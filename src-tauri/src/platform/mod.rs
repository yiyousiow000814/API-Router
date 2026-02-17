//! Platform-specific helpers.
//!
//! Keep OS-specific code out of the orchestrator logic so it can remain portable.

pub mod windows_loopback_peer;
pub mod windows_terminal;
pub mod wsl_gateway_host;
