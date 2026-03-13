use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::sync::Mutex;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const NOTIFICATION_QUEUE_CAP: usize = 2048;
const DEBUG_EVENT_CAP: usize = 160;

// Keyed by CODEX_HOME override ("" means inherit parent env / default process CODEX_HOME).
// Value is per-home server mutex so different homes can run concurrently without global lock blocking.
static APP_SERVERS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<AppServer>>>>> =
    OnceLock::new();
static NOTIFICATION_STATE: OnceLock<Mutex<HashMap<String, NotificationState>>> = OnceLock::new();
static DEBUG_EVENTS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();

#[cfg(test)]
static TEST_REQUEST_HANDLER: OnceLock<
    Mutex<
        Option<
            std::sync::Arc<
                dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync,
            >,
        >,
    >,
> = OnceLock::new();

#[cfg(test)]
pub async fn _set_test_request_handler(
    handler: Option<
        std::sync::Arc<dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync>,
    >,
) {
    let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    *guard = handler;
}

#[cfg(test)]
async fn maybe_handle_test_request(
    codex_home: Option<&str>,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
    let guard = lock.lock().await;
    let Some(handler) = guard.as_ref() else {
        return None;
    };
    Some(handler(codex_home, method, params.clone()))
}

struct NotificationState {
    next_event_id: u64,
    items: VecDeque<(u64, Value)>,
}

impl Default for NotificationState {
    fn default() -> Self {
        Self {
            next_event_id: 1,
            items: VecDeque::new(),
        }
    }
}

fn normalize_home_key(codex_home: Option<&str>) -> Cow<'static, str> {
    let Some(home) = codex_home else {
        return Cow::Borrowed("");
    };
    let trimmed = home.trim();
    if trimmed.is_empty() {
        Cow::Borrowed("")
    } else {
        Cow::Owned(trimmed.to_string())
    }
}

fn notification_state_map() -> &'static Mutex<HashMap<String, NotificationState>> {
    NOTIFICATION_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn ensure_notification_home_state(codex_home: Option<&str>) {
    let key = normalize_home_key(codex_home).to_string();
    let map = notification_state_map();
    let mut guard = map.lock().await;
    guard.entry(key).or_insert_with(NotificationState::default);
}

