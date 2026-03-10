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
    requestAnimationFrameRef = requestAnimationFrame,
    documentRef = document,
  } = deps;

  function attachMessageDebugMeta(node, payload = {}) {
    if (!node) return node;
    try {
      node.__webCodexRole = String(payload.role || "").trim();
      node.__webCodexKind = String(payload.kind || "").trim();
      node.__webCodexRawText = typeof payload.text === "string" ? payload.text : String(payload.text || "");
      node.__webCodexSource = String(payload.source || "").trim();
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
    const headLabel = kind && role === "system" ? kind : role;
    const attachmentsHtml = renderMessageAttachments(attachments);
    const bodyHtml = renderMessageBody(role, text);
    node.innerHTML = `<div class="msgHead">${escapeHtml(headLabel)}</div><div class="msgBody">${attachmentsHtml}${bodyHtml}</div>`;
    attachMessageDebugMeta(node, { role, kind, text, source: String(options.source || "").trim() || "createMessageNode" });
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
      source: "addChat",
    });
    if (options.animate !== false) {
      const defaultDelay = role === "assistant" || role === "system" ? 50 : 0;
      const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : defaultDelay;
      animateMessageNode(node, delayMs);
    }
    box.appendChild(node);
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
    bodyNode.innerHTML = renderMessageBody("assistant", finalText);
    attachMessageDebugMeta(msgNode, { role: "assistant", kind: "", text: finalText, source: "finalizeAssistantMessage" });
    wireMessageLinks(msgNode);
  }

  function clearChatMessages(options = {}) {
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
    setChatOpening,
  };
}
