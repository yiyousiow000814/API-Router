import { summarizeChatTimeline } from "./chatTimeline.js";
import { decideHistoryRenderStrategy } from "./historyRenderStrategy.js";
import { reconcileTimelineMessages } from "./historyTimelineReconcile.js";

function canReplayAssistantHistory({ state, threadId, forceFullRender, previousMessages }) {
  if (forceFullRender) return false;
  if (String(state?.activeThreadId || threadId || "").trim() !== String(threadId || "").trim()) return false;
  if (!String(state?.activeThreadRolloutPath || "").trim()) return false;
  if (state?.chatOpening === true) return false;
  if (!Array.isArray(previousMessages) || previousMessages.length <= 0) return true;
  return state?.activeThreadStarted === true;
}

function isReplayableAssistantMessage(message) {
  return (
    String(message?.role || "").trim() === "assistant" &&
    !String(message?.kind || "").trim() &&
    String(message?.text || "").length > 0
  );
}

function maybeReplayAssistantHistoryMessage(node, message, replayContext = {}, options = {}) {
  if (!replayContext.enabled) return false;
  if (!isReplayableAssistantMessage(message)) return false;
  if (typeof replayContext.replayAssistantHistoryMessage !== "function") return false;
  return replayContext.replayAssistantHistoryMessage(node, message, {
    fromText: String(options.fromText || ""),
  });
}

function appendMessages(messages, startIndex, addChat, replayContext = {}) {
  for (let i = startIndex; i < messages.length; i += 1) {
    const msg = messages[i];
    const node = addChat(msg.role, msg.text, {
      scroll: false,
      messageKey: String(msg.id || msg.messageKey || "").trim(),
      kind: msg.kind || "",
      attachments: msg.images || [],
      archiveBlocks: msg.archiveBlocks || [],
      archiveKey: msg.archiveKey || "",
      source: "historyRender",
    });
    maybeReplayAssistantHistoryMessage(node, msg, replayContext, { fromText: "" });
  }
}

function updateLastNode(box, message, renderMessageBody) {
  if (!box) return false;
  const role = String(message?.role || "").trim();
  const text = String(message?.text || "");
  const kind = String(message?.kind || "").trim();
  const nodes = box.querySelectorAll(".msg");
  const last = nodes.length ? nodes[nodes.length - 1] : null;
  if (!last) return false;
  if (!last.classList.contains(role)) return false;
  const body = last.querySelector(".msgBody");
  if (!body) return false;
  body.innerHTML = renderMessageBody(role, text, { kind });
  const messageKey = String(message?.id || message?.messageKey || "").trim();
  if (messageKey) {
    last.setAttribute?.("data-msg-key", messageKey);
    last.setAttribute?.("data-msg-id", messageKey);
  }
  return last;
}

function snapshotTimeline(box, byId) {
  const target = box || (typeof byId === "function" ? byId("chatBox") : null);
  return target ? summarizeChatTimeline(target) : null;
}

export function applyWindowedHistoryRender(params = {}) {
  const {
    state,
    threadId,
    messages,
    prevAll,
    prevMessages,
    box,
    preservedScrollTop,
    inlineCommentaryArchiveCount,
    renderSig,
    toolCount,
    forceFullRender = false,
    options,
    historyCommentary,
    liveCommentarySnapshot,
    deps = {},
  } = params;
  const {
    clearChatMessages,
    documentRef,
    buildMsgNode,
    byId,
    ensureLoadOlderControl,
    updateLoadOlderControl,
    renderMessageBody,
    addChat,
    pushLiveDebugEvent,
    scrollToBottomReliable,
    scheduleChatLiveFollow,
    scrollChatToBottom,
    maybeScheduleChatFollow,
    replayAssistantHistoryMessage,
    finalizeThreadRenderEffects,
  } = deps;
  const alreadyWindowed = state.historyWindowEnabled && state.historyWindowThreadId === threadId;
  const replayContext = {
    enabled: canReplayAssistantHistory({
      state,
      threadId,
      forceFullRender,
      previousMessages: prevMessages,
    }),
    replayAssistantHistoryMessage,
  };

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
    const nextBox = byId("chatBox");
    if (nextBox) {
      if (start > 0 || state.activeThreadHistoryHasMore) ensureLoadOlderControl(nextBox);
      nextBox.appendChild(frag);
      if (preservedScrollTop !== null) {
        const maxTop = Math.max(0, Number(nextBox.scrollHeight || 0) - Number(nextBox.clientHeight || 0));
        nextBox.scrollTop = Math.min(preservedScrollTop, maxTop);
      }
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

    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot, {
      updateScrollButton: true,
    });
  };

  const strategy = decideHistoryRenderStrategy({
    previousMessages: prevAll,
    nextMessages: messages,
    windowed: true,
    alreadyWindowed,
  });

  if (forceFullRender || strategy === "window_full") {
    doWindowedRender();
    return true;
  }

  state.historyAllMessages = messages;
  const visibleMessages = messages.slice(Number(state.historyWindowStart || 0));
  const commentaryArchivePatch = !forceFullRender && alreadyWindowed
    ? reconcileTimelineMessages({
        box,
        previousMessages: prevMessages,
        nextMessages: visibleMessages,
        buildMsgNode,
        renderMessageBody,
        replayMessage: (node, message, options = {}) =>
          maybeReplayAssistantHistoryMessage(node, message, replayContext, options),
      })
    : null;
  if (commentaryArchivePatch) {
    state.activeThreadMessages = visibleMessages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:archive_patch", {
      threadId,
      inserted: commentaryArchivePatch.inserted,
      updated: commentaryArchivePatch.updated,
      messages: visibleMessages.length,
      toolMessages: toolCount,
      timeline: snapshotTimeline(box, byId),
    });
    updateLoadOlderControl();
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    maybeScheduleChatFollow(1100);
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot, {
      updateScrollButton: true,
    });
    return true;
  }
  if (strategy === "window_unchanged") {
    state.activeThreadRenderSig = renderSig;
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot);
    updateLoadOlderControl();
    return true;
  }

  if (strategy === "window_update_last") {
    const nextLast = messages[messages.length - 1];
    const updated = updateLastNode(box, nextLast, renderMessageBody);
    if (updated) {
      const previousLast = prevAll[prevAll.length - 1];
      maybeReplayAssistantHistoryMessage(updated, nextLast, replayContext, {
        fromText: previousLast?.text,
      });
      state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
      state.activeThreadRenderSig = renderSig;
      pushLiveDebugEvent("history.render:update_last", {
        threadId,
        messages: messages.length,
        toolMessages: toolCount,
        timeline: snapshotTimeline(box, byId),
      });
      updateLoadOlderControl();
      maybeScheduleChatFollow(900);
      finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot);
      return true;
    }
    doWindowedRender();
    return true;
  }

  if (strategy === "window_append") {
    appendMessages(messages, prevAll.length, addChat, replayContext);
    state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:append", {
      threadId,
      appended: messages.length - prevAll.length,
      messages: messages.length,
      toolMessages: toolCount,
      timeline: snapshotTimeline(box, byId),
    });
    updateLoadOlderControl();
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    maybeScheduleChatFollow(1100);
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot, {
      updateScrollButton: true,
    });
    return true;
  }

  doWindowedRender();
  return true;
}

