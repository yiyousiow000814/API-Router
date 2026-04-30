#[cfg(windows)]
pub(crate) fn registered_wsl_distribution_exists() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(lxss) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Lxss") else {
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
pub(crate) fn registered_wsl_distribution_exists() -> bool {
    false
}
