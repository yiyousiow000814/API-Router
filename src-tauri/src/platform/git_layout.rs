use std::path::Component;
use std::path::{Path, PathBuf};

fn parse_git_dir_pointer(text: &str) -> Option<PathBuf> {
    text.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("gitdir:")
            .map(|value| PathBuf::from(value.trim()))
    })
}

pub fn resolve_git_dir(repo_root: &Path) -> PathBuf {
    let git_entry = repo_root.join(".git");
    if git_entry.is_dir() {
        return git_entry;
    }

    let pointer = std::fs::read_to_string(&git_entry)
        .ok()
        .and_then(|text| parse_git_dir_pointer(&text));

    match pointer {
        Some(path) if path.is_absolute() => path,
        Some(path) => normalize_path(repo_root.join(path)),
        None => git_entry,
    }
}

fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub fn git_watch_paths(repo_root: &Path) -> Vec<PathBuf> {
    let git_entry = repo_root.join(".git");
    let git_dir = resolve_git_dir(repo_root);
    let mut paths = Vec::new();

    if git_entry != git_dir {
        paths.push(git_entry);
    }

    paths.push(git_dir.join("HEAD"));
    push_if_exists(&mut paths, git_dir.join("refs"));
    push_if_exists(&mut paths, git_dir.join("packed-refs"));
    paths
}

fn push_if_exists(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.exists() {
        paths.push(path);
    }
}
