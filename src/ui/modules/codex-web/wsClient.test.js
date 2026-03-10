import { describe, expect, it } from "vitest";

import {
  buildCodexWsUrl,
  ensureArrayItems,
  resolveApiErrorMessage,
} from "./wsClient.js";

describe("wsClient", () => {
  it("normalizes array-like payloads", () => {
    expect(ensureArrayItems([1, 2])).toEqual([1, 2]);
    expect(ensureArrayItems({ items: [3] })).toEqual([3]);
    expect(ensureArrayItems(null)).toEqual([]);
  });

  it("builds websocket urls from location and token", () => {
    expect(buildCodexWsUrl({ protocol: "https:", host: "example.com" }, "abc")).toBe(
      "wss://example.com/codex/ws?token=abc"
    );
  });

  it("prefers structured api errors", () => {
    expect(resolveApiErrorMessage({ error: { detail: "boom" } }, 500)).toBe("boom");
    expect(resolveApiErrorMessage({}, 404)).toBe("HTTP 404");
  });
});
