import { describe, expect, it } from "vitest";

import { createComposerUiModule } from "./composerUi.js";

describe("composerUi", () => {
  function makeClassList(target) {
    const values = new Set();
    const sync = () => {
      target._className = [...values].join(" ").trim();
    };
    return {
      _values: values,
      add(...tokens) {
        for (const token of tokens) {
          const normalized = String(token || "").trim();
          if (normalized) values.add(normalized);
        }
        sync();
      },
      remove(...tokens) {
        for (const token of tokens) values.delete(String(token || "").trim());
        sync();
      },
      contains(token) {
        return values.has(String(token || "").trim());
      },
      toggle(token, force) {
        const normalized = String(token || "").trim();
        if (!normalized) return false;
        if (force === true) {
          values.add(normalized);
          sync();
          return true;
        }
        if (force === false) {
          values.delete(normalized);
          sync();
          return false;
        }
        if (values.has(normalized)) {
          values.delete(normalized);
          sync();
          return false;
        }
        values.add(normalized);
        sync();
        return true;
      },
    };
  }

  function installClassNameAccessor(node) {
    Object.defineProperty(node, "className", {
      get() {
        return this._className || "";
      },
      set(value) {
        this._className = String(value || "").trim();
        if (this.classList?._values) {
          this.classList._values.clear();
          for (const token of this._className.split(/\s+/).filter(Boolean)) {
            this.classList._values.add(token);
          }
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  function makeNode() {
    function findById(node, selector) {
      if (!node || typeof selector !== "string" || !selector.startsWith("#")) return null;
      const ownId = `#${String(node.id || "")}`;
      if (ownId === selector) return node;
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        const match = findById(child, selector);
        if (match) return match;
      }
      return null;
    }
    const node = {
      id: "",
      style: {},
      innerHTML: "",
      textContent: "",
      attributes: new Map(),
      _className: "",
      children: [],
      appendChild(node) {
        this.children = this.children.filter((item) => item !== node);
        this.children.push(node);
        node.parentNode = this;
      },
      insertBefore(node, before) {
        this.children = this.children.filter((item) => item !== node);
        const index = before ? this.children.indexOf(before) : -1;
        if (index >= 0) this.children.splice(index, 0, node);
        else this.children.push(node);
        node.parentNode = this;
      },
      querySelector(selector) {
        return findById(this, selector);
      },
      setAttribute(name, value) {
        this.attributes.set(String(name || ""), String(value || ""));
      },
      getAttribute(name) {
        return this.attributes.get(String(name || "")) || null;
      },
      addEventListener() {},
      removeEventListener() {},
    };
    node.classList = makeClassList(node);
    installClassNameAccessor(node);
    return node;
  }

  function makeElementFactory(dockRef = null) {
    function findById(node, selector) {
      if (!node || typeof selector !== "string" || !selector.startsWith("#")) return null;
      const ownId = `#${String(node.id || "")}`;
      if (ownId === selector) return node;
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        const match = findById(child, selector);
        if (match) return match;
      }
      return null;
    }
    return (tag) => {
      const node = {
      tagName: String(tag || "").toUpperCase(),
      id: "",
      _className: "",
      style: {},
      innerHTML: "",
      textContent: "",
      attributes: new Map(),
      children: [],
      parentNode: null,
      appendChild(node) {
        this.children = this.children.filter((item) => item !== node);
        this.children.push(node);
        node.parentNode = this;
      },
      insertBefore(node, before) {
        this.children = this.children.filter((item) => item !== node);
        const index = before ? this.children.indexOf(before) : -1;
        if (index >= 0) this.children.splice(index, 0, node);
        else this.children.push(node);
        node.parentNode = this;
      },
      querySelector(selector) {
        return findById(this, selector);
      },
      setAttribute(name, value) {
        this.attributes.set(String(name || ""), String(value || ""));
      },
      getAttribute(name) {
        return this.attributes.get(String(name || "")) || null;
      },
      remove() {
        if (this.parentNode?.children) {
          this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
        }
        if (dockRef?.children) {
          dockRef.children = dockRef.children.filter((item) => item !== this);
        }
        this.parentNode = null;
      },
      addEventListener() {},
      removeEventListener() {},
    };
      node.classList = makeClassList(node);
      installClassNameAccessor(node);
      return node;
    };
  }

  function expectWorkingActivityBarHtml(html) {
    expect(String(html || "")).toContain("working");
    expect(html).toContain("runtimeActivityDots");
  }

  function expectLabeledActivityBarHtml(html, title, detail, tone) {
    expect(String(html || "")).toContain(String(title || ""));
    if (detail) expect(String(html || "")).toContain(String(detail));
    expect(String(html || "")).toContain(`data-activity-tone="${String(tone || "")}"`);
    expect(String(html || "")).toContain("runtimeActivityDots");
  }

  it("reads prompt value through dependency", () => {
    const deps = {
      state: { activeThreadTokenUsage: null, activeMainTab: "chat" },
      byId(id) {
        return id === "mobilePromptInput" ? { value: "hello" } : null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    };
    const { getPromptValue } = createComposerUiModule(deps);
    expect(getPromptValue()).toBe("hello");
  });

  it("keeps permission out of the context-left annotation because it lives in the picker bar", () => {
    const calls = [];
    const deps = {
      state: {
        activeThreadTokenUsage: null,
        activeMainTab: "chat",
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        planModeEnabled: true,
        fastModeEnabled: true,
        permissionPresetByWorkspace: { windows: "/permission full-access", wsl2: "" },
      },
      byId(id) {
        return id === "mobileContextLeft" ? makeNode() : id === "mobilePromptInput" ? { value: "" } : null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode(...args) {
        calls.push(args);
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    };
    const { renderComposerContextLeft } = createComposerUiModule(deps);

    renderComposerContextLeft();

    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toEqual({ annotation: "fast · plan mode" });
  });

  it("syncs settings default toggles from workspace state", () => {
    const nodes = new Map();
    for (const id of [
      "toggleLiveInspectorBtn",
      "liveInspectorState",
      "previewUpdatedPlanBtn",
      "previewPendingBtn",
      "settingsFullAccessOnBtn",
      "settingsFullAccessOffBtn",
      "settingsFastOnBtn",
      "settingsFastOffBtn",
    ]) {
      nodes.set(id, makeNode());
    }
    const deps = {
      state: {
        activeThreadTokenUsage: null,
        activeMainTab: "chat",
        activeThreadWorkspace: "wsl2",
        workspaceTarget: "windows",
        planModeEnabled: false,
        fastModeEnabled: true,
        permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "/permission full-access" },
      },
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      localStorageRef: { getItem() { return ""; } },
      documentRef: { querySelector() { return null; }, getElementById() { return null; } },
      windowRef: {
        innerHeight: 900,
        __webCodexDebug: {
          isPreviewUpdatedPlanActive() {
            return true;
          },
          isPreviewPendingActive() {
            return true;
          },
        },
        addEventListener() {},
      },
    };
    const { syncSettingsControlsFromMain } = createComposerUiModule(deps);

    syncSettingsControlsFromMain();

    expect(nodes.get("previewUpdatedPlanBtn")?.textContent).toBe("Plan Preview: On");
    expect(nodes.get("previewPendingBtn")?.textContent).toBe("Pending Preview: On");
    expect(nodes.get("settingsFullAccessOnBtn")?.classList.contains("is-active")).toBe(true);
    expect(nodes.get("settingsFullAccessOffBtn")?.classList.contains("is-active")).toBe(false);
    expect(nodes.get("settingsFastOnBtn")?.classList.contains("is-active")).toBe(true);
    expect(nodes.get("settingsFastOffBtn")?.classList.contains("is-active")).toBe(false);
  });

  it("renders direct provider health dots from switchboard status", () => {
    const nodes = new Map();
    for (const id of [
      "settingsProviderList",
      "settingsProviderDirectCount",
    ]) {
      nodes.set(id, makeNode());
    }
    const deps = {
      state: {
        activeThreadTokenUsage: null,
        activeMainTab: "settings",
        settingsActiveSection: "provider",
        providerSwitchboardScope: "windows",
        providerSwitchboardDraftTarget: "provider",
        providerSwitchboardDraftProvider: "codex-for-me",
        providerSwitchboardStatus: {
          ok: true,
          scope: "windows",
          mode: "provider",
          model_provider: "codex-for-me",
          provider_details: [
            {
              name: "codex-for-me",
              display_name: "codex-for.me",
              disabled: false,
              health: { status: "healthy" },
              quota: { kind: "budget_info", daily_spent_usd: 1, daily_budget_usd: 10 },
            },
            {
              name: "retry-provider",
              display_name: "retry-provider",
              disabled: false,
              health: { status: "cooldown" },
              quota: { kind: "budget_info", daily_spent_usd: 0, daily_budget_usd: 10 },
            },
            {
              name: "bad-provider",
              display_name: "bad-provider",
              disabled: false,
              health: { status: "unhealthy" },
              quota: { kind: "budget_info", daily_spent_usd: 0, daily_budget_usd: 10 },
            },
          ],
          official_profiles: [],
        },
        workspaceAvailability: { wsl2Installed: false },
        permissionPresetByWorkspace: {},
      },
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue() {
        return "";
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      localStorageRef: { getItem() { return ""; } },
      documentRef: { querySelector() { return null; }, getElementById() { return null; } },
      windowRef: { innerHeight: 900, addEventListener() {} },
    };
    const { syncSettingsControlsFromMain } = createComposerUiModule(deps);

    syncSettingsControlsFromMain();

    const html = nodes.get("settingsProviderList")?.innerHTML || "";
    expect(html).toContain("settingsProviderHealthDot is-good");
    expect(html).toContain("settingsProviderHealthDot is-neutral");
    expect(html).toContain("settingsProviderHealthDot is-bad");
    expect(html).toContain('title="Healthy"');
    expect(html).toContain('title="Retrying"');
    expect(html).toContain('title="Unhealthy"');
  });

  it("shows the provider workspace switch only when both workspaces are available", () => {
    function renderWithAvailability(workspaceAvailability) {
      const nodes = new Map();
      for (const id of [
        "settingsProviderCurrentMode",
        "settingsProviderScopeRow",
        "settingsProviderScopeWindowsBtn",
        "settingsProviderScopeWslBtn",
      ]) {
        nodes.set(id, makeNode());
      }
      const deps = {
        state: {
          activeMainTab: "settings",
          settingsActiveSection: "provider",
          providerSwitchboardScope: "windows",
          providerSwitchboardStatus: {
            ok: true,
            scope: "windows",
            mode: "gateway",
            provider_details: [],
            official_profiles: [],
          },
          workspaceAvailability,
          permissionPresetByWorkspace: {},
        },
        byId(id) {
          return nodes.get(id) || null;
        },
        readPromptValue() {
          return "";
        },
        clearPromptInput() {},
        resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
        renderComposerContextLeftInNode() {},
        updateHeaderUi() {},
        localStorageRef: { getItem() { return ""; } },
        documentRef: { querySelector() { return null; }, getElementById() { return null; } },
        windowRef: { innerHeight: 900, addEventListener() {} },
      };
      createComposerUiModule(deps).syncSettingsControlsFromMain();
      return {
        display: nodes.get("settingsProviderScopeRow").style.display,
        currentMode: nodes.get("settingsProviderCurrentMode").textContent,
      };
    }

    expect(renderWithAvailability({ windowsInstalled: true, wsl2Installed: false })).toMatchObject({
      display: "none",
      currentMode: "Windows",
    });
    expect(renderWithAvailability({ windowsInstalled: false, wsl2Installed: true })).toMatchObject({
      display: "none",
      currentMode: "WSL2",
    });
    expect(renderWithAvailability({ windowsInstalled: true, wsl2Installed: true })).toMatchObject({
      display: "",
      currentMode: "Windows",
    });
  });

  it("updates mobile composer actions for running turns", () => {
    const nodes = new Map();
    const wrap = makeNode();
    const input = makeNode();
    input.value = "help me steer";
    const sendBtn = makeNode();
    const menuBtn = makeNode();
    const menu = makeNode();
    const queuedCard = makeNode();
    const queuedTitle = makeNode();
    const queuedCount = makeNode();
    const queuedToggleBtn = makeNode();
    const queuedStatus = makeNode();
    const queuedSummary = makeNode();
    const queuedList = makeNode();
    nodes.set("mobilePromptWrap", wrap);
    nodes.set("mobilePromptInput", input);
    nodes.set("mobileSendBtn", sendBtn);
    nodes.set("composerActionMenuBtn", menuBtn);
    nodes.set("composerActionMenu", menu);
    nodes.set("queuedTurnCard", queuedCard);
    nodes.set("queuedTurnCardTitle", queuedTitle);
    nodes.set("queuedTurnCardCount", queuedCount);
    nodes.set("queuedTurnToggleBtn", queuedToggleBtn);
    nodes.set("queuedTurnCardStatus", queuedStatus);
    nodes.set("queuedTurnCardSummary", queuedSummary);
    nodes.set("queuedTurnCardList", queuedList);
    const { updateMobileComposerState } = createComposerUiModule({
      state: {
        activeThreadId: "",
        activeThreadOpenState: { threadId: "thread-1" },
        activeThreadTokenUsage: null,
        activeMainTab: "chat",
        activeThreadPendingTurnRunning: true,
        activeThreadQueuedTurns: [],
        composerActionMenuOpen: false,
      },
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    updateMobileComposerState();

    expect(sendBtn.innerHTML).toContain("sendArrowIcon");
    expect(sendBtn.innerHTML).not.toContain("Steer");
    expect(sendBtn.classList.contains("is-steer")).toBe(true);
    expect(menuBtn.disabled).toBe(false);
  });

  it("renders queued draft messaging immediately after a steer or follow-up is queued", () => {
    const nodes = new Map();
    const wrap = makeNode();
    const input = makeNode();
    input.value = "";
    const sendBtn = makeNode();
    const menuBtn = makeNode();
    const menu = makeNode();
    const queuedCard = makeNode();
    const queuedTitle = makeNode();
    const queuedCount = makeNode();
    const queuedToggleBtn = makeNode();
    const queuedStatus = makeNode();
    const queuedList = makeNode();
    nodes.set("mobilePromptWrap", wrap);
    nodes.set("mobilePromptInput", input);
    nodes.set("mobileSendBtn", sendBtn);
    nodes.set("composerActionMenuBtn", menuBtn);
    nodes.set("composerActionMenu", menu);
    nodes.set("queuedTurnCard", queuedCard);
    nodes.set("queuedTurnCardTitle", queuedTitle);
    nodes.set("queuedTurnCardCount", queuedCount);
    nodes.set("queuedTurnToggleBtn", queuedToggleBtn);
    nodes.set("queuedTurnCardStatus", queuedStatus);
    nodes.set("queuedTurnCardList", queuedList);

    const { updateMobileComposerState } = createComposerUiModule({
      state: {
        activeThreadTokenUsage: null,
        activeMainTab: "chat",
        activeThreadPendingTurnRunning: true,
        activeThreadQueuedTurns: [
          {
            id: "queued-1",
            threadId: "thread-1",
            prompt: "Please change the approach",
            mode: "steer",
          },
          {
            id: "queued-2",
            threadId: "thread-1",
            prompt: "Then summarize the result",
            mode: "queue",
          },
        ],
        queuedTurnsExpanded: true,
        composerActionMenuOpen: false,
      },
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    updateMobileComposerState();

    expect(queuedCard.style.display).toBe("block");
    expect(queuedTitle.textContent).toBe("Queued messages");
    expect(queuedCount.textContent).toBe("2 queued");
    expect(queuedToggleBtn.getAttribute("aria-expanded")).toBe("true");
    expect(queuedToggleBtn.innerHTML).toContain("queuedTurnToggleIcon");
    expect(queuedStatus.textContent).toContain("Steer waits for the next tool call");
    expect(queuedList.innerHTML).toContain("Please change the approach");
    expect(queuedList.innerHTML).toContain("Then summarize the result");
    expect(queuedList.innerHTML).toContain("data-queued-action=\"edit\"");
    expect(queuedList.innerHTML).toContain("data-queued-action=\"remove\"");
  });

  it("collapses the remaining queue list when queuedTurnsExpanded is false", () => {
    const nodes = new Map();
    const wrap = makeNode();
    const input = makeNode();
    const sendBtn = makeNode();
    const menuBtn = makeNode();
    const menu = makeNode();
    const queuedCard = makeNode();
    const queuedTitle = makeNode();
    const queuedCount = makeNode();
    const queuedToggleBtn = makeNode();
    const queuedStatus = makeNode();
    const queuedSummary = makeNode();
    const queuedList = makeNode();
    nodes.set("mobilePromptWrap", wrap);
    nodes.set("mobilePromptInput", input);
    nodes.set("mobileSendBtn", sendBtn);
    nodes.set("composerActionMenuBtn", menuBtn);
    nodes.set("composerActionMenu", menu);
    nodes.set("queuedTurnCard", queuedCard);
    nodes.set("queuedTurnCardTitle", queuedTitle);
    nodes.set("queuedTurnCardCount", queuedCount);
    nodes.set("queuedTurnToggleBtn", queuedToggleBtn);
    nodes.set("queuedTurnCardStatus", queuedStatus);
    nodes.set("queuedTurnCardSummary", queuedSummary);
    nodes.set("queuedTurnCardList", queuedList);

    const { updateMobileComposerState } = createComposerUiModule({
      state: {
        activeThreadTokenUsage: null,
        activeMainTab: "chat",
        activeThreadPendingTurnRunning: true,
        activeThreadQueuedTurns: [
          { id: "queued-1", threadId: "thread-1", prompt: "First", mode: "queue" },
          { id: "queued-2", threadId: "thread-1", prompt: "Second", mode: "queue" },
        ],
        queuedTurnsExpanded: false,
        composerActionMenuOpen: false,
      },
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    updateMobileComposerState();

    expect(queuedToggleBtn.getAttribute("aria-expanded")).toBe("false");
    expect(queuedList.classList.contains("is-collapsed")).toBe(true);
    expect(queuedSummary.classList.contains("is-visible")).toBe(true);
    expect(queuedSummary.textContent).toContain("Follow-up - First");
  });

  it("persists the active main tab when switching views", () => {
    const nodes = new Map();
    const settingsTab = makeNode();
    const settingsInfoSection = makeNode();
    const chatBox = makeNode();
    const composer = makeNode();
    nodes.set("settingsTab", settingsTab);
    nodes.set("settingsInfoSection", settingsInfoSection);
    nodes.set("chatBox", chatBox);
    const writes = [];
    const state = {
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
    };
    const { setMainTab } = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      updateHeaderUi() {},
      localStorageRef: {
        getItem() { return ""; },
        setItem(key, value) { writes.push([key, value]); },
      },
      documentRef: {
        querySelector(selector) {
          return selector === ".composer" ? composer : null;
        },
        getElementById() { return null; },
      },
      windowRef: { innerHeight: 900 },
    });

    setMainTab("settings");
    setMainTab("chat");

    expect(writes).toEqual([
      ["web_codex_active_main_tab_v1", "settings"],
      ["web_codex_active_main_tab_v1", "chat"],
    ]);
  });

  it("renders runtime panels for plan, active commands, and activity", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "",
      activeThreadOpenState: { threadId: "thread-1" },
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActiveCommands([
      { key: "cmd-1", text: "Running `npm test`", state: "running", icon: "command" },
    ]);
    module.setActivePlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Need a quick plan",
      steps: [{ step: "Inspect history", status: "completed" }],
      deltaText: "",
    });
    module.setRuntimeActivity({
      threadId: "thread-1",
      title: "Planning",
      detail: "Need a quick plan",
      tone: "running",
    });

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Plan");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm test");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("runtimeToolItemTailDot");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("renders a dedicated status tray above the composer and clears it", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const statusTrayMount = makeNode();
    statusTrayMount.id = "statusTrayMount";
    nodes.set("statusTrayMount", statusTrayMount);
    const statusTrayTitle = makeNode();
    statusTrayTitle.id = "statusTrayTitle";
    nodes.set("statusTrayTitle", statusTrayTitle);
    const statusTraySessionValue = makeNode();
    statusTraySessionValue.id = "statusTraySessionValue";
    nodes.set("statusTraySessionValue", statusTraySessionValue);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadStatusCard: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      localStorageRef: { getItem() { return "0"; } },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { requestAnimationFrame(cb) { cb(); } },
    });

    module.setThreadStatusCard({
      threadId: "thread-1",
      sessionId: "019da209-a2eb-7741-ab62-8a4474de0821",
      title: "Status",
    });

    expect(nodes.get("statusTrayTitle").textContent).toBe("Status");
    expect(nodes.get("statusTraySessionValue").textContent).toBe("019da209-a2eb-7741-ab62-8a4474de0821");
    expect(nodes.get("statusTrayMount").classList.contains("is-hidden")).toBe(false);

    module.clearThreadStatusCard();

    expect(nodes.get("statusTrayTitle").textContent).toBe("");
    expect(nodes.get("statusTraySessionValue").textContent).toBe("");
    expect(nodes.get("statusTrayMount").classList.contains("is-hidden")).toBe(true);
  });

  it("marks runtime tool entries as error when the enclosing turn fails", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "",
      activeThreadOpenState: { threadId: "thread-1" },
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-turn-failed",
      type: "commandExecution",
      command: "cargo test",
      text: "Ran `cargo test`",
    }, { threadId: "thread-1", method: "turn/failed", timestamp: 100 });

    expect(state.activeThreadActiveCommands[0].state).toBe("error");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("state-error");
  });

  it("renders the activity bar as a compact generic working hint without runtime detail text", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Running `npm test`", state: "running", icon: "command" }],
      activeThreadActivity: { threadId: "thread-1", title: "Running command", detail: "npm test", tone: "running" },
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "Inspect runtime rendering",
        steps: [{ step: "Check activity bar", status: "in_progress" }],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      localStorageRef: { getItem() { return "0"; } },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(runtimeDock) },
      windowRef: { requestAnimationFrame(cb) { cb(); } },
    });

    module.renderRuntimePanels();

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("working");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("npm test");
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("Updated Plan");
  });

  it("renders reconnecting and error activity labels when the state should be user-visible", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: {
        threadId: "thread-1",
        title: "Reconnecting",
        detail: "Provider disconnected. Reconnecting...",
        tone: "running",
      },
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      localStorageRef: { getItem() { return "0"; } },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(runtimeDock) },
      windowRef: { requestAnimationFrame(cb) { cb(); } },
    });

    module.renderRuntimePanels();
    expectLabeledActivityBarHtml(
      nodes.get("runtimeActivityBar").innerHTML,
      "Reconnecting",
      "Provider disconnected. Reconnecting...",
      "running"
    );

    module.setRuntimeActivity({
      threadId: "thread-1",
      title: "Error",
      detail: "Reconnecting failed.",
      tone: "error",
    });
    expectLabeledActivityBarHtml(
      nodes.get("runtimeActivityBar").innerHTML,
      "Error",
      "Reconnecting failed.",
      "error"
    );
  });

  it("keeps generic working activity visible while a connection status card shows reconnect state", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 2/5",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      localStorageRef: { getItem() { return "0"; } },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(runtimeDock) },
      windowRef: { requestAnimationFrame(cb) { cb(); } },
    });

    module.renderRuntimePanels();

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("keeps runtime chat panels above the pending inline card", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    const pendingMount = makeNode();
    pendingMount.id = "pendingInlineMount";
    chatBox.appendChild(pendingMount);
    nodes.set("chatBox", chatBox);
    nodes.set("pendingInlineMount", pendingMount);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-1", text: "Running `npm test`", state: "running", icon: "command" }],
      activeThreadActivity: { threadId: "thread-1", title: "Running command", detail: "", tone: "running" },
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.renderRuntimePanels();

    expect(chatBox.children.map((child) => child.id)).toEqual(["runtimeChatPanels", "pendingInlineMount"]);
  });

  it("prepares runtime panels synchronously during chat opening without per-item enter animations", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      chatOpening: true,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActiveCommands([
      { key: "cmd-1", text: "Running `npm test`", state: "running", icon: "command" },
    ]);
    module.setActivePlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Need a quick plan",
      steps: [{ step: "Inspect history", status: "completed" }],
      deltaText: "",
    });
    module.setRuntimeActivity({
      threadId: "thread-1",
      title: "Planning",
      detail: "Need a quick plan",
      tone: "running",
    });

    expect(chatBox.querySelector("#runtimePlanInline").className).not.toContain("is-hidden");
    expect(chatBox.querySelector("#runtimeToolInline").className).not.toContain("is-hidden");
    expect(nodes.get("runtimeDock").style.display).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("keeps the runtime dock visible for a pending turn before tools or commentary arrive", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadTransientThinkingText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActiveCommands([]);

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("does not leak stale commentary text into the pending runtime activity placeholder", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadTransientThinkingText: "",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-stale",
        text: "构建已完成。",
        tools: [],
      },
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.renderRuntimePanels();

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("构建已完成");
  });

  it("keeps showing Thinking after runtime state is cleared while a pending turn is still running", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadTransientThinkingText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [
        { key: "cmd-1", text: "Running `npm test`", state: "running", icon: "command" },
      ],
      activeThreadActivity: { threadId: "thread-1", title: "Running command", detail: "npm test", tone: "running" },
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "Need a quick plan",
        steps: [{ step: "Inspect history", status: "completed" }],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.clearRuntimeState();

    expect(nodes.get("runtimeDock").style.display).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("derives runtime command cards from tool payloads without reparsing markdown text", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "tool-1",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "cargo test --manifest-path src-tauri/Cargo.toml" }),
      text: "Running `cargo test --manifest-path src-tauri/Cargo.toml`",
    }, { threadId: "thread-1", timestamp: 100 });

    module.applyToolItemRuntimeUpdate({
      id: "tool-2",
      type: "mcpToolCall",
      server: "github",
      tool: "search_issues",
      status: "running",
      text: "Running tool `github / search_issues`",
    }, { threadId: "thread-1", timestamp: 200 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("cargo test --manifest-path src-tauri/Cargo.toml");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("github / search_issues");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("summarizes multiline command previews from the first meaningful line", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "tool-3",
      type: "commandExecution",
      command: "@'\nimport { renderMessageRichHtml } from './messageRender.js';\nconsole.log('x');\n'@ | node --input-type=module",
      status: "running",
    }, { threadId: "thread-1", timestamp: 300 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain('</code> <span class="runtimeToolItemMeta">+3 lines</span>');
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("import { renderMessageRichHtml }");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("+3 lines");
  });

  it("keeps finished commands in the runtime panel and mirrors the latest command in the activity bar", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "tool-1",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", timestamp: 100 });
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("composerUi.test.js");

    module.applyToolItemRuntimeUpdate({
      id: "tool-1",
      type: "toolCall",
      tool: "shell_command",
      status: "completed",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", timestamp: 200 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("composerUi.test.js");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeDock").style.display).toBe("");
  });

  it("restores completed commands into the activity bar when syncing incomplete history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "cmd-1",
              type: "commandExecution",
              command: "rg -n runtimeDock codex-web.html",
              status: "completed",
            },
          ],
        },
      ],
    });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("runtimeDock");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeDock").style.display).toBe("");
  });

  it("keeps only the latest commentary block tools when syncing incomplete history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { id: "cmd-1", type: "commandExecution", command: "git status --short", status: "completed" },
            { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "first pass" },
            { id: "cmd-2", type: "commandExecution", command: "npm test", status: "completed" },
            { id: "plan-1", type: "plan", text: "Keep latest investigation only" },
            { id: "commentary-2", type: "agentMessage", phase: "commentary", text: "second pass" },
            { id: "cmd-3", type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(state.activeThreadPlan?.steps).toEqual([
      { step: "Keep latest investigation only", status: "pending" },
    ]);
    expect(state.activeThreadActiveCommands).toHaveLength(1);
    expect(state.activeThreadActiveCommands[0]?.label || state.activeThreadActiveCommands[0]?.command).toContain("npm run build");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm run build");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("git status --short");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("npm test");
  });

  it("renders activity dots even when the tone is complete", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setRuntimeActivity({
      threadId: "thread-1",
      title: "Ran command",
      detail: "npm test",
      tone: "complete",
    });

    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("clears runtime panels when the latest turn already has a final assistant message", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-stale", text: "Running `npm test`", state: "running", icon: "command" }],
      activeThreadActivity: { threadId: "thread-1", title: "Running command", detail: "npm test", tone: "running" },
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "Investigate runtime",
        steps: [{ step: "Inspect", status: "in_progress" }],
      },
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-stale",
        text: "still thinking",
        tools: ["Running `npm test`"],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking one" },
            { id: "cmd-1", type: "commandExecution", command: "npm test", status: "completed" },
            { type: "assistantMessage", phase: "final_answer", text: "done" },
          ],
        },
      ],
    });

    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
    expect(nodes.get("runtimeDock").style.display).toBe("none");
    expect(chatBox.querySelector("#runtimeChatPanels")).toBeNull();
  });

  it("renders apply_patch runtime cards from edited files instead of the raw tool name", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return "Edited `src/ui/modules/codex-web/chatTimeline.js`"; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "patch-1",
      type: "toolCall",
      tool: "apply_patch",
      status: "running",
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain('<code class="msgInlineCode">src/ui/modules/codex-web/chatTimeline.js</code>');
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("apply_patch");
  });

  it("keeps command and read prefixes in runtime tool cards", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActiveCommands([
      { key: "cmd-1", text: "Ran `git -C /home/yiyou/ast-tri-strategy status --short`", state: "complete", icon: "command" },
      { key: "cmd-2", text: "Read `selflearn_fullsuite_15-03-2026.log`", state: "complete", icon: "tool" },
    ]);

    const html = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(html).toContain('<span class="msgToolPrefix">Ran </span>');
    expect(html).toContain('<span class="msgToolPrefix">Read </span>');
    expect(html).toContain('<code class="msgInlineCode">git -C /home/yiyou/ast-tri-strategy status --short</code>');
    expect(html).toContain('<code class="msgInlineCode">selflearn_fullsuite_15-03-2026.log</code>');
  });

  it("keeps searched web prefixes in runtime tool cards", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActiveCommands([
      { key: "search-1", text: "Searched web for `site:github.com/openai/codex slash commands review compact diff codex github`", state: "complete", icon: "search" },
    ]);

    const html = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(html).toContain('<span class="msgToolPrefix">Searched web for </span>');
    expect(html).toContain('<code class="msgInlineCode">site:github.com/openai/codex slash commands review compact diff codex github</code>');
  });

  it("renders single-file apply_patch diff counts with colored runtime spans", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return "Edited `src/ui/modules/codex-web/chatTimeline.test.js` (+11 -0)"; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "patch-1b",
      type: "toolCall",
      tool: "apply_patch",
      status: "completed",
    }, { threadId: "thread-1", timestamp: 100 });

    const html = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(html).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(html).toContain('<code class="msgInlineCode">src/ui/modules/codex-web/chatTimeline.test.js</code>');
    expect(html).toContain("runtimeToolItemDiffAdd");
    expect(html).toContain("runtimeToolItemDiffDel");
    expect(html).toContain("+11");
    expect(html).toContain("-0");
  });

  it("renders apply_patch aggregate diff counts in runtime cards", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return "Edited 2 files (+2 -0)"; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "patch-2",
      type: "toolCall",
      tool: "apply_patch",
      status: "completed",
    }, { threadId: "thread-1", timestamp: 100 });

    const html = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(html).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(html).toContain(">2 files</span>");
    expect(html).toContain("runtimeToolItemDiffAdd");
    expect(html).toContain("runtimeToolItemDiffDel");
  });

  it("does not resurrect passive write_stdin entries in the runtime tool list", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) {
        if (String(item?.tool || "").trim() === "write_stdin") return null;
        return item?.text || "";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "tool-write-1",
      type: "toolCall",
      tool: "write_stdin",
      status: "completed",
      arguments: JSON.stringify({ chars: "" }),
    }, { threadId: "thread-1", timestamp: 300 });

    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(chatBox.querySelector("#runtimeToolInline")).toBeNull();
  });

  it("replaces the previous completed batch when a new running phase starts", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "phase-1",
      type: "toolCall",
      tool: "shell_command",
      status: "completed",
      arguments: JSON.stringify({ command: "rg -n runtimeChatPanels src/ui/modules/codex-web/composerUi.js" }),
    }, { threadId: "thread-1", timestamp: 100 });
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("runtimeChatPanels");

    module.applyToolItemRuntimeUpdate({
      id: "phase-2",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/chatTimeline.test.js" }),
    }, { threadId: "thread-1", timestamp: 200 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("runtimeChatPanels");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("chatTimeline.test.js");
  });

  it("treats item/started notifications without explicit status as running tools", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", method: "item/started", timestamp: 100 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("composerUi.test.js");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
  });

  it("ignores placeholder tool updates that do not have any meaningful label yet", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", method: "item/started", timestamp: 100 });

    const beforeHtml = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(beforeHtml).toContain("composerUi.test.js");

    module.applyToolItemRuntimeUpdate({
      id: "ghost-tool-1",
      type: "toolCall",
      status: "running",
    }, { threadId: "thread-1", method: "item/started", timestamp: 200 });

    const afterHtml = chatBox.querySelector("#runtimeToolInline").innerHTML;
    expect(afterHtml).toContain("composerUi.test.js");
    expect(afterHtml).not.toContain(">Tool<");
    expect(state.activeThreadActiveCommands).toHaveLength(1);
  });

  it("animates a runtime card only on first appearance for the same command key", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("runtimeToolItemEnter");

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      status: "completed",
      arguments: JSON.stringify({ command: "npm test -- --run src/ui/modules/codex-web/composerUi.test.js" }),
    }, { threadId: "thread-1", timestamp: 200 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("runtimeToolItemEnter");
  });

  it("does not re-animate a runtime card when history refresh remaps the same command to a different item id", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "live-tool-1",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "rg -n runtimeDock codex-web.html" }),
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("runtimeToolItemEnter");

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "history-tool-77",
              type: "commandExecution",
              command: "rg -n runtimeDock codex-web.html",
              status: "running",
            },
          ],
        },
      ],
    });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("runtimeToolItemEnter");
  });

  it("keeps history runtime tools and activity visible while commentary is active", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-2",
        text: "thinking two",
        tools: ["Running `npm test`", "Running `npm run build`"],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
            { id: "cmd-1", type: "commandExecution", command: "npm test", status: "completed" },
            { id: "cmd-2", type: "commandExecution", command: "npm run build", status: "running" },
          ],
        },
      ],
    });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm test");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm run build");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeDock").style.display).toBe("");
  });

  it("shows Thinking for incomplete history before commentary arrives and clears it after completion", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadTransientThinkingText: "",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "run it from terminal" }] },
          ],
        },
      ],
    });

    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeDock").style.display).toBe("");

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "run it from terminal" }] },
            { type: "assistantMessage", id: "assistant-1", phase: "final_answer", text: "done" },
          ],
        },
      ],
    });

    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
  });

  it("does not rebuild runtime panels from interrupted incomplete history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-old", state: "running", text: "old" }],
      activeThreadActivity: { threadId: "thread-1", title: "Working", detail: "", tone: "running" },
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "old", steps: [] },
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryStatusType: "interrupted",
    };
    const syntheticPendingCalls = [];
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticPendingCalls.push({ threadId, items });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      status: { type: "interrupted" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking" },
            { type: "plan", text: "Inspect" },
            {
              id: "request-1",
              type: "toolCall",
              tool: "request_user_input",
              status: "running",
              arguments: JSON.stringify({
                questions: [{ id: "q-1", header: "Question 1/1", question: "Keep waiting?" }],
              }),
            },
          ],
        },
      ],
    });

    expect(syntheticPendingCalls).toEqual([{ threadId: "thread-1", items: [] }]);
    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
  });

  it("does not rebuild runtime panels from failed incomplete history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-old", state: "running", text: "old" }],
      activeThreadActivity: { threadId: "thread-1", title: "Working", detail: "", tone: "running" },
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "old", steps: [] },
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryStatusType: "failed",
    };
    const syntheticPendingCalls = [];
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticPendingCalls.push({ threadId, items });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      status: { type: "failed" },
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking" },
            { type: "plan", text: "Inspect" },
            {
              id: "request-1",
              type: "toolCall",
              tool: "request_user_input",
              status: "running",
              arguments: JSON.stringify({
                questions: [{ id: "q-1", header: "Question 1/1", question: "Keep waiting?" }],
              }),
            },
          ],
        },
      ],
    });

    expect(syntheticPendingCalls).toEqual([{ threadId: "thread-1", items: [] }]);
    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
  });

  it("does not restore proposed plan confirmation from interrupted history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const syntheticPendingCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadHistoryStatusType: "interrupted",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticPendingCalls.push({ threadId, items });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      status: { type: "interrupted" },
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "assistant-1",
              type: "assistantMessage",
              phase: "final_answer",
              text: `<proposed_plan>
# Cleanup Plan

- Clear stale pending UI.
</proposed_plan>`,
            },
          ],
        },
      ],
    });

    expect(syntheticPendingCalls).toEqual([{ threadId: "thread-1", items: [] }]);
    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
  });

  it("does not rebuild runtime panels from locally interrupted incomplete history before terminal status catches up", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [{ key: "cmd-old", state: "running", text: "old" }],
      activeThreadActivity: { threadId: "thread-1", title: "Working", detail: "", tone: "running" },
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "old", steps: [] },
      activeThreadCommentaryCurrent: null,
      suppressedIncompleteHistoryRuntimeByThreadId: { "thread-1": true },
    };
    const syntheticPendingCalls = [];
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticPendingCalls.push({ threadId, items });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "agentMessage", id: "commentary-1", phase: "commentary", text: "thinking" },
            { type: "plan", text: "Inspect" },
            { type: "commandExecution", command: "npm test", status: "running" },
          ],
        },
      ],
    });

    expect(syntheticPendingCalls).toEqual([{ threadId: "thread-1", items: [] }]);
    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadActivity).toBeNull();
  });

  it("keeps the activity bar on Thinking while an incomplete turn only has a plan update", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadTransientThinkingText: "",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", id: "user-1", content: [{ type: "text", text: "run it from terminal" }] },
            {
              id: "plan-1",
              type: "toolCall",
              tool: "update_plan",
              status: "running",
              arguments: JSON.stringify({
                explanation: "Keep the UI aligned with Codex",
                plan: [{ step: "Inspect runtime", status: "in_progress" }],
              }),
            },
          ],
        },
      ],
    });

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Updated Plan");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("Planning");
  });

  it("renders live runtime stack in the order plan then thinking then tools", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "Investigate runtime display",
        steps: [{ step: "Inspect live stack", status: "in_progress" }],
      },
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "thinking one",
        tools: [],
      },
      activeThreadTransientThinkingText: "thinking one",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "npm test" }),
    }, { threadId: "thread-1", timestamp: 100 });

    const panels = chatBox.querySelector("#runtimeChatPanels");
    expect(panels.children.map((child) => child.id)).toEqual([
      "runtimePlanInline",
      "runtimeThinkingInline",
      "runtimeToolInline",
    ]);
    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Updated Plan");
    expect(chatBox.querySelector("#runtimeThinkingInline").innerHTML).toContain("thinking one");
    expect(chatBox.querySelector("#runtimeThinkingInline").innerHTML).not.toContain("runtimeThinkingHeader");
    expect(chatBox.querySelector("#runtimeThinkingInline").innerHTML).not.toContain(">Thinking<");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm test");
  });

  it("prefers active commentary over a stored plan for the runtime activity bar", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: {
        threadId: "thread-1",
        title: "Updated Plan",
        explanation: "Investigate runtime",
        steps: [{ step: "Inspect", status: "in_progress" }],
      },
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-2",
        text: "thinking two",
        tools: [],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            { type: "plan", text: "Inspect" },
            { type: "agentMessage", id: "commentary-2", phase: "commentary", text: "thinking two" },
          ],
        },
      ],
    });

    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("Planning");
  });

  it("accumulates tool rows within the same live commentary block", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-2",
        text: "thinking two",
        tools: [],
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "cmd-1",
      type: "toolCall",
      tool: "shell_command",
      status: "completed",
      arguments: JSON.stringify({ command: "npm test" }),
    }, { threadId: "thread-1", timestamp: 100 });
    module.applyToolItemRuntimeUpdate({
      id: "cmd-2",
      type: "toolCall",
      tool: "shell_command",
      status: "running",
      arguments: JSON.stringify({ command: "npm run build" }),
    }, { threadId: "thread-1", timestamp: 200 });

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm test");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm run build");
  });

  it("does not re-append runtime chat panels for identical plan updates", () => {
    const nodes = new Map();
    let appendCount = 0;
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    chatBox.appendChild = function appendChild(node) {
      appendCount += 1;
      this.children = this.children.filter((item) => item !== node);
      this.children.push(node);
      node.parentNode = this;
    };
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActivePlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Need a quick plan",
      steps: [{ step: "Inspect history", status: "completed" }],
      deltaText: "",
    });
    module.setActivePlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Need a quick plan",
      steps: [{ step: "Inspect history", status: "completed" }],
      deltaText: "",
    });

    expect(appendCount).toBe(1);
  });

  it("renders runtime plan and tool panels in the chat-bottom runtime mount", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.setActivePlan({
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Need a quick plan",
      steps: [{ step: "Inspect history", status: "completed" }],
      deltaText: "",
    });
    module.setActiveCommands([
      { key: "cmd-1", text: "Ran `npm test`", state: "complete", icon: "command" },
    ]);

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Inspect history");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("npm test");
  });

  it("maps update_plan tool calls into a plan card instead of a generic tool row", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() {
        return "Updating plan";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "plan-1",
      type: "toolCall",
      tool: "update_plan",
      status: "running",
      arguments: JSON.stringify({
        explanation: "Keep the UI aligned with Codex",
        plan: [
          { step: "Fix runtime display", status: "in_progress" },
          { step: "Add regression tests", status: "pending" },
        ],
      }),
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Updated Plan");
    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Fix runtime display");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toBe("");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("Updated Plan");
  });

  it("maps request_user_input tool calls into synthetic pending questions", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const syntheticCalls = [];
    const upsertCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() {
        return "Waiting for input";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticCalls.push({ threadId, items });
      },
      upsertSyntheticPendingUserInput(threadId, item) {
        upsertCalls.push({ threadId, item });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "input-tool-1",
      type: "toolCall",
      tool: "request_user_input",
      status: "running",
      arguments: JSON.stringify({
        questions: [
          {
            id: "scope",
            header: "Question 1/1",
            question: "Where should preview appear?",
            options: [{ label: "Current chat" }],
          },
        ],
      }),
    }, { threadId: "thread-1", timestamp: 100 });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "input-tool-1",
              type: "toolCall",
              tool: "request_user_input",
              status: "running",
              arguments: JSON.stringify({
                questions: [
                  {
                    id: "scope",
                    header: "Question 1/1",
                    question: "Where should preview appear?",
                    options: [{ label: "Current chat" }],
                  },
                ],
              }),
            },
          ],
        },
      ],
    });

    expect(upsertCalls).toEqual([
      {
        threadId: "thread-1",
        item: {
          id: "input-tool-1",
          prompt: "Where should preview appear?",
          title: "",
          questions: [
            {
              id: "scope",
              header: "Question 1/1",
              question: "Where should preview appear?",
              options: [{ label: "Current chat" }],
            },
          ],
        },
      },
    ]);
    expect(syntheticCalls).toEqual([
      {
        threadId: "thread-1",
        items: [
          {
            id: "input-tool-1",
            prompt: "Where should preview appear?",
            title: "",
            questions: [
              {
                id: "scope",
                header: "Question 1/1",
                question: "Where should preview appear?",
                options: [{ label: "Current chat" }],
              },
            ],
          },
        ],
      },
    ]);
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(chatBox.querySelector("#runtimeToolInline")).toBeNull();
  });

  it("keeps request_user_input questions visible even when the tool item is completed", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const syntheticCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return "Waiting for input"; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticCalls.push({ threadId, items });
      },
      upsertSyntheticPendingUserInput() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "input-tool-complete",
              type: "toolCall",
              tool: "request_user_input",
              status: "completed",
              arguments: JSON.stringify({
                questions: [
                  {
                    id: "scope",
                    question: "Implement now?",
                    options: [{ label: "Yes" }, { label: "No" }],
                  },
                ],
              }),
            },
          ],
        },
      ],
    });

    expect(syntheticCalls).toEqual([
      {
        threadId: "thread-1",
        items: [
          {
            id: "input-tool-complete",
            prompt: "Implement now?",
            title: "",
            questions: [
              {
                id: "scope",
                question: "Implement now?",
                options: [{ label: "Yes" }, { label: "No" }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("does not restore proposed plan confirmation from completed history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const syntheticCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() { return ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      setSyntheticPendingUserInputs(threadId, items) {
        syntheticCalls.push({ threadId, items });
      },
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: false },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "assistant-1",
              type: "assistantMessage",
              phase: "final_answer",
              text: `<proposed_plan>
# Cleanup Plan

### Summary
- Clear stale pending UI.
</proposed_plan>`,
            },
          ],
        },
      ],
    });

    expect(syntheticCalls).toEqual([
      {
        threadId: "thread-1",
        items: [],
      },
    ]);
  });

  it("keeps the pending activity bar on Thinking when a live update_plan arrives before commentary", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadTransientThinkingText: "",
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage() {
        return "Updating plan";
      },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "plan-1",
      type: "toolCall",
      tool: "update_plan",
      status: "running",
      arguments: JSON.stringify({
        explanation: "Keep the UI aligned with Codex",
        plan: [
          { step: "Fix runtime display", status: "in_progress" },
          { step: "Add regression tests", status: "pending" },
        ],
      }),
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("Updated Plan");
    expectWorkingActivityBarHtml(nodes.get("runtimeActivityBar").innerHTML);
    expect(nodes.get("runtimeActivityBar").innerHTML).not.toContain("Updated Plan");
  });

  it("does not re-animate an updated plan card when the same plan turn refreshes from history", () => {
    const nodes = new Map();
    const runtimeDock = makeNode();
    const runtimeActivityBar = makeNode();
    runtimeActivityBar.id = "runtimeActivityBar";
    runtimeDock.appendChild(runtimeActivityBar);
    nodes.set("runtimeDock", runtimeDock);
    nodes.set("runtimeActivityBar", runtimeActivityBar);
    const chatBox = makeNode();
    nodes.set("chatBox", chatBox);
    const state = {
      activeThreadId: "thread-1",
      activeThreadTokenUsage: null,
      activeMainTab: "chat",
      activeThreadActiveCommands: [],
      activeThreadActivity: null,
      activeThreadPlan: null,
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || (id === "mobilePromptInput" ? { value: "" } : null);
      },
      readPromptValue(node) { return String(node?.value || ""); },
      clearPromptInput() {},
      resolveMobilePromptLayout() { return { heightPx: 40, overflowY: "hidden" }; },
      renderComposerContextLeftInNode() {},
      renderInlineMessageText(value) { return `<span>${String(value || "")}</span>`; },
      toolItemToMessage(item) { return item?.text || ""; },
      normalizeType(value) { return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); },
      escapeHtml(value) { return String(value || ""); },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; }, createElement: makeElementFactory(chatBox) },
      windowRef: { innerHeight: 900 },
    });

    module.applyToolItemRuntimeUpdate({
      id: "plan-live-1",
      type: "toolCall",
      tool: "update_plan",
      status: "running",
      arguments: JSON.stringify({
        explanation: "Investigate live commentary",
        plan: [{ step: "Inspect runtime", status: "in_progress" }],
      }),
    }, { threadId: "thread-1", timestamp: 100 });

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("runtimePlanCard");
    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).toContain("runtimePlanCardEnter");

    module.syncRuntimeStateFromHistory({
      id: "thread-1",
      page: { incomplete: true },
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "plan-history-1",
              type: "plan",
              text: "Inspect runtime",
            },
          ],
        },
      ],
    });

    expect(chatBox.querySelector("#runtimePlanInline").innerHTML).not.toContain("runtimePlanCardEnter");
  });

  it("renders the separate branch and permission picker bar below the composer meta row", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: true,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
      permissionPresetByWorkspace: {
        windows: "/permission full-access",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();

    expect(nodes.get("composerPickerBar")?.style.display || "").toBe("");
    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").toContain("main");
    expect(nodes.get("composerPermissionPickerBtn")?.innerHTML || "").toContain("Full access");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("composerPickerMenuScroll");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("feature/ui");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("#182");
    expect(nodes.get("composerBranchPickerMenu")?.classList.contains("open")).toBe(true);
  });

  it("reads the permission picker preset from the active WSL2 workspace", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "wsl2",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "thread:wsl2:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }],
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission full-access",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();

    expect(nodes.get("composerPermissionPickerBtn")?.innerHTML || "").toContain("Full access");
  });

  it("loads branch picker state from the selected project folder before a thread exists", async () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const apiCalls = [];
    const state = {
      activeMainTab: "chat",
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      startCwdByWorkspace: { windows: "C:\\repo\\demo", wsl2: "" },
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: false,
      activeThreadGitMetaKey: "",
      activeThreadCurrentBranch: "",
      activeThreadBranchOptions: [],
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      api(url) {
        apiCalls.push(url);
        return Promise.resolve({
          workspace: "windows",
          cwd: "C:\\repo\\demo",
          currentBranch: "main",
          branches: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
          isWorktree: false,
        });
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();
    await Promise.resolve();
    await Promise.resolve();

    expect(apiCalls[0]).toContain("/codex/git?workspace=windows");
    expect(apiCalls[0]).toContain("cwd=C%3A%5Crepo%5Cdemo");
    expect(nodes.get("composerBranchPickerBtn")?.disabled).toBe(false);
    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").toContain("main");
    expect(state.activeThreadGitMetaSource).toBe("cwd");
  });

  it("does not rewrite the open branch menu when branch state is unchanged", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const branchMenu = nodes.get("composerBranchPickerMenu");
    const branchBtn = nodes.get("composerBranchPickerBtn");
    let branchMenuWrites = 0;
    let branchBtnWrites = 0;
    let branchMenuHtml = "";
    let branchBtnHtml = "";
    Object.defineProperty(branchMenu, "innerHTML", {
      get() {
        return branchMenuHtml;
      },
      set(value) {
        branchMenuWrites += 1;
        branchMenuHtml = String(value || "");
      },
      configurable: true,
    });
    Object.defineProperty(branchBtn, "innerHTML", {
      get() {
        return branchBtnHtml;
      },
      set(value) {
        branchBtnWrites += 1;
        branchBtnHtml = String(value || "");
      },
      configurable: true,
    });
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: true,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
      permissionPresetByWorkspace: {
        windows: "/permission full-access",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();
    module.updateMobileComposerState();

    expect(branchBtnWrites).toBe(1);
    expect(branchMenuWrites).toBe(1);
  });

  it("keeps branch options visible in the menu while the branch button shows loading", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: true,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: true,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
      permissionPresetByWorkspace: {
        windows: "/permission full-access",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();

    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").toContain("Loading...");
    expect(nodes.get("composerBranchPickerBtn")?.disabled).toBe(true);
    expect(nodes.get("composerBranchPickerMenu")?.classList.contains("open")).toBe(false);
  });

  it("animates the branch picker label when loading resolves to a branch name", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: true,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();
    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").not.toContain("is-animating");

    state.activeThreadGitMetaLoading = false;
    module.updateMobileComposerState();

    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").toContain("composerPickerBtnLabel is-animating");
    expect(nodes.get("composerBranchPickerBtn")?.innerHTML || "").toContain("main");
  });

  it("shows uncommitted file count and disables other branch options in the menu", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: true,
      composerPermissionMenuOpen: false,
      activeThreadUncommittedFileCount: 3,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }, { name: "feature/ui", prNumber: 182 }],
      permissionPresetByWorkspace: {
        windows: "/permission full-access",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();

    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("uncommitted files: 3");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("feature/ui");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").not.toContain(" is-disabled");
    expect(nodes.get("composerBranchPickerMenu")?.innerHTML || "").toContain("composerPickerMenuItem is-active");
  });

  it("does not trigger a git-meta refresh when the loaded key already matches", () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "hello";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    let apiCalls = 0;
    const module = createComposerUiModule({
      state: {
        activeMainTab: "chat",
        activeThreadId: "thread-1",
        activeThreadWorkspace: "windows",
        workspaceTarget: "windows",
        activeThreadPendingTurnRunning: false,
        activeThreadQueuedTurns: [],
        composerActionMenuOpen: false,
        composerBranchMenuOpen: false,
        composerPermissionMenuOpen: false,
        activeThreadGitMetaLoading: false,
        activeThreadGitMetaLoaded: true,
        activeThreadGitMetaKey: "thread:windows:thread-1",
        activeThreadCurrentBranch: "main",
        activeThreadBranchOptions: [{ name: "main" }],
        permissionPresetByWorkspace: {
          windows: "/permission auto",
          wsl2: "/permission auto",
        },
      },
      byId(id) {
        return nodes.get(id) || null;
      },
      api() {
        apiCalls += 1;
        return Promise.resolve(null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    module.updateMobileComposerState();

    expect(apiCalls).toBe(0);
  });

  it("clears the worktree flag when git meta is reset", async () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      startCwdByWorkspace: { windows: "", wsl2: "" },
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaError: "",
      activeThreadGitMetaErrorKey: "",
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }],
      activeThreadIsWorktree: true,
      activeThreadUncommittedFileCount: 2,
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      api() {
        return Promise.resolve(null);
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    await module.refreshActiveThreadGitMeta({ force: true });

    expect(state.activeThreadCurrentBranch).toBe("");
    expect(state.activeThreadBranchOptions).toEqual([]);
    expect(state.activeThreadIsWorktree).toBe(false);
    expect(state.activeThreadUncommittedFileCount).toBe(0);
    expect(state.activeThreadGitMetaLoaded).toBe(false);
    expect(state.activeThreadGitMetaError).toBe("");
    expect(state.activeThreadGitMetaErrorKey).toBe("");
  });

  it("preserves the last good git metadata when refresh fails", async () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      startCwdByWorkspace: { windows: "C:\\repo", wsl2: "" },
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: true,
      activeThreadGitMetaError: "",
      activeThreadGitMetaErrorKey: "",
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }],
      activeThreadIsWorktree: true,
      activeThreadUncommittedFileCount: 2,
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      api() {
        return Promise.reject(new Error("boom"));
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    await module.refreshActiveThreadGitMeta({ force: true });

    expect(state.activeThreadCurrentBranch).toBe("main");
    expect(state.activeThreadBranchOptions).toEqual([{ name: "main" }]);
    expect(state.activeThreadIsWorktree).toBe(true);
    expect(state.activeThreadUncommittedFileCount).toBe(2);
    expect(state.activeThreadGitMetaLoaded).toBe(false);
    expect(state.activeThreadGitMetaError).toBe("git metadata unavailable");
    expect(state.activeThreadGitMetaErrorKey).toBe("thread:windows:thread-1");
  });

  it("does not auto-retry git metadata after a same-key failure", async () => {
    const nodes = new Map();
    for (const id of [
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    let apiCalls = 0;
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-1",
      activeThreadWorkspace: "windows",
      workspaceTarget: "windows",
      startCwdByWorkspace: { windows: "C:\\repo", wsl2: "" },
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: false,
      activeThreadGitMetaError: "git metadata unavailable",
      activeThreadGitMetaErrorKey: "thread:windows:thread-1",
      activeThreadGitMetaKey: "thread:windows:thread-1",
      activeThreadCurrentBranch: "main",
      activeThreadBranchOptions: [{ name: "main" }],
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      api() {
        apiCalls += 1;
        return Promise.reject(new Error("boom"));
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    await module.refreshActiveThreadGitMeta();

    expect(apiCalls).toBe(0);
  });

  it("uses the cached thread workspace when git metadata state is stale", async () => {
    const nodes = new Map();
    for (const id of [
      "mobileComposerRow",
      "mobilePromptWrap",
      "mobilePromptInput",
      "mobileSendBtn",
      "composerActionMenuBtn",
      "composerActionMenu",
      "queuedTurnCard",
      "queuedTurnCardTitle",
      "queuedTurnCardCount",
      "queuedTurnToggleBtn",
      "queuedTurnCardStatus",
      "queuedTurnCardList",
      "queuedTurnCardSummary",
      "composerPickerBar",
      "composerBranchPickerBtn",
      "composerBranchPickerMenu",
      "composerPermissionPickerBtn",
      "composerPermissionPickerMenu",
    ]) {
      nodes.set(id, makeNode());
    }
    nodes.get("mobilePromptInput").value = "";
    nodes.get("mobilePromptInput").scrollHeight = 44;
    const apiCalls = [];
    const state = {
      activeMainTab: "chat",
      activeThreadId: "thread-win",
      activeThreadWorkspace: "wsl2",
      workspaceTarget: "wsl2",
      startCwdByWorkspace: { windows: "C:\\repo", wsl2: "/repo" },
      threadItemsAll: [],
      threadItemsByWorkspace: {
        windows: [{ id: "thread-win", workspace: "windows", cwd: "C:\\repo" }],
        wsl2: [{ id: "thread-wsl", workspace: "wsl2", cwd: "/repo" }],
      },
      activeThreadPendingTurnRunning: false,
      activeThreadQueuedTurns: [],
      composerActionMenuOpen: false,
      composerBranchMenuOpen: false,
      composerPermissionMenuOpen: false,
      activeThreadGitMetaLoading: false,
      activeThreadGitMetaLoaded: false,
      activeThreadGitMetaError: "",
      activeThreadGitMetaErrorKey: "",
      activeThreadGitMetaKey: "",
      activeThreadCurrentBranch: "",
      activeThreadBranchOptions: [],
      permissionPresetByWorkspace: {
        windows: "/permission auto",
        wsl2: "/permission auto",
      },
    };
    const module = createComposerUiModule({
      state,
      byId(id) {
        return nodes.get(id) || null;
      },
      api(url) {
        apiCalls.push(url);
        return Promise.resolve({
          threadId: "thread-win",
          workspace: "windows",
          cwd: "C:\\repo",
          currentBranch: "main",
          branches: [{ name: "main" }],
          isWorktree: false,
        });
      },
      detectThreadWorkspaceTarget(thread) {
        return String(thread?.workspace || "").trim() === "wsl2" ? "wsl2" : "windows";
      },
      readPromptValue(node) {
        return String(node?.value || "");
      },
      clearPromptInput() {},
      resolveMobilePromptLayout() {
        return { heightPx: 44, overflowY: "hidden" };
      },
      renderComposerContextLeftInNode() {},
      escapeHtml(value) {
        return String(value || "");
      },
      updateHeaderUi() {},
      documentRef: { querySelector() { return null; } },
      windowRef: { innerHeight: 900 },
    });

    await module.refreshActiveThreadGitMeta({ force: true });

    expect(apiCalls).toEqual(["/codex/threads/thread-win/git?workspace=windows"]);
    expect(state.activeThreadWorkspace).toBe("windows");
    expect(state.activeThreadGitMetaKey).toBe("thread:windows:thread-win");
  });
});
