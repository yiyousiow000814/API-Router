export function buildThreadHistoryUrl(threadId, options = {}, fallbackWorkspace = "") {
  const params = new URLSearchParams();
  const workspace = String(options.workspace || fallbackWorkspace || "").trim();
  const rolloutPath = String(options.rolloutPath || "").trim();
  const before = String(options.before || "").trim();
  const limit = Number(options.limit || 0) || 0;
  if (workspace === "windows" || workspace === "wsl2") params.set("workspace", workspace);
  if (rolloutPath) params.set("rolloutPath", rolloutPath);
  if (before) params.set("before", before);
  if (limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return `/codex/threads/${encodeURIComponent(threadId)}/history${query ? `?${query}` : ""}`;
}

export function mergeHistoryTurns(existingTurns, incomingTurns) {
  const merged = [];
  const indexes = new Map();
  const seenAnonymous = new Set();
  const pushTurn = (turn) => {
    if (!turn || typeof turn !== "object") return;
    const id = String(turn.id || "").trim();
    if (id) {
      const existingIndex = indexes.get(id);
      if (existingIndex !== undefined) {
        merged[existingIndex] = turn;
        return;
      }
      indexes.set(id, merged.length);
      merged.push(turn);
      return;
    }
    const key = JSON.stringify(turn);
    if (!key || seenAnonymous.has(key)) return;
    seenAnonymous.add(key);
    merged.push(turn);
  };
  for (const turn of Array.isArray(existingTurns) ? existingTurns : []) pushTurn(turn);
  for (const turn of Array.isArray(incomingTurns) ? incomingTurns : []) pushTurn(turn);
  return merged;
}

export function normalizeSessionAssistantText(content, deps = {}) {
  const normalizeTypeRef =
    typeof deps.normalizeType === "function"
      ? deps.normalizeType
      : (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const stripCodexImageBlocksRef =
    typeof deps.stripCodexImageBlocks === "function"
      ? deps.stripCodexImageBlocks
      : (value) => String(value || "");
  const parts = Array.isArray(content) ? content : [];
  const lines = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const partType = normalizeTypeRef(part.type);
    if (partType !== "outputtext" && partType !== "inputtext") continue;
    const text = stripCodexImageBlocksRef(String(part.text || "")).trim();
    if (text) lines.push(text);
  }
  return lines.join("\n").trim();
}

export function shouldUseHistoryWindow(messages, options = {}, state = {}) {
  if (!Array.isArray(messages)) return false;
  if (options.forceHistoryWindow || state.activeThreadHistoryHasMore) return true;
  if (messages.length < Number(state.HISTORY_WINDOW_THRESHOLD || 0)) return false;
  return true;
}

function messageMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind && a.text === b.text;
}

export function mergePendingLiveMessages(messages, state = {}, threadId = "") {
  const out = Array.isArray(messages) ? messages.slice() : [];
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!pendingThreadId || !threadId || pendingThreadId !== threadId) return out;

  const pendingUser = String(state.activeThreadPendingUserMessage || "");
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "");
  const hasPendingUser = !!pendingUser.trim();
  const hasPendingAssistant = !!pendingAssistant.trim();
  const pending = [];
  if (hasPendingUser) pending.push({ role: "user", text: pendingUser, kind: "" });
  if (hasPendingAssistant) pending.push({ role: "assistant", text: pendingAssistant, kind: "" });
  if (!pending.length) return out;

  const endsWithPending =
    pending.length <= out.length &&
    pending.every((msg, index) => messageMatches(out[out.length - pending.length + index], msg));
  if (endsWithPending) {
    if (hasPendingAssistant || !hasPendingUser) {
      state.activeThreadPendingTurnThreadId = "";
      state.activeThreadPendingUserMessage = "";
      state.activeThreadPendingAssistantMessage = "";
    } else {
      state.activeThreadPendingUserMessage = "";
    }
    return out;
  }

  let appendFrom = 0;
  if (pending.length >= 1 && out.length >= 1 && messageMatches(out[out.length - 1], pending[0])) {
    appendFrom = 1;
  }
  return out.concat(pending.slice(appendFrom));
}

