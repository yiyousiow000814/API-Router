import { toolItemToMessage } from "./messageData.js";
import { clonePlanState, extractPlanUpdate } from "./runtimePlan.js";
import {
  clearProposedPlanConfirmation,
  extractProposedPlanArtifacts,
  setProposedPlanConfirmation,
} from "./proposedPlan.js";
import {
  clearActiveAssistantLiveState as clearActiveAssistantLiveStateRuntime,
  finishPendingTurnRun as finishPendingTurnRunRuntime,
  rememberFinalAssistant as rememberFinalAssistantRuntime,
  resetPendingTurnRuntime as resetPendingTurnRuntimeRuntime,
  resetTurnPresentationState as resetTurnPresentationStateRuntime,
  setPendingTurnRunning as setPendingTurnRunningRuntime,
  syncPendingTurnRuntime as syncPendingTurnRuntimeState,
  syncPendingAssistantState as syncPendingAssistantStateRuntime,
} from "./runtimeState.js";

export function workspaceKeyOfThread(thread) {
  const raw = thread.cwd || thread.workspace || thread.project || thread.directory || thread.path || "";
  const text = String(raw || "").trim();
  if (!text) return { key: "default-folder", label: "Default folder" };
  const normalized = text
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const folder = parts[parts.length - 1] || "Default folder";
  let key = /[\\/]/.test(normalized)
    ? normalized.replace(/\\/g, "/").toLowerCase()
    : folder.toLowerCase();
  const normalizedKeyParts = key.split("/").filter(Boolean);
  const worktreeIndex = normalizedKeyParts.findIndex((part, index, items) =>
    part === ".codex" && items[index + 1] === "worktrees"
  );
  if (worktreeIndex >= 0 && normalizedKeyParts.length > worktreeIndex + 3) {
    const projectName = normalizedKeyParts[worktreeIndex + 3];
    const rootParts = normalizedKeyParts.slice(0, worktreeIndex);
    if (projectName && rootParts.length > 0) {
      key = `${rootParts.join("/")}/${projectName}`;
    }
  }
  return {
    key,
    label: folder,
  };
}

export function isRunningLiveStatus(value) {
  return /running|inprogress|working|queued|started|streaming/.test(
    String(value || "").trim().toLowerCase()
  );
}

export function isFailedLiveStatus(value) {
  return /failed|error|cancelled|timeout|denied/.test(
    String(value || "").trim().toLowerCase()
  );
}

export function isReconnectLiveStatus(value) {
  return /reconnect|retry|disconnected|connectionlost|connection_lost|resume/.test(
    String(value || "").trim().toLowerCase()
  );
}

export function formatReconnectStatusPreview(message) {
  const raw = String(message || "").trim();
  if (!raw) return "Reconnecting...";
  const attemptMatch = raw.match(/\b(\d+\s*\/\s*\d+)\b/);
  const attempt = attemptMatch ? String(attemptMatch[1] || "").replace(/\s+/g, "") : "";
  return attempt ? `Reconnecting... ${attempt}` : "Reconnecting...";
}

export function normalizeLiveMethod(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const aliases = {
    task_started: "codex/event/task_started",
    turn_started: "codex/event/turn_started",
    task_complete: "codex/event/task_complete",
    turn_complete: "codex/event/turn_complete",
    task_aborted: "codex/event/task_aborted",
    turn_aborted: "codex/event/turn_aborted",
    task_failed: "codex/event/task_failed",
    turn_failed: "codex/event/turn_failed",
    item_started: "item/started",
    item_completed: "item/completed",
    thread_name_updated: "thread/name/updated",
    thread_status_changed: "thread/status/changed",
  };
  return aliases[raw] || raw.replace(/\./g, "/");
}

function normalizeLiveStatusValue(value, helpers) {
  const { normalizeType, toRecord } = helpers;
  const record = toRecord(value);
  if (record) {
    return (
      normalizeType(record.type) ||
      normalizeType(record.status) ||
      normalizeType(record.state) ||
      normalizeType(record.kind) ||
      normalizeType(record.name)
    );
  }
  return normalizeType(value);
}

function extractLiveStatusMessage(params, helpers) {
  const { normalizeInline, toRecord } = helpers;
  const error = toRecord(params?.error);
  const turnError = toRecord(params?.turn?.error);
  const threadError = toRecord(params?.thread?.error);
  return (
    normalizeInline(params?.message, 180) ||
    normalizeInline(error?.message, 180) ||
    normalizeInline(params?.error, 180) ||
    normalizeInline(params?.turn?.message, 180) ||
    normalizeInline(turnError?.message, 180) ||
    normalizeInline(params?.turn?.error, 180) ||
    normalizeInline(params?.thread?.message, 180) ||
    normalizeInline(threadError?.message, 180) ||
    normalizeInline(params?.thread?.error, 180) ||
    normalizeInline(params?.code, 180) ||
    ""
  );
}

export function deriveLiveStatusFromToolItem(item, helpers) {
  const { normalizeType, normalizeInline, toRecord } = helpers;
  const itemType = normalizeType(item?.type);
  if (!itemType) return null;

  if (itemType === "commandexecution") {
    const command = normalizeInline(item?.command, 120) ?? "command";
    const status = normalizeType(item?.status);
    if (isFailedLiveStatus(status)) return { message: `Command failed: ${command}`, isWarn: true };
    if (isRunningLiveStatus(status)) return { message: `Running ${command}...`, isWarn: false };
    return { message: `Command completed: ${command}`, isWarn: false };
  }

  if (itemType === "mcptoolcall") {
    const server = normalizeInline(item?.server, 80);
    const tool = normalizeInline(item?.tool, 80);
    const label = [server, tool].filter(Boolean).join(" / ") || "tool";
    const status = normalizeType(item?.status);
    if (isFailedLiveStatus(status)) return { message: `Tool failed: ${label}`, isWarn: true };
    if (isRunningLiveStatus(status)) return { message: `Calling tool: ${label}`, isWarn: false };
    return { message: `Tool completed: ${label}`, isWarn: false };
  }

  if (itemType === "websearch") {
    const query = normalizeInline(item?.query, 120);
    const status = normalizeType(item?.status);
    if (isFailedLiveStatus(status)) {
      return { message: query ? `Web search failed: ${query}` : "Web search failed.", isWarn: true };
    }
    if (isRunningLiveStatus(status)) {
      return { message: query ? `Searching web: ${query}` : "Searching web...", isWarn: false };
    }
    return { message: query ? `Searched web: ${query}` : "Searched web.", isWarn: false };
  }

  if (itemType === "filechange") {
    const status = normalizeType(item?.status);
    const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    if (isFailedLiveStatus(status)) return { message: "File changes failed.", isWarn: true };
    if (isRunningLiveStatus(status)) return { message: "Applying file changes...", isWarn: false };
    return {
      message: changeCount > 0 ? `Applied ${String(changeCount)} file change(s).` : "Applied file changes.",
      isWarn: false,
    };
  }

  if (itemType === "enteredreviewmode") return { message: "Entered review mode.", isWarn: false };
  if (itemType === "exitedreviewmode") return { message: "Exited review mode.", isWarn: false };
  if (itemType === "contextcompaction") return { message: "Compacted conversation context.", isWarn: false };

  const err = toRecord(item?.error);
  const errMsg = normalizeInline(err?.message, 180) ?? normalizeInline(item?.error, 180);
  if (errMsg) return { message: errMsg, isWarn: true };
  return null;
}

export function deriveLiveStatusFromNotification(notification, helpers) {
  const { toRecord, normalizeType, normalizeInline } = helpers;
  const record = toRecord(notification);
  const method = normalizeLiveMethod(record?.method);
  if (!method) return null;
  const params = toRecord(record?.params) || toRecord(record?.payload) || null;
  const toolItem = params
    ? toRecord(params?.msg) || toRecord(params?.item) || toRecord(params?.delta) || toRecord(params?.event) || null
    : null;
  const toolStatus = toolItem ? deriveLiveStatusFromToolItem(toolItem, helpers) : null;
  if (toolStatus) return toolStatus;

  if (method.includes("turn/assistant/delta")) {
    return { message: "Receiving response...", isWarn: false };
  }

  const status =
    normalizeLiveStatusValue(params?.status, helpers) ||
    normalizeLiveStatusValue(params?.turn?.status, helpers) ||
    normalizeLiveStatusValue(params?.thread?.status, helpers);
  const message = extractLiveStatusMessage(params, helpers);

  if (isReconnectLiveStatus(status || message)) {
    return {
      message: formatReconnectStatusPreview(message),
      isWarn: false,
    };
  }
  if (
    (method.includes("turn/completed") || method.includes("turn/finished")) &&
    isFailedLiveStatus(status || message)
  ) {
    return { message: message || "Turn failed.", isWarn: true };
  }
  if (
    (method.includes("turn/completed") || method.includes("turn/finished")) &&
    /cancel|interrupt/.test(String(status || message || "").trim().toLowerCase())
  ) {
    return { message: message || "Turn cancelled.", isWarn: true };
  }
  if (message) {
    return { message, isWarn: isFailedLiveStatus(status || message) };
  }
  if (isRunningLiveStatus(status) || method.includes("turn/started")) {
    return { message: "Running...", isWarn: false };
  }
  if (method.includes("turn/completed") || method.includes("turn/finished")) {
    return { message: "Turn completed.", isWarn: false };
  }
  if (method.includes("turn/failed")) {
    return { message: "Turn failed.", isWarn: true };
  }
  if (method.includes("turn/cancelled")) {
    return { message: "Turn cancelled.", isWarn: true };
  }
  return null;
}

function matchesNormalizedType(value, names, normalizeType) {
  const raw = String(value || "").trim().toLowerCase();
  const normalized = typeof normalizeType === "function" ? normalizeType(value) : raw;
  return names.some((name) => {
    const rawName = String(name || "").trim().toLowerCase();
    const normalizedName = typeof normalizeType === "function" ? normalizeType(name) : rawName;
    return raw === rawName || normalized === normalizedName;
  });
}

function isTerminalHistoryStatusValue(value) {
  const statusType = String(value || "").trim().toLowerCase();
  if (!statusType) return false;
  return (
    statusType === "interrupted" ||
    statusType === "cancelled" ||
    statusType === "failed" ||
    statusType === "error" ||
    statusType === "systemerror" ||
    statusType === "timeout" ||
    statusType === "denied"
  );
}

function isVisibleAssistantPhase(value) {
  const phase = String(value || "").trim().toLowerCase();
  if (!phase) return true;
  return phase === "final_answer";
}

