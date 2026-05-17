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
  return inspectNotificationThreadIdentity(notification).threadId;
}

export function inspectNotificationThreadIdentity(notification) {
  const record = toRecord(notification);
  const params = toRecord(record?.params) || toRecord(record?.payload) || null;
  const msg = toRecord(params?.msg);
  const thread = toRecord(params?.thread) || toRecord(params?.threadState) || toRecord(params?.thread_state);
  const turn = toRecord(params?.turn) || toRecord(params?.turnState) || toRecord(params?.turn_state);
  const item = toRecord(params?.item) || toRecord(params?.itemState) || toRecord(params?.item_state);
  const source = toRecord(params?.source) || toRecord(msg?.source);
  const subagent = toRecord(toRecord(source?.subagent)?.thread_spawn);
  const exactMatches = [
    ["msg.thread_id", readString(msg?.thread_id)],
    ["msg.threadId", readString(msg?.threadId)],
    ["msg.conversation_id", readString(msg?.conversation_id)],
    ["msg.conversationId", readString(msg?.conversationId)],
    ["msg.session_id", readString(msg?.session_id)],
    ["msg.sessionId", readString(msg?.sessionId)],
    ["params.thread_id", readString(params?.thread_id)],
    ["params.threadId", readString(params?.threadId)],
    ["params.conversation_id", readString(params?.conversation_id)],
    ["params.conversationId", readString(params?.conversationId)],
    ["params.session_id", readString(params?.session_id)],
    ["params.sessionId", readString(params?.sessionId)],
    ["thread.id", readString(thread?.id)],
    ["thread.thread_id", readString(thread?.thread_id)],
    ["thread.threadId", readString(thread?.threadId)],
    ["thread.conversation_id", readString(thread?.conversation_id)],
    ["thread.conversationId", readString(thread?.conversationId)],
    ["thread.session_id", readString(thread?.session_id)],
    ["thread.sessionId", readString(thread?.sessionId)],
    ["turn.thread_id", readString(turn?.thread_id)],
    ["turn.threadId", readString(turn?.threadId)],
    ["turn.conversation_id", readString(turn?.conversation_id)],
    ["turn.conversationId", readString(turn?.conversationId)],
    ["turn.session_id", readString(turn?.session_id)],
    ["turn.sessionId", readString(turn?.sessionId)],
    ["item.thread_id", readString(item?.thread_id)],
    ["item.threadId", readString(item?.threadId)],
    ["item.conversation_id", readString(item?.conversation_id)],
    ["item.conversationId", readString(item?.conversationId)],
    ["item.session_id", readString(item?.session_id)],
    ["item.sessionId", readString(item?.sessionId)],
    ["source.thread_id", readString(source?.thread_id)],
    ["source.threadId", readString(source?.threadId)],
    ["source.conversation_id", readString(source?.conversation_id)],
    ["source.conversationId", readString(source?.conversationId)],
    ["source.session_id", readString(source?.session_id)],
    ["source.sessionId", readString(source?.sessionId)],
    ["source.parent_thread_id", readString(source?.parent_thread_id)],
    ["source.parentThreadId", readString(source?.parentThreadId)],
    ["source.parent_session_id", readString(source?.parent_session_id)],
    ["source.parentSessionId", readString(source?.parentSessionId)],
    ["subagent.parent_thread_id", readString(subagent?.parent_thread_id)],
    ["subagent.parentThreadId", readString(subagent?.parentThreadId)],
    ["subagent.parent_session_id", readString(subagent?.parent_session_id)],
    ["subagent.parentSessionId", readString(subagent?.parentSessionId)],
  ];
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
        if (found) {
          return {
            threadId: found,
            matchedKey: `deep.${key}`,
          };
        }
      }
    }
    for (const key of Object.keys(root)) {
      const found = deepFindThreadId(root[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  const matched = exactMatches.find(([, value]) => value) || null;
  const deepMatch = matched ? null : deepFindThreadId(params);
  const finalThreadId = matched?.[1] || deepMatch?.threadId || null;
  const matchedKey = matched?.[0] || deepMatch?.matchedKey || "";
  return {
    threadId: finalThreadId,
    matchedKey,
    usedParentThreadId: matchedKey.includes("parent_thread") || matchedKey.includes("parentThread"),
    parentThreadId:
      readString(source?.parent_thread_id) ||
      readString(source?.parentThreadId) ||
      readString(source?.parent_session_id) ||
      readString(source?.parentSessionId) ||
      readString(subagent?.parent_thread_id) ||
      readString(subagent?.parentThreadId) ||
      readString(subagent?.parent_session_id) ||
      readString(subagent?.parentSessionId) ||
      null,
  };
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

function isSubagentNotification(notification) {
  const seen = new Set();
  const scan = (value, depth = 0) => {
    if (!value || depth > 6 || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 40).some((child) => scan(child, depth + 1));
    }
    if (value.subagent != null || value.subAgent != null) return true;
    if (
      readString(value.agentRole)?.trim() ||
      readString(value.agent_role)?.trim() ||
      readString(value.agentNickname)?.trim() ||
      readString(value.agent_nickname)?.trim()
    ) {
      return true;
    }
    return Object.values(value).some((child) => scan(child, depth + 1));
  };
  const params = extractNotificationParams(notification) || notification;
  return scan(params);
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

function isUserMessageRecord(value) {
  const record = toRecord(value);
  if (!record) return false;
  const type = normalizeLiveMethod(readString(record?.type) || "");
  const role = String(record?.role || "").trim().toLowerCase();
  return (
    role === "user" ||
    type === "user_message" ||
    type === "usermessage" ||
    (type === "message" && role === "user")
  );
}

function extractUserMessageTextPreview(value) {
  if (!isUserMessageRecord(value)) return "";
  return extractNotificationTextPreview(value);
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
  const inspection = inspectProvisionalThreadCandidate(notification, fallbackWorkspace, nowMs);
  return inspection.accepted ? inspection.item : null;
}

export function inspectProvisionalThreadCandidate(
  notification,
  fallbackWorkspace = "windows",
  nowMs = Date.now()
) {
  const record = toRecord(notification);
  const threadIdentity = inspectNotificationThreadIdentity(record);
  if (isSubagentNotification(record)) {
    return {
      accepted: false,
      rejectionReason: "subagent-notification",
      ...threadIdentity,
    };
  }
  const threadId = threadIdentity.threadId;
  if (!threadId) {
    return {
      accepted: false,
      rejectionReason: "missing-thread-id",
      ...threadIdentity,
    };
  }
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
    extractUserMessageTextPreview(item) ||
    extractUserMessageTextPreview(thread) ||
    extractUserMessageTextPreview(params) ||
    "";
  if (isFilteredTestThreadCwd(cwd)) {
    return {
      accepted: false,
      rejectionReason: "filtered-cwd",
      workspace,
      rolloutPath,
      cwd,
      preview,
      status: readNotificationStatus(record),
      ...threadIdentity,
    };
  }
  if (isAuxiliaryThreadPreviewText(preview)) {
    return {
      accepted: false,
      rejectionReason: "auxiliary-preview",
      workspace,
      rolloutPath,
      cwd,
      preview,
      status: readNotificationStatus(record),
      ...threadIdentity,
    };
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
    nextItem.previewSource = "user";
  }
  if (status) nextItem.status = { type: status };
  return {
    accepted: true,
    rejectionReason: "",
    workspace,
    rolloutPath,
    cwd,
    preview,
    status,
    item: nextItem,
    ...threadIdentity,
  };
}
