import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  activateExistingThreadView,
  buildThreadResumeUrl,
  buildWorkspaceEntries,
  createThreadListViewModule,
  filterWorkspaceSectionThreads,
  primeOpeningThreadState,
  resumeThreadLiveOnOpen,
  shouldStaggerThreadGroupEnter,
} from "./threadListView.js";
import { resolveThreadOpenState } from "./threadOpenState.js";

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
      style: {
        setProperty(name, value) {
          this[String(name)] = String(value);
        },
        removeProperty(name) {
          delete this[String(name)];
        },
      },
      classList: createFakeClassList(),
      attributes: new Map(),
      className: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      appendChild(child) {
        child.offsetTop = this.children.length * 38;
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((item) => item !== child);
        if (child) child.parentNode = null;
        return child;
      },
      remove() {
        this.parentNode?.removeChild?.(this);
      },
      setAttribute(name, value) {
        this.attributes.set(String(name), String(value));
      },
      getAttribute(name) {
        return this.attributes.get(String(name)) || "";
      },
      querySelector(selector) {
        const className = String(selector || "").startsWith(".")
          ? String(selector).slice(1)
          : "";
        if (!className) return null;
        return this.children.find((child) => child?.className === className || child?.classList?.contains?.(className)) || null;
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
        const explicitHeight = Number.parseFloat(this.style.height || "");
        if (Number.isFinite(explicitHeight)) return { height: explicitHeight };
        if (Number.isFinite(this.mockHeight)) return { height: this.mockHeight };
        if (this.children.length) {
          const last = this.children[this.children.length - 1];
          return { height: Math.max(0, Number(last.offsetTop || 0) + 32 + 16) };
        }
        return { height: 32 };
      },
      addEventListener() {},
      removeEventListener() {},
      get scrollHeight() {
        if (Number.isFinite(this.mockScrollHeight)) return this.mockScrollHeight;
        if (this.children.length) {
          const last = this.children[this.children.length - 1];
          return Math.max(0, Number(last.offsetTop || 0) + 32 + 16);
        }
        return 32;
      },
      set innerHTML(value) {
        this._innerHTML = String(value || "");
        if (!this._innerHTML) this.children = [];
      },
      get innerHTML() {
        return this._innerHTML || "";
      },
    };
  }

  it("sorts workspace groups alphabetically while preserving thread order inside each group", () => {
    const entries = buildWorkspaceEntries(
      [
        { id: "2", workspaceLabel: "zzz-project" },
        { id: "1", workspaceLabel: "aaa-project" },
        { id: "3", workspaceLabel: "AAA-project" },
      ],
      (thread) => thread.workspaceLabel
    );
    expect(entries.map(([label, items]) => [label, items.map((item) => item.id)])).toEqual([
      ["aaa-project", ["1", "3"]],
      ["zzz-project", ["2"]],
    ]);
  });

  it("sorts same-label folders by their rendered disambiguation", () => {
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
      ["api-router (sandbox)", ["2"], "d:/sandbox/api-router"],
      ["api-router (work)", ["1"], "c:/work/api-router"],
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

  it("keeps group stagger for sidebar entry even when a section is already expanded", () => {
    const entries = [
      ["project", [{ id: "1" }], "project"],
      ["yiyou", [{ id: "2" }], "yiyou"],
    ];
    expect(shouldStaggerThreadGroupEnter(entries, new Set(["project", "yiyou"]))).toBe(true);
    expect(shouldStaggerThreadGroupEnter(entries, new Set(["yiyou"]))).toBe(true);
  });

  it("keeps expanded group motion on one body node while staggering expanded chat cards", () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const state = {
      threadItems: [],
      threadItemsAll: [],
      threadSearchOpen: false,
      threadSearchQuery: "",
      threadListLoading: false,
      threadListLoadingTarget: "",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      threadListPendingVisibleAnimationByWorkspace: {},
      threadListAnimationHoldUntilByWorkspace: {},
      threadListVisibleOpenAnimationUntil: 0,
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(["windows"]),
      threadListCollapseAnimateGroupKeys: new Set(),
      threadListChevronOpenAnimateKeys: new Set(["windows"]),
      threadListChevronCloseAnimateKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
      collapsedWorkspaceKeys: new Set(),
      threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
      favoriteThreadIds: new Set(),
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

    module.renderThreads(
      Array.from({ length: 14 }, (_, index) => ({
        id: `thread-${index + 1}`,
        workspace: "windows",
        title: `Thread ${index + 1}`,
      }))
    );

    const cards = list.children[0].children[1].children;
    expect(cards).toHaveLength(14);
    expect(cards[0].classList.contains("threadExpandEnter")).toBe(true);
    expect(cards[1].classList.contains("threadExpandEnter")).toBe(true);
    expect(cards[0].classList.contains("threadEnter")).toBe(false);
    expect(cards[0].style["--thread-expand-enter-delay"]).toBe("0ms");
    expect(cards[1].style["--thread-expand-enter-delay"]).toBe("20ms");
    expect(cards[13].style["--thread-expand-enter-delay"]).toBe("260ms");
    const groupBody = list.children[0].children[1];
    expect(groupBody.classList.contains("collapsed")).toBe(false);
    expect(groupBody.style.height || "").toBe("");
    const source = fs.readFileSync(new URL("./threadListView.js", import.meta.url), "utf8");
    expect(source).not.toContain(".slice(0, 12)");
    expect(source).not.toContain("setTimeout(cleanup");
  });

  it("does not rerender the expanding group while the previous group is collapsing away", () => {
      const list = createFakeElement("div");
      const body = createFakeElement("body");
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
        collapsedWorkspaceKeys: new Set(["beta"]),
        threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
        favoriteThreadIds: new Set(),
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
      state.threadItems = [
        { id: "alpha-1", workspace: "alpha", title: "Alpha 1" },
        { id: "alpha-2", workspace: "alpha", title: "Alpha 2" },
        { id: "beta-1", workspace: "beta", title: "Beta 1" },
        { id: "beta-2", workspace: "beta", title: "Beta 2" },
      ];

      module.renderThreads(state.threadItems);
      expect(list.children).toHaveLength(2);
      list.children[1].children[0].onclick();
      const betaGroup = list.children[1];
      const betaBody = betaGroup.children[1];
      expect(betaBody.classList.contains("collapsed")).toBe(false);
      expect(betaBody.classList.contains("is-animating")).toBe(true);

      expect(list.children[1]).toBe(betaGroup);
      expect(betaGroup.children[1]).toBe(betaBody);
      expect(betaBody.classList.contains("collapsed")).toBe(false);
  });

  it("keeps the same group body node when toggling expansion so collapse can reverse smoothly", () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
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
      collapsedWorkspaceKeys: new Set(["beta"]),
      threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
      favoriteThreadIds: new Set(),
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
    state.threadItems = [
      { id: "alpha-1", workspace: "alpha", title: "Alpha 1" },
      { id: "alpha-2", workspace: "alpha", title: "Alpha 2" },
      { id: "beta-1", workspace: "beta", title: "Beta 1" },
      { id: "beta-2", workspace: "beta", title: "Beta 2" },
    ];

    module.renderThreads(state.threadItems);
    const betaGroup = list.children[1];
    const betaHeader = betaGroup.children[0];
    const betaBody = betaGroup.children[1];
    expect(betaBody.classList.contains("collapsed")).toBe(true);

    betaHeader.onclick();
    expect(list.children[1]).toBe(betaGroup);
    expect(betaGroup.children[1]).toBe(betaBody);
    expect(betaBody.classList.contains("collapsed")).toBe(false);

    betaHeader.onclick();
    expect(list.children[1]).toBe(betaGroup);
    expect(betaGroup.children[1]).toBe(betaBody);
    expect(betaBody.classList.contains("collapsed")).toBe(true);
  });

  it("animates a later expanded group as a continuous reveal during list enter", () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    body.classList.add("drawer-left-open");
    const state = {
      threadItems: [],
      threadItemsAll: [],
      threadSearchQuery: "",
      threadListLoading: false,
      threadListLoadingTarget: "",
      workspaceAvailability: { windowsInstalled: true, wsl2Installed: true },
      threadListPendingVisibleAnimationByWorkspace: { windows: true },
      threadListAnimationHoldUntilByWorkspace: {},
      threadListVisibleOpenAnimationUntil: 0,
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListCollapseAnimateGroupKeys: new Set(),
      threadListChevronOpenAnimateKeys: new Set(),
      threadListChevronCloseAnimateKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
      collapsedWorkspaceKeys: new Set(["alpha"]),
      threadGroupCollapseInitializedByWorkspace: { windows: true, wsl2: true },
      favoriteThreadIds: new Set(),
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
    state.threadItems = [
      { id: "alpha-1", workspace: "alpha", title: "Alpha 1" },
      { id: "alpha-2", workspace: "alpha", title: "Alpha 2" },
      { id: "beta-1", workspace: "beta", title: "Beta 1" },
      { id: "beta-2", workspace: "beta", title: "Beta 2" },
      { id: "gamma-1", workspace: "gamma", title: "Gamma 1" },
      { id: "gamma-2", workspace: "gamma", title: "Gamma 2" },
    ];

    module.renderThreads(state.threadItems);

    const betaGroup = list.children[1];
    const betaBody = betaGroup.children[1];
    expect(betaBody.classList.contains("is-animating")).toBe(true);
    expect(betaBody.style.height).toBe("86px");
    expect(betaBody.style.transitionDelay).toBe("340ms");
    expect(betaBody.children[0].classList.contains("threadExpandEnter")).toBe(true);
    expect(betaBody.children[0].classList.contains("threadEnter")).toBe(false);
    expect(betaBody.children[0].style["--thread-expand-enter-delay"]).toBe("340ms");
    expect(betaBody.children[1].style["--thread-expand-enter-delay"]).toBe("360ms");
  });

  it("does not restore a stale thread list scroll offset while the mobile drawer is open", () => {
    const list = createFakeElement("div");
    list.scrollTop = 84;
    list.clientHeight = 320;
    list.mockScrollHeight = 1200;
    const body = createFakeElement("body");
    body.classList.add("drawer-left-open");
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
    state.threadItems = [
      { id: "alpha-1", workspace: "alpha", title: "Alpha 1" },
      { id: "alpha-2", workspace: "alpha", title: "Alpha 2" },
      { id: "beta-1", workspace: "beta", title: "Beta 1" },
    ];

    module.renderThreads(state.threadItems);

    expect(list.scrollTop).toBe(0);
  });

  it("disables thread list scrolling when the rendered chats do not exceed the drawer height", () => {
    const list = createFakeElement("div");
    list.clientHeight = 520;
    const body = createFakeElement("body");
    body.classList.add("drawer-left-open");
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
    state.threadItems = [
      { id: "alpha-1", workspace: "alpha", title: "Alpha 1" },
      { id: "alpha-2", workspace: "alpha", title: "Alpha 2" },
      { id: "beta-1", workspace: "beta", title: "Beta 1" },
    ];

    module.renderThreads(state.threadItems);

    expect(list.style.overflowY).toBe("hidden");
    expect(list.style.touchAction).toBe("none");
    expect(list.style.overscrollBehaviorY).toBe("none");
    expect(list.style.webkitOverflowScrolling).toBe("auto");
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
      threadSearchOpen: true,
      threadSearchQuery: "alpha",
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
    expect(events).not.toContain(
      "POST:/codex/threads/thread-1/resume?workspace=windows"
    );
    expect(state.threadSearchOpen).toBe(false);
    expect(state.threadSearchQuery).toBe("");
  });

  it("waits for the opening overlay to paint before loading history", async () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const events = [];
    const rafQueue = [];
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
      setChatOpening(open) {
        events.push(open ? "chat-opening:on" : "chat-opening:off");
      },
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      loadThreadMessages: async (threadId) => {
        events.push(`history:${threadId}`);
        state.activeThreadHistoryThreadId = threadId;
      },
      api: async () => ({ ok: true }),
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
        rafQueue.push(callback);
        return rafQueue.length;
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

    expect(events).toEqual(["chat-opening:on"]);

    let framesRun = 0;
    while (!events.includes("history:thread-1") && rafQueue.length && framesRun < 10) {
      const nextFrame = rafQueue.shift();
      nextFrame?.();
      await flushAsyncWork();
      framesRun += 1;
    }

    expect(events).toContain("history:thread-1");
  });

  it("subscribes live state before slow history finishes when opening a running chat", async () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const events = [];
    let resolveHistory;
    const historyPromise = new Promise((resolve) => {
      resolveHistory = resolve;
    });
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
      setChatOpening(open) {
        events.push(open ? "chat-opening:on" : "chat-opening:off");
      },
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
      loadThreadMessages: async (threadId) => {
        events.push(`history:start:${threadId}`);
        await historyPromise;
        events.push(`history:finish:${threadId}`);
        state.activeThreadHistoryThreadId = threadId;
        state.activeThreadHistoryIncomplete = true;
        state.activeThreadHistoryStatusType = "running";
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

    const thread = { id: "thread-running", workspace: "windows", title: "Active", status: { type: "running" } };
    module.renderThreads([thread]);
    const card = list.children[0]?.children[1]?.children[0];

    card.onclick();
    await flushAsyncWork();

    expect(events).toEqual([
      "chat-opening:on",
      "ws:connect",
      "ws:sync",
      "chat-opening:off",
      "history:start:thread-running",
    ]);

    resolveHistory();
    await flushAsyncWork();
  });

  it("does not reuse the previous workspace before opening history resolves", async () => {
    const list = createFakeElement("div");
    const body = createFakeElement("body");
    const events = [];
    let resolveHistory;
    const historyPromise = new Promise((resolve) => {
      resolveHistory = resolve;
    });
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
      activeThreadId: "previous-thread",
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
        return thread.workspace || "unknown";
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
      detectThreadWorkspaceTarget() {
        return "unknown";
      },
      loadThreadMessages: async (threadId) => {
        events.push(`history:start:${threadId}`);
        await historyPromise;
        state.activeThreadWorkspace = "wsl2";
        state.activeThreadHistoryThreadId = threadId;
        state.activeThreadHistoryIncomplete = true;
        state.activeThreadHistoryStatusType = "running";
        events.push(`history:finish:${threadId}`);
      },
      api: async (path, options = {}) => {
        events.push(`${options.method || "GET"}:${path}`);
        return { turnId: "turn-1" };
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
        events.push("pending:update");
      },
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

    const thread = { id: "thread-unknown", title: "Active", status: { type: "running" } };
    module.renderThreads([thread]);
    const card = list.children[0]?.children[1]?.children[0];

    card.onclick();
    await flushAsyncWork();

    expect(events).toEqual([
      "chat-opening:on",
      "ws:connect",
      "chat-opening:off",
      "history:start:thread-unknown",
    ]);

    resolveHistory();
    await flushAsyncWork();

    expect(events).toContain("runtime:wsl2");
    expect(events).toContain("POST:/codex/threads/thread-unknown/resume?workspace=wsl2");
    expect(events).not.toContain("ws:sync");
    expect(events).not.toContain("runtime:windows");
    expect(events).not.toContain("POST:/codex/threads/thread-unknown/resume?workspace=windows");
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
    expect(state.activeThreadOpenState.resumeRequired).toBe(true);
    expect(state.activeThreadWorkspace).toBe("wsl2");
    expect(state.activeThreadRolloutPath).toBe("/home/yiyou/.codex/sessions/rollout.jsonl");
  });

  it("does not mark completed thread open as needing resume by default", () => {
    const state = {
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
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
    expect(state.activeThreadOpenState.resumeRequired).toBe(false);
  });

  it("does not mark not-loaded threads as needing resume once matching history is idle", () => {
    const state = {
      activeThreadWorkspace: "windows",
      activeThreadRolloutPath: "",
      activeThreadHistoryThreadId: "thread-notloaded",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "idle",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
    };

    const result = primeOpeningThreadState({
      thread: {
        id: "thread-notloaded",
        workspace: "windows",
        path: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
        status: { type: "notLoaded" },
      },
      state,
      setActiveThread() {},
      detectThreadWorkspaceTarget(thread) {
        return thread.workspace;
      },
    });

    expect(result.threadStatusType).toBe("notLoaded");
    expect(state.activeThreadOpenState.resumeRequired).toBe(false);
  });

  it("does not resume not-loaded threads on open when there is no runtime evidence", async () => {
    const calls = [];
    const state = {
      activeThreadHistoryThreadId: "",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
      activeThreadOpenState: null,
    };

    const resumed = await resumeThreadLiveOnOpen({
      threadId: "thread-notloaded",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      threadStatusType: "notLoaded",
      state,
      api: async (path, options = {}) => {
        calls.push({ path, method: options.method || "GET" });
        return { ok: true };
      },
      connectWs() {
        calls.push({ path: "connectWs", method: "CALL" });
      },
      syncEventSubscription() {
        calls.push({ path: "syncEventSubscription", method: "CALL" });
      },
      refreshWorkspaceRuntimeState: async () => null,
    });

    expect(resumed).toBe(null);
    expect(calls).toEqual([]);
    expect(state.activeThreadOpenState).toMatchObject({
      threadId: "thread-notloaded",
      threadStatusType: "notloaded",
      loaded: false,
      resumeRequired: false,
      resumeReason: "thread-not-loaded",
    });
  });

  it("only resumes threads on open when runtime evidence says it is needed", () => {
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "running",
      }).resumeRequired
    ).toBe(true);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "idle",
      }).resumeRequired
    ).toBe(false);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: true,
      }).resumeRequired
    ).toBe(true);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: false,
      }).resumeRequired
    ).toBe(false);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        pendingTurnRunning: true,
        pendingThreadId: "thread-1",
      }).resumeRequired
    ).toBe(true);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "running",
      }).resumeRequired
    ).toBe(true);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "running",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "idle",
      }).resumeRequired
    ).toBe(false);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "notLoaded",
        historyThreadId: "thread-1",
        historyIncomplete: false,
        historyStatusType: "idle",
      }).resumeRequired
    ).toBe(false);
    expect(
      resolveThreadOpenState({
        threadId: "thread-1",
        threadStatusType: "notLoaded",
        loaded: true,
      }).resumeRequired
    ).toBe(false);
  });

  it("resumes opened threads in background for live updates", async () => {
    const calls = [];
    const state = {
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      pendingThreadResumes: new Map(),
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
    expect(state.activeThreadOpenState.loaded).toBe(true);
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
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
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
    expect(calls).toEqual([]);
    expect(state.activeThreadOpenState.loaded).toBe(false);
  });

  it("does not blindly resume when loaded history overrides stale running sidebar state", async () => {
    const calls = [];
    const state = {
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "idle",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
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

    expect(calls).toEqual([]);
    expect(state.activeThreadOpenState.loaded).toBe(false);
  });

  it("does not resume when loaded history overrides stale notLoaded sidebar state", async () => {
    const calls = [];
    const state = {
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryIncomplete: false,
      activeThreadHistoryStatusType: "idle",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnThreadId: "",
      pendingThreadResumes: new Map(),
    };
    const api = async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      return { ok: true, attached: false, transport: null };
    };

    await resumeThreadLiveOnOpen({
      threadId: "thread-1",
      workspace: "windows",
      rolloutPath: "C:\\repo\\.codex\\sessions\\rollout.jsonl",
      threadStatusType: "notLoaded",
      state,
      api,
      registerPendingThreadResume(map, threadId, promise) {
        map.set(threadId, promise);
      },
    });

    expect(calls).toEqual([]);
    expect(state.activeThreadOpenState.loaded).toBe(false);
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
    expect(state.threadSearchOpen).toBe(false);
    expect(state.threadSearchQuery).toBe("");
    expect(state.activeThreadOpenState.loaded).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-2");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
  });
});
