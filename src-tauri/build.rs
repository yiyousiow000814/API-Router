#[path = "build_support/git_exec.rs"]
mod git_exec;
#[path = "src/platform/git_layout.rs"]
mod git_layout;

use std::path::{Path, PathBuf};
use std::{env, fs};

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
}

fn git_output(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = git_exec::new_git_command()
        .args(args)
        .current_dir(repo_root)
        .output()
        .ok()?;
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
#[derive(Clone)]
struct WindowsSdkToolchain {
    bin_dir: PathBuf,
    rc_path: PathBuf,
    mt_path: Option<PathBuf>,
    checked_rc_paths: Vec<PathBuf>,
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
fn preferred_windows_sdk_versions() -> [&'static str; 4] {
    [
        "10.0.26100.0",
        "10.0.22621.0",
        "10.0.22000.0",
        "10.0.19041.0",
    ]
}

#[cfg(windows)]
fn discover_windows_sdk_bin_dirs(kits_bin: &Path) -> Vec<PathBuf> {
    let mut discovered = fs::read_dir(kits_bin)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
        .map(|entry| entry.path().join("x64"))
        .filter(|dir| dir.join("rc.exe").is_file())
        .collect::<Vec<_>>();
    discovered.sort();
    discovered.reverse();
    discovered
}

#[cfg(windows)]
fn resolve_windows_sdk_toolchain() -> Result<WindowsSdkToolchain, String> {
    let mut checked_rc_paths = Vec::new();
    if let (Ok(sdk_dir), Ok(sdk_version)) =
        (env::var("WindowsSdkDir"), env::var("WindowsSDKVersion"))
    {
        let normalized_version = sdk_version.trim().trim_end_matches('\\');
        let candidate = PathBuf::from(sdk_dir)
            .join("bin")
            .join(normalized_version)
            .join("x64");
        checked_rc_paths.push(candidate.join("rc.exe"));
        if candidate.join("rc.exe").is_file() {
            let mt_path = candidate.join("mt.exe");
            return Ok(WindowsSdkToolchain {
                rc_path: candidate.join("rc.exe"),
                mt_path: mt_path.is_file().then_some(mt_path),
                bin_dir: candidate,
                checked_rc_paths,
            });
        }
    }
    let pf86 = env::var("ProgramFiles(x86)")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "C:\\Program Files (x86)".to_string());
    let kits_bin = PathBuf::from(pf86)
        .join("Windows Kits")
        .join("10")
        .join("bin");
    for version in preferred_windows_sdk_versions() {
        let dir = kits_bin.join(version).join("x64");
        checked_rc_paths.push(dir.join("rc.exe"));
        if dir.join("rc.exe").is_file() {
            let mt_path = dir.join("mt.exe");
            return Ok(WindowsSdkToolchain {
                rc_path: dir.join("rc.exe"),
                mt_path: mt_path.is_file().then_some(mt_path),
                bin_dir: dir,
                checked_rc_paths,
            });
        }
    }
    for dir in discover_windows_sdk_bin_dirs(&kits_bin) {
        let rc_path = dir.join("rc.exe");
        if checked_rc_paths.iter().all(|path| path != &rc_path) {
            checked_rc_paths.push(rc_path.clone());
        }
        if rc_path.is_file() {
            let mt_path = dir.join("mt.exe");
            return Ok(WindowsSdkToolchain {
                rc_path,
                mt_path: mt_path.is_file().then_some(mt_path),
                bin_dir: dir,
                checked_rc_paths,
            });
        }
    }

    let mut parts = Vec::new();
    parts.push(format!(
        "WindowsSdkDir={}",
        env::var("WindowsSdkDir").unwrap_or_else(|_| "<unset>".to_string())
    ));
    parts.push(format!(
        "WindowsSDKVersion={}",
        env::var("WindowsSDKVersion").unwrap_or_else(|_| "<unset>".to_string())
    ));
    parts.push(format!("kits_bin={}", kits_bin.display()));
    parts.push(format!(
        "checked_rc_paths={}",
        checked_rc_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    Err(parts.join("; "))
}

#[cfg(windows)]
fn configure_windows_resource_toolchain() {
    let toolchain = resolve_windows_sdk_toolchain().unwrap_or_else(|report| {
        panic!("Windows resource toolchain probe failed before tauri-build. {report}")
    });
    if env::var("API_ROUTER_WIN_SDK_TRACE").as_deref() == Ok("1") {
        println!(
            "cargo:warning=windows resource toolchain bin={} rc={} mt={} checked={}",
            toolchain.bin_dir.display(),
            toolchain.rc_path.display(),
            toolchain
                .mt_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<missing>".to_string()),
            toolchain
                .checked_rc_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    if let Some(path) = toolchain.bin_dir.to_str() {
        prepend_env_path("PATH", path);
    }
    env::set_var("RC", &toolchain.rc_path);
    env::set_var("CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RC", &toolchain.rc_path);
    if let Some(mt_path) = &toolchain.mt_path {
        env::set_var("MT", mt_path);
        env::set_var("CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_MT", mt_path);
    }
}

fn main() {
    let repo_root = repo_root();
    #[cfg(windows)]
    println!("cargo:rerun-if-env-changed=API_ROUTER_WIN_SDK_TRACE");
    for path in git_layout::git_watch_paths(&repo_root) {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let git_sha =
        git_output(&repo_root, &["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=API_ROUTER_BUILD_GIT_SHA={git_sha}");

    let git_short_sha = git_output(&repo_root, &["rev-parse", "--short=8", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=API_ROUTER_BUILD_GIT_SHORT_SHA={git_short_sha}");
    let git_commit_unix_ms = git_output(&repo_root, &["show", "-s", "--format=%ct", "HEAD"])
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.saturating_mul(1000));

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let build_info_rs = out_dir.join("build_info.rs");
    let build_info = format!(
        "pub const API_ROUTER_BUILD_GIT_SHA: &str = {:?};\n\
         pub const API_ROUTER_BUILD_GIT_SHORT_SHA: &str = {:?};\n\
         pub const API_ROUTER_BUILD_GIT_COMMIT_UNIX_MS: Option<u64> = {:?};\n",
        git_sha, git_short_sha, git_commit_unix_ms
    );
    fs::write(&build_info_rs, build_info).expect("write build_info.rs");
    println!("cargo:rerun-if-changed={}", build_info_rs.display());

    #[cfg(windows)]
    configure_windows_resource_toolchain();

    tauri_build::build()
}
