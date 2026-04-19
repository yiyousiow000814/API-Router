use super::web_codex_home::{parse_workspace_target, WorkspaceTarget};
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const WORKTREE_CACHE_TTL: Duration = Duration::from_secs(300);

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorktreeCacheEntry {
    is_worktree: bool,
    observed_at: Instant,
}

fn worktree_cache() -> &'static Mutex<HashMap<String, WorktreeCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, WorktreeCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitBranchOption {
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pr_number: Option<u64>,
}

fn normalize_cache_key(workspace: Option<&str>, cwd: &str) -> Option<String> {
    let workspace = workspace
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("windows")
        .to_ascii_lowercase();
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return None;
    }
    let normalized_cwd = if workspace == "wsl2" {
        cwd.to_string()
    } else {
        cwd.replace('\\', "/").to_ascii_lowercase()
    };
    Some(format!("{workspace}:{normalized_cwd}"))
}

fn read_cached_worktree_status(entry: WorktreeCacheEntry, now: Instant) -> Option<bool> {
    if now.duration_since(entry.observed_at) > WORKTREE_CACHE_TTL {
        None
    } else {
        Some(entry.is_worktree)
    }
}

fn has_uncommitted_changes(status_output: &str) -> bool {
    status_output
        .lines()
        .any(status_line_counts_as_tracked_change)
}

pub(super) fn count_uncommitted_changes(status_output: &str) -> usize {
    status_output
        .lines()
        .filter(|line| status_line_counts_as_tracked_change(line))
        .count()
}

fn status_line_counts_as_tracked_change(line: &str) -> bool {
    let normalized = line.trim_end();
    !normalized.trim().is_empty() && !normalized.starts_with("??") && !normalized.starts_with("!!")
}

fn branch_switch_args(branch: &str) -> [&str; 3] {
    ["switch", "--", branch]
}

fn branch_checkout_fallback_args(branch: &str) -> [&str; 2] {
    ["checkout", branch]
}

fn format_branch_switch_fallback_error(switch_error: &str, checkout_error: &str) -> String {
    format!(
        "git switch failed: {}; git checkout fallback failed: {}",
        switch_error.trim(),
        checkout_error.trim()
    )
}

pub(super) async fn run_git_command_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
    args: &[&str],
) -> Result<String, String> {
    let target = workspace.and_then(parse_workspace_target);
    let mut command = if matches!(target, Some(WorkspaceTarget::Wsl2)) {
        let mut script = format!("git -C {}", shell_quote(cwd));
        for arg in args {
            script.push(' ');
            script.push_str(&shell_quote(arg));
        }
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.arg("-e").arg("bash").arg("-lc").arg(script);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("-C").arg(cwd);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    };
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "git command timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() {
            "git command failed".to_string()
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(super) async fn run_gh_command_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
    args: &[&str],
) -> Result<String, String> {
    let target = workspace.and_then(parse_workspace_target);
    let mut command = if matches!(target, Some(WorkspaceTarget::Wsl2)) {
        let mut script = format!("cd {} && gh", shell_quote(cwd));
        for arg in args {
            script.push(' ');
            script.push_str(&shell_quote(arg));
        }
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.arg("-e").arg("bash").arg("-lc").arg(script);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("gh");
        cmd.current_dir(cwd);
        for arg in args {
            cmd.arg(arg);
        }
        cmd
    };
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "gh command timed out".to_string())?
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if detail.is_empty() {
            "gh command failed".to_string()
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Deserialize)]
struct GhPrListItem {
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    number: u64,
}

async fn pr_numbers_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<HashMap<String, u64>, String> {
    let output = run_gh_command_for_workspace(
        workspace,
        cwd,
        &[
            "pr",
            "list",
            "--limit",
            "100",
            "--state",
            "open",
            "--json",
            "headRefName,number",
        ],
    )
    .await?;
    let items: Vec<GhPrListItem> = serde_json::from_str(&output).map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for item in items {
        map.insert(item.head_ref_name, item.number);
    }
    Ok(map)
}

