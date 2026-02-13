pub fn open_store_dir(base: PathBuf) -> anyhow::Result<Store> {
    std::fs::create_dir_all(&base)?;
    let path = base.join("sled");
    std::fs::create_dir_all(&path)?;
    // Best-effort maintenance: remove unexpected keys and optionally compact to prevent unbounded growth.
    // Runs before opening the DB to avoid Windows file locking issues.
    //
    // IMPORTANT: sled may panic if the on-disk database is corrupted (e.g. user manually deletes blobs).
    // Do not let that crash the whole app. If maintenance/open panics or errors, move the broken store
    // out of the way and recreate a fresh one.
    fn open_or_recover(path: &Path) -> anyhow::Result<Store> {
        let attempt = std::panic::catch_unwind(|| {
            if let Err(e) = super::store::maintain_store_dir(path) {
                log::warn!("store maintenance skipped: {e}");
            }
            Store::open(path)
        });

        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => {
                log::warn!("store open failed, recreating DB: {e}");
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    return Err(e2);
                }
                reopen_after_recovery(path)
            }
            Err(_) => {
                log::warn!("store open panicked, recreating DB");
                let recovered = recover_store_dir(path);
                if let Err(e2) = recovered {
                    log::warn!("store recovery failed: {e2}");
                    return Err(e2);
                }
                reopen_after_recovery(path)
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

    fn reopen_after_recovery(path: &Path) -> anyhow::Result<Store> {
        // On Windows, file locks can make recovery partially fail in practice.
        // Be defensive and avoid crashing if sled panics again.
        let attempt = std::panic::catch_unwind(|| Store::open(path));
        match attempt {
            Ok(Ok(store)) => Ok(store),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(anyhow::anyhow!(
                "sled panicked when opening recovered store"
            )),
        }
    }

    open_or_recover(&path)
}

