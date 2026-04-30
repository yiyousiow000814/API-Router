#[cfg_attr(not(test), allow(dead_code))]
pub fn open_store_dir(base: PathBuf) -> anyhow::Result<Store> {
    open_store_dir_with_trace(base, |_, _| {})
}

pub fn open_store_dir_with_trace<F>(base: PathBuf, mut trace: F) -> anyhow::Result<Store>
where
    F: FnMut(&str, Option<String>),
{
    trace(
        "store_base_dir_create_start",
        Some(format!("path={}", base.display())),
    );
    std::fs::create_dir_all(&base)?;
    trace("store_base_dir_create_ok", None);
    let path = base.join("sled");
    trace(
        "store_sled_dir_create_start",
        Some(format!("path={}", path.display())),
    );
    std::fs::create_dir_all(&path)?;
    trace("store_sled_dir_create_ok", None);
    // Best-effort maintenance: remove unexpected keys and optionally compact to prevent unbounded growth.
    // Runs before opening the DB to avoid Windows file locking issues.
    //
    // IMPORTANT: sled may panic if the on-disk database is corrupted (e.g. user manually deletes blobs).
    // Do not let that crash the whole app. If maintenance/open panics or errors, move the broken store
    // out of the way and recreate a fresh one.
    fn open_or_recover<F>(path: &Path, trace: &mut F) -> anyhow::Result<Store>
    where
        F: FnMut(&str, Option<String>),
    {
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            trace("store_maintenance_start", None);
            if let Err(e) = super::store::maintain_store_dir(path) {
                log::warn!("store maintenance skipped: {e}");
                trace(
                    "store_maintenance_skipped",
                    Some(format!("error={e}")),
                );
            } else {
                trace("store_maintenance_ok", None);
            }
            Store::open_with_trace(path, &mut *trace)
        }));

        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => {
                log::warn!("store open failed, recreating DB: {e}");
                trace(
                    "store_open_failed_recover_start",
                    Some(format!("error={e}")),
                );
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    trace(
                        "store_recovery_failed",
                        Some(format!("error={e2}")),
                    );
                    return Err(e2);
                }
                trace("store_recovery_ok", None);
                reopen_after_recovery(path, trace)
            }
            Err(_) => {
                log::warn!("store open panicked, recreating DB");
                trace("store_open_panicked_recover_start", None);
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    trace(
                        "store_recovery_failed",
                        Some(format!("error={e2}")),
                    );
                    return Err(e2);
                }
                trace("store_recovery_ok", None);
                reopen_after_recovery(path, trace)
            }
        }
    }

    fn recover_store_dir(path: &Path) -> anyhow::Result<()> {
        // Move aside (best-effort) so we don't lose evidence for debugging,
        // and so file locks don't cause partial deletes.
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let backup = parent.join(format!("sled.corrupt.{}", unix_ms()));
        if backup.exists() {
            let _ = std::fs::remove_dir_all(&backup);
        }
        if path.exists() {
            if let Err(e) = std::fs::rename(path, &backup) {
                // If rename fails (e.g. cross-device), fall back to delete.
                log::warn!(
                    "failed to move corrupted store to {}: {e}",
                    backup.display()
                );
                if let Err(e2) = std::fs::remove_dir_all(path) {
                    return Err(anyhow::anyhow!(
                        "failed to remove corrupted store dir: {e2}"
                    ));
                }
            }
        }
        std::fs::create_dir_all(path)?;
        Ok(())
    }

    fn reopen_after_recovery<F>(path: &Path, trace: &mut F) -> anyhow::Result<Store>
    where
        F: FnMut(&str, Option<String>),
    {
        // On Windows, file locks can make recovery partially fail in practice.
        // Be defensive and avoid crashing if sled panics again.
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Store::open_with_trace(path, trace)
        }));
        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(anyhow::anyhow!(
                "sled panicked when opening recovered store"
            )),
        }
    }

    open_or_recover(&path, &mut trace)
}

#[cfg(test)]
mod store_recovery_tests {
    use super::*;

    #[test]
    fn open_store_dir_trace_records_store_open_stages() {
        let tmp = tempfile::tempdir().expect("tmp");
        let mut stages = Vec::new();
        let store = open_store_dir_with_trace(tmp.path().join("data"), |stage, _| {
            stages.push(stage.to_string());
        })
        .expect("store");

        drop(store);
        assert!(stages.contains(&"store_base_dir_create_start".to_string()));
        assert!(stages.contains(&"store_sled_open_start".to_string()));
        assert!(stages.contains(&"store_events_sqlite_open_start".to_string()));
        assert!(stages.contains(&"store_events_schema_ddl_start".to_string()));
        assert!(stages.contains(&"store_usage_request_columns_start".to_string()));
        assert!(stages.contains(&"store_event_day_counts_rebuild_ok".to_string()));
        assert!(stages.contains(&"store_open_ok".to_string()));
    }
}
