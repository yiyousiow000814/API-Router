use parking_lot::{Condvar, Mutex};
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
    ready: Condvar,
}

impl<T> DashboardSnapshotCache<T> {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(DashboardSnapshotState::default()),
            ready: Condvar::new(),
        }
    }
}

impl<T: Clone + Send + Sync + 'static> DashboardSnapshotCache<T> {
    pub(crate) fn snapshot_if_fresh(&self, ttl_ms: u64) -> Option<T> {
        let now = unix_ms();
        let guard = self.state.lock();
        let entry = guard.snapshot.as_ref()?;
        (now.saturating_sub(entry.captured_at_unix_ms) < ttl_ms).then(|| entry.snapshot.clone())
    }

    pub(crate) fn read_or_refresh(
        self: &Arc<Self>,
        ttl_ms: u64,
        compute: Arc<dyn Fn() -> T + Send + Sync + 'static>,
    ) -> T {
        loop {
            let now = unix_ms();
            let mut guard = self.state.lock();
            if let Some(entry) = guard.snapshot.as_ref() {
                if now.saturating_sub(entry.captured_at_unix_ms) < ttl_ms {
                    return entry.snapshot.clone();
                }
                let snapshot = entry.snapshot.clone();
                if !guard.refreshing {
                    guard.refreshing = true;
                    drop(guard);
                    self.spawn_refresh(compute);
                }
                return snapshot;
            }
            if guard.refreshing {
                self.ready.wait(&mut guard);
                continue;
            }
            guard.refreshing = true;
            drop(guard);
            return self.compute_cold_snapshot(compute);
        }
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
                    // Dashboards should keep serving the last snapshot instead of surfacing
                    // refresh task failures; the next poll will attempt another refresh.
                    cache.finish_refresh();
                    log::warn!("dashboard snapshot background refresh failed: {err}");
                }
            }
        });
    }

    fn compute_cold_snapshot(&self, compute: Arc<dyn Fn() -> T + Send + Sync + 'static>) -> T {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compute())) {
            Ok(snapshot) => {
                self.store_snapshot(snapshot.clone());
                snapshot
            }
            Err(panic_payload) => {
                self.finish_refresh();
                std::panic::resume_unwind(panic_payload);
            }
        }
    }

    fn store_snapshot(&self, snapshot: T) {
        let mut guard = self.state.lock();
        guard.snapshot = Some(DashboardSnapshotEntry {
            captured_at_unix_ms: unix_ms(),
            snapshot,
        });
        guard.refreshing = false;
        drop(guard);
        self.ready.notify_all();
    }

    fn finish_refresh(&self) {
        let mut guard = self.state.lock();
        guard.refreshing = false;
        drop(guard);
        self.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::DashboardSnapshotCache;
    use crate::orchestrator::store::unix_ms;
    use parking_lot::{Condvar, Mutex};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

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

    #[test]
    fn cold_cache_waits_for_inflight_refresh_instead_of_recomputing() {
        let cache = Arc::new(DashboardSnapshotCache::<u32>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let compute = {
            let calls = Arc::clone(&calls);
            let release = Arc::clone(&release);
            let started_tx = started_tx.clone();
            Arc::new(move || {
                let call_index = calls.fetch_add(1, Ordering::SeqCst) + 1;
                if call_index == 1 {
                    started_tx.send(()).expect("signal first cold compute");
                }
                let (lock, ready) = &*release;
                let mut released = lock.lock();
                while !*released {
                    ready.wait(&mut released);
                }
                55
            })
        };

        let cache_for_first = Arc::clone(&cache);
        let compute_for_first = Arc::clone(&compute);
        let first =
            std::thread::spawn(move || cache_for_first.read_or_refresh(5_000, compute_for_first));

        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first cold compute started");

        let cache_for_second = Arc::clone(&cache);
        let compute_for_second = Arc::clone(&compute);
        let second =
            std::thread::spawn(move || cache_for_second.read_or_refresh(5_000, compute_for_second));

        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cold cache should let only one caller compute while others wait for the snapshot",
        );

        let (lock, ready) = &*release;
        *lock.lock() = true;
        ready.notify_all();

        assert_eq!(first.join().expect("first result"), 55);
        assert_eq!(second.join().expect("second result"), 55);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
