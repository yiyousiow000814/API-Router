import { toolItemToMessage } from "./messageData.js";

export function workspaceKeyOfThread(thread) {
  const raw = thread.cwd || thread.workspace || thread.project || thread.directory || thread.path || "";
  const text = String(raw || "").trim();
  if (!text) return "Default folder";
  const normalized = text
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "Default folder";
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

export function normalizeLiveMethod(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const aliases = {
    task_started: "turn/started",
    turn_started: "turn/started",
    task_complete: "turn/completed",
    turn_complete: "turn/completed",
    task_aborted: "turn/cancelled",
    turn_aborted: "turn/cancelled",
    item_started: "item/started",
    item_completed: "item/completed",
    thread_name_updated: "thread/name/updated",
    thread_status_changed: "thread/status/changed",
  };
  return aliases[raw] || raw.replace(/\./g, "/");
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
    return { message: query ? `Searching web: ${query}` : "Searching web...", isWarn: false };
  }

  if (itemType === "filechange") {
    const status = normalizeType(item?.status);
    const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    if (isFailedLiveStatus(status)) return { message: "File changes failed.", isWarn: true };
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
    normalizeType(params?.status) || normalizeType(params?.turn?.status) || normalizeType(params?.thread?.status);
  const message =
    normalizeInline(params?.message, 180) ||
    normalizeInline(params?.turn?.message, 180) ||
    normalizeInline(params?.thread?.message, 180) ||
    normalizeInline(params?.code, 180) ||
    "";

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

function isVisibleAssistantPhase(value) {
  const phase = String(value || "").trim().toLowerCase();
  if (!phase) return true;
  return phase === "final_answer";
}

function readAssistantContentText(item, helpers) {
  const { normalizeType, normalizeMultiline } = helpers;
  const itemType = String(item?.type || "").trim();
  if (!itemType) return null;
  if (!isVisibleAssistantPhase(item?.phase)) return null;

  if (
    matchesNormalizedType(
      itemType,
      ["agent_message_delta", "assistant_message_delta", "agent_message_content_delta"],
      normalizeType
    )
  ) {
    const text = normalizeMultiline(item?.delta ?? item?.text ?? item?.message, 24000);
    return text ? { mode: "delta", text } : null;
  }

  if (matchesNormalizedType(itemType, ["agent_message", "assistant_message"], normalizeType)) {
    const text = normalizeMultiline(item?.text ?? item?.message ?? item?.delta, 24000);
    return text ? { mode: "snapshot", text } : null;
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
    return joined ? { mode: "snapshot", text: joined } : null;
  }

  return null;
}

export function createLiveNotificationsModule(deps) {
  const {
    state,
    byId,
    setStatus = () => {},
    addChat,
    scheduleChatLiveFollow,
    hideWelcomeCard = () => {},
    createAssistantStreamingMessage = () => ({ msg: null, body: null }),
    appendStreamingDelta = () => {},
    renderAssistantLiveBody = null,
    finalizeAssistantMessage = () => {},
    setRuntimeActivity = () => {},
    applyToolItemRuntimeUpdate = () => {},
    applyPlanDeltaUpdate = () => {},
    applyPlanSnapshotUpdate = () => {},
    finalizeRuntimeState = () => {},
    normalizeType,
    normalizeInline,
    normalizeMultiline,
    readNumber,
    toRecord,
    toStructuredPreview,
    extractNotificationThreadId,
  } = deps;

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 160) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 160);
    }
  }

  function toToolLikeMessage(item) {
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

  function notificationToToolItem(notification) {
    const record = toRecord(notification);
    const params = toRecord(record?.params) || toRecord(record?.payload) || null;
    if (!params) return null;
    return (
      toRecord(params?.msg) || toRecord(params?.item) || toRecord(params?.delta) || toRecord(params?.event) || null
    );
  }

  function clearActiveAssistantLiveState() {
    state.activeThreadLiveAssistantThreadId = "";
    state.activeThreadLiveAssistantIndex = -1;
    state.activeThreadLiveAssistantMsgNode = null;
    state.activeThreadLiveAssistantBodyNode = null;
    state.activeThreadLiveAssistantText = "";
  }

  function syncPendingAssistantState(threadId, text) {
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return;
    state.activeThreadPendingAssistantMessage = String(text || "");
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
    box.appendChild(msg);
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
      finalizeAssistantLive(threadId);
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
    if (msg && body) finalizeAssistantMessage(msg, body, text);
    clearActiveAssistantLiveState();
    pushLiveDebugEvent("live.render:assistant_finalize", {
      threadId: String(threadId || ""),
      chars: text.length,
    });
    clearTransientToolMessages();
    scheduleChatLiveFollow(800);
  }

  function renderLiveNotification(notification) {
    const record = toRecord(notification);
    const method = normalizeLiveMethod(record?.method);
    if (!method) {
      pushLiveDebugEvent("live.drop:no_method", {});
      return;
    }
    const threadId = extractNotificationThreadId(record);
    const params = toRecord(record?.params) || null;
    pushLiveDebugEvent("live.notification", {
      method,
      threadId: String(threadId || ""),
      activeThreadId: String(state.activeThreadId || ""),
    });
    if (!threadId || threadId === state.activeThreadId) {
      const nextStatus = deriveLiveStatusFromNotification(record, {
        normalizeType,
        normalizeInline,
        toRecord,
      });
      if (nextStatus?.message) {
        pushLiveDebugEvent("live.status", {
          method,
          threadId: String(threadId || ""),
          activeThreadId: String(state.activeThreadId || ""),
          message: String(nextStatus.message || "").slice(0, 180),
          isWarn: nextStatus.isWarn === true,
        });
        setStatus(nextStatus.message, nextStatus.isWarn === true);
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

    if (method.includes("turn/assistant/delta")) {
      renderAssistantDelta(threadId, params?.delta);
      return;
    }

    const toolItem = notificationToToolItem(record);
    const assistantUpdate = toolItem
      ? readAssistantContentText(toolItem, {
          normalizeType,
          normalizeMultiline,
        })
      : null;
    if (assistantUpdate?.text) {
      const toolStatus = normalizeType(toolItem?.status);
      const isFinalAssistantUpdate =
        assistantUpdate.mode === "snapshot" &&
        (method.includes("completed") ||
          method.includes("finished") ||
          (!isRunningLiveStatus(toolStatus) && toolStatus !== "updating"));
      pushLiveDebugEvent("live.match:assistant_update", {
        method,
        threadId: String(threadId || ""),
        mode: assistantUpdate.mode,
        final: isFinalAssistantUpdate,
      });
      renderAssistantSnapshot(threadId, assistantUpdate.text, { final: isFinalAssistantUpdate });
      return;
    }
    if (method.includes("turn/plan/updated")) {
      applyPlanSnapshotUpdate({ ...(params || {}), threadId });
      clearTransientToolMessages();
      scheduleChatLiveFollow(900);
      return;
    }
    if (method.includes("item/plan/delta")) {
      applyPlanDeltaUpdate({ ...(params || {}), threadId });
      clearTransientToolMessages();
      scheduleChatLiveFollow(900);
      return;
    }
    if (toolItem) {
      applyToolItemRuntimeUpdate(toolItem, { threadId, method, timestamp: Date.now() });
      const toolLike = toToolLikeMessage(toolItem);
      if (toolLike) {
        if (
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

    const status =
      normalizeType(params?.status) || normalizeType(params?.turn?.status) || normalizeType(params?.thread?.status);
    const isRunning = /running|inprogress|working|queued/.test(status || "") || method.includes("turn/started");
    if (isRunning) {
      setRuntimeActivity({ threadId, title: "Thinking", detail: "", tone: "running" });
      return;
    }
    if (method.includes("turn/completed") || method.includes("turn/finished") || method.includes("turn/failed") || method.includes("turn/cancelled")) {
      pushLiveDebugEvent("live.render:turn_terminal", {
        method,
        threadId: String(threadId || ""),
      });
      finalizeAssistantLive(threadId);
      clearTransientToolMessages();
      finalizeRuntimeState(threadId);
      try {
        const box = byId("chatBox");
        box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]')?.remove?.();
      } catch {}
    }
  }

  return {
    clearTransientToolMessages,
    deriveLiveStatusFromNotification,
    deriveLiveStatusFromToolItem,
    isFailedLiveStatus,
    isRunningLiveStatus,
    normalizeLiveMethod,
    notificationToToolItem,
    renderLiveNotification,
    showTransientToolMessage,
    toToolLikeMessage,
    workspaceKeyOfThread,
  };
}
