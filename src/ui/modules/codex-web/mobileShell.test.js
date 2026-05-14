import { describe, expect, it } from "vitest";

import {
  createMobileShellModule,
  isCompactMobileViewport,
  shouldCommitDrawerOpen,
  shouldCommitDrawerClose,
  shouldOpenDrawerWithAnimation,
  shouldStartDrawerCloseSwipe,
  shouldStartDrawerEdgeSwipe,
  shouldUseHorizontalScrollPriority,
} from "./mobileShell.js";

describe("mobileShell", () => {
  it("animates only when opening thread drawer from closed state", () => {
    expect(shouldOpenDrawerWithAnimation("threads", false)).toBe(true);
    expect(shouldOpenDrawerWithAnimation("threads", true)).toBe(false);
    expect(shouldOpenDrawerWithAnimation("chat", false)).toBe(false);
  });

  it("recognizes compact mobile viewports for drawer opening from any horizontal start point", () => {
    expect(isCompactMobileViewport({ innerWidth: 420 })).toBe(true);
    expect(isCompactMobileViewport({ innerWidth: 1280 })).toBe(false);
    expect(
      shouldStartDrawerEdgeSwipe({
        startX: 16,
        body: {
          classList: {
            contains() {
              return false;
            },
          },
        },
        windowRef: { innerWidth: 420 },
      })
    ).toBe(true);
    expect(
      shouldStartDrawerEdgeSwipe({
        startX: 240,
        body: {
          classList: {
            contains() {
              return false;
            },
          },
        },
        windowRef: { innerWidth: 420 },
      })
    ).toBe(true);
  });

  it("keeps a tiny accidental drag from committing the drawer", () => {
    expect(shouldCommitDrawerOpen({ deltaX: 8, drawerWidth: 300 })).toBe(false);
    expect(shouldCommitDrawerOpen({ deltaX: 18, drawerWidth: 300 })).toBe(true);
    expect(shouldCommitDrawerClose({ deltaX: -8, drawerWidth: 300 })).toBe(false);
    expect(shouldCommitDrawerClose({ deltaX: -18, drawerWidth: 300 })).toBe(true);
  });

  it("snaps open or closed once the drag has clearly started in that direction", () => {
    expect(shouldCommitDrawerOpen({ deltaX: 18, drawerWidth: 300 })).toBe(true);
    expect(shouldCommitDrawerClose({ deltaX: -18, drawerWidth: 300 })).toBe(true);
  });

  it("starts close swipe from anywhere once the left drawer is already open on non-phone layouts", () => {
    expect(
      shouldStartDrawerCloseSwipe({
        startX: 250,
        body: {
          classList: {
            contains(name) {
              return name === "drawer-left-open";
            },
          },
        },
        panelRect: { right: 300 },
        windowRef: { innerWidth: 420 },
      })
    ).toBe(true);
    expect(
      shouldStartDrawerCloseSwipe({
        startX: 380,
        body: {
          classList: {
            contains(name) {
              return name === "drawer-left-open";
            },
          },
        },
        panelRect: { right: 300 },
        windowRef: { innerWidth: 420 },
      })
    ).toBe(true);
  });

  it("starts close swipe from anywhere once the left drawer is already open on phone-like layouts", () => {
    expect(
      shouldStartDrawerCloseSwipe({
        startX: 180,
        body: {
          classList: {
            contains(name) {
              return name === "drawer-left-open";
            },
          },
        },
        panelRect: { right: 300 },
        windowRef: {
          innerWidth: 420,
          navigator: { maxTouchPoints: 5 },
          matchMedia(query) {
            return { matches: query === "(max-width: 1080px)" || query === "(pointer: coarse)" || query === "(hover: none)" };
          },
        },
      })
    ).toBe(true);
  });

  it("hides the slash menu before opening a drawer", () => {
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
      },
    };
    const calls = [];
    const module = createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
      hideSlashCommandMenu() {
        calls.push("hide");
      },
    });

    module.setMobileTab("threads");

    expect(calls).toEqual(["hide"]);
  });

  it("keeps drawer content hidden during open drag preview and restores entry animation after release", () => {
    const timers = [];
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
        toggle(name, force) {
          if (force) body._classes.add(name);
          else body._classes.delete(name);
        },
      },
      style: {
        setProperty() {},
        removeProperty() {},
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
        add() {},
        remove() {},
      },
    };
    const state = {
      drawerOpenPhaseTimer: 0,
      threadListVisibleOpenAnimationUntil: 0,
      threadListPendingSidebarOpenAnimation: false,
      threadListVisibleAnimationTimer: 0,
      threadListLoading: false,
      threadItems: [{ id: "t1" }],
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
    };
    const module = createMobileShellModule({
      state,
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
      hideSlashCommandMenu() {},
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    body.classList.add("drawer-left-dragging");
    body.classList.add("drawer-left-previewing");
    module.setMobileTab("threads");

    expect(body._classes.has("drawer-left-open")).toBe(true);
    expect(body._classes.has("drawer-left-opening")).toBe(true);
    expect(body._classes.has("drawer-left-previewing")).toBe(false);
    expect(state.threadListVisibleOpenAnimationUntil).toBeGreaterThan(0);
    expect(state.threadListAnimateNextRender).toBe(false);

    timers.find((timer) => timer.delayMs === 220)?.callback();
    expect(state.threadListAnimateNextRender).toBe(false);

    timers.find((timer) => timer.delayMs > 220)?.callback();
    expect(state.threadListAnimateNextRender).toBe(true);
  });

  it("defers visible thread list entry animation until the drawer is open", () => {
    const timers = [];
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        removeProperty() {},
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
        remove() {},
      },
    };
    const state = {
      drawerOpenPhaseTimer: 0,
      threadListVisibleOpenAnimationUntil: 0,
      threadListPendingSidebarOpenAnimation: false,
      threadListVisibleAnimationTimer: 0,
      threadListLoading: false,
      threadItems: [{ id: "t1" }, { id: "t2" }],
      threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
    };
    const rendered = [];
    const module = createMobileShellModule({
      state,
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads(items) {
        rendered.push(items.map((item) => item.id));
      },
      hideSlashCommandMenu() {},
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    module.setMobileTab("threads");

    expect(rendered).toEqual([]);
    expect(state.threadListAnimateNextRender).toBe(false);
    expect(body._classes.has("drawer-left-opening")).toBe(true);

    timers.find((timer) => timer.delayMs === 220)?.callback();
    expect(rendered).toEqual([]);

    timers.find((timer) => timer.delayMs > 220)?.callback();
    expect(rendered).toEqual([["t1", "t2"]]);
    expect(state.threadListAnimateNextRender).toBe(true);
    expect(state.threadListPendingVisibleAnimationByWorkspace.windows).toBe(true);
  });

  it("does not restart thread list entry animation when refresh already started it", () => {
    const timers = [];
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        removeProperty() {},
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
        remove() {},
      },
    };
    const threadList = {
      querySelector(selector) {
        return String(selector || "").includes("groupEnter") ? { nodeType: 1 } : null;
      },
    };
    const state = {
      drawerOpenPhaseTimer: 0,
      threadListVisibleOpenAnimationUntil: 0,
      threadListPendingSidebarOpenAnimation: false,
      threadListVisibleAnimationTimer: 0,
      threadListLoading: false,
      threadItems: [{ id: "t1" }],
      threadListPendingVisibleAnimationByWorkspace: { windows: true, wsl2: false },
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
    };
    const rendered = [];
    const module = createMobileShellModule({
      state,
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        if (id === "threadList") return threadList;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads(items) {
        rendered.push(items.map((item) => item.id));
      },
      hideSlashCommandMenu() {},
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    module.setMobileTab("threads");
    timers.find((timer) => timer.delayMs > 220)?.callback();

    expect(rendered).toEqual([]);
    expect(state.threadListAnimateNextRender).toBe(false);
    expect(state.threadListPendingVisibleAnimationByWorkspace.windows).toBe(false);
  });

  it("animates existing thread list DOM on drawer open without re-rendering it", () => {
    const timers = [];
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        removeProperty() {},
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
        remove() {},
      },
    };
    const group = {
      style: {
        props: {},
        setProperty(name, value) {
          this.props[name] = value;
        },
      },
      classList: {
        classes: new Set(["groupCard"]),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
    };
    const header = {
      classList: {
        classes: new Set(["groupHeader"]),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
    };
    const item = {
      style: {
        props: {},
        setProperty(name, value) {
          this.props[name] = value;
        },
      },
      classList: {
        classes: new Set(["itemCard"]),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
    };
    const threadList = {
      classList: {
        classes: new Set(),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        remove(...names) {
          for (const name of names) this.classes.delete(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
      getBoundingClientRect() {
        return { width: 280, height: 640 };
      },
      querySelector(selector) {
        const query = String(selector || "");
        if (query.includes("groupEnter") || query.includes("threadEnter")) return null;
        if (query.includes(".groupCard") || query.includes(".itemCard")) return group;
        return null;
      },
      querySelectorAll(selector) {
        const query = String(selector || "");
        if (query === ".groupCard") return [group];
        if (query === ".groupHeader") return [header];
        if (query === ".itemCard") return [item];
        return [];
      },
    };
    const state = {
      drawerOpenPhaseTimer: 0,
      threadListVisibleOpenAnimationUntil: 0,
      threadListPendingSidebarOpenAnimation: false,
      threadListVisibleAnimationTimer: 0,
      threadListLoading: false,
      threadItems: [{ id: "t1" }],
      threadListPendingVisibleAnimationByWorkspace: { windows: true, wsl2: false },
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
    };
    const rendered = [];
    const module = createMobileShellModule({
      state,
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        if (id === "threadList") return threadList;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads(items) {
        rendered.push(items.map((entry) => entry.id));
      },
      hideSlashCommandMenu() {},
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    module.setMobileTab("threads");

    expect(rendered).toEqual([]);
    expect(threadList.classList.contains("threadListDrawerEnter")).toBe(true);
    expect(group.classList.contains("groupEnter")).toBe(false);
    expect(header.classList.contains("threadHeaderEnter")).toBe(false);
    expect(item.classList.contains("threadEnter")).toBe(false);
    expect(state.threadListPendingVisibleAnimationByWorkspace.windows).toBe(false);
    expect(timers.some((timer) => timer.delayMs === 240)).toBe(false);
  });

  it("animates workspace-switched existing thread list DOM before the drawer paints", () => {
    const timers = [];
    const body = {
      _classes: new Set(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        removeProperty() {},
      },
    };
    const backdrop = {
      classList: {
        toggle() {},
        remove() {},
      },
    };
    const group = {
      style: {
        setProperty() {},
      },
      classList: {
        classes: new Set(["groupCard"]),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
    };
    const header = {
      classList: {
        classes: new Set(["groupHeader"]),
        add(...names) {
          for (const name of names) this.classes.add(name);
        },
        contains(name) {
          return this.classes.has(name);
        },
      },
    };
    const threadList = {
      querySelector(selector) {
        const query = String(selector || "");
        if (query.includes(".groupCard") || query.includes(".itemCard")) return group;
        return null;
      },
      querySelectorAll(selector) {
        const query = String(selector || "");
        if (query === ".groupCard") return [group];
        if (query === ".groupHeader") return [header];
        if (query === ".itemCard") return [];
        return [];
      },
    };
    const state = {
      drawerOpenPhaseTimer: 0,
      threadListVisibleOpenAnimationUntil: 0,
      threadListPendingSidebarOpenAnimation: false,
      threadListVisibleAnimationTimer: 0,
      threadListLoading: false,
      threadItems: [{ id: "t1" }],
      threadListPendingVisibleAnimationByWorkspace: { windows: true, wsl2: false },
      threadListAnimateExistingDomOnOpenByWorkspace: { windows: true, wsl2: false },
      threadListAnimateNextRender: false,
      threadListAnimateThreadIds: new Set(),
      threadListExpandAnimateGroupKeys: new Set(),
      threadListSkipScrollRestoreOnce: false,
    };
    const rendered = [];
    const module = createMobileShellModule({
      state,
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        if (id === "threadList") return threadList;
        return null;
      },
      documentRef: { body },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads(items) {
        rendered.push(items.map((entry) => entry.id));
      },
      hideSlashCommandMenu() {},
      setTimeoutRef(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeoutRef(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    });

    module.setMobileTab("threads");

    expect(rendered).toEqual([]);
    expect(group.classList.contains("groupEnter")).toBe(true);
    expect(header.classList.contains("threadHeaderEnter")).toBe(true);
    expect(state.threadListAnimateExistingDomOnOpenByWorkspace.windows).toBe(false);
    expect(timers.some((timer) => timer.delayMs > 220)).toBe(false);
  });

  it("drags the thread drawer with a left-edge swipe on mobile", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) {
            this._classes.add(name);
            return;
          }
          this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 12, clientY: 220 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 78, clientY: 226 }],
    });

    expect(body._classes.has("drawer-left-dragging")).toBe(true);
    expect(body._style.get("--drawer-left-drag-translate")).toBe("-258px");
    expect(backdrop.classList._classes.has("show")).toBe(true);

    handlers.get("touchend")({
      changedTouches: [{ clientX: 148, clientY: 226 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(true);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
  });

  it("commits drawer opening from the last drag point when touchend omits changedTouches", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) {
            this._classes.add(name);
            return;
          }
          this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 12, clientY: 220 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 148, clientY: 226 }],
    });
    handlers.get("touchend")({});

    expect(body._classes.has("drawer-left-open")).toBe(true);
  });

  it("does not cancel an already-horizontal drawer drag because of later vertical drift", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) {
            this._classes.add(name);
            return;
          }
          this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 10, clientY: 200 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 62, clientY: 206 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 86, clientY: 248 }],
    });

    expect(body._classes.has("drawer-left-dragging")).toBe(true);
    expect(body._style.has("--drawer-left-drag-translate")).toBe(true);
  });

  it("opens the thread drawer from any rightward horizontal swipe", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) {
            this._classes.add(name);
            return;
          }
          this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 48, clientY: 220 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 116, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-dragging")).toBe(true);

    handlers.get("touchend")({
      changedTouches: [{ clientX: 140, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(true);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
  });

  it("lets horizontally scrollable message content keep horizontal swipes", () => {
    const scrollable = {
      classList: {
        contains(name) {
          return name === "msgCodeBlock";
        },
      },
      scrollWidth: 640,
      clientWidth: 280,
      parentElement: null,
    };
    expect(shouldUseHorizontalScrollPriority(scrollable, null)).toBe(true);

    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) this._classes.add(name);
          else this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      target: scrollable,
      touches: [{ clientX: 48, clientY: 220 }],
    });
    handlers.get("touchmove")({
      target: scrollable,
      touches: [{ clientX: 116, clientY: 224 }],
    });
    handlers.get("touchend")({
      target: scrollable,
      changedTouches: [{ clientX: 140, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(false);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
    expect(body._style.has("--drawer-left-drag-translate")).toBe(false);
  });

  it("does not open the drawer when an image viewer gesture starts inside the modal", () => {
    const imageViewer = {
      getAttribute(name) {
        return name === "role" ? "dialog" : null;
      },
      parentElement: null,
    };
    const imageViewerBody = {
      classList: {
        contains(name) {
          return name === "imageViewerBody";
        },
      },
      parentElement: imageViewer,
    };
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) this._classes.add(name);
          else this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      target: imageViewerBody,
      touches: [{ clientX: 48, clientY: 220 }],
    });
    handlers.get("touchmove")({
      target: imageViewerBody,
      touches: [{ clientX: 116, clientY: 224 }],
    });
    handlers.get("touchend")({
      target: imageViewerBody,
      changedTouches: [{ clientX: 140, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(false);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
    expect(body._style.has("--drawer-left-drag-translate")).toBe(false);
  });

  it("does not open the drawer when a generic drawer-blocking backdrop is active", () => {
    const genericBackdrop = {
      _attrs: new Map([
        ["data-block-drawer-gesture", "true"],
        ["aria-hidden", "false"],
      ]),
      classList: {
        contains(name) {
          return name === "show";
        },
      },
      getAttribute(name) {
        return this._attrs.get(name) || null;
      },
      parentElement: null,
    };
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) this._classes.add(name);
          else this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      target: genericBackdrop,
      touches: [{ clientX: 48, clientY: 220 }],
    });
    handlers.get("touchmove")({
      target: genericBackdrop,
      touches: [{ clientX: 116, clientY: 224 }],
    });
    handlers.get("touchend")({
      target: genericBackdrop,
      changedTouches: [{ clientX: 140, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(false);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
    expect(body._style.has("--drawer-left-drag-translate")).toBe(false);
  });

  it("cancels drawer opening when native text selection becomes active mid-gesture", () => {
    let selectionActive = false;
    const messageText = {
      classList: {
        contains() {
          return false;
        },
      },
      parentElement: null,
    };
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) this._classes.add(name);
          else this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };
    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: {
        innerWidth: 420,
        getSelection() {
          return selectionActive
            ? {
                isCollapsed: false,
                toString() {
                  return "selected text";
                },
              }
            : {
                isCollapsed: true,
                toString() {
                  return "";
                },
              };
        },
      },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      target: messageText,
      touches: [{ clientX: 48, clientY: 220 }],
    });
    selectionActive = true;
    handlers.get("touchmove")({
      target: messageText,
      touches: [{ clientX: 116, clientY: 224 }],
    });
    handlers.get("touchend")({
      target: messageText,
      changedTouches: [{ clientX: 140, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(false);
    expect(body._classes.has("drawer-left-dragging")).toBe(false);
    expect(body._style.has("--drawer-left-drag-translate")).toBe(false);
  });

  it("keeps sidebar swipes available over non-overflowing message blocks", () => {
    const codeBlock = {
      classList: {
        contains(name) {
          return name === "msgCodeBlock";
        },
      },
      scrollWidth: 280,
      clientWidth: 280,
      parentElement: null,
    };

    expect(shouldUseHorizontalScrollPriority(codeBlock, null)).toBe(false);
  });

  it("falls back to the real .leftPanel node when no leftPanel id exists", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(),
        toggle(name, force) {
          if (force) {
            this._classes.add(name);
            return;
          }
          this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };

    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 320 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 10, clientY: 200 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 90, clientY: 204 }],
    });

    expect(body._style.get("--drawer-left-drag-translate")).toBe("-265.6px");
  });

  it("closes the thread drawer when dragging it back to the left", () => {
    const handlers = new Map();
    const body = {
      _classes: new Set(["drawer-left-open"]),
      _style: new Map(),
      classList: {
        contains(name) {
          return body._classes.has(name);
        },
        add(...names) {
          for (const name of names) body._classes.add(name);
        },
        remove(...names) {
          for (const name of names) body._classes.delete(name);
        },
      },
      style: {
        setProperty(name, value) {
          body._style.set(name, value);
        },
        removeProperty(name) {
          body._style.delete(name);
        },
      },
    };
    const backdrop = {
      classList: {
        _classes: new Set(["show"]),
        toggle(name, force) {
          if (force) this._classes.add(name);
          else this._classes.delete(name);
        },
        add(name) {
          this._classes.add(name);
        },
        remove(name) {
          this._classes.delete(name);
        },
      },
    };

    createMobileShellModule({
      state: {
        drawerOpenPhaseTimer: 0,
        threadListVisibleOpenAnimationUntil: 0,
        threadListPendingSidebarOpenAnimation: false,
        threadListVisibleAnimationTimer: 0,
        threadListLoading: false,
        threadItems: [],
        threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
        threadListAnimateNextRender: false,
        threadListAnimateThreadIds: new Set(),
        threadListExpandAnimateGroupKeys: new Set(),
        threadListSkipScrollRestoreOnce: false,
      },
      byId(id) {
        if (id === "mobileDrawerBackdrop") return backdrop;
        return null;
      },
      documentRef: {
        body,
        querySelector(selector) {
          if (selector === ".leftPanel") {
            return {
              getBoundingClientRect() {
                return { width: 300, right: 310 };
              },
            };
          }
          return null;
        },
        addEventListener(name, handler) {
          handlers.set(name, handler);
        },
      },
      windowRef: { innerWidth: 420 },
      normalizeWorkspaceTarget(value) {
        return value;
      },
      getWorkspaceTarget() {
        return "windows";
      },
      pushThreadAnimDebug() {},
      renderThreads() {},
    });

    handlers.get("touchstart")({
      touches: [{ clientX: 220, clientY: 220 }],
    });
    handlers.get("touchmove")({
      touches: [{ clientX: 120, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-dragging")).toBe(true);
    expect(body._style.get("--drawer-left-drag-translate")).toBe("-100px");

    handlers.get("touchend")({
      changedTouches: [{ clientX: 80, clientY: 224 }],
    });

    expect(body._classes.has("drawer-left-open")).toBe(false);
  });
});
