function toggleClass(node, name, enabled) {
  if (node?.classList?.toggle) {
    node.classList.toggle(name, enabled);
    return;
  }
  if (enabled) node?.classList?.add?.(name);
  else node?.classList?.remove?.(name);
}

export function resolveThreadSearchMode(state, isCompactViewport = () => false) {
  const open = state.threadSearchOpen === true || !!String(state.threadSearchQuery || "").trim();
  const mobileMode = open && isCompactViewport();
  state.threadSearchMobileMode = mobileMode;
  return { open, mobileMode };
}

export function syncThreadSearchUiState({
  state,
  panel = null,
  input = null,
  body = null,
  isCompactViewport = () => false,
} = {}) {
  const { open, mobileMode } = resolveThreadSearchMode(state, isCompactViewport);
  const hasQuery = !!String(state.threadSearchQuery || "").trim();
  toggleClass(panel, "search-open", open);
  toggleClass(panel, "search-mobile-mode", mobileMode);
  toggleClass(panel, "search-has-query", hasQuery);
  toggleClass(panel, "search-transition-opening", state.threadSearchTransitionPhase === "opening");
  toggleClass(panel, "search-transition-closing", state.threadSearchTransitionPhase === "closing");
  toggleClass(body, "drawer-left-search-open", mobileMode);
  input?.setAttribute?.("aria-expanded", open ? "true" : "false");
  return { open, mobileMode };
}

export function resetThreadSearchUiState({
  state,
  panel = null,
  input = null,
  body = null,
  clearScheduledTimeout = () => {},
  isCompactViewport = () => false,
} = {}) {
  state.threadSearchOpen = false;
  state.threadSearchMobileMode = false;
  state.threadSearchTransitionPhase = "";
  state.threadSearchQuery = "";
  if (state.threadSearchTransitionTimer) {
    clearScheduledTimeout(state.threadSearchTransitionTimer);
    state.threadSearchTransitionTimer = 0;
  }
  if (input) input.value = "";
  return syncThreadSearchUiState({
    state,
    panel,
    input,
    body,
    isCompactViewport,
  });
}
