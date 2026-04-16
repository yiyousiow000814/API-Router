export function normalizeWorkspaceTarget(value) {
  return value === "wsl2" ? "wsl2" : "windows";
}

export function normalizeThreadCwdForMatch(value, workspace = "windows") {
  const target = normalizeWorkspaceTarget(workspace);
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.replace(/[\\/]+$/, "");
  if (!normalized) return target === "wsl2" ? "/" : "";
  if (target === "wsl2") {
    return normalized.startsWith("/") ? normalized : "";
  }
  return normalized.replace(/\\/g, "/").toLowerCase();
}

export function threadMatchesStartCwd(thread, startCwd = "", workspace = "windows") {
  const target = normalizeWorkspaceTarget(workspace);
  const selected = normalizeThreadCwdForMatch(startCwd, target);
  if (!selected) return true;
  const threadCwd = normalizeThreadCwdForMatch(
    thread?.cwd || thread?.project || thread?.directory || thread?.path || "",
    target
  );
  if (!threadCwd) return false;
  if (threadCwd === selected) return true;
  const separator = target === "wsl2" ? "/" : "/";
  return threadCwd.startsWith(`${selected}${separator}`);
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

export function readThreadItemId(thread) {
  return String(thread?.id || thread?.threadId || "").trim();
}

function preferIncomingValue(existing, incoming) {
  if (incoming == null) return existing;
  if (typeof incoming === "string") {
    return incoming.trim() ? incoming : existing;
  }
  if (Array.isArray(incoming)) {
    return incoming.length ? incoming.slice() : existing;
  }
  if (typeof incoming === "object") {
    return Object.keys(incoming).length ? incoming : existing;
  }
  return incoming;
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

export function mergeThreadItem(existing, incoming) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const next = incoming && typeof incoming === "object" ? { ...incoming } : {};
  const merged = { ...base, ...next };
  for (const key of [
    "workspace",
    "__workspaceQueryTarget",
    "path",
    "cwd",
    "preview",
    "title",
    "name",
    "source",
  ]) {
    merged[key] = preferIncomingValue(base[key], next[key]);
  }
  const baseUpdatedAt = threadSortTimestampMs(base);
  const nextUpdatedAt = threadSortTimestampMs(next);
  if (baseUpdatedAt > nextUpdatedAt && base.updatedAt != null) {
    merged.updatedAt = base.updatedAt;
  }
  if (base.createdAt != null && next.createdAt == null) {
    merged.createdAt = base.createdAt;
  }
  if (base.status && !next.status) {
    merged.status = base.status;
  }
  if (next.provisional === false) merged.provisional = false;
  else if (base.provisional === true && next.provisional == null) merged.provisional = true;
  return merged;
}

export function upsertThreadItem(items, incoming) {
  const id = readThreadItemId(incoming);
  if (!id) return Array.isArray(items) ? items.slice() : [];
  const sourceItems = Array.isArray(items) ? items.slice() : [];
  const index = sourceItems.findIndex((item) => readThreadItemId(item) === id);
  if (index >= 0) {
    sourceItems[index] = mergeThreadItem(sourceItems[index], incoming);
  } else {
    sourceItems.push(mergeThreadItem(null, incoming));
  }
  return sortThreadsByNewest(sourceItems);
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
      const isWorktree = item?.isWorktree === true ? "wt" : "repo";
      return `${id}:${ts}:${status}:${preview}:${isWorktree}`;
    })
    .join("|");
}

export function filterThreadsForWorkspace(items, options = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const hasDualWorkspaceTargets = !!options.hasDualWorkspaceTargets;
  const currentTarget = normalizeWorkspaceTarget(String(options.currentTarget || "").trim());
  const startCwd = String(options.startCwd || "").trim();
  return sourceItems.filter((thread) => {
    const target = detectThreadWorkspaceTarget(thread);
    if (hasDualWorkspaceTargets && target !== "unknown" && target !== currentTarget) return false;
    const matchTarget = target === "unknown" ? currentTarget : target;
    if (!startCwd) return true;
    if (target === "unknown") return true;
    if (hasDualWorkspaceTargets && target !== currentTarget) return false;
    if (!hasDualWorkspaceTargets && target !== "unknown" && target !== currentTarget) return false;
    return threadMatchesStartCwd(thread, startCwd, matchTarget);
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