fn debug_event_queue() -> &'static Mutex<VecDeque<Value>> {
    DEBUG_EVENTS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn deep_find_thread_id(value: &Value, depth: usize) -> Option<String> {
    if depth > 6 {
        return None;
    }
    match value {
        Value::Object(map) => {
            for key in [
                "threadId",
                "thread_id",
                "conversationId",
                "conversation_id",
                "sessionId",
                "session_id",
                "parentThreadId",
                "parent_thread_id",
            ] {
                if let Some(found) = map
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    return Some(found.to_string());
                }
            }
            for child in map.values() {
                if let Some(found) = deep_find_thread_id(child, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .take(40)
            .find_map(|child| deep_find_thread_id(child, depth + 1)),
        _ => None,
    }
}

async fn push_debug_event(kind: &str, payload: Value) {
    let mut guard = debug_event_queue().lock().await;
    let obj = payload.as_object().cloned().unwrap_or_default();
    let mut map = serde_json::Map::with_capacity(obj.len() + 2);
    map.insert(
        "at".to_string(),
        serde_json::json!(crate::orchestrator::store::unix_ms()),
    );
    map.insert("kind".to_string(), Value::from(kind));
    for (key, value) in obj {
        map.insert(key, value);
    }
    let entry = Value::Object(map);
    guard.push_back(entry.clone());
    while guard.len() > DEBUG_EVENT_CAP {
        guard.pop_front();
    }
    drop(guard);
    let _ = crate::orchestrator::gateway::web_codex_storage::append_codex_live_trace_entry(
        &serde_json::json!({
            "source": "backend.app",
            "entry": entry,
        }),
    );
}

pub async fn debug_snapshot() -> Value {
    let homes = {
        let guard = notification_state_map().lock().await;
        let mut homes = Vec::with_capacity(guard.len());
        for (home, state) in guard.iter() {
            let first_event_id = state.items.front().map(|(id, _)| *id);
            let last = state.items.back();
            let last_event_id = last.map(|(id, _)| *id);
            let last_method = last
                .and_then(|(_, value)| value.get("method"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let last_thread_id = last
                .and_then(|(_, value)| extract_thread_id_for_debug(value))
                .unwrap_or_default();
            homes.push(serde_json::json!({
                "home": home,
                "queueLen": state.items.len(),
                "nextEventId": state.next_event_id,
                "firstEventId": first_event_id,
                "lastEventId": last_event_id,
                "lastMethod": last_method,
                "lastThreadId": last_thread_id,
            }));
        }
        homes
    };
    let recent = {
        let guard = debug_event_queue().lock().await;
        guard.iter().cloned().collect::<Vec<_>>()
    };
    serde_json::json!({
        "homes": homes,
        "recent": recent,
    })
}

fn extract_thread_id_for_debug(value: &Value) -> Option<String> {
    let params = value
        .get("params")
        .and_then(Value::as_object)
        .or_else(|| value.get("payload").and_then(Value::as_object));
    let direct = params
        .and_then(|map| map.get("threadId").and_then(Value::as_str))
        .or_else(|| params.and_then(|map| map.get("thread_id").and_then(Value::as_str)));
    if let Some(thread_id) = direct {
        return Some(thread_id.to_string());
    }
    let item = params
        .and_then(|map| map.get("item").and_then(Value::as_object))
        .or_else(|| params.and_then(|map| map.get("msg").and_then(Value::as_object)));
    item.and_then(|map| {
        map.get("threadId")
            .and_then(Value::as_str)
            .or_else(|| map.get("thread_id").and_then(Value::as_str))
            .map(str::to_string)
    })
    .or_else(|| deep_find_thread_id(value, 0))
}

fn normalize_stdout_notification(value: &Value) -> Option<Value> {
    if value.get("method").and_then(Value::as_str).is_some() {
        return Some(value.clone());
    }
    let record_type = value.get("type").and_then(Value::as_str)?;
    let payload = value.get("payload")?.clone();
    match record_type {
        "event_msg" => {
            let event_type = payload
                .get("type")
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .unwrap_or("event_msg");
            Some(serde_json::json!({
                "method": format!("codex/event/{event_type}"),
                "params": {
                    "payload": payload,
                },
            }))
        }
        "response_item" => Some(serde_json::json!({
            "method": "codex/event/response_item",
            "params": {
                "payload": payload,
            },
        })),
        _ => None,
    }
}

async fn push_notification(codex_home: Option<&str>, value: Value) {
    let key = normalize_home_key(codex_home);
    let map = notification_state_map();
    let mut guard = map.lock().await;
    let st = guard
        .entry(key.to_string())
        .or_insert_with(|| NotificationState {
            next_event_id: 1,
            items: VecDeque::new(),
        });
    let event_id = st.next_event_id;
    st.next_event_id = st.next_event_id.saturating_add(1);
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let thread_id = extract_thread_id_for_debug(&value).unwrap_or_default();
    st.items.push_back((event_id, value));
    let mut dropped = None;
    while st.items.len() > NOTIFICATION_QUEUE_CAP {
        dropped = st.items.pop_front();
    }
    let queue_len = st.items.len();
    drop(guard);
    if let Some((dropped_event_id, dropped_value)) = dropped {
        push_debug_event(
            "app.notification.drop.overflow",
            serde_json::json!({
                "home": key.as_ref(),
                "droppedEventId": dropped_event_id,
                "droppedMethod": dropped_value.get("method").and_then(Value::as_str).unwrap_or_default(),
                "droppedThreadId": extract_thread_id_for_debug(&dropped_value).unwrap_or_default(),
                "queueLen": queue_len,
            }),
        )
        .await;
    }
    push_debug_event(
        "app.notification.push",
        serde_json::json!({
            "home": key.as_ref(),
            "eventId": event_id,
            "method": method,
            "threadId": thread_id,
            "queueLen": queue_len,
        }),
    )
    .await;
}

fn with_event_id(mut value: Value, event_id: u64) -> Value {
    // Prefer preserving the original notification shape (method/params/etc) and attach eventId.
    if let Value::Object(map) = &mut value {
        map.insert("eventId".to_string(), Value::from(event_id));
        return value;
    }
    serde_json::json!({ "eventId": event_id, "payload": value })
}

/// Replay notifications newer than `since_event_id` (exclusive).
///
/// This does NOT drain the global queue so multiple clients can replay independently.
/// Returns: (items, first_event_id_in_buffer, last_event_id_in_buffer, gap)
/// - `gap=true` means some events older than requested have been dropped due to buffer cap.
pub async fn replay_notifications_since_in_home(
    codex_home: Option<&str>,
    since_event_id: u64,
    max: usize,
) -> (Vec<Value>, Option<u64>, Option<u64>, bool) {
    if let Some(result) = crate::codex_wsl_bridge::try_replay_notifications_since_in_home(
        codex_home,
        since_event_id,
        max,
    )
    .await
    {
        push_debug_event(
            "app.notification.replay.bridge",
            serde_json::json!({
                "home": normalize_home_key(codex_home).as_ref(),
                "sinceEventId": since_event_id,
                "max": max,
                "count": result.0.len(),
                "firstEventId": result.1,
                "lastEventId": result.2,
                "gap": result.3,
            }),
        )
        .await;
        return result;
    }
    let cap = max.clamp(1, NOTIFICATION_QUEUE_CAP);
    let key = normalize_home_key(codex_home);
    let map = notification_state_map();
    let guard = map.lock().await;
    let Some(st) = guard.get(key.as_ref()) else {
        drop(guard);
        push_debug_event(
            "app.notification.replay.empty_home",
            serde_json::json!({
                "home": key.as_ref(),
                "sinceEventId": since_event_id,
                "max": cap,
            }),
        )
        .await;
        return (Vec::new(), None, None, false);
    };
    let first = st.items.front().map(|(id, _)| *id);
    let last = st.items.back().map(|(id, _)| *id);
    let gap = first
        .map(|first_id| since_event_id + 1 < first_id)
        .unwrap_or(false);
    let mut out = Vec::new();
    for (event_id, value) in st.items.iter() {
        if *event_id <= since_event_id {
            continue;
        }
        out.push(with_event_id(value.clone(), *event_id));
        if out.len() >= cap {
            break;
        }
    }
    let out_len = out.len();
    drop(guard);
    push_debug_event(
        "app.notification.replay",
        serde_json::json!({
            "home": key.as_ref(),
            "sinceEventId": since_event_id,
            "max": cap,
            "count": out_len,
            "firstEventId": first,
            "lastEventId": last,
            "gap": gap,
        }),
    )
    .await;
    (out, first, last, gap)
}

pub async fn ensure_server_in_home(codex_home: Option<&str>) -> Result<(), String> {
    ensure_notification_home_state(codex_home).await;

    #[cfg(test)]
    {
        let lock = TEST_REQUEST_HANDLER.get_or_init(|| Mutex::new(None));
        if lock.lock().await.is_some() {
            push_debug_event(
                "app.server.ensure.test",
                serde_json::json!({
                    "home": normalize_home_key(codex_home).as_ref(),
                }),
            )
            .await;
            return Ok(());
        }
    }

    let key = normalize_home_key(codex_home).to_string();
    let lock = APP_SERVERS.get_or_init(|| Mutex::new(HashMap::new()));

    loop {
        let existing = {
            let guard = lock.lock().await;
            guard.get(&key).cloned()
        };

        if let Some(server) = existing {
            let dead = {
                let mut srv = server.lock().await;
                srv.is_dead().unwrap_or(true)
            };
            if !dead {
                return Ok(());
            }
            let mut guard = lock.lock().await;
            if guard
                .get(&key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server))
            {
                guard.remove(&key);
            }
            continue;
        }

        push_debug_event(
            "app.server.ensure.spawn_requested",
            serde_json::json!({
                "home": key,
            }),
        )
        .await;

        let spawned = AppServer::spawn(if key.is_empty() {
            None
        } else {
            Some(key.as_str())
        })
        .await?;
        let spawned_arc = std::sync::Arc::new(Mutex::new(spawned));
        let mut guard = lock.lock().await;
        guard
            .entry(key.clone())
            .or_insert_with(|| spawned_arc.clone());
        return Ok(());
    }
}

fn resolve_codex_cmd() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let candidate = PathBuf::from(appdata).join("npm").join("codex.cmd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum LaunchSpec {
    Native {
        codex_home: Option<String>,
    },
    #[cfg(any(test, target_os = "windows"))]
    Wsl {
        distro: Option<String>,
        codex_home_linux: Option<String>,
    },
}

#[cfg(any(test, target_os = "windows"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(test, target_os = "windows"))]
fn parse_wsl_unc_codex_home(value: &str) -> Option<(String, String)> {
    let mut text = value.trim().replace('/', "\\");
    if let Some(stripped) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{stripped}");
    }
    let stripped = text
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| text.strip_prefix(r"\\wsl$\\"))?;
    let mut parts = stripped.split('\\').filter(|part| !part.is_empty());
    let distro = parts.next()?.trim().to_string();
    if distro.is_empty() {
        return None;
    }
    let rest = parts.collect::<Vec<_>>();
    let linux_path = if rest.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", rest.join("/"))
    };
    Some((distro, linux_path))
}

