export function beginApplyThreadToChat(state = {}, thread = {}, options = {}, pushLiveDebugEvent = () => {}) {
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
  if (options.stickToBottom) {
    state.chatShouldStickToBottom = true;
    state.chatUserScrolledAwayAt = 0;
    state.chatProgrammaticScrollUntil = Date.now() + 260;
  }
  return threadId;
}

export function reportPreparedHistory(threadId = "", prepared = {}, pushLiveDebugEvent = () => {}) {
  const {
    turns = [],
    messages = [],
    toolCount = 0,
    historyItems = [],
  } = prepared;
  pushLiveDebugEvent("history.receive", {
    threadId,
    turns: turns.length,
    messages: messages.length,
    toolMessages: toolCount,
    historyItems: historyItems.length,
  });
}

export function getRenderBaseline(state = {}, byId) {
  const box = byId("chatBox");
  const prevMessages = Array.isArray(state.activeThreadMessages) ? state.activeThreadMessages : [];
  const preservedScrollTop =
    !state.chatShouldStickToBottom && box && prevMessages.length > 0
      ? Math.max(0, Number(box.scrollTop || 0))
      : null;
  return {
    box,
    prevMessages,
    preservedScrollTop,
  };
}
