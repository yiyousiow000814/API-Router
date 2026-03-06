use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn main() {
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs");

    let git_sha = git_output(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=API_ROUTER_BUILD_GIT_SHA={git_sha}");

    let git_short_sha =
        git_output(&["rev-parse", "--short=8", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=API_ROUTER_BUILD_GIT_SHORT_SHA={git_short_sha}");

    tauri_build::build()
}
