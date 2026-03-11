import { describe, expect, it } from "vitest";

import {
  collectPendingLiveTraceEvents,
  hasQueryFlag,
  readDebugMessageNode,
} from "./debugTools.js";

describe("debugTools", () => {
  it("detects query flags", () => {
    expect(hasQueryFlag("?e2e=1", "e2e")).toBe(true);
    expect(hasQueryFlag("?e2e=0", "e2e")).toBe(false);
  });

  it("reads message debug snapshots", () => {
    const body = {
      textContent: "abc",
      innerHTML:
        '<code class="msgInlineCode">a</code><span class="msgPseudoLink">b</span><a class="msgLink" href="/x">c</a>',
      querySelectorAll(selector) {
        if (selector === "code.msgInlineCode") return [{ textContent: "a" }];
        if (selector === ".msgPseudoLink") return [{ textContent: "b" }];
        if (selector === "a.msgLink") {
          return [
            {
              textContent: "c",
              getAttribute(name) {
                return name === "href" ? "/x" : "";
              },
            },
          ];
        }
        return [];
      },
    };
    const node = {
      className: "msg assistant",
      __webCodexRole: "assistant",
      __webCodexKind: "tool",
      __webCodexSource: "live",
      __webCodexRawText: "hello",
      querySelector(selector) {
        if (selector === ".msgBody") return body;
        if (selector === ".msgHead") return { textContent: "Codex" };
        return null;
      },
    };
    const info = readDebugMessageNode(node, 2);
    expect(info.index).toBe(2);
    expect(info.role).toBe("assistant");
    expect(info.inline).toEqual(["a"]);
    expect(info.pseudo).toEqual(["b"]);
    expect(info.links).toEqual([{ text: "c", href: "/x" }]);
  });

  it("collects only unsent live trace events", () => {
    const state = {
      liveDebugEvents: [
        { at: 1, kind: "a", __traceUploaded: true },
        { at: 2, kind: "b" },
        { at: 3, kind: "c" },
      ],
    };
    expect(collectPendingLiveTraceEvents(state, 1)).toEqual([{ at: 2, kind: "b" }]);
    expect(collectPendingLiveTraceEvents(state, 5)).toEqual([
      { at: 2, kind: "b" },
      { at: 3, kind: "c" },
    ]);
  });
});
