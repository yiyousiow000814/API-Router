import { describe, expect, it } from "vitest";

import { createMobileShellModule, shouldOpenDrawerWithAnimation } from "./mobileShell.js";

describe("mobileShell", () => {
  it("animates only when opening thread drawer from closed state", () => {
    expect(shouldOpenDrawerWithAnimation("threads", false)).toBe(true);
    expect(shouldOpenDrawerWithAnimation("threads", true)).toBe(false);
    expect(shouldOpenDrawerWithAnimation("chat", false)).toBe(false);
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
});
