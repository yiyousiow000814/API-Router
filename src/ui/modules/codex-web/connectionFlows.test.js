import { describe, expect, it, vi } from "vitest";

import {
  createConnectionFlowsModule,
  normalizePendingSelection,
  pickPendingDefaults,
} from "./connectionFlows.js";

describe("connectionFlows", () => {
  it("picks the first pending ids", () => {
    expect(
      pickPendingDefaults([{ id: "a1" }, { id: "a2" }], [{ id: "u1" }])
    ).toEqual({
      approvalId: "a1",
      userInputId: "u1",
    });
  });

  it("returns empty ids when lists are empty", () => {
    expect(pickPendingDefaults([], [])).toEqual({
      approvalId: "",
      userInputId: "",
    });
  });

  it("preserves a valid pending selection and falls back when it disappears", () => {
    expect(
      normalizePendingSelection([{ id: "a1" }, { id: "a2" }], "a2", "a1")
    ).toBe("a2");
    expect(
      normalizePendingSelection([{ id: "a1" }, { id: "a2" }], "missing", "a1")
    ).toBe("a1");
    expect(normalizePendingSelection([], "missing", "")).toBe("");
  });

  it("ignores host rendering when host list UI is absent", () => {
    const module = createConnectionFlowsModule({
      state: { activeHostId: "", pendingApprovals: [], pendingUserInputs: [] },
      byId: () => null,
      api: async () => ({}),
      wsSend: () => false,
      nextReqId: () => "req-1",
      connectWs: () => {},
      ensureArrayItems: (value) => value,
      escapeHtml: (value) => String(value || ""),
      blockInSandbox: () => false,
      TOKEN_STORAGE_KEY: "token",
      getEmbeddedToken: () => "",
      refreshModels: async () => {},
      refreshCodexVersions: async () => {},
      refreshThreads: async () => {},
      getWorkspaceTarget: () => "windows",
      isWorkspaceAvailable: () => false,
      setStatus: () => {},
      setMainTab: () => {},
      setMobileTab: () => {},
      addChat: () => {},
    });

    expect(() => module.renderHosts([{ id: "host-1", name: "Host 1", base_url: "http://x" }])).not.toThrow();
  });

  it("does not force-close the mobile drawer after connect completes", async () => {
    const setMainTab = vi.fn();
    const setMobileTab = vi.fn();
    const localStorageState = new Map();
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem(key) {
          return localStorageState.has(key) ? localStorageState.get(key) : null;
        },
        setItem(key, value) {
          localStorageState.set(key, String(value));
        },
        removeItem(key) {
          localStorageState.delete(key);
        },
      },
    });
    const module = createConnectionFlowsModule({
      state: { activeHostId: "", pendingApprovals: [], pendingUserInputs: [], token: "" },
      byId: (id) => (id === "tokenInput" ? { value: "" } : null),
      api: async (path) => {
        if (path === "/codex/auth/verify") return { ok: true };
        if (path === "/codex/approvals/pending" || path === "/codex/user-input/pending") return { items: [] };
        return { ok: true };
      },
      wsSend: () => false,
      nextReqId: () => "req-1",
      connectWs: () => {},
      ensureArrayItems: (value) =>
        Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : value ? [value] : [],
      escapeHtml: (value) => String(value || ""),
      blockInSandbox: () => false,
      TOKEN_STORAGE_KEY: "token",
      getEmbeddedToken: () => "",
      refreshModels: async () => {},
      refreshCodexVersions: async () => {},
      refreshThreads: async () => {},
      getWorkspaceTarget: () => "windows",
      isWorkspaceAvailable: () => false,
      setStatus: () => {},
      setMainTab,
      setMobileTab,
      addChat: () => {},
    });

    try {
      await module.connect();
      expect(setMainTab).toHaveBeenCalledWith("chat");
      expect(setMobileTab).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it("does not switch back to chat when bootstrap connects with switchToChat disabled", async () => {
    const setMainTab = vi.fn();
    const localStorageState = new Map();
    const originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem(key) {
          return localStorageState.has(key) ? localStorageState.get(key) : null;
        },
        setItem(key, value) {
          localStorageState.set(key, String(value));
        },
        removeItem(key) {
          localStorageState.delete(key);
        },
      },
    });
    const module = createConnectionFlowsModule({
      state: { activeHostId: "", pendingApprovals: [], pendingUserInputs: [], token: "" },
      byId: (id) => (id === "tokenInput" ? { value: "" } : null),
      api: async (path) => {
        if (path === "/codex/auth/verify") return { ok: true };
        if (path === "/codex/approvals/pending" || path === "/codex/user-input/pending") return { items: [] };
        return { ok: true };
      },
      wsSend: () => false,
      nextReqId: () => "req-1",
      connectWs: () => {},
      ensureArrayItems: (value) =>
        Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : value ? [value] : [],
      escapeHtml: (value) => String(value || ""),
      blockInSandbox: () => false,
      TOKEN_STORAGE_KEY: "token",
      getEmbeddedToken: () => "",
      refreshModels: async () => {},
      refreshCodexVersions: async () => {},
      refreshThreads: async () => {},
      getWorkspaceTarget: () => "windows",
      isWorkspaceAvailable: () => false,
      setStatus: () => {},
      setMainTab,
      setMobileTab: vi.fn(),
      addChat: () => {},
    });

    try {
      await module.connect({ switchToChat: false });
      expect(setMainTab).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  });

  it("stores pending selections in state and mirrors them into the inputs", () => {
    const approvalIdInput = { value: "" };
    const userInputIdInput = { value: "" };
    const statusMessages = [];
    const approvalList = { innerHTML: "", appendChild(node) { this.lastNode = node; } };
    const userInputList = { innerHTML: "", appendChild(node) { this.lastNode = node; } };
    const state = {
      activeHostId: "",
      pendingApprovals: [],
      pendingUserInputs: [],
      selectedPendingApprovalId: "",
      selectedPendingUserInputId: "",
    };
    globalThis.document = {
      createElement() {
        return {
          className: "",
          innerHTML: "",
          onclick: null,
        };
      },
    };
    const module = createConnectionFlowsModule({
      state,
      byId(id) {
        if (id === "approvalIdInput") return approvalIdInput;
        if (id === "userInputIdInput") return userInputIdInput;
        if (id === "approvalPendingList") return approvalList;
        if (id === "userInputPendingList") return userInputList;
        return null;
      },
      api: async () => ({}),
      wsSend: () => false,
      nextReqId: () => "req-1",
      connectWs: () => {},
      ensureArrayItems: (value) => (Array.isArray(value) ? value : []),
      escapeHtml: (value) => String(value || ""),
      blockInSandbox: () => false,
      TOKEN_STORAGE_KEY: "token",
      getEmbeddedToken: () => "",
      refreshModels: async () => {},
      refreshCodexVersions: async () => {},
      refreshThreads: async () => {},
      getWorkspaceTarget: () => "windows",
      isWorkspaceAvailable: () => false,
      setStatus(message) {
        statusMessages.push(message);
      },
      setMainTab: () => {},
      setMobileTab: () => {},
      addChat: () => {},
    });

    try {
      module.applyPendingPayloads([{ id: "a1" }, { id: "a2" }], [{ id: "u1" }, { id: "u2" }]);
      expect(state.selectedPendingApprovalId).toBe("a1");
      expect(state.selectedPendingUserInputId).toBe("u1");
      expect(approvalIdInput.value).toBe("a1");
      expect(userInputIdInput.value).toBe("u1");

      approvalList.lastNode.onclick();
      userInputList.lastNode.onclick();
      expect(state.selectedPendingApprovalId).toBe("a2");
      expect(state.selectedPendingUserInputId).toBe("u2");
      expect(approvalIdInput.value).toBe("a2");
      expect(userInputIdInput.value).toBe("u2");
      expect(statusMessages).toEqual(["Selected approval a2", "Selected user_input u2"]);
    } finally {
      delete globalThis.document;
    }
  });
});
