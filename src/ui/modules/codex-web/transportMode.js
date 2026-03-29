export function isTruthyFlag(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

export function resolveCodexWebTransportMode({ importMetaEnv = {}, windowRef } = {}) {
  const win = windowRef ?? (typeof window === "undefined" ? null : window);
  const params = new URLSearchParams(String(win?.location?.search || ""));
  if (isTruthyFlag(params.get("live"))) return "live";
  if (isTruthyFlag(params.get("mock"))) return "mock";
  const isDev = importMetaEnv?.DEV === true;
  const isTauri = !!win?.__TAURI__?.core?.invoke;
  return isDev && !isTauri ? "safe" : "live";
}
