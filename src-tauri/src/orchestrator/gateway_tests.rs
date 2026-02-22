#[cfg(test)]
mod tests {
    include!("gateway_tests/common.rs");
    include!("gateway_tests/basic_and_routing.rs");
    include!("gateway_tests/closed_provider_e2e.rs");
    include!("gateway_tests/failure_last_error_e2e.rs");
    include!("gateway_tests/request_preserve.rs");
    include!("gateway_tests/retry_and_session.rs");
}
