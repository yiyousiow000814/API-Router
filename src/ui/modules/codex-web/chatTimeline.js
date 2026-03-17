import { renderPlanCardHtml } from "./runtimePlan.js";

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
  let archiveViewportAdjustToken = 0;

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
    if (state.chatOpening === true) return;
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
    const showHead = !(role === "assistant" || role === "user" || (role === "system" && (kind === "tool" || kind === "thinking")));
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
    if (msg?.kind === "commentaryArchive") {
      return createCommentaryArchiveNode(msg?.archiveBlocks, {
        source: "buildMsgNode",
        key: msg?.archiveKey,
      });
    }
    return createMessageNode(msg?.role || "", msg?.text || "", {
      kind: msg?.kind || "",
      attachments: msg?.images || [],
      source: "buildMsgNode",
    });
  }

  function removeCommentaryArchiveMount() {
    const mount = byId("commentaryArchiveMount");
    mount?.remove?.();
  }

  function formatCommentaryArchiveSummary(commentaryCount, toolCount) {
    const normalizedCommentaryCount = Math.max(0, Number(commentaryCount || 0));
    const normalizedToolCount = Math.max(0, Number(toolCount || 0));
    return `${String(normalizedCommentaryCount)} commentary message${normalizedCommentaryCount === 1 ? "" : "s"}, ${String(normalizedToolCount)} used tool${normalizedToolCount === 1 ? "" : "s"}`;
  }

  function getChatDistanceFromBottom(box) {
    if (!box) return 0;
    return Math.max(0, Number(box.scrollHeight || 0) - (Number(box.scrollTop || 0) + Number(box.clientHeight || 0)));
  }

  function getViewportTop(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return null;
    const rect = node.getBoundingClientRect();
    const top = Number(rect?.top);
    return Number.isFinite(top) ? top : null;
  }

  function prepareArchiveViewportAfterToggle(toggle) {
    const box = byId("chatBox");
    if (!box || !toggle) {
      return () => updateScrollToBottomBtn();
    }
    const lockBottom = !!state.chatShouldStickToBottom || getChatDistanceFromBottom(box) <= 80;
    const anchorTop = lockBottom ? null : getViewportTop(toggle);
    return () => {
      const token = (archiveViewportAdjustToken + 1) | 0;
      archiveViewportAdjustToken = token;
      const startedAt = Date.now();
      const tick = () => {
        if (archiveViewportAdjustToken !== token) return;
        const liveBox = byId("chatBox");
        if (!liveBox || !toggle.parentElement) return;
        if (lockBottom) {
          state.chatShouldStickToBottom = true;
          state.chatUserScrolledAwayAt = 0;
          scrollChatToBottom({ force: true });
          scheduleChatLiveFollow(380);
          updateScrollToBottomBtn();
        } else if (anchorTop != null) {
          const nextTop = getViewportTop(toggle);
          if (nextTop != null) {
            const delta = nextTop - anchorTop;
            if (Math.abs(delta) > 0.5) {
              state.chatProgrammaticScrollUntil = Date.now() + 180;
              liveBox.scrollTop += delta;
            }
          }
          updateScrollToBottomBtn();
        } else {
          updateScrollToBottomBtn();
        }
        if (Date.now() - startedAt < 320) requestAnimationFrameRef(tick);
      };
      requestAnimationFrameRef(tick);
    };
  }

  function createCommentaryArchiveNode(blocks, options = {}) {
    const archive = Array.isArray(blocks)
      ? blocks.filter((block) => {
          const tools = Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
          return !!(block && (block?.summaryOnly === true || String(block.text || "").trim() || block?.plan || tools.length));
        })
      : [];
    const expandableArchive = archive.filter((block) => block?.summaryOnly !== true && (String(block?.text || "").trim() || block?.plan));
    const totalToolCount = archive.reduce((count, block) => {
      return count + (Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean).length : 0);
    }, 0);
    const mount = documentRef.createElement("div");
    mount.className = "commentaryArchiveMount";
    attachMessageDebugMeta(mount, {
      role: "system",
      kind: "commentaryArchive",
      text: archive
        .map((block) => [
          String(block?.text || "").trim(),
          ...(Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()) : []),
        ].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n"),
      source: String(options.source || "").trim() || "commentaryArchive",
      transient: false,
    });
    if (options.key) {
      try { mount.setAttribute("data-commentary-archive-key", String(options.key)); } catch {}
    }
    if (!expandableArchive.length) {
      const summary = documentRef.createElement("div");
      summary.className = "commentaryArchiveSummary";
      summary.textContent = formatCommentaryArchiveSummary(0, totalToolCount);
      mount.appendChild(summary);
      return mount;
    }
    const expandedState = { value: false };
    const toggle = documentRef.createElement("button");
    toggle.type = "button";
    toggle.className = "commentaryArchiveToggle is-collapsed";
    toggle.setAttribute("aria-expanded", "false");
    const countLabel = documentRef.createElement("span");
    countLabel.className = "commentaryArchiveCount";
    countLabel.textContent = formatCommentaryArchiveSummary(expandableArchive.length, totalToolCount);
    const chevron = documentRef.createElement("span");
    chevron.className = "commentaryArchiveChevron is-collapsed";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    toggle.appendChild(countLabel);
    toggle.appendChild(chevron);
    mount.appendChild(toggle);

    const body = documentRef.createElement("div");
    body.className = "commentaryArchiveBody collapsed";
    body.setAttribute("aria-hidden", "true");
    const bodyInner = documentRef.createElement("div");
    bodyInner.className = "commentaryArchiveBodyInner";
    for (const block of expandableArchive) {
      const blockNode = documentRef.createElement("div");
      blockNode.className = "commentaryArchiveBlock";
      if (block?.plan) {
        const planNode = documentRef.createElement("div");
        planNode.className = "commentaryArchivePlan";
        planNode.innerHTML = renderPlanCardHtml(block.plan, {
          escapeHtml,
          cardClass: "commentaryArchivePlanCard",
        });
        blockNode.appendChild(planNode);
      }
      if (String(block?.text || "").trim()) {
        blockNode.appendChild(createMessageNode("system", block.text, {
          kind: "thinking",
          source: "commentaryArchive",
        }));
      }
      bodyInner.appendChild(blockNode);
    }
    const finalDivider = documentRef.createElement("div");
    finalDivider.className = "commentaryArchiveFinalDivider";
    finalDivider.innerHTML = '<span class="commentaryArchiveFinalLabel">Final message</span>';
    bodyInner.appendChild(finalDivider);
    body.appendChild(bodyInner);
    mount.appendChild(body);

    const syncExpandedUi = () => {
      toggle.className = `commentaryArchiveToggle${expandedState.value ? "" : " is-collapsed"}`;
      chevron.className = `commentaryArchiveChevron${expandedState.value ? "" : " is-collapsed"}`;
      body.className = `commentaryArchiveBody${expandedState.value ? "" : " collapsed"}`;
      toggle.setAttribute("aria-expanded", expandedState.value ? "true" : "false");
      body.setAttribute("aria-hidden", expandedState.value ? "false" : "true");
    };
    toggle.addEventListener("click", () => {
      const syncViewport = prepareArchiveViewportAfterToggle(toggle);
      expandedState.value = !(expandedState.value === true);
      syncExpandedUi();
      syncViewport();
    });
    syncExpandedUi();
    return mount;
  }

  function renderCommentaryArchive(options = {}) {
    const box = byId("chatBox");
    if (!box) return;
    const inlineArchiveCount = Math.max(0, Number(state.activeThreadInlineCommentaryArchiveCount || 0));
    const archive = Array.isArray(state.activeThreadCommentaryArchive)
      ? state.activeThreadCommentaryArchive.filter((block) => {
          const tools = Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
          return !!(block && (block?.summaryOnly === true || String(block.text || "").trim() || block?.plan || tools.length));
        })
      : [];
    const visible = state.activeThreadCommentaryArchiveVisible === true && archive.length > 0;
    removeCommentaryArchiveMount();
    if (!visible || inlineArchiveCount > 0) return;

    const mount = createCommentaryArchiveNode(archive, { source: "commentaryArchiveMount" });
    mount.id = "commentaryArchiveMount";
    const toggle = mount.querySelector(".commentaryArchiveToggle");
    const chevron = mount.querySelector(".commentaryArchiveChevron");
    const body = mount.querySelector(".commentaryArchiveBody");
    const syncExpandedUi = () => {
      if (toggle) toggle.className = `commentaryArchiveToggle${state.activeThreadCommentaryArchiveExpanded ? "" : " is-collapsed"}`;
      if (chevron) chevron.className = `commentaryArchiveChevron${state.activeThreadCommentaryArchiveExpanded ? "" : " is-collapsed"}`;
      if (body) body.className = `commentaryArchiveBody${state.activeThreadCommentaryArchiveExpanded ? "" : " collapsed"}`;
      if (toggle) toggle.setAttribute("aria-expanded", state.activeThreadCommentaryArchiveExpanded ? "true" : "false");
      if (body) body.setAttribute("aria-hidden", state.activeThreadCommentaryArchiveExpanded ? "false" : "true");
    };
    if (toggle) {
      toggle.addEventListener("click", () => {
        const syncViewport = prepareArchiveViewportAfterToggle(toggle);
        state.activeThreadCommentaryArchiveExpanded = !(state.activeThreadCommentaryArchiveExpanded === true);
        syncExpandedUi();
        syncViewport();
      });
    }
    syncExpandedUi();

    const fallbackAssistantAnchor = (() => {
      const assistantNodes = Array.from(box.querySelectorAll(".assistant"));
      return assistantNodes.length ? assistantNodes[assistantNodes.length - 1] : null;
    })();
    const anchorNode =
      (options.anchorNode && options.anchorNode.parentElement === box ? options.anchorNode : null) ||
      fallbackAssistantAnchor ||
      box.querySelector("#runtimeChatPanels") ||
      null;
    if (anchorNode) box.insertBefore(mount, anchorNode);
    else box.appendChild(mount);
  }

  function addChat(role, text, options = {}) {
    const box = byId("chatBox");
    const welcome = byId("welcomeCard");
    if (!box) return;
    if (welcome) welcome.style.display = "none";
    const node = options.kind === "commentaryArchive"
      ? createCommentaryArchiveNode(options.archiveBlocks, {
          source: String(options.source || "").trim() || "addChat",
          key: options.archiveKey,
        })
      : createMessageNode(role, text, {
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
    const preservePendingTurn = options && options.preservePendingTurn === true;
    const welcome = byId("welcomeCard");
    const overlay = byId("chatOpeningOverlay");
    const keep = [];
    if (welcome && welcome.parentElement === box) keep.push(welcome);
    if (overlay && overlay.parentElement === box) keep.push(overlay);
    box.replaceChildren(...keep);
    if (!preserveScroll) box.scrollTop = 0;
    state.activeThreadRenderSig = "";
    state.activeThreadMessages = [];
    if (!preservePendingTurn) {
      state.activeThreadLiveStateEpoch = Math.max(0, Number(state.activeThreadLiveStateEpoch || 0)) + 1;
      state.activeThreadLiveRuntimeEpoch = 0;
      state.activeThreadPendingTurnThreadId = "";
      state.activeThreadPendingTurnRunning = false;
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
    if (!preservePendingTurn) state.activeThreadTransientToolText = "";
    if (!preservePendingTurn) state.activeThreadTransientThinkingText = "";
    if (!preservePendingTurn) state.activeThreadCommentaryPendingPlan = null;
    if (!preservePendingTurn) state.activeThreadCommentaryPendingTools = [];
    if (!preservePendingTurn) state.activeThreadCommentaryPendingToolKeys = [];
    if (!preservePendingTurn) state.activeThreadCommentaryCurrent = null;
    if (!preservePendingTurn) state.activeThreadCommentaryArchive = [];
    if (!preservePendingTurn) state.activeThreadCommentaryArchiveVisible = false;
    if (!preservePendingTurn) state.activeThreadCommentaryArchiveExpanded = false;
    if (!preservePendingTurn) state.activeThreadInlineCommentaryArchiveCount = 0;
    if (!preservePendingTurn) state.activeThreadActivity = null;
    if (!preservePendingTurn) state.activeThreadActiveCommands = [];
    if (!preservePendingTurn) state.activeThreadPlan = null;
    renderRuntimePanels();
  }

  function setChatOpening(isOpening) {
    const overlay = byId("chatOpeningOverlay");
    const box = byId("chatBox");
    if (!overlay) return;
    state.chatOpening = isOpening === true;
    if (isOpening) {
      clearChatMessages();
      const welcome = byId("welcomeCard");
      if (welcome) welcome.style.display = "none";
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      if (box) {
        box.scrollTop = 0;
        box.classList.add("chat-opening");
        box.classList.remove("chat-opening-reveal");
      }
    } else if (box) {
      const hadOpeningClass = box.classList.contains("chat-opening");
      box.classList.remove("chat-opening");
      if (hadOpeningClass) {
        box.classList.remove("chat-opening-reveal");
        box.classList.add("chat-opening-reveal");
        const clearRevealClass = () => box.classList.remove("chat-opening-reveal");
        if (typeof box.addEventListener === "function") {
          box.addEventListener("animationend", clearRevealClass, { once: true });
        }
      }
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
    renderCommentaryArchive,
    renderAssistantLiveBody,
    removeCommentaryArchiveMount,
    setChatOpening,
  };
}
