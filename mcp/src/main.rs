use std::io::Write;
use std::path::PathBuf;

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncReadExt;

// Minimal MCP (JSON-RPC 2.0 over stdio, LSP-style framing).
// We intentionally keep this server small and repo-specific: it helps automation and testing,
// without exposing secrets (we never read back provider keys).

#[derive(Debug, Deserialize)]
struct RpcEnvelope {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct RpcOk<'a> {
    jsonrpc: &'a str,
    id: serde_json::Value,
    result: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct RpcErr<'a> {
    jsonrpc: &'a str,
    id: serde_json::Value,
    error: RpcErrObj,
}

#[derive(Debug, Serialize)]
struct RpcErrObj {
    code: i64,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

fn write_framed(stdout: &mut std::io::StdoutLock<'_>, v: &serde_json::Value) -> anyhow::Result<()> {
    let body = serde_json::to_vec(v)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdout.write_all(header.as_bytes())?;
    stdout.write_all(&body)?;
    stdout.flush()?;
    Ok(())
}

async fn read_framed(stdin: &mut tokio::io::Stdin) -> anyhow::Result<Option<Vec<u8>>> {
    // Read headers until \r\n\r\n, then read Content-Length bytes.
    let mut header_bytes = Vec::<u8>::new();
    let mut buf = [0u8; 1];
    loop {
        let n = stdin.read(&mut buf).await?;
        if n == 0 {
            if header_bytes.is_empty() {
                return Ok(None);
            }
            return Err(anyhow!("unexpected EOF while reading headers"));
        }
        header_bytes.push(buf[0]);
        if header_bytes.ends_with(b"\r\n\r\n") {
            break;
        }
        if header_bytes.len() > 32 * 1024 {
            return Err(anyhow!("header too large"));
        }
    }

    let header = String::from_utf8_lossy(&header_bytes);
    let mut content_len: Option<usize> = None;
    for line in header.split("\r\n") {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.eq_ignore_ascii_case("content-length") {
            let n = v.trim().parse::<usize>()?;
            content_len = Some(n);
        }
    }
    let len = content_len.ok_or_else(|| anyhow!("missing Content-Length"))?;

    let mut body = vec![0u8; len];
    stdin.read_exact(&mut body).await?;
    Ok(Some(body))
}

fn user_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("AO_USER_DATA_DIR") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return pb;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let p = cwd.join("user-data");
    if p.is_dir() {
        return p;
    }
    cwd
}

fn config_path() -> PathBuf {
    user_data_dir().join("config.toml")
}

fn read_config() -> anyhow::Result<toml::Value> {
    let p = config_path();
    let txt = std::fs::read_to_string(&p).with_context(|| format!("read config: {}", p.display()))?;
    Ok(toml::from_str(&txt)?)
}

fn write_config(v: &toml::Value) -> anyhow::Result<()> {
    let p = config_path();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&p, toml::to_string_pretty(v)?)?;
    Ok(())
}

async fn http_get_json(url: &str) -> anyhow::Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .user_agent("agent-orchestrator-mcp/0.1")
        .build()?;
    let j = client.get(url).send().await?.json::<serde_json::Value>().await?;
    Ok(j)
}

fn tool_list() -> serde_json::Value {
    // Minimal toolset: status probes + safe, fixed test/build commands + config edits.
    json!({
      "tools": [
        {
          "name": "ao.health",
          "description": "Fetch gateway /health (defaults to http://127.0.0.1:4000).",
          "inputSchema": {
            "type": "object",
            "properties": { "baseUrl": { "type": "string" } }
          }
        },
        {
          "name": "ao.status",
          "description": "Fetch gateway /status (defaults to http://127.0.0.1:4000).",
          "inputSchema": {
            "type": "object",
            "properties": { "baseUrl": { "type": "string" } }
          }
        },
        {
          "name": "ao.config.get",
          "description": "Read user-data/config.toml (AO_USER_DATA_DIR or ./user-data).",
          "inputSchema": { "type": "object", "properties": {} }
        },
        {
          "name": "ao.config.setProviderBaseUrl",
          "description": "Update providers.<name>.base_url in user-data/config.toml.",
          "inputSchema": {
            "type": "object",
            "required": ["provider", "baseUrl"],
            "properties": {
              "provider": { "type": "string" },
              "baseUrl": { "type": "string" }
            }
          }
        },
        {
          "name": "ao.config.setUsageBaseUrl",
          "description": "Set providers.<name>.usage_base_url in user-data/config.toml (optional override for usage endpoints).",
          "inputSchema": {
            "type": "object",
            "required": ["provider", "usageBaseUrl"],
            "properties": {
              "provider": { "type": "string" },
              "usageBaseUrl": { "type": "string" }
            }
          }
        },
        {
          "name": "ao.dev.run",
          "description": "Run a safe, predefined command (npm_build | cargo_test | cargo_clippy).",
          "inputSchema": {
            "type": "object",
            "required": ["cmd"],
            "properties": {
              "cmd": { "type": "string", "enum": ["npm_build", "cargo_test", "cargo_clippy"] }
            }
          }
        }
      ]
    })
}

