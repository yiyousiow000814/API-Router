use parking_lot::Mutex;
use std::sync::Arc;

use crate::orchestrator::store::unix_ms;

#[derive(Clone)]
struct DashboardSnapshotEntry<T> {
    captured_at_unix_ms: u64,
    snapshot: T,
}

struct DashboardSnapshotState<T> {
    snapshot: Option<DashboardSnapshotEntry<T>>,
    refreshing: bool,
}

impl<T> Default for DashboardSnapshotState<T> {
    fn default() -> Self {
        Self {
            snapshot: None,
            refreshing: false,
        }
    }
}

pub(crate) struct DashboardSnapshotCache<T> {
    state: Mutex<DashboardSnapshotState<T>>,
}

impl<T> DashboardSnapshotCache<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(DashboardSnapshotState::default()),
        }
    }
}

impl<T: Clone + Send + Sync + 'static> DashboardSnapshotCache<T> {
    pub(crate) fn read_or_refresh(
        self: &Arc<Self>,
        ttl_ms: u64,
        compute: Arc<dyn Fn() -> T + Send + Sync + 'static>,
    ) -> T {
        let now = unix_ms();
        let mut should_refresh = false;
        let stale_snapshot = {
            let mut guard = self.state.lock();
            if let Some(entry) = guard.snapshot.as_ref() {
                if now.saturating_sub(entry.captured_at_unix_ms) < ttl_ms {
                    return entry.snapshot.clone();
                }
                let snapshot = entry.snapshot.clone();
                if !guard.refreshing {
                    guard.refreshing = true;
                    should_refresh = true;
                }
                Some(snapshot)
            } else {
                None
            }
        };

        if let Some(snapshot) = stale_snapshot {
            if should_refresh {
                self.spawn_refresh(compute);
            }
            return snapshot;
        }

        let snapshot = compute();
        self.store_snapshot(snapshot.clone());
        snapshot
    }

    pub(crate) fn refresh_now(
        self: &Arc<Self>,
        compute: Arc<dyn Fn() -> T + Send + Sync + 'static>,
    ) -> T {
        let snapshot = compute();
        self.store_snapshot(snapshot.clone());
        snapshot
    }

    fn spawn_refresh(self: &Arc<Self>, compute: Arc<dyn Fn() -> T + Send + Sync + 'static>) {
        let cache = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let result = tauri::async_runtime::spawn_blocking(move || compute()).await;
            match result {
                Ok(snapshot) => cache.store_snapshot(snapshot),
                Err(err) => {
                    cache.finish_refresh();
                    log::warn!("dashboard snapshot background refresh failed: {err}");
                }
            }
        });
    }

    fn store_snapshot(&self, snapshot: T) {
        let mut guard = self.state.lock();
        guard.snapshot = Some(DashboardSnapshotEntry {
            captured_at_unix_ms: unix_ms(),
            snapshot,
        });
        guard.refreshing = false;
    }

    fn finish_refresh(&self) {
        let mut guard = self.state.lock();
        guard.refreshing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::DashboardSnapshotCache;
    use crate::orchestrator::store::unix_ms;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[tokio::test(flavor = "current_thread")]
    async fn fresh_snapshot_returns_without_recomputing() {
        let cache = Arc::new(DashboardSnapshotCache::<u32>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let compute = {
            let calls = Arc::clone(&calls);
            Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                7
            })
        };

        let first = cache.read_or_refresh(5_000, compute.clone());
        let second = cache.read_or_refresh(5_000, compute.clone());

        assert_eq!(first, 7);
        assert_eq!(second, 7);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_snapshot_returns_immediately_and_refreshes_in_background() {
        let cache = Arc::new(DashboardSnapshotCache::<u32>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let compute = {
            let calls = Arc::clone(&calls);
            Arc::new(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                99
            })
        };

        cache.refresh_now(compute.clone());
        {
            let mut guard = cache.state.lock();
            let snapshot = guard.snapshot.take().map(|mut entry| {
                entry.captured_at_unix_ms = unix_ms().saturating_sub(10_000);
                entry
            });
            guard.snapshot = snapshot;
            guard.refreshing = false;
        }

        let stale = cache.read_or_refresh(5_000, compute.clone());
        assert_eq!(stale, 99);

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let cached = cache.read_or_refresh(5_000, compute.clone());
        assert_eq!(cached, 99);
    }
}
