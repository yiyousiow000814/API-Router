//! Platform-specific helpers.
//!
//! Keep OS-specific code out of the orchestrator logic so it can remain portable.

pub mod codex_managed_terminal;
pub mod codex_terminal_session;
#[path = "../../build_support/git_exec.rs"]
pub mod git_exec;
pub mod git_layout;
pub mod local_network;
pub mod windows_firewall;
pub mod windows_loopback_peer;
pub mod windows_terminal;
pub mod wsl_availability;
pub mod wsl_gateway_host;
