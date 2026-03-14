import { describe, expect, it } from "vitest";

import {
  createSlashCommandsModule,
  filterSlashCommands,
  normalizeSlashCommandCatalog,
  readSlashSearchQuery,
} from "./slashCommands.js";

describe("slashCommands", () => {
  it("normalizes slash command catalogs from the backend", () => {
    expect(
      normalizeSlashCommandCatalog({
        commands: [
          { command: "/help", usage: "/help", insertText: "/help", description: "Show help" },
          { command: "/fork", usage: "/fork", insertText: "/fork", description: "hidden" },
          { command: "/plan", usage: "/plan [on|off|prompt]", insertText: "/plan ", description: "plan" },
          { command: "status", usage: "/status", insertText: "/status", description: "invalid" },
        ],
      })
    ).toEqual([
      { command: "/help", usage: "/help", insertText: "/help", description: "Show help" },
      { command: "/plan on", usage: "/plan on", insertText: "/plan on", description: "Enable plan mode." },
      { command: "/plan off", usage: "/plan off", insertText: "/plan off", description: "Disable plan mode." },
    ]);
  });

  it("extracts slash search queries only for the first token", () => {
    expect(readSlashSearchQuery("/")).toBe("");
    expect(readSlashSearchQuery("/pl")).toBe("pl");
    expect(readSlashSearchQuery("/plan add checklist")).toBe("");
    expect(readSlashSearchQuery("hello")).toBe("");
  });

  it("filters slash commands by command prefix and description", () => {
    const commands = [
      { command: "/help", usage: "/help", insertText: "/help", description: "Show help" },
      { command: "/plan", usage: "/plan [on|off|prompt]", insertText: "/plan ", description: "Plan mode" },
    ];
    expect(filterSlashCommands(commands, "/pl")).toEqual([commands[1]]);
    expect(filterSlashCommands(commands, "/hel")).toEqual([commands[0]]);
  });

  it("renders and applies slash command selections", async () => {
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
      _nodes: [],
      _selectedNode: null,
      querySelectorAll() {
        return this._nodes;
      },
      querySelector(selector) {
        if (selector === '[data-slash-index="0"]') return this._selectedNode;
        return null;
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
    const byId = (id) =>
      id === "slashCommandMenu"
        ? menu
        : id === "mobilePromptInput"
          ? input
          : id === "mobilePromptWrap"
            ? wrap
            : null;
    const api = async () => ({
      commands: [
        { command: "/plan", usage: "/plan [on|off|prompt]", insertText: "/plan ", description: "Plan mode" },
      ],
    });
    const module = createSlashCommandsModule({
      state,
      byId,
      api,
      escapeHtml: (value) => String(value || ""),
      updateMobileComposerState: () => {},
      setStatus: () => {},
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    menu.querySelectorAll = () => {
      const matches = Array.from(String(menu.innerHTML || "").matchAll(/data-slash-index="(\d+)"/g));
      return matches.map((match) => ({
        scrollIntoView() {},
        getAttribute(name) {
          return name === "data-slash-index" ? match[1] : "";
        },
        addEventListener() {},
      }));
    };
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
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.width).toBe("336px");
    expect(menu.style.top).toBe("404px");
    expect(menu.__scrolled).toBe(true);

    const handled = module.handleSlashCommandKeyDown({
      key: "Enter",
      preventDefault() {},
    });
    expect(handled).toBe(true);
    expect(input.value).toBe("/plan on");
    expect(state.slashMenuOpen).toBe(false);
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

  it("keeps the menu closed once the prompt already equals a committed slash command", () => {
    const state = {
      slashCommands: [
        { command: "/compact", usage: "/compact", insertText: "/compact", description: "Compact context" },
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
      value: "/compact",
      getBoundingClientRect() {
        return { left: 40, top: 500, width: 280 };
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
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.syncSlashCommandMenu();

    expect(state.slashMenuOpen).toBe(false);
    expect(menu.style.display).toBe("none");
  });

  it("applies a slash command on pointerdown so one click inserts immediately", async () => {
    const state = {
      slashCommands: [
        { command: "/plan", usage: "/plan [on|off|prompt]", insertText: "/plan ", description: "Plan mode" },
      ],
      slashCommandsLoaded: true,
      slashCommandsLoading: false,
      slashCommandsError: "",
      slashMenuItems: [
        { command: "/plan", usage: "/plan [on|off|prompt]", insertText: "/plan ", description: "Plan mode" },
      ],
      slashMenuOpen: true,
      slashMenuSelectedIndex: 0,
    };
    const listeners = new Map();
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
              listeners.set(name, handler);
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
      windowRef: {
        innerWidth: 420,
        addEventListener() {},
      },
    });

    module.renderSlashMenu();
    listeners.get("pointerdown")?.({ preventDefault() {} });

    expect(input.value).toBe("/plan ");
    expect(state.slashMenuOpen).toBe(false);
  });
});
