use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

static APP_SERVER: OnceLock<Mutex<Option<AppServer>>> = OnceLock::new();

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

struct AppServer {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
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

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open codex stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open codex stdout".to_string())?;
        let mut reader = BufReader::new(stdout).lines();

        let init_id = 1;
        let init = serde_json::json!({
            "id": init_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "Agent Orchestrator",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        write_json_line(&mut stdin, &init).await?;
        let _ = read_response(&mut reader, init_id).await?;

        let initialized = serde_json::json!({
            "method": "initialized",
            "params": {}
        });
        write_json_line(&mut stdin, &initialized).await?;

        Ok(Self {
            child,
            stdin,
            stdout: reader,
            next_id: 2,
        })
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
        write_json_line(&mut self.stdin, &request).await?;
        read_response(&mut self.stdout, request_id).await
    }
}

async fn read_response(
    reader: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    request_id: i64,
) -> Result<Value, String> {
    let response = tokio::time::timeout(REQUEST_TIMEOUT, async {
        while let Some(line) = reader.next_line().await.map_err(|e| e.to_string())? {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("id") == Some(&Value::from(request_id)) {
                    return Ok(value);
                }
            }
        }
        Err("codex app-server closed before responding".to_string())
    })
    .await
    .map_err(|_| "codex app-server timed out".to_string())??;

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
            *guard = None;
            Err(e)
        }
    }
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}
