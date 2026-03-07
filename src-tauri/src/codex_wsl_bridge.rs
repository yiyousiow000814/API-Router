use reqwest::Client;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::HashMap;
#[cfg(target_os = "windows")]
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
#[cfg(target_os = "windows")]
use tokio::process::Command;
use tokio::sync::Mutex;

const BRIDGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const BRIDGE_START_TIMEOUT: Duration = Duration::from_secs(8);
const BRIDGE_START_POLL_INTERVAL: Duration = Duration::from_millis(150);
const BRIDGE_PORT_BASE: u16 = 42180;
const BRIDGE_PORT_SPREAD: u16 = 211;
const BRIDGE_PORT_CANDIDATES: usize = 4;
const BRIDGE_HEALTH_MARKER: &str = "api-router-wsl-codex-bridge";
const BRIDGE_LOG_PATH: &str = "/tmp/api-router-wsl-codex-bridge.log";

static BRIDGES: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<BridgeRuntime>>>>> =
    OnceLock::new();

#[cfg(test)]
static TEST_RPC_HANDLER: OnceLock<
    Mutex<
        Option<
            std::sync::Arc<
                dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync,
            >,
        >,
    >,
> = OnceLock::new();

#[cfg(test)]
static TEST_REPLAY_HANDLER: OnceLock<
    Mutex<
        Option<
            std::sync::Arc<
                dyn Fn(Option<&str>, u64, usize) -> (Vec<Value>, Option<u64>, Option<u64>, bool)
                    + Send
                    + Sync,
            >,
        >,
    >,
> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
struct BridgeTarget {
    distro: Option<String>,
    codex_home_linux: Option<String>,
}

#[derive(Clone)]
struct BridgeEndpoint {
    base_url: String,
    client: Client,
}

struct BridgeRuntime {
    endpoint: BridgeEndpoint,
    child: Option<tokio::process::Child>,
}

impl BridgeRuntime {
    fn is_dead(&mut self) -> Result<bool, String> {
        let Some(child) = self.child.as_mut() else {
            return Ok(false);
        };
        match child.try_wait() {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn bridge_map() -> &'static Mutex<HashMap<String, std::sync::Arc<Mutex<BridgeRuntime>>>> {
    BRIDGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn parse_unc_home(value: &str) -> Option<(String, String)> {
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

fn parse_bridge_target(codex_home: Option<&str>) -> Option<BridgeTarget> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = codex_home;
        None
    }
    #[cfg(target_os = "windows")]
    {
        let trimmed = codex_home?.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some((distro, path)) = parse_unc_home(trimmed) {
            return Some(BridgeTarget {
                distro: Some(distro),
                codex_home_linux: Some(path),
            });
        }
        if trimmed.starts_with('/') {
            return Some(BridgeTarget {
                distro: None,
                codex_home_linux: Some(trimmed.to_string()),
            });
        }
        None
    }
}

fn default_bridge_key(target: &BridgeTarget) -> Cow<'_, str> {
    match target.distro.as_deref() {
        Some(distro) if !distro.trim().is_empty() => Cow::Borrowed(distro),
        _ => Cow::Borrowed("__default__"),
    }
}

fn stable_bridge_port(key: &str, slot: usize) -> u16 {
    let mut hash = 2166136261u32;
    for byte in key.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16777619);
    }
    let base = BRIDGE_PORT_BASE + (hash % u32::from(BRIDGE_PORT_SPREAD)) as u16;
    base + u16::try_from(slot).unwrap_or(0)
}

fn bridge_ports_for_target(target: &BridgeTarget) -> Vec<u16> {
    let key = default_bridge_key(target);
    (0..BRIDGE_PORT_CANDIDATES)
        .map(|slot| stable_bridge_port(key.as_ref(), slot))
        .collect()
}

fn python_bridge_script() -> &'static str {
    r#"
import collections
import json
import os
import queue
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

REQUEST_TIMEOUT = 30.0
NOTIFICATION_QUEUE_CAP = 2048
servers = {}
servers_lock = threading.Lock()
notifications = {}
notifications_lock = threading.Lock()

def normalize_home(value):
    text = (value or "").strip()
    return text or ""