export async function applyFullHistoryRender(params = {}) {
  const {
    state,
    threadId,
    messages,
    prevMessages,
    box,
    preservedScrollTop,
    inlineCommentaryArchiveCount,
    renderSig,
    toolCount,
    forceFullRender = false,
    options,
    historyCommentary,
    liveCommentarySnapshot,
    deps = {},
  } = params;
  const {
    renderMessageBody,
    addChat,
    buildMsgNode,
    clearChatMessages,
    renderChatFull,
    pushLiveDebugEvent,
    scrollChatToBottom,
    canStartChatLiveFollow,
    maybeScheduleChatFollow,
    replayAssistantHistoryMessage,
    finalizeThreadRenderEffects,
  } = deps;
  const replayContext = {
    enabled: canReplayAssistantHistory({
      state,
      threadId,
      forceFullRender,
      previousMessages: prevMessages,
    }),
    replayAssistantHistoryMessage,
  };

  const strategy = forceFullRender
    ? "full_rerender"
    : decideHistoryRenderStrategy({
        previousMessages: prevMessages,
        nextMessages: messages,
      });

  const commentaryArchivePatch = !forceFullRender
    ? reconcileTimelineMessages({
        box,
        previousMessages: prevMessages,
        nextMessages: messages,
        buildMsgNode,
        renderMessageBody,
        replayMessage: (node, message, options = {}) =>
          maybeReplayAssistantHistoryMessage(node, message, replayContext, options),
      })
    : null;
  if (commentaryArchivePatch) {
    state.activeThreadInlineCommentaryArchiveCount = inlineCommentaryArchiveCount;
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:archive_patch", {
      threadId,
      inserted: commentaryArchivePatch.inserted,
      updated: commentaryArchivePatch.updated,
      messages: messages.length,
      toolMessages: toolCount,
      timeline: snapshotTimeline(box, deps.byId),
    });
    if (preservedScrollTop !== null && box) {
      const maxTop = Math.max(0, Number(box.scrollHeight || 0) - Number(box.clientHeight || 0));
      box.scrollTop = Math.min(preservedScrollTop, maxTop);
    } else if (state.chatShouldStickToBottom) {
      scrollChatToBottom({ force: true });
    }
    if (canStartChatLiveFollow()) maybeScheduleChatFollow(1100);
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot, {
      updateScrollButton: true,
    });
    return true;
  }

  if (strategy === "full_update_last") {
    const nextLast = messages[messages.length - 1];
    const updated = updateLastNode(box, nextLast, renderMessageBody);
    const previousLast = prevMessages[prevMessages.length - 1];
    maybeReplayAssistantHistoryMessage(updated, nextLast, replayContext, {
      fromText: previousLast?.text,
    });
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:update_last", {
      threadId,
      messages: messages.length,
      toolMessages: toolCount,
      timeline: snapshotTimeline(box, deps.byId),
    });
    maybeScheduleChatFollow(900);
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot);
    return;
  }

  if (strategy === "full_append") {
    appendMessages(messages, prevMessages.length, addChat, replayContext);
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:append", {
      threadId,
      appended: messages.length - prevMessages.length,
      messages: messages.length,
      toolMessages: toolCount,
      timeline: snapshotTimeline(box, deps.byId),
    });
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    maybeScheduleChatFollow(1100);
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
      appendMessages(messages, 0, addChat);
      if (preservedScrollTop !== null && box) {
        const maxTop = Math.max(0, Number(box.scrollHeight || 0) - Number(box.clientHeight || 0));
        box.scrollTop = Math.min(preservedScrollTop, maxTop);
      }
    }
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:full", {
      threadId,
      messages: messages.length,
      toolMessages: toolCount,
      async: shouldAsyncRender,
      timeline: snapshotTimeline(box, deps.byId),
    });
    if (state.chatShouldStickToBottom) scrollChatToBottom({ force: true });
    if (canStartChatLiveFollow()) maybeScheduleChatFollow(1100);
    else if (box) box.scrollTop = box.scrollHeight;
  }

  if (options.stickToBottom) {
    deps.scrollToBottomReliable();
    deps.scheduleChatLiveFollow(1400);
  }

  finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot, {
    updateScrollButton: true,
  });
}
