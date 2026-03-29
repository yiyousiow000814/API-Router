import { normalizeLiveMethod } from "./liveNotifications.js";

function toRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function extractNotificationEventId(notification) {
  const record = toRecord(notification);
  const id = readNumber(record?.eventId) ?? readNumber(record?.event_id);
  if (id === null) return null;
  const normalized = Math.floor(id);
  return normalized > 0 ? normalized : null;
}

export function extractNotificationThreadId(notification) {
  const record = toRecord(notification);
  const params = toRecord(record?.params) || toRecord(record?.payload) || null;
  const msg = toRecord(params?.msg);
  const thread = toRecord(params?.thread) || toRecord(params?.threadState) || toRecord(params?.thread_state);
  const turn = toRecord(params?.turn) || toRecord(params?.turnState) || toRecord(params?.turn_state);
  const item = toRecord(params?.item) || toRecord(params?.itemState) || toRecord(params?.item_state);
  const source = toRecord(params?.source) || toRecord(msg?.source);
  const subagent = toRecord(toRecord(source?.subagent)?.thread_spawn);
  const keys = new Set([
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
    "session_id",
    "sessionId",
    "parent_thread_id",
    "parentThreadId",
    "parent_session_id",
    "parentSessionId",
  ]);
  const seen = new Set();
  const deepFindThreadId = (root, depth = 0) => {
    if (!root || depth > 6 || typeof root !== "object" || seen.has(root)) return null;
    seen.add(root);
    if (Array.isArray(root)) {
      for (let index = 0; index < Math.min(root.length, 40); index += 1) {
        const found = deepFindThreadId(root[index], depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const key of Object.keys(root)) {
      if (keys.has(key)) {
        const found = readString(root[key]);
        if (found) return found;
      }
    }
    for (const key of Object.keys(root)) {
      const found = deepFindThreadId(root[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return (
    readString(msg?.thread_id) ||
    readString(msg?.threadId) ||
    readString(msg?.conversation_id) ||
    readString(msg?.conversationId) ||
    readString(msg?.session_id) ||
    readString(msg?.sessionId) ||
    readString(params?.thread_id) ||
    readString(params?.threadId) ||
    readString(params?.conversation_id) ||
    readString(params?.conversationId) ||
    readString(params?.session_id) ||
    readString(params?.sessionId) ||
    readString(thread?.id) ||
    readString(thread?.thread_id) ||
    readString(thread?.threadId) ||
    readString(thread?.conversation_id) ||
    readString(thread?.conversationId) ||
    readString(thread?.session_id) ||
    readString(thread?.sessionId) ||
    readString(turn?.thread_id) ||
    readString(turn?.threadId) ||
    readString(turn?.conversation_id) ||
    readString(turn?.conversationId) ||
    readString(turn?.session_id) ||
    readString(turn?.sessionId) ||
    readString(item?.thread_id) ||
    readString(item?.threadId) ||
    readString(item?.conversation_id) ||
    readString(item?.conversationId) ||
    readString(item?.session_id) ||
    readString(item?.sessionId) ||
    readString(source?.thread_id) ||
    readString(source?.threadId) ||
    readString(source?.conversation_id) ||
    readString(source?.conversationId) ||
    readString(source?.session_id) ||
    readString(source?.sessionId) ||
    readString(source?.parent_thread_id) ||
    readString(source?.parentThreadId) ||
    readString(source?.parent_session_id) ||
    readString(source?.parentSessionId) ||
    readString(subagent?.parent_thread_id) ||
    readString(subagent?.parentThreadId) ||
    readString(subagent?.parent_session_id) ||
    readString(subagent?.parentSessionId) ||
    deepFindThreadId(params) ||
    null
  );
}

export function shouldRefreshThreadsFromNotification(method) {
  const normalized = normalizeLiveMethod(method);
  return (
    normalized.startsWith("thread/") ||
    normalized.startsWith("turn/") ||
    normalized.startsWith("item/") ||
    normalized.startsWith("codex/event/")
  );
}

export function shouldRefreshActiveThreadFromNotification(method) {
  const normalized = normalizeLiveMethod(method);
  if (!normalized) return false;
  if (
    normalized === "thread/name/updated" ||
    normalized === "thread/status" ||
    normalized === "thread/status/changed"
  ) return true;
  if (
    normalized === "turn/started" ||
    normalized === "turn/completed" ||
    normalized === "turn/finished" ||
    normalized === "turn/failed" ||
    normalized === "turn/cancelled" ||
    normalized === "item/started" ||
    normalized === "item/completed"
  ) {
    return true;
  }
  return (
    normalized === "codex/event/response_item" ||
    normalized === "codex/event/agent_message" ||
    normalized === "codex/event/task_complete" ||
    normalized === "codex/event/turn_complete" ||
    normalized === "codex/event/task_failed" ||
    normalized === "codex/event/turn_failed" ||
    normalized === "codex/event/task_aborted" ||
    normalized === "codex/event/turn_aborted"
  );
}

function extractNotificationParams(notification) {
  const record = toRecord(notification);
  return toRecord(record?.params) || toRecord(record?.payload) || null;
}

function readNotificationStatus(notification) {
  const record = toRecord(notification);
  const method = normalizeLiveMethod(readString(record?.method) || "");
  const params = extractNotificationParams(notification);
  const thread = toRecord(params?.thread);
  const status =
    readString(params?.status) ||
    readString(thread?.status?.type) ||
    readString(thread?.status) ||
    "";
  if (status) return status;
  if (method.includes("turn/started")) return "running";
  if (method.includes("turn/completed") || method.includes("turn/finished")) return "completed";
  if (method.includes("turn/failed")) return "failed";
  if (method.includes("turn/cancelled")) return "interrupted";
  return "";
}

function readNotificationRolloutPath(notification) {
  const params = extractNotificationParams(notification);
  const thread = toRecord(params?.thread);
  const item = toRecord(params?.item) || toRecord(params?.payload);
  return (
    readString(params?.rolloutPath) ||
    readString(params?.rollout_path) ||
    readString(params?.path) ||
    readString(thread?.rolloutPath) ||
    readString(thread?.rollout_path) ||
    readString(thread?.path) ||
    readString(item?.rolloutPath) ||
    readString(item?.rollout_path) ||
    readString(item?.path) ||
    ""
  );
}

function readNotificationWorkspace(notification, fallbackWorkspace = "windows") {
  const params = extractNotificationParams(notification);
  const thread = toRecord(params?.thread);
  const payload = toRecord(params?.payload);
  const raw =
    readString(params?.workspace) ||
    readString(thread?.workspace) ||
    readString(payload?.workspace) ||
    String(fallbackWorkspace || "").trim();
  return raw.toLowerCase() === "wsl2" ? "wsl2" : "windows";
}

function extractNotificationTextPreview(value) {
  const record = toRecord(value);
  if (!record) return "";
  const direct =
    readString(record?.message) || readString(record?.text) || readString(record?.delta) || "";
  if (direct) return direct.replace(/\s+/g, " ").trim();
  const content = Array.isArray(record?.content) ? record.content : [];
  for (const part of content) {
    const text = readString(part?.text);
    if (text) return text.replace(/\s+/g, " ").trim();
  }
  return "";
}

function isFilteredTestThreadCwd(raw) {
  const text = String(raw || "").trim().replace(/\//g, "\\").toLowerCase();
  return (
    text.includes("\\.tmp-codex-web") ||
    text.endsWith("\\usersyiyouapi-router") ||
    text.endsWith("\\home\\yiyou\\.tmp-codex-web-live-sync-debug")
  );
}

function isAuxiliaryThreadPreviewText(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return (
    text.startsWith("# agents.md instructions") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("review the code changes against the base branch") ||
    text.includes("<environment_context>") ||
    text.includes("<turn_context>") ||
    text.includes("another language model started to solve this problem") ||
    text.includes("<user_action>") ||
    text.includes("<turn_aborted>") ||
    text === "say ok only" ||
    text === "say ok only." ||
    text.startsWith("reply with ok only.") ||
    text.startsWith("reply with ok only [") ||
    text.startsWith("reply with ok only. [") ||
    text.startsWith("reply with exactly") ||
    (text.startsWith("reply with ") &&
      (text.includes(" only") || text.includes("nothing else"))) ||
    text.startsWith("use the shell to ") ||
    text.startsWith("sync smoke test") ||
    text.startsWith("embedfix_") ||
    text.startsWith("livefix_") ||
    text.startsWith("histchk_") ||
    text.startsWith("live_real_") ||
    text.startsWith("livee2e") ||
    text.startsWith("zxqw_")
  );
}

export function synthesizeProvisionalThreadItem(
  notification,
  fallbackWorkspace = "windows",
  nowMs = Date.now()
) {
  const record = toRecord(notification);
  const threadId = extractNotificationThreadId(record);
  if (!threadId) return null;
  const params = extractNotificationParams(record);
  const item = toRecord(params?.item) || toRecord(params?.payload);
  const thread = toRecord(params?.thread);
  const workspace = readNotificationWorkspace(record, fallbackWorkspace);
  const rolloutPath = readNotificationRolloutPath(record);
  const cwd =
    readString(params?.cwd) ||
    readString(thread?.cwd) ||
    readString(item?.cwd) ||
    "";
  const preview =
    extractNotificationTextPreview(item) ||
    extractNotificationTextPreview(thread) ||
    extractNotificationTextPreview(params) ||
    "";
  if (isFilteredTestThreadCwd(cwd) || isAuxiliaryThreadPreviewText(preview)) {
    return null;
  }
  const status = readNotificationStatus(record);
  const updatedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nextItem = {
    id: threadId,
    threadId,
    workspace,
    __workspaceQueryTarget: workspace,
    source: "live-provisional",
    provisional: true,
    updatedAt,
  };
  if (rolloutPath) nextItem.path = rolloutPath;
  if (cwd) nextItem.cwd = cwd;
  if (preview) {
    nextItem.preview = preview;
    nextItem.title = preview;
  }
  if (status) nextItem.status = { type: status };
  return nextItem;
}
