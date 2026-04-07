//! Windows-only helpers to map a loopback TCP connection to the owning PID and to read env vars
//! from that process.
//!
//! This is a low-level building block used for features like Windows Terminal WT_SESSION detection.

use std::net::SocketAddr;

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn infer_loopback_peer_pid(_peer: SocketAddr, _server_port: u16) -> Option<u32> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn is_pid_alive(_pid: u32) -> bool {
    false
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn read_process_env_var(_pid: u32, _key: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn read_process_command_line(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn read_process_cwd(_pid: u32) -> Option<std::path::PathBuf> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn duplicate_process_stdin_write_handle(_pid: u32) -> Option<isize> {
    None
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn list_process_ids_by_name(_names: &[&str]) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn visible_window_title(_pid: u32) -> Option<String> {
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleWindowSnapshot {
    pub hwnd: isize,
    pub pid: u32,
    pub title: String,
    pub class_name: String,
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn list_visible_windows() -> Vec<VisibleWindowSnapshot> {
    Vec::new()
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::ffi::OsString;
    use std::mem::{size_of, MaybeUninit};
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, BOOL, DUPLICATE_SAME_ACCESS, HANDLE, HWND,
        INVALID_HANDLE_VALUE, LPARAM,
    };
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetExitCodeProcess, OpenProcess, PROCESS_DUP_HANDLE,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct Peb {
        _reserved1: [u8; 0x20],
        process_parameters: usize,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct UnicodeString {
        length: u16,         // bytes (not including NUL)
        maximum_length: u16, // bytes
        buffer: usize,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CurDir {
        dos_path: UnicodeString,
        handle: usize,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct RtlUserProcessParameters {
        maximum_length: u32,
        length: u32,
        flags: u32,
        debug_flags: u32,
        console_handle: usize,
        console_flags: u32,
        _pad0: u32,
        standard_input: usize,
        standard_output: usize,
        standard_error: usize,
        current_directory: CurDir,
        dll_path: UnicodeString,
        image_path_name: UnicodeString,
        command_line: UnicodeString,
        environment: usize,
    }

    // NtQueryInformationProcess is not officially documented in the Win32 API, but it is stable and widely used.
    // We only use it to locate the PEB so we can read the child's environment block.
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            process_handle: HANDLE,
            process_information_class: u32,
            process_information: *mut core::ffi::c_void,
            process_information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    pub fn infer_loopback_peer_pid(peer: SocketAddr, server_port: u16) -> Option<u32> {
        if !peer.ip().is_loopback() {
            return None;
        }
        match peer {
            SocketAddr::V4(v4) => tcp_owner_pid_v4(v4.port(), server_port),
            SocketAddr::V6(v6) => tcp_owner_pid_v6(v6.port(), server_port),
        }
    }

    pub fn is_pid_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h == 0 {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code as *mut u32);
            let _ = CloseHandle(h);
            ok != 0 && code == 259 // STILL_ACTIVE
        }
    }

    pub fn read_process_env_var(pid: u32, key: &str) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h == 0 {
                return None;
            }
            let out = read_process_env_var_handle(h, key);
            let _ = CloseHandle(h);
            out
        }
    }

    pub fn read_process_command_line(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h == 0 {
                return None;
            }
            let out = read_process_command_line_handle(h);
            let _ = CloseHandle(h);
            out
        }
    }

    pub fn read_process_cwd(pid: u32) -> Option<std::path::PathBuf> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
            if h == 0 {
                return None;
            }
            let out = read_process_cwd_handle(h);
            let _ = CloseHandle(h);
            out
        }
    }

    pub fn duplicate_process_stdin_write_handle(pid: u32) -> Option<isize> {
        unsafe {
            let h = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | PROCESS_DUP_HANDLE,
                0,
                pid,
            );
            if h == 0 {
                return None;
            }
            let out = duplicate_process_stdin_write_handle_impl(h);
            let _ = CloseHandle(h);
            out
        }
    }

    pub fn list_process_ids_by_name(names: &[&str]) -> Vec<u32> {
        let wanted = names
            .iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect::<std::collections::HashSet<_>>();
        if wanted.is_empty() {
            return Vec::new();
        }
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return Vec::new();
            }
            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..std::mem::zeroed()
            };
            let mut out = Vec::new();
            if Process32FirstW(snapshot, &mut entry as *mut PROCESSENTRY32W) != 0 {
                loop {
                    let exe_name = widestr_to_string(&entry.szExeFile);
                    if wanted.contains(&exe_name.to_ascii_lowercase()) {
                        out.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry as *mut PROCESSENTRY32W) == 0 {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
            out
        }
    }

    pub fn visible_window_title(pid: u32) -> Option<String> {
        #[derive(Default)]
        struct VisibleWindowMatch {
            pid: u32,
            title: Option<String>,
        }

        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let state = &mut *(lparam as *mut VisibleWindowMatch);
            let mut owner_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut owner_pid as *mut u32);
            if owner_pid != state.pid || IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let title_len = GetWindowTextLengthW(hwnd);
            if title_len <= 0 {
                state.title = Some(String::new());
                return 0;
            }
            let mut buf = vec![0u16; title_len as usize + 1];
            let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if copied <= 0 {
                state.title = Some(String::new());
            } else {
                state.title = Some(String::from_utf16_lossy(&buf[..copied as usize]));
            }
            0
        }

        let mut state = VisibleWindowMatch { pid, title: None };
        unsafe {
            let _ = EnumWindows(Some(enum_windows_proc), &mut state as *mut _ as LPARAM);
        }
        state.title
    }

    pub fn list_visible_windows() -> Vec<VisibleWindowSnapshot> {
        unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let windows = &mut *(lparam as *mut Vec<VisibleWindowSnapshot>);
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let title = read_window_text(hwnd);
            let class_name = read_window_class_name(hwnd);
            if title.trim().is_empty() && class_name.trim().is_empty() {
                return 1;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid as *mut u32);
            windows.push(VisibleWindowSnapshot {
                hwnd,
                pid,
                title,
                class_name,
            });
            1
        }

        let mut windows = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(enum_windows_proc), &mut windows as *mut _ as LPARAM);
        }
        windows
    }

    fn tcp_owner_pid_v4(peer_port: u16, server_port: u16) -> Option<u32> {
        // Query size.
        let mut size: u32 = 0;
        unsafe {
            let _ = GetExtendedTcpTable(
                null_mut(),
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
        }
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = unsafe {
            GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut _,
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if ret != 0 {
            return None;
        }

        #[repr(C)]
        #[derive(Copy, Clone)]
        struct MibTcpRowOwnerPid {
            state: u32,
            local_addr: u32,
            local_port: u32,
            remote_addr: u32,
            remote_port: u32,
            owning_pid: u32,
        }

        #[repr(C)]
        struct MibTcpTableOwnerPid {
            num_entries: u32,
            table: [MibTcpRowOwnerPid; 1],
        }

        let table = buf.as_ptr() as *const MibTcpTableOwnerPid;
        let count = unsafe { (*table).num_entries } as usize;
        let first = unsafe { (*table).table.as_ptr() };

        for i in 0..count {
            let row = unsafe { *first.add(i) };
            // Ports are stored in network byte order in the low 16 bits.
            let lp = u16::from_be(row.local_port as u16);
            let rp = u16::from_be(row.remote_port as u16);
            // For incoming requests: client's ephemeral port is local_port, our server port is remote_port.
            if lp == peer_port && rp == server_port {
                return Some(row.owning_pid);
            }
        }
        None
    }

    fn tcp_owner_pid_v6(peer_port: u16, server_port: u16) -> Option<u32> {
        // Query size.
        let mut size: u32 = 0;
        unsafe {
            let _ = GetExtendedTcpTable(
                null_mut(),
                &mut size,
                0,
                AF_INET6 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
        }
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let ret = unsafe {
            GetExtendedTcpTable(
                buf.as_mut_ptr() as *mut _,
                &mut size,
                0,
                AF_INET6 as u32,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if ret != 0 {
            return None;
        }

        #[repr(C)]
        #[derive(Copy, Clone)]
        struct MibTcp6RowOwnerPid {
            local_addr: [u8; 16],
            local_scope_id: u32,
            local_port: u32,
            remote_addr: [u8; 16],
            remote_scope_id: u32,
            remote_port: u32,
            state: u32,
            owning_pid: u32,
        }

        #[repr(C)]
        struct MibTcp6TableOwnerPid {
            num_entries: u32,
            table: [MibTcp6RowOwnerPid; 1],
        }

        let table = buf.as_ptr() as *const MibTcp6TableOwnerPid;
        let count = unsafe { (*table).num_entries } as usize;
        let first = unsafe { (*table).table.as_ptr() };

        for i in 0..count {
            let row = unsafe { *first.add(i) };
            let lp = u16::from_be(row.local_port as u16);
            let rp = u16::from_be(row.remote_port as u16);
            if lp == peer_port && rp == server_port {
                return Some(row.owning_pid);
            }
        }
        None
    }

    // PROCESS_BASIC_INFORMATION (class 0) includes the PEB base address.
    fn peb_base_address(h: HANDLE) -> Option<usize> {
        unsafe {
            #[repr(C)]
            struct ProcessBasicInformation {
                reserved1: *mut core::ffi::c_void,
                peb_base_address: *mut core::ffi::c_void,
                reserved2: [*mut core::ffi::c_void; 2],
                unique_process_id: usize,
                reserved3: *mut core::ffi::c_void,
            }

            let mut pbi = MaybeUninit::<ProcessBasicInformation>::zeroed();
            let mut ret_len: u32 = 0;
            let status = NtQueryInformationProcess(
                h,
                0,
                pbi.as_mut_ptr() as *mut _,
                size_of::<ProcessBasicInformation>() as u32,
                &mut ret_len,
            );
            if status != 0 {
                return None;
            }
            let pbi = pbi.assume_init();
            let peb_addr = pbi.peb_base_address as usize;
            if peb_addr == 0 {
                None
            } else {
                Some(peb_addr)
            }
        }
    }

    fn read_process_env_var_handle(h: HANDLE, key: &str) -> Option<String> {
        let peb_addr = peb_base_address(h)?;
        let peb: Peb = read_struct::<Peb>(h, peb_addr)?;
        if peb.process_parameters == 0 {
            return None;
        }

        let params: RtlUserProcessParameters =
            read_struct::<RtlUserProcessParameters>(h, peb.process_parameters)?;
        if params.environment == 0 {
            return None;
        }

        let env_u16 = read_utf16_env_block(h, params.environment)?;
        find_env_var(&env_u16, key)
    }

    fn read_process_command_line_handle(h: HANDLE) -> Option<String> {
        let peb_addr = peb_base_address(h)?;

        let peb: Peb = read_struct::<Peb>(h, peb_addr)?;
        if peb.process_parameters == 0 {
            return None;
        }

        let params: RtlUserProcessParameters =
            read_struct::<RtlUserProcessParameters>(h, peb.process_parameters)?;
        read_unicode_string(h, params.command_line)
    }

    fn read_process_cwd_handle(h: HANDLE) -> Option<std::path::PathBuf> {
        let peb_addr = peb_base_address(h)?;

        let peb: Peb = read_struct::<Peb>(h, peb_addr)?;
        if peb.process_parameters == 0 {
            return None;
        }

        let params: RtlUserProcessParameters =
            read_struct::<RtlUserProcessParameters>(h, peb.process_parameters)?;
        let s = read_unicode_string(h, params.current_directory.dos_path)?;
        let s = s.trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(std::path::PathBuf::from(s))
        }
    }

    fn read_struct<T: Copy>(h: HANDLE, addr: usize) -> Option<T> {
        unsafe {
            let mut out = MaybeUninit::<T>::uninit();
            let mut read: usize = 0;
            let ok = ReadProcessMemory(
                h,
                addr as *const _,
                out.as_mut_ptr() as *mut _,
                size_of::<T>(),
                &mut read as *mut usize,
            );
            if ok == 0 || read != size_of::<T>() {
                return None;
            }
            Some(out.assume_init())
        }
    }

    fn read_utf16_env_block(h: HANDLE, addr: usize) -> Option<Vec<u16>> {
        // Read up to 256KB and stop at double-null.
        const MAX_U16: usize = 131_072; // 256KB
        const CHUNK_U16: usize = 8192; // 16KB

        let mut out: Vec<u16> = Vec::new();
        let mut offset_u16: usize = 0;
        while out.len() < MAX_U16 {
            let mut chunk = vec![0u16; CHUNK_U16];
            let bytes = CHUNK_U16 * 2;
            let mut read: usize = 0;
            let ok = unsafe {
                ReadProcessMemory(
                    h,
                    (addr + offset_u16 * 2) as *const _,
                    chunk.as_mut_ptr() as *mut _,
                    bytes,
                    &mut read as *mut usize,
                )
            };
            if ok == 0 || read == 0 {
                return None;
            }
            let got_u16 = read / 2;
            chunk.truncate(got_u16);
            out.extend_from_slice(&chunk);

            if out.windows(2).any(|w| w == [0, 0]) {
                if let Some(pos) = out.windows(2).position(|w| w == [0, 0]) {
                    out.truncate(pos + 2);
                }
                return Some(out);
            }

            offset_u16 += got_u16;
        }
        Some(out)
    }

    fn read_unicode_string(h: HANDLE, s: UnicodeString) -> Option<String> {
        if s.buffer == 0 || s.length == 0 {
            return None;
        }
        let bytes = s.length as usize;
        if bytes % 2 != 0 {
            return None;
        }
        let len_u16 = bytes / 2;
        let mut buf = vec![0u16; len_u16];
        let mut read: usize = 0;
        let ok = unsafe {
            ReadProcessMemory(
                h,
                s.buffer as *const _,
                buf.as_mut_ptr() as *mut _,
                bytes,
                &mut read as *mut usize,
            )
        };
        if ok == 0 || read != bytes {
            return None;
        }
        Some(OsString::from_wide(&buf).to_string_lossy().to_string())
    }

    fn find_env_var(env: &[u16], key: &str) -> Option<String> {
        let mut start = 0usize;
        while start < env.len() {
            let mut end = start;
            while end < env.len() && env[end] != 0 {
                end += 1;
            }
            if end == start {
                break;
            }
            let line = OsString::from_wide(&env[start..end])
                .to_string_lossy()
                .to_string();
            if let Some((k, v)) = line.split_once('=') {
                if k == key {
                    return Some(v.to_string());
                }
            }
            start = end + 1;
        }
        None
    }

    fn duplicate_process_stdin_write_handle_impl(h: HANDLE) -> Option<isize> {
        let peb_addr = peb_base_address(h)?;
        let peb: Peb = read_struct::<Peb>(h, peb_addr)?;
        let params: RtlUserProcessParameters =
            read_struct::<RtlUserProcessParameters>(h, peb.process_parameters)?;
        if params.standard_input == 0 {
            return None;
        }
        let mut duplicated: HANDLE = 0;
        let ok = unsafe {
            DuplicateHandle(
                h,
                params.standard_input as HANDLE,
                GetCurrentProcess(),
                &mut duplicated as *mut HANDLE,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 || duplicated == 0 {
            return None;
        }
        Some(duplicated)
    }

    fn widestr_to_string(value: &[u16]) -> String {
        let end = value
            .iter()
            .position(|wide| *wide == 0)
            .unwrap_or(value.len());
        OsString::from_wide(&value[..end])
            .to_string_lossy()
            .to_string()
    }

    fn read_window_text(hwnd: HWND) -> String {
        let title_len = unsafe { GetWindowTextLengthW(hwnd) };
        if title_len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; title_len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if copied <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..copied as usize])
        }
    }

    fn read_window_class_name(hwnd: HWND) -> String {
        let mut buf = vec![0u16; 256];
        let copied = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        if copied <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..copied as usize])
        }
    }
}

