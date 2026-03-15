import { describe, expect, it } from "vitest";

import {
  createSlashCommandsModule,
  filterSlashCommands,
  normalizeSlashCommandCatalog,
  readSlashSearchQuery,
} from "./slashCommands.js";

describe("slashCommands", () => {
  it("normalizes nested slash command catalogs from the backend", () => {
    expect(
      normalizeSlashCommandCatalog({
        commands: [
          { command: "/help", usage: "/help", insertText: "/help", description: "Show help" },
          { command: "/fork", usage: "/fork", insertText: "/fork", description: "hidden" },
          {
            command: "/plan",
            usage: "/plan",
            insertText: "/plan",
            description: "Plan mode",
            children: [
              { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "On" },
              { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Off" },
            ],
          },
        ],
      })
    ).toEqual([
      {
        command: "/plan",
        usage: "/plan",
        insertText: "/plan",
        description: "Plan mode",
        active: false,
        children: [
          { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "On", active: false, children: [] },
          { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Off", active: false, children: [] },
        ],
      },
    ]);
  });

  it("keeps workspace-specific permission options from the backend", () => {
    expect(
      normalizeSlashCommandCatalog({
        commands: [
          {
            command: "/permission",
            usage: "/permission",
            insertText: "/permission",
            description: "Permissions",
            children: [
              { command: "/permission auto", usage: "/permission auto", insertText: "/permission auto", description: "Auto" },
              { command: "/permission full-access", usage: "/permission full-access", insertText: "/permission full-access", description: "Full access" },
            ],
          },
        ],
      })
    ).toEqual([
      {
        command: "/permission",
        usage: "/permission",
        insertText: "/permission",
        description: "Permissions",
        active: false,
        children: [
          { command: "/permission auto", usage: "/permission auto", insertText: "/permission auto", description: "Auto", active: false, children: [] },
          {
            command: "/permission full-access",
            usage: "/permission full-access",
            insertText: "/permission full-access",
            description: "Full access",
            active: false,
            children: [],
          },
        ],
      },
    ]);
  });

  it("extracts slash search queries only for the first token", () => {
    expect(readSlashSearchQuery("/")).toBe("");
    expect(readSlashSearchQuery("/pl")).toBe("pl");
    expect(readSlashSearchQuery("/plan add checklist")).toBe("");
    expect(readSlashSearchQuery("hello")).toBe("");
  });

  it("filters slash commands by top-level command prefix", () => {
    const commands = [
      { command: "/plan", usage: "/plan", insertText: "/plan", description: "Plan mode", children: [] },
      { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
      { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
    ];
    expect(filterSlashCommands(commands, "/pl")).toEqual([commands[0]]);
    expect(filterSlashCommands(commands, "/com")).toEqual([commands[1]]);
    expect(filterSlashCommands(commands, "/re")).toEqual([commands[2]]);
  });

  it("enters a submenu when selecting a parent slash command", async () => {
    const state = {
      slashCommands: [],
      slashCommandsLoaded: false,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector(selector) {
        if (selector === '[data-slash-index="0"]') return this._selectedNode;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const input = {
      value: "/pl",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const wrap = {
      getBoundingClientRect() {
        return { left: 16, top: 412, width: 336 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        if (id === "mobilePromptWrap") return wrap;
        return null;
      },
      api: async () => ({
        commands: [
          {
            command: "/plan",
            usage: "/plan",
            insertText: "/plan",
            description: "Plan mode",
            children: [
              { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "Enable" },
              { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Disable" },
            ],
          },
        ],
      }),
      escapeHtml: (value) => String(value || ""),
      updateMobileComposerState: () => {},
      setStatus: () => {},
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    menu._selectedNode = {
      scrollIntoView() {
        menu.__scrolled = true;
      },
    };

    await module.refreshSlashCommands();
    module.syncSlashCommandMenu();

    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("/plan");
    expect(menu.style.display).toBe("block");
    expect(menu.innerHTML).not.toContain("is-selected");

    const handled = module.handleSlashCommandKeyDown({
      key: "Enter",
      preventDefault() {},
    });
    expect(handled).toBe(true);
    expect(input.value).toBe("/plan");
    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("/plan on");
    expect(menu.innerHTML).toContain("/plan off");
    expect(menu.__scrolled).toBeUndefined();
  });

  it("shows selection only after keyboard navigation", () => {
    const state = {
      slashCommands: [
        { command: "/fast", usage: "/fast", insertText: "/fast", description: "Fast", children: [] },
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector(selector) {
        if (selector === '[data-slash-index="1"]') {
          return {
            scrollIntoView() {
              menu.__scrolled = true;
            },
          };
        }
        return null;
      },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    expect(menu.innerHTML).not.toContain("is-selected");

    module.handleSlashCommandKeyDown({
      key: "ArrowDown",
      preventDefault() {},
    });

    expect(state.slashMenuSelectionVisible).toBe(true);
    expect(menu.innerHTML).toContain("is-selected");
    expect(menu.__scrolled).toBe(true);
  });

  it("keeps the selected slash item visible by adjusting the menu scroll box", () => {
    const state = {
      slashCommands: [
        { command: "/fast", usage: "/fast", insertText: "/fast", description: "Fast", children: [] },
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const scrollBox = {
      scrollTop: 0,
      clientHeight: 120,
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector(selector) {
        if (selector === ".slashCommandScroll") return scrollBox;
        if (selector === '[data-slash-index="1"]') {
          return {
            offsetTop: 148,
            offsetHeight: 36,
            scrollIntoView() {
              menu.__fallbackScrolled = true;
            },
          };
        }
        return null;
      },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
        requestAnimationFrame(cb) { cb(); },
      },
    });

    module.syncSlashCommandMenu();
    module.handleSlashCommandKeyDown({
      key: "ArrowDown",
      preventDefault() {},
    });

    expect(scrollBox.scrollTop).toBe(72);
    expect(menu.__fallbackScrolled).toBeUndefined();
  });

  it("returns to the top-level slash menu on escape from a submenu", async () => {
    const state = {
      slashCommands: [
        {
          command: "/plan",
          usage: "/plan",
          insertText: "/plan",
          description: "Plan mode",
          children: [
            { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "Enable", children: [] },
            { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Disable", children: [] },
          ],
        },
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/plan",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      updateMobileComposerState: () => {},
      setStatus: () => {},
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    expect(menu.innerHTML).toContain("/plan on");

    const handled = module.handleSlashCommandKeyDown({
      key: "Escape",
      preventDefault() {},
    });

    expect(handled).toBe(true);
    expect(input.value).toBe("/");
    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("/compact");
    expect(menu.innerHTML).toContain("/plan");
  });

  it("keeps the slash menu open while async refreshes resolve from inside the menu", async () => {
    let resolveCommands;
    const state = {
      slashCommands: [],
      slashCommandsLoaded: false,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menuButton = {};
    const menu = {
      style: {},
      innerHTML: "",
      contains(target) {
        return target === menuButton;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        if (path.startsWith("/codex/slash/commands?")) {
          return await new Promise((resolve) => {
            resolveCommands = () => resolve({
              commands: [
                { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
                { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
              ],
            });
          });
        }
        throw new Error(`unexpected path: ${path}`);
      },
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("Loading slash commands");

    documentRef.activeElement = menuButton;
    resolveCommands();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.slashMenuOpen).toBe(true);
    expect(menu.style.display).toBe("block");
  });

  it("returns from review branches to presets and then to the root slash menu", async () => {
    const state = {
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
        { command: "/diff", usage: "/diff", insertText: "/diff", description: "Diff", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menuBack = {};
    const menu = {
      style: {},
      innerHTML: "",
      contains(target) {
        return target === menuBack;
      },
      querySelector(selector) {
        if (selector === "[data-slash-back='true']") return menuBack;
        return null;
      },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/review",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        if (path.startsWith("/codex/slash/review/branches?")) {
          return { items: [{ value: "main", label: "fix/web -> main" }] };
        }
        return { commands: [] };
      },
      getStartCwdForWorkspace: () => "C:\\repo",
      updateMobileComposerState() {},
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    expect(menu.innerHTML).toContain("Select a review preset");

    module.applySelectedSlashCommand();
    await Promise.resolve();
    await Promise.resolve();
    expect(menu.innerHTML).toContain("Select a base branch");

    documentRef.activeElement = menuBack;
    expect(module.handleSlashCommandKeyDown({ key: "Escape", preventDefault() {} })).toBe(true);
    expect(menu.innerHTML).toContain("Select a review preset");

    documentRef.activeElement = menuBack;
    expect(module.handleSlashCommandKeyDown({ key: "Escape", preventDefault() {} })).toBe(true);
    expect(state.slashMenuOpen).toBe(true);
    expect(input.value).toBe("/");
    expect(menu.innerHTML).toContain("/compact");
    expect(menu.innerHTML).toContain("/diff");
  });

  it("renders review branch children with a horizontal branch glyph", async () => {
    let resolveBranches;
    const state = {
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/review",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        if (path.startsWith("/codex/slash/review/branches?")) {
          return await new Promise((resolve) => {
            resolveBranches = () => resolve({ items: [{ value: "main", label: "fix/web -> main" }] });
          });
        }
        return { commands: [] };
      },
      getStartCwdForWorkspace: () => "C:\\repo",
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    module.applySelectedSlashCommand();
    resolveBranches();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(menu.innerHTML).toContain("↳");
    expect(menu.innerHTML).not.toContain("└↘");
  });

  it("prioritizes the main branch at the top of review branch results", async () => {
    let resolveBranches;
    const state = {
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/review",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        if (path.startsWith("/codex/slash/review/branches?")) {
          return await new Promise((resolve) => {
            resolveBranches = () => resolve({
              items: [
                { value: "fix/web-codex-history-ui", label: "fix/current -> fix/web-codex-history-ui" },
                { value: "main", label: "fix/current -> main" },
                { value: "fix/provider-healthy-refresh-on-renew", label: "fix/current -> fix/provider-healthy-refresh-on-renew" },
              ],
            });
          });
        }
        return { commands: [] };
      },
      getStartCwdForWorkspace: () => "C:\\repo",
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    module.applySelectedSlashCommand();
    resolveBranches();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mainPos = menu.innerHTML.indexOf("main");
    const otherPos = menu.innerHTML.indexOf("fix/web-codex-history-ui");
    expect(mainPos).toBeGreaterThan(-1);
    expect(otherPos).toBeGreaterThan(-1);
    expect(mainPos).toBeLessThan(otherPos);
  });

  it("does not re-render the menu while scrolling inside the menu itself", () => {
    const listeners = {};
    const state = {
      slashCommands: [
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const menu = {
      style: {},
      innerHTML: "",
      contains(target) {
        return target === this;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 40, top: 500, width: 280 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener(name, handler) {
          listeners[name] = handler;
        },
      },
    });

    module.syncSlashCommandMenu();
    const htmlBefore = menu.innerHTML;
    listeners.scroll?.({ target: menu });
    expect(menu.innerHTML).toBe(htmlBefore);
  });

  it("does not activate a submenu child from the same click sequence", async () => {
    const state = {
      slashCommands: [
        {
          command: "/permission",
          usage: "/permission",
          insertText: "/permission",
          description: "Permission presets",
          children: [
            {
              command: "/permission full-access",
              usage: "/permission full-access",
              insertText: "/permission full-access",
              description: "Full access",
              children: [],
            },
          ],
        },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const listeners = {};
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() {
        return [
          {
            getAttribute(name) {
              return name === "data-slash-index" ? "0" : "";
            },
            addEventListener(name, handler) {
              listeners[name] = handler;
            },
            scrollIntoView() {},
          },
        ];
      },
    };
    const input = {
      value: "/",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      updateMobileComposerState: () => {},
      setStatus: () => {},
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    listeners.pointerdown?.({ type: "pointerdown", button: 0, isPrimary: true, preventDefault() {} });
    listeners.pointerdown?.({ type: "pointerdown", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });
    listeners.pointerup?.({ type: "pointerup", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });

    expect(input.value).toBe("/permission");
    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("/permission full-access");
  });

  it("executes selection submenu commands directly with a checkmark", () => {
    const listeners = {};
    const executed = [];
    let suppressedMs = 0;
    const state = {
      workspaceTarget: "windows",
      activeThreadWorkspace: "windows",
      planModeEnabled: true,
      fastModeEnabled: false,
      permissionPresetByWorkspace: { windows: "/permission auto", wsl2: "" },
      slashCommands: [
        {
          command: "/plan",
          usage: "/plan",
          insertText: "/plan",
          description: "Plan mode",
          active: false,
          children: [
            { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "Enable", active: false, children: [] },
            { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Disable", active: false, children: [] },
          ],
        },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() {
        return [
          {
            getAttribute(name) {
              return name === "data-slash-index" ? "0" : "";
            },
            addEventListener(name, handler) {
              listeners[name] = handler;
            },
          },
        ];
      },
    };
    const input = {
      value: "/plan",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      armSyntheticClickSuppression(ms) {
        suppressedMs = ms;
      },
      executeSlashCommand(command) {
        executed.push(command);
        return Promise.resolve();
      },
      updateMobileComposerState() {},
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(menu.innerHTML).toContain("slashCommandCheck is-active");
    expect(menu.innerHTML).toContain("✓");

    listeners.pointerdown?.({ type: "pointerdown", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });
    listeners.pointerup?.({ type: "pointerup", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });

    expect(executed).toEqual(["/plan on"]);
    expect(input.value).toBe("/plan");
    expect(suppressedMs).toBe(420);
  });

  it("prevents pointerdown focus-steal on slash menu items", () => {
    const listeners = {};
    const state = {
      slashCommands: [
        {
          command: "/fast",
          usage: "/fast",
          insertText: "/fast",
          description: "Fast mode",
          children: [
            { command: "/fast on", usage: "/fast on", insertText: "/fast on", description: "On", children: [] },
          ],
        },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() {
        return [
          {
            getAttribute(name) {
              return name === "data-slash-index" ? "0" : "";
            },
            addEventListener(name, handler) {
              listeners[name] = handler;
            },
          },
        ];
      },
      addEventListener() {},
    };
    const input = {
      value: "/fast",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      updateMobileComposerState() {},
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    const event = {
      prevented: false,
      stopped: false,
      type: "pointerdown",
      button: 0,
      isPrimary: true,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };

    listeners.pointerdown?.(event);

    expect(event.prevented).toBe(true);
    expect(event.stopped).toBe(true);
  });

  it("stops pointer events from leaking through the slash menu", () => {
    const listeners = {};
    const state = {
      slashCommands: [
        { command: "/fast", usage: "/fast", insertText: "/fast", description: "Fast", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      addEventListener(name, handler) {
        listeners[`menu:${name}`] = handler;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    const event = {
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    listeners["menu:pointerdown"]?.(event);

    expect(event.prevented).toBe(false);
    expect(event.stopped).toBe(true);
  });

  it("uses the active thread cwd for review pickers before falling back to selected folder", async () => {
    const requests = [];
    const state = {
      activeThreadId: "thread-1",
      threadItemsAll: [
        { id: "thread-1", cwd: "/home/yiyou/repo" },
      ],
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const listeners = {};
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() {
        return [
          {
            getAttribute(name) {
              return name === "data-slash-index" ? "0" : "";
            },
            addEventListener(name, handler) {
              listeners[name] = handler;
            },
          },
        ];
      },
    };
    const input = {
      value: "/review",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        requests.push(path);
        if (path.startsWith("/codex/slash/review/branches?")) {
          return { items: [{ value: "main", label: "main" }] };
        }
        return { commands: [] };
      },
      getWorkspaceTarget: () => "wsl2",
      getStartCwdForWorkspace: () => "",
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    listeners.pointerdown?.({ type: "pointerdown", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });
    listeners.pointerup?.({ type: "pointerup", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toContain("/codex/slash/review/branches?workspace=wsl2&cwd=%2Fhome%2Fyiyou%2Frepo");
    expect(menu.innerHTML).not.toContain("Select a folder first.");
  });

  it("hides duplicate usage text when usage equals the command", () => {
    const state = {
      slashCommands: [
        {
          command: "/fast",
          usage: "/fast",
          insertText: "/fast",
          description: "Fast mode",
          children: [
            { command: "/fast on", usage: "/fast on", insertText: "/fast on", description: "Enable Fast mode.", active: false, children: [] },
            { command: "/fast off", usage: "/fast off", insertText: "/fast off", description: "Disable Fast mode.", active: true, children: [] },
          ],
        },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
      fastModeEnabled: false,
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/fast",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(menu.innerHTML).toContain("/fast on");
    expect(menu.innerHTML).not.toContain('/fast on</span><span class="slashCommandUsage">');
    expect(menu.innerHTML).toContain("Disable Fast mode.");
  });

  it("resets submenu selection to the first child when context changes", () => {
    const state = {
      slashCommands: [
        { command: "/fast", usage: "/fast", insertText: "/fast", description: "Fast", children: [] },
        {
          command: "/permission",
          usage: "/permission",
          insertText: "/permission",
          description: "Permission",
          children: [
            { command: "/permission read-only", usage: "/permission read-only", insertText: "/permission read-only", description: "Read only", children: [] },
            { command: "/permission auto", usage: "/permission auto", insertText: "/permission auto", description: "Auto", children: [] },
            { command: "/permission full-access", usage: "/permission full-access", insertText: "/permission full-access", description: "Full", children: [] },
          ],
        },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 1,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/permission",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(state.slashMenuSelectedIndex).toBe(0);
    expect(menu.innerHTML).toContain("/permission read-only");
  });

  it("opens on a single slash and renders a loading state before the catalog resolves", () => {
    const state = {
      slashCommands: [],
      slashCommandsLoaded: false,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const documentRef = { activeElement: {} };
    const menu = {
      style: {},
      innerHTML: "",
      querySelectorAll() {
        return [];
      },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 40, top: 500, width: 280 };
      },
    };
    documentRef.activeElement = input;
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api() {
        return new Promise(() => {});
      },
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(state.slashMenuOpen).toBe(true);
    expect(state.slashCommandsLoading).toBe(true);
    expect(menu.innerHTML).toContain("Loading slash commands");
    expect(menu.style.display).toBe("block");
    expect(menu.style.position).toBe("fixed");
  });

  it("keeps slash menu closed when the prompt is not focused", () => {
    const state = {
      slashCommands: [
        { command: "/fast", usage: "/fast", insertText: "/fast", description: "Fast", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const documentRef = { activeElement: {} };
    const menu = {
      style: {},
      innerHTML: "",
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(state.slashMenuOpen).toBe(false);
    expect(menu.style.display).toBe("none");
  });

  it("reloads the slash catalog when the workspace changes", async () => {
    const requests = [];
    const state = {
      workspaceTarget: "windows",
      activeThreadWorkspace: "windows",
      slashCommands: [],
      slashCommandsLoaded: false,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashCommandsWorkspace: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelectorAll() {
        return [];
      },
    };
    const input = {
      value: "/permission",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        requests.push(path);
        if (path === "/codex/slash/commands?workspace=windows") {
          return {
            commands: [
              {
                command: "/permission",
                usage: "/permission",
                insertText: "/permission",
                description: "Permissions",
                children: [
                  { command: "/permission read-only", usage: "/permission read-only", insertText: "/permission read-only", description: "Read only" },
                ],
              },
            ],
          };
        }
        if (path === "/codex/slash/commands?workspace=wsl2") {
          return {
            commands: [
              {
                command: "/permission",
                usage: "/permission",
                insertText: "/permission",
                description: "Permissions",
                children: [
                  { command: "/permission auto", usage: "/permission auto", insertText: "/permission auto", description: "Auto" },
                ],
              },
            ],
          };
        }
        throw new Error(`unexpected path: ${path}`);
      },
      getWorkspaceTarget: () => state.workspaceTarget,
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    await module.refreshSlashCommands();
    expect(menu.innerHTML).toContain("/permission read-only");

    state.workspaceTarget = "wsl2";
    state.activeThreadWorkspace = "wsl2";
    state.slashCommandsLoaded = false;
    await module.refreshSlashCommands();
    module.syncSlashCommandMenu();

    expect(requests).toEqual([
      "/codex/slash/commands?workspace=windows",
      "/codex/slash/commands?workspace=wsl2",
    ]);
    expect(menu.innerHTML).toContain("/permission auto");
    expect(menu.innerHTML).not.toContain("/permission read-only");
  });

  it("requests slash catalog state with active thread context and syncs local state from backend actives", async () => {
    const requests = [];
    const state = {
      activeThreadId: "thread-7",
      activeThreadRolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      workspaceTarget: "windows",
      activeThreadWorkspace: "windows",
      planModeEnabled: false,
      fastModeEnabled: false,
      permissionPresetByWorkspace: { windows: "", wsl2: "" },
      slashCommands: [],
      slashCommandsLoaded: false,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashCommandsWorkspace: "",
      slashCommandsContextKey: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async (path) => {
        requests.push(path);
        return {
          commands: [
            {
              command: "/fast",
              usage: "/fast",
              insertText: "/fast",
              description: "Fast",
              children: [
                { command: "/fast on", usage: "/fast on", insertText: "/fast on", description: "On", active: true },
                { command: "/fast off", usage: "/fast off", insertText: "/fast off", description: "Off" },
              ],
            },
            {
              command: "/plan",
              usage: "/plan",
              insertText: "/plan",
              description: "Plan",
              children: [
                { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "On" },
                { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Off", active: true },
              ],
            },
            {
              command: "/permission",
              usage: "/permission",
              insertText: "/permission",
              description: "Permission",
              children: [
                { command: "/permission auto", usage: "/permission auto", insertText: "/permission auto", description: "Auto", active: true },
              ],
            },
          ],
        };
      },
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    await module.refreshSlashCommands({ force: true, silent: true });

    expect(requests).toEqual([
      "/codex/slash/commands?workspace=windows&threadId=thread-7&rolloutPath=C%3A%5Crepo%5C.codex%5Csessions%5Crollout.jsonl",
    ]);
    expect(state.fastModeEnabled).toBe(true);
    expect(state.planModeEnabled).toBe(false);
    expect(state.permissionPresetByWorkspace.windows).toBe("/permission auto");
  });

  it("keeps the menu open for a parent command and closed for a leaf command", () => {
    const baseState = {
      slashCommands: [
        {
          command: "/plan",
          usage: "/plan",
          insertText: "/plan",
          description: "Plan mode",
          children: [
            { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "On", children: [] },
          ],
        },
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact context", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelectorAll() {
        return [];
      },
    };
    const input = {
      value: "/plan",
      getBoundingClientRect() {
        return { left: 40, top: 500, width: 280 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state: baseState,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    expect(baseState.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("/plan on");

    input.value = "/compact";
    module.syncSlashCommandMenu();
    expect(baseState.slashMenuOpen).toBe(false);
    expect(menu.style.display).toBe("none");
  });

  it("opens the Codex-style review preset picker for /review", () => {
    const state = {
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 0,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    const input = {
      value: "/review",
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      getStartCwdForWorkspace: () => "C:\\repo",
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(state.slashMenuOpen).toBe(true);
    expect(menu.innerHTML).toContain("Select a review preset");
    expect(menu.innerHTML).toContain("Review against a base branch");
    expect(menu.innerHTML).toContain("Review uncommitted changes");
    expect(menu.innerHTML).not.toContain("/review start");
  });

  it("fills the review slash command after choosing a preset", () => {
    const listeners = {};
    const state = {
      slashCommands: [
        { command: "/review", usage: "/review", insertText: "/review", description: "Review", children: [] },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [],
      slashMenuOpen: false,
      slashMenuSelectedIndex: 1,
      slashMenuSelectionVisible: false,
      slashMenuContextKey: "",
    };
    const menu = {
      style: {},
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() {
        return [
          {
            getAttribute(name) {
              return name === "data-slash-index" ? "1" : "";
            },
            addEventListener(name, handler) {
              listeners[name] = handler;
            },
          },
        ];
      },
    };
    const input = {
      value: "/review",
      focus() {},
      setSelectionRange() {},
      getBoundingClientRect() {
        return { left: 24, top: 420, width: 320 };
      },
    };
    const documentRef = { activeElement: input };
    const module = createSlashCommandsModule({
      state,
      byId(id) {
        if (id === "slashCommandMenu") return menu;
        if (id === "mobilePromptInput") return input;
        return null;
      },
      api: async () => ({ commands: [] }),
      getStartCwdForWorkspace: () => "C:\\repo",
      updateMobileComposerState() {},
      setStatus() {},
      documentRef,
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();
    listeners.pointerdown?.({ type: "pointerdown", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });
    listeners.pointerup?.({ type: "pointerup", button: 0, isPrimary: true, preventDefault() {}, stopPropagation() {} });

    expect(input.value).toBe("/review uncommitted");
    expect(state.slashMenuOpen).toBe(false);
  });
});
