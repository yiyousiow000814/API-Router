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
  if (normalized === "thread/name/updated" || normalized === "thread/status/changed") return true;
  return (
    normalized === "turn/completed" ||
    normalized === "turn/finished" ||
    normalized === "turn/failed" ||
    normalized === "turn/cancelled"
  );
}
