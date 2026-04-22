import { describe, expect, it } from "vitest";

import {
  createLiveNotificationsModule,
  deriveLiveStatusFromNotification,
  deriveLiveStatusFromToolItem,
  normalizeLiveMethod,
  workspaceKeyOfThread,
} from "./liveNotifications.js";

describe("liveNotifications", () => {
  it("extracts workspace key and label from thread cwd", () => {
    expect(workspaceKeyOfThread({ cwd: "src/ui" })).toEqual({ key: "src/ui", label: "ui" });
  });

  it("uses canonical paths as keys while preserving folder labels", () => {
    const cases = [
      { cwd: "C:\\Users\\yiyou\\API-Router", key: "c:/users/yiyou/api-router" },
      { cwd: "C:\\Users\\yiyou\\API-router", key: "c:/users/yiyou/api-router" },
      { cwd: "\\\\?\\C:\\Users\\yiyou\\API-Router", key: "c:/users/yiyou/api-router" },
      { cwd: "C:\\Users\\yiyou\\.codex\\worktrees\\4002\\API-Router", key: "c:/users/yiyou/api-router" },
      { cwd: "C:/Users/yiyou/API-Router", key: "c:/users/yiyou/api-router" },
    ];
    for (const thread of cases) {
      const result = workspaceKeyOfThread(thread);
      expect(result.key).toEqual(thread.key);
      // Label matches the actual folder name from the cwd (case preserved)
      expect(result.label).toMatch(/^API-?[Rr]outer$/);
    }
  });

  it("does not merge distinct projects with the same folder name", () => {
    expect(workspaceKeyOfThread({ cwd: "C:\\work\\myproject" })).toEqual({
      key: "c:/work/myproject",
      label: "myproject",
    });
    expect(workspaceKeyOfThread({ cwd: "D:\\personal\\myproject" })).toEqual({
      key: "d:/personal/myproject",
      label: "myproject",
    });
  });

  it("uses 'default-folder' for empty or missing cwd", () => {
    expect(workspaceKeyOfThread({})).toEqual({ key: "default-folder", label: "Default folder" });
    expect(workspaceKeyOfThread({ cwd: "" })).toEqual({ key: "default-folder", label: "Default folder" });
  });

  it("falls back to workspace, project, directory, path when cwd is missing", () => {
    expect(workspaceKeyOfThread({ workspace: "my-workspace" })).toEqual({ key: "my-workspace", label: "my-workspace" });
    expect(workspaceKeyOfThread({ project: "my-project" })).toEqual({ key: "my-project", label: "my-project" });
  });

  it("merges codex worktree paths back into the root project key", () => {
    expect(workspaceKeyOfThread({ cwd: "C:\\Users\\yiyou\\API-Router" })).toEqual({ key: "c:/users/yiyou/api-router", label: "API-Router" });
    expect(workspaceKeyOfThread({ cwd: "C:\\Users\\yiyou\\.codex\\worktrees\\4002\\API-Router" })).toEqual({ key: "c:/users/yiyou/api-router", label: "API-Router" });
    expect(workspaceKeyOfThread({ cwd: "C:\\Users\\yiyou\\.codex\\worktrees\\4002\\API-Router\\src" })).toEqual({ key: "c:/users/yiyou/api-router", label: "src" });
  });

  it("keeps truly distinct folder names separate", () => {
    expect(workspaceKeyOfThread({ cwd: "C:\\Users\\yiyou\\API-Router" })).toEqual({ key: "c:/users/yiyou/api-router", label: "API-Router" });
    expect(workspaceKeyOfThread({ cwd: "C:\\Users\\yiyou\\API-Router-wt-main" })).toEqual({ key: "c:/users/yiyou/api-router-wt-main", label: "API-Router-wt-main" });
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

  it("formats shell_command tool calls as compact command lines", () => {
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

    expect(
      toToolLikeMessage({
        type: "toolCall",
        tool: "shell_command",
        status: "running",
        arguments: JSON.stringify({ command: "cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib" }),
      })
    ).toBe("Running `cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib`");
  });

  it("suppresses request_user_input tool placeholder messages", () => {
    const { toToolLikeMessage } = createLiveNotificationsModule({
      state: { activeThreadId: "" },
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId() { return ""; },
    });

    expect(
      toToolLikeMessage({
        type: "toolCall",
        tool: "request_user_input",
        status: "completed",
        arguments: JSON.stringify({ questions: [{ id: "q1", question: "Continue?" }] }),
      })
    ).toBe("");
  });

  it("derives live status from command execution updates", () => {
    expect(
      deriveLiveStatusFromToolItem(
        { type: "commandExecution", command: "git commit", status: "running" },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toEqual({ message: "Running git commit...", isWarn: false });
  });

  it("derives live status from web search and file change failures", () => {
    expect(
      deriveLiveStatusFromToolItem(
        { type: "webSearch", query: "codex live sync", status: "failed" },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toEqual({ message: "Web search failed: codex live sync", isWarn: true });

    expect(
      deriveLiveStatusFromToolItem(
        { type: "fileChange", changes: [{ path: "a.txt" }], status: "running" },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toEqual({ message: "Applying file changes...", isWarn: false });
  });

  it("derives live status from turn notifications", () => {
    expect(
      deriveLiveStatusFromNotification(
        { method: "turn/assistant/delta", params: { threadId: "thread-1", delta: "hello" } },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toEqual({ message: "Receiving response...", isWarn: false });
  });

  it("treats turn/completed with failed status as failed", () => {
    expect(
      deriveLiveStatusFromNotification(
        { method: "turn/completed", params: { threadId: "thread-1", status: "failed" } },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toEqual({ message: "Turn failed.", isWarn: true });
  });

  it("normalizes current Codex notification method spellings", () => {
    expect(normalizeLiveMethod("turn.completed")).toBe("turn/completed");
    expect(normalizeLiveMethod("item_completed")).toBe("item/completed");
    expect(normalizeLiveMethod("task_complete")).toBe("codex/event/task_complete");
    expect(normalizeLiveMethod("turn_complete")).toBe("codex/event/turn_complete");
    expect(normalizeLiveMethod("task_aborted")).toBe("codex/event/task_aborted");
  });

  it("does not treat rollout task_complete as a successful terminal turn", () => {
    expect(
      deriveLiveStatusFromNotification(
        { method: "task_complete", params: { threadId: "thread-1" } },
        {
          normalizeType(value) { return String(value || "").toLowerCase(); },
          normalizeInline(value) { return value == null ? null : String(value); },
          toRecord(value) { return value && typeof value === "object" ? value : null; },
        }
      )
    ).toBeNull();
  });

  it("streams assistant deltas into the active thread", () => {
    const appended = [];
    const finalized = [];
    const created = [];
    const statuses = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase(); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.conversationId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        const msg = { setAttribute() {} };
        const body = {};
        created.push({ msg, body });
        return { msg, body };
      },
      appendStreamingDelta(body, text) {
        appended.push({ body, text });
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
    });

    module.renderLiveNotification({
      method: "turn/assistant/delta",
      params: { threadId: "thread-1", delta: "hello" },
    });
    module.renderLiveNotification({
      method: "turn/assistant/delta",
      params: { threadId: "thread-1", delta: " world" },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" },
    });

    expect(created).toHaveLength(1);
    expect(appended.map((item) => item.text)).toEqual(["hello", " world"]);
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "hello world", kind: "" }]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("hello world");
    expect(statuses[0]).toEqual({ message: "Receiving response...", isWarn: false });
    expect(statuses[statuses.length - 1]).toEqual({ message: "Turn completed.", isWarn: false });
  });

  it("renders live assistant markdown through rich body renderer when available", () => {
    const rendered = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) { return String(value || "").toLowerCase(); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      renderAssistantLiveBody(_msg, _body, text) {
        rendered.push(text);
      },
      appendStreamingDelta() {
        throw new Error("should not use raw streaming fallback");
      },
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "turn/assistant/delta",
      params: { threadId: "thread-1", delta: "**关于 tool live**" },
    });

    expect(rendered).toEqual(["**关于 tool live**"]);
  });

  it("renders assistant message items live for the active thread", () => {
    const appended = [];
    const finalized = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      appendStreamingDelta(body, text) {
        appended.push({ body, text });
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
    });

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          type: "assistant_message",
          text: "live reply",
        },
      },
    });

    expect(appended.map((item) => item.text)).toEqual(["live reply"]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("live reply");
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "live reply", kind: "" }]);
  });

  it("turns proposed_plan assistant output into a plan card and local confirmation question", () => {
    const added = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", plan: options.plan || null });
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "assistant-1",
          type: "assistant_message",
          phase: "final_answer",
          text: `<proposed_plan>
# Fix Pending

- Clear stale UI
</proposed_plan>`,
        },
      },
    });

    expect(added).toEqual([
      expect.objectContaining({
        role: "system",
        kind: "planCard",
        plan: expect.objectContaining({ title: "Fix Pending" }),
      }),
    ]);
    expect(state.proposedPlanConfirmationsByThreadId).toEqual(expect.objectContaining({
      "thread-1": expect.objectContaining({
        prompt: "Implement this plan?",
        plan: expect.objectContaining({ title: "Fix Pending" }),
      }),
    }));
  });

  it("turns markdown proposed plan assistant output into a plan card and local confirmation question", () => {
    const added = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", plan: options.plan || null });
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "assistant-2",
          type: "assistant_message",
          phase: "final_answer",
          text: `Context before plan.

Proposed Plan
## Fix Pending

Tighten cancellation cleanup.

- Clear stale UI
- Remove empty commentary archive`,
        },
      },
    });

    expect(state.activeThreadMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        text: "Context before plan.",
      })
    );
    expect(added).toEqual([
      expect.objectContaining({
        role: "system",
        kind: "planCard",
        plan: expect.objectContaining({ title: "Fix Pending" }),
      }),
    ]);
    expect(state.proposedPlanConfirmationsByThreadId).toEqual(expect.objectContaining({
      "thread-1": expect.objectContaining({
        prompt: "Implement this plan?",
        plan: expect.objectContaining({ title: "Fix Pending" }),
      }),
    }));
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.inspect:proposed_plan_detection",
        source: "live",
        threadId: "thread-1",
        itemId: "assistant-2",
        hasPlan: true,
        hasPendingUserInput: true,
      }),
    ]));
  });

  it("treats standalone plan markdown plus the decision prompt as a proposed plan", () => {
    const added = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", plan: options.plan || null });
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "assistant-3",
          type: "assistant_message",
          phase: "final_answer",
          text: `# Fix Plan Rendering

## Summary
Ensure the web client recognizes plan responses even when the wrapper heading is omitted.

### Changes
- Detect standalone plan markdown before the confirmation prompt
- Render the inline plan card and local confirmation question

Implement this plan?
1. Yes, implement this plan
2. No, stay in Plan mode`,
        },
      },
    });

    expect(added).toEqual([
      expect.objectContaining({
        role: "system",
        kind: "planCard",
        plan: expect.objectContaining({ title: "Fix Plan Rendering" }),
      }),
    ]);
    expect(state.proposedPlanConfirmationsByThreadId).toEqual(expect.objectContaining({
      "thread-1": expect.objectContaining({
        prompt: "Implement this plan?",
        plan: expect.objectContaining({ title: "Fix Plan Rendering" }),
      }),
    }));
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.inspect:proposed_plan_detection",
        source: "live",
        threadId: "thread-1",
        itemId: "assistant-3",
        hasPlan: true,
        hasPendingUserInput: true,
      }),
    ]));
  });

  it("renders current Codex item.updated content delta events for the active thread", () => {
    const appended = [];
    const finalized = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      appendStreamingDelta(body, text) {
        appended.push({ body, text });
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          delta: "live",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          text: "live reply",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn.completed",
      params: { threadId: "thread-1" },
    });

    expect(appended.map((item) => item.text)).toEqual(["live", " reply"]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("live reply");
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "live reply", kind: "" }]);
  });

  it("dedupes duplicate final assistant snapshots from mixed live notification formats", () => {
    const appended = [];
    const finalized = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadLiveStateEpoch: 3,
      activeThreadLastFinalAssistantThreadId: "",
      activeThreadLastFinalAssistantText: "",
      activeThreadLastFinalAssistantAt: 0,
      activeThreadLastFinalAssistantEpoch: 0,
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(
          notification?.params?.threadId ||
          notification?.params?.item?.thread_id ||
          notification?.params?.payload?.thread_id ||
          ""
        );
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      appendStreamingDelta(body, text) {
        appended.push({ body, text });
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
      finalizeRuntimeState() {},
    });

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "行",
        },
      },
    });

    module.renderLiveNotification({
      method: "codex/event/agent_message",
      params: {
        payload: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          message: "行",
        },
      },
    });

    expect(appended.map((item) => item.text)).toEqual(["行"]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("行");
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "行", kind: "" }]);
    expect(state.liveDebugEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "live.skip:assistant_final_duplicate",
          threadId: "thread-1",
        }),
      ])
    );
  });

  it("persists the finalized assistant snapshot into pending turn state until history catches up", () => {
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          delta: "live",
        },
      },
    });
    expect(state.activeThreadPendingAssistantMessage).toBe("live");

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          text: "live reply",
        },
      },
    });
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("ends the pending runtime indicator once a final assistant snapshot arrives", () => {
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "partial",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("records pending turn baseline state when an external turn starts", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }, { id: "turn-2" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingTurnBaselineTurnCount: 0,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "stale",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-old",
        text: "old thinking",
        tools: [],
      },
      activeThreadCommentaryArchive: [{ key: "older", text: "older", tools: [] }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
      renderCommentaryArchive() {},
    });

    module.renderLiveNotification({
      method: "turn/started",
      params: { threadId: "thread-1" },
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(2);
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
  });

  it("ignores commentary-phase live assistant updates in the chat transcript", () => {
    const appended = [];
    const finalized = [];
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      appendStreamingDelta(_body, text) {
        appended.push(text);
      },
      finalizeAssistantMessage(_msg, _body, text) {
        finalized.push(text);
      },
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          phase: "commentary",
          delta: "working",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "commentary",
          text: "working notes",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn.completed",
      params: { threadId: "thread-1" },
    });

    expect(appended).toEqual(["done"]);
    expect(finalized).toEqual(["done"]);
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "done", kind: "" }]);
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("archives the previous commentary block and clears live runtime tools when a new commentary block starts", () => {
    const clearedCommandBatches = [];
    const renderArchiveCalls = [];
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadActiveCommands: [{ key: "old-cmd" }],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      setActiveCommands(entries) {
        clearedCommandBatches.push(Array.isArray(entries) ? entries.slice() : entries);
        state.activeThreadActiveCommands = Array.isArray(entries) ? entries.slice() : [];
      },
      renderCommentaryArchive() {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
        });
      },
      applyToolItemRuntimeUpdate(item) {
        state.activeThreadActiveCommands = [{ key: String(item?.id || "tool") }];
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          id: "commentary-1",
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          phase: "commentary",
          delta: "thinking one",
        },
      },
    });
    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "npm test",
          status: "running",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          id: "commentary-2",
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          phase: "commentary",
          delta: "thinking two",
        },
      },
    });

    expect(clearedCommandBatches).toEqual([[], []]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "thinking one",
        tools: ["Running `npm test`"],
      }),
    ]);
    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({
        key: "commentary-2",
        text: "thinking two",
        tools: [],
      })
    );
    expect(renderArchiveCalls.at(-1)).toEqual({ visible: false, archiveCount: 1 });
    expect(state.activeThreadTransientThinkingText).toBe("thinking two");
  });

  it("shows archived commentary only after final answer arrives", () => {
    const renderArchiveCalls = [];
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const makeThinkingNode = (text) => ({
      __webCodexRole: "system",
      __webCodexKind: "thinking",
      __webCodexRawText: text,
      remove() {
        chatBox.nodes = chatBox.nodes.filter((node) => node !== this);
      },
    });
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(_role, text, options = {}) {
        if (options.kind === "thinking" && options.transient === true) {
          chatBox.nodes = [makeThinkingNode(text)];
        }
      },
      scheduleChatLiveFollow() {},
      renderCommentaryArchive(options = {}) {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
          hasAnchor: !!options.anchorNode,
        });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { innerHTML: "", removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          id: "commentary-1",
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          phase: "commentary",
          delta: "thinking one",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({ key: "commentary-1", text: "thinking one" }),
    ]);
    expect(renderArchiveCalls.at(-1)).toEqual(
      expect.objectContaining({ visible: true, archiveCount: 1 })
    );
  });

  it("archives a plan-only commentary block when the turn finishes without commentary text", () => {
    const renderArchiveCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      renderCommentaryArchive(options = {}) {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
          hasAnchor: !!options.anchorNode,
        });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { innerHTML: "", removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "Investigate foldout rendering",
        plan: [{ step: "Check commentary archive", status: "in_progress" }],
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        text: "",
        plan: expect.objectContaining({
          title: "Updated Plan",
          explanation: "Investigate foldout rendering",
          steps: [{ step: "Check commentary archive", status: "inprogress" }],
        }),
      }),
    ]);
    expect(renderArchiveCalls.at(-1)).toEqual(
      expect.objectContaining({ visible: true, archiveCount: 1 })
    );
  });

  it("archives a tool-only commentary block when the turn finishes without commentary text", () => {
    const renderArchiveCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadActiveCommands: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      renderCommentaryArchive(options = {}) {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
          hasAnchor: !!options.anchorNode,
        });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { innerHTML: "", removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });
    const expectedToolText = module.toToolLikeMessage({
      type: "command_execution",
      command: "npm test",
      status: "completed",
    });

    module.renderLiveNotification({
      method: "item.started",
      params: {
        item: {
          id: "tool-1",
          type: "command_execution",
          thread_id: "thread-1",
          command: "npm test",
          status: "running",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          id: "tool-1",
          type: "command_execution",
          thread_id: "thread-1",
          command: "npm test",
          status: "completed",
        },
      },
    });
    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        text: "",
        tools: [expectedToolText],
      }),
    ]);
    expect(renderArchiveCalls.at(-1)).toEqual(
      expect.objectContaining({ visible: true, archiveCount: 1 })
    );
  });

  it("does not archive an empty commentary summary block when the turn finishes without commentary or tools", () => {
    const renderArchiveCalls = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadActiveCommands: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      renderCommentaryArchive(options = {}) {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
          hasAnchor: !!options.anchorNode,
        });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { innerHTML: "", removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(renderArchiveCalls.at(-1)).toEqual(
      expect.objectContaining({ visible: false, archiveCount: 0 })
    );
  });

  it("accepts codex/event agent_message commentary payloads and archives them on turn completion", () => {
    const renderArchiveCalls = [];
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      renderCommentaryArchive(options = {}) {
        renderArchiveCalls.push({
          visible: state.activeThreadCommentaryArchiveVisible,
          archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
          hasAnchor: !!options.anchorNode,
        });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(
          notification?.params?.threadId ||
          notification?.params?.payload?.thread_id ||
          notification?.params?.payload?.threadId ||
          ""
        );
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { innerHTML: "", removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
    });

    module.renderLiveNotification({
      method: "codex/event/agent_message",
      params: {
        payload: {
          id: "commentary-raw-1",
          type: "agent_message",
          thread_id: "thread-1",
          phase: "commentary",
          message: "working notes",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn.completed",
      params: { threadId: "thread-1" },
    });

    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({ key: "commentary-raw-1", text: "working notes" }),
    ]);
    expect(renderArchiveCalls.at(-1)).toEqual(
      expect.objectContaining({ visible: true, archiveCount: 1 })
    );
  });

  it("accepts codex/event response_item assistant commentary payloads", () => {
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.payload?.thread_id || notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "codex/event/response_item",
      params: {
        payload: {
          id: "commentary-raw-2",
          type: "message",
          role: "assistant",
          thread_id: "thread-1",
          phase: "commentary",
          content: [{ type: "output_text", text: "thinking from response item" }],
        },
      },
    });

    expect(state.activeThreadCommentaryCurrent).toEqual(
      expect.objectContaining({ key: "commentary-raw-2", text: "thinking from response item" })
    );
    expect(state.activeThreadTransientThinkingText).toBe("thinking from response item");
  });

  it("records commentary diagnostics for raw codex events in live debug trace", () => {
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-thinking[data-msg-transient="1"]') return this.nodes;
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const makeThinkingNode = (text) => ({
      __webCodexRole: "system",
      __webCodexKind: "thinking",
      __webCodexRawText: text,
      remove() {
        chatBox.nodes = chatBox.nodes.filter((node) => node !== this);
      },
    });
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(_role, text, options = {}) {
        if (options.kind === "thinking" && options.transient === true) {
          chatBox.nodes = [makeThinkingNode(text)];
        }
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.payload?.thread_id || notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "codex/event/agent_message",
      params: {
        payload: {
          id: "commentary-raw-3",
          type: "agent_message",
          thread_id: "thread-1",
          phase: "commentary",
          message: "diagnostic trace text",
        },
      },
    });

    expect(state.liveDebugEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "live.inspect:item_candidate",
          method: "codex/event/agent_message",
          itemSource: "params.payload",
          itemType: "agent_message",
          phase: "commentary",
          itemId: "commentary-raw-3",
        }),
        expect.objectContaining({
          kind: "live.inspect:assistant_candidate",
          method: "codex/event/agent_message",
          phase: "commentary",
          visible: false,
          preview: "diagnostic trace text",
        }),
        expect.objectContaining({
          kind: "live.inspect:commentary_state",
          action: "update",
          key: "commentary-raw-3",
          preview: "diagnostic trace text",
        }),
      ])
    );
  });

  it("shows only the latest live tool message and clears it on turn completion", () => {
    const added = [];
    const removed = [];
    const transientNode = (text) => ({
      __webCodexRole: "system",
      __webCodexKind: "tool",
      __webCodexRawText: text,
      remove() {
        removed.push(text);
      },
    });
    const chatBox = {
      nodes: [],
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-tool[data-msg-transient="1"]') {
          return this.nodes;
        }
        return [];
      },
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", transient: options.transient === true });
        if (options.transient === true) chatBox.nodes = [transientNode(text)];
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: {
          type: "commandExecution",
          command: "npm test",
          status: "running",
        },
      },
    });

    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: {
          type: "mcpToolCall",
          server: "x",
          tool: "y",
          status: "running",
        },
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" },
    });

    expect(added).toEqual([
      { role: "system", text: "Running `npm test`", kind: "tool", transient: true },
      { role: "system", text: "Running tool `x / y`", kind: "tool", transient: true },
    ]);
    expect(removed).toEqual(["Running `npm test`", "Running tool `x / y`"]);
    expect(state.activeThreadMessages).toEqual([
      { role: "user", text: "hello", kind: "" },
    ]);
  });

  it("routes live command updates into runtime state and skips chat fallback when active commands are present", () => {
    const added = [];
    const runtimeUpdates = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat(role, text) {
        added.push({ role, text });
      },
      scheduleChatLiveFollow() {},
      applyToolItemRuntimeUpdate(item, options) {
        runtimeUpdates.push({ item, options });
        state.activeThreadActiveCommands = [{ key: "cmd-1" }];
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: { id: "cmd-1", type: "commandExecution", command: "npm test", status: "running" },
      },
    });

    expect(runtimeUpdates).toHaveLength(1);
    expect(added).toEqual([]);
  });

  it("routes turn plan updates into runtime plan state", () => {
    const planUpdates = [];
    const module = createLiveNotificationsModule({
      state: { activeThreadId: "thread-1", activeThreadMessages: [] },
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      applyPlanSnapshotUpdate(payload) {
        planUpdates.push(payload);
      },
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "Need plan",
        plan: [{ step: "Inspect", status: "completed" }],
      },
    });

    expect(planUpdates).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "Need plan",
        plan: [{ step: "Inspect", status: "completed" }],
      },
    ]);
  });

  it("captures the running turn id when a turn starts", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      renderCommentaryArchive() {},
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-123",
      },
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-123");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
  });

  it("replays an opened chat through running, reasoning, tool, and final states in order", () => {
    const statuses = [];
    const runtimeActivity = [];
    const runtimeUpdates = [];
    const finalizedRuntime = [];
    const finalized = [];
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-seq",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadLiveStateEpoch: 0,
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      applyToolItemRuntimeUpdate(item, options) {
        runtimeUpdates.push({ item, options });
        state.activeThreadActiveCommands = [
          {
            key: String(item?.id || ""),
            type: item?.type,
            command: item?.command,
            status: item?.status,
          },
        ];
      },
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
        state.activeThreadActiveCommands = [];
        state.activeThreadPlan = null;
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.payload?.thread_id || notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/started",
      params: {
        threadId: "thread-seq",
        turnId: "turn-seq-1",
      },
    });
    module.renderLiveNotification({
      method: "codex/event/agent_reasoning",
      params: {
        payload: {
          id: "reasoning-1",
          type: "message",
          role: "assistant",
          thread_id: "thread-seq",
          phase: "commentary",
          content: [{ type: "output_text", text: "Inspecting workspace state" }],
        },
      },
    });
    module.renderLiveNotification({
      method: "item/started",
      params: {
        threadId: "thread-seq",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "pwd",
          status: "running",
        },
      },
    });
    module.renderLiveNotification({
      method: "codex/event/response_item",
      params: {
        payload: {
          id: "final-1",
          type: "message",
          role: "assistant",
          thread_id: "thread-seq",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    });
    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-seq",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "pwd",
          status: "completed",
          exitCode: 0,
        },
      },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-seq",
        turnId: "turn-seq-1",
      },
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(runtimeActivity).toEqual([
      expect.objectContaining({
        threadId: "thread-seq",
        title: "Thinking",
        detail: "",
        tone: "running",
      }),
      expect.objectContaining({
        threadId: "thread-seq",
        title: "Thinking",
        detail: "Inspecting workspace state",
        tone: "running",
      }),
    ]);
    expect(runtimeUpdates).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          id: "cmd-1",
          type: "commandExecution",
          command: "pwd",
          status: "running",
        }),
        options: expect.objectContaining({
          threadId: "thread-seq",
          method: "item/started",
        }),
      }),
      expect.objectContaining({
        item: expect.objectContaining({
          id: "cmd-1",
          status: "completed",
          exitCode: 0,
        }),
        options: expect.objectContaining({
          threadId: "thread-seq",
          method: "item/completed",
        }),
      }),
    ]);
    expect(state.activeThreadMessages).toEqual([
      { role: "assistant", text: "Done.", kind: "" },
    ]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("Done.");
    expect(finalizedRuntime).toEqual(["thread-seq", "thread-seq"]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        key: "reasoning-1",
        text: "Inspecting workspace state",
      }),
    ]);
    expect(statuses.map((entry) => entry.message)).toEqual([
      "Running...",
      "Running pwd...",
      "Turn completed.",
      "Command completed: pwd",
      "Turn completed.",
    ]);
  });

  it("keeps pending turn placeholders when a final assistant snapshot arrives without turn completed", () => {
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadLiveStateEpoch: 0,
    };
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const finalized = [];
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push({ msg, body, text });
      },
      setRuntimeActivity() {},
      applyToolItemRuntimeUpdate() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.payload?.thread_id || notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "codex/event/response_item",
      params: {
        payload: {
          id: "final-1",
          type: "message",
          role: "assistant",
          thread_id: "thread-1",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    });

    expect(finalized).toHaveLength(1);
    expect(finalized[0].text).toBe("Done.");
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(statuses.at(-1)).toEqual({ message: "Turn completed.", isWarn: false });
  });

  it("clears live runtime panels as soon as final answer becomes visible before turn completion", () => {
    const runtimeUpdates = [];
    const finalizedRuntime = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "Running `pwd`",
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "Inspecting workspace state",
        tools: ["Running `pwd`"],
        toolKeys: ["cmd-1"],
      },
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [{ key: "cmd-1", label: "pwd", text: "Running `pwd`", state: "running" }],
      activeThreadPlan: null,
    };
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelectorAll() {
        return [];
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      finalizeAssistantMessage() {},
      applyToolItemRuntimeUpdate(item, options) {
        runtimeUpdates.push({ item, options });
      },
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      renderCommentaryArchive() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.payload?.thread_id || notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
    });

    module.renderLiveNotification({
      method: "codex/event/response_item",
      params: {
        payload: {
          id: "final-1",
          type: "message",
          role: "assistant",
          thread_id: "thread-1",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Done." }],
        },
      },
    });

    expect(finalizedRuntime).toEqual(["thread-1"]);
    expect(state.activeThreadTransientToolText).toBe("");
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchiveVisible).toBe(true);
    expect(state.activeThreadCommentaryArchive).toEqual([
      expect.objectContaining({
        key: "commentary-1",
        text: "Inspecting workspace state",
        tools: ["Running `pwd`"],
      }),
    ]);

    module.renderLiveNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "pwd",
          status: "completed",
          exitCode: 0,
        },
      },
    });

    expect(runtimeUpdates).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          id: "cmd-1",
          type: "commandExecution",
          status: "completed",
        }),
        options: expect.objectContaining({
          threadId: "thread-1",
          method: "item/completed",
        }),
      }),
    ]);
    expect(finalizedRuntime).toEqual(["thread-1"]);
  });

  it("switches runtime activity back to thinking when commentary resumes after a plan update", () => {
    const runtimeActivity = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadTransientThinkingText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      normalizeType(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        explanation: "Need plan",
        plan: [{ step: "Inspect", status: "completed" }],
      },
    });
    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "thinking again",
        },
      },
    });

    expect(runtimeActivity[runtimeActivity.length - 1]).toEqual({
      threadId: "thread-1",
      title: "Thinking",
      detail: "thinking again",
      tone: "running",
    });
  });

  it("does not re-add the same transient tool bubble on repeated history polls", () => {
    const added = [];
    const removed = [];
    const transientNode = (text) => ({
      __webCodexRole: "system",
      __webCodexKind: "tool",
      __webCodexRawText: text,
      remove() {
        removed.push(text);
      },
    });
    const chatBox = {
      nodes: [],
      querySelectorAll(selector) {
        if (selector === '.msg.system.kind-tool[data-msg-transient="1"]') return this.nodes;
        return [];
      },
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
      activeThreadTransientToolText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat(role, text, options = {}) {
        added.push({ role, text, kind: options.kind || "", transient: options.transient === true });
        if (options.transient === true) chatBox.nodes = [transientNode(text)];
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.showTransientToolMessage("Ran `npm test`");
    state.activeThreadMessages = [{ role: "user", text: "hello", kind: "" }];
    module.showTransientToolMessage("Ran `npm test`");

    expect(added).toEqual([
      { role: "system", text: "Ran `npm test`", kind: "tool", transient: true },
    ]);
    expect(removed).toEqual([]);
  });

  it("reuses an existing live assistant node after live state pointers are cleared", () => {
    const appended = [];
    const created = [];
    const finalized = [];
    const makeBody = () => ({
      className: "msgBody",
      textContent: "",
    });
    const makeMsg = () => {
      const attrs = new Map();
      const body = makeBody();
      return {
        className: "msg assistant",
        body,
        setAttribute(name, value) {
          attrs.set(name, String(value));
        },
        getAttribute(name) {
          return attrs.get(name) || "";
        },
        removeAttribute(name) {
          attrs.delete(name);
        },
        querySelector(selector) {
          return selector === ".msgBody" ? body : null;
        },
      };
    };
    const chatBox = {
      nodes: [],
      appendChild(node) {
        this.nodes.push(node);
        this.lastElementChild = node;
      },
      querySelectorAll(selector) {
        if (selector === '.msg.assistant[data-live-assistant="1"]') {
          return this.nodes.filter(
            (node) =>
              node.className === "msg assistant" &&
              node.getAttribute("data-live-assistant") === "1"
          );
        }
        if (selector === ".msg.assistant") {
          return this.nodes.filter((node) => node.className === "msg assistant");
        }
        return [];
      },
      querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length ? all[0] : null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        const msg = makeMsg();
        const body = msg.body;
        created.push(msg);
        return { msg, body };
      },
      appendStreamingDelta(body, text) {
        appended.push(text);
        body.textContent = `${body.textContent || ""}${text}`;
      },
      finalizeAssistantMessage(msg, body, text) {
        finalized.push(text);
        body.textContent = text;
      },
    });

    module.renderLiveNotification({
      method: "item.updated",
      params: {
        item: {
          type: "agent_message_content_delta",
          thread_id: "thread-1",
          delta: "live",
        },
      },
    });

    state.activeThreadLiveAssistantThreadId = "";
    state.activeThreadLiveAssistantIndex = -1;
    state.activeThreadLiveAssistantMsgNode = null;
    state.activeThreadLiveAssistantBodyNode = null;

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          text: "live reply",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn.completed",
      params: { threadId: "thread-1" },
    });

    expect(created).toHaveLength(1);
    expect(chatBox.querySelectorAll(".msg.assistant")).toHaveLength(1);
    expect(appended).toEqual(["live", " reply"]);
    expect(finalized).toEqual(["live reply"]);
    expect(state.activeThreadMessages).toEqual([{ role: "assistant", text: "live reply", kind: "" }]);
  });

  it("flushes a queued turn after a terminal turn event", () => {
    const flushed = [];
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: null,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      flushQueuedTurn(threadId) {
        flushed.push(threadId);
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn.completed",
      params: { threadId: "thread-1" },
    });

    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(flushed).toEqual(["thread-1"]);
  });

  it("keeps pending placeholders after turn completion until history catches up", () => {
    const chatBox = {
      appendChild(node) {
        this.lastElementChild = node;
      },
      querySelector() {
        return null;
      },
      lastElementChild: null,
    };
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [{ role: "user", text: "hello", kind: "" }],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadLiveStateEpoch: 1,
      activeThreadLastFinalAssistantThreadId: "",
      activeThreadLastFinalAssistantText: "",
      activeThreadLastFinalAssistantAt: 0,
      activeThreadLastFinalAssistantEpoch: 0,
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {}, removeAttribute() {} }, body: { removeAttribute() {} } };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
    });

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" },
    });

    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
  });

  it("clears pending question state when a turn is cancelled", () => {
    const cleared = [];
    const clearedRealPending = [];
    const renders = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadMessages: [],
      activeThreadCommentaryCurrent: {
        threadId: "thread-1",
        key: "commentary-1",
        text: "thinking",
        tools: [],
        toolKeys: [],
        plan: null,
      },
      activeThreadCommentaryArchive: [{ key: "old", text: "old", tools: [], toolKeys: [], plan: null }],
      activeThreadCommentaryArchiveVisible: true,
      activeThreadCommentaryArchiveExpanded: true,
      activeThreadInlineCommentaryArchiveCount: 1,
      activeThreadTransientThinkingText: "thinking",
      activeThreadTransientToolText: "tool",
      activeThreadActivity: { threadId: "thread-1", title: "Thinking", detail: "", tone: "running" },
      activeThreadActiveCommands: [{ key: "cmd-1", state: "running", text: "npm test" }],
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "", steps: [] },
      activeThreadLiveStateEpoch: 2,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      addChat() {},
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderCommentaryArchive() {
        renders.push("commentary");
      },
      renderPendingInline() {
        renders.push("pending");
      },
      clearPendingUserInputs(options = {}) {
        clearedRealPending.push(options);
      },
      setSyntheticPendingUserInputs(threadId, items) {
        cleared.push({ threadId, items });
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/cancelled",
      params: { threadId: "thread-1" },
    });

    expect(cleared).toEqual([{ threadId: "thread-1", items: [] }]);
    expect(clearedRealPending).toEqual([{ threadId: "thread-1" }]);
    expect(renders).toEqual(["commentary", "pending"]);
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadCommentaryCurrent).toBeNull();
    expect(state.activeThreadCommentaryArchive).toEqual([]);
    expect(state.activeThreadCommentaryArchiveVisible).toBe(false);
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadTransientToolText).toBe("");
    expect(state.activeThreadActivity).toBeNull();
    expect(state.activeThreadActiveCommands).toEqual([]);
    expect(state.activeThreadPlan).toBeNull();
  });

  it("discards a partial live assistant message when a turn is cancelled", () => {
    const statuses = [];
    const removed = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [{ role: "assistant", text: "partial", kind: "" }],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "partial",
      activeThreadLiveAssistantThreadId: "thread-1",
      activeThreadLiveAssistantIndex: 0,
      activeThreadLiveAssistantMsgNode: { remove() { removed.push("msg"); } },
      activeThreadLiveAssistantBodyNode: {},
      activeThreadLiveAssistantText: "partial",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadLiveStateEpoch: 0,
    };
    const finalized = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return { msg: { setAttribute() {} }, body: {} };
      },
      finalizeAssistantMessage(_msg, _body, text) {
        finalized.push(text);
      },
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/cancelled",
      params: { threadId: "thread-1" },
    });

    expect(finalized).toEqual([]);
    expect(removed).toEqual(["msg"]);
    expect(state.activeThreadMessages).toEqual([]);
    expect(state.activeThreadLiveAssistantThreadId).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(statuses.at(-1)).toEqual({ message: "Turn cancelled.", isWarn: true });
  });

  it("suppresses stale running live updates after a local interrupt until terminal status arrives", () => {
    const statuses = [];
    const runtimeActivity = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      suppressedLiveInterruptByThreadId: { "thread-1": true },
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
    });

    module.renderLiveNotification({
      method: "item/updated",
      params: {
        threadId: "thread-1",
        item: {
          id: "commentary-1",
          type: "agent_message",
          thread_id: "thread-1",
          phase: "commentary",
          text: "still working",
          status: "running",
        },
      },
    });

    expect(statuses).toEqual([]);
    expect(runtimeActivity).toEqual([]);
    expect(state.activeThreadTransientThinkingText).toBe("");

    module.renderLiveNotification({
      method: "turn/cancelled",
      params: { threadId: "thread-1" },
    });

    expect(state.suppressedLiveInterruptByThreadId["thread-1"]).toBeUndefined();
    expect(statuses.at(-1)).toEqual({ message: "Turn cancelled.", isWarn: true });
  });

  it("shows reconnecting thread status in chat without ending the pending turn", () => {
    const statuses = [];
    const runtimeActivity = [];
    const finalizedRuntime = [];
    const chatMessages = [];
    const pendingRenders = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey() { return false; },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      renderPendingInline() {
        pendingRenders.push("pending");
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "Provider disconnected. Reconnecting... 1/5",
      },
    });
    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "Provider disconnected. Reconnecting... 2/5",
      },
    });

    expect(statuses.at(-1)).toEqual({
      message: "Reconnecting... 2/5",
      isWarn: false,
    });
    expect(chatMessages).toEqual([
      {
        role: "system",
        content: "Reconnecting... 1/5",
        options: {
          kind: "thinking",
          transient: false,
          animate: true,
          messageKey: "live-thread-connection-status",
        },
      },
      {
        role: "system",
        content: "Reconnecting... 2/5",
        options: {
          kind: "thinking",
          transient: false,
          animate: true,
          messageKey: "live-thread-connection-status",
        },
      },
    ]);
    expect(runtimeActivity).toEqual([]);
    expect(finalizedRuntime).toEqual([]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(pendingRenders).toEqual([]);
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_show_reconnect",
        __tracePersist: true,
        rendered: "Reconnecting... 1/5",
        attempt: "1/5",
        rawMessage: "Provider disconnected. Reconnecting... 1/5",
      }),
      expect.objectContaining({
        kind: "live.connection:thread_show_reconnect",
        __tracePersist: true,
        rendered: "Reconnecting... 2/5",
        attempt: "2/5",
        rawMessage: "Provider disconnected. Reconnecting... 2/5",
      }),
    ]));
  });

  it("treats turn/status reconnecting as official reconnect progress", () => {
    const statuses = [];
    const chatMessages = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey() { return false; },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/status",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "Reconnecting... 1/5",
      },
    });

    expect(statuses.at(-1)).toEqual({
      message: "Reconnecting... 1/5",
      isWarn: false,
    });
    expect(chatMessages.at(-1)).toEqual({
      role: "system",
      content: "Reconnecting... 1/5",
      options: {
        kind: "thinking",
        transient: false,
        animate: true,
        messageKey: "live-thread-connection-status",
      },
    });
    expect(state.activeThreadPendingTurnRunning).toBe(true);
  });

  it("keeps a live thread reconnect card through running turn lifecycle updates", () => {
    const chatMessages = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadTransientThinkingText: "",
      activeThreadTransientToolText: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "Provider disconnected. Reconnecting... 1/5",
      },
    });
    module.renderLiveNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "running",
        message: "Working...",
      },
    });

    expect(chatMessages[0]).toEqual(expect.objectContaining({
      content: "Reconnecting... 1/5",
    }));
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("reconnecting");
    expect(state.activeThreadConnectionStatusText).toBe("Reconnecting... 1/5");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.liveDebugEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_clear_reason",
      }),
    ]));
  });

  it("surfaces thread status failures as a final chat error and ends the pending turn", () => {
    const statuses = [];
    const runtimeActivity = [];
    const finalizedRuntime = [];
    const chatMessages = [];
    const pendingRenders = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "partial",
      activeThreadLiveAssistantThreadId: "",
      activeThreadTransientThinkingText: "thinking",
      activeThreadTransientToolText: "tool",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [{ key: "cmd-1", state: "running", text: "npm test" }],
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "", steps: [] },
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(key) {
        chatMessages.push({ role: "remove", content: key, options: null });
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      renderPendingInline() {
        pendingRenders.push("pending");
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "error",
        message: "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2",
      },
    });

    expect(statuses.at(-1)).toEqual({
      message: "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2",
      isWarn: true,
    });
    expect(chatMessages).toEqual([
      {
        role: "system",
        content: "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2",
        options: {
          kind: "error",
          transient: false,
          animate: true,
          messageKey: "live-thread-connection-status",
        },
      },
    ]);
    expect(finalizedRuntime).toEqual(["thread-1"]);
    expect(pendingRenders).toEqual(["pending"]);
    expect(runtimeActivity).toEqual([]);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(state.activeThreadTransientThinkingText).toBe("");
    expect(state.activeThreadTransientToolText).toBe("");
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_show_error",
        __tracePersist: true,
        rawMessage: "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2",
      }),
    ]));
  });

  it("shows reconnecting thread status in chat without ending the pending turn", () => {
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      wsSubscribedEvents: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey() {
        return false;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "Provider disconnected. Reconnecting... 2/5",
      },
    });

    expect(statuses.at(-1)).toEqual({
      message: "Reconnecting... 2/5",
      isWarn: false,
    });
  });

  it("does not let reconnecting status override a latched terminal error on the same thread", () => {
    const statuses = [];
    const chatMessages = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      wsSubscribedEvents: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey() {
        return false;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "no routable providers available; preferred=aigateway; tried=. Reconnecting... 1/5",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:suppress_reconnect_after_terminal_error",
        __tracePersist: true,
      }),
    ]));
  });

  it("shows a terminal error card for turn/completed notifications with failed status", () => {
    const statuses = [];
    const chatMessages = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      wsSubscribedEvents: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey() {
        return false;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(statuses.at(-1)).toEqual({
      message: "no routable providers available; preferred=aigateway; tried=",
      isWarn: true,
    });
    expect(chatMessages).toEqual([
      {
        role: "system",
        content: "no routable providers available; preferred=aigateway; tried=",
        options: {
          kind: "error",
          transient: false,
          animate: true,
          messageKey: "live-thread-connection-status",
        },
      },
    ]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
  });

  it("does not clear the live connection error for an empty thread status notification", () => {
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
      },
    });

    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(state.liveDebugEvents || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_clear_reason",
      }),
    ]));
  });

  it("does not clear the live connection error for object-shaped empty thread status", () => {
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        thread: { status: {} },
      },
    });

    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(state.liveDebugEvents || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_clear_reason",
      }),
    ]));
  });

  it("does not clear the live connection error for non-connection token usage updates", () => {
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: { total: { totalTokens: 42 } },
      },
    });

    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(state.liveDebugEvents || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_clear_reason",
      }),
    ]));
  });

  it("keeps the real connection error when a later systemError status has no message", () => {
    const chatMessages = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        thread: { status: { type: "systemError" } },
      },
    });

    expect(chatMessages).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available; preferred=aigateway; tried=");
    expect(state.liveDebugEvents || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        rawMessage: "Reconnecting failed.",
      }),
    ]));
  });

  it("does not replace a detailed connection error with a weaker repeated failure", () => {
    const chatMessages = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      renderPendingInline() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried=aigateway,aigateway2"
    );
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_skip_weaker_error",
        __tracePersist: true,
        rawMessage: "no routable providers available; preferred=aigateway; tried=",
      }),
    ]));
  });

  it("does not clear the live connection error for a terminal error notification", () => {
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "error",
      params: {
        threadId: "thread-1",
      },
    });

    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(state.liveDebugEvents || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:thread_clear_reason",
      }),
    ]));
  });

  it("clears the stale terminal connection error latch when a new turn starts on the same thread", () => {
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      wsSubscribedEvents: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.clearLiveThreadConnectionStatus("turn.send:new_turn");

    expect(removedKeys).toEqual(["live-thread-connection-status"]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(state.activeThreadTerminalConnectionErrorThreadId).toBe("");
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.connection:terminal_error_latch_clear",
        __tracePersist: true,
        threadId: "thread-1",
        reason: "turn.send:new_turn",
      }),
    ]));
  });

  it("does not rewrite terminal connection error status back to reconnecting for a later bare error", () => {
    const statuses = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      wsSubscribedEvents: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey() {
        return false;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "error",
      params: {
        threadId: "thread-1",
        error: {
          message: "Provider disconnected. Reconnecting... 1/5",
        },
      },
    });

    expect(statuses).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(state.liveDebugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.status:suppress_terminal_connection_error_echo",
        method: "error",
        message: "Reconnecting... 1/5",
      }),
    ]));
    expect(state.liveDebugEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "live.status",
        method: "error",
      }),
    ]));
  });

  it("does not clear the live connection error for failed turn completion", () => {
    const removedKeys = [];
    const finalizedRuntime = [];
    const flushed = [];
    const pendingRenders = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      wsSubscribedEvents: true,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(key) {
        removedKeys.push(key);
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      renderPendingInline() {
        pendingRenders.push("pending");
      },
      flushQueuedTurn(threadId) {
        flushed.push(threadId);
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        status: "failed",
      },
    });

    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available");
    expect(finalizedRuntime).toEqual(["thread-1"]);
    expect(state.activeThreadPendingTurnThreadId).toBe("");
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(pendingRenders).toEqual(["pending"]);
    expect(flushed).toEqual([]);
  });

  it("drops replayed failed thread status before websocket subscriptions are restored", () => {
    const statuses = [];
    const runtimeActivity = [];
    const finalizedRuntime = [];
    const chatMessages = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hello",
      activeThreadPendingAssistantMessage: "partial",
      activeThreadLiveAssistantThreadId: "",
      activeThreadTransientThinkingText: "thinking",
      activeThreadTransientToolText: "tool",
      activeThreadCommentaryCurrent: null,
      activeThreadCommentaryArchive: [],
      activeThreadCommentaryArchiveVisible: false,
      activeThreadCommentaryArchiveExpanded: false,
      activeThreadActiveCommands: [{ key: "cmd-1", state: "running", text: "npm test" }],
      activeThreadPlan: { threadId: "thread-1", title: "Updated Plan", explanation: "", steps: [] },
      wsSubscribedEvents: false,
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "error",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(statuses).toEqual([]);
    expect(runtimeActivity).toEqual([]);
    expect(chatMessages).toEqual([]);
    expect(finalizedRuntime).toEqual([]);
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-1");
    expect(state.activeThreadPendingUserMessage).toBe("hello");
    expect(state.activeThreadPendingAssistantMessage).toBe("partial");
  });

  it("drops dormant replayed turn lifecycle before websocket subscriptions are restored", () => {
    const statuses = [];
    const runtimeActivity = [];
    const finalizedRuntime = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadHistoryStatusType: "idle",
      wsSubscribedEvents: false,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity(payload) {
        runtimeActivity.push(payload);
      },
      finalizeRuntimeState(threadId) {
        finalizedRuntime.push(threadId);
      },
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-2",
      },
    });

    expect(statuses).toEqual([]);
    expect(runtimeActivity).toEqual([]);
    expect(finalizedRuntime).toEqual([]);
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingTurnId).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_replayed_turn_lifecycle" && event.method === "turn/started")
    ).toBe(true);
  });

  it("inserts the live assistant message before the pending inline card", () => {
    const children = [];
    const pendingMount = { id: "pendingInlineMount", parentElement: null };
    const chatBox = {
      children,
      appendChild(node) {
        children.push(node);
        node.parentElement = this;
        return node;
      },
      insertBefore(node, referenceNode) {
        const index = children.indexOf(referenceNode);
        if (index < 0) return this.appendChild(node);
        children.splice(index, 0, node);
        node.parentElement = this;
        return node;
      },
      querySelector(selector) {
        if (selector === "#pendingInlineMount") return pendingMount;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    chatBox.appendChild(pendingMount);
    const state = {
      activeThreadId: "thread-1",
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadLiveAssistantIndex: -1,
      activeThreadLiveAssistantMsgNode: null,
      activeThreadLiveAssistantBodyNode: null,
      activeThreadLiveAssistantText: "",
    };
    const module = createLiveNotificationsModule({
      state,
      byId(id) {
        return id === "chatBox" ? chatBox : null;
      },
      addChat() {},
      scheduleChatLiveFollow() {},
      hideWelcomeCard() {},
      createAssistantStreamingMessage() {
        return {
          msg: {
            setAttribute() {},
            removeAttribute() {},
            querySelector() {
              return {};
            },
          },
          body: {},
        };
      },
      appendStreamingDelta() {},
      finalizeAssistantMessage() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || notification?.params?.item?.thread_id || "");
      },
    });

    module.renderLiveNotification({
      method: "item.completed",
      params: {
        item: {
          type: "agent_message",
          thread_id: "thread-1",
          phase: "final_answer",
          text: "done",
        },
      },
    });

    expect(chatBox.children[0]).not.toBe(pendingMount);
    expect(chatBox.children[1]).toBe(pendingMount);
  });

  it("does not redraw the same failed thread status repeatedly", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: true,
      wsSubscribedEvents: true,
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText:
        "no routable providers available; preferred=aigateway; tried=",
    };
    const chatMessages = [];
    const statuses = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    const failedNotification = {
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    };

    module.renderLiveNotification(failedNotification);

    expect(chatMessages).toEqual([]);
    expect(statuses.at(-1)).toEqual({
      message: "no routable providers available; preferred=aigateway; tried=",
      isWarn: true,
    });
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available; preferred=aigateway; tried=");
  });

  it("keeps the terminal connection error latched across later terminal echoes", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: true,
      wsSubscribedEvents: true,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadMessages: [],
      liveDebugEvents: [],
    };
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "no routable providers available; preferred=aigateway; tried=. Reconnecting... 5/5",
      },
    });
    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });
    module.renderLiveNotification({
      method: "error",
      params: {
        threadId: "thread-1",
      },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "failed",
          message:
            "unexpected status 424 Failed Dependency: no routable providers available; preferred=aigateway; tried=, url: http://127.0.0.1:4000/v1/responses",
        },
      },
    });
    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
      },
    });
    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "completed",
      },
    });

    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available; preferred=aigateway; tried=");
    expect(statuses.at(-1)).toEqual({
      message: "no routable providers available; preferred=aigateway; tried=",
      isWarn: true,
    });
    expect(removedKeys).toEqual(["live-thread-connection-status"]);
  });

  it("drops replayed failed connection status for dormant terminal history threads without clearing the latched error", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "systemerror",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });

  it("keeps the current thread terminal connection error latched when the same failed status replays", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: true,
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "systemerror",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });

  it("drops replayed failed connection status even if a stale pending turn id lingers", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "failed",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "turn-stale",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadTerminalConnectionErrorThreadId: "thread-1",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });

  it("drops a stale failed replay from the previous connection cycle after a new send starts", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 7,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-new",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 7,
      activeThreadConnectionReplayGuardReconnectSeen: false,
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:pending_connection_terminal_replay")
    ).toBe(true);
  });

  it("accepts the new terminal failed status after reconnect progress has started", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 7,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-new",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 7,
      activeThreadConnectionReplayGuardReconnectSeen: false,
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "no routable providers available; preferred=aigateway; tried=. Reconnecting... 1/5",
      },
    });
    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(state.activeThreadConnectionReplayGuardReconnectSeen).toBe(true);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(statuses.some((entry) => entry.message === "Reconnecting... 1/5")).toBe(true);
    expect(statuses.some((entry) => entry.message === "no routable providers available; preferred=aigateway; tried=")).toBe(true);
    expect(chatMessages[chatMessages.length - 1]).toEqual(
      expect.objectContaining({
        role: "system",
        content: "no routable providers available; preferred=aigateway; tried=",
      })
    );
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnId).toBe("turn-new");
    expect(state.activeThreadPendingTurnRunning).toBe(false);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingAssistantMessage).toBe("");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(1);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(1);
  });

  it("drops a stale failed turn/completed replay from the previous connection cycle after a new send starts", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 7,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-new",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 7,
      activeThreadConnectionReplayGuardReconnectSeen: false,
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-old",
          status: "failed",
        },
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadPendingTurnThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.activeThreadPendingUserMessage).toBe("hi");
    expect(state.activeThreadPendingTurnBaselineTurnCount).toBe(1);
    expect(state.activeThreadPendingTurnBaselineUserCount).toBe(1);
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:stale_pending_turn_terminal_replay")
    ).toBe(true);
  });

  it("drops a stale failed thread status replay when it carries an older turn id than the current send", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 7,
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-new",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadPendingTurnBaselineTurnCount: 1,
      activeThreadPendingTurnBaselineUserCount: 1,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      liveDebugEvents: [],
      suppressedSyntheticPendingUserInputsByThreadId: {},
    };
    const statuses = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey() {
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        turnId: "turn-old",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(statuses).toEqual([]);
    expect(state.activeThreadPendingTurnRunning).toBe(true);
    expect(state.suppressedSyntheticPendingUserInputsByThreadId).toEqual({});
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:stale_pending_turn_terminal_replay")
    ).toBe(true);
  });

  it("drops a failed replay without clearing the current latched error even if activeThreadStarted is false", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: false,
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "failed",
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      liveDebugEvents: [],
    };
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus() {},
      setRuntimeActivity() {},
      addChat() {},
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(removedKeys).toEqual(["live-thread-connection-status"]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });

  it("drops failed connection replay while reopening a thread before history has loaded", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadOpenState: { threadId: "thread-1", loaded: false, resumeRequired: false },
      wsSubscribedEvents: true,
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "error",
      activeThreadConnectionStatusText: "no routable providers available; preferred=aigateway; tried=",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([{ message: "", isWarn: false }]);
    expect(removedKeys).toEqual(["live-thread-connection-status"]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:hydrating_thread_connection_replay")
    ).toBe(true);
  });

  it("drops failed replay after refresh even if the old reconnect replay guard still says reconnect seen", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: false,
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardEpoch: 4,
      activeThreadLiveStateEpoch: 4,
      activeThreadConnectionReplayGuardReconnectSeen: true,
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });

  it("drops reconnect replay while reopening a history-only thread before terminal history catches up", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: true,
      wsSubscribedEvents: true,
      activeThreadOpenState: { threadId: "thread-1", loaded: true, resumeRequired: false },
      activeThreadHistoryStatusType: "active",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "no routable providers available; preferred=aigateway; tried=. Reconnecting... 5/5",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_reconnect_replay")
    ).toBe(true);
  });

  it("drops failed turn replay while reopening a history-only thread before terminal history catches up", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: true,
      wsSubscribedEvents: true,
      activeThreadOpenState: { threadId: "thread-1", loaded: true, resumeRequired: false },
      activeThreadHistoryStatusType: "active",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          status: "failed",
          error: { message: "no routable providers available; preferred=aigateway; tried=" },
        },
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_turn_failure_replay")
    ).toBe(true);
  });

  it("drops reconnect replay after refresh when terminal history is already authoritative", () => {
    const state = {
      activeThreadId: "thread-1",
      activeThreadStarted: false,
      wsSubscribedEvents: true,
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi", kind: "" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardEpoch: 4,
      activeThreadLiveStateEpoch: 4,
      activeThreadConnectionReplayGuardReconnectSeen: true,
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "reconnecting",
        message: "no routable providers available; preferred=aigateway; tried=. Reconnecting... 1/5",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_reconnect_replay")
    ).toBe(true);
  });

  it("drops failed connection replay while the active thread is still hydrating history even without open-state metadata", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadHistoryThreadId: "",
      activeThreadHistoryTurns: [],
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:hydrating_thread_connection_replay")
    ).toBe(true);
  });

  it("drops a failed turn/completed replay while the active thread is still hydrating history", () => {
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadOpenState: { threadId: "thread-1", loaded: false, resumeRequired: false },
      activeThreadHistoryThreadId: "",
      activeThreadHistoryTurns: [],
      activeThreadMessages: [],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      liveDebugEvents: [],
    };
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          message: "no routable providers available; preferred=aigateway; tried=",
        },
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:hydrating_thread_connection_replay")
    ).toBe(true);
  });

  it("drops a failed turn/completed replay when authoritative failed history is already loaded", () => {
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [{ role: "user", text: "hi" }],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_turn_failure_replay")
    ).toBe(true);
  });

  it("keeps a delayed failed turn/completed as terminal when the current thread is still visibly reconnecting", () => {
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryTurns: [{ id: "turn-1" }],
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnId: "turn-2",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 5/5",
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([
      expect.objectContaining({
        role: "system",
        content: "no routable providers available; preferred=aigateway; tried=",
        options: expect.objectContaining({ kind: "error" }),
      }),
    ]);
    expect(statuses).toEqual([
      { message: "no routable providers available; preferred=aigateway; tried=", isWarn: true },
      { message: "no routable providers available; preferred=aigateway; tried=", isWarn: true },
    ]);
    expect(removedKeys).toEqual(["live-thread-connection-status"]);
    expect(state.activeThreadConnectionStatusKind).toBe("error");
    expect(state.activeThreadConnectionStatusText).toBe("no routable providers available; preferred=aigateway; tried=");
  });

  it("keeps a current-cycle failed turn/completed as terminal after reconnect was already seen", () => {
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 9,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryTurns: [{ id: "turn-old" }],
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 9,
      activeThreadConnectionReplayGuardReconnectSeen: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-2",
          status: "failed",
          message: "no routable providers available; preferred=aigateway; tried=",
        },
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_turn_failure_replay")
    ).toBe(true);
  });

  it("keeps a current-cycle failed thread status as terminal after reconnect was already seen", () => {
    const chatMessages = [];
    const statuses = [];
    const removedKeys = [];
    const state = {
      activeThreadId: "thread-1",
      wsSubscribedEvents: true,
      activeThreadLiveStateEpoch: 9,
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryStatusType: "failed",
      activeThreadHistoryTurns: [{ id: "turn-old" }],
      activeThreadMessages: [
        { role: "user", text: "hi", kind: "" },
        { role: "user", text: "hi", kind: "" },
      ],
      activeThreadPendingTurnThreadId: "",
      activeThreadPendingTurnId: "",
      activeThreadPendingTurnRunning: false,
      activeThreadPendingUserMessage: "",
      activeThreadPendingAssistantMessage: "",
      activeThreadLiveAssistantThreadId: "",
      activeThreadCommentaryCurrent: null,
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadConnectionStatusKind: "",
      activeThreadConnectionStatusText: "",
      activeThreadConnectionReplayGuardThreadId: "thread-1",
      activeThreadConnectionReplayGuardText: "no routable providers available; preferred=aigateway; tried=",
      activeThreadConnectionReplayGuardEpoch: 9,
      activeThreadConnectionReplayGuardReconnectSeen: true,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey(messageKey) {
        removedKeys.push(String(messageKey || ""));
        return true;
      },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(chatMessages).toEqual([]);
    expect(statuses).toEqual([]);
    expect(removedKeys).toEqual([]);
    expect(state.activeThreadConnectionStatusKind).toBe("");
    expect(state.activeThreadConnectionStatusText).toBe("");
    expect(
      state.liveDebugEvents.some((event) => event.kind === "live.drop:dormant_terminal_connection_replay")
    ).toBe(true);
  });
  it("defers terminal connection error until authoritative history also becomes terminal", () => {
    const statuses = [];
    const chatMessages = [];
    const state = {
      activeThreadId: "thread-1",
      activeThreadHistoryThreadId: "thread-1",
      activeThreadHistoryStatusType: "active",
      wsSubscribedEvents: true,
      activeThreadConnectionStatusKind: "reconnecting",
      activeThreadConnectionStatusText: "Reconnecting... 5/5",
      activeThreadPendingTurnThreadId: "thread-1",
      activeThreadPendingTurnRunning: true,
      activeThreadPendingUserMessage: "hi",
      activeThreadPendingAssistantMessage: "",
      activeThreadActiveCommands: [],
      activeThreadPlan: null,
      activeThreadCommentaryCurrent: null,
      liveDebugEvents: [],
    };
    const module = createLiveNotificationsModule({
      state,
      byId() { return null; },
      setStatus(message, isWarn = false) {
        statuses.push({ message, isWarn });
      },
      setRuntimeActivity() {},
      addChat(role, content, options) {
        chatMessages.push({ role, content, options });
      },
      removeChatMessageByKey() { return false; },
      scheduleChatLiveFollow() {},
      finalizeRuntimeState() {},
      normalizeType(value) {
        return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      },
      normalizeInline(value) { return value == null ? null : String(value); },
      normalizeMultiline(value) { return value == null ? null : String(value); },
      readNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : null; },
      toRecord(value) { return value && typeof value === "object" ? value : null; },
      toStructuredPreview(value) { return value == null ? null : String(value); },
      extractNotificationThreadId(notification) {
        return String(notification?.params?.threadId || "");
      },
    });

    module.renderLiveNotification({
      method: "thread/status/changed",
      params: {
        threadId: "thread-1",
        status: "failed",
        source: "gateway.no_routable_provider",
        message: "no routable providers available; preferred=aigateway; tried=",
      },
    });

    expect(state.activeThreadConnectionStatusKind).toBe("reconnecting");
    expect(state.activeThreadPendingTerminalConnectionErrorThreadId).toBe("thread-1");
    expect(state.activeThreadPendingTerminalConnectionErrorText).toBe(
      "no routable providers available; preferred=aigateway; tried="
    );
    expect(statuses).toEqual([]);
    expect(chatMessages).toEqual([]);
  });
});
