fn normalize_session_path_like(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    if normalized.len() > 1 {
        normalized = normalized.trim_end_matches('/').to_string();
    }
    Some(normalized.to_ascii_lowercase())
}

pub(super) fn is_imported_session_path(raw: &str) -> bool {
    let Some(path) = normalize_session_path_like(raw) else {
        return false;
    };
    path.contains("/.codex/sessions/imported/") && path.ends_with(".jsonl")
}

pub(super) fn is_live_session_rollout_path(raw: &str) -> bool {
    let Some(path) = normalize_session_path_like(raw) else {
        return false;
    };
    path.contains("/.codex/sessions/")
        && path.contains("/rollout-")
        && !path.contains("/.codex/sessions/imported/")
        && path.ends_with(".jsonl")
}

pub(super) fn runtime_path_should_override_existing(
    existing_path: Option<&str>,
    runtime_path: Option<&str>,
) -> bool {
    let Some(runtime_path) = runtime_path else {
        return false;
    };
    !matches!(
        existing_path,
        Some(existing_path)
            if is_live_session_rollout_path(existing_path)
                && is_imported_session_path(runtime_path)
    )
}

pub(super) fn session_candidate_should_replace_existing(
    existing_path: Option<&str>,
    existing_updated_at: i64,
    candidate_path: Option<&str>,
    candidate_updated_at: i64,
) -> bool {
    match (existing_path, candidate_path) {
        (Some(existing_path), Some(candidate_path))
            if is_live_session_rollout_path(existing_path)
                && is_imported_session_path(candidate_path) =>
        {
            false
        }
        (Some(existing_path), Some(candidate_path))
            if is_imported_session_path(existing_path)
                && is_live_session_rollout_path(candidate_path) =>
        {
            true
        }
        _ => existing_updated_at < candidate_updated_at,
    }
}

pub(super) fn rollout_path_is_already_in_codex_home(
    codex_home: Option<&str>,
    rollout_path: &str,
) -> bool {
    let Some(home) = codex_home.and_then(normalize_session_path_like) else {
        return false;
    };
    let Some(path) = normalize_session_path_like(rollout_path) else {
        return false;
    };
    let sessions_root = format!("{home}/sessions/");
    let imported_root = format!("{home}/sessions/imported/");
    path.starts_with(&sessions_root) && !path.starts_with(&imported_root)
}

#[cfg(test)]
mod tests {
    use super::{
        is_imported_session_path, is_live_session_rollout_path,
        rollout_path_is_already_in_codex_home, runtime_path_should_override_existing,
        session_candidate_should_replace_existing,
    };

    #[test]
    fn imported_session_path_detection_matches_expected_shapes() {
        assert!(is_imported_session_path(
            "/home/yiyou/.codex/sessions/imported/thread-1.jsonl"
        ));
        assert!(is_imported_session_path(
            r"C:\Users\yiyou\.codex\sessions\imported\thread-1.jsonl"
        ));
        assert!(!is_imported_session_path(
            "/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"
        ));
    }

    #[test]
    fn runtime_path_should_not_override_live_rollout_with_imported_copy() {
        assert!(!runtime_path_should_override_existing(
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"),
            Some("/home/yiyou/.codex/sessions/imported/thread-1.jsonl"),
        ));
        assert!(runtime_path_should_override_existing(
            Some("/home/yiyou/.codex/sessions/imported/thread-1.jsonl"),
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"),
        ));
    }

    #[test]
    fn rollout_path_in_same_home_skips_import_only_for_live_session_files() {
        assert!(rollout_path_is_already_in_codex_home(
            Some("/home/yiyou/.codex"),
            "/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl",
        ));
        assert!(!rollout_path_is_already_in_codex_home(
            Some("/home/yiyou/.codex"),
            "/home/yiyou/.codex/sessions/imported/thread-1.jsonl",
        ));
        assert!(!rollout_path_is_already_in_codex_home(
            Some("/home/yiyou/.codex"),
            "/tmp/other-home/sessions/2026/03/20/rollout-thread-1.jsonl",
        ));
        assert!(is_live_session_rollout_path(
            "/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"
        ));
    }

    #[test]
    fn session_candidate_should_replace_existing_prefers_live_rollout_over_imported_copy() {
        assert!(session_candidate_should_replace_existing(
            Some("/home/yiyou/.codex/sessions/imported/thread-1.jsonl"),
            10,
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"),
            9,
        ));
        assert!(!session_candidate_should_replace_existing(
            Some("/home/yiyou/.codex/sessions/2026/03/20/rollout-thread-1.jsonl"),
            9,
            Some("/home/yiyou/.codex/sessions/imported/thread-1.jsonl"),
            10,
        ));
    }
}
