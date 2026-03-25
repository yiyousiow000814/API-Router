export function ensureLoadOlderControl(box, deps = {}) {
  const {
    byId,
    documentRef,
    loadOlderHistoryChunk = () => {},
  } = deps;
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

export function updateLoadOlderControl(state = {}, deps = {}) {
  const {
    byId,
    ensureLoadOlderControl = () => null,
  } = deps;
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
