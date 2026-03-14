import { describe, expect, it } from "vitest";

import {
  isBootstrapAgentsPrompt,
  normalizeTextPayload,
  parseUserMessageParts,
  stripCodexImageBlocks,
  toolItemToMessage,
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
