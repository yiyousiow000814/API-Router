#[path = "../src/platform/git_layout.rs"]
mod git_layout;

#[test]
fn resolve_git_dir_keeps_normal_repo_git_dir() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo_root = tmp.path();
    std::fs::create_dir_all(repo_root.join(".git").join("refs")).unwrap();

    assert_eq!(
        git_layout::resolve_git_dir(repo_root),
        repo_root.join(".git")
    );
    assert_eq!(
        git_layout::git_watch_paths(repo_root),
        vec![
            repo_root.join(".git").join("HEAD"),
            repo_root.join(".git").join("refs"),
        ]
    );
}

#[test]
fn resolve_git_dir_follows_worktree_git_pointer_file() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let repo_root = tmp.path().join("repo");
    let worktree_git_dir = tmp
        .path()
        .join("main-git")
        .join("worktrees")
        .join("feature");
    std::fs::create_dir_all(&repo_root).unwrap();
    std::fs::create_dir_all(worktree_git_dir.join("refs")).unwrap();
    std::fs::write(
        repo_root.join(".git"),
        "gitdir: ../main-git/worktrees/feature\r\n",
    )
    .unwrap();

    assert_eq!(git_layout::resolve_git_dir(&repo_root), worktree_git_dir);
    assert_eq!(
        git_layout::git_watch_paths(&repo_root),
        vec![
            repo_root.join(".git"),
            worktree_git_dir.join("HEAD"),
            worktree_git_dir.join("refs"),
        ]
    );
}
