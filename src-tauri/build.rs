use std::process::Command;
#[cfg(windows)]
use std::{env, fs, path::PathBuf};

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

#[cfg(windows)]
fn prepend_env_path(name: &str, value: &str) {
    let current = env::var_os(name).unwrap_or_default();
    let current_text = current.to_string_lossy();
    let already_present = current_text
        .split(';')
        .any(|part| part.eq_ignore_ascii_case(value));
    if already_present {
        return;
    }
    let next = if current_text.trim().is_empty() {
        value.to_string()
    } else {
        format!("{value};{current_text}")
    };
    env::set_var(name, next);
}

#[cfg(windows)]
fn find_windows_sdk_bin_dir() -> Option<PathBuf> {
    let pf86 = env::var("ProgramFiles(x86)")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "C:\\Program Files (x86)".to_string());
    let kits_bin = PathBuf::from(pf86)
        .join("Windows Kits")
        .join("10")
        .join("bin");
    let preferred_versions = [
        "10.0.26100.0",
        "10.0.22621.0",
        "10.0.22000.0",
        "10.0.19041.0",
    ];
    for version in preferred_versions {
        let dir = kits_bin.join(version).join("x64");
        if dir.join("rc.exe").is_file() {
            return Some(dir);
        }
    }
    let mut discovered = fs::read_dir(&kits_bin)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("x64"))
        .filter(|dir| dir.join("rc.exe").is_file())
        .collect::<Vec<_>>();
    discovered.sort();
    discovered.pop()
}

#[cfg(windows)]
fn configure_windows_resource_toolchain() {
    let Some(bin_dir) = find_windows_sdk_bin_dir() else {
        println!("cargo:warning=Windows SDK rc.exe not found under Windows Kits");
        return;
    };
    if let Some(path) = bin_dir.to_str() {
        prepend_env_path("PATH", path);
    }
    let rc = bin_dir.join("rc.exe");
    let mt = bin_dir.join("mt.exe");
    if rc.is_file() {
        env::set_var("RC", &rc);
    }
    if mt.is_file() {
        env::set_var("MT", &mt);
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

    #[cfg(windows)]
    configure_windows_resource_toolchain();

    tauri_build::build()
}
