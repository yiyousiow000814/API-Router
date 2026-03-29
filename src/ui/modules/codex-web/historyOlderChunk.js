export async function loadOlderHistoryChunk(state = {}, deps = {}) {
  const {
    byId,
    api,
    buildThreadHistoryUrl,
    applyHistoryPageToState,
    applyThreadToChat,
    updateLoadOlderControl = () => {},
    ensureLoadOlderControl = () => null,
    documentRef,
    buildMsgNode,
  } = deps;
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
        const { thread } = applyHistoryPageToState(state, state.activeThreadId, page, {
          mergeDirection: "prepend",
        });
        await applyThreadToChat({
          ...(thread || {}),
          id: state.activeThreadId,
          workspace: state.activeThreadWorkspace,
          rolloutPath: state.activeThreadRolloutPath,
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