fn resolve_launch_spec(codex_home: Option<&str>) -> LaunchSpec {
    let home = codex_home
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    #[cfg(any(test, target_os = "windows"))]
    {
        if let Some(ref value) = home {
            if let Some((distro, linux_path)) = parse_wsl_unc_codex_home(value) {
                return LaunchSpec::Wsl {
                    distro: Some(distro),
                    codex_home_linux: Some(linux_path),
                };
            }
            #[cfg(target_os = "windows")]
            if value.starts_with('/') {
                return LaunchSpec::Wsl {
                    distro: None,
                    codex_home_linux: Some(value.clone()),
                };
            }
        }
    }
    LaunchSpec::Native { codex_home: home }
}

fn build_codex_command(codex_home: Option<&str>) -> Command {
    match resolve_launch_spec(codex_home) {
        LaunchSpec::Native { codex_home } => {
            if let Some(path) = resolve_codex_cmd() {
                let mut cmd = Command::new("cmd.exe");
                cmd.arg("/c").arg(path).arg("app-server");
                if let Some(home) = codex_home.as_deref() {
                    cmd.env("CODEX_HOME", home);
                }
                #[cfg(target_os = "windows")]
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                return cmd;
            }
            let mut cmd = Command::new("codex");
            cmd.arg("app-server");
            if let Some(home) = codex_home.as_deref() {
                cmd.env("CODEX_HOME", home);
            }
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd
        }
        #[cfg(any(test, target_os = "windows"))]
        LaunchSpec::Wsl {
            distro,
            codex_home_linux,
        } => {
            let mut cmd = Command::new("wsl.exe");
            if let Some(distro) = distro.as_deref() {
                cmd.arg("-d").arg(distro);
            }
            cmd.arg("-e").arg("sh").arg("-lc");
            let script = if let Some(home) = codex_home_linux.as_deref() {
                format!(
                    "export CODEX_HOME={}; exec codex app-server",
                    shell_single_quote(home)
                )
            } else {
                "exec codex app-server".to_string()
            };
            cmd.arg(script);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd
        }
    }
}