def push_notification(home, payload):
    key = normalize_home(home)
    with notifications_lock:
        st = notifications.get(key)
        if st is None:
            st = {"next": 1, "items": collections.deque(maxlen=NOTIFICATION_QUEUE_CAP)}
            notifications[key] = st
        event_id = st["next"]
        st["next"] += 1
        obj = payload if isinstance(payload, dict) else {"payload": payload}
        if "eventId" not in obj:
            obj = dict(obj)
            obj["eventId"] = event_id
        st["items"].append((event_id, obj))

def replay_notifications(home, since_event_id, max_items):
    key = normalize_home(home)
    cap = max(1, min(int(max_items or 1), NOTIFICATION_QUEUE_CAP))
    with notifications_lock:
        st = notifications.get(key)
        if st is None:
            return [], None, None, False
        items = list(st["items"])
    first = items[0][0] if items else None
    last = items[-1][0] if items else None
    gap = first is not None and since_event_id + 1 < first
    out = []
    for event_id, payload in items:
        if event_id <= since_event_id:
            continue
        item = payload if isinstance(payload, dict) else {"payload": payload}
        if "eventId" not in item:
            item = dict(item)
            item["eventId"] = event_id
        out.append(item)
        if len(out) >= cap:
            break
    return out, first, last, gap

class AppServer:
    def __init__(self, codex_home):
        self.codex_home = normalize_home(codex_home)
        self.child = None
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.stdin_lock = threading.Lock()
        self.next_id = 1
        self.reader = None
        self.ensure_started()
        self.request("initialize", {"clientInfo": {"name": "API Router WSL Bridge", "version": "1"}})
        self._write({"method": "initialized", "params": {}})
        self.next_id = 2

    def ensure_started(self):
        if self.child is not None and self.child.poll() is None:
            return
        env = os.environ.copy()
        if self.codex_home:
            env["CODEX_HOME"] = self.codex_home
        elif "CODEX_HOME" in env:
            env.pop("CODEX_HOME", None)
        self.child = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=env,
        )
        self.reader = threading.Thread(target=self._route_stdout, daemon=True)
        self.reader.start()

    def _route_stdout(self):
        try:
            for line in self.child.stdout:
                if not line or not line.strip():
                    continue
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                msg_id = payload.get("id")
                if isinstance(msg_id, int):
                    with self.pending_lock:
                        waiter = self.pending.pop(msg_id, None)
                    if waiter is not None:
                        waiter.put(payload)
                    continue
                if isinstance(payload, dict) and payload.get("method"):
                    push_notification(self.codex_home, payload)
        finally:
            with self.pending_lock:
                pending = list(self.pending.values())
                self.pending.clear()
            for waiter in pending:
                waiter.put({"error": {"message": "codex app-server closed before responding"}})

    def _write(self, payload):
        self.ensure_started()
        if self.child.stdin is None:
            raise RuntimeError("failed to open codex stdin")
        line = json.dumps(payload, ensure_ascii=False)
        with self.stdin_lock:
            self.child.stdin.write(line + "\n")
            self.child.stdin.flush()

    def request(self, method, params):
        self.ensure_started()
        if self.child.poll() is not None:
            raise RuntimeError("codex app-server exited")
        payload = params if isinstance(params, dict) else {}
        msg_id = self.next_id
        self.next_id += 1
        waiter = queue.Queue(maxsize=1)
        with self.pending_lock:
            self.pending[msg_id] = waiter
        try:
            self._write({"id": msg_id, "method": method, "params": payload})
        except Exception:
            with self.pending_lock:
                self.pending.pop(msg_id, None)
            raise
        try:
            response = waiter.get(timeout=REQUEST_TIMEOUT)
        except queue.Empty:
            with self.pending_lock:
                self.pending.pop(msg_id, None)
            raise RuntimeError("codex app-server timed out")
        err = response.get("error")
        if isinstance(err, dict):
            message = err.get("message")
            if isinstance(message, str) and message.strip():
                raise RuntimeError(message.strip())
            raise RuntimeError("codex app-server error")
        if "result" not in response:
            raise RuntimeError("codex app-server response missing result")
        return response["result"]

