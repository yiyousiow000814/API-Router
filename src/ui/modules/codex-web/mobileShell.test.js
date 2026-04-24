import { describe, expect, it } from "vitest";

import {
  createMobileShellModule,
  isCompactMobileViewport,
  shouldCommitDrawerOpen,
  shouldCommitDrawerClose,
  shouldOpenDrawerWithAnimation,
  shouldStartDrawerCloseSwipe,
  shouldStartDrawerEdgeSwipe,
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
    });

    body.classList.add("drawer-left-dragging");
    body.classList.add("drawer-left-previewing");
    module.setMobileTab("threads");

    expect(body._classes.has("drawer-left-open")).toBe(true);
    expect(body._classes.has("drawer-left-opening")).toBe(true);
    expect(body._classes.has("drawer-left-previewing")).toBe(false);
    expect(state.threadListVisibleOpenAnimationUntil).toBeGreaterThan(0);
    expect(state.threadListAnimateNextRender).toBe(true);
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