async fn run_cmd(kind: &str) -> anyhow::Result<serde_json::Value> {
    let (program, args, cwd) = match kind {
        "npm_build" => ("npm", vec!["run", "build"], std::env::current_dir()?),
        "cargo_test" => (
            "cargo",
            vec!["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
            std::env::current_dir()?,
        ),
        "cargo_clippy" => (
            "cargo",
            vec![
                "clippy",
                "--manifest-path",
                "src-tauri/Cargo.toml",
                "--",
                "-D",
                "warnings",
            ],
            std::env::current_dir()?,
        ),
        _ => return Err(anyhow!("unknown cmd: {kind}")),
    };

    let child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    let out = child.wait_with_output().await?;
    Ok(json!({
      "ok": out.status.success(),
      "code": out.status.code(),
      "stdout": String::from_utf8_lossy(&out.stdout),
      "stderr": String::from_utf8_lossy(&out.stderr),
    }))
}

fn toml_set_provider_base_url(mut cfg: toml::Value, provider: &str, base_url: &str) -> anyhow::Result<toml::Value> {
    let providers = cfg
        .get_mut("providers")
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow!("missing providers table"))?;

    let p = providers
        .get_mut(provider)
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow!("unknown provider: {provider}"))?;

    p.insert("base_url".to_string(), toml::Value::String(base_url.to_string()));
    Ok(cfg)
}

fn toml_set_provider_usage_base_url(
    mut cfg: toml::Value,
    provider: &str,
    usage_base_url: &str,
) -> anyhow::Result<toml::Value> {
    let providers = cfg
        .get_mut("providers")
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow!("missing providers table"))?;

    let p = providers
        .get_mut(provider)
        .and_then(|v| v.as_table_mut())
        .ok_or_else(|| anyhow!("unknown provider: {provider}"))?;

    p.insert(
        "usage_base_url".to_string(),
        toml::Value::String(usage_base_url.to_string()),
    );
    Ok(cfg)
}

async fn handle_tool_call(name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    match name {
        "ao.health" => {
            let base = args
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("http://127.0.0.1:4000")
                .trim_end_matches('/');
            http_get_json(&format!("{base}/health")).await
        }
        "ao.status" => {
            let base = args
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("http://127.0.0.1:4000")
                .trim_end_matches('/');
            http_get_json(&format!("{base}/status")).await
        }
        "ao.config.get" => {
            let v = read_config()?;
            Ok(serde_json::to_value(v)?)
        }
        "ao.config.setProviderBaseUrl" => {
            let provider = args
                .get("provider")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("missing provider"))?;
            let base_url = args
                .get("baseUrl")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("missing baseUrl"))?;
            let cfg = read_config()?;
            let next = toml_set_provider_base_url(cfg, provider, base_url)?;
            write_config(&next)?;
            Ok(json!({"ok": true}))
        }
        "ao.config.setUsageBaseUrl" => {
            let provider = args
                .get("provider")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("missing provider"))?;
            let usage_base_url = args
                .get("usageBaseUrl")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("missing usageBaseUrl"))?;
            let cfg = read_config()?;
            let next = toml_set_provider_usage_base_url(cfg, provider, usage_base_url)?;
            write_config(&next)?;
            Ok(json!({"ok": true}))
        }
        "ao.dev.run" => {
            let cmd = args
                .get("cmd")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("missing cmd"))?;
            run_cmd(cmd).await
        }
        _ => Err(anyhow!("unknown tool: {name}")),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut stdin = tokio::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let Some(body) = read_framed(&mut stdin).await? else {
            break;
        };
        let msg: RpcEnvelope = serde_json::from_slice(&body)
            .map_err(|e| anyhow!("invalid json: {e}"))
            .context("parse request")?;
        if msg.jsonrpc.trim() != "2.0" {
            // MCP uses JSON-RPC 2.0. Keep strict so clients can detect errors early.
            continue;
        }

        // Notifications have no id; MCP sends plenty of them. Ignore.
        let Some(id) = msg.id.clone() else {
            continue;
        };

        let result = match msg.method.as_str() {
            "initialize" => Ok(json!({
              "protocolVersion": "2024-11-05",
              "serverInfo": { "name": "agent-orchestrator-mcp", "version": "0.1.0" },
              "capabilities": { "tools": {} }
            })),
            "tools/list" => Ok(tool_list()),
            "tools/call" => {
                let tool_name = msg
                    .params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("missing params.name"))?;
                let tool_args = msg.params.get("arguments").cloned().unwrap_or(json!({}));
                handle_tool_call(tool_name, tool_args).await
            }
            "ping" => Ok(json!({ "ok": true })),
            _ => Err(anyhow!("unknown method: {}", msg.method)),
        };

        let out = match result {
            Ok(v) => serde_json::to_value(RpcOk {
                jsonrpc: "2.0",
                id,
                result: v,
            })?,
            Err(e) => serde_json::to_value(RpcErr {
                jsonrpc: "2.0",
                id,
                error: RpcErrObj {
                    code: -32000,
                    message: e.to_string(),
                    data: None,
                },
            })?,
        };

        write_framed(&mut stdout, &out)?;
    }

    Ok(())
}