#[cfg(windows)]
pub use windows_impl::{
    duplicate_process_stdin_write_handle, infer_loopback_peer_pid, is_pid_alive,
    list_process_ids_by_name, list_visible_windows, read_process_command_line, read_process_cwd,
    read_process_env_var, visible_window_title,
};

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn can_read_child_process_env_var() {
        // Regression test: session pre-discovery relies on cross-process env reads.
        // Spawn a short-lived child with a known var and verify we can read it by PID.
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/C", "ping", "127.0.0.1", "-n", "3", ">", "NUL"]);
        cmd.env("CODEX_ENV_TEST", "hello");
        let mut child = cmd.spawn().expect("spawn cmd");
        let pid = child.id();
        let got = read_process_env_var(pid, "CODEX_ENV_TEST");
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(got.as_deref(), Some("hello"));
    }

    #[test]
    fn can_read_child_process_command_line() {
        // Ensure our PEB reading logic can fetch the command line of another process.
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/C", "ping", "127.0.0.1", "-n", "3", ">", "NUL"]);
        let mut child = cmd.spawn().expect("spawn cmd");
        let pid = child.id();
        let got = read_process_command_line(pid).unwrap_or_default();
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            got.to_ascii_lowercase().contains("cmd.exe"),
            "command line missing cmd.exe: {got}"
        );
    }
}
