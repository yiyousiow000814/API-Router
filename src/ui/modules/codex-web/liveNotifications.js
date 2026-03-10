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

export function createLiveNotificationsModule(deps) {
  const {
    state,
    byId,
    addChat,
    scheduleChatLiveFollow,
    hideWelcomeCard = () => {},
    createAssistantStreamingMessage = () => ({ msg: null, body: null }),
    appendStreamingDelta = () => {},
    finalizeAssistantMessage = () => {},
    normalizeType,
    normalizeInline,
    normalizeMultiline,
    readNumber,
    toRecord,
    toStructuredPreview,
    extractNotificationThreadId,
  } = deps;

  function toToolLikeMessage(item) {
    const itemType = normalizeType(item?.type);
    if (!itemType) return null;
    if (itemType === "plan") return normalizeMultiline(item?.text, 1800) || null;
    if (itemType === "commandexecution") {
      const command = normalizeInline(item?.command, 240) ?? "command";
      const status = normalizeType(item?.status);
      const output =
        normalizeMultiline(item?.aggregatedOutput, 2400) ??
        normalizeMultiline(item?.aggregated_output, 2400) ??
        normalizeMultiline(item?.output, 2400);
      const exitCode = readNumber(item?.exitCode) ?? readNumber(item?.exit_code);
      const title =
        status === "failed" || status === "error"
          ? `- Command failed \`${command}\``
          : `- Ran \`${command}\``;
      const lines = [title];
      if (exitCode !== null) lines.push(`  - exit code ${String(exitCode)}`);
      if (output) lines.push(`  - ${output.replace(/\n/g, "\n    ")}`);
      return lines.join("\n");
    }
    if (itemType === "mcptoolcall") {
      const server = normalizeInline(item?.server, 120);
      const tool = normalizeInline(item?.tool, 120);
      const label = [server, tool].filter(Boolean).join(" / ") || "MCP tool call";
      const status = normalizeType(item?.status);
      const err = toRecord(item?.error);
      const errMsg = normalizeInline(err?.message, 240) ?? normalizeInline(item?.error, 240);
      const result = toStructuredPreview(item?.result, 240);
      const detail = status === "failed" || status === "error" ? errMsg ?? result : result ?? errMsg;
      const title =
        status === "failed" || status === "error"
          ? `- Tool failed \`${label}\``
          : `- Called tool \`${label}\``;
      return detail ? `${title}\n  - ${detail.replace(/\n/g, "\n    ")}` : title;
    }
    if (itemType === "websearch") {
      const query = normalizeInline(item?.query, 180);
      const action = toRecord(item?.action);
      const actionType = normalizeType(action?.type);
      let detail = query;
      if (actionType === "openpage") detail = normalizeInline(action?.url, 240) ?? detail;
      else if (actionType === "findinpage") {
        const url = normalizeInline(action?.url, 180);
        const pattern = normalizeInline(action?.pattern, 120);
        detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(" | ") || detail;
      }
      const title = query ? `- Searched web for "${query}"` : "- Searched web";
      return detail && detail !== query ? `${title}\n  - ${detail}` : title;
    }
    if (itemType === "filechange") {
      const status = normalizeType(item?.status);
      const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
      const title = status === "failed" || status === "error" ? "- File changes failed" : "- Applied file changes";
      return changeCount > 0 ? `${title}\n  - ${String(changeCount)} file(s) changed` : title;
    }
    if (itemType === "enteredreviewmode") return "- Entered review mode";
    if (itemType === "exitedreviewmode") return "- Exited review mode";
    if (itemType === "contextcompaction") return "- Compacted conversation context";
    return null;
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

  function ensureAssistantLiveStream(threadId) {
    const liveThreadId = String(state.activeThreadLiveAssistantThreadId || "");
    const liveMsg = state.activeThreadLiveAssistantMsgNode;
    const liveBody = state.activeThreadLiveAssistantBodyNode;
    if (liveThreadId === threadId && liveMsg && liveBody) {
      return { msg: liveMsg, body: liveBody };
    }
    const box = byId("chatBox");
    if (!box) return null;
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
    if (!text) return;
    const live = ensureAssistantLiveStream(threadId);
    if (!live) return;
    appendStreamingDelta(live.body, text);
    state.activeThreadLiveAssistantText = `${String(state.activeThreadLiveAssistantText || "")}${text}`;
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
    scheduleChatLiveFollow(700);
  }

  function finalizeAssistantLive(threadId) {
    if (!threadId || String(state.activeThreadLiveAssistantThreadId || "") !== threadId) return;
    const msg = state.activeThreadLiveAssistantMsgNode;
    const body = state.activeThreadLiveAssistantBodyNode;
    const text = String(state.activeThreadLiveAssistantText || "");
    if (msg && body) finalizeAssistantMessage(msg, body, text);
    clearActiveAssistantLiveState();
    scheduleChatLiveFollow(800);
  }

  function renderLiveNotification(notification) {
    const record = toRecord(notification);
    const method = String(record?.method || "");
    if (!method) return;
    const threadId = extractNotificationThreadId(record);
    if (!threadId || threadId !== state.activeThreadId) return;
    const params = toRecord(record?.params) || null;

    if (method.includes("turn/assistant/delta")) {
      renderAssistantDelta(threadId, params?.delta);
      return;
    }

    const toolItem = notificationToToolItem(record);
    if (toolItem) {
      const toolLike = toToolLikeMessage(toolItem);
      if (toolLike) {
        addChat("system", toolLike, { kind: "tool", scroll: false });
        scheduleChatLiveFollow(900);
        return;
      }
    }

    const status =
      normalizeType(params?.status) || normalizeType(params?.turn?.status) || normalizeType(params?.thread?.status);
    const isRunning = /running|inprogress|working|queued/.test(status || "") || method.includes("turn/started");
    if (isRunning) {
      const box = byId("chatBox");
      if (!box) return;
      const existing = box.querySelector('.msg.system.kind-thinking[data-thinking="1"]');
      if (!existing) {
        addChat("system", "- Thinkingâ€¦", { kind: "thinking", scroll: false });
        try {
          const last = box.lastElementChild;
          if (last?.classList?.contains("kind-thinking")) last.setAttribute("data-thinking", "1");
        } catch {}
        scheduleChatLiveFollow(800);
      }
      return;
    }
    if (method.includes("turn/completed") || method.includes("turn/finished") || method.includes("turn/failed") || method.includes("turn/cancelled")) {
      finalizeAssistantLive(threadId);
      try {
        const box = byId("chatBox");
        box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]')?.remove?.();
      } catch {}
    }
  }

  return { notificationToToolItem, renderLiveNotification, toToolLikeMessage, workspaceKeyOfThread };
}