function readAssistantContentText(item, helpers) {
  const { normalizeType, normalizeMultiline } = helpers;
  const itemType = String(item?.type || "").trim();
  if (!itemType) return null;
  const phase = String(item?.phase || "").trim().toLowerCase();
  const itemId =
    String(item?.id || item?.itemId || item?.item_id || item?.message_id || item?.messageId || "").trim();

  if (
    matchesNormalizedType(
      itemType,
      ["agent_message_delta", "assistant_message_delta", "agent_message_content_delta"],
      normalizeType
    )
  ) {
    const text = normalizeMultiline(item?.delta ?? item?.text ?? item?.message, 24000);
    return text ? { mode: "delta", text, phase, itemId } : null;
  }

  if (matchesNormalizedType(itemType, ["agent_message", "assistant_message"], normalizeType)) {
    const text = normalizeMultiline(item?.text ?? item?.message ?? item?.delta, 24000);
    return text ? { mode: "snapshot", text, phase, itemId } : null;
  }

  if (
    matchesNormalizedType(itemType, ["message"], normalizeType) &&
    matchesNormalizedType(item?.role, ["assistant"], normalizeType)
  ) {
    const parts = Array.isArray(item?.content) ? item.content : [];
    const lines = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (!matchesNormalizedType(part?.type, ["output_text", "input_text", "text"], normalizeType)) continue;
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim()) lines.push(text);
    }
    const joined = normalizeMultiline(lines.join("\n"), 24000);
    return joined ? { mode: "snapshot", text: joined, phase, itemId } : null;
  }

  return null;
}

