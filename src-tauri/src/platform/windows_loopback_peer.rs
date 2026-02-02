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

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::ffi::OsString;
    use std::mem::{size_of, MaybeUninit};
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
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
}

#[cfg(windows)]
pub use windows_impl::{
    infer_loopback_peer_pid, is_pid_alive, read_process_command_line, read_process_cwd,
    read_process_env_var,
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
