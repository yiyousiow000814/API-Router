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
});
