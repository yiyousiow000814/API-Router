use std::net::SocketAddr;

#[cfg(not(windows))]
pub fn infer_wt_session(_peer: SocketAddr, _server_port: u16) -> Option<InferredWtSession> {
    None
}

#[cfg(windows)]
pub fn infer_wt_session(peer: SocketAddr, server_port: u16) -> Option<InferredWtSession> {
    windows_impl::infer_wt_session(peer, server_port)
}

#[derive(Clone, Debug)]
pub struct InferredWtSession {
    pub wt_session: String,
    pub pid: u32,
}

#[cfg(not(windows))]
pub fn is_pid_alive(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
pub fn is_pid_alive(pid: u32) -> bool {
    windows_impl::is_pid_alive(pid)
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use crate::orchestrator::store::unix_ms;
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::mem::{size_of, MaybeUninit};
    use std::os::windows::ffi::OsStringExt;
    use std::ptr::null_mut;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };

    // NtQueryInformationProcess is not officially documented in the Win32 API, but it is stable and widely used.
    // We only use it to locate the PEB so we can read the child's environment block and extract WT_SESSION.
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

    // Simple cache: PID -> WT_SESSION for a short TTL, to avoid scanning TCP tables/reading PEB per request.
    static PID_CACHE: OnceLock<Mutex<HashMap<u32, (String, u64)>>> = OnceLock::new();
    const PID_CACHE_TTL_MS: u64 = 10_000;

    pub fn infer_wt_session(peer: SocketAddr, server_port: u16) -> Option<InferredWtSession> {
        let now = unix_ms();

        // Only meaningful for loopback requests. External clients won't have WT_SESSION.
        if !peer.ip().is_loopback() {
            return None;
        }

        // Fast path: if we can map the connection to a PID and we recently resolved it, reuse.
        if let Some(pid) = tcp_owner_pid(peer, server_port) {
            if let Some(v) = cached_pid(pid, now) {
                return Some(InferredWtSession { wt_session: v, pid });
            }
            let v = read_process_env_var(pid, "WT_SESSION")?;
            remember_pid(pid, v.clone(), now);
            return Some(InferredWtSession { wt_session: v, pid });
        }
        None
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

    fn cached_pid(pid: u32, now: u64) -> Option<String> {
        let cache = PID_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let cache = cache.lock();
        let (v, at) = cache.get(&pid)?;
        if now.saturating_sub(*at) <= PID_CACHE_TTL_MS {
            Some(v.clone())
        } else {
            None
        }
    }

    fn remember_pid(pid: u32, v: String, now: u64) {
        let cache = PID_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache.lock();
        // Bound memory usage.
        if cache.len() > 512 {
            cache.retain(|_, (_, at)| now.saturating_sub(*at) <= PID_CACHE_TTL_MS);
        }
        cache.insert(pid, (v, now));
    }

    fn tcp_owner_pid(peer: SocketAddr, server_port: u16) -> Option<u32> {
        match peer {
            SocketAddr::V4(v4) => tcp_owner_pid_v4(v4.port(), server_port),
            SocketAddr::V6(v6) => tcp_owner_pid_v6(v6.port(), server_port),
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

        // Layout for TCP_TABLE_OWNER_PID_ALL (AF_INET).
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
            let lp = u16::from_be(row.local_port as u16);
            let rp = u16::from_be(row.remote_port as u16);
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

        // Layout for TCP_TABLE_OWNER_PID_ALL (AF_INET6).
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

    fn read_process_env_var(pid: u32, key: &str) -> Option<String> {
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

    fn read_process_env_var_handle(h: HANDLE, key: &str) -> Option<String> {
        unsafe {
            // PROCESS_BASIC_INFORMATION (class 0) includes the PEB base address.
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
                return None;
            }

            // Minimal PEB for reading ProcessParameters pointer (works for x64).
            #[repr(C)]
            #[derive(Copy, Clone)]
            struct Peb {
                _reserved1: [u8; 0x20],
                process_parameters: usize,
            }

            let peb: Peb = read_struct::<Peb>(h, peb_addr)?;
            if peb.process_parameters == 0 {
                return None;
            }

            #[repr(C)]
            #[derive(Copy, Clone)]
            struct UnicodeString {
                length: u16,
                maximum_length: u16,
                buffer: usize,
            }

            #[repr(C)]
            #[derive(Copy, Clone)]
            struct CurDir {
                dos_path: UnicodeString,
                handle: usize,
            }

            // Minimal RTL_USER_PROCESS_PARAMETERS up to Environment pointer.
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

            let params: RtlUserProcessParameters =
                read_struct::<RtlUserProcessParameters>(h, peb.process_parameters)?;
            if params.environment == 0 {
                return None;
            }

            let env_u16 = read_utf16_env_block(h, params.environment)?;
            find_env_var(&env_u16, key)
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
        // Read up to 256KB (UTF-16 units) and stop at double-null.
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
                // Trim after the first double-null.
                if let Some(pos) = out.windows(2).position(|w| w == [0, 0]) {
                    out.truncate(pos + 2);
                }
                return Some(out);
            }

            offset_u16 += got_u16;
        }
        Some(out)
    }

    fn find_env_var(env: &[u16], key: &str) -> Option<String> {
        let mut start = 0usize;
        while start < env.len() {
            // Find NUL terminator.
            let mut end = start;
            while end < env.len() && env[end] != 0 {
                end += 1;
            }
            if end == start {
                // Double NUL => end.
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
