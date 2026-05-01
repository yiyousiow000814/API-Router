#[cfg(test)]
fn registered_wsl_distribution_override() -> Option<bool> {
    std::env::var("API_ROUTER_TEST_REGISTERED_WSL_DISTRIBUTIONS")
        .ok()
        .map(|value| matches!(value.trim(), "1" | "true" | "yes"))
}

#[cfg(any(windows, test))]
pub(crate) fn registered_wsl_distribution_exists() -> bool {
    #[cfg(test)]
    if let Some(value) = registered_wsl_distribution_override() {
        return value;
    }

    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(lxss) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss")
        else {
            return false;
        };
        lxss.enum_keys().flatten().any(|key| {
            lxss.open_subkey(key)
                .ok()
                .and_then(|distro| distro.get_value::<String, _>("DistributionName").ok())
                .is_some_and(|name| !name.trim().is_empty())
        })
    }

    #[cfg(not(windows))]
    false
}