#[cfg(test)]
pub async fn _clear_notifications_for_test() {
    let map = notification_state_map();
    let mut guard = map.lock().await;
    guard.clear();
    drop(guard);
    let mut debug = debug_event_queue().lock().await;
    debug.clear();
}

async fn write_json_line(
    stdin: &mut tokio::process::ChildStdin,
    value: &serde_json::Value,
) -> Result<(), String> {
    let line = value.to_string();
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Default)]
struct PendingRouter {
    pending: Mutex<HashMap<i64, oneshot::Sender<Value>>>,
}

impl PendingRouter {
    async fn register(&self, id: i64) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self.pending.lock().await;
        guard.insert(id, tx);
        rx
    }

    async fn deliver(&self, id: i64, value: Value) -> bool {
        let tx = {
            let mut guard = self.pending.lock().await;
            guard.remove(&id)
        };
        if let Some(tx) = tx {
            let _ = tx.send(value);
            return true;
        }
        false
    }
}

async fn route_stdout_lines(
    stdout: tokio::process::ChildStdout,
    router: std::sync::Arc<PendingRouter>,
    codex_home: Option<String>,
) {
    let mut reader = BufReader::new(stdout).lines();
    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    push_debug_event(
                        "app.stdout.drop.invalid_json",
                        serde_json::json!({
                            "home": codex_home.as_deref().unwrap_or(""),
                            "raw": line.chars().take(180).collect::<String>(),
                        }),
                    )
                    .await;
                    continue;
                };
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    push_debug_event(
                        "app.stdout.response",
                        serde_json::json!({
                            "home": codex_home.as_deref().unwrap_or(""),
                            "requestId": id,
                            "hasResult": value.get("result").is_some(),
                            "hasError": value.get("error").is_some(),
                        }),
                    )
                    .await;
                    let _ = router.deliver(id, value).await;
                    continue;
                }
                if let Some(notification) = normalize_stdout_notification(&value) {
                    push_notification(codex_home.as_deref(), notification).await;
                    continue;
                }
                push_debug_event(
                    "app.stdout.drop.ignored_shape",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                        "hasId": value.get("id").is_some(),
                        "hasMethod": value.get("method").is_some(),
                        "keys": value.as_object().map(|obj| obj.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                    }),
                )
                .await;
            }
            Ok(None) => {
                push_debug_event(
                    "app.stdout.eof",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                    }),
                )
                .await;
                break;
            }
            Err(error) => {
                push_debug_event(
                    "app.stdout.read_error",
                    serde_json::json!({
                        "home": codex_home.as_deref().unwrap_or(""),
                        "message": error.to_string(),
                    }),
                )
                .await;
                break;
            }
        }
    }
}

