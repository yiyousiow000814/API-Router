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
    expect(nodes.get("runtimeActivityBar").innerHTML).toContain("Planning");
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

  it("keeps finished commands in the runtime panel but clears the activity bar", () => {
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
    expect(nodes.get("runtimeActivityBar").innerHTML).toBe("");
    expect(nodes.get("runtimeDock").style.display).toBe("none");
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
});
