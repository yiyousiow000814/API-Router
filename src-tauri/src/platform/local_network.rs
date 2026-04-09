use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use serde::Serialize;

#[cfg(target_os = "windows")]
pub const LOCAL_NETWORK_EVENT: &str = "local-network-connectivity-changed";

#[derive(Clone)]
pub struct LocalNetworkState {
    online: Arc<AtomicBool>,
    known: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LocalNetworkConnectivityPayload {
    pub online: bool,
}

#[derive(Clone, Debug)]
pub struct LocalNetworkSnapshot {
    pub online: Option<bool>,
    pub source: &'static str,
    pub last_error: Option<String>,
}

impl Default for LocalNetworkState {
    fn default() -> Self {
        Self {
            online: Arc::new(AtomicBool::new(false)),
            known: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
        }
    }
}

impl LocalNetworkState {
    pub fn new() -> Self {
        let state = Self::default();
        let _ = state.refresh_from_system();
        state
    }

    pub fn refresh_from_system(&self) -> LocalNetworkSnapshot {
        match detect_online() {
            Ok(next_online) => {
                self.online.store(next_online, Ordering::Relaxed);
                self.known.store(true, Ordering::Relaxed);
                self.set_last_error(None);
            }
            Err(err) => {
                self.set_last_error(Some(err));
            }
        }
        self.snapshot()
    }

    pub fn snapshot_for_status_poll(&self) -> LocalNetworkSnapshot {
        #[cfg(target_os = "windows")]
        {
            self.snapshot_or_refresh_if_unknown(|state| state.refresh_from_system())
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.refresh_from_system()
        }
    }

    pub fn snapshot(&self) -> LocalNetworkSnapshot {
        let online = if self.known.load(Ordering::Relaxed) {
            Some(self.online.load(Ordering::Relaxed))
        } else {
            None
        };
        LocalNetworkSnapshot {
            online,
            source: detect_source(),
            last_error: self.last_error.lock().ok().and_then(|guard| guard.clone()),
        }
    }

    #[cfg(target_os = "windows")]
    fn snapshot_or_refresh_if_unknown<F>(&self, refresh: F) -> LocalNetworkSnapshot
    where
        F: FnOnce(&Self) -> LocalNetworkSnapshot,
    {
        if self.known.load(Ordering::Relaxed) {
            self.snapshot()
        } else {
            refresh(self)
        }
    }

    #[cfg(target_os = "windows")]
    fn apply_detected_online(&self, next_online: bool) -> bool {
        let previous_known = self.known.swap(true, Ordering::Relaxed);
        let previous_online = self.online.swap(next_online, Ordering::Relaxed);
        self.set_last_error(None);
        !previous_known || previous_online != next_online
    }