struct AppServer {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    router: std::sync::Arc<PendingRouter>,
    _stdout_task: tokio::task::JoinHandle<()>,
    next_id: i64,
}

impl AppServer {
    async fn spawn(codex_home: Option<&str>) -> Result<Self, String> {
        let home = normalize_home_key(codex_home).to_string();
        push_debug_event(
            "app.server.spawn.start",
            serde_json::json!({
                "home": home,
            }),
        )
        .await;
        let mut cmd = build_codex_command(codex_home);

        let mut child = match cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                push_debug_event(
                    "app.server.spawn.error",
                    serde_json::json!({
                        "home": home,
                        "message": error.to_string(),
                    }),
                )
                .await;
                return Err(format!("failed to start codex app-server: {error}"));
            }
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open codex stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open codex stdout".to_string())?;

        let router = std::sync::Arc::new(PendingRouter::default());
        let router_for_task = router.clone();
        let home_for_task = codex_home
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let stdout_task = tokio::spawn(async move {
            route_stdout_lines(stdout, router_for_task, home_for_task).await;
        });

        // Initialize via normal request path so notifications can be captured concurrently.
        let mut server = Self {
            child,
            stdin,
            router,
            _stdout_task: stdout_task,
            next_id: 1,
        };
        let _ = server
            .request(
                "initialize",
                serde_json::json!({
                    "clientInfo": {
                        "name": "API Router",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;

        let initialized = serde_json::json!({
            "method": "initialized",
            "params": {}
        });
        write_json_line(&mut server.stdin, &initialized).await?;

        server.next_id = 2;
        push_debug_event(
            "app.server.spawn.ok",
            serde_json::json!({
                "home": normalize_home_key(codex_home).as_ref(),
            }),
        )
        .await;
        Ok(server)
    }

    fn is_dead(&mut self) -> Result<bool, String> {
        match self.child.try_wait() {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if self.is_dead()? {
            return Err("codex app-server exited".to_string());
        }

        let params = if params.is_null() {
            Value::Object(serde_json::Map::new())
        } else {
            params
        };
        let request_id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let request = serde_json::json!({
            "id": request_id,
            "method": method,
            "params": params
        });
        let rx = self.router.register(request_id).await;
        write_json_line(&mut self.stdin, &request).await?;

        let response = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| "codex app-server timed out".to_string())?
            .map_err(|_| "codex app-server closed before responding".to_string())?;

        if let Some(err) = response.get("error") {
            if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
                return Err(msg.to_string());
            }
            return Err("codex app-server error".to_string());
        }

        response
            .get("result")
            .cloned()
            .ok_or_else(|| "codex app-server response missing result".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    use tokio::io::AsyncWriteExt;

    // codex_app_server uses global singletons (notification ring buffer + event id counter).
    // These tests must run serially to avoid cross-test interference.
    static TEST_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    fn lock_tests() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stdout_router_captures_notifications_and_delivers_responses() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        let (mut w, r) = tokio::io::duplex(8 * 1024);
        // duplex gives us AsyncRead/Write; wrap the reader side into the same route function
        // by faking a ChildStdout via a pipe-like approach is not possible, so we test the core
        // logic by writing into a BufReader<DuplexStream> here.
        //
        // We keep this test close to production behavior: parse JSON lines and route by id.
        let router = std::sync::Arc::new(PendingRouter::default());

        let router_for_task = router.clone();
        let read_task = tokio::spawn(async move {
            let mut reader = BufReader::new(r).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
                    let _ = router_for_task.deliver(id, value).await;
                    continue;
                }
                if let Some(notification) = normalize_stdout_notification(&value) {
                    push_notification(None, notification).await;
                }
            }
        });

        // Register a pending request and send a notification + response lines.
        let rx = router.register(99).await;
        let notif = serde_json::json!({"method":"turn/status","params":{"thread_id":"t1","status":"running"}});
        let commentary = serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"agent_message","thread_id":"t1","phase":"commentary","message":"thinking"}
        });
        let final_item = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"message","role":"assistant","thread_id":"t1","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}
        });
        let resp = serde_json::json!({"id":99,"result":{"ok":true}});
        w.write_all(notif.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(commentary.to_string().as_bytes())
            .await
            .unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(final_item.to_string().as_bytes())
            .await
            .unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(resp.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.shutdown().await.unwrap();

        let got = tokio::time::timeout(Duration::from_millis(800), rx)
            .await
            .expect("response timeout")
            .expect("oneshot dropped");
        assert_eq!(got.get("id").and_then(|v| v.as_i64()), Some(99));

        let (drained, _first, _last, _gap) = replay_notifications_since_in_home(None, 0, 8).await;
        assert_eq!(drained.len(), 3);
        assert_eq!(
            drained[0].get("method").and_then(|v| v.as_str()),
            Some("turn/status")
        );
        assert_eq!(
            drained[1].get("method").and_then(|v| v.as_str()),
            Some("codex/event/agent_message")
        );
        assert_eq!(
            drained[2].get("method").and_then(|v| v.as_str()),
            Some("codex/event/response_item")
        );
        assert_eq!(drained[0].get("eventId").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(drained[1].get("eventId").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(drained[2].get("eventId").and_then(|v| v.as_u64()), Some(3));

        let _ = read_task.await;
    }

    #[test]
    fn normalize_stdout_notification_wraps_commentary_shapes() {
        let event_msg = serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"agent_message","thread_id":"thread-1","phase":"commentary","message":"thinking"}
        });
        let response_item = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"message","role":"assistant","thread_id":"thread-1","phase":"final_answer","content":[{"type":"output_text","text":"done"}]}
        });

        let wrapped_event = normalize_stdout_notification(&event_msg).expect("wrapped event_msg");
        let wrapped_item =
            normalize_stdout_notification(&response_item).expect("wrapped response_item");

        assert_eq!(
            wrapped_event.get("method").and_then(Value::as_str),
            Some("codex/event/agent_message")
        );
        assert_eq!(
            wrapped_item.get("method").and_then(Value::as_str),
            Some("codex/event/response_item")
        );
        assert_eq!(
            extract_thread_id_for_debug(&wrapped_event).as_deref(),
            Some("thread-1")
        );
        assert_eq!(
            extract_thread_id_for_debug(&wrapped_item).as_deref(),
            Some("thread-1")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_notifications_since_includes_event_ids_and_gaps() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        push_notification(None, serde_json::json!({"method":"a","params":{}})).await;
        push_notification(None, serde_json::json!({"method":"b","params":{}})).await;

        let (all, first, last, gap) = replay_notifications_since_in_home(None, 0, 10).await;
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(2));
        assert!(!gap);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].get("eventId").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(all[1].get("eventId").and_then(|v| v.as_u64()), Some(2));

        let (only_b, _f2, _l2, gap2) = replay_notifications_since_in_home(None, 1, 10).await;
        assert!(!gap2);
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].get("method").and_then(|v| v.as_str()), Some("b"));
        assert_eq!(only_b[0].get("eventId").and_then(|v| v.as_u64()), Some(2));

        // If the buffer is empty, first/last are None.
        _clear_notifications_for_test().await;
        let (empty, f3, l3, gap3) = replay_notifications_since_in_home(None, 0, 10).await;
        assert!(empty.is_empty());
        assert_eq!(f3, None);
        assert_eq!(l3, None);
        assert!(!gap3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn replay_gap_flag_when_since_is_older_than_ring_buffer() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        // Fill beyond the cap so the oldest events are dropped.
        for i in 0..(NOTIFICATION_QUEUE_CAP + 2) {
            push_notification(None, serde_json::json!({"method":"m","params":{"i":i}})).await;
        }
        let (items, first, last, gap) = replay_notifications_since_in_home(None, 0, 5).await;
        assert!(
            gap,
            "expected gap=true when since is older than retained buffer"
        );
        assert!(first.is_some());
        assert!(last.is_some());
        assert!(!items.is_empty());
        // The first retained event id should be > 1 due to dropping.
        assert!(first.unwrap() > 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn notification_overflow_emits_debug_event() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        for i in 0..(NOTIFICATION_QUEUE_CAP + 1) {
            push_notification(
                None,
                serde_json::json!({
                    "method": "turn/status",
                    "params": { "thread_id": format!("thread-{i}") }
                }),
            )
            .await;
        }

        let snapshot = debug_snapshot().await;
        let recent = snapshot
            .get("recent")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let overflow = recent
            .iter()
            .rev()
            .find(|entry| {
                entry.get("kind").and_then(Value::as_str) == Some("app.notification.drop.overflow")
            })
            .cloned()
            .expect("overflow debug event");
        assert_eq!(
            overflow.get("droppedEventId").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            overflow.get("droppedMethod").and_then(Value::as_str),
            Some("turn/status")
        );
        assert_eq!(
            overflow.get("droppedThreadId").and_then(Value::as_str),
            Some("thread-0")
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "current_thread")]
    async fn wsl_homes_route_requests_through_bridge_transport() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        crate::codex_wsl_bridge::_set_test_rpc_handler(Some(std::sync::Arc::new(
            |codex_home, method, params| {
                assert_eq!(codex_home, Some("/home/me/.codex"));
                assert_eq!(method, "thread/read");
                assert_eq!(params.get("id").and_then(|v| v.as_str()), Some("thread-1"));
                Ok(serde_json::json!({ "via": "bridge" }))
            },
        )))
        .await;

        let result = request_in_home(
            Some(r"\\wsl.localhost\Ubuntu\home\me\.codex"),
            "thread/read",
            serde_json::json!({ "id": "thread-1" }),
        )
        .await
        .expect("bridge result");

        crate::codex_wsl_bridge::_set_test_rpc_handler(None).await;
        assert_eq!(result.get("via").and_then(|v| v.as_str()), Some("bridge"));
    }

    #[cfg(target_os = "windows")]
    #[tokio::test(flavor = "current_thread")]
    async fn wsl_homes_route_notification_replay_through_bridge_transport() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        crate::codex_wsl_bridge::_set_test_replay_handler(Some(std::sync::Arc::new(
            |codex_home, since_event_id, max| {
                assert_eq!(codex_home, Some("/home/me/.codex"));
                assert_eq!(since_event_id, 4);
                assert_eq!(max, 2);
                (
                    vec![serde_json::json!({
                        "eventId": 5,
                        "method": "turn/status",
                        "params": { "status": "running" }
                    })],
                    Some(5),
                    Some(5),
                    false,
                )
            },
        )))
        .await;

        let (items, first, last, gap) = replay_notifications_since_in_home(
            Some(r"\\wsl.localhost\Ubuntu\home\me\.codex"),
            4,
            2,
        )
        .await;

        crate::codex_wsl_bridge::_set_test_replay_handler(None).await;
        assert_eq!(first, Some(5));
        assert_eq!(last, Some(5));
        assert!(!gap);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("eventId").and_then(|v| v.as_u64()), Some(5));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ensure_server_in_home_initializes_notification_ring_for_selected_home() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;
        _set_test_request_handler(Some(std::sync::Arc::new(
            |_codex_home, _method, _params| Ok(serde_json::json!({ "ok": true })),
        )))
        .await;

        ensure_server_in_home(Some(r"C:\Users\yiyou\.codex"))
            .await
            .expect("ensure server");

        let snapshot = debug_snapshot().await;
        let homes = snapshot
            .get("homes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(homes.iter().any(|entry| {
            entry.get("home").and_then(Value::as_str) == Some(r"C:\Users\yiyou\.codex")
        }));

        _set_test_request_handler(None).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn notification_home_state_starts_event_ids_at_one() {
        let _guard = lock_tests();
        _clear_notifications_for_test().await;

        ensure_notification_home_state(Some(r"C:\Users\yiyou\.codex")).await;
        push_notification(
            Some(r"C:\Users\yiyou\.codex"),
            serde_json::json!({
                "method": "thread/status/changed",
                "params": { "threadId": "thread-1" }
            }),
        )
        .await;

        let (items, first, last, gap) =
            replay_notifications_since_in_home(Some(r"C:\Users\yiyou\.codex"), 0, 8).await;
        assert!(!gap);
        assert_eq!(first, Some(1));
        assert_eq!(last, Some(1));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].get("eventId").and_then(Value::as_u64), Some(1));
    }

    #[test]
    fn resolves_native_launcher_for_windows_home() {
        let spec = resolve_launch_spec(Some(r"C:\Users\yiyou\.codex"));
        assert_eq!(
            spec,
            LaunchSpec::Native {
                codex_home: Some(r"C:\Users\yiyou\.codex".to_string())
            }
        );
    }

    #[test]
    fn resolves_wsl_launcher_for_unc_home() {
        let spec = resolve_launch_spec(Some(r"\\?\UNC\wsl.localhost\Ubuntu\home\yiyou\.codex"));
        assert_eq!(
            spec,
            LaunchSpec::Wsl {
                distro: Some("Ubuntu".to_string()),
                codex_home_linux: Some("/home/yiyou/.codex".to_string())
            }
        );
    }

    #[test]
    fn resolves_wsl_launcher_for_linux_home() {
        let spec = resolve_launch_spec(Some("/home/yiyou/.codex"));
        #[cfg(target_os = "windows")]
        assert_eq!(
            spec,
            LaunchSpec::Wsl {
                distro: None,
                codex_home_linux: Some("/home/yiyou/.codex".to_string())
            }
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            spec,
            LaunchSpec::Native {
                codex_home: Some("/home/yiyou/.codex".to_string())
            }
        );
    }
}

