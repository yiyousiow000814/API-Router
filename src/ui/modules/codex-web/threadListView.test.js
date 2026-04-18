import fs from "node:fs";
import { describe, expect, it } from "vitest";

import {
  activateExistingThreadView,
  buildThreadResumeUrl,
  buildWorkspaceEntries,
  createThreadListViewModule,
  filterWorkspaceSectionThreads,
  primeOpeningThreadState,
  resumeThreadLiveOnOpen,
  shouldResumeThreadOnOpen,
  shouldStaggerThreadGroupEnter,
} from "./threadListView.js";

describe("threadListView", () => {
  async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
  }

  function createFakeClassList() {
    const values = new Set();
    return {
      add(...items) {
        for (const item of items) values.add(String(item));
      },
      remove(...items) {
        for (const item of items) values.delete(String(item));
      },
      contains(item) {
        return values.has(String(item));
      },
    };
  }

  function createFakeElement(tagName = "div") {
    return {
      tagName: String(tagName).toUpperCase(),
      children: [],
      style: { setProperty() {} },
      classList: createFakeClassList(),
      attributes: new Map(),
      className: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attributes.set(String(name), String(value));
      },
      getAttribute(name) {
        return this.attributes.get(String(name)) || "";
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      get firstElementChild() {
        return this.children[0] || null;
      },
      get childElementCount() {
        return this.children.length;
      },
      getBoundingClientRect() {
        return { height: 0 };
      },
      addEventListener() {},
      set innerHTML(value) {
        this._innerHTML = String(value || "");
        if (!this._innerHTML) this.children = [];
      },
      get innerHTML() {
        return this._innerHTML || "";
      },
    };
  }

  it("builds stable workspace entries grouped by first visible order", () => {
    const entries = buildWorkspaceEntries(
      [
        { id: "2", workspaceLabel: "zzz-project" },
        { id: "1", workspaceLabel: "aaa-project" },
        { id: "3", workspaceLabel: "AAA-project" },
      ],
      (thread) => thread.workspaceLabel
    );
    expect(entries.map(([label, items]) => [label, items.map((item) => item.id)])).toEqual([
      ["zzz-project", ["2"]],
      ["aaa-project", ["1", "3"]],
    ]);
  });

  it("keeps same-label folders separate when group keys differ", () => {
    const entries = buildWorkspaceEntries(
      [
        { id: "1", cwd: "C:/work/api-router" },
        { id: "2", cwd: "D:/sandbox/api-router" },
      ],
      (thread) => ({
        key: String(thread.cwd || "").toLowerCase(),
        label: "api-router",
      })
    );
    expect(entries.map(([label, items, key]) => [label, items.map((item) => item.id), key])).toEqual([
      ["api-router (work)", ["1"], "c:/work/api-router"],
      ["api-router (sandbox)", ["2"], "d:/sandbox/api-router"],
    ]);
  });

  it("extends the disambiguation suffix until duplicate labels become unique", () => {
    const entries = buildWorkspaceEntries(
      [
        { id: "1", cwd: "C:/repos/api-router" },
        { id: "2", cwd: "D:/repos/api-router" },
      ],
      (thread) => ({
        key: String(thread.cwd || "").toLowerCase(),
        label: "api-router",
      })
    );
    expect(entries.map(([label, items, key]) => [label, items.map((item) => item.id), key])).toEqual([
      ["api-router (c:/repos)", ["1"], "c:/repos/api-router"],
      ["api-router (d:/repos)", ["2"], "d:/repos/api-router"],
    ]);
  });

  it("filters section threads by favorites and query", () => {
    const items = [
      { id: "fav-1", title: "Alpha" },
      { id: "keep-1", title: "Beta Thread" },
      { id: "keep-2", title: "Gamma" },
    ];
    const favoriteSet = new Set(["fav-1"]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
      "keep-2",
    ]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "beta", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
    ]);
    expect(filterWorkspaceSectionThreads(items, favoriteSet, "win", "WIN").map((item) => item.id)).toEqual([
      "keep-1",
      "keep-2",
    ]);
  });

  it("disables group stagger when any section is already expanded", () => {
    const entries = [
      ["project", [{ id: "1" }], "project"],
      ["yiyou", [{ id: "2" }], "yiyou"],
    ];
    expect(shouldStaggerThreadGroupEnter(entries, new Set(["project", "yiyou"]))).toBe(true);
    expect(shouldStaggerThreadGroupEnter(entries, new Set(["yiyou"]))).toBe(false);
  });

  it("renders grouped threads without touching entries before initialization", () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const module = createThreadListViewModule({
      state: {
        threadItems: [],
        threadItemsAll: [],
        threadSearchQuery: "",
        threadListLoading: false,
        threadListLoadingTarget: "",
        workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
        threadListPendingVisibleAnimationByWorkspace: {},
        threadListAnimationHoldUntilByWorkspace: {},
        threadListVisibleOpenAnimationUntil: 0,
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListCollapseAnimateGroupKeys: new Set(),
        threadListChevronOpenAnimateKeys: new Set(),
        threadListChevronCloseAnimateKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
        collapsedWorkspaceKeys: new Set(),
        threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
        favoriteThreadIds: new Set(),
      },
      byId(id) {
        return id === "threadList" ? list : null;
      },
      escapeHtml(value) {
        return String(value || "");
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      getWorkspaceTarget() {
        return "windows";
      },
      hasDualWorkspaceTargets() {
        return true;
      },
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return true;
      },
      workspaceKeyOfThread(thread) {
        return thread.workspace;
      },
      truncateLabel(value) {
        return String(value || "");
      },
      relativeTimeLabel() {
        return "";
      },
      pickThreadTimestamp() {
        return Date.now();
      },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread() {},
      setChatOpening() {},
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      loadThreadMessages: async () => {},
      api: async () => ({}),
      setStatus() {},
      scheduleThreadRefresh() {},
      scrollToBottomReliable() {},
      windowRef: { getComputedStyle() { return { paddingTop: "0px", paddingBottom: "0px" }; } },
      documentRef: {
        body,
        createElement(tagName) {
          return createFakeElement(tagName);
        },
      },
      requestAnimationFrameRef(callback) {
        callback();
        return 1;
      },
      performanceRef: { now() { return 0; } },
      localStorageRef: { setItem() {} },
      FAVORITE_THREADS_KEY: "favorites",
    });

    expect(() =>
      module.renderThreads([
        { id: "thread-1", workspace: "windows", title: "Alpha" },
        { id: "thread-2", workspace: "wsl2", title: "Beta" },
      ])
    ).not.toThrow();
    expect(list.childElementCount).toBeGreaterThan(0);
  });

  it("loads history before subscribing live state when opening an existing chat", async () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const events = [];
    const state = {
      threadItems: [],
      threadItemsAll: [],
      threadSearchQuery: "",
      threadListLoading: false,
      threadListLoadingTarget: "",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      threadListPendingVisibleAnimationByWorkspace: {},
      threadListAnimationHoldUntilByWorkspace: {},
      threadListVisibleOpenAnimationUntil: 0,
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListCollapseAnimateGroupKeys: new Set(),
      threadListChevronOpenAnimateKeys: new Set(),
      threadListChevronCloseAnimateKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
      collapsedWorkspaceKeys: new Set(),
      threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
      favoriteThreadIds: new Set(),
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      openingThreadReqId: 0,
      openingThreadAbort: null,
      pendingThreadResumes: new Map(),
      threadAttachTransportById: new Map(),
      activeThreadId: "",
      chatShouldStickToBottom: false,
      threadItems: [],
    };
    const module = createThreadListViewModule({
      state,
      byId(id) {
        return id === "threadList" ? list : null;
      },
      escapeHtml(value) {
        return String(value || "");
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      getWorkspaceTarget() {
        return "windows";
      },
      hasDualWorkspaceTargets() {
        return true;
      },
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return true;
      },
      workspaceKeyOfThread(thread) {
        return thread.workspace;
      },
      truncateLabel(value) {
        return String(value || "");
      },
      relativeTimeLabel() {
        return "";
      },
      pickThreadTimestamp() {
        return Date.now();
      },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread(threadId) {
        state.activeThreadId = threadId;
      },
      setChatOpening(open) {
        events.push(open ? "chat-opening:on" : "chat-opening:off");
      },
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      loadThreadMessages: async (threadId) => {
        events.push(`history:${threadId}`);
        state.activeThreadHistoryThreadId = threadId;
        state.activeThreadHistoryIncomplete = false;
        state.activeThreadHistoryStatusType = "idle";
      },
      api: async (path, options = {}) => {
        events.push(`${options.method || "GET"}:${path}`);
        return { ok: true };
      },
      connectWs() {
        events.push("ws:connect");
      },
      syncEventSubscription() {
        events.push("ws:sync");
      },
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
      onPendingTurnStateChange() {},
      refreshWorkspaceRuntimeState: async (workspace) => {
        events.push(`runtime:${workspace}`);
      },
      updateHeaderUi() {
        events.push("header:update");
      },
      setStatus(message) {
        events.push(`status:${message}`);
      },
      scheduleThreadRefresh() {
        events.push("threads:refresh");
      },
      scrollToBottomReliable() {
        events.push("chat:scroll-bottom");
      },
      windowRef: { getComputedStyle() { return { paddingTop: "0px", paddingBottom: "0px" }; } },
      documentRef: {
        body,
        createElement(tagName) {
          return createFakeElement(tagName);
        },
      },
      requestAnimationFrameRef(callback) {
        callback();
        return 1;
      },
      performanceRef: { now() { return 0; } },
      localStorageRef: { setItem() {} },
      FAVORITE_THREADS_KEY: "favorites",
    });

    const thread = { id: "thread-1", workspace: "windows", title: "Alpha", status: { type: "idle" } };
    module.renderThreads([thread]);
    const card = list.children[0]?.children[1]?.children[0];

    card.onclick();
    await flushAsyncWork();

    expect(events.indexOf("history:thread-1")).toBeGreaterThan(events.indexOf("chat-opening:on"));
    expect(events.indexOf("ws:connect")).toBeGreaterThan(events.indexOf("history:thread-1"));
    expect(events.indexOf("ws:sync")).toBeGreaterThan(events.indexOf("history:thread-1"));
    expect(events).toContain("GET:/codex/threads/thread-1/transport?workspace=windows");
    expect(events).not.toContain(
      "POST:/codex/threads/thread-1/resume?workspace=windows"
    );
  });

  it("builds resume urls with workspace and rolloutPath", () => {
    expect(
      buildThreadResumeUrl("thread-1", {
        workspace: "windows",
        rolloutPath: "C:\\Users\\yiyou\\.codex\\sessions\\rollout.jsonl",
      })
    ).toBe(
      "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5CUsers%5Cyiyou%5C.codex%5Csessions%5Crollout.jsonl"
    );
  });

  it("returns to the existing chat view without reloading when clicking the active thread", () => {
    const calls = [];
    const state = {
      activeThreadId: "thread-1",
      activeMainTab: "settings",
    };

    expect(
      activateExistingThreadView({
        threadId: "thread-1",
        state,
        setMainTab(tab) {
          calls.push(`main:${tab}`);
        },
        setMobileTab(tab) {
          calls.push(`mobile:${tab}`);
        },
      })
    ).toBe(true);

    expect(calls).toEqual(["main:chat", "mobile:chat"]);
  });

  it("does not intercept clicks for a different thread", () => {
    const calls = [];
    const state = {
      activeThreadId: "thread-1",
      activeMainTab: "chat",
    };

    expect(
      activateExistingThreadView({
        threadId: "thread-2",
        state,
        setMainTab(tab) {
          calls.push(`main:${tab}`);
        },
        setMobileTab(tab) {
          calls.push(`mobile:${tab}`);
        },
      })
    ).toBe(false);

    expect(calls).toEqual([]);
  });

  it("primes active thread meta before history load begins", () => {
    const state = {
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: false,
    };
    const selected = [];

    const result = primeOpeningThreadState({
      thread: {
        id: "thread-wsl",
        workspace: "wsl2",
        path: "/home/yiyou/.codex/sessions/rollout.jsonl",
        status: { type: "running" },
      },
      state,
      setActiveThread(threadId) {
        selected.push(threadId);
      },
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
    });

    expect(result).toEqual({
      threadId: "thread-wsl",
      workspace: "wsl2",
      rolloutPath: "/home/yiyou/.codex/sessions/rollout.jsonl",
      threadStatusType: "running",
    });
    expect(selected).toEqual(["thread-wsl"]);
    expect(state.activeThreadNeedsResume).toBe(true);
    expect(state.activeThreadWorkspace).toBe("wsl2");
    expect(state.activeThreadRolloutPath).toBe("/home/yiyou/.codex/sessions/rollout.jsonl");
  });

  it("does not mark completed thread open as needing resume by default", () => {
    const state = {
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadNeedsResume: true,
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
    };

    const result = primeOpeningThreadState({
      thread: {
        id: "thread-idle",
        workspace: "windows",
        path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
        status: { type: "idle" },
      },
      state,
      setActiveThread() {},
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
    });

    expect(result.threadStatusType).toBe("idle");
    expect(state.activeThreadNeedsResume).toBe(false);
  });

  it("only resumes threads on open when runtime evidence says it is needed", () => {
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        threadStatusType: "running",
      })
    ).toBe(true);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        threadStatusType: "idle",
      })
    ).toBe(false);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: true,
      })
    ).toBe(true);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: false,
      })
    ).toBe(false);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        pendingTurnRunning: true,
        pendingThreadId: "thread-1",
      })
    ).toBe(true);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "running",
      })
    ).toBe(true);
    expect(
      shouldResumeThreadOnOpen({
        threadId: "thread-1",
        threadStatusType: "running",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "idle",
      })
    ).toBe(false);
  });

  it("resumes opened threads in background to attach live updates", async () => {
    const calls = [];
    const state = {
      activeThreadNeedsResume: true,
      activeThreadAttachTransport: "",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      pendingThreadResumes: new Map(),
      threadAttachTransportById: new Map(),
    };
    const ui = [];
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      return { ok: true, turnId: "turn-123", attached: true, transport: "terminal-session" };
    };
    const ws = [];

    await resumeThreadLiveOnOpen({
      threadId: "thread-1",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      threadStatusType: "running",
      state,
      api,
      connectWs() {
        ws.push("connect");
      },
      syncEventSubscription() {
        ws.push("sync");
      },
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
      onPendingTurnStateChange() {
        ui.push({
          threadId: state.activeThreadPendingTurnThreadId,
          turnId: state.activeThreadPendingTurnId,
          running: state.activeThreadPendingTurnRunning,
        });
      },
    });

    expect(ws).toEqual(["connect", "sync"]);
    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/resume?workspace=windows&rolloutPath=C%3A%5Crepo%5C.codex%5Csessions%5Crollout.jsonl",
        method: "POST",
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
    expect(state.activeThreadAttachTransport).toBe("terminal-session");
    expect(state.threadAttachTransportById.get("thread-1")).toBe("terminal-session");
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-123");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(ui).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-123",
        running: true,
      },
    ]);
  });

  it("does not resume completed threads after history load", async () => {
    const calls = [];
    const state = {
      activeThreadNeedsResume: true,
      activeThreadAttachTransport: "",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
      threadAttachTransportById: new Map(),
    };
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      return { ok: true, attached: true, transport: "terminal-session" };
    };
    const ws = [];

    await resumeThreadLiveOnOpen({
      threadId: "thread-1",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      threadStatusType: "idle",
      state,
      api,
      connectWs() {
        ws.push("connect");
      },
      syncEventSubscription() {
        ws.push("sync");
      },
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
    });

    expect(ws).toEqual([]);
    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/transport?workspace=windows",
        method: "GET",
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
    expect(state.activeThreadAttachTransport).toBe("terminal-session");
    expect(state.threadAttachTransportById.get("thread-1")).toBe("terminal-session");
  });

  it("does not blindly resume when loaded history overrides stale running sidebar state", async () => {
    const calls = [];
    const state = {
      activeThreadNeedsResume: true,
      activeThreadAttachTransport: "",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "idle",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
      threadAttachTransportById: new Map(),
    };
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      return { ok: true, attached: false, transport: null };
    };

    await resumeThreadLiveOnOpen({
      threadId: "thread-1",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      threadStatusType: "running",
      state,
      api,
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
    });

    expect(calls).toEqual([
      {
        path: "/codex/threads/thread-1/transport?workspace=windows",
        method: "GET",
      },
    ]);
    expect(state.activeThreadNeedsResume).toBe(false);
  });

  it("resumes only after history proves the opened thread is still active", async () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const events = [];
    const state = {
      threadItems: [],
      threadItemsAll: [],
      threadSearchQuery: "",
      threadListLoading: false,
      threadListLoadingTarget: "",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      threadListPendingVisibleAnimationByWorkspace: {},
      threadListAnimationHoldUntilByWorkspace: {},
      threadListVisibleOpenAnimationUntil: 0,
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListCollapseAnimateGroupKeys: new Set(),
      threadListChevronOpenAnimateKeys: new Set(),
      threadListChevronCloseAnimateKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
      collapsedWorkspaceKeys: new Set(),
      threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
      favoriteThreadIds: new Set(),
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      openingThreadReqId: 0,
      openingThreadAbort: null,
      pendingThreadResumes: new Map(),
      threadAttachTransportById: new Map(),
      activeThreadId: "",
      chatShouldStickToBottom: false,
    };
    const module = createThreadListViewModule({
      state,
      byId(id) {
        return id === "threadList" ? list : null;
      },
      escapeHtml(value) {
        return String(value || "");
      },
      normalizeWorkspaceTarget(value) {
        return String(value || "").toLowerCase() === "wsl2" ? "wsl2" : "windows";
      },
      getWorkspaceTarget() {
        return "windows";
      },
      hasDualWorkspaceTargets() {
        return true;
      },
      pushThreadAnimDebug() {},
      isThreadListActuallyVisible() {
        return true;
      },
      workspaceKeyOfThread(thread) {
        return thread.workspace;
      },
      truncateLabel(value) {
        return String(value || "");
      },
      relativeTimeLabel() {
        return "";
      },
      pickThreadTimestamp() {
        return Date.now();
      },
      setMainTab() {},
      setMobileTab() {},
      setActiveThread(threadId) {
        state.activeThreadId = threadId;
      },
      onActiveThreadOpened() {
        events.push("composer:update");
      },
      setChatOpening() {},
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      loadThreadMessages: async (threadId) => {
        events.push(`history:${threadId}`);
        state.activeThreadHistoryThreadId = threadId;
        state.activeThreadHistoryIncomplete = false;
        state.activeThreadHistoryStatusType = "running";
      },
      api: async (path, options = {}) => {
        events.push(`${options.method || "GET"}:${path}`);
        return { ok: true, turnId: "turn-2", attached: true, transport: "terminal-session" };
      },
      connectWs() {
        events.push("ws:connect");
      },
      syncEventSubscription() {
        events.push("ws:sync");
      },
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
      onPendingTurnStateChange() {
        events.push("pending:sync");
      },
      refreshWorkspaceRuntimeState: async (workspace) => {
        events.push(`runtime:${workspace}`);
      },
      updateHeaderUi() {
        events.push("header:update");
      },
      setStatus() {},
      scheduleThreadRefresh() {},
      scrollToBottomReliable() {},
      windowRef: { getComputedStyle() { return { paddingTop: "0px", paddingBottom: "0px" }; } },
      documentRef: {
        body,
        createElement(tagName) {
          return createFakeElement(tagName);
        },
      },
      requestAnimationFrameRef(callback) {
        callback();
        return 1;
      },
      performanceRef: { now() { return 0; } },
      localStorageRef: { setItem() {} },
      FAVORITE_THREADS_KEY: "favorites",
    });

    const thread = { id: "thread-2", workspace: "windows", title: "Beta", status: { type: "idle" } };
    module.renderThreads([thread]);
    const card = list.children[0]?.children[1]?.children[0];

    card.onclick();
    await flushAsyncWork();

    expect(events).toContain("composer:update");
    expect(events.indexOf("composer:update")).toBeLessThan(events.indexOf("history:thread-2"));
    expect(events.indexOf("ws:connect")).toBeGreaterThan(events.indexOf("history:thread-2"));
    expect(events.indexOf("ws:sync")).toBeGreaterThan(events.indexOf("history:thread-2"));
    expect(events.indexOf("POST:/codex/threads/thread-2/resume?workspace=windows")).toBeGreaterThan(
      events.indexOf("history:thread-2")
    );
    expect(events).toContain("pending:sync");
    expect(state.activeThreadNeedsResume).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-2");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
  });
});