def get_server(codex_home):
    key = normalize_home(codex_home)
    with servers_lock:
        server = servers.get(key)
        if server is None:
            server = AppServer(key or None)
            servers[key] = server
        return server

class Handler(BaseHTTPRequestHandler):
    server_version = "ApiRouterWslCodexBridge/1.0"

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "bridge": "api-router-wsl-codex-bridge", "version": 1})
            return
        if parsed.path != "/notifications":
            self._send(404, {"error": "not found"})
            return
        query = parse_qs(parsed.query)
        home = (query.get("codexHome") or [""])[0]
        since_event_id = int((query.get("sinceEventId") or ["0"])[0] or 0)
        max_items = int((query.get("max") or ["1"])[0] or 1)
        items, first, last, gap = replay_notifications(home, since_event_id, max_items)
        self._send(
            200,
            {
                "items": items,
                "firstEventId": first,
                "lastEventId": last,
                "gap": gap,
            },
        )

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/rpc":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or "0")
        try:
            body = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(body.decode("utf-8"))
        except Exception as exc:
            self._send(400, {"error": f"invalid request body: {exc}"})
            return
        method = str(payload.get("method") or "").strip()
        if not method:
            self._send(400, {"error": "missing method"})
            return
        params = payload.get("params")
        if not isinstance(params, dict):
            params = {}
        codex_home = payload.get("codexHome")
        if codex_home is not None:
            codex_home = str(codex_home)
        try:
            result = get_server(codex_home).request(method, params)
        except Exception as exc:
            self._send(502, {"error": str(exc)})
            return
        self._send(200, {"result": result})

if __name__ == "__main__":
    host = os.environ.get("API_ROUTER_WSL_BRIDGE_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("API_ROUTER_WSL_BRIDGE_PORT", "42180"))
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()
"#
}

fn build_launch_script(target: &BridgeTarget, port: u16) -> String {
    let encoded = {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        STANDARD.encode(python_bridge_script())
    };
    let distro = target.distro.as_deref().unwrap_or_default();
    let mut prefix = String::new();
    if !distro.trim().is_empty() {
        prefix.push_str(&format!(
            "export WSL_DISTRO_NAME={}; ",
            shell_single_quote(distro)
        ));
    }
    format!(
        "exec >>{log} 2>&1; \
{prefix}PYTHON_BIN=\"$(command -v python3 || command -v python || true)\"; \
if [ -z \"$PYTHON_BIN\" ]; then echo 'python3 not found in WSL' >&2; exit 127; fi; \
export API_ROUTER_WSL_BRIDGE_HOST='127.0.0.1'; \
export API_ROUTER_WSL_BRIDGE_PORT={port}; \
exec \"$PYTHON_BIN\" -u -c \"import base64; exec(base64.b64decode('{encoded}').decode('utf-8'))\"",
        prefix = prefix,
        port = port,
        encoded = encoded,
        log = shell_single_quote(BRIDGE_LOG_PATH),
    )
}

#[cfg(target_os = "windows")]
fn build_launch_command(target: &BridgeTarget, port: u16) -> Command {
    let mut cmd = Command::new("wsl.exe");
    if let Some(distro) = target.distro.as_deref() {
        if !distro.trim().is_empty() {
            cmd.arg("-d").arg(distro);
        }
    }
    cmd.arg("-e")
        .arg("sh")
        .arg("-lc")
        .arg(build_launch_script(target, port));
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.creation_flags(0x08000000);
    cmd
}

#[cfg(test)]
pub async fn _set_test_rpc_handler(
    handler: Option<
        std::sync::Arc<dyn Fn(Option<&str>, &str, Value) -> Result<Value, String> + Send + Sync>,
    >,
) {
    let lock = TEST_RPC_HANDLER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    *guard = handler;
}

#[cfg(test)]
pub async fn _set_test_replay_handler(
    handler: Option<
        std::sync::Arc<
            dyn Fn(Option<&str>, u64, usize) -> (Vec<Value>, Option<u64>, Option<u64>, bool)
                + Send
                + Sync,
        >,
    >,
) {
    let lock = TEST_REPLAY_HANDLER.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    *guard = handler;
}

