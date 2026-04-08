pub(crate) fn is_ppchat_base(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .map(|host| host.ends_with("ppchat.vip"))
        .unwrap_or(false)
}

pub(crate) fn default_candidate_bases() -> [&'static str; 3] {
    [
        "https://his.ppchat.vip",
        "https://code.ppchat.vip",
        "https://code.pumpkinai.vip",
    ]
}