pub async fn request_in_home(
    codex_home: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    #[cfg(test)]
    if let Some(result) = maybe_handle_test_request(codex_home, method, &params).await {
        return result;
    }

    let home = normalize_home_key(codex_home).to_string();
    ensure_notification_home_state(codex_home).await;
    let thread_id = extract_thread_id_for_debug(&serde_json::json!({
        "params": params.clone(),
    }))
    .unwrap_or_default();
    push_debug_event(
        "app.request.start",
        serde_json::json!({
            "home": home,
            "method": method,
            "threadId": thread_id,
        }),
    )
    .await;

    if let Some(result) =
        crate::codex_wsl_bridge::try_request_in_home(codex_home, method, params.clone()).await
    {
        let is_ok = result.is_ok();
        push_debug_event(
            if is_ok {
                "app.request.bridge.ok"
            } else {
                "app.request.bridge.error"
            },
            serde_json::json!({
                "home": home,
                "method": method,
                "threadId": thread_id,
                "message": result.as_ref().err().cloned().unwrap_or_default(),
            }),
        )
        .await;
        return result;
    }

    let key = home.clone();
    let lock = APP_SERVERS.get_or_init(|| Mutex::new(HashMap::new()));

    let server_arc = loop {
        let existing = {
            let guard = lock.lock().await;
            guard.get(&key).cloned()
        };

        if let Some(server) = existing {
            let dead = {
                let mut srv = server.lock().await;
                srv.is_dead().unwrap_or(true)
            };
            if !dead {
                break server;
            }
            let mut guard = lock.lock().await;
            if guard
                .get(&key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server))
            {
                guard.remove(&key);
            }
            continue;
        }

        push_debug_event(
            "app.server.spawn.requested",
            serde_json::json!({
                "home": key,
                "method": method,
                "threadId": thread_id,
            }),
        )
        .await;
        let spawned = AppServer::spawn(if key.is_empty() {
            None
        } else {
            Some(key.as_str())
        })
        .await?;
        let spawned_arc = std::sync::Arc::new(Mutex::new(spawned));
        let mut guard = lock.lock().await;
        let entry = guard
            .entry(key.clone())
            .or_insert_with(|| spawned_arc.clone())
            .clone();
        break entry;
    };

    let mut server = server_arc.lock().await;
    match server.request(method, params).await {
        Ok(result) => {
            push_debug_event(
                "app.request.ok",
                serde_json::json!({
                    "home": home,
                    "method": method,
                    "threadId": thread_id,
                }),
            )
            .await;
            Ok(result)
        }
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            let should_respawn = lower.contains("closed")
                || lower.contains("exited")
                || lower.contains("missing result")
                || lower.contains("failed to open codex stdin")
                || lower.contains("failed to open codex stdout");
            if should_respawn {
                let mut guard = lock.lock().await;
                if guard
                    .get(&key)
                    .is_some_and(|current| std::sync::Arc::ptr_eq(current, &server_arc))
                {
                    guard.remove(&key);
                }
            }
            push_debug_event(
                "app.request.error",
                serde_json::json!({
                    "home": home,
                    "method": method,
                    "threadId": thread_id,
                    "message": e.clone(),
                    "respawn": should_respawn,
                }),
            )
            .await;
            Err(e)
        }
    }
}

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    request_in_home(None, method, params).await
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}
