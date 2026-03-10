export function createComposerUiModule(deps) {
  const {
    state,
    byId,
    readPromptValue,
    clearPromptInput,
    resolveMobilePromptLayout,
    renderComposerContextLeftInNode,
    updateHeaderUi,
    documentRef = document,
    windowRef = window,
  } = deps;

  function getPromptValue() {
    return readPromptValue(byId("mobilePromptInput"));
  }

  function clearPromptValue() {
    const mobile = byId("mobilePromptInput");
    clearPromptInput(mobile);
    updateMobileComposerState();
  }

  function hideWelcomeCard() {
    const welcome = byId("welcomeCard");
    if (welcome) welcome.style.display = "none";
  }

  function showWelcomeCard() {
    const welcome = byId("welcomeCard");
    if (welcome) welcome.style.display = "";
  }

  function renderComposerContextLeft() {
    const node = byId("mobileContextLeft");
    if (!node) return;
    renderComposerContextLeftInNode(node, state.activeThreadTokenUsage);
  }

  function updateMobileComposerState() {
    const wrap = byId("mobilePromptWrap");
    const input = byId("mobilePromptInput");
    if (!wrap || !input) return;
    input.style.height = "auto";
    const layout = resolveMobilePromptLayout(
      input.scrollHeight,
      typeof windowRef === "undefined" ? Number.NaN : windowRef.innerHeight,
    );
    input.style.height = `${layout.heightPx}px`;
    input.style.overflowY = layout.overflowY;
    wrap.classList.toggle("has-text", !!String(input.value || "").trim());
  }

  function setMainTab(tab) {
    state.activeMainTab = tab === "settings" ? "settings" : "chat";
    const settingsTab = byId("settingsTab");
    const settingsInfoSection = byId("settingsInfoSection");
    const chatBox = byId("chatBox");
    const composer = documentRef.querySelector(".composer");
    const isSideTab = state.activeMainTab === "settings";
    if (settingsTab) settingsTab.classList.toggle("show", isSideTab);
    if (settingsInfoSection) settingsInfoSection.style.display = "";
    if (chatBox) chatBox.style.display = isSideTab ? "none" : "";
    if (composer) composer.style.display = isSideTab ? "none" : "";
    updateHeaderUi();
  }

  function syncSettingsControlsFromMain() {}
  function updateWelcomeSelections() {}

  return {
    clearPromptValue,
    getPromptValue,
    hideWelcomeCard,
    renderComposerContextLeft,
    setMainTab,
    showWelcomeCard,
    syncSettingsControlsFromMain,
    updateMobileComposerState,
    updateWelcomeSelections,
  };
}
