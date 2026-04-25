import { describe, expect, it } from "vitest";

import {
  isBootstrapAgentsPrompt,
  normalizeDisplayedAssistantText,
  normalizeTextPayload,
  parseUserMessageParts,
  stripCodexImageBlocks,
  toolItemToMessage,
  normalizeThreadItemText,
} from "./messageData.js";

describe("messageData", () => {
  it("normalizes text payloads from common fields", () => {
    expect(normalizeTextPayload({ output_text: "hello" })).toBe("hello");
    expect(normalizeTextPayload({ text: "world" })).toBe("world");
  });

  it("strips standalone image markers", () => {
    expect(stripCodexImageBlocks("hello\n<image name=[Image #1]></image>\nworld")).toBe(
      "hello\n[Image #1]\nworld"
    );
  });

  it("parses user message parts into text and images", () => {
    const parsed = parseUserMessageParts({
      content: [
        { type: "input_text", text: "hello" },
        { type: "input_image", image_url: "https://example.com/a.png", name: "A" },
      ],
    });
    expect(parsed.text).toBe("hello");
    expect(parsed.images).toEqual([
      { src: "https://example.com/a.png", label: "Image #1", kind: "url" },
    ]);
  });

  it("preserves intentional blank lines in user text parts", () => {
    const parsed = parseUserMessageParts({
      content: [
        { type: "input_text", text: "line 1\n\nline 2" },
      ],
    });
    expect(parsed.text).toBe("line 1\n\nline 2");
  });

  it("displays only the typed request from Codex review context wrappers", () => {
    const parsed = parseUserMessageParts({
      content: [
        {
          type: "input_text",
          text: `# Review findings:

## Finding 1 (src-tauri/src/orchestrator/store.rs:1054-1075) [added]
[P3] Startup compaction reruns every open

compact_runtime_listener_skip_events runs on every Store::open.

## My request for Codex:
推送最新的上去，然后build exe`,
        },
      ],
    });
    expect(parsed.text).toBe("推送最新的上去，然后build exe");
  });

  it("displays only the typed request from Codex selected-text wrappers", () => {
    const parsed = parseUserMessageParts({
      content: [
        {
          type: "input_text",
          text: `# Selected text:

## Selection 1
cli: 295 条
vscode: 150 条

## My request for Codex:
这里就能分辨哪一些应该被隐藏了`,
        },
      ],
    });
    expect(parsed.text).toBe("这里就能分辨哪一些应该被隐藏了");
  });

  it("strips Codex desktop git directives from assistant display text", () => {
    expect(
      normalizeDisplayedAssistantText(`已推送到 fix/thread-source-allowlist。

::git-stage{cwd="C:\\Users\\yiyou\\API-Router"}
::git-commit{cwd="C:\\Users\\yiyou\\API-Router"}
::git-push{cwd="C:\\Users\\yiyou\\API-Router" branch="fix/thread-source-allowlist"}`)
    ).toBe("已推送到 fix/thread-source-allowlist。");
  });

  it("strips Codex desktop git directives from thread assistant items", () => {
    expect(
      normalizeThreadItemText({
        type: "assistantMessage",
        text: `完成
::git-stage{cwd="C:\\Users\\yiyou\\API-Router"}`,
      })
    ).toBe("完成");
  });

  it("detects bootstrap prompts", () => {
    expect(
      isBootstrapAgentsPrompt("# AGENTS.md instructions for repo\n<INSTRUCTIONS>Agent Defaults</INSTRUCTIONS>")
    ).toBe(true);
    expect(isBootstrapAgentsPrompt("hello world")).toBe(false);
  });

  it("summarizes apply_patch results as edited files in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "apply_patch",
          status: "completed",
          result: "Success. Updated the following files:\nM src/ui/modules/codex-web/chatTimeline.js",
        },
        { compact: true }
      )
    ).toBe("Edited `src/ui/modules/codex-web/chatTimeline.js`");
  });

  it("summarizes apply_patch arguments with file and diff counts in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "apply_patch",
          status: "completed",
          arguments: `*** Begin Patch
*** Update File: src/ui/modules/codex-web/chatTimeline.test.js
@@
-expect(oldValue).toBe(true);
+expect(oldValue).toBe(false);
+expect(nextValue).toBe(true);
*** End Patch`,
        },
        { compact: true }
      )
    ).toBe("Edited `src/ui/modules/codex-web/chatTimeline.test.js` (+2 -1)");
  });

  it("shortens absolute apply_patch argument paths to project-relative display paths", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "apply_patch",
          status: "completed",
          arguments: `*** Begin Patch
*** Update File: C:\\Users\\yiyou\\API-Router\\src\\ui\\modules\\codex-web\\messageRender.test.js
@@
-expect(oldValue).toBe(true);
+expect(oldValue).toBe(false);
*** End Patch`,
        },
        { compact: true }
      )
    ).toBe("Edited `src\\ui\\modules\\codex-web\\messageRender.test.js` (+1 -1)");
  });

  it("shortens absolute apply_patch result paths to project-relative display paths", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "apply_patch",
          status: "completed",
          result: "Success. Updated the following files:\nM C:\\Users\\yiyou\\API-Router\\src\\ui\\modules\\codex-web\\chatTimeline.js",
        },
        { compact: true }
      )
    ).toBe("Edited `src\\ui\\modules\\codex-web\\chatTimeline.js`");
  });

  it("summarizes multi-file apply_patch edits with aggregate diff counts", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "apply_patch",
          status: "completed",
          arguments: `*** Begin Patch
*** Update File: src/ui/modules/codex-web/composition.js
@@
+renderCommentaryArchive: chatTimeline.renderCommentaryArchive,
*** Update File: src/ui/modules/codex-web/debugTools.js
@@
+renderCommentaryArchive = () => {},
*** End Patch`,
        },
        { compact: true }
      )
    ).toBe("Edited 2 files (+2 -0)");
  });

  it("formats compact web search summaries with an explicit searched prefix", () => {
    expect(
      toolItemToMessage(
        {
          type: "webSearch",
          query: "openai codex previous messages animation final message divider",
        },
        { compact: true }
      )
    ).toBe("Searched web for `openai codex previous messages animation final message divider`");
  });

  it("formats running web search summaries with an explicit searching prefix", () => {
    expect(
      toolItemToMessage(
        {
          type: "webSearch",
          query: "openai codex",
          status: "running",
        },
        { compact: true }
      )
    ).toBe("Searching web for `openai codex`");
  });

  it("formats failed web search summaries with an explicit failure prefix", () => {
    expect(
      toolItemToMessage(
        {
          type: "webSearch",
          query: "openai codex",
          status: "failed",
        },
        { compact: true }
      )
    ).toBe("Web search failed for `openai codex`");
  });

  it("formats running and failed web search summaries with status-aware prefixes", () => {
    expect(
      toolItemToMessage(
        {
          type: "webSearch",
          query: "codex web running search state",
          status: "running",
        },
        { compact: true }
      )
    ).toBe("Searching web for `codex web running search state`");

    expect(
      toolItemToMessage(
        {
          type: "webSearch",
          query: "codex web failed search state",
          status: "failed",
        },
        { compact: true }
      )
    ).toBe("Web search failed for `codex web failed search state`");
  });

  it("formats file change summaries with running and failed statuses", () => {
    expect(
      toolItemToMessage(
        {
          type: "fileChange",
          status: "running",
        },
        { compact: true }
      )
    ).toBe("Applying file changes");

    expect(
      toolItemToMessage(
        {
          type: "fileChange",
          status: "failed",
        },
        { compact: true }
      )
    ).toBe("File changes failed");
  });

  it("formats context compaction summaries without a leading bullet", () => {
    expect(
      toolItemToMessage(
        {
          type: "context_compaction",
        },
        { compact: true }
      )
    ).toBe("Compacted conversation context");
  });

  it("treats exec_command as a command execution in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "exec_command",
          status: "completed",
          arguments: JSON.stringify({
            cmd: "bash -lc 'ls -la'",
            workdir: "/home/yiyou/project",
          }),
        },
        { compact: true }
      )
    ).toBe("Ran `bash -lc 'ls -la'`");
  });

  it("unwraps wrapped shell_command arrays back to the inner command in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "shell_command",
          status: "completed",
          arguments: JSON.stringify({
            command: [
              "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-Command",
              "git rev-parse HEAD; git branch --show-current",
            ],
          }),
        },
        { compact: true }
      )
    ).toBe("Ran `git rev-parse HEAD; git branch --show-current`");
  });

  it("unwraps wrapped shell_command strings back to the inner command in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "shell_command",
          status: "completed",
          arguments: JSON.stringify({
            command: "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'git status --short'",
          }),
        },
        { compact: true }
      )
    ).toBe("Ran `git status --short`");
  });

  it("keeps command executions running for item updates without an explicit status", () => {
    expect(
      toolItemToMessage(
        {
          type: "commandExecution",
          command: "Get-ChildItem -Recurse -Filter *.js",
        },
        { compact: true, method: "item/updated" }
      )
    ).toBe("Running `Get-ChildItem -Recurse -Filter *.js`");
  });

  it("does not mark successful command output as failed just because the output mentions failure words", () => {
    expect(
      toolItemToMessage(
        {
          type: "commandExecution",
      command: "Get-Content tests/ui/e2e/codex-web/send-turn-live.mjs",
          status: "completed",
          output: "const note = \"command failed\";",
          exitCode: 0,
        },
        { compact: true }
      )
    ).toBe("Ran `Get-Content tests/ui/e2e/codex-web/send-turn-live.mjs`");
  });

  it("summarizes tail-based file reads as a read action in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "shell_command",
          status: "completed",
          arguments: JSON.stringify({
            command: "tail -n 120 /tmp/selflearn_fullsuite_15-03-2026.log | sed -n '1,120p'",
          }),
        },
        { compact: true }
      )
    ).toBe("Read `selflearn_fullsuite_15-03-2026.log`");
  });

  it("hides passive write_stdin polling in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "write_stdin",
          status: "completed",
          arguments: JSON.stringify({
            session_id: 71512,
            chars: "",
            yield_time_ms: 30000,
            max_output_tokens: 12000,
          }),
        },
        { compact: true }
      )
    ).toBeNull();
  });

  it("formats send_input as a dedicated agent action in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "send_input",
          status: "completed",
          arguments: JSON.stringify({
            id: "019cc194-bd95-7262-84c2-fc1ddf0967bb",
            interrupt: true,
            message: "continue",
          }),
          result: JSON.stringify({
            submission_id: "019cc23a-35a1-7350-845c-e8a390a31ec6",
          }),
        },
        { compact: true }
      )
    ).toBe("Sent input to agent");
  });

  it("formats spawn_agent success with the spawned nickname in compact mode", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "spawn_agent",
          status: "completed",
          result: JSON.stringify({
            agent_id: "019cc52a-c146-7ba3-9778-37bbddd0a8d1",
            nickname: "Kierkegaard",
          }),
        },
        { compact: true }
      )
    ).toBe("Spawned agent Kierkegaard");
  });

  it("maps text-only spawn_agent failures into a failed compact summary", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "spawn_agent",
          status: "completed",
          output: "collab spawn failed: agent thread limit reached (max 10)",
        },
        { compact: true }
      )
    ).toBe("Agent spawn failed");
  });

  it("maps structured send_input failures into a failed compact summary", () => {
    expect(
      toolItemToMessage(
        {
          type: "toolCall",
          tool: "send_input",
          status: "completed",
          output: JSON.stringify({
            status: "failed",
            error: "agent is closed",
          }),
        },
        { compact: true }
      )
    ).toBe("Failed to send input to agent");
  });
});
