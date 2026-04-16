use super::web_codex_home::{parse_workspace_target, WorkspaceTarget};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubPullRequestSummary {
    number: u64,
    head_ref_name: String,
    #[serde(default)]
    base_ref_name: String,
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

async fn run_gh_command_for_workspace(
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

fn normalize_origin_head_branch(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix("refs/remotes/origin/") {
        let branch = stripped.trim();
        return (!branch.is_empty()).then(|| branch.to_string());
    }
    if let Some(stripped) = trimmed.strip_prefix("origin/") {
        let branch = stripped.trim();
        return (!branch.is_empty()).then(|| branch.to_string());
    }
    Some(trimmed.to_string())
}

fn parse_open_pull_requests(payload: &str) -> Result<Vec<GithubPullRequestSummary>, String> {
    serde_json::from_str::<Vec<GithubPullRequestSummary>>(payload).map_err(|err| err.to_string())
}

fn preferred_default_branch_name(
    explicit_default_branch: Option<&str>,
    open_pull_requests: &[GithubPullRequestSummary],
) -> Option<String> {
    let explicit = explicit_default_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if explicit.is_some() {
        return explicit;
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for pull_request in open_pull_requests {
        let base_branch = pull_request.base_ref_name.trim();
        if base_branch.is_empty() {
            continue;
        }
        *counts.entry(base_branch.to_string()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by(|(left_branch, left_count), (right_branch, right_count)| {
            left_count
                .cmp(right_count)
                .then_with(|| right_branch.cmp(left_branch))
        })
        .map(|(branch, _)| branch)
}

fn build_visible_branch_options(
    current_branch: &str,
    default_branch: Option<&str>,
    open_pull_requests: &[GithubPullRequestSummary],
) -> Vec<GitBranchOption> {
    let current_branch = current_branch.trim();
    let default_branch = preferred_default_branch_name(default_branch, open_pull_requests);
    let pr_numbers_by_branch: HashMap<String, u64> = open_pull_requests
        .iter()
        .filter_map(|pull_request| {
            let branch = pull_request.head_ref_name.trim();
            (!branch.is_empty()).then(|| (branch.to_string(), pull_request.number))
        })
        .collect();
    let mut branch_names = Vec::new();
    if let Some(default_branch) = default_branch.as_deref() {
        let default_branch = default_branch.trim();
        if !default_branch.is_empty() {
            branch_names.push(default_branch.to_string());
        }
    }
    if !current_branch.is_empty() {
        branch_names.push(current_branch.to_string());
    }
    let mut pull_request_branch_names: Vec<String> = pr_numbers_by_branch.keys().cloned().collect();
    pull_request_branch_names.sort();
    branch_names.extend(pull_request_branch_names);

    let mut seen = std::collections::HashSet::new();
    branch_names
        .into_iter()
        .filter(|branch| seen.insert(branch.to_string()))
        .map(|branch| GitBranchOption {
            pr_number: pr_numbers_by_branch.get(&branch).copied(),
            name: branch,
        })
        .collect()
}

async fn repo_default_branch_for_workspace(workspace: Option<&str>, cwd: &str) -> Option<String> {
    run_git_command_for_workspace(
        workspace,
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .await
    .ok()
    .and_then(|output| normalize_origin_head_branch(&output))
}

async fn open_pull_requests_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
) -> Result<Vec<GithubPullRequestSummary>, String> {
    let output = run_gh_command_for_workspace(
        workspace,
        cwd,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,headRefName,baseRefName",
        ],
    )
    .await?;
    parse_open_pull_requests(&output)
}

pub(super) async fn visible_branch_options_for_workspace_with_current_branch(
    workspace: Option<&str>,
    cwd: &str,
    current_branch: &str,
) -> Result<Vec<GitBranchOption>, String> {
    let (default_branch, open_pull_requests_result) = tokio::join!(
        repo_default_branch_for_workspace(workspace, cwd),
        open_pull_requests_for_workspace(workspace, cwd)
    );
    let open_pull_requests = open_pull_requests_result.unwrap_or_default();
    Ok(build_visible_branch_options(
        current_branch,
        default_branch.as_deref(),
        &open_pull_requests,
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

pub(super) async fn switch_branch_for_workspace(
    workspace: Option<&str>,
    cwd: &str,
    branch: &str,
) -> Result<(), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err("branch is required".to_string());
    }
    match run_git_command_for_workspace(workspace, cwd, &["switch", "--", branch]).await {
        Ok(_) => Ok(()),
        Err(_) => run_git_command_for_workspace(workspace, cwd, &["checkout", "--", branch])
            .await
            .map(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_origin_head_branch_removes_origin_prefix() {
        assert_eq!(
            normalize_origin_head_branch("origin/main"),
            Some("main".to_string())
        );
        assert_eq!(
            normalize_origin_head_branch("refs/remotes/origin/release/web"),
            Some("release/web".to_string())
        );
        assert_eq!(normalize_origin_head_branch("   "), None);
    }

    #[test]
    fn parse_open_pull_requests_reads_head_branch_and_number() {
        let pull_requests = parse_open_pull_requests(
            r#"[{"number":150,"headRefName":"chore/web-codex-terminal-communication","baseRefName":"main"},{"number":168,"headRefName":"docs/repo-refactor-blueprint","baseRefName":"main"}]"#,
        )
        .expect("pull request payload");

        assert_eq!(pull_requests.len(), 2);
        assert_eq!(pull_requests[0].number, 150);
        assert_eq!(
            pull_requests[1].head_ref_name,
            "docs/repo-refactor-blueprint".to_string()
        );
    }

    #[test]
    fn build_visible_branch_options_keeps_default_branch_first() {
        let pull_requests = parse_open_pull_requests(
            r#"[{"number":168,"headRefName":"docs/repo-refactor-blueprint","baseRefName":"main"},{"number":150,"headRefName":"chore/web-codex-terminal-communication","baseRefName":"main"}]"#,
        )
        .expect("pull request payload");

        let visible = build_visible_branch_options(
            "docs/repo-refactor-blueprint",
            Some("main"),
            &pull_requests,
        );

        assert_eq!(
            visible,
            vec![
                GitBranchOption {
                    name: "main".to_string(),
                    pr_number: None,
                },
                GitBranchOption {
                    name: "docs/repo-refactor-blueprint".to_string(),
                    pr_number: Some(168),
                },
                GitBranchOption {
                    name: "chore/web-codex-terminal-communication".to_string(),
                    pr_number: Some(150),
                },
            ]
        );
    }

    #[test]
    fn build_visible_branch_options_preserves_pr_number_for_current_branch() {
        let pull_requests = parse_open_pull_requests(
            r#"[{"number":196,"headRefName":"feat/codex-web-branch-picker","baseRefName":"main"}]"#,
        )
        .expect("pull request payload");

        let visible = build_visible_branch_options(
            "feat/codex-web-branch-picker",
            Some("main"),
            &pull_requests,
        );

        assert_eq!(
            visible,
            vec![
                GitBranchOption {
                    name: "main".to_string(),
                    pr_number: None,
                },
                GitBranchOption {
                    name: "feat/codex-web-branch-picker".to_string(),
                    pr_number: Some(196),
                },
            ]
        );
    }

    #[test]
    fn build_visible_branch_options_uses_open_pr_base_when_origin_head_is_missing() {
        let pull_requests = parse_open_pull_requests(
            r#"[{"number":168,"headRefName":"docs/repo-refactor-blueprint","baseRefName":"main"},{"number":150,"headRefName":"chore/web-codex-terminal-communication","baseRefName":"main"}]"#,
        )
        .expect("pull request payload");

        let visible = build_visible_branch_options("", None, &pull_requests);

        assert_eq!(
            visible,
            vec![
                GitBranchOption {
                    name: "main".to_string(),
                    pr_number: None,
                },
                GitBranchOption {
                    name: "chore/web-codex-terminal-communication".to_string(),
                    pr_number: Some(150),
                },
                GitBranchOption {
                    name: "docs/repo-refactor-blueprint".to_string(),
                    pr_number: Some(168),
                },
            ]
        );
    }

    #[test]
    fn build_visible_branch_options_deduplicates_current_and_default_branch() {
        let visible = build_visible_branch_options("main", Some("main"), &[]);

        assert_eq!(
            visible,
            vec![GitBranchOption {
                name: "main".to_string(),
                pr_number: None,
            }]
        );
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
}
