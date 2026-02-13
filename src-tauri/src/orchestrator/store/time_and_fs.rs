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
