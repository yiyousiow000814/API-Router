import { describe, expect, it } from "vitest";

import { createLiveNotificationsModule, workspaceKeyOfThread } from "./liveNotifications.js";

describe("liveNotifications", () => {
  it("extracts workspace key from thread cwd", () => {
    expect(workspaceKeyOfThread({ cwd: "src/ui" })).toBe("ui");
  });

  it("formats command execution items", () => {
    const { toToolLikeMessage } = createLiveNotificationsModule({
      state: { activeThreadId: "" },
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase(); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId() { return ""; },
    });
    expect(toToolLikeMessage({ type: "commandExecution", command: "pwd", exitCode: 0 })).toContain("pwd");
  });
});
