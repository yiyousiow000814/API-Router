use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

pub const LOCAL_NETWORK_EVENT: &str = "local-network-connectivity-changed";

#[derive(Clone, Default)]
pub struct LocalNetworkState {
    online: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LocalNetworkConnectivityPayload {
    pub online: bool,
}

impl LocalNetworkState {
    pub fn new() -> Self {
        Self {
            online: Arc::new(AtomicBool::new(detect_online())),
        }
    }

    pub fn replace_if_changed(&self, next: bool) -> bool {
        let previous = self.online.swap(next, Ordering::Relaxed);
        previous != next
    }

    pub fn refresh_from_system(&self) -> bool {
        let next = detect_online();
        self.online.store(next, Ordering::Relaxed);
        next
    }
}

pub fn spawn_monitor(app: &tauri::AppHandle, state: LocalNetworkState) {
    spawn_monitor_impl(app, state);
}

#[cfg(target_os = "windows")]
fn spawn_monitor_impl(app: &tauri::AppHandle, state: LocalNetworkState) {
    use tauri::Emitter;

    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        if !wait_for_connectivity_change() {
            std::thread::sleep(std::time::Duration::from_secs(1));
            continue;
        }
        let next_online = detect_online();
        if !state.replace_if_changed(next_online) {
            continue;
        }
        let _ = app_handle.emit(
            LOCAL_NETWORK_EVENT,
            LocalNetworkConnectivityPayload {
                online: next_online,
            },
        );
    });
}

#[cfg(not(target_os = "windows"))]
fn spawn_monitor_impl(_app: &tauri::AppHandle, _state: LocalNetworkState) {}

#[cfg(target_os = "windows")]
fn detect_online() -> bool {
    windows::detect_online()
}

#[cfg(not(target_os = "windows"))]
fn detect_online() -> bool {
    true
}

#[cfg(target_os = "windows")]
fn wait_for_connectivity_change() -> bool {
    windows::wait_for_connectivity_change()
}

#[cfg(not(target_os = "windows"))]
fn wait_for_connectivity_change() -> bool {
    false
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ptr::{null, null_mut};

    use windows::Win32::Networking::NetworkListManager::{INetworkListManager, NetworkListManager};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows_sys::Win32::Foundation::{HANDLE, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::NotifyAddrChange;

    pub(super) fn wait_for_connectivity_change() -> bool {
        // Null handle + null OVERLAPPED gives us a blocking wait without polling.
        unsafe { NotifyAddrChange(null_mut::<HANDLE>(), null()) == NO_ERROR }
    }

    pub(super) fn detect_online() -> bool {
        unsafe { detect_online_inner() }
    }

    unsafe fn detect_online_inner() -> bool {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let connectivity =
            CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL)
                .and_then(|manager: INetworkListManager| manager.IsConnectedToInternet())
                .map(|connected| connected.0 != 0)
                .unwrap_or(true);
        if initialized {
            CoUninitialize();
        }
        connectivity
    }
}

#[cfg(test)]
mod tests {
    use super::LocalNetworkState;

    #[test]
    fn replace_if_changed_reports_only_real_transitions() {
        let state = LocalNetworkState::default();
        assert!(!state.replace_if_changed(false));
        assert!(state.replace_if_changed(true));
        assert!(!state.replace_if_changed(true));
    }
}