export function createHistoryLoaderModule(deps) {
  const {
    state,
    byId,
    api,
    nextFrame,
    waitMs,
    windowRef = window,
    documentRef = document,
    performanceRef = performance,
    setTimeoutRef = setTimeout,
    HISTORY_WINDOW_THRESHOLD,
    normalizeThreadTokenUsage,
    renderComposerContextLeft,
    detectThreadWorkspaceTarget,
    parseUserMessageParts,
    isBootstrapAgentsPrompt,
    normalizeThreadItemText,
    normalizeType,
    stripCodexImageBlocks,
    hideWelcomeCard,
    showWelcomeCard,
    updateHeaderUi,
    updateScrollToBottomBtn,
    scheduleChatLiveFollow,
    scrollChatToBottom,
    scrollToBottomReliable,
    canStartChatLiveFollow,
    renderMessageBody,
    addChat,
    buildMsgNode,
    clearChatMessages,
    syncEventSubscription = () => {},
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

  async function mapThreadReadMessages(thread) {
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const messages = [];
    let lastYieldMs = performanceRef.now();
    const yieldBudgetMs = 7.5;
    if (turns.length >= 40) await nextFrame();

    for (let ti = 0; ti < turns.length; ti += 1) {
      if (turns.length >= 40 && performanceRef.now() - lastYieldMs >= yieldBudgetMs) {
        lastYieldMs = performanceRef.now();
        await nextFrame();
      }
      const turn = turns[ti];
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        const type = String(item?.type || "").trim();
        if (type === "userMessage") {
          const parsed = parseUserMessageParts(item);
          const text = parsed.text;
          if (text && isBootstrapAgentsPrompt(text)) continue;
          if (text || parsed.images.length) {
            messages.push({ role: "user", text, kind: "", images: parsed.images });
          }
          continue;
        }
        const text = normalizeThreadItemText(item);
        if (!text) continue;
        if (type === "agentMessage" || type === "assistantMessage") {
          messages.push({ role: "assistant", text, kind: "" });
        }
      }
    }
    return messages;
  }

  async function mapSessionHistoryMessages(items) {
    const historyItems = Array.isArray(items) ? items : [];
    const messages = [];
    let lastYieldMs = performanceRef.now();
    const yieldBudgetMs = 7.5;
    if (historyItems.length >= 40) await nextFrame();

    for (let index = 0; index < historyItems.length; index += 1) {
      if (historyItems.length >= 40 && performanceRef.now() - lastYieldMs >= yieldBudgetMs) {
        lastYieldMs = performanceRef.now();
        await nextFrame();
      }
      const item = historyItems[index];
      if (!item || typeof item !== "object") continue;
      const type = String(item.type || "").trim();
      if (type !== "message") continue;
      const role = String(item.role || "").trim();
      if (role === "user") {
        const parsed = parseUserMessageParts({ content: item.content });
        const text = parsed.text;
        if (text && isBootstrapAgentsPrompt(text)) continue;
        if (text || parsed.images.length) {
          messages.push({ role: "user", text, kind: "", images: parsed.images });
        }
        continue;
      }
      if (role === "assistant") {
        const text = normalizeSessionAssistantText(item.content, {
          normalizeType,
          stripCodexImageBlocks,
        });
        if (text) messages.push({ role: "assistant", text, kind: "" });
      }
    }
    return messages;
  }

  function queuePendingActiveThreadHistoryRefresh(threadId, options = {}) {
    if (!threadId) return;
    const previous = state.activeThreadHistoryPendingRefresh;
    const next = {
      threadId,
      animateBadge: !!(previous?.animateBadge || options.animateBadge),
      forceRender: !!(previous?.forceRender || options.forceRender),
      forceHistoryWindow: !!(previous?.forceHistoryWindow || options.forceHistoryWindow),
      workspace: String(options.workspace || previous?.workspace || state.activeThreadWorkspace || "").trim(),
      rolloutPath: String(options.rolloutPath || previous?.rolloutPath || state.activeThreadRolloutPath || "").trim(),
    };
    const limit = Number(options.limit || previous?.limit || 0) || 0;
    if (limit > 0) next.limit = limit;
    state.activeThreadHistoryPendingRefresh = next;
  }

  function ensureLoadOlderControl(box) {
    if (!box) return null;
    let wrap = byId("loadOlderWrap");
    if (!wrap) {
      wrap = documentRef.createElement("div");
      wrap.id = "loadOlderWrap";
      wrap.className = "loadOlderWrap";
      wrap.innerHTML = `<button id="loadOlderBtn" class="loadOlderBtn" type="button">Load older</button>`;
      const firstMsg = box.querySelector(".msg");
      if (firstMsg) box.insertBefore(wrap, firstMsg);
      else box.appendChild(wrap);
    }
    const btn = wrap.querySelector("#loadOlderBtn");
    if (btn && !btn.__wiredLoadOlder) {
      btn.__wiredLoadOlder = true;
      btn.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          loadOlderHistoryChunk();
        },
        { passive: false }
      );
    }
    return wrap;
  }

  function updateLoadOlderControl() {
    const box = byId("chatBox");
    if (!box) return;
    const wrap = byId("loadOlderWrap");
    if (!state.historyWindowEnabled || !state.historyWindowThreadId) {
      if (wrap) wrap.remove();
      return;
    }
    const remaining = Math.max(0, Number(state.historyWindowStart || 0));
    const loadedTurns = Array.isArray(state.activeThreadHistoryTurns) ? state.activeThreadHistoryTurns.length : 0;
    const serverRemaining = Math.max(0, Number(state.activeThreadHistoryTotalTurns || 0) - loadedTurns);
    if (!remaining && !state.activeThreadHistoryHasMore) {
      if (wrap) wrap.remove();
      return;
    }
    ensureLoadOlderControl(box);
    const btn = byId("loadOlderBtn");
    if (btn) {
      btn.disabled = !!state.historyWindowLoading;
      const count = remaining || serverRemaining;
      btn.textContent = state.historyWindowLoading ? "Loading..." : (count > 0 ? `Load older (${count})` : "Load older");
    }
  }

  async function renderChatFull(messages, options = {}) {
    const box = byId("chatBox");
    if (!box) return;

    state.chatRenderToken = (Number(state.chatRenderToken || 0) + 1) | 0;
    const token = state.chatRenderToken;

    clearChatMessages({
      preserveScroll: options && options.preserveScroll === true,
      preservePendingTurn: true,
    });
    state.activeThreadMessages = [];

    const slowYield = !!options.slowRender;
    const batchSize = Math.max(6, Math.min(28, Number(options.batchSize || 14)));
    for (let i = 0; i < messages.length; i += batchSize) {
      if (token !== state.chatRenderToken) return;
      const frag = documentRef.createDocumentFragment();
      const end = Math.min(messages.length, i + batchSize);
      for (let j = i; j < end; j += 1) frag.appendChild(buildMsgNode(messages[j]));
      box.appendChild(frag);
      const now = Date.now();
      const recentGesture = now - Number(state.chatLastUserGestureAt || 0) <= 250;
      if (state.chatShouldStickToBottom && !recentGesture) {
        scrollChatToBottom({ force: true });
      }
      await nextFrame();
      if (slowYield) await waitMs(12);
    }
  }

  async function applyThreadToChat(thread, options = {}) {
    pushLiveDebugEvent("history.apply", {
      threadId: String(thread?.id || state.activeThreadId || ""),
      forceRender: !!options.forceRender,
      historyItems: Array.isArray(thread?.historyItems) ? thread.historyItems.length : 0,
      turns: Array.isArray(thread?.turns) ? thread.turns.length : 0,
      pendingThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      pendingUser: String(state.activeThreadPendingUserMessage || ""),
      pendingAssistant: String(state.activeThreadPendingAssistantMessage || ""),
    });
    if (options.stickToBottom) {
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
    }
    const historyItems = Array.isArray(thread?.historyItems) ? thread.historyItems : [];
    const rawMessages = historyItems.length
      ? await mapSessionHistoryMessages(historyItems)
      : await mapThreadReadMessages(thread);
    const threadId = String(thread?.id || state.activeThreadId || "");
    const messages = mergePendingLiveMessages(rawMessages, state, threadId);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    state.activeThreadTokenUsage = normalizeThreadTokenUsage(thread?.tokenUsage);
    renderComposerContextLeft();
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    const renderSig = [
      String(thread?.id || state.activeThreadId || ""),
      String(turns.length),
      String(messages.length),
      String(lastMsg?.role || ""),
      String(lastMsg?.text || ""),
    ].join("::");
    state.activeThreadStarted = messages.length > 0 || turns.length > 0 || historyItems.length > 0;
    const detectedTarget = detectThreadWorkspaceTarget(thread);
    const target = detectedTarget !== "unknown"
      ? detectedTarget
      : ((options.workspace === "windows" || options.workspace === "wsl2") ? options.workspace : "unknown");
    const previousWorkspace = String(state.activeThreadWorkspace || "").trim();
    if (target !== "unknown") state.activeThreadWorkspace = target;
    if (
      target !== "unknown" &&
      target !== previousWorkspace &&
      state.activeThreadId === threadId
    ) {
      syncEventSubscription();
    }
    if (!options.forceRender && state.activeThreadRenderSig === renderSig) {
      if (state.activeThreadStarted) hideWelcomeCard();
      else showWelcomeCard();
      updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
      if (state.historyWindowEnabled && state.historyWindowThreadId === threadId) updateLoadOlderControl();
      return;
    }

    const box = byId("chatBox");
    const prevMessages = Array.isArray(state.activeThreadMessages) ? state.activeThreadMessages : [];

    if (shouldUseHistoryWindow(messages, options, { activeThreadHistoryHasMore: state.activeThreadHistoryHasMore, HISTORY_WINDOW_THRESHOLD })) {
      const prevAll = Array.isArray(state.historyAllMessages) ? state.historyAllMessages : [];
      const alreadyWindowed = state.historyWindowEnabled && state.historyWindowThreadId === threadId;

      const doWindowedRender = () => {
        const size = Math.max(40, Number(state.historyWindowSize || 160) | 0);
        const start = Math.max(0, messages.length - size);
        clearChatMessages({ preservePendingTurn: true });
        state.historyWindowEnabled = true;
        state.historyWindowThreadId = threadId;
        state.historyWindowStart = start;
        state.historyAllMessages = messages;
        const slice = messages.slice(start);
        const frag = documentRef.createDocumentFragment();
        for (const msg of slice) frag.appendChild(buildMsgNode(msg));
        const box2 = byId("chatBox");
        if (box2) {
          if (start > 0 || state.activeThreadHistoryHasMore) ensureLoadOlderControl(box2);
          box2.appendChild(frag);
        }
        state.activeThreadMessages = slice;
        state.activeThreadRenderSig = renderSig;
        updateLoadOlderControl();

        if (options.stickToBottom) {
          scrollToBottomReliable();
          scheduleChatLiveFollow(1400);
        } else if (state.chatShouldStickToBottom) {
          scrollChatToBottom({ force: true });
        }

        if (state.activeThreadStarted) hideWelcomeCard();
        else showWelcomeCard();
        updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
        updateScrollToBottomBtn();
      };

      if (!alreadyWindowed || messages.length < prevAll.length) {
        doWindowedRender();
        return;
      }

      state.historyAllMessages = messages;
      if (messages.length === prevAll.length) {
        const a = prevAll[prevAll.length - 1];
        const b = messages[messages.length - 1];
        if (a && b && a.role === b.role && a.kind === b.kind && a.text !== b.text) {
          const updated = (() => {
            if (!box) return false;
            const nodes = box.querySelectorAll(".msg");
            const last = nodes.length ? nodes[nodes.length - 1] : null;
            if (!last) return false;
            if (!last.classList.contains(b.role)) return false;
            const body = last.querySelector(".msgBody");
            if (!body) return false;
            body.innerHTML = renderMessageBody(b.role, b.text);
            return true;
          })();
          if (updated) {
            state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
            state.activeThreadRenderSig = renderSig;
            updateLoadOlderControl();
            if (canStartChatLiveFollow()) scheduleChatLiveFollow(900);
            if (state.activeThreadStarted) hideWelcomeCard();
            else showWelcomeCard();
            updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
            return;
          }
        }
        state.activeThreadRenderSig = renderSig;
        updateLoadOlderControl();
        return;
      }

      if (messages.length > prevAll.length) {
        for (let i = prevAll.length; i < messages.length; i += 1) {
          const msg = messages[i];
          addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
        }
        state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
        state.activeThreadRenderSig = renderSig;
        updateLoadOlderControl();
        if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
        if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100);
        if (state.activeThreadStarted) hideWelcomeCard();
        else showWelcomeCard();
        updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
        updateScrollToBottomBtn();
        return;
      }

      doWindowedRender();
      return;
    }

    if (state.historyWindowEnabled && state.historyWindowThreadId === threadId && messages.length < HISTORY_WINDOW_THRESHOLD) {
      state.historyWindowEnabled = false;
      state.historyWindowThreadId = "";
      state.historyWindowStart = 0;
      state.historyAllMessages = [];
      const wrap = byId("loadOlderWrap");
      if (wrap) wrap.remove();
    }

    const isSamePrefix = (a, b) => {
      if (a.length > b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i].role !== b[i].role) return false;
        if (a[i].kind !== b[i].kind) return false;
        if (a[i].text !== b[i].text) return false;
      }
      return true;
    };

    const updateLastNode = (role, text) => {
      if (!box) return false;
      const nodes = box.querySelectorAll(".msg");
      const last = nodes.length ? nodes[nodes.length - 1] : null;
      if (!last) return false;
      if (!last.classList.contains(role)) return false;
      const body = last.querySelector(".msgBody");
      if (!body) return false;
      body.innerHTML = renderMessageBody(role, text);
      return true;
    };

    if (prevMessages.length && messages.length === prevMessages.length) {
      let allButLastSame = true;
      for (let i = 0; i < prevMessages.length - 1; i += 1) {
        const a = prevMessages[i];
        const b = messages[i];
        if (a.role !== b.role || a.kind !== b.kind || a.text !== b.text) {
          allButLastSame = false;
          break;
        }
      }
      if (allButLastSame && prevMessages.length) {
        const a = prevMessages[prevMessages.length - 1];
        const b = messages[messages.length - 1];
        if (a.role === b.role && a.kind === b.kind && a.text !== b.text) {
          updateLastNode(b.role, b.text);
          state.activeThreadMessages = messages;
          state.activeThreadRenderSig = renderSig;
          if (canStartChatLiveFollow()) scheduleChatLiveFollow(900);
          if (state.activeThreadStarted) hideWelcomeCard();
          else showWelcomeCard();
          updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
          return;
        }
      }
    }

    if (isSamePrefix(prevMessages, messages)) {
      for (let i = prevMessages.length; i < messages.length; i += 1) {
        const msg = messages[i];
        addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
      }
      state.activeThreadMessages = messages;
      state.activeThreadRenderSig = renderSig;
      if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
      if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100);
    } else {
      const shouldAsyncRender = messages.length >= 80 || !!options.slowRender;
      if (shouldAsyncRender) {
        await renderChatFull(messages, { slowRender: !!options.slowRender, preserveScroll: !!state.chatShouldStickToBottom });
      } else {
        clearChatMessages({
          preserveScroll: !!state.chatShouldStickToBottom,
          preservePendingTurn: true,
        });
        for (const msg of messages) {
          addChat(msg.role, msg.text, { scroll: false, kind: msg.kind || "", attachments: msg.images || [] });
        }
      }
      state.activeThreadMessages = messages;
      state.activeThreadRenderSig = renderSig;
      if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
      if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100);
      else if (box) box.scrollTop = box.scrollHeight;
    }

    if (options.stickToBottom) {
      scrollToBottomReliable();
      scheduleChatLiveFollow(1400);
    }

    if (state.activeThreadStarted) hideWelcomeCard();
    else showWelcomeCard();
    updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
    updateScrollToBottomBtn();
  }

  async function loadThreadMessages(threadId, options = {}) {
    if (!threadId) return;
    pushLiveDebugEvent("history.load", {
      threadId: String(threadId || ""),
      forceRender: !!options.forceRender,
      workspace: String(options.workspace || ""),
    });
    if (state.activeThreadHistoryInFlightPromise && state.activeThreadHistoryInFlightThreadId === threadId) {
      queuePendingActiveThreadHistoryRefresh(threadId, options);
      return state.activeThreadHistoryInFlightPromise;
    }
    const reqSeq = (Number(state.activeThreadHistoryReqSeq || 0) + 1) | 0;
    state.activeThreadHistoryReqSeq = reqSeq;
    state.activeThreadLiveLastPollMs = Date.now();
    const loadPromise = (async () => {
      try {
        const e2e = windowRef.__webCodexE2E;
        if (e2e && typeof e2e.getThreadHistory === "function") {
          const seeded = e2e.getThreadHistory(threadId);
          if (seeded) {
            try { windowRef.__webCodexE2E_lastHistorySource = "seed"; } catch {}
            await applyThreadToChat(seeded, options);
            return;
          }
        }
      } catch (e) {
        try {
          if (windowRef.__webCodexE2E) {
            windowRef.__webCodexE2E_seedHistoryError = String(e && e.message ? e.message : e);
          }
        } catch {}
      }

      const limit = Number(options.limit || state.historyWindowSize || 160) || 160;
      const history = await api(buildThreadHistoryUrl(threadId, {
        workspace: options.workspace,
        rolloutPath: options.rolloutPath,
        limit,
      }, state.activeThreadWorkspace), {
        signal: options.signal,
      });
      if (reqSeq !== state.activeThreadHistoryReqSeq) return;
      if (state.activeThreadId && state.activeThreadId !== threadId) return;
      const page = history?.page || {};
      const incomingThread = history?.thread || null;
      const incomingTurns = Array.isArray(incomingThread?.turns) ? incomingThread.turns : [];
      const shouldReplaceTurns = !!page?.incomplete || !!state.activeThreadHistoryIncomplete;
      const mergedTurns = shouldReplaceTurns
        ? incomingTurns
        : mergeHistoryTurns(
            state.activeThreadHistoryThreadId === threadId ? state.activeThreadHistoryTurns : [],
            incomingTurns
          );
      state.activeThreadHistoryTurns = mergedTurns;
      state.activeThreadHistoryThreadId = threadId;
      state.activeThreadHistoryHasMore = !!page?.hasMore;
      state.activeThreadHistoryIncomplete = !!page?.incomplete;
      state.activeThreadHistoryBeforeCursor = String(page?.beforeCursor || "").trim();
      state.activeThreadHistoryTotalTurns = Number(page?.totalTurns || incomingTurns.length || 0) || incomingTurns.length || 0;
      const thread = incomingThread ? { ...incomingThread, turns: mergedTurns, page } : null;
      if (!thread) return;
      try { windowRef.__webCodexE2E_lastHistorySource = "history"; } catch {}
      await applyThreadToChat(thread, { ...options, forceHistoryWindow: !!page?.hasMore });
      pushLiveDebugEvent("history.load:success", {
        threadId: String(threadId || ""),
        workspace: String(options.workspace || state.activeThreadWorkspace || ""),
        turns: mergedTurns.length,
        hasMore: !!page?.hasMore,
      });
    })().catch((error) => {
      pushLiveDebugEvent("history.load:error", {
        threadId: String(threadId || ""),
        workspace: String(options.workspace || state.activeThreadWorkspace || ""),
        message: String(error?.message || error || "").slice(0, 220),
        rolloutPath: String(options.rolloutPath || state.activeThreadRolloutPath || "").slice(0, 220),
      });
      throw error;
    });
    state.activeThreadHistoryInFlightPromise = loadPromise;
    state.activeThreadHistoryInFlightThreadId = threadId;
    try {
      return await loadPromise;
    } finally {
      if (state.activeThreadHistoryInFlightPromise === loadPromise) {
        state.activeThreadHistoryInFlightPromise = null;
        state.activeThreadHistoryInFlightThreadId = "";
        const pending = state.activeThreadHistoryPendingRefresh;
        if (pending && pending.threadId === threadId) {
          state.activeThreadHistoryPendingRefresh = null;
          setTimeoutRef(() => {
            if (state.activeThreadId !== threadId) return;
            loadThreadMessages(threadId, pending).catch(() => {});
          }, 0);
        }
      }
    }
  }

  async function loadOlderHistoryChunk() {
    if (!state.historyWindowEnabled || state.historyWindowLoading) return;
    const box = byId("chatBox");
    if (!box) return;
    const all = Array.isArray(state.historyAllMessages) ? state.historyAllMessages : [];
    const start = Math.max(0, Number(state.historyWindowStart || 0));
    if (!start) return;
    state.historyWindowLoading = true;
    updateLoadOlderControl();
    const nextStart = Math.max(0, start - Math.max(1, Number(state.historyWindowChunk || 0)));
    const slice = all.slice(nextStart, start);
    if (!slice.length) {
      if (state.activeThreadHistoryHasMore && state.activeThreadId) {
        try {
          const page = await api(buildThreadHistoryUrl(state.activeThreadId, {
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
            before: state.activeThreadHistoryBeforeCursor,
            limit: Math.max(1, Number(state.historyWindowChunk || 0)),
          }, state.activeThreadWorkspace));
          const pageMeta = page?.page || {};
          const olderTurns = Array.isArray(page?.thread?.turns) ? page.thread.turns : [];
          const mergedTurns = mergeHistoryTurns(olderTurns, state.activeThreadHistoryTurns);
          state.activeThreadHistoryTurns = mergedTurns;
          state.activeThreadHistoryThreadId = state.activeThreadId;
          state.activeThreadHistoryHasMore = !!pageMeta?.hasMore;
          state.activeThreadHistoryIncomplete = !!pageMeta?.incomplete;
          state.activeThreadHistoryBeforeCursor = String(pageMeta?.beforeCursor || "").trim();
          state.activeThreadHistoryTotalTurns = Number(pageMeta?.totalTurns || mergedTurns.length || 0) || mergedTurns.length || 0;
          await applyThreadToChat({
            ...(page?.thread || {}),
            id: state.activeThreadId,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
            turns: mergedTurns,
            page: pageMeta,
          }, {
            forceRender: true,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
            forceHistoryWindow: !!state.activeThreadHistoryHasMore,
          });
        } finally {
          state.historyWindowLoading = false;
          updateLoadOlderControl();
        }
        return;
      }
      state.historyWindowStart = nextStart;
      state.historyWindowLoading = false;
      updateLoadOlderControl();
      return;
    }

    const prevScrollHeight = box.scrollHeight;
    const frag = documentRef.createDocumentFragment();
    for (const msg of slice) frag.appendChild(buildMsgNode(msg));
    const wrap = ensureLoadOlderControl(box);
    const anchor = wrap ? wrap.nextSibling : box.firstChild;
    box.insertBefore(frag, anchor || null);
    const deltaH = box.scrollHeight - prevScrollHeight;
    box.scrollTop += deltaH;

    state.historyWindowStart = nextStart;
    state.historyWindowLoading = false;
    state.activeThreadMessages = all.slice(nextStart);
    updateLoadOlderControl();
  }

  return {
    applyThreadToChat,
    ensureLoadOlderControl,
    loadOlderHistoryChunk,
    loadThreadMessages,
    mapSessionHistoryMessages,
    mapThreadReadMessages,
    queuePendingActiveThreadHistoryRefresh,
    renderChatFull,
    updateLoadOlderControl,
  };
}
