use serde_json::Value;
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

static APP_SERVER: OnceLock<Mutex<Option<AppServer>>> = OnceLock::new();
static NOTIFICATIONS: OnceLock<Mutex<VecDeque<Value>>> = OnceLock::new();

fn notifications_queue() -> &'static Mutex<VecDeque<Value>> {
    NOTIFICATIONS.get_or_init(|| Mutex::new(VecDeque::new()))
}

async fn push_notification(value: Value) {
    let q = notifications_queue();
    let mut guard = q.lock().await;
    guard.push_back(value);
    while guard.len() > NOTIFICATION_QUEUE_CAP {
        guard.pop_front();
    }
}

pub async fn drain_notifications(max: usize) -> Vec<Value> {
    let cap = max.clamp(1, NOTIFICATION_QUEUE_CAP);
    let q = notifications_queue();
    let mut guard = q.lock().await;
    let mut out = Vec::new();
    while out.len() < cap {
        let Some(v) = guard.pop_front() else { break };
        out.push(v);
    }
    out
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

fn build_codex_command() -> Command {
    if let Some(path) = resolve_codex_cmd() {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/c").arg(path).arg("app-server");
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        return cmd;
    }
    let mut cmd = Command::new("codex");
    cmd.arg("app-server");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(test)]
pub async fn _clear_notifications_for_test() {
    let q = notifications_queue();
    let mut guard = q.lock().await;
    guard.clear();
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
) {
    let mut reader = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = value.get("id").and_then(|v| v.as_i64()) {
            let _ = router.deliver(id, value).await;
            continue;
        }
        if value.get("method").and_then(|v| v.as_str()).is_some() {
            push_notification(value).await;
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
    async fn spawn() -> Result<Self, String> {
        let mut child = build_codex_command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to start codex app-server: {e}"))?;

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
        let stdout_task = tokio::spawn(async move {
            route_stdout_lines(stdout, router_for_task).await;
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
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn stdout_router_captures_notifications_and_delivers_responses() {
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
                if value.get("method").and_then(|v| v.as_str()).is_some() {
                    push_notification(value).await;
                }
            }
        });

        // Register a pending request and send a notification + response lines.
        let rx = router.register(99).await;
        let notif = serde_json::json!({"method":"turn/status","params":{"thread_id":"t1","status":"running"}});
        let resp = serde_json::json!({"id":99,"result":{"ok":true}});
        w.write_all(notif.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.write_all(resp.to_string().as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.shutdown().await.unwrap();

        let got = tokio::time::timeout(Duration::from_millis(800), rx)
            .await
            .expect("response timeout")
            .expect("oneshot dropped");
        assert_eq!(got.get("id").and_then(|v| v.as_i64()), Some(99));

        let drained = drain_notifications(8).await;
        assert!(!drained.is_empty(), "expected at least one notification");
        assert_eq!(
            drained[0].get("method").and_then(|v| v.as_str()),
            Some("turn/status")
        );

        let _ = read_task.await;
    }
}

pub async fn request(method: &str, params: Value) -> Result<Value, String> {
    let lock = APP_SERVER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    let needs_spawn = match guard.as_mut() {
        Some(server) => server.is_dead().unwrap_or(true),
        None => true,
    };
    if needs_spawn {
        *guard = Some(AppServer::spawn().await?);
    }
    let server = guard
        .as_mut()
        .ok_or_else(|| "codex app-server not available".to_string())?;
    match server.request(method, params).await {
        Ok(result) => Ok(result),
        Err(e) => {
            let lower = e.to_ascii_lowercase();
            let should_respawn = lower.contains("closed")
                || lower.contains("exited")
                || lower.contains("missing result")
                || lower.contains("failed to open codex stdin")
                || lower.contains("failed to open codex stdout");
            if should_respawn {
                *guard = None;
            }
            Err(e)
        }
    }
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}
