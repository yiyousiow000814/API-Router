import { buildPlanSignature, clonePlanState, extractPlanUpdate } from "./runtimePlan.js";

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

export function isVisibleAssistantHistoryPhase(phase) {
  const value = String(phase || "").trim().toLowerCase();
  if (!value) return true;
  return value === "final_answer";
}

export function shouldUseHistoryWindow(messages, options = {}, state = {}) {
  if (!Array.isArray(messages)) return false;
  if (options.forceHistoryWindow || state.activeThreadHistoryHasMore) return true;
  if (messages.length < Number(state.HISTORY_WINDOW_THRESHOLD || 0)) return false;
  return true;
}

function cloneArchiveBlock(block) {
  if (!block || typeof block !== "object") return null;
  const text = String(block.text || "").trim();
  const tools = Array.isArray(block.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
  const plan = clonePlanState(block.plan, String(block.threadId || "").trim());
  const summaryOnly = block.summaryOnly === true;
  if (!text && !tools.length && !plan && !summaryOnly) return null;
  const cloned = {
    key: String(block.key || "").trim(),
    text,
    tools,
    plan,
  };
  if (summaryOnly) cloned.summaryOnly = true;
  return cloned;
}

function createSummaryArchiveBlock(plan, tools, threadId, turnId = "", options = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  const snapshot = clonePlanState(plan, normalizedThreadId);
  const normalizedTools = Array.isArray(tools)
    ? tools.map((tool) => String(tool || "").trim()).filter(Boolean)
    : [];
  const allowEmpty = options.allowEmpty === true;
  if (!snapshot && !normalizedTools.length && !allowEmpty) return null;
  const seed = String(snapshot?.turnId || turnId || normalizedThreadId || "summary").trim() || "summary";
  const block = {
    key: `commentary-summary:${seed}`,
    text: "",
    tools: normalizedTools,
    plan: snapshot,
  };
  if (!snapshot && !normalizedTools.length) block.summaryOnly = true;
  return block;
}

function finalizeArchiveBlocks(currentBlocks, currentBlock, hasFinalAssistant) {
  const blocks = Array.isArray(currentBlocks) ? currentBlocks.slice() : [];
  const clonedCurrent = cloneArchiveBlock(currentBlock);
  if (clonedCurrent) blocks.push(clonedCurrent);
  if (!hasFinalAssistant || !blocks.length) return [];
  return blocks;
}

function buildCommentaryArchiveSignature(blocks) {
  const archive = Array.isArray(blocks) ? blocks : [];
  return archive
    .map((block) => [
      buildPlanSignature(block?.plan),
      String(block?.key || "").trim(),
      String(block?.text || "").trim(),
      ...(Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()) : []),
    ].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

function buildCommentaryArchiveMessage(turnId, blocks) {
  const archive = Array.isArray(blocks) ? blocks.map((block) => cloneArchiveBlock(block)).filter(Boolean) : [];
  if (!archive.length) return null;
  return {
    role: "system",
    kind: "commentaryArchive",
    text: buildCommentaryArchiveSignature(archive),
    archiveKey: String(turnId || "").trim() || `commentary-archive-${archive.length}`,
    archiveBlocks: archive,
  };
}

function updateArchiveBlock(block, item, nextText) {
  const toolText = String(nextText || "").trim();
  if (!toolText && !String(block?.text || "").trim() && !clonePlanState(block?.plan)) return block;
  const nextBlock = block && typeof block === "object"
    ? {
        key: String(block.key || "").trim(),
        text: String(block.text || "").trim(),
        tools: Array.isArray(block.tools) ? block.tools.slice() : [],
        plan: clonePlanState(block.plan),
      }
    : {
        key: String(item?.id || item?.messageId || item?.message_id || "").trim(),
        text: "",
        tools: [],
        plan: null,
      };
  if (toolText) nextBlock.text = toolText;
  return nextBlock;
}

export function extractLatestCommentaryState(thread, helpers = {}) {
  const normalizeThreadItemText =
    typeof helpers.normalizeThreadItemText === "function"
      ? helpers.normalizeThreadItemText
      : () => "";
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let latestState = {
    current: null,
    archive: [],
    visible: false,
  };

  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    let blocks = [];
    let currentBlock = null;
    let hasFinalAssistant = false;
    let pendingPlan = null;
    let pendingTools = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const type = String(item.type || "").trim();
      if (!type || type === "userMessage") continue;
      const planUpdate = extractPlanUpdate(item, { threadId: String(thread?.id || "").trim() });
      if (planUpdate) {
        if (currentBlock) currentBlock = { ...currentBlock, plan: clonePlanState(planUpdate, String(thread?.id || "").trim()) };
        else pendingPlan = clonePlanState(planUpdate, String(thread?.id || "").trim());
        continue;
      }
      if (type === "agentMessage" || type === "assistantMessage") {
        const phase = String(item.phase || "").trim().toLowerCase();
        const text = String(normalizeThreadItemText(item) || "").trim();
        if (!text) continue;
        if (!phase || phase === "final_answer") {
          hasFinalAssistant = true;
          continue;
        }
        if (currentBlock) {
          const finalized = cloneArchiveBlock(currentBlock);
          if (finalized) blocks.push(finalized);
        }
        currentBlock = updateArchiveBlock(
          {
            key: String(item.id || item.messageId || item.message_id || text.slice(0, 80)).trim(),
            text: "",
            tools: pendingTools,
            plan: pendingPlan,
          },
          item,
          text
        );
        pendingPlan = null;
        pendingTools = [];
        continue;
      }
      const toolText = String(normalizeThreadItemText(item, { compact: true }) || "").trim();
      if (!toolText) continue;
      if (!currentBlock) {
        pendingTools = [...pendingTools, toolText];
        continue;
      }
      currentBlock = {
        ...currentBlock,
        tools: [...(Array.isArray(currentBlock.tools) ? currentBlock.tools : []), toolText],
      };
    }

    const trailingPlanOnlyBlock =
      !currentBlock && hasFinalAssistant
        ? createSummaryArchiveBlock(
            pendingPlan,
            pendingTools,
            String(thread?.id || "").trim(),
            String(turn?.id || "").trim()
          )
        : null;
    const archive = finalizeArchiveBlocks(blocks, trailingPlanOnlyBlock || currentBlock, hasFinalAssistant);
    latestState = {
      current: hasFinalAssistant ? null : cloneArchiveBlock(currentBlock),
      archive,
      visible: hasFinalAssistant && archive.length > 0,
    };
  }

  return latestState;
}