#[cfg(test)]
async fn maybe_handle_test_rpc(
    codex_home: Option<&str>,
    method: &str,
    params: &Value,
) -> Option<Result<Value, String>> {
    let lock = TEST_RPC_HANDLER.get_or_init(|| Mutex::new(None));
    let guard = lock.lock().await;
    let Some(handler) = guard.as_ref() else {
        return None;
    };
    Some(handler(codex_home, method, params.clone()))
}

#[cfg(test)]
async fn maybe_handle_test_replay(
    codex_home: Option<&str>,
    since_event_id: u64,
    max: usize,
) -> Option<(Vec<Value>, Option<u64>, Option<u64>, bool)> {
    let lock = TEST_REPLAY_HANDLER.get_or_init(|| Mutex::new(None));
    let guard = lock.lock().await;
    let Some(handler) = guard.as_ref() else {
        return None;
    };
    Some(handler(codex_home, since_event_id, max))
}

async fn healthcheck(base_url: &str, client: &Client) -> Result<bool, String> {
    let response = client
        .get(format!("{base_url}/health"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let payload = response.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok(
        payload.get("bridge").and_then(|v| v.as_str()) == Some(BRIDGE_HEALTH_MARKER)
            && payload.get("ok").and_then(|v| v.as_bool()) == Some(true),
    )
}

async fn start_bridge(target: &BridgeTarget) -> Result<BridgeRuntime, String> {
    let client = Client::builder()
        .timeout(BRIDGE_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut errors: Vec<String> = Vec::new();

    for port in bridge_ports_for_target(target) {
        let base_url = format!("http://127.0.0.1:{port}");
        if healthcheck(&base_url, &client).await.unwrap_or(false) {
            return Ok(BridgeRuntime {
                endpoint: BridgeEndpoint { base_url, client },
                child: None,
            });
        }

        #[cfg(target_os = "windows")]
        {
            let mut child = build_launch_command(target, port)
                .spawn()
                .map_err(|e| format!("failed to launch WSL bridge: {e}"))?;
            let deadline = tokio::time::Instant::now() + BRIDGE_START_TIMEOUT;
            let mut launch_dead = None;
            while tokio::time::Instant::now() < deadline {
                if healthcheck(&base_url, &client).await.unwrap_or(false) {
                    return Ok(BridgeRuntime {
                        endpoint: BridgeEndpoint { base_url, client },
                        child: Some(child),
                    });
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        launch_dead = Some(status.to_string());
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        launch_dead = Some(e.to_string());
                        break;
                    }
                }
                tokio::time::sleep(BRIDGE_START_POLL_INTERVAL).await;
            }
            if launch_dead.is_none() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            if let Some(detail) = launch_dead {
                errors.push(format!(
                    "WSL bridge exited before healthcheck on port {port}: {detail}"
                ));
            } else {
                errors.push(format!("WSL bridge did not become healthy on port {port}"));
            }
            continue;
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = port;
            return Err("WSL bridge is only supported on Windows host".to_string());
        }
    }

    Err(if errors.is_empty() {
        "failed to start WSL bridge".to_string()
    } else {
        errors.join("; ")
    })
}

async fn ensure_bridge(target: &BridgeTarget) -> Result<BridgeEndpoint, String> {
    let key = default_bridge_key(target).to_string();
    let lock = bridge_map();

    loop {
        let existing = {
            let guard = lock.lock().await;
            guard.get(&key).cloned()
        };
        if let Some(runtime) = existing {
            let (dead, endpoint) = {
                let mut rt = runtime.lock().await;
                let dead = rt.is_dead().unwrap_or(true);
                let endpoint = rt.endpoint.clone();
                (dead, endpoint)
            };
            if !dead
                && healthcheck(&endpoint.base_url, &endpoint.client)
                    .await
                    .unwrap_or(false)
            {
                return Ok(endpoint);
            }
            let mut guard = lock.lock().await;
            if guard
                .get(&key)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, &runtime))
            {
                guard.remove(&key);
            }
            continue;
        }

        let runtime = start_bridge(target).await?;
        let runtime_arc = std::sync::Arc::new(Mutex::new(runtime));
        let mut guard = lock.lock().await;
        let entry = guard
            .entry(key.clone())
            .or_insert_with(|| runtime_arc.clone())
            .clone();
        let endpoint = {
            let rt = entry.lock().await;
            rt.endpoint.clone()
        };
        return Ok(endpoint);
    }
}

