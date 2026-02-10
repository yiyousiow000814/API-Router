pub fn unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn dir_size_bytes(path: &Path) -> u64 {
    fn walk(p: &Path, sum: &mut u64) {
        let Ok(rd) = std::fs::read_dir(p) else {
            return;
        };
        for entry in rd.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                walk(&entry.path(), sum);
            } else {
                *sum = sum.saturating_add(meta.len());
            }
        }
    }

    let mut sum = 0u64;
    walk(path, &mut sum);
    sum
}

fn is_allowed_key(key: &[u8]) -> bool {
    Store::allowed_key_prefixes()
        .iter()
        .any(|p| key.starts_with(p))
        || Store::allowed_exact_keys().contains(&key)
}

/// Best-effort maintenance to keep the on-disk DB bounded:
/// - remove unexpected keys (e.g. large cached payloads) from this store
/// - prune events to MAX_EVENTS
/// - if the directory is still huge, rebuild a compacted DB with only allowed keys
pub fn maintain_store_dir(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    // If there's no DB yet, nothing to do.
    if !path.join("db").exists() {
        return Ok(());
    }

    // 1) Remove unexpected keys + prune events.
    {
        let db = sled::open(path)?;

        let mut batch: Vec<sled::IVec> = Vec::with_capacity(2048);
        for res in db.iter() {
            let (k, _v) = res?;
            if !is_allowed_key(&k) {
                batch.push(k);
                if batch.len() >= 2048 {
                    for key in batch.drain(..) {
                        let _ = db.remove(key);
                    }
                }
            }
        }
        for key in batch.drain(..) {
            let _ = db.remove(key);
        }

        Store::prune_events_db(&db);
        Store::prune_usage_requests_db(&db);
        db.flush()?;
    } // drop DB handle (important for Windows rename)

    // 2) If still too large, rebuild in a new directory and swap.
    let size = dir_size_bytes(path);
    if size <= Store::MAX_DB_BYTES {
        return Ok(());
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_dir = parent.join("sled.compact.tmp");
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir)?;

    {
        let src = sled::open(path)?;
        let dst = sled::open(&tmp_dir)?;
        for res in src.iter() {
            let (k, v) = res?;
            if is_allowed_key(&k) {
                let _ = dst.insert(k, v);
            }
        }
        dst.flush()?;
        src.flush()?;
    }

    // Swap directories. If installing the compacted DB fails, attempt to restore from backup.
    let backup = parent.join(format!("sled.bak.{}", unix_ms()));
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&backup);
    }
    if let Err(e) = std::fs::rename(path, &backup) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e.into());
    }
    if let Err(e2) = std::fs::rename(&tmp_dir, path) {
        // Best-effort rollback: restore the original DB directory if possible.
        let rollback = std::fs::rename(&backup, path);
        let _ = std::fs::remove_dir_all(&tmp_dir);
        match rollback {
            Ok(_) => {
                return Err(anyhow::anyhow!(
                    "failed to install compacted store: {e2} (restored from backup)"
                ));
            }
            Err(e3) => {
                return Err(anyhow::anyhow!(
                    "failed to install compacted store: {e2}; rollback failed: {e3} (backup at {})",
                    backup.display()
                ));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&backup);

    Ok(())
}