export function extractLatestCommentaryArchive(thread, helpers = {}) {
  return extractLatestCommentaryState(thread, helpers).archive;
}

function messageMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind && a.text === b.text;
}

export function mergePendingLiveMessages(messages, state = {}, threadId = "", options = {}) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  if (!pendingThreadId || !threadId || pendingThreadId !== threadId) return out;

  const pendingUser = String(state.activeThreadPendingUserMessage || "");
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "");
  const hasPendingUser = !!pendingUser.trim();
  const hasPendingAssistant = !!pendingAssistant.trim();
  const historyIncomplete =
    options.historyIncomplete === true ||
    (options.historyIncomplete == null && state.activeThreadHistoryIncomplete === true);
  const keepPendingUserFallback =
    hasPendingUser &&
    !hasPendingAssistant &&
    state.activeThreadPendingTurnRunning === true;
  const pending = [];
  if (hasPendingUser) pending.push({ role: "user", text: pendingUser, kind: "" });
  if (hasPendingAssistant) pending.push({ role: "assistant", text: pendingAssistant, kind: "" });
  if (!pending.length) return out;

  const endsWithPending =
    pending.length <= out.length &&
    pending.every((msg, index) => messageMatches(out[out.length - pending.length + index], msg));
  if (endsWithPending) {
    if ((hasPendingAssistant && !historyIncomplete) || !hasPendingUser) {
      state.activeThreadPendingTurnThreadId = "";
      state.activeThreadPendingTurnRunning = false;
      state.activeThreadPendingUserMessage = "";
      state.activeThreadPendingAssistantMessage = "";
    } else if (!keepPendingUserFallback) {
      state.activeThreadPendingUserMessage = "";
    } else {
      state.activeThreadPendingUserMessage = pendingUser;
    }
    return out;
  }

  let appendFrom = 0;
  if (pending.length >= 1 && out.length >= 1 && messageMatches(out[out.length - 1], pending[0])) {
    appendFrom = 1;
  }
  return out.concat(pending.slice(appendFrom));
}

