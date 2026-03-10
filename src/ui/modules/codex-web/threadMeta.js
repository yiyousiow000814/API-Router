export function normalizeWorkspaceTarget(value) {
  return value === "wsl2" ? "wsl2" : "windows";
}

export function detectThreadWorkspaceTarget(thread) {
  const pathLikeRaw = String(
    thread?.cwd || thread?.project || thread?.directory || thread?.path || ""
  ).trim();
  const workspaceRaw = String(thread?.workspace || "").trim();
  const raw = pathLikeRaw || workspaceRaw;
  if (!raw) return "unknown";
  const text = raw.toLowerCase();
  if (
    text.startsWith("/") ||
    text.startsWith("\\\\wsl$\\") ||
    text.startsWith("\\\\wsl.localhost\\") ||
    text.includes("\\\\wsl$\\") ||
    text.includes("\\\\wsl.localhost\\") ||
    text.includes("/mnt/") ||
    text.includes(" wsl") ||
    text.includes("\\wsl$")
  ) {
    return "wsl2";
  }
  if (/^[a-z]:[\\/]/i.test(raw) || raw.includes(":\\") || raw.includes("\\\\")) {
    return "windows";
  }
  const queryWorkspaceRaw = String(thread?.__workspaceQueryTarget || "").trim().toLowerCase();
  if (queryWorkspaceRaw === "wsl2" || queryWorkspaceRaw === "wsl") return "wsl2";
  if (queryWorkspaceRaw === "windows" || queryWorkspaceRaw === "win") return "windows";
  if (workspaceRaw) {
    const workspaceText = workspaceRaw.toLowerCase();
    if (workspaceText === "wsl2" || workspaceText === "wsl") return "wsl2";
    if (workspaceText === "windows" || workspaceText === "win") return "windows";
  }
  return "unknown";
}

export function pickThreadTimestamp(thread) {
  return thread?.updatedAt ?? thread?.createdAt ?? thread?.statusUpdatedAt ?? "";
}

export function threadSortTimestampMs(thread) {
  const raw = pickThreadTimestamp(thread);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return 0;
    if (/^\d+(?:\.\d+)?$/.test(text)) {
      const num = Number.parseFloat(text);
      if (!Number.isFinite(num)) return 0;
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortThreadsByNewest(items) {
  return [...items].sort((a, b) => {
    const diff = threadSortTimestampMs(b) - threadSortTimestampMs(a);
    if (diff !== 0) return diff;
    const aId = String(a?.id || a?.threadId || "");
    const bId = String(b?.id || b?.threadId || "");
    return bId.localeCompare(aId);
  });
}

function ensureArrayItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return value ? [value] : [];
}

export function buildThreadRenderSig(items) {
  return sortThreadsByNewest(ensureArrayItems(items).slice())
    .map((item) => {
      const id = item?.id || item?.threadId || "";
      const ts = item?.updatedAt ?? item?.createdAt ?? "";
      const status = String(item?.status?.type || item?.status || item?.state || "").trim();
      const preview = String(item?.preview || item?.title || item?.name || "").trim();
      return `${id}:${ts}:${status}:${preview}`;
    })
    .join("|");
}

export function filterThreadsForWorkspace(items, options = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const hasDualWorkspaceTargets = !!options.hasDualWorkspaceTargets;
  const currentTarget = String(options.currentTarget || "").trim();
  if (!hasDualWorkspaceTargets) return sourceItems;
  return sourceItems.filter((thread) => {
    const target = detectThreadWorkspaceTarget(thread);
    if (target === "unknown") return true;
    return target === currentTarget;
  });
}

export function detectWorkspaceAvailabilityFromThreads(items, currentAvailability = {}) {
  let hasWindows = !!currentAvailability.windowsInstalled;
  let hasWsl2 = !!currentAvailability.wsl2Installed;
  for (const thread of Array.isArray(items) ? items : []) {
    const target = detectThreadWorkspaceTarget(thread);
    if (target === "windows") hasWindows = true;
    if (target === "wsl2") hasWsl2 = true;
    if (hasWindows && hasWsl2) break;
  }
  return {
    windowsInstalled: hasWindows,
    wsl2Installed: hasWsl2,
  };
}
