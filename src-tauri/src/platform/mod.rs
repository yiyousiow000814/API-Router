//! Platform-specific helpers.
//!
//! Keep OS-specific code out of the orchestrator logic so it can remain portable.

#[path = "../../build_support/git_exec.rs"]
pub mod git_exec;
pub mod local_network;
pub mod windows_firewall;
pub mod windows_loopback_peer;
pub mod windows_terminal;
pub mod wsl_availability;
pub mod wsl_gateway_host;