fn build_visible_branch_options(
    current_branch: &str,
    local_branches: Vec<String>,
    pr_numbers: HashMap<String, u64>,
) -> Vec<GitBranchOption> {
    let current_branch = current_branch.trim();
    let mut seen = HashSet::new();

    // Candidates for "active" branches:
    // - Default branches (main/master) if they exist
    // - The current branch
    // - Any local branch with an open PR
    let mut options: Vec<GitBranchOption> = local_branches
        .into_iter()
        .filter(|name| {
            name == "main"
                || name == "master"
                || name == current_branch
                || pr_numbers.contains_key(name)
        })
        .map(|name| {
            seen.insert(name.clone());
            let pr_number = pr_numbers.get(&name).copied();
            GitBranchOption { name, pr_number }
        })
        .collect();

    // Ensure current_branch is included even if not in local_branches (e.g. fresh clone)
    if !current_branch.is_empty() && !seen.contains(current_branch) {
        options.push(GitBranchOption {
            name: current_branch.to_string(),
            pr_number: pr_numbers.get(current_branch).copied(),
        });
    }

    // Stable sort to keep main/master first while preserving committer-date order for others
    options.sort_by(|a, b| {
        let a_is_main = a.name == "main" || a.name == "master";
        let b_is_main = b.name == "main" || b.name == "master";
        if a_is_main && !b_is_main {
            std::cmp::Ordering::Less
        } else if !a_is_main && b_is_main {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });

    options
}

pub(super) async fn visible_branch_options_for_workspace_with_current_branch(
    workspace: Option<&str>,
    cwd: &str,
    current_branch: &str,
) -> Result<Vec<GitBranchOption>, String> {
    let local_branches = local_branches_for_workspace(workspace, cwd).await?;
    let pr_numbers = pr_numbers_for_workspace(workspace, cwd)
        .await
        .unwrap_or_default();
    Ok(build_visible_branch_options(
        current_branch,
        local_branches,
        pr_numbers,
    ))
}

const WORKTREE_DETECTION_GIT_ARGS: &[&str] = &[
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
];

fn parse_worktree_detection_output(output: &str) -> Result<bool, String> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let _root = lines
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "git rev-parse missing repo root".to_string())?;
    let git_dir = lines
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "git rev-parse missing git dir".to_string())?;
    let git_common_dir = lines
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "git rev-parse missing git common dir".to_string())?;
    Ok(git_dir != git_common_dir)
}

pub(super) async fn detect_git_worktree_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<bool, String> {
    let Some(cache_key) = normalize_cache_key(workspace, cwd) else {
        return Ok(false);
    };
    {
        let cache = worktree_cache();
        let guard = match cache.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if let Some(entry) = guard.get(&cache_key).copied() {
            if let Some(value) = read_cached_worktree_status(entry, Instant::now()) {
                return Ok(value);
            }
        }
    }
    let output = run_git_command_for_workspace(workspace, cwd, WORKTREE_DETECTION_GIT_ARGS).await?;
    let is_worktree = parse_worktree_detection_output(&output)?;
    let cache = worktree_cache();
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(err) => err.into_inner(),
    };
    guard.insert(
        cache_key,
        WorktreeCacheEntry {
            is_worktree,
            observed_at: Instant::now(),
        },
    );
    Ok(is_worktree)
}

pub(super) async fn current_branch_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<String, String> {
    Ok(
        run_git_command_for_workspace(workspace, cwd, &["branch", "--show-current"])
            .await?
            .lines()
            .next()
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
    )
}

pub(super) async fn local_branches_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<Vec<String>, String> {
    let branches = run_git_command_for_workspace(
        workspace,
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "--sort=-committerdate",
            "refs/heads",
        ],
    )
    .await?;
    Ok(branches
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect())
}

pub(super) async fn ensure_clean_worktree_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<(), String> {
    let status_output = run_git_command_for_workspace(
        workspace,
        cwd,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )
    .await?;
    if has_uncommitted_changes(&status_output) {
        return Err(
            "cannot switch branches with uncommitted changes; commit or stash them first"
                .to_string(),
        );
    }
    Ok(())
}

pub(super) async fn uncommitted_file_count_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<usize, String> {
    let status_output = run_git_command_for_workspace(
        workspace,
        cwd,
        &["status", "--porcelain=v1", "--untracked-files=no"],
    )
    .await?;
    Ok(count_uncommitted_changes(&status_output))
}