pub async fn try_request_in_home(
    codex_home: Option<&str>,
    method: &str,
    params: Value,
) -> Option<Result<Value, String>> {
    let target = parse_bridge_target(codex_home)?;
    #[cfg(test)]
    if let Some(result) =
        maybe_handle_test_rpc(target.codex_home_linux.as_deref(), method, &params).await
    {
        return Some(result);
    }
    Some(request_via_bridge(&target, method, params).await)
}

pub async fn try_replay_notifications_since_in_home(
    codex_home: Option<&str>,
    since_event_id: u64,
    max: usize,
) -> Option<(Vec<Value>, Option<u64>, Option<u64>, bool)> {
    let target = parse_bridge_target(codex_home)?;
    #[cfg(test)]
    if let Some(result) =
        maybe_handle_test_replay(target.codex_home_linux.as_deref(), since_event_id, max).await
    {
        return Some(result);
    }
    Some(replay_via_bridge(&target, since_event_id, max).await)
}

async fn request_via_bridge(
    target: &BridgeTarget,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let bridge = ensure_bridge(target).await?;
    let response = bridge
        .client
        .post(format!("{}/rpc", bridge.base_url))
        .json(&json!({
            "method": method,
            "params": params,
            "codexHome": target.codex_home_linux,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let payload = response.json::<Value>().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = payload
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("WSL bridge request failed");
        return Err(msg.to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "WSL bridge response missing result".to_string())
}

async fn replay_via_bridge(
    target: &BridgeTarget,
    since_event_id: u64,
    max: usize,
) -> (Vec<Value>, Option<u64>, Option<u64>, bool) {
    let Ok(bridge) = ensure_bridge(target).await else {
        return (Vec::new(), None, None, false);
    };
    let response = bridge
        .client
        .get(format!("{}/notifications", bridge.base_url))
        .query(&[
            (
                "codexHome",
                target.codex_home_linux.clone().unwrap_or_default(),
            ),
            ("sinceEventId", since_event_id.to_string()),
            ("max", max.to_string()),
        ])
        .send()
        .await;
    let Ok(response) = response else {
        return (Vec::new(), None, None, false);
    };
    let Ok(payload) = response.json::<Value>().await else {
        return (Vec::new(), None, None, false);
    };
    let items = payload
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let first = payload.get("firstEventId").and_then(|v| v.as_u64());
    let last = payload.get("lastEventId").and_then(|v| v.as_u64());
    let gap = payload
        .get("gap")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    (items, first, last, gap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wsl_unc_home_for_bridge() {
        let target = parse_bridge_target(Some(r"\\wsl.localhost\Ubuntu\home\me\.codex"))
            .expect("wsl target");
        assert_eq!(target.distro.as_deref(), Some("Ubuntu"));
        assert_eq!(target.codex_home_linux.as_deref(), Some("/home/me/.codex"));
    }

    #[test]
    fn stable_ports_are_deterministic_per_distro() {
        let target = BridgeTarget {
            distro: Some("Ubuntu".to_string()),
            codex_home_linux: Some("/home/me/.codex".to_string()),
        };
        let first = bridge_ports_for_target(&target);
        let second = bridge_ports_for_target(&target);
        assert_eq!(first, second);
        assert_eq!(first.len(), BRIDGE_PORT_CANDIDATES);
    }

    #[test]
    fn launch_script_execs_python_in_foreground_with_log_redirect() {
        let target = BridgeTarget {
            distro: Some("Ubuntu".to_string()),
            codex_home_linux: Some("/home/me/.codex".to_string()),
        };
        let script = build_launch_script(&target, 42180);
        assert!(script.contains("command -v python3"));
        assert!(script.contains("exec >>"));
        assert!(script.contains("exec \"$PYTHON_BIN\" -u -c"));
        assert!(!script.contains("nohup "));
        assert!(script.contains("API_ROUTER_WSL_BRIDGE_HOST='127.0.0.1'"));
        assert!(script.contains(BRIDGE_LOG_PATH));
    }
}