export function createLiveNotificationsModule(deps) {
  const LIVE_THREAD_CONNECTION_STATUS_MESSAGE_KEY = "live-thread-connection-status";
  const {
    state,
    byId,
    setStatus = () => {},
    addChat,
    removeChatMessageByKey = () => false,
    scheduleChatLiveFollow,
    hideWelcomeCard = () => {},
    createAssistantStreamingMessage = () => ({ msg: null, body: null }),
    appendStreamingDelta = () => {},
    renderAssistantLiveBody = null,
    finalizeAssistantMessage = () => {},
    setRuntimeActivity = () => {},
    setActiveCommands = () => {},
    applyToolItemRuntimeUpdate = () => {},
    applyPlanDeltaUpdate = () => {},
    applyPlanSnapshotUpdate = () => {},
    clearPendingUserInputs = () => false,
    setSyntheticPendingUserInputs = () => {},
    suppressSyntheticPendingUserInputs = () => {},
    upsertSyntheticPendingUserInput = () => {},
    finalizeRuntimeState = () => {},
    flushQueuedTurn = async () => false,
    renderPendingInline = () => {},
    renderCommentaryArchive = () => {},
    normalizeType,
    normalizeInline,
    normalizeMultiline,
    readNumber,
    toRecord,
    toStructuredPreview,
    extractNotificationThreadId,
  } = deps;

  function activeThreadHistoryTurnCount(threadId = state.activeThreadId) {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    if (!normalizedThreadId) return 0;
    if (String(state.activeThreadHistoryThreadId || "").trim() !== normalizedThreadId) return 0;
    return Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
  }

  function pushLiveDebugEvent(kind, payload = {}) {
    const eventKind = String(kind || "");
    const nextPayload = payload && typeof payload === "object" ? { ...payload } : {};
    const combinedStatusText = [
      nextPayload.rawStatus,
      nextPayload.rawMessage,
      nextPayload.status,
      nextPayload.statusMessage,
      nextPayload.message,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" ");
    if (eventKind.startsWith("live.connection:")) {
      nextPayload.__tracePersist = true;
    } else if (
      eventKind === "live.status" &&
      (isReconnectLiveStatus(combinedStatusText) || isFailedLiveStatus(combinedStatusText))
    ) {
      nextPayload.__tracePersist = true;
    }
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: eventKind,
      ...nextPayload,
    });
    if (state.liveDebugEvents.length > 160) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 160);
    }
  }

  function summarizeRecordKeys(value) {
    const record = toRecord(value);
    if (!record) return "";
    return Object.keys(record)
      .slice(0, 8)
      .join(",");
  }

  function summarizePreview(value, maxChars = 180) {
    const preview = toStructuredPreview(value, maxChars) ?? normalizeInline(value, maxChars);
    if (!preview) return "";
    return String(preview).replace(/\s+/g, " ").trim().slice(0, Math.max(1, maxChars));
  }

  function toToolLikeMessage(item) {
    const normalizedTool = normalizeType(item?.tool || item?.name);
    if (normalizedTool === "requestuserinput") return "";
    return toolItemToMessage(item, { compact: true });
  }

  function clearTransientToolMessages() {
    state.activeThreadTransientToolText = "";
    try {
      const box = byId("chatBox");
      const nodes = Array.from(box?.querySelectorAll?.('.msg.system.kind-tool[data-msg-transient="1"]') || []);
      for (const node of nodes) node.remove?.();
    } catch {}
  }

  function hasMatchingTransientToolNode(toolText) {
    try {
      const box = byId("chatBox");
      const nodes = Array.from(box?.querySelectorAll?.('.msg.system.kind-tool[data-msg-transient="1"]') || []);
      return nodes.some((node) => String(node?.__webCodexRawText || "").trim() === toolText);
    } catch {
      return false;
    }
  }

  function showTransientToolMessage(text) {
    const toolText = String(text || "");
    if (!toolText) return;
    if (String(state.activeThreadTransientToolText || "") === toolText && hasMatchingTransientToolNode(toolText)) return;
    clearTransientToolMessages();
    state.activeThreadTransientToolText = toolText;
    addChat("system", toolText, { kind: "tool", scroll: false, source: "live", transient: true });
  }

  function clearTransientThinkingMessages() {
    state.activeThreadTransientThinkingText = "";
    try {
      const box = byId("chatBox");
      const nodes = Array.from(box?.querySelectorAll?.('.msg.system.kind-thinking[data-msg-transient="1"]') || []);
      for (const node of nodes) node.remove?.();
    } catch {}
  }

  function hasMatchingTransientThinkingNode(thinkingText) {
    try {
      const box = byId("chatBox");
      const nodes = Array.from(box?.querySelectorAll?.('.msg.system.kind-thinking[data-msg-transient="1"]') || []);
      return nodes.some((node) => String(node?.__webCodexRawText || "").trim() === thinkingText);
    } catch {
      return false;
    }
  }

  function showTransientThinkingMessage(text) {
    const thinkingText = String(text || "");
    if (!thinkingText) return;
    state.activeThreadTransientThinkingText = thinkingText;
    if (hasMatchingTransientThinkingNode(thinkingText)) return;
    clearTransientThinkingMessages();
    state.activeThreadTransientThinkingText = thinkingText;
  }

  function clearLiveThreadConnectionStatus(reason = "") {
    const currentKind = String(state.activeThreadConnectionStatusKind || "").trim();
    const currentText = String(state.activeThreadConnectionStatusText || "").trim();
    const currentThreadId = String(state.activeThreadId || "").trim();
    const currentEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
    const normalizedReason = String(reason || "").trim();
    const terminalConnectionErrorThreadId = String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
    const shouldForceRemove = !!terminalConnectionErrorThreadId;
    if (
      normalizedReason === "turn.send:new_turn" &&
      currentKind === "error" &&
      currentText &&
      currentThreadId
    ) {
      state.activeThreadConnectionReplayGuardThreadId = currentThreadId;
      state.activeThreadConnectionReplayGuardText = currentText;
      state.activeThreadConnectionReplayGuardEpoch = currentEpoch;
      state.activeThreadConnectionReplayGuardReconnectSeen = false;
      pushLiveDebugEvent("live.connection:replay_guard_prime", {
        threadId: currentThreadId,
        epoch: currentEpoch,
        text: currentText.slice(0, 180),
      });
    } else if (
      normalizedReason !== "show_error:replace_previous_status" &&
      (
        String(state.activeThreadConnectionReplayGuardThreadId || "").trim() ||
        String(state.activeThreadConnectionReplayGuardText || "").trim() ||
        Number(state.activeThreadConnectionReplayGuardEpoch || 0) > 0 ||
        state.activeThreadConnectionReplayGuardReconnectSeen === true
      )
    ) {
      pushLiveDebugEvent("live.connection:replay_guard_clear", {
        threadId: String(state.activeThreadConnectionReplayGuardThreadId || "").trim(),
        epoch: Math.max(0, Number(state.activeThreadConnectionReplayGuardEpoch || 0)),
        reconnectSeen: state.activeThreadConnectionReplayGuardReconnectSeen === true,
        reason: normalizedReason,
      });
      state.activeThreadConnectionReplayGuardThreadId = "";
      state.activeThreadConnectionReplayGuardText = "";
      state.activeThreadConnectionReplayGuardEpoch = 0;
      state.activeThreadConnectionReplayGuardReconnectSeen = false;
    }
    if (
      normalizedReason === "turn.send:new_turn" &&
      terminalConnectionErrorThreadId &&
      terminalConnectionErrorThreadId === currentThreadId
    ) {
      pushLiveDebugEvent("live.connection:terminal_error_latch_clear", {
        threadId: currentThreadId,
        reason: normalizedReason,
      });
      state.activeThreadTerminalConnectionErrorThreadId = "";
    }
    if (normalizedReason === "turn.send:new_turn") {
      state.activeThreadPendingTerminalConnectionErrorThreadId = "";
      state.activeThreadPendingTerminalConnectionErrorText = "";
    }
    if (!currentKind && !currentText && !shouldForceRemove) return;
    pushLiveDebugEvent("live.connection:thread_clear", {
      threadId: String(state.activeThreadId || ""),
      reason: normalizedReason,
      currentKind,
      currentText: currentText.slice(0, 180),
      forced: !currentKind && !currentText,
    });
    state.activeThreadConnectionStatusKind = "";
    state.activeThreadConnectionStatusText = "";
    removeChatMessageByKey(LIVE_THREAD_CONNECTION_STATUS_MESSAGE_KEY);
    if (currentText && normalizedReason && normalizedReason !== "show_error:replace_previous_status") {
      setStatus("", false);
    }
  }

  function shouldDeferTerminalConnectionFailure(threadId) {
    const activeThreadId = String(state.activeThreadId || "").trim();
    const historyThreadId = String(state.activeThreadHistoryThreadId || "").trim();
    const historyStatusType = String(state.activeThreadHistoryStatusType || "").trim().toLowerCase();
    if (!threadId || activeThreadId !== threadId || historyThreadId !== threadId) return false;
    return !isTerminalHistoryStatusValue(historyStatusType);
  }

  function rememberDeferredTerminalConnectionFailure(threadId, message, context = {}) {
    const detail = String(message || "").trim();
    if (!threadId || !detail) return;
    state.activeThreadPendingTerminalConnectionErrorThreadId = threadId;
    state.activeThreadPendingTerminalConnectionErrorText = detail;
    pushLiveDebugEvent("live.connection:terminal_error_deferred", {
      threadId,
      method: String(context.method || ""),
      status: String(context.status || ""),
      message: detail.slice(0, 180),
      historyStatusType: String(state.activeThreadHistoryStatusType || "").trim().toLowerCase(),
    });
  }

  function showLiveThreadReconnectStatus(message, context = {}) {
    const detail = String(message || "").trim();
    if (!detail) return;
    const rendered = formatReconnectStatusPreview(detail);
    const threadId = String(context.threadId || state.activeThreadId || "").trim();
    const currentEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
    if (
      String(state.activeThreadConnectionReplayGuardThreadId || "").trim() === threadId &&
      Math.max(0, Number(state.activeThreadConnectionReplayGuardEpoch || 0)) === currentEpoch &&
      state.activeThreadConnectionReplayGuardReconnectSeen !== true
    ) {
      state.activeThreadConnectionReplayGuardReconnectSeen = true;
      pushLiveDebugEvent("live.connection:replay_guard_reconnect_seen", {
        threadId,
        epoch: currentEpoch,
      });
    }
    if (
      String(state.activeThreadConnectionStatusKind || "") === "reconnecting" &&
      String(state.activeThreadConnectionStatusText || "") === rendered
    ) {
      pushLiveDebugEvent("live.connection:thread_skip_duplicate_reconnect", {
        threadId: String(context.threadId || state.activeThreadId || ""),
        method: String(context.method || ""),
        status: String(context.status || ""),
        rendered,
      });
      return;
    }
    const attemptMatch = detail.match(/\b(\d+\s*\/\s*\d+)\b/);
    pushLiveDebugEvent("live.connection:thread_show_reconnect", {
      threadId: String(context.threadId || state.activeThreadId || ""),
      method: String(context.method || ""),
      status: String(context.status || ""),
      rawMessage: detail.slice(0, 180),
      rendered,
      attempt: attemptMatch ? String(attemptMatch[1] || "").replace(/\s+/g, "") : "",
    });
    state.activeThreadConnectionStatusKind = "reconnecting";
    state.activeThreadConnectionStatusText = rendered;
    addChat("system", rendered, {
      kind: "thinking",
      transient: false,
      animate: true,
      messageKey: LIVE_THREAD_CONNECTION_STATUS_MESSAGE_KEY,
    });
  }

  function showLiveThreadReconnectError(message, context = {}) {
    const detail = String(message || "").trim();
    if (!detail) return;
    const threadId = String(context.threadId || state.activeThreadId || "").trim();
    const previousKind = String(state.activeThreadConnectionStatusKind || "");
    const previousText = String(state.activeThreadConnectionStatusText || "").trim();
    if (
      previousKind === "error" &&
      previousText === detail
    ) {
      pushLiveDebugEvent("live.connection:thread_skip_duplicate_error", {
        threadId: String(context.threadId || state.activeThreadId || ""),
        method: String(context.method || ""),
        status: String(context.status || ""),
        rawMessage: detail.slice(0, 180),
      });
      return;
    }
    if (previousKind === "error" && previousText && detail.length <= previousText.length) {
      pushLiveDebugEvent("live.connection:thread_skip_weaker_error", {
        threadId: String(context.threadId || state.activeThreadId || ""),
        method: String(context.method || ""),
        status: String(context.status || ""),
        rawMessage: detail.slice(0, 180),
        previousText: previousText.slice(0, 180),
      });
      return;
    }
    pushLiveDebugEvent("live.connection:thread_show_error", {
      threadId: String(context.threadId || state.activeThreadId || ""),
      method: String(context.method || ""),
      status: String(context.status || ""),
      rawMessage: detail.slice(0, 180),
      previousKind,
      previousText: previousText.slice(0, 180),
    });
    clearLiveThreadConnectionStatus("show_error:replace_previous_status");
    state.activeThreadConnectionStatusKind = "error";
    state.activeThreadConnectionStatusText = detail;
    state.activeThreadTerminalConnectionErrorThreadId = threadId;
    addChat("system", detail, {
      kind: "error",
      transient: false,
      animate: true,
      messageKey: LIVE_THREAD_CONNECTION_STATUS_MESSAGE_KEY,
    });
  }

  function shouldKeepReconnectStatusDuringActiveTurn(_threadId, method, status, statusMessage) {
    if (String(state.activeThreadConnectionStatusKind || "").trim() !== "reconnecting") return false;
    if (
      method.includes("thread/status/changed") ||
      method === "thread/status" ||
      method === "turn/status"
    ) {
      const liveValue = String(status || statusMessage || "").trim();
      if (isReconnectLiveStatus(liveValue) || isFailedLiveStatus(liveValue)) return false;
    }
    return true;
  }

  function shouldSuppressPendingConnectionTerminalReplay({
    threadId,
    method,
    status,
    statusMessage,
    terminalFailureStatus = false,
  }) {
    const normalizedThreadId = String(threadId || "").trim();
    const guardThreadId = String(state.activeThreadConnectionReplayGuardThreadId || "").trim();
    if (!normalizedThreadId || !guardThreadId || guardThreadId !== normalizedThreadId) return false;
    const currentEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
    const guardEpoch = Math.max(0, Number(state.activeThreadConnectionReplayGuardEpoch || 0));
    if (!guardEpoch || guardEpoch !== currentEpoch) return false;
    if (state.activeThreadConnectionReplayGuardReconnectSeen === true) return false;
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const hasPendingRuntime =
      pendingThreadId === normalizedThreadId &&
      (
        state.activeThreadPendingTurnRunning === true ||
        !!String(state.activeThreadPendingTurnId || "").trim() ||
        !!String(state.activeThreadPendingUserMessage || "").trim() ||
        !!String(state.activeThreadPendingAssistantMessage || "").trim()
      );
    if (!hasPendingRuntime) return false;
    if (method === "error") return true;
    if (
      method.includes("thread/status/changed") ||
      method === "thread/status" ||
      method === "turn/status"
    ) {
      if (!isFailedLiveStatus(status || statusMessage)) return false;
      const guardText = String(state.activeThreadConnectionReplayGuardText || "").trim();
      const nextMessage = String(statusMessage || "").trim();
      return !!guardText && nextMessage === guardText;
    }
    const isFailedTurnTerminal =
      terminalFailureStatus &&
      (method.includes("turn/completed") || method.includes("turn/failed"));
    if (!isFailedTurnTerminal) return false;
    const guardText = String(state.activeThreadConnectionReplayGuardText || "").trim();
    return !!guardText;
  }

  function ensureCommentaryState() {
    if (!Array.isArray(state.activeThreadCommentaryArchive)) state.activeThreadCommentaryArchive = [];
    if (typeof state.activeThreadCommentaryArchiveVisible !== "boolean") state.activeThreadCommentaryArchiveVisible = false;
    if (typeof state.activeThreadCommentaryArchiveExpanded !== "boolean") state.activeThreadCommentaryArchiveExpanded = false;
    if (!Array.isArray(state.activeThreadCommentaryPendingTools)) state.activeThreadCommentaryPendingTools = [];
    if (!Array.isArray(state.activeThreadCommentaryPendingToolKeys)) state.activeThreadCommentaryPendingToolKeys = [];
    if (!state.activeThreadCommentaryPendingPlan || typeof state.activeThreadCommentaryPendingPlan !== "object") {
      state.activeThreadCommentaryPendingPlan = null;
    }
    if (!state.activeThreadCommentaryCurrent || typeof state.activeThreadCommentaryCurrent !== "object") {
      state.activeThreadCommentaryCurrent = null;
    }
  }

  function pushCommentaryStateDebug(action, payload = {}) {
    const current = state.activeThreadCommentaryCurrent;
    const text = String((payload.text ?? current?.text) || "");
    const tools = Array.isArray(payload.tools)
      ? payload.tools
      : Array.isArray(current?.tools)
        ? current.tools
        : [];
    pushLiveDebugEvent("live.inspect:commentary_state", {
      action,
      threadId: String(payload.threadId || state.activeThreadId || current?.threadId || ""),
      key: String(payload.key || current?.key || ""),
      chars: text.length,
      toolCount: tools.length,
      archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
      visible: state.activeThreadCommentaryArchiveVisible === true,
      expanded: state.activeThreadCommentaryArchiveExpanded === true,
      preview: summarizePreview(text, 120),
    });
  }

  function normalizeCommentaryBlockKey(item, assistantUpdate) {
    const explicit = String(
      assistantUpdate?.itemId ||
      item?.id ||
      item?.itemId ||
      item?.item_id ||
      item?.message_id ||
      item?.messageId ||
      ""
    ).trim();
    if (explicit) return explicit;
    const currentKey = String(state.activeThreadCommentaryCurrent?.key || "").trim();
    if (currentKey) return currentKey;
    const seed = String(assistantUpdate?.text || "").trim().slice(0, 160);
    return seed ? `commentary:${seed}` : "";
  }

  function createSummaryCommentaryBlock(threadId, plan, tools = [], toolKeys = [], options = {}) {
    const normalizedThreadId = String(threadId || state.activeThreadId || "").trim();
    const snapshot = clonePlanState(plan, normalizedThreadId);
    const normalizedTools = Array.isArray(tools)
      ? tools.map((tool) => String(tool || "").trim()).filter(Boolean)
      : [];
    const normalizedToolKeys = Array.isArray(toolKeys)
      ? toolKeys.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    const allowEmpty = options.allowEmpty === true;
    if (!snapshot && !normalizedTools.length && !allowEmpty) return null;
    const seed = String(snapshot?.turnId || normalizedToolKeys[0] || normalizedThreadId || "summary").trim() || "summary";
    const block = {
      threadId: normalizedThreadId,
      key: `commentary-summary:${seed}`,
      text: "",
      tools: normalizedTools,
      toolKeys: normalizedToolKeys,
      plan: snapshot,
    };
    if (!snapshot && !normalizedTools.length) block.summaryOnly = true;
    return block;
  }

  function archiveCommentaryBlock(block) {
    ensureCommentaryState();
    if (!block || typeof block !== "object") return false;
    const text = String(block.text || "").trim();
    const tools = Array.isArray(block.tools) ? block.tools.filter((tool) => String(tool || "").trim()) : [];
    const plan = clonePlanState(block.plan, String(block.threadId || state.activeThreadId || "").trim());
    const summaryOnly = block.summaryOnly === true;
    if (!text && !tools.length && !plan && !summaryOnly) return false;
    const nextBlock = {
      threadId: String(block.threadId || state.activeThreadId || "").trim(),
      key: String(block.key || "").trim(),
      text,
      tools,
      plan,
    };
    if (summaryOnly) nextBlock.summaryOnly = true;
    const last = state.activeThreadCommentaryArchive[state.activeThreadCommentaryArchive.length - 1] || null;
    const duplicate =
      last &&
      String(last.key || "") === nextBlock.key &&
      String(last.text || "") === nextBlock.text &&
      JSON.stringify(Array.isArray(last.tools) ? last.tools : []) === JSON.stringify(nextBlock.tools) &&
      JSON.stringify(clonePlanState(last.plan, String(last.threadId || ""))) === JSON.stringify(nextBlock.plan) &&
      (last.summaryOnly === true) === (nextBlock.summaryOnly === true);
    if (!duplicate) state.activeThreadCommentaryArchive = [...state.activeThreadCommentaryArchive, nextBlock];
    pushCommentaryStateDebug("archive", {
      threadId: nextBlock.threadId,
      key: nextBlock.key,
      text: nextBlock.text,
      tools: nextBlock.tools,
    });
    return true;
  }

  function beginCommentaryBlock(threadId, item, assistantUpdate) {
    ensureCommentaryState();
    const blockKey = normalizeCommentaryBlockKey(item, assistantUpdate);
    const current = state.activeThreadCommentaryCurrent;
    const currentKey = String(current?.key || "").trim();
    const nextThreadId = String(threadId || state.activeThreadId || "").trim();
    const pendingPlan = clonePlanState(state.activeThreadCommentaryPendingPlan, nextThreadId);
    const pendingTools = Array.isArray(state.activeThreadCommentaryPendingTools)
      ? state.activeThreadCommentaryPendingTools.slice()
      : [];
    const pendingToolKeys = Array.isArray(state.activeThreadCommentaryPendingToolKeys)
      ? state.activeThreadCommentaryPendingToolKeys.slice()
      : [];
    const changed = !!current && (currentKey !== blockKey || String(current.threadId || "") !== nextThreadId);
    if (changed) archiveCommentaryBlock(current);
    if (!current || changed) {
      state.activeThreadCommentaryCurrent = {
        threadId: nextThreadId,
        key: blockKey,
        text: "",
        tools: pendingTools,
        toolKeys: pendingToolKeys,
        plan: pendingPlan,
      };
      state.activeThreadCommentaryPendingPlan = null;
      state.activeThreadCommentaryPendingTools = [];
      state.activeThreadCommentaryPendingToolKeys = [];
      if (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0) {
        setActiveCommands([]);
      }
      pushCommentaryStateDebug("begin", {
        threadId: nextThreadId,
        key: blockKey,
        text: "",
        tools: [],
      });
    }
    state.activeThreadCommentaryArchiveVisible = false;
    state.activeThreadCommentaryArchiveExpanded = false;
    renderCommentaryArchive();
    return { changed, block: state.activeThreadCommentaryCurrent };
  }

  function updateCurrentCommentaryText(threadId, item, assistantUpdate) {
    const { block } = beginCommentaryBlock(threadId, item, assistantUpdate);
    if (!block) return "";
    const currentText = String(block.text || "");
    const nextText = assistantUpdate.mode === "delta"
      ? `${currentText}${assistantUpdate.text}`
      : assistantUpdate.text;
    state.activeThreadCommentaryCurrent = {
      ...block,
      text: nextText,
      tools: Array.isArray(block.tools) ? block.tools.slice() : [],
      toolKeys: Array.isArray(block.toolKeys) ? block.toolKeys.slice() : [],
    };
    pushCommentaryStateDebug("update", {
      threadId,
      key: String(state.activeThreadCommentaryCurrent?.key || ""),
      text: nextText,
      tools: state.activeThreadCommentaryCurrent?.tools,
      plan: clonePlanState(state.activeThreadCommentaryCurrent?.plan, threadId),
    });
    return nextText;
  }

  function recordCommentaryPlan(plan) {
    ensureCommentaryState();
    const current = state.activeThreadCommentaryCurrent;
    const snapshot = clonePlanState(plan, String(current?.threadId || state.activeThreadId || ""));
    if (!snapshot) return;
    if (!current) {
      state.activeThreadCommentaryPendingPlan = snapshot;
      pushCommentaryStateDebug("plan_pending", {
        threadId: String(snapshot.threadId || state.activeThreadId || ""),
        key: `commentary-plan:${String(snapshot.turnId || state.activeThreadId || "plan").trim() || "plan"}`,
        text: "",
        tools: [],
      });
      return;
    }
    state.activeThreadCommentaryCurrent = {
      ...current,
      plan: snapshot,
    };
    pushCommentaryStateDebug("plan", {
      threadId: String(current.threadId || state.activeThreadId || ""),
      key: String(current.key || ""),
      text: String(current.text || ""),
      tools: current.tools,
    });
  }

  function recordPendingCommentaryTool(toolItem, toolText) {
    ensureCommentaryState();
    if (!toolText) return;
    const toolKey = String(toolItem?.id || toolItem?.callId || toolItem?.call_id || toolText).trim() || toolText;
    const tools = Array.isArray(state.activeThreadCommentaryPendingTools)
      ? state.activeThreadCommentaryPendingTools.slice()
      : [];
    const toolKeys = Array.isArray(state.activeThreadCommentaryPendingToolKeys)
      ? state.activeThreadCommentaryPendingToolKeys.slice()
      : [];
    const index = toolKeys.findIndex((value) => value === toolKey);
    if (index >= 0) tools[index] = toolText;
    else {
      toolKeys.push(toolKey);
      tools.push(toolText);
    }
    state.activeThreadCommentaryPendingTools = tools;
    state.activeThreadCommentaryPendingToolKeys = toolKeys;
    pushCommentaryStateDebug("tool_pending", {
      threadId: String(state.activeThreadId || ""),
      key: `commentary-summary:${toolKeys[0] || state.activeThreadId || "summary"}`,
      text: "",
      tools,
    });
  }

  function recordCommentaryTool(toolItem, toolText) {
    ensureCommentaryState();
    if (!toolText) return;
    if (!state.activeThreadCommentaryCurrent) {
      recordPendingCommentaryTool(toolItem, toolText);
      return;
    }
    const current = state.activeThreadCommentaryCurrent;
    const toolKey = String(toolItem?.id || toolItem?.callId || toolItem?.call_id || toolText).trim() || toolText;
    const tools = Array.isArray(current.tools) ? current.tools.slice() : [];
    const toolKeys = Array.isArray(current.toolKeys) ? current.toolKeys.slice() : [];
    const index = toolKeys.findIndex((value) => value === toolKey);
    if (index >= 0) tools[index] = toolText;
    else {
      toolKeys.push(toolKey);
      tools.push(toolText);
    }
    state.activeThreadCommentaryCurrent = {
      ...current,
      tools,
      toolKeys,
      plan: clonePlanState(current.plan, String(current.threadId || state.activeThreadId || "")),
    };
    pushCommentaryStateDebug("tool", {
      threadId: String(current.threadId || state.activeThreadId || ""),
      key: String(current.key || ""),
      text: String(current.text || ""),
      tools,
    });
  }

  function finalizeCommentaryArchive(anchorNode = null) {
    ensureCommentaryState();
    if (state.activeThreadCommentaryCurrent) {
      archiveCommentaryBlock(state.activeThreadCommentaryCurrent);
      state.activeThreadCommentaryCurrent = null;
    } else {
      const summaryBlock = createSummaryCommentaryBlock(
        String(state.activeThreadId || "").trim(),
        state.activeThreadCommentaryPendingPlan,
        state.activeThreadCommentaryPendingTools,
        state.activeThreadCommentaryPendingToolKeys
      );
      if (summaryBlock) archiveCommentaryBlock(summaryBlock);
    }
    state.activeThreadCommentaryPendingPlan = null;
    state.activeThreadCommentaryPendingTools = [];
    state.activeThreadCommentaryPendingToolKeys = [];
    state.activeThreadCommentaryArchiveVisible = state.activeThreadCommentaryArchive.length > 0;
    pushCommentaryStateDebug("finalize", {
      threadId: String(state.activeThreadId || ""),
      key: "",
      text: "",
      tools: [],
    });
    if (state.activeThreadCommentaryArchiveVisible) {
      renderCommentaryArchive({ anchorNode });
    } else {
      renderCommentaryArchive();
    }
  }

  function extractNotificationCandidate(notification) {
    const record = toRecord(notification);
    const paramsRecord = toRecord(record?.params);
    const payloadRecord = toRecord(record?.payload);
    const params = paramsRecord || payloadRecord || null;
    const paramsSource = paramsRecord ? "params" : payloadRecord ? "payload" : "";
    if (!params) {
      return { params: null, paramsSource, item: null, itemSource: "" };
    }
    const slots = [
      ["msg", toRecord(params?.msg)],
      ["item", toRecord(params?.item)],
      ["delta", toRecord(params?.delta)],
      ["event", toRecord(params?.event)],
      ["payload", toRecord(params?.payload)],
    ];
    for (const [slot, item] of slots) {
      if (item) {
        return {
          params,
          paramsSource,
          item,
          itemSource: paramsSource ? `${paramsSource}.${slot}` : slot,
        };
      }
    }
    return { params, paramsSource, item: null, itemSource: "" };
  }

  function notificationToToolItem(notification) {
    return extractNotificationCandidate(notification).item;
  }

  function clearActiveAssistantLiveState() {
    clearActiveAssistantLiveStateRuntime(state);
  }

  function rememberFinalAssistant(threadId, text) {
    rememberFinalAssistantRuntime(state, threadId, text);
  }

  function isRecentFinalAssistantDuplicate(threadId, text) {
    const normalizedThreadId = String(threadId || "").trim();
    const nextText = String(text || "");
    if (!normalizedThreadId || !nextText) return false;
    const lastThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
    const lastText = String(state.activeThreadLastFinalAssistantText || "");
    const lastAt = Math.max(0, Number(state.activeThreadLastFinalAssistantAt || 0));
    const lastEpoch = Math.max(0, Number(state.activeThreadLastFinalAssistantEpoch || 0));
    const currentEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
    if (!lastThreadId || lastThreadId !== normalizedThreadId) return false;
    if (!lastText || lastText !== nextText) return false;
    if (!lastAt || Date.now() - lastAt > 1500) return false;
    return lastEpoch === currentEpoch;
  }

  function syncPendingAssistantState(threadId, text) {
    syncPendingAssistantStateRuntime(state, threadId, text);
  }

  function finishPendingTurnRun(threadId, options = {}) {
    finishPendingTurnRunRuntime(state, threadId, options);
  }

  function syncPendingTurnRuntime(threadId, options = {}) {
    syncPendingTurnRuntimeState(state, threadId, options);
  }

  function resetTurnPresentationState(options = {}) {
    resetTurnPresentationStateRuntime(state, options);
  }

  function setPendingTurnRunning(threadId, running, options = {}) {
    setPendingTurnRunningRuntime(state, threadId, running, options);
  }

  function resetPendingTurnRuntime(options = {}) {
    resetPendingTurnRuntimeRuntime(state, options);
  }

  function settlePendingTurnFailure(threadId, reason = "", options = {}) {
    const normalizedThreadId = String(threadId || "").trim();
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "").trim();
    const preserveUserFallback =
      options.allowUserFallback !== false &&
      !!normalizedThreadId &&
      pendingThreadId === normalizedThreadId &&
      !!String(state.activeThreadPendingUserMessage || "").trim() &&
      !pendingAssistant;
    finishPendingTurnRun(threadId, {
      preserveTurnId: preserveUserFallback,
      preserveBaselineTurnCount: preserveUserFallback,
      preserveBaselineUserCount: preserveUserFallback,
    });
    resetPendingTurnRuntime({
      preserveThreadId: preserveUserFallback,
      preserveTurnId: preserveUserFallback,
      preserveMessages: preserveUserFallback,
      preserveBaselineTurnCount: preserveUserFallback,
      preserveBaselineUserCount: preserveUserFallback,
      reason: String(reason || "").trim(),
    });
  }

  function findAssistantLiveStream(box, threadId) {
    const nodes = Array.from(box?.querySelectorAll?.('.msg.assistant[data-live-assistant="1"]') || []);
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const msg = nodes[index];
      const liveThreadId = String(msg?.getAttribute?.("data-live-thread-id") || "");
      if (liveThreadId !== threadId) continue;
      const body = msg?.querySelector?.(".msgBody") || null;
      if (!body) continue;
      return { msg, body };
    }
    return null;
  }

  function ensureAssistantLiveStream(threadId) {
    const liveThreadId = String(state.activeThreadLiveAssistantThreadId || "");
    const liveMsg = state.activeThreadLiveAssistantMsgNode;
    const liveBody = state.activeThreadLiveAssistantBodyNode;
    if (liveThreadId === threadId && liveMsg && liveBody) {
      return { msg: liveMsg, body: liveBody };
    }
    const box = byId("chatBox");
    if (!box) return null;
    const reused = findAssistantLiveStream(box, threadId);
    if (reused) {
      state.activeThreadLiveAssistantThreadId = threadId;
      state.activeThreadLiveAssistantMsgNode = reused.msg;
      state.activeThreadLiveAssistantBodyNode = reused.body;
      let index = Number(state.activeThreadLiveAssistantIndex);
      const hasValidIndex =
        Array.isArray(state.activeThreadMessages) &&
        index >= 0 &&
        index < state.activeThreadMessages.length &&
        state.activeThreadMessages[index];
      if (!hasValidIndex) {
        if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
        const currentText = String(state.activeThreadLiveAssistantText || "");
        index = state.activeThreadMessages.findIndex(
          (message) =>
            message &&
            message.role === "assistant" &&
            !String(message.kind || "").trim() &&
            String(message.text || "") === currentText
        );
        if (index < 0) {
          index = state.activeThreadMessages.length;
          state.activeThreadMessages.push({
            role: "assistant",
            text: currentText,
            kind: "",
          });
        }
      }
      state.activeThreadLiveAssistantIndex = index;
      return reused;
    }
    hideWelcomeCard();
    const created = createAssistantStreamingMessage();
    const msg = created?.msg || null;
    const body = created?.body || null;
    if (!msg || !body) return null;
    try {
      msg.setAttribute?.("data-live-assistant", "1");
      msg.setAttribute?.("data-live-thread-id", threadId);
    } catch {}
    const pendingMount = box.querySelector?.("#pendingInlineMount") || null;
    if (pendingMount && pendingMount.parentElement === box) box.insertBefore(msg, pendingMount);
    else box.appendChild(msg);
    state.activeThreadLiveAssistantThreadId = threadId;
    state.activeThreadLiveAssistantIndex = Array.isArray(state.activeThreadMessages)
      ? state.activeThreadMessages.length
      : 0;
    state.activeThreadLiveAssistantMsgNode = msg;
    state.activeThreadLiveAssistantBodyNode = body;
    state.activeThreadLiveAssistantText = "";
    if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
    state.activeThreadMessages.push({ role: "assistant", text: "", kind: "" });
    return { msg, body };
  }

  function renderAssistantDelta(threadId, delta) {
    const text = String(delta || "");
    if (!text) {
      pushLiveDebugEvent("live.drop:empty_assistant_delta", { threadId: String(threadId || "") });
      return;
    }
    const live = ensureAssistantLiveStream(threadId);
    if (!live) {
      pushLiveDebugEvent("live.drop:no_live_assistant_stream", {
        threadId: String(threadId || ""),
        activeThreadId: String(state.activeThreadId || ""),
      });
      return;
    }
    state.activeThreadLiveAssistantText = `${String(state.activeThreadLiveAssistantText || "")}${text}`;
    if (typeof renderAssistantLiveBody === "function") {
      renderAssistantLiveBody(live.msg, live.body, state.activeThreadLiveAssistantText);
    } else {
      appendStreamingDelta(live.body, text);
    }
    const index = Number(state.activeThreadLiveAssistantIndex);
    if (
      Array.isArray(state.activeThreadMessages) &&
      index >= 0 &&
      index < state.activeThreadMessages.length &&
      state.activeThreadMessages[index]
    ) {
      state.activeThreadMessages[index] = {
        ...state.activeThreadMessages[index],
        role: "assistant",
        kind: "",
        text: state.activeThreadLiveAssistantText,
      };
    }
    syncPendingAssistantState(threadId, state.activeThreadLiveAssistantText);
    pushLiveDebugEvent("live.render:assistant_delta", {
      threadId: String(threadId || ""),
      chars: text.length,
      totalChars: String(state.activeThreadLiveAssistantText || "").length,
    });
    scheduleChatLiveFollow(700);
  }

  function syncLiveAssistantState(text) {
    state.activeThreadLiveAssistantText = String(text || "");
    const index = Number(state.activeThreadLiveAssistantIndex);
    if (
      Array.isArray(state.activeThreadMessages) &&
      index >= 0 &&
      index < state.activeThreadMessages.length &&
      state.activeThreadMessages[index]
    ) {
      state.activeThreadMessages[index] = {
        ...state.activeThreadMessages[index],
        role: "assistant",
        kind: "",
        text: state.activeThreadLiveAssistantText,
      };
    }
    syncPendingAssistantState(String(state.activeThreadLiveAssistantThreadId || ""), state.activeThreadLiveAssistantText);
  }

  function renderAssistantSnapshot(threadId, text, options = {}) {
    const nextText = String(text || "");
    if (!nextText) {
      pushLiveDebugEvent("live.drop:empty_assistant_snapshot", {
        threadId: String(threadId || ""),
        final: !!options.final,
      });
      return;
    }
    if (options.final === true && isRecentFinalAssistantDuplicate(threadId, nextText)) {
      pushLiveDebugEvent("live.skip:assistant_final_duplicate", {
        threadId: String(threadId || ""),
        final: true,
        chars: nextText.length,
      });
      return;
    }
    if (
      options.final === true &&
      !state.activeThreadLiveAssistantMsgNode &&
      Array.isArray(state.activeThreadMessages) &&
      state.activeThreadMessages.length > 0
    ) {
      const last = state.activeThreadMessages[state.activeThreadMessages.length - 1];
      if (
        last &&
        last.role === "assistant" &&
        !String(last.kind || "").trim() &&
        String(last.text || "") === nextText
      ) {
        pushLiveDebugEvent("live.skip:assistant_snapshot_duplicate", {
          threadId: String(threadId || ""),
          final: !!options.final,
        });
        rememberFinalAssistant(threadId, nextText);
        return;
      }
    }
    const live = ensureAssistantLiveStream(threadId);
    if (!live) {
      pushLiveDebugEvent("live.drop:no_live_assistant_snapshot_stream", {
        threadId: String(threadId || ""),
        final: !!options.final,
      });
      return;
    }
    const currentText = String(state.activeThreadLiveAssistantText || "");
    if (nextText !== currentText) {
      if (typeof renderAssistantLiveBody === "function") {
        renderAssistantLiveBody(live.msg, live.body, nextText);
      } else if (currentText && nextText.startsWith(currentText)) {
        appendStreamingDelta(live.body, nextText.slice(currentText.length));
      } else if (!currentText) {
        appendStreamingDelta(live.body, nextText);
      } else {
        finalizeAssistantMessage(live.msg, live.body, nextText);
      }
      syncLiveAssistantState(nextText);
    }
    if (options.final === true) {
      pushLiveDebugEvent("live.render:assistant_snapshot_final", {
        threadId: String(threadId || ""),
        chars: nextText.length,
      });
      finishPendingTurnRun(threadId);
      resetPendingTurnRuntime({ reason: "live.assistant_snapshot:final" });
      finalizeAssistantLive(threadId);
      if (
        (!Array.isArray(state.activeThreadActiveCommands) || state.activeThreadActiveCommands.length === 0) &&
        !state.activeThreadPlan
      ) {
        setStatus("Turn completed.", false);
      }
      return;
    }
    pushLiveDebugEvent("live.render:assistant_snapshot", {
      threadId: String(threadId || ""),
      chars: nextText.length,
    });
    scheduleChatLiveFollow(700);
  }

  function finalizeAssistantLive(threadId) {
    if (!threadId || String(state.activeThreadLiveAssistantThreadId || "") !== threadId) {
      pushLiveDebugEvent("live.skip:finalize_assistant_mismatch", {
        threadId: String(threadId || ""),
        liveThreadId: String(state.activeThreadLiveAssistantThreadId || ""),
      });
      return;
    }
    const msg = state.activeThreadLiveAssistantMsgNode;
    const body = state.activeThreadLiveAssistantBodyNode;
    const text = String(state.activeThreadLiveAssistantText || "");
    finalizeCommentaryArchive(msg || null);
    if (msg && body) finalizeAssistantMessage(msg, body, text);
    rememberFinalAssistant(threadId, text);
    clearActiveAssistantLiveState();
    pushLiveDebugEvent("live.render:assistant_finalize", {
      threadId: String(threadId || ""),
      chars: text.length,
    });
    clearTransientToolMessages();
    clearTransientThinkingMessages();
    scheduleChatLiveFollow(800);
  }

  function discardAssistantLive(threadId) {
    if (!threadId || String(state.activeThreadLiveAssistantThreadId || "") !== threadId) {
      pushLiveDebugEvent("live.skip:discard_assistant_mismatch", {
        threadId: String(threadId || ""),
        liveThreadId: String(state.activeThreadLiveAssistantThreadId || ""),
      });
      return;
    }
    const msg = state.activeThreadLiveAssistantMsgNode;
    const index = Number(state.activeThreadLiveAssistantIndex);
    if (
      Array.isArray(state.activeThreadMessages) &&
      index >= 0 &&
      index < state.activeThreadMessages.length
    ) {
      state.activeThreadMessages.splice(index, 1);
    }
    msg?.remove?.();
    clearActiveAssistantLiveState();
    pushLiveDebugEvent("live.render:assistant_discard", {
      threadId: String(threadId || ""),
    });
  }

  function appendPlanCardMessage(threadId, planMessage) {
    if (!planMessage?.plan) return false;
    const signature = String(planMessage.text || "").trim();
    const last = Array.isArray(state.activeThreadMessages) && state.activeThreadMessages.length
      ? state.activeThreadMessages[state.activeThreadMessages.length - 1]
      : null;
    if (
      last &&
      last.role === "system" &&
      String(last.kind || "").trim() === "planCard" &&
      String(last.text || "").trim() === signature
    ) {
      return false;
    }
    addChat("system", signature, {
      kind: "planCard",
      plan: planMessage.plan,
      source: "liveProposedPlan",
    });
    if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
    state.activeThreadMessages.push({
      role: "system",
      kind: "planCard",
      text: signature,
      plan: planMessage.plan,
    });
    return true;
  }

  function collapseLiveRuntimeBeforeVisibleAssistant(threadId, anchorNode = null) {
    finalizeCommentaryArchive(anchorNode);
    clearTransientToolMessages();
    clearTransientThinkingMessages();
    finalizeRuntimeState(threadId);
  }

  function renderLiveNotification(notification) {
    const record = toRecord(notification);
    const method = normalizeLiveMethod(record?.method);
    if (!method) {
      pushLiveDebugEvent("live.drop:no_method", {});
      return;
    }
    const threadId = extractNotificationThreadId(record);
    const candidate = extractNotificationCandidate(record);
    const params = candidate.params;
    const toolItem = candidate.item;
    const assistantUpdate = toolItem
      ? readAssistantContentText(toolItem, {
          normalizeType,
          normalizeMultiline,
        })
      : null;
    pushLiveDebugEvent("live.notification", {
      method,
      threadId: String(threadId || ""),
      activeThreadId: String(state.activeThreadId || ""),
    });
    const interruptSuppressed =
      !!threadId &&
      state.suppressedLiveInterruptByThreadId &&
      state.suppressedLiveInterruptByThreadId[threadId] === true;
    const terminalMethod =
      method.includes("turn/completed") ||
      method.includes("turn/finished") ||
      method.includes("turn/failed") ||
      method.includes("turn/cancelled");
    if (
      toolItem ||
      method.includes("codex/event/") ||
      method.includes("item/") ||
      method.includes("item.") ||
      method.includes("agent_message") ||
      method.includes("response_item")
    ) {
      if (toolItem) {
        pushLiveDebugEvent("live.inspect:item_candidate", {
          method,
          threadId: String(threadId || ""),
          activeThreadId: String(state.activeThreadId || ""),
          paramsSource: candidate.paramsSource,
          itemSource: candidate.itemSource,
          itemType: String(toolItem?.type || ""),
          itemId: String(
            toolItem?.id ||
            toolItem?.itemId ||
            toolItem?.item_id ||
            toolItem?.message_id ||
            toolItem?.messageId ||
            ""
          ),
          phase: String(toolItem?.phase || ""),
          paramsKeys: summarizeRecordKeys(params),
          itemKeys: summarizeRecordKeys(toolItem),
          preview: summarizePreview(toolItem?.message ?? toolItem?.text ?? toolItem?.delta ?? toolItem?.content, 120),
        });
      } else {
        pushLiveDebugEvent("live.inspect:no_item_candidate", {
          method,
          threadId: String(threadId || ""),
          activeThreadId: String(state.activeThreadId || ""),
          paramsSource: candidate.paramsSource,
          paramsKeys: summarizeRecordKeys(params),
          preview: summarizePreview(params, 120),
        });
      }
    }
    if (assistantUpdate?.text) {
      pushLiveDebugEvent("live.inspect:assistant_candidate", {
        method,
        threadId: String(threadId || ""),
        activeThreadId: String(state.activeThreadId || ""),
        paramsSource: candidate.paramsSource,
        itemSource: candidate.itemSource,
        itemType: String(toolItem?.type || ""),
        itemId: String(assistantUpdate.itemId || ""),
        mode: assistantUpdate.mode,
        phase: String(assistantUpdate.phase || ""),
        visible: isVisibleAssistantPhase(assistantUpdate.phase),
        chars: assistantUpdate.text.length,
        preview: summarizePreview(assistantUpdate.text, 120),
      });
    }
    const status =
      normalizeLiveStatusValue(params?.status, {
        normalizeType,
        toRecord,
      }) ||
      normalizeLiveStatusValue(params?.turn?.status, {
        normalizeType,
        toRecord,
      }) ||
      normalizeLiveStatusValue(params?.thread?.status, {
        normalizeType,
        toRecord,
      });
    const statusMessage = extractLiveStatusMessage(params, {
      normalizeInline,
      toRecord,
    });
    const notificationTurnId = String(
      params?.turnId || params?.turn_id || params?.turn?.id || params?.id || ""
    ).trim();
    const connectionStatusMethod =
      method.includes("thread/status/changed") ||
      method === "thread/status" ||
      method === "turn/status";
    const connectionStatusValue = status || statusMessage;
    const terminalFailureStatus = isFailedLiveStatus(connectionStatusValue);
    const terminalFailureMethod =
      method.includes("error") ||
      method.includes("turn/failed") ||
      (method.includes("turn/completed") && terminalFailureStatus);
    const terminalConnectionErrorThreadId = String(state.activeThreadTerminalConnectionErrorThreadId || "").trim();
    const latchedConnectionError =
      terminalConnectionErrorThreadId === threadId ||
      (
        String(state.activeThreadConnectionStatusKind || "").trim() === "error" &&
        !!String(state.activeThreadConnectionStatusText || "").trim()
      );
    const weakTerminalConnectionEcho =
      latchedConnectionError &&
      (
        method === "error" ||
        (
          (method.includes("turn/completed") || method.includes("turn/finished")) &&
          !terminalFailureStatus &&
          !String(statusMessage || "").trim()
        ) ||
        (
          connectionStatusMethod &&
          !terminalFailureStatus &&
          !isReconnectLiveStatus(connectionStatusValue) &&
          (
            !String(status || "").trim() ||
            String(status || "").trim() === "completed"
          ) &&
          !String(statusMessage || "").trim()
        )
      );
    const suppressReplayedConnectionStatus =
      connectionStatusMethod &&
      (isReconnectLiveStatus(connectionStatusValue) || isFailedLiveStatus(connectionStatusValue)) &&
      state.wsSubscribedEvents !== true;
    const historyStatusType = String(state.activeThreadHistoryStatusType || "").trim().toLowerCase();
    const suppressDeferredTerminalFailureStatus =
      isFailedLiveStatus(connectionStatusValue) &&
      shouldDeferTerminalConnectionFailure(String(threadId || "").trim());
    const activeThreadStarted = state.activeThreadStarted === true;
    const hasTrackedRuntimeContext =
      (String(state.activeThreadPendingTurnThreadId || "").trim() === threadId) ||
      (String(state.activeThreadLiveAssistantThreadId || "").trim() === threadId) ||
      (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === threadId) ||
      (String(state.activeThreadPlan?.threadId || "").trim() === threadId) ||
      (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0);
    const suppressDormantReplayedTurnLifecycle =
      state.wsSubscribedEvents !== true &&
      !!historyStatusType &&
      !/active|running|queued|pending|inprogress/.test(historyStatusType) &&
      !hasTrackedRuntimeContext &&
      (method.includes("turn/started") || terminalMethod);
    const hasLivePendingContext =
      String(state.activeThreadPendingTurnThreadId || "").trim() === threadId &&
      (
        state.activeThreadPendingTurnRunning === true ||
        !!String(state.activeThreadPendingTurnId || "").trim() ||
        !!String(state.activeThreadPendingUserMessage || "").trim() ||
        !!String(state.activeThreadPendingAssistantMessage || "").trim()
      );
    const pendingTurnId = String(state.activeThreadPendingTurnId || "").trim();
    const stalePendingTurnTerminalReplay =
      String(state.activeThreadPendingTurnThreadId || "").trim() === threadId &&
      !!pendingTurnId &&
      !!notificationTurnId &&
      notificationTurnId !== pendingTurnId &&
      (
        terminalMethod ||
        (connectionStatusMethod && isFailedLiveStatus(connectionStatusValue))
      );
    const hasLiveConnectionProgressContext =
      String(state.activeThreadConnectionStatusKind || "").trim() === "reconnecting" ||
      hasLivePendingContext;
    const hasAuthoritativeHistoryContext =
      (
        String(state.activeThreadHistoryThreadId || "").trim() === threadId ||
        String(state.activeThreadId || "").trim() === threadId
      ) &&
      (
        (Array.isArray(state.activeThreadHistoryTurns) && state.activeThreadHistoryTurns.length > 0) ||
        (Array.isArray(state.activeThreadMessages) && state.activeThreadMessages.length > 0) ||
        isTerminalHistoryStatusValue(historyStatusType)
      );
    const historyOnlyReopenContext =
      String(state.activeThreadOpenState?.threadId || "").trim() === threadId &&
      state.activeThreadOpenState?.resumeRequired !== true &&
      !hasTrackedRuntimeContext &&
      !hasLivePendingContext &&
      hasAuthoritativeHistoryContext;
    const currentConnectionReplayGuardMatchesThread =
      String(state.activeThreadConnectionReplayGuardThreadId || "").trim() === threadId &&
      Math.max(0, Number(state.activeThreadConnectionReplayGuardEpoch || 0)) ===
        Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
    const hasCurrentCycleReconnectReplayContext =
      currentConnectionReplayGuardMatchesThread &&
      state.activeThreadConnectionReplayGuardReconnectSeen === true &&
      activeThreadStarted;
    const suppressDormantTerminalConnectionReplay =
      connectionStatusMethod &&
      isFailedLiveStatus(connectionStatusValue) &&
      !hasCurrentCycleReconnectReplayContext &&
      !hasLiveConnectionProgressContext &&
      hasAuthoritativeHistoryContext &&
      (isTerminalHistoryStatusValue(historyStatusType) || historyOnlyReopenContext);
    const suppressDormantReconnectReplay =
      connectionStatusMethod &&
      isReconnectLiveStatus(connectionStatusValue) &&
      !hasLivePendingContext &&
      hasAuthoritativeHistoryContext &&
      (isTerminalHistoryStatusValue(historyStatusType) || historyOnlyReopenContext);
    const suppressDormantTerminalTurnFailureReplay =
      terminalMethod &&
      terminalFailureStatus &&
      !hasCurrentCycleReconnectReplayContext &&
      String(state.activeThreadConnectionStatusKind || "").trim().toLowerCase() !== "reconnecting" &&
      !hasLiveConnectionProgressContext &&
      hasAuthoritativeHistoryContext &&
      (isTerminalHistoryStatusValue(historyStatusType) || historyOnlyReopenContext);
    const keepLatchedDormantTerminalConnectionError =
      suppressDormantTerminalConnectionReplay &&
      String(state.activeThreadConnectionStatusKind || "").trim() === "error" &&
      String(state.activeThreadTerminalConnectionErrorThreadId || "").trim() === threadId;
    const clearDormantTerminalConnectionReplay =
      suppressDormantTerminalConnectionReplay &&
      !keepLatchedDormantTerminalConnectionError;
    const suppressDormantBareErrorReplay =
      method === "error" &&
      !hasLiveConnectionProgressContext &&
      hasAuthoritativeHistoryContext;
    const clearDormantBareErrorReplay =
      suppressDormantBareErrorReplay;
    const hydratingActiveThreadConnectionReplay =
      String(state.activeThreadId || "").trim() === threadId &&
      !String(state.activeThreadConnectionStatusKind || "").trim() &&
      !hasAuthoritativeHistoryContext &&
      !hasLiveConnectionProgressContext &&
      (
        (connectionStatusMethod && isFailedLiveStatus(connectionStatusValue)) ||
        (terminalMethod && terminalFailureStatus) ||
        method === "error"
      );
    const suppressHydratingThreadConnectionReplay =
      hydratingActiveThreadConnectionReplay ||
      (
        String(state.activeThreadOpenState?.threadId || "").trim() === threadId &&
        state.activeThreadOpenState?.loaded !== true &&
        !hasLiveConnectionProgressContext &&
        (
          (connectionStatusMethod && isFailedLiveStatus(connectionStatusValue)) ||
          (terminalMethod && terminalFailureStatus) ||
          method === "error"
        )
      );
    const suppressPendingConnectionTerminalReplay = shouldSuppressPendingConnectionTerminalReplay({
      threadId,
      method,
      status,
      statusMessage,
      terminalFailureStatus,
    });
    const suppressReconnectAfterTerminalError =
      latchedConnectionError &&
      connectionStatusMethod &&
      isReconnectLiveStatus(connectionStatusValue);
    if (!threadId || threadId === state.activeThreadId) {
      if (stalePendingTurnTerminalReplay) {
        pushLiveDebugEvent("live.drop:stale_pending_turn_terminal_replay", {
          method,
          threadId: String(threadId || ""),
          pendingTurnId,
          notificationTurnId,
          status: String(status || ""),
          statusMessage: String(statusMessage || "").slice(0, 180),
        });
        return;
      }
      if (interruptSuppressed && !terminalMethod && !method.includes("turn/started")) {
        pushLiveDebugEvent("live.status:suppress_after_interrupt", {
          method,
          threadId: String(threadId || ""),
          activeThreadId: String(state.activeThreadId || ""),
        });
      } else {
        const nextStatus = deriveLiveStatusFromNotification(record, {
          normalizeType,
          normalizeInline,
          toRecord,
        });
        const suppressTerminalConnectionErrorEcho =
          method === "error" &&
          String(state.activeThreadConnectionStatusKind || "").trim() === "error" &&
          (isReconnectLiveStatus(nextStatus?.message) || isFailedLiveStatus(nextStatus?.message));
        const suppressLatchedConnectionTerminalEcho =
          weakTerminalConnectionEcho &&
          (
            !nextStatus?.message ||
            nextStatus.message === "Turn completed."
          );
        const suppressLatchedConnectionFailureOverride =
          latchedConnectionError &&
          terminalMethod &&
          terminalFailureStatus &&
          !connectionStatusMethod &&
          !!String(nextStatus?.message || "").trim();
        const suppressLatchedConnectionStatusEcho =
          latchedConnectionError &&
          connectionStatusMethod &&
          terminalFailureStatus &&
          !!String(statusMessage || "").trim() &&
          String(statusMessage || "").trim() === String(state.activeThreadConnectionStatusText || "").trim();
        if (suppressTerminalConnectionErrorEcho) {
          pushLiveDebugEvent("live.status:suppress_terminal_connection_error_echo", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            message: String(nextStatus?.message || "").slice(0, 180),
          });
        }
        if (suppressLatchedConnectionTerminalEcho) {
          pushLiveDebugEvent("live.status:suppress_latched_connection_terminal_echo", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            message: String(nextStatus?.message || "").slice(0, 180),
          });
        }
        if (suppressLatchedConnectionFailureOverride) {
          pushLiveDebugEvent("live.status:suppress_latched_connection_failure_override", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            message: String(nextStatus?.message || "").slice(0, 180),
          });
        }
        if (suppressLatchedConnectionStatusEcho) {
          pushLiveDebugEvent("live.status:suppress_latched_connection_status_echo", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            message: String(statusMessage || "").slice(0, 180),
          });
        }
        if (suppressPendingConnectionTerminalReplay) {
          pushLiveDebugEvent("live.status:suppress_pending_connection_terminal_replay", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            message: String(statusMessage || "").slice(0, 180),
            guardText: String(state.activeThreadConnectionReplayGuardText || "").slice(0, 180),
          });
        }
        if (
          nextStatus?.message &&
          !suppressReplayedConnectionStatus &&
          !suppressDormantReconnectReplay &&
          !suppressDormantReplayedTurnLifecycle &&
          !suppressDormantTerminalConnectionReplay &&
          !suppressDormantTerminalTurnFailureReplay &&
          !suppressDormantBareErrorReplay &&
          !suppressHydratingThreadConnectionReplay &&
          !suppressPendingConnectionTerminalReplay &&
          !suppressReconnectAfterTerminalError &&
          !suppressDeferredTerminalFailureStatus &&
          !suppressTerminalConnectionErrorEcho &&
          !suppressLatchedConnectionTerminalEcho &&
          !suppressLatchedConnectionFailureOverride &&
          !suppressLatchedConnectionStatusEcho
        ) {
          pushLiveDebugEvent("live.status", {
            method,
            threadId: String(threadId || ""),
            activeThreadId: String(state.activeThreadId || ""),
            rawStatus: String(params?.status || params?.turn?.status || params?.thread?.status || "").slice(0, 180),
            rawMessage: String(params?.message || params?.turn?.message || params?.thread?.message || params?.code || "").slice(0, 180),
            message: String(nextStatus.message || "").slice(0, 180),
            isWarn: nextStatus.isWarn === true,
          });
          setStatus(nextStatus.message, nextStatus.isWarn === true);
        }
      }
    }
    if (!threadId) {
      pushLiveDebugEvent("live.drop:missing_thread_id", {
        method,
        activeThreadId: String(state.activeThreadId || ""),
      });
      return;
    }
    if (threadId !== state.activeThreadId) {
      pushLiveDebugEvent("live.drop:thread_mismatch", {
        method,
        threadId: String(threadId || ""),
        activeThreadId: String(state.activeThreadId || ""),
      });
      return;
    }

    if (suppressReplayedConnectionStatus) {
      pushLiveDebugEvent("live.drop:replayed_connection_status", {
        method,
        threadId: String(threadId || ""),
      });
      return;
    }
    if (suppressDormantReconnectReplay) {
      pushLiveDebugEvent("live.drop:dormant_reconnect_replay", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      clearLiveThreadConnectionStatus("drop:dormant_reconnect_replay");
      return;
    }
    if (suppressDormantReplayedTurnLifecycle) {
      pushLiveDebugEvent("live.drop:dormant_replayed_turn_lifecycle", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      return;
    }
    if (suppressDormantTerminalConnectionReplay) {
      pushLiveDebugEvent("live.drop:dormant_terminal_connection_replay", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      if (clearDormantTerminalConnectionReplay) {
        clearLiveThreadConnectionStatus("drop:dormant_terminal_connection_replay");
      }
      return;
    }
    if (suppressDormantTerminalTurnFailureReplay) {
      pushLiveDebugEvent("live.drop:dormant_terminal_turn_failure_replay", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      return;
    }
    if (suppressDormantBareErrorReplay) {
      pushLiveDebugEvent("live.drop:dormant_bare_error_replay", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      if (clearDormantBareErrorReplay) {
        clearLiveThreadConnectionStatus("drop:dormant_bare_error_replay");
      }
      return;
    }
    if (suppressHydratingThreadConnectionReplay) {
      pushLiveDebugEvent("live.drop:hydrating_thread_connection_replay", {
        method,
        threadId: String(threadId || ""),
        historyStatusType,
      });
      clearLiveThreadConnectionStatus("drop:hydrating_thread_connection_replay");
      return;
    }
    if (suppressPendingConnectionTerminalReplay) {
      pushLiveDebugEvent("live.drop:pending_connection_terminal_replay", {
        method,
        threadId: String(threadId || ""),
        status: String(status || ""),
        statusMessage: String(statusMessage || "").slice(0, 180),
      });
      return;
    }
    if (weakTerminalConnectionEcho) {
      pushLiveDebugEvent("live.drop:latched_connection_terminal_echo", {
        method,
        threadId: String(threadId || ""),
        status: String(status || ""),
        statusMessage: String(statusMessage || "").slice(0, 180),
      });
      return;
    }

    const emptyConnectionStatusMethod =
      connectionStatusMethod &&
      !String(status || "").trim() &&
      !String(statusMessage || "").trim();
    const keepReconnectStatusDuringActiveTurn = shouldKeepReconnectStatusDuringActiveTurn(
      threadId,
      method,
      status,
      statusMessage
    );
    const keepTerminalConnectionErrorLatched =
      String(state.activeThreadConnectionStatusKind || "").trim() === "error" &&
      String(state.activeThreadTerminalConnectionErrorThreadId || "").trim() === String(threadId || "").trim();
    if (
      !emptyConnectionStatusMethod &&
      !keepTerminalConnectionErrorLatched &&
      !keepReconnectStatusDuringActiveTurn &&
      !terminalFailureMethod &&
      (!connectionStatusMethod ||
        (!isReconnectLiveStatus(connectionStatusValue) && !isFailedLiveStatus(connectionStatusValue)))
    ) {
      if (String(state.activeThreadConnectionStatusKind || "").trim()) {
        pushLiveDebugEvent("live.connection:thread_clear_reason", {
          threadId: String(threadId || ""),
          method,
          rawStatus: String(params?.status || params?.turn?.status || params?.thread?.status || "").slice(0, 180),
          rawMessage: String(params?.message || params?.turn?.message || params?.thread?.message || params?.code || "").slice(0, 180),
          status: String(status || ""),
          statusMessage: String(statusMessage || "").slice(0, 180),
          connectionStatusMethod,
          keepReconnectStatusDuringActiveTurn,
          keepTerminalConnectionErrorLatched,
        });
      }
      clearLiveThreadConnectionStatus("notification:non_connection_status");
    }

    if (interruptSuppressed && !terminalMethod && !method.includes("turn/started")) {
      pushLiveDebugEvent("live.drop:suppress_after_interrupt", {
        method,
        threadId: String(threadId || ""),
      });
      return;
    }

    if (method.includes("turn/started")) {
      if (
        state.suppressedLiveInterruptByThreadId &&
        state.suppressedLiveInterruptByThreadId[threadId] === true
      ) {
        delete state.suppressedLiveInterruptByThreadId[threadId];
      }
      clearProposedPlanConfirmation(state, threadId);
      suppressSyntheticPendingUserInputs(threadId, false);
      setSyntheticPendingUserInputs(threadId, []);
      syncPendingTurnRuntime(threadId, {
        turnId: params?.turnId || params?.turn_id || params?.turn?.id || params?.id || "",
        running: true,
        assistantMessage: "",
        baselineTurnCount: activeThreadHistoryTurnCount(threadId),
      });
      resetTurnPresentationState({ bumpLiveEpoch: true });
      ensureCommentaryState();
      pushCommentaryStateDebug("reset", {
        threadId: String(threadId || ""),
        key: "",
        text: "",
        tools: [],
      });
      renderCommentaryArchive();
    }

    if (method.includes("turn/assistant/delta")) {
      renderAssistantDelta(threadId, params?.delta);
      return;
    }
    if (assistantUpdate?.text) {
      if (!isVisibleAssistantPhase(assistantUpdate.phase)) {
        const nextThinkingText = updateCurrentCommentaryText(threadId, toolItem, assistantUpdate);
        showTransientThinkingMessage(nextThinkingText);
        setRuntimeActivity({
          threadId,
          title: String(nextThinkingText || "").trim() ? "Thinking" : "Working",
          detail: String(nextThinkingText || "").trim(),
          tone: "running",
        });
        pushLiveDebugEvent("live.match:commentary_update", {
          method,
          threadId: String(threadId || ""),
          mode: assistantUpdate.mode,
          chars: nextThinkingText.length,
        });
        scheduleChatLiveFollow(700);
        return;
      }
      collapseLiveRuntimeBeforeVisibleAssistant(
        threadId,
        state.activeThreadLiveAssistantMsgNode || null
      );
      const proposedPlan = extractProposedPlanArtifacts(assistantUpdate.text, {
        threadId,
        itemId: assistantUpdate.itemId,
      });
      const toolStatus = normalizeType(toolItem?.status);
      const isFinalAssistantUpdate =
        assistantUpdate.mode === "snapshot" &&
        (method.includes("completed") ||
          method.includes("finished") ||
          (!isRunningLiveStatus(toolStatus) && toolStatus !== "updating"));
      const nextAssistantText = proposedPlan.plan
        ? proposedPlan.cleanedText
        : assistantUpdate.text;
      pushLiveDebugEvent("live.match:assistant_update", {
        method,
        threadId: String(threadId || ""),
        mode: assistantUpdate.mode,
        final: isFinalAssistantUpdate,
      });
      pushLiveDebugEvent("live.inspect:proposed_plan_detection", {
        source: "live",
        method,
        threadId: String(threadId || ""),
        itemId: String(assistantUpdate.itemId || ""),
        phase: String(assistantUpdate.phase || ""),
        final: isFinalAssistantUpdate,
        hasPlan: !!proposedPlan.planMessage?.plan,
        hasPendingUserInput: !!proposedPlan.pendingConfirmation,
        rawPreview: summarizePreview(assistantUpdate.text, 220),
        cleanedPreview: summarizePreview(proposedPlan.cleanedText, 220),
      });
      if (!nextAssistantText && proposedPlan.planMessage?.plan && isFinalAssistantUpdate) {
        const liveMsgNode = state.activeThreadLiveAssistantMsgNode;
        liveMsgNode?.remove?.();
        clearActiveAssistantLiveState();
        finishPendingTurnRun(threadId);
        resetPendingTurnRuntime({ reason: "live.assistant_update:plan_only_final" });
      } else {
        renderAssistantSnapshot(threadId, nextAssistantText, { final: isFinalAssistantUpdate });
      }
      if (proposedPlan.planMessage?.plan && isFinalAssistantUpdate) {
        appendPlanCardMessage(threadId, proposedPlan.planMessage);
      }
      if (proposedPlan.pendingConfirmation && isFinalAssistantUpdate) {
        setProposedPlanConfirmation(state, threadId, proposedPlan.pendingConfirmation);
        renderPendingInline();
      }
      return;
    }
    if (method.includes("turn/plan/updated")) {
      const payload = { ...(params || {}), threadId };
      applyPlanSnapshotUpdate(payload);
      recordCommentaryPlan({
        threadId,
        turnId: String(payload.turnId || payload.turn_id || ""),
        title: "Updated Plan",
        explanation: String(payload.explanation || "").trim(),
        steps: Array.isArray(payload.plan) ? payload.plan : [],
        deltaText: "",
      });
      clearTransientToolMessages();
      scheduleChatLiveFollow(900);
      return;
    }
    if (method.includes("item/plan/delta")) {
      const payload = { ...(params || {}), threadId };
      applyPlanDeltaUpdate(payload);
      recordCommentaryPlan({
        threadId,
        turnId: String(payload.turnId || payload.turn_id || ""),
        title: "Updated Plan",
        explanation: "",
        steps: [],
        deltaText: String(payload.delta || "").trim(),
      });
      clearTransientToolMessages();
      scheduleChatLiveFollow(900);
      return;
    }
    if (toolItem) {
      const planUpdate = extractPlanUpdate(toolItem, {
        threadId,
        normalizeType,
      });
      applyToolItemRuntimeUpdate(toolItem, { threadId, method, timestamp: Date.now() });
      if (planUpdate) {
        recordCommentaryPlan(planUpdate);
        clearTransientToolMessages();
        scheduleChatLiveFollow(900);
        return;
      }
      const toolLike = toToolLikeMessage(toolItem);
      if (toolLike) {
        recordCommentaryTool(toolItem, toolLike);
        if (
          !state.activeThreadCommentaryCurrent &&
          !(Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0) &&
          !state.activeThreadPlan
        ) {
          showTransientToolMessage(toolLike);
        } else {
          clearTransientToolMessages();
        }
        pushLiveDebugEvent("live.render:tool_message", {
          method,
          threadId: String(threadId || ""),
          itemType: String(toolItem?.type || ""),
        });
        scheduleChatLiveFollow(900);
        return;
      }
    }

    const reconnectingStatus = connectionStatusMethod && isReconnectLiveStatus(status || statusMessage);
    if (reconnectingStatus) {
      if (suppressReconnectAfterTerminalError) {
        pushLiveDebugEvent("live.connection:suppress_reconnect_after_terminal_error", {
          threadId: String(threadId || ""),
          method,
          status: String(status || ""),
          statusMessage: String(statusMessage || "").slice(0, 180),
        });
        return;
      }
      if (suppressReplayedConnectionStatus) return;
      setPendingTurnRunning(threadId, true, { reason: "live.thread_status:reconnecting" });
      showLiveThreadReconnectStatus(statusMessage || "Connection interrupted.", {
        threadId,
        method,
        status,
      });
      return;
    }
    const failedConnectionStatus = connectionStatusMethod && isFailedLiveStatus(status || statusMessage);
    if (failedConnectionStatus) {
      if (suppressReplayedConnectionStatus) return;
      if (shouldDeferTerminalConnectionFailure(threadId)) {
        rememberDeferredTerminalConnectionFailure(threadId, statusMessage, { method, status });
        return;
      }
      const previousConnectionError =
        String(state.activeThreadConnectionStatusKind || "") === "error"
          ? String(state.activeThreadConnectionStatusText || "").trim()
          : "";
      const connectionErrorMessage = statusMessage || previousConnectionError;
      const hadPendingAssistant = !!String(state.activeThreadPendingAssistantMessage || "").trim();
      if (String(state.activeThreadLiveAssistantThreadId || "") === String(threadId || "").trim()) {
        discardAssistantLive(threadId);
      }
      clearProposedPlanConfirmation(state, threadId);
      syncPendingAssistantState(threadId, "");
      settlePendingTurnFailure(threadId, "live.thread_status:failed", {
        allowUserFallback: !hadPendingAssistant,
      });
      clearTransientToolMessages();
      clearTransientThinkingMessages();
      finalizeRuntimeState(threadId);
      renderPendingInline();
      if (connectionErrorMessage) {
        showLiveThreadReconnectError(connectionErrorMessage, {
          threadId,
          method,
          status,
        });
        setStatus(connectionErrorMessage, true);
      } else {
        pushLiveDebugEvent("live.connection:thread_skip_empty_error", {
          threadId: String(threadId || ""),
          method,
          status: String(status || ""),
        });
        setStatus("", false);
      }
      return;
    }
    const isRunning = /running|inprogress|working|queued/.test(status || "") || method.includes("turn/started");
    if (isRunning) {
      setPendingTurnRunning(threadId, true, { reason: "live.status:running" });
      setRuntimeActivity({ threadId, title: "Thinking", detail: "", tone: "running" });
      return;
    }
    if (terminalMethod) {
      pushLiveDebugEvent("live.render:turn_terminal", {
        method,
        threadId: String(threadId || ""),
      });
      const turnCancelled = method.includes("turn/cancelled");
      const turnFailed =
        method.includes("turn/failed") ||
        (method.includes("turn/completed") && terminalFailureStatus);
      if (
        state.suppressedLiveInterruptByThreadId &&
        state.suppressedLiveInterruptByThreadId[threadId] === true
      ) {
        delete state.suppressedLiveInterruptByThreadId[threadId];
      }
      if (turnFailed || turnCancelled) {
        if (turnFailed && shouldDeferTerminalConnectionFailure(threadId)) {
          rememberDeferredTerminalConnectionFailure(threadId, statusMessage, { method, status });
          return;
        }
        if (String(state.activeThreadLiveAssistantThreadId || "") === String(threadId || "").trim()) {
          discardAssistantLive(threadId);
        }
        const hadPendingAssistant = !!String(state.activeThreadPendingAssistantMessage || "").trim();
        if (turnCancelled) {
          resetTurnPresentationState({ bumpLiveEpoch: true });
        }
        clearProposedPlanConfirmation(state, threadId);
        clearPendingUserInputs({ threadId });
        suppressSyntheticPendingUserInputs(threadId, true);
        setSyntheticPendingUserInputs(threadId, []);
        if (turnCancelled) {
          resetPendingTurnRuntime({
            reason: "live.turn_terminal:cancelled",
          });
        } else {
          syncPendingAssistantState(threadId, "");
          settlePendingTurnFailure(threadId, "live.turn_terminal:failed", {
            allowUserFallback: !hadPendingAssistant,
          });
        }
      }
      if (turnCancelled || !(turnFailed || turnCancelled)) finishPendingTurnRun(threadId);
      if (
        state.activeThreadCommentaryCurrent &&
        !String(state.activeThreadLiveAssistantThreadId || "").trim()
      ) {
        finalizeCommentaryArchive(null);
      }
      if (!(turnCancelled || turnFailed)) {
        finalizeAssistantLive(threadId);
      }
      const finalizedAssistantThreadId = String(state.activeThreadLastFinalAssistantThreadId || "").trim();
      if (turnFailed || method.includes("turn/cancelled")) {
        syncPendingAssistantState(threadId, "");
      } else if (finalizedAssistantThreadId === String(threadId || "").trim()) {
        syncPendingAssistantState(threadId, String(state.activeThreadLastFinalAssistantText || ""));
      }
      clearTransientToolMessages();
      clearTransientThinkingMessages();
      finalizeRuntimeState(threadId);
      if (turnCancelled || turnFailed) {
        const terminalErrorMessage = String(
          statusMessage ||
          state.activeThreadConnectionStatusText ||
          ""
        ).trim();
        if (
          turnFailed &&
          terminalErrorMessage &&
          String(state.activeThreadConnectionStatusKind || "").trim() !== "error"
        ) {
          showLiveThreadReconnectError(terminalErrorMessage, {
            threadId,
            method,
            status,
          });
          setStatus(terminalErrorMessage, true);
        }
        renderCommentaryArchive();
        renderPendingInline();
        return;
      }
      void flushQueuedTurn(threadId);
    }
  }

  return {
    clearLiveThreadConnectionStatus,
    clearTransientThinkingMessages,
    clearTransientToolMessages,
    deriveLiveStatusFromNotification,
    deriveLiveStatusFromToolItem,
    isFailedLiveStatus,
    isRunningLiveStatus,
    normalizeLiveMethod,
    notificationToToolItem,
    renderLiveNotification,
    showTransientThinkingMessage,
    showTransientToolMessage,
    toToolLikeMessage,
    workspaceKeyOfThread,
  };
}