pub(super) async fn switch_branch_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
    branch: &str,
) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch is required".to_string());
    }
    ensure_clean_worktree_for_workspace(workspace, cwd).await?;
    match run_git_command_for_workspace(workspace, cwd, &branch_switch_args(branch)).await {
        Ok(_) => Ok(()),
        Err(switch_error) => {
            run_git_command_for_workspace(workspace, cwd, &branch_checkout_fallback_args(branch))
                .await
                .map(|_| ())
                .map_err(|checkout_error| {
                    format_branch_switch_fallback_error(&switch_error, &checkout_error)
                })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_visible_branch_options_filters_for_active_branches() {
        let visible = build_visible_branch_options(
            "current",
            vec![
                "main".to_string(),
                "current".to_string(),
                "with-pr".to_string(),
                "inactive".to_string(),
            ],
            HashMap::from([("with-pr".to_string(), 123)]),
        );
        // Should have: main, current, with-pr. Should NOT have: inactive.
        assert_eq!(visible.len(), 3);
        assert!(visible.iter().any(|o| o.name == "main"));
        assert!(visible.iter().any(|o| o.name == "current"));
        assert!(visible.iter().any(|o| o.name == "with-pr"));
        assert!(!visible.iter().any(|o| o.name == "inactive"));
    }

    #[test]
    fn build_visible_branch_options_keeps_current_even_if_not_local() {
        let visible =
            build_visible_branch_options("detached", vec!["main".to_string()], HashMap::new());
        assert_eq!(visible.len(), 2);
        assert!(visible.iter().any(|o| o.name == "detached"));
    }

    #[test]
    fn build_visible_branch_options_omits_empty_current_branch_if_no_locals() {
        assert!(build_visible_branch_options("", Vec::new(), HashMap::new()).is_empty());
    }

    #[test]
    fn build_visible_branch_options_puts_main_first() {
        let visible = build_visible_branch_options(
            "feat/a",
            vec![
                "feat/b".to_string(),
                "main".to_string(),
                "feat/a".to_string(),
            ],
            HashMap::new(),
        );
        assert_eq!(visible[0].name, "main");
    }

    #[test]
    fn worktree_detection_uses_absolute_git_paths() {
        assert_eq!(
            WORKTREE_DETECTION_GIT_ARGS,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-dir",
                "--git-common-dir",
            ]
        );
    }

    #[test]
    fn parse_worktree_detection_output_reads_absolute_git_paths() {
        let output = "C:/repo\nC:/repo/.git\nC:/repo/.git\n";
        assert_eq!(parse_worktree_detection_output(output), Ok(false));

        let worktree_output = "C:/repo/worktree\nC:/repo/.git/worktrees/feature\nC:/repo/.git\n";
        assert_eq!(parse_worktree_detection_output(worktree_output), Ok(true));
    }

    #[test]
    fn read_cached_worktree_status_expires_stale_entries() {
        let now = Instant::now();
        let fresh_entry = WorktreeCacheEntry {
            is_worktree: true,
            observed_at: now - Duration::from_secs(30),
        };
        let stale_entry = WorktreeCacheEntry {
            is_worktree: false,
            observed_at: now - WORKTREE_CACHE_TTL - Duration::from_secs(1),
        };

        assert_eq!(read_cached_worktree_status(fresh_entry, now), Some(true));
        assert_eq!(read_cached_worktree_status(stale_entry, now), None);
    }

    #[test]
    fn has_uncommitted_changes_ignores_untracked_files() {
        assert!(!has_uncommitted_changes(""));
        assert!(!has_uncommitted_changes("   \n"));
        assert!(has_uncommitted_changes(" M src/main.rs\n"));
        assert!(has_uncommitted_changes("M  src/main.rs\n"));
        assert!(!has_uncommitted_changes("?? notes.txt\n"));
        assert!(!has_uncommitted_changes("?? notes.txt\n!! target/\n"));
    }

    #[test]
    fn count_uncommitted_changes_counts_only_tracked_changes() {
        assert_eq!(count_uncommitted_changes(""), 0);
        assert_eq!(count_uncommitted_changes("   \n"), 0);
        assert_eq!(count_uncommitted_changes(" M src/main.rs\n"), 1);
        assert_eq!(count_uncommitted_changes("?? notes.txt\n"), 0);
        assert_eq!(
            count_uncommitted_changes(" M src/main.rs\nM  src/lib.rs\n?? notes.txt\n"),
            2
        );
    }

    #[test]
    fn status_line_counts_as_tracked_change_preserves_porcelain_prefixes() {
        assert!(status_line_counts_as_tracked_change(" M src/main.rs"));
        assert!(status_line_counts_as_tracked_change("M  src/lib.rs   "));
        assert!(!status_line_counts_as_tracked_change("?? notes.txt"));
        assert!(!status_line_counts_as_tracked_change("!! target/"));
    }

    #[test]
    fn branch_switch_and_checkout_fallback_use_correct_git_args() {
        assert_eq!(
            branch_switch_args("feature/demo"),
            ["switch", "--", "feature/demo"]
        );
        assert_eq!(
            branch_checkout_fallback_args("feature/demo"),
            ["checkout", "feature/demo"]
        );
    }

    #[test]
    fn branch_switch_fallback_error_keeps_both_git_failures() {
        assert_eq!(
            format_branch_switch_fallback_error("fatal: bad switch target", "error: pathspec not found"),
            "git switch failed: fatal: bad switch target; git checkout fallback failed: error: pathspec not found"
        );
    }
}
