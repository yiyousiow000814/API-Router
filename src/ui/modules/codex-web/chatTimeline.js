export function createChatTimelineModule(deps) {
  const {
    byId,
    state,
    escapeHtml,
    renderMessageAttachments,
    renderMessageBody,
    wireMessageLinks,
    wireMessageAttachments,
    scheduleChatLiveFollow,
    updateScrollToBottomBtn,
    scrollChatToBottom,
    renderRuntimePanels = () => {},
    requestAnimationFrameRef = requestAnimationFrame,
    documentRef = document,
  } = deps;

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 120) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 120);
    }
  }

  function attachMessageDebugMeta(node, payload = {}) {
    if (!node) return node;
    try {
      node.__webCodexRole = String(payload.role || "").trim();
      node.__webCodexKind = String(payload.kind || "").trim();
      node.__webCodexRawText = typeof payload.text === "string" ? payload.text : String(payload.text || "");
      node.__webCodexSource = String(payload.source || "").trim();
      node.__webCodexTransient = payload.transient === true;
      if (node.setAttribute) {
        if (node.__webCodexSource) node.setAttribute("data-msg-source", node.__webCodexSource);
        if (node.__webCodexTransient) node.setAttribute("data-msg-transient", "1");
        else node.removeAttribute("data-msg-transient");
      }
    } catch {}
    return node;
  }

  function animateMessageNode(node, delayMs = 0) {
    if (delayMs > 0) node.style.setProperty("--msg-enter-delay", `${Math.floor(delayMs)}ms`);
    else node.style.removeProperty("--msg-enter-delay");
    node.classList.add("msg-enter");
    node.addEventListener("animationend", () => {
      node.classList.remove("msg-enter");
      node.style.removeProperty("--msg-enter-delay");
    }, { once: true });
  }

  function createMessageNode(role, text, options = {}) {
    const node = documentRef.createElement("div");
    const kind = typeof options.kind === "string" && options.kind.trim() ? options.kind.trim() : "";
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    const hasAttachments = attachments.length > 0;
    const hasText = !!String(text || "").trim();
    const attachmentClass = role === "user" && hasAttachments && hasText ? " withAttachments" : "";
    node.className = `msg ${role}${kind ? ` kind-${kind}` : ""}${attachmentClass}`.trim();
    const showHead = !(role === "assistant" || role === "user" || (role === "system" && kind === "tool"));
    const headLabel = kind && role === "system" ? kind : role;
    const attachmentsHtml = renderMessageAttachments(attachments);
    const bodyHtml = renderMessageBody(role, text, { kind });
    node.innerHTML = `${showHead ? `<div class="msgHead">${escapeHtml(headLabel)}</div>` : ""}<div class="msgBody">${attachmentsHtml}${bodyHtml}</div>`;
    attachMessageDebugMeta(node, {
      role,
      kind,
      text,
      source: String(options.source || "").trim() || "createMessageNode",
      transient: options.transient === true,
    });
    wireMessageLinks(node);
    wireMessageAttachments(node);
    return node;
  }

  function buildMsgNode(msg) {
    return createMessageNode(msg?.role || "", msg?.text || "", {
      kind: msg?.kind || "",
      attachments: msg?.images || [],
      source: "buildMsgNode",
    });
  }

  function addChat(role, text, options = {}) {
    const box = byId("chatBox");
    const welcome = byId("welcomeCard");
    if (!box) return;
    if (welcome) welcome.style.display = "none";
    const node = createMessageNode(role, text, {
      kind: options.kind,
      attachments: options.attachments,
      source: String(options.source || "").trim() || "addChat",
      transient: options.transient === true,
    });
    if (options.animate !== false) {
      const defaultDelay = role === "assistant" || role === "system" ? 50 : 0;
      const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : defaultDelay;
      animateMessageNode(node, delayMs);
    }
    box.appendChild(node);
    renderRuntimePanels();
    if (options.scroll !== false) {
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      box.scrollTop = box.scrollHeight;
      scheduleChatLiveFollow(800);
    }
    updateScrollToBottomBtn();
  }

  function createAssistantStreamingMessage() {
    const msg = documentRef.createElement("div");
    msg.className = "msg assistant";
    msg.innerHTML = `<div class="msgHead">assistant</div><div class="msgBody"></div>`;
    animateMessageNode(msg, 50);
    attachMessageDebugMeta(msg, { role: "assistant", kind: "", text: "", source: "streaming" });
    const body = msg.querySelector(".msgBody");
    return { msg, body };
  }

  function ensureStreamingBody(body) {
    if (!body) return null;
    try {
      body.setAttribute("data-streaming", "1");
    } catch {}
    let box = body.querySelector(".streamChunks");
    if (!box) {
      box = documentRef.createElement("div");
      box.className = "streamChunks";
      body.textContent = "";
      body.appendChild(box);
    }
    if (!body.__streaming) {
      body.__streaming = { pending: "", scheduled: false };
    }
    return { box, st: body.__streaming };
  }

  function flushStreamingBody(body) {
    const prepared = ensureStreamingBody(body);
    if (!prepared) return;
    const { box, st } = prepared;
    const pending = String(st.pending || "");
    st.pending = "";
    st.scheduled = false;
    if (!pending) return;

    const parts = pending.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part) {
        const span = documentRef.createElement("span");
        span.className = "streamChunk";
        span.textContent = part;
        box.appendChild(span);
      }
      if (i !== parts.length - 1) box.appendChild(documentRef.createElement("br"));
    }
  }

  function appendStreamingDelta(body, text) {
    const prepared = ensureStreamingBody(body);
    if (!prepared) return;
    const { st } = prepared;
    st.pending += String(text || "");
    if (st.scheduled) return;
    st.scheduled = true;
    requestAnimationFrameRef(() => flushStreamingBody(body));
  }

  function renderAssistantLiveBody(msgNode, bodyNode, text) {
    if (!msgNode || !bodyNode) return;
    const liveText = String(text || "");
    try {
      bodyNode.setAttribute("data-streaming", "1");
      bodyNode.__streaming = null;
    } catch {}
    bodyNode.innerHTML = renderMessageBody("assistant", liveText, { kind: "" });
    attachMessageDebugMeta(msgNode, {
      role: "assistant",
      kind: "",
      text: liveText,
      source: "renderAssistantLiveBody",
    });
    wireMessageLinks(msgNode);
  }

  function finalizeAssistantMessage(msgNode, bodyNode, text) {
    if (!msgNode || !bodyNode) return;
    try {
      const box = byId("chatBox");
      const node = box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]') || null;
      if (node) node.remove();
    } catch {}
    const finalText = String(text || "").trim();
    try {
      bodyNode.removeAttribute("data-streaming");
      bodyNode.__streaming = null;
    } catch {}
    try {
      msgNode.removeAttribute("data-live-assistant");
      msgNode.removeAttribute("data-live-thread-id");
    } catch {}
    bodyNode.innerHTML = renderMessageBody("assistant", finalText, { kind: "" });
    attachMessageDebugMeta(msgNode, { role: "assistant", kind: "", text: finalText, source: "finalizeAssistantMessage" });
    wireMessageLinks(msgNode);
  }

  function clearChatMessages(options = {}) {
    pushLiveDebugEvent("chat.clear", {
      activeThreadId: String(state.activeThreadId || ""),
      pendingThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      pendingUser: String(state.activeThreadPendingUserMessage || ""),
      pendingAssistant: String(state.activeThreadPendingAssistantMessage || ""),
      preservePendingTurn: !!(options && options.preservePendingTurn === true),
    });
    const box = byId("chatBox");
    if (!box) return;
    const preserveScroll = options && options.preserveScroll === true;
    const welcome = byId("welcomeCard");
    const overlay = byId("chatOpeningOverlay");
    const keep = [];
    if (welcome && welcome.parentElement === box) keep.push(welcome);
    if (overlay && overlay.parentElement === box) keep.push(overlay);
    box.replaceChildren(...keep);
    if (!preserveScroll) box.scrollTop = 0;
    state.activeThreadRenderSig = "";
    state.activeThreadMessages = [];
    if (!(options && options.preservePendingTurn === true)) {
      state.activeThreadPendingTurnThreadId = "";
      state.activeThreadPendingUserMessage = "";
      state.activeThreadPendingAssistantMessage = "";
    }
    state.activeThreadLiveAssistantThreadId = "";
    state.activeThreadLiveAssistantIndex = -1;
    state.activeThreadLiveAssistantMsgNode = null;
    state.activeThreadLiveAssistantBodyNode = null;
    state.activeThreadLiveAssistantText = "";
    state.historyWindowEnabled = false;
    state.historyWindowThreadId = "";
    state.historyWindowStart = 0;
    state.historyWindowLoading = false;
    state.historyAllMessages = [];
    state.activeThreadHistoryTurns = [];
    state.activeThreadHistoryThreadId = "";
    state.activeThreadHistoryHasMore = false;
    state.activeThreadHistoryIncomplete = false;
    state.activeThreadHistoryBeforeCursor = "";
    state.activeThreadHistoryTotalTurns = 0;
    state.activeThreadHistoryReqSeq = 0;
    state.activeThreadHistoryInFlightPromise = null;
    state.activeThreadHistoryInFlightThreadId = "";
    state.activeThreadHistoryPendingRefresh = null;
    state.activeThreadTransientToolText = "";
    state.activeThreadActivity = null;
    state.activeThreadActiveCommands = [];
    state.activeThreadPlan = null;
    renderRuntimePanels();
  }

  function setChatOpening(isOpening) {
    const overlay = byId("chatOpeningOverlay");
    const box = byId("chatBox");
    if (!overlay) return;
    if (isOpening) {
      clearChatMessages();
      const welcome = byId("welcomeCard");
      if (welcome) welcome.style.display = "none";
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      if (box) box.scrollTop = 0;
    }
    overlay.classList.toggle("show", !!isOpening);
  }

  return {
    addChat,
    appendStreamingDelta,
    attachMessageDebugMeta,
    animateMessageNode,
    buildMsgNode,
    clearChatMessages,
    createAssistantStreamingMessage,
    ensureStreamingBody,
    finalizeAssistantMessage,
    flushStreamingBody,
    renderAssistantLiveBody,
    setChatOpening,
  };
}
