import { describe, expect, it } from "vitest";

import { createComposerUiModule } from "./composerUi.js";

describe("composerUi", () => {
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
    return {
      id: "",
      style: {},
      innerHTML: "",
      textContent: "",
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
    };
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
    return (tag) => ({
      tagName: String(tag || "").toUpperCase(),
      id: "",
      className: "",
      style: {},
      innerHTML: "",
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
      remove() {
        if (this.parentNode?.children) {
          this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
        }
        if (dockRef?.children) {
          dockRef.children = dockRef.children.filter((item) => item !== this);
        }
        this.parentNode = null;
      },
    });
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Planning");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Thinking");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Thinking");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Thinking");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Running tool");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Ran command");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Ran command");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
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

    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("runtimeActivityDots");
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Ran command");
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

    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).toContain("Edited src/ui/modules/codex-web/chatTimeline.js");
    expect(chatBox.querySelector("#runtimeToolInline").innerHTML).not.toContain("apply_patch");
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
    expect(html).toContain("Edited 2 files");
    expect(html).toContain("runtimeToolItemDiffAdd");
    expect(html).toContain("runtimeToolItemDiffDel");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Running command");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Running command");
    expect(nodes.get("runtimeDock").style.display).toBe("");
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

    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Thinking");
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Updated Plan");
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
});
