import { decideHistoryRenderStrategy } from "./historyRenderStrategy.js";

function appendMessages(messages, startIndex, addChat) {
  for (let i = startIndex; i < messages.length; i += 1) {
    const msg = messages[i];
    addChat(msg.role, msg.text, {
      scroll: false,
      kind: msg.kind || "",
      attachments: msg.images || [],
      archiveBlocks: msg.archiveBlocks || [],
      archiveKey: msg.archiveKey || "",
    });
  }
}

function updateLastNode(box, role, text, kind, renderMessageBody) {
  if (!box) return false;
  const nodes = box.querySelectorAll(".msg");
  const last = nodes.length ? nodes[nodes.length - 1] : null;
  if (!last) return false;
  if (!last.classList.contains(role)) return false;
  const body = last.querySelector(".msgBody");
  if (!body) return false;
  body.innerHTML = renderMessageBody(role, text, { kind });
  return true;
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
    finalizeThreadRenderEffects,
  } = deps;
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

  if (strategy === "window_full") {
    doWindowedRender();
    return true;
  }

  state.historyAllMessages = messages;
  if (strategy === "window_unchanged") {
    state.activeThreadRenderSig = renderSig;
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot);
    updateLoadOlderControl();
    return true;
  }

  if (strategy === "window_update_last") {
    const nextLast = messages[messages.length - 1];
    const updated = updateLastNode(box, nextLast?.role, nextLast?.text, nextLast?.kind || "", renderMessageBody);
    if (updated) {
      state.activeThreadMessages = messages.slice(Number(state.historyWindowStart || 0));
      state.activeThreadRenderSig = renderSig;
      pushLiveDebugEvent("history.render:update_last", {
        threadId,
        messages: messages.length,
        toolMessages: toolCount,
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
    appendMessages(messages, prevAll.length, addChat);
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
    options,
    historyCommentary,
    liveCommentarySnapshot,
    deps = {},
  } = params;
  const {
    renderMessageBody,
    addChat,
    clearChatMessages,
    renderChatFull,
    pushLiveDebugEvent,
    scrollChatToBottom,
    canStartChatLiveFollow,
    maybeScheduleChatFollow,
    finalizeThreadRenderEffects,
  } = deps;

  const strategy = decideHistoryRenderStrategy({
    previousMessages: prevMessages,
    nextMessages: messages,
  });

  if (strategy === "full_update_last") {
    const nextLast = messages[messages.length - 1];
    updateLastNode(box, nextLast.role, nextLast.text, nextLast.kind || "", renderMessageBody);
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:update_last", {
      threadId,
      messages: messages.length,
      toolMessages: toolCount,
    });
    maybeScheduleChatFollow(900);
    finalizeThreadRenderEffects(historyCommentary, liveCommentarySnapshot);
    return;
  }

  if (strategy === "full_append") {
    appendMessages(messages, prevMessages.length, addChat);
    state.activeThreadMessages = messages;
    state.activeThreadRenderSig = renderSig;
    pushLiveDebugEvent("history.render:append", {
      threadId,
      appended: messages.length - prevMessages.length,
      messages: messages.length,
      toolMessages: toolCount,
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