    fn set_last_error(&self, next_error: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = next_error;
        }
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
        let Ok(next_online) = detect_online() else {
            let _ = state.refresh_from_system();
            continue;
        };
        if !state.apply_detected_online(next_online) {
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
fn detect_online() -> Result<bool, String> {
    windows::detect_online()
}

#[cfg(target_os = "linux")]
fn detect_online() -> Result<bool, String> {
    linux::detect_online()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn detect_online() -> Result<bool, String> {
    Err("local network detection is not implemented on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn wait_for_connectivity_change() -> bool {
    windows::wait_for_connectivity_change()
}

#[cfg(target_os = "windows")]
fn detect_source() -> &'static str {
    "windows_network_list_manager"
}

#[cfg(target_os = "linux")]
fn detect_source() -> &'static str {
    "linux_default_route"
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn detect_source() -> &'static str {
    "unsupported_platform"
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
        unsafe { NotifyAddrChange(null_mut::<HANDLE>(), null()) == NO_ERROR }
    }

    pub(super) fn detect_online() -> Result<bool, String> {
        unsafe { detect_online_inner() }
    }

    unsafe fn detect_online_inner() -> Result<bool, String> {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let result =
            CoCreateInstance::<_, INetworkListManager>(&NetworkListManager, None, CLSCTX_ALL)
                .and_then(|manager: INetworkListManager| manager.IsConnectedToInternet())
                .map(|connected| connected.0 != 0)
                .map_err(|err| format!("network list manager IsConnectedToInternet failed: {err}"));
        if initialized {
            CoUninitialize();
        }
        result
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::BTreeSet;

    pub(super) fn detect_online() -> Result<bool, String> {
        let route_text = std::fs::read_to_string("/proc/net/route")
            .map_err(|err| format!("read /proc/net/route failed: {err}"))?;
        let interfaces = parse_default_route_interfaces(&route_text)
            .map_err(|err| format!("parse /proc/net/route failed: {err}"))?;
        if interfaces.is_empty() {
            return Ok(false);
        }
        for iface in interfaces {
            if interface_is_up(&iface)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn interface_is_up(name: &str) -> Result<bool, String> {
        if name.trim().is_empty() || name == "lo" {
            return Ok(false);
        }
        let operstate_path = format!("/sys/class/net/{name}/operstate");
        let operstate = std::fs::read_to_string(&operstate_path)
            .map_err(|err| format!("read {operstate_path} failed: {err}"))?;
        let normalized = operstate.trim().to_ascii_lowercase();
        Ok(matches!(normalized.as_str(), "up" | "unknown"))
    }

    fn parse_default_route_interfaces(route_text: &str) -> Result<Vec<String>, String> {
        let mut interfaces = BTreeSet::new();
        for (index, line) in route_text.lines().enumerate() {
            if index == 0 || line.trim().is_empty() {
                continue;
            }
            let columns: Vec<&str> = line.split_whitespace().collect();
            if columns.len() < 4 {
                return Err(format!("line {} had fewer than 4 columns", index + 1));
            }
            let iface = columns[0].trim();
            let destination = columns[1].trim();
            let flags = u16::from_str_radix(columns[3].trim(), 16)
                .map_err(|err| format!("line {} had invalid flags: {err}", index + 1))?;
            let route_is_up = flags & 0x1 != 0;
            if destination == "00000000" && route_is_up && !iface.is_empty() {
                interfaces.insert(iface.to_string());
            }
        }
        Ok(interfaces.into_iter().collect())
    }

    #[cfg(test)]
    mod tests {
        use super::parse_default_route_interfaces;

        #[test]
        fn parse_default_route_interfaces_keeps_unique_up_defaults() {
            let route_text = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
eth0\t00000000\t01010101\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
tailscale0\t00000000\t00000000\t0001\t0\t0\t100\t00000000\t0\t0\t0\n\
eth0\t00000000\t02020202\t0003\t0\t0\t200\t00000000\t0\t0\t0\n";
            assert_eq!(
                parse_default_route_interfaces(route_text).expect("parse route text"),
                vec!["eth0".to_string(), "tailscale0".to_string()]
            );
        }

        #[test]
        fn parse_default_route_interfaces_ignores_non_default_and_down_routes() {
            let route_text = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
eth0\t00112233\t00000000\t0001\t0\t0\t100\t00000000\t0\t0\t0\n\
wlan0\t00000000\t00000000\t0000\t0\t0\t100\t00000000\t0\t0\t0\n";
            assert!(parse_default_route_interfaces(route_text)
                .expect("parse route text")
                .is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LocalNetworkSnapshot;
    use super::LocalNetworkState;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn snapshot_starts_unknown_until_first_success() {
        let state = LocalNetworkState::default();
        assert!(state.snapshot().online.is_none());
    }

    #[test]
    fn apply_detected_online_reports_only_real_transitions() {
        let state = LocalNetworkState::default();
        assert!(state.apply_detected_online(false));
        assert!(!state.apply_detected_online(false));
        assert!(state.apply_detected_online(true));
        assert!(!state.apply_detected_online(true));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn snapshot_or_refresh_if_unknown_refreshes_unknown_state() {
        let state = LocalNetworkState::default();
        let refresh_calls = AtomicUsize::new(0);

        let snapshot = state.snapshot_or_refresh_if_unknown(|state| {
            refresh_calls.fetch_add(1, Ordering::Relaxed);
            assert!(state.apply_detected_online(false));
            state.snapshot()
        });

        assert_eq!(refresh_calls.load(Ordering::Relaxed), 1);
        assert_eq!(snapshot.online, Some(false));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn snapshot_or_refresh_if_unknown_keeps_known_cached_state() {
        let state = LocalNetworkState::default();
        assert!(state.apply_detected_online(true));
        let refresh_calls = AtomicUsize::new(0);

        let snapshot = state.snapshot_or_refresh_if_unknown(|_| {
            refresh_calls.fetch_add(1, Ordering::Relaxed);
            LocalNetworkSnapshot {
                online: Some(false),
                source: "test_probe",
                last_error: Some("should not run".to_string()),
            }
        });

        assert_eq!(refresh_calls.load(Ordering::Relaxed), 0);
        assert_eq!(snapshot.online, Some(true));
    }
}