export function buildHistoryRenderSig(threadId, turns, messages) {
  let hash = 2166136261;
  const pushChunk = (value) => {
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= 124;
    hash = Math.imul(hash, 16777619) >>> 0;
  };
  pushChunk(threadId);
  pushChunk(Array.isArray(turns) ? turns.length : 0);
  const items = Array.isArray(messages) ? messages : [];
  pushChunk(items.length);
  for (const message of items) {
    pushChunk(message?.role || "");
    pushChunk(message?.kind || "");
    pushChunk(message?.text || "");
    pushChunk(message?.archiveKey || "");
  }
  return `${String(threadId || "")}::${hash.toString(16)}`;
}

export function findLatestIncompleteToolMessage(thread, normalizeThreadItemText) {
  const page = thread?.page || {};
  if (!page?.incomplete) return "";
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const type = String(item?.type || "").trim();
    if (!type || type === "userMessage" || type === "assistantMessage" || type === "agentMessage") continue;
    const text = typeof normalizeThreadItemText === "function" ? normalizeThreadItemText(item, { compact: true }) : "";
    if (text) return text;
  }
  return "";
}

function syncPendingTurnStateFromIncompleteHistory(thread, state = {}) {
  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
  const pendingUser = String(state.activeThreadPendingUserMessage || "").trim();
  const pendingAssistant = String(state.activeThreadPendingAssistantMessage || "").trim();
  const pageIncomplete = !!thread?.page?.incomplete;
  if (!threadId) return;
  if (!pageIncomplete) {
    if (pendingThreadId && pendingThreadId === threadId && !pendingUser && !pendingAssistant) {
      state.activeThreadPendingTurnThreadId = "";
      state.activeThreadPendingTurnId = "";
      state.activeThreadPendingTurnRunning = false;
    }
    return;
  }
  if (pendingThreadId && pendingThreadId !== threadId) return;
  if (pendingThreadId === threadId && (pendingUser || pendingAssistant)) {
    state.activeThreadPendingTurnRunning = true;
    return;
  }
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const lastTurnId = String(lastTurn?.id || "").trim();
  state.activeThreadPendingTurnThreadId = threadId;
  state.activeThreadPendingTurnId = lastTurnId;
  state.activeThreadPendingTurnRunning = true;
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
    showTransientToolMessage = () => {},
    showTransientThinkingMessage = () => {},
    clearTransientToolMessages = () => {},
    clearTransientThinkingMessages = () => {},
    clearRuntimeState = () => {},
    renderCommentaryArchive = () => {},
    syncRuntimeStateFromHistory = () => {},
    syncEventSubscription = () => {},
  } = deps;

  function isSupersededHistoryApply(threadId, options = {}) {
    const requestSeq = Math.max(0, Number(options.historyReqSeq || 0));
    if (requestSeq > 0 && requestSeq !== Math.max(0, Number(state.activeThreadHistoryReqSeq || 0))) {
      pushLiveDebugEvent("history.apply:drop_stale_req", {
        threadId: String(threadId || state.activeThreadId || "").trim(),
        requestSeq,
        activeRequestSeq: Math.max(0, Number(state.activeThreadHistoryReqSeq || 0)),
      });
      return true;
    }
    if (threadId && state.activeThreadId && state.activeThreadId !== threadId) {
      pushLiveDebugEvent("history.apply:drop_thread_mismatch", {
        threadId: String(threadId || "").trim(),
        activeThreadId: String(state.activeThreadId || "").trim(),
      });
      return true;
    }
    return false;
  }

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

  function syncIncompleteToolMessage(thread) {
    if (shouldSuppressStalePendingHistoryLiveState(thread)) {
      clearRuntimeState();
      clearTransientToolMessages();
      pushLiveDebugEvent("history.runtime:suppress_stale_pending", {
        threadId: String(thread?.id || state.activeThreadId || "").trim(),
        promptChars: String(state.activeThreadPendingUserMessage || "").trim().length,
      });
      return;
    }
    syncPendingTurnStateFromIncompleteHistory(thread, state);
    syncRuntimeStateFromHistory(thread);
    if (
      (Array.isArray(state.activeThreadActiveCommands) && state.activeThreadActiveCommands.length > 0) ||
      state.activeThreadPlan ||
      state.activeThreadActivity
    ) {
      clearTransientToolMessages();
      return;
    }
    const text = findLatestIncompleteToolMessage(thread, normalizeThreadItemText);
    if (text) showTransientToolMessage(text);
    else clearTransientToolMessages();
  }

  function cloneCommentaryBlock(block) {
    if (!block || typeof block !== "object") return null;
    return {
      threadId: String(block.threadId || "").trim(),
      key: String(block.key || "").trim(),
      text: String(block.text || ""),
      tools: Array.isArray(block.tools) ? block.tools.map((tool) => String(tool || "")) : [],
      toolKeys: Array.isArray(block.toolKeys) ? block.toolKeys.map((tool) => String(tool || "")) : [],
      plan: clonePlanState(block.plan, String(block.threadId || "").trim()),
    };
  }

  function readLiveStateEpoch() {
    return Math.max(0, Number(state.activeThreadLiveStateEpoch || 0));
  }

  function latestTurnContainsPendingUserEcho(thread) {
    const threadId = String(thread?.id || state.activeThreadId || "").trim();
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
    if (!threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
    if (!pendingPrompt) return false;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
    for (const item of items) {
      if (String(item?.type || "").trim() !== "userMessage") continue;
      const parsed = parseUserMessageParts(item);
      const text = String(parsed?.text || "").trim();
      if (text && text === pendingPrompt) return true;
    }
    return false;
  }

  function shouldSuppressStalePendingHistoryLiveState(thread) {
    const threadId = String(thread?.id || state.activeThreadId || "").trim();
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const pendingRunning = state.activeThreadPendingTurnRunning === true;
    if (!pendingRunning || !threadId || !pendingThreadId || pendingThreadId !== threadId) return false;
    if (latestTurnContainsPendingUserEcho(thread) === true) return false;
    const pendingPrompt = String(state.activeThreadPendingUserMessage || "").trim();
    if (pendingPrompt) return true;
    const baselineTurnCount = Math.max(0, Number(state.activeThreadPendingTurnBaselineTurnCount || 0));
    const incomingTurnCount = Array.isArray(thread?.turns) ? thread.turns.length : 0;
    return incomingTurnCount <= baselineTurnCount;
  }

  function createCommentarySnapshotFromHistory(thread, commentaryState) {
    if (!commentaryState || typeof commentaryState !== "object") return null;
    const threadId = String(thread?.id || state.activeThreadId || "").trim();
    const current = cloneArchiveBlock(commentaryState.current);
    const archive = Array.isArray(commentaryState.archive)
      ? commentaryState.archive.map((block) => cloneArchiveBlock(block)).filter(Boolean)
      : [];
    const visible = commentaryState.visible === true && archive.length > 0;
    if (!current && !archive.length && !visible) return null;
    return {
      current: current
        ? {
            threadId,
            key: String(current.key || "").trim(),
            text: String(current.text || ""),
            tools: Array.isArray(current.tools) ? current.tools.slice() : [],
            toolKeys: [],
            plan: clonePlanState(current.plan, threadId),
          }
        : null,
      archive: archive.map((block) => ({
        threadId,
        key: String(block.key || "").trim(),
        text: String(block.text || ""),
        tools: Array.isArray(block.tools) ? block.tools.slice() : [],
        toolKeys: [],
        plan: clonePlanState(block.plan, threadId),
      })),
      visible,
      expanded: false,
    };
  }

  function captureLiveCommentarySnapshot(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    const current = cloneCommentaryBlock(state.activeThreadCommentaryCurrent);
    const currentThreadId = String(current?.threadId || normalizedThreadId).trim();
    const matchesThread = !!current && (!normalizedThreadId || !currentThreadId || currentThreadId === normalizedThreadId);
    const archive = Array.isArray(state.activeThreadCommentaryArchive)
      ? state.activeThreadCommentaryArchive.map((block) => cloneCommentaryBlock(block)).filter(Boolean)
      : [];
    if (!matchesThread && !archive.length && state.activeThreadCommentaryArchiveVisible !== true) return null;
    return {
      epoch: readLiveStateEpoch(),
      current: matchesThread ? { ...current, threadId: currentThreadId || normalizedThreadId } : null,
      archive,
      visible: state.activeThreadCommentaryArchiveVisible === true,
      expanded: state.activeThreadCommentaryArchiveExpanded === true,
    };
  }

  function restoreLiveCommentarySnapshot(snapshot, thread, options = {}) {
    const historySnapshot = createCommentarySnapshotFromHistory(thread, options.historyCommentary);
    const suppressStalePendingHistory = shouldSuppressStalePendingHistoryLiveState(thread);
    if (suppressStalePendingHistory && historySnapshot?.current) {
      pushLiveDebugEvent("history.commentary:suppress_stale_pending", {
        threadId: String(thread?.id || state.activeThreadId || "").trim(),
        key: String(historySnapshot.current.key || "").trim(),
        chars: String(historySnapshot.current.text || "").length,
      });
      historySnapshot.current = null;
    }
    let effectiveSnapshot = snapshot
      && Math.max(0, Number(snapshot.epoch || 0)) === readLiveStateEpoch()
      ? {
          current: snapshot.current ? cloneCommentaryBlock(snapshot.current) : null,
          archive: Array.isArray(snapshot.archive)
            ? snapshot.archive.map((block) => cloneCommentaryBlock(block)).filter(Boolean)
            : [],
          visible: snapshot.visible === true,
          expanded: snapshot.expanded === true,
        }
      : null;
    if (snapshot && !effectiveSnapshot) {
      pushLiveDebugEvent("history.commentary:drop_stale_snapshot", {
        threadId: String(thread?.id || state.activeThreadId || "").trim(),
        snapshotEpoch: Math.max(0, Number(snapshot.epoch || 0)),
        currentEpoch: readLiveStateEpoch(),
        key: String(snapshot.current?.key || "").trim(),
      });
    }
    if (!effectiveSnapshot && historySnapshot) {
      effectiveSnapshot = historySnapshot;
    } else if (effectiveSnapshot && historySnapshot) {
      const historyCurrent = historySnapshot.current ? cloneCommentaryBlock(historySnapshot.current) : null;
      const effectiveCurrent = effectiveSnapshot.current ? cloneCommentaryBlock(effectiveSnapshot.current) : null;
      const historyCurrentKey = String(historyCurrent?.key || "").trim();
      const effectiveCurrentKey = String(effectiveCurrent?.key || "").trim();
      const historyCurrentText = String(historyCurrent?.text || "");
      const effectiveCurrentText = String(effectiveCurrent?.text || "");
      const historyCurrentTools = JSON.stringify(Array.isArray(historyCurrent?.tools) ? historyCurrent.tools : []);
      const effectiveCurrentTools = JSON.stringify(Array.isArray(effectiveCurrent?.tools) ? effectiveCurrent.tools : []);
      const shouldReplaceCurrent =
        !!historyCurrent &&
        (
          !effectiveCurrent ||
          historyCurrentKey !== effectiveCurrentKey ||
          historyCurrentText !== effectiveCurrentText ||
          historyCurrentTools !== effectiveCurrentTools
        );
      if (shouldReplaceCurrent) {
        effectiveSnapshot.current = historyCurrent;
        effectiveSnapshot.archive = historySnapshot.archive;
        effectiveSnapshot.visible = false;
        effectiveSnapshot.expanded = false;
        pushLiveDebugEvent(
          effectiveCurrent
            ? "history.commentary:replace_current"
            : "history.commentary:promote_current",
          {
            threadId: String(thread?.id || state.activeThreadId || ""),
            archiveCount: historySnapshot.archive.length,
            chars: historyCurrentText.length,
            previousKey: effectiveCurrentKey,
            nextKey: historyCurrentKey,
          }
        );
      }
      const shouldClearCurrent =
        !historyCurrent &&
        !!effectiveCurrent &&
        (
          historySnapshot.visible === true ||
          suppressStalePendingHistory ||
          !thread?.page?.incomplete
        );
      if (shouldClearCurrent) {
        effectiveSnapshot.current = null;
        effectiveSnapshot.archive = historySnapshot.archive;
        effectiveSnapshot.visible = historySnapshot.visible === true;
        effectiveSnapshot.expanded = false;
        pushLiveDebugEvent("history.commentary:clear_current", {
          threadId: String(thread?.id || state.activeThreadId || ""),
          archiveCount: historySnapshot.archive.length,
          previousKey: effectiveCurrentKey,
          stalePending: suppressStalePendingHistory === true,
          historyVisible: historySnapshot.visible === true,
          incomplete: !!thread?.page?.incomplete,
        });
      }
      if (historySnapshot.archive.length > effectiveSnapshot.archive.length) {
        effectiveSnapshot.archive = historySnapshot.archive;
      }
      if (!effectiveSnapshot.visible && historySnapshot.visible) {
        effectiveSnapshot.visible = true;
      }
      if (effectiveSnapshot.visible !== true) {
        effectiveSnapshot.expanded = false;
      }
    }
    if (effectiveSnapshot) {
      state.activeThreadCommentaryCurrent = effectiveSnapshot.current;
      state.activeThreadCommentaryArchive = effectiveSnapshot.archive;
      state.activeThreadCommentaryArchiveVisible = effectiveSnapshot.visible === true;
      state.activeThreadCommentaryArchiveExpanded =
        effectiveSnapshot.visible === true && effectiveSnapshot.expanded === true;
    } else {
      state.activeThreadCommentaryCurrent = null;
      state.activeThreadCommentaryArchive = [];
      state.activeThreadCommentaryArchiveVisible = false;
      state.activeThreadCommentaryArchiveExpanded = false;
    }
    if (String(state.activeThreadCommentaryCurrent?.text || "").trim()) {
      showTransientThinkingMessage(state.activeThreadCommentaryCurrent.text);
    } else {
      clearTransientThinkingMessages();
    }
    const box = byId("chatBox");
    const assistantNodes = Array.from(box?.querySelectorAll?.(".assistant") || []);
    const anchorNode = assistantNodes.length ? assistantNodes[assistantNodes.length - 1] : null;
    renderCommentaryArchive(anchorNode ? { anchorNode } : {});
    syncIncompleteToolMessage(thread);
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
      let commentaryBlocks = [];
      let currentCommentaryBlock = null;
      let pendingPlan = null;
      let pendingTools = [];
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
        const planUpdate = extractPlanUpdate(item, { threadId: String(thread?.id || "").trim() });
        if (planUpdate) {
          if (currentCommentaryBlock) {
            currentCommentaryBlock = {
              ...currentCommentaryBlock,
              plan: clonePlanState(planUpdate, String(thread?.id || "").trim()),
            };
          } else {
            pendingPlan = clonePlanState(planUpdate, String(thread?.id || "").trim());
          }
          continue;
        }
        const text = normalizeThreadItemText(item);
        if (type === "agentMessage" || type === "assistantMessage") {
          const phase = String(item?.phase || "").trim().toLowerCase();
          if (phase && phase !== "final_answer") {
            if (currentCommentaryBlock) {
              const finalized = cloneArchiveBlock(currentCommentaryBlock);
              if (finalized) commentaryBlocks.push(finalized);
            }
            currentCommentaryBlock = updateArchiveBlock(
              {
                key: String(item.id || item.messageId || item.message_id || text.slice(0, 80)).trim(),
                text: "",
                tools: pendingTools,
                plan: pendingPlan,
              },
              item,
              text
            );
            pendingPlan = null;
            pendingTools = [];
            continue;
          }
          if (!text) continue;
          const trailingPlanOnlyBlock =
            !currentCommentaryBlock
              ? createSummaryArchiveBlock(
                  pendingPlan,
                  pendingTools,
                  String(thread?.id || "").trim(),
                  String(turn?.id || "").trim(),
                  { allowEmpty: commentaryBlocks.length === 0 }
                )
              : null;
          const archiveMessage = buildCommentaryArchiveMessage(
            turn?.id,
            finalizeArchiveBlocks(commentaryBlocks, trailingPlanOnlyBlock || currentCommentaryBlock, true)
          );
          if (archiveMessage) messages.push(archiveMessage);
          commentaryBlocks = [];
          currentCommentaryBlock = null;
          pendingPlan = null;
          if (!isVisibleAssistantHistoryPhase(item?.phase)) continue;
          messages.push({ role: "assistant", text, kind: "" });
          continue;
        }
        const toolText = String(normalizeThreadItemText(item, { compact: true }) || "").trim();
        if (!toolText) continue;
        if (!currentCommentaryBlock) {
          pendingTools = [...pendingTools, toolText];
          continue;
        }
        currentCommentaryBlock = {
          ...currentCommentaryBlock,
          tools: [...(Array.isArray(currentCommentaryBlock.tools) ? currentCommentaryBlock.tools : []), toolText],
        };
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
        if (!isVisibleAssistantHistoryPhase(item.phase)) continue;
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
    state.activeThreadInlineCommentaryArchiveCount = messages.filter((message) => message?.kind === "commentaryArchive").length;
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
    const threadId = String(thread?.id || state.activeThreadId || "");
    pushLiveDebugEvent("history.apply", {
      threadId,
      forceRender: !!options.forceRender,
      historyItems: Array.isArray(thread?.historyItems) ? thread.historyItems.length : 0,
      turns: Array.isArray(thread?.turns) ? thread.turns.length : 0,
      pendingThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      pendingUser: String(state.activeThreadPendingUserMessage || ""),
      pendingAssistant: String(state.activeThreadPendingAssistantMessage || ""),
    });
    if (isSupersededHistoryApply(threadId, options)) return;
    if (options.stickToBottom) {
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
    }
    const historyItems = Array.isArray(thread?.historyItems) ? thread.historyItems : [];
    const rawMessages = historyItems.length
      ? await mapSessionHistoryMessages(historyItems)
      : await mapThreadReadMessages(thread);
    if (isSupersededHistoryApply(threadId, options)) return;
    const historyCommentary = extractLatestCommentaryState(thread, { normalizeThreadItemText });
    const messages = mergePendingLiveMessages(rawMessages, state, threadId, {
      historyIncomplete: thread?.page?.incomplete === true,
    });
    const inlineCommentaryArchiveCount = messages.filter((message) => message?.kind === "commentaryArchive").length;
    state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
    const liveCommentarySnapshot = captureLiveCommentarySnapshot(threadId);
    const toolCount = messages.filter((message) => message?.role === "system" && message?.kind === "tool").length;
    pushLiveDebugEvent("history.receive", {
      threadId,
      turns: Array.isArray(thread?.turns) ? thread.turns.length : 0,
      messages: messages.length,
      toolMessages: toolCount,
      historyItems: historyItems.length,
    });
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    state.activeThreadTokenUsage = normalizeThreadTokenUsage(thread?.tokenUsage);
    renderComposerContextLeft();
    const renderSig = buildHistoryRenderSig(
      String(thread?.id || state.activeThreadId || ""),
      turns,
      messages
    );
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
      state.activeThreadMessages = messages;
      pushLiveDebugEvent("history.render:unchanged", {
        threadId,
        messages: messages.length,
        toolMessages: toolCount,
      });
      if (state.activeThreadStarted) hideWelcomeCard();
      else showWelcomeCard();
      updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
      restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
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
        clearChatMessages({
          preservePendingTurn: true,
          preserveScroll: !state.chatShouldStickToBottom && prevMessages.length > 0,
        });
        state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
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
        pushLiveDebugEvent("history.render:window", {
          threadId,
          messages: slice.length,
          start,
          totalMessages: messages.length,
          toolMessages: slice.filter((message) => message?.role === "system" && message?.kind === "tool").length,
        });
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
        restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
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
            body.innerHTML = renderMessageBody(b.role, b.text, { kind: b.kind || "" });
            return true;
          })();
          if (updated) {
            state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
            state.activeThreadRenderSig = renderSig;
            pushLiveDebugEvent("history.render:update_last", {
              threadId,
              messages: messages.length,
              toolMessages: toolCount,
            });
            updateLoadOlderControl();
            if (canStartChatLiveFollow()) scheduleChatLiveFollow(900);
            if (state.activeThreadStarted) hideWelcomeCard();
            else showWelcomeCard();
            updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
            restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
            return;
          }
        }
        state.activeThreadRenderSig = renderSig;
        restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
        updateLoadOlderControl();
        return;
      }

      if (messages.length > prevAll.length) {
        for (let i = prevAll.length; i < messages.length; i += 1) {
          const msg = messages[i];
          addChat(msg.role, msg.text, {
            scroll: false,
            kind: msg.kind || "",
            attachments: msg.images || [],
            archiveBlocks: msg.archiveBlocks || [],
            archiveKey: msg.archiveKey || "",
          });
        }
        state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
        state.activeThreadRenderSig = renderSig;
        pushLiveDebugEvent("history.render:append", {
          threadId,
          appended: messages.length - prevAll.length,
          messages: messages.length,
          toolMessages: toolCount,
        });
        updateLoadOlderControl();
        if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
        if (canStartChatLiveFollow()) scheduleChatLiveFollow(1100);
        if (state.activeThreadStarted) hideWelcomeCard();
        else showWelcomeCard();
        updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
        restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
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

    const updateLastNode = (role, text, kind = "") => {
      if (!box) return false;
      const nodes = box.querySelectorAll(".msg");
      const last = nodes.length ? nodes[nodes.length - 1] : null;
      if (!last) return false;
      if (!last.classList.contains(role)) return false;
      const body = last.querySelector(".msgBody");
      if (!body) return false;
      body.innerHTML = renderMessageBody(role, text, { kind });
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
          updateLastNode(b.role, b.text, b.kind || "");
          state.activeThreadMessages = messages;
          state.activeThreadRenderSig = renderSig;
          pushLiveDebugEvent("history.render:update_last", {
            threadId,
            messages: messages.length,
            toolMessages: toolCount,
          });
          if (canStartChatLiveFollow()) scheduleChatLiveFollow(900);
          if (state.activeThreadStarted) hideWelcomeCard();
          else showWelcomeCard();
          updateHeaderUi(Boolean(options.animateBadge && state.activeThreadStarted));
          restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
          return;
        }
      }
    }

    if (isSamePrefix(prevMessages, messages)) {
      for (let i = prevMessages.length; i < messages.length; i += 1) {
        const msg = messages[i];
        addChat(msg.role, msg.text, {
          scroll: false,
          kind: msg.kind || "",
          attachments: msg.images || [],
          archiveBlocks: msg.archiveBlocks || [],
          archiveKey: msg.archiveKey || "",
        });
      }
      state.activeThreadMessages = messages;
      state.activeThreadRenderSig = renderSig;
      pushLiveDebugEvent("history.render:append", {
        threadId,
        appended: messages.length - prevMessages.length,
        messages: messages.length,
        toolMessages: toolCount,
      });
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
        state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
        for (const msg of messages) {
          addChat(msg.role, msg.text, {
            scroll: false,
            kind: msg.kind || "",
            attachments: msg.images || [],
            archiveBlocks: msg.archiveBlocks || [],
            archiveKey: msg.archiveKey || "",
          });
        }
      }
      state.activeThreadMessages = messages;
      state.activeThreadRenderSig = renderSig;
      pushLiveDebugEvent("history.render:full", {
        threadId,
        messages: messages.length,
        toolMessages: toolCount,
        async: shouldAsyncRender,
      });
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
    restoreLiveCommentarySnapshot(liveCommentarySnapshot, thread, { historyCommentary });
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
      await applyThreadToChat(thread, {
        ...options,
        forceHistoryWindow: !!page?.hasMore,
        historyReqSeq: reqSeq,
      });
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
