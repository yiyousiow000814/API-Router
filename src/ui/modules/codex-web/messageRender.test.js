import { describe, expect, it } from "vitest";

import {
  fileRefDisplayLabel,
  findNextInlineCodeSpan,
  looksLikeFileRef,
  renderInlineMessageText,
  renderMessageAttachments,
  renderMessageBody,
  renderMessageRichHtml,
} from "./messageRender.js";

describe("messageRender", () => {
  it("detects file refs and shortens display labels", () => {
    expect(looksLikeFileRef("src/ui/codex-web-dev.js:1714")).toBe(true);
    expect(looksLikeFileRef("https://example.com/docs")).toBe(false);
    expect(fileRefDisplayLabel("src/ui/codex-web-dev.js:1714")).toBe("codex-web-dev.js:1714");
  });

  it("keeps escaped backticks literal and only parses real inline code fences", () => {
    expect(findNextInlineCodeSpan(String.raw`\`src/ui/codex-web-dev.js:1714\``)).toBeNull();
    expect(findNextInlineCodeSpan("use `src/ui/codex-web-dev.js:1714` here")).toEqual({
      start: 4,
      end: 34,
      fenceLen: 1,
      content: "src/ui/codex-web-dev.js:1714",
    });
  });

  it("renders inline code file refs as pseudo-links with shortened labels", () => {
    expect(renderInlineMessageText("例如 `src/ui/codex-web-dev.js:1714`")).toContain(
      '<span class="msgPseudoLink">codex-web-dev.js:1714</span>'
    );
    expect(renderInlineMessageText("打开 https://example.com/docs")).toContain(
      '<a class="msgLink" href="https://example.com/docs"'
    );
  });

  it("keeps inline command snippets as code when they only contain a trailing file path", () => {
    const command = "- npm test -- --run src/ui/utils/providerCardRenderer.test.tsx";
    expect(looksLikeFileRef(command)).toBe(false);
    expect(renderInlineMessageText(`\`${command}\``)).toBe(
      `<code class="msgInlineCode">${command}</code>`
    );
    expect(renderMessageRichHtml(`- \`${command}\``)).toContain(
      `<li class="msgListItem depth-0"><code class="msgInlineCode">${command}</code></li>`
    );
  });

  it("renders nested list blocks without flattening numbering", () => {
    const html = renderMessageRichHtml(["1. top", "  - child", "2. next"].join("\n"));
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
    expect(html).toContain('msgListItem depth-1');
  });

  it("renders non-chat roles as escaped paragraphs", () => {
    expect(renderMessageBody("tool", "<x>\nline 2")).toBe("<p>&lt;x&gt;<br>line 2</p>");
  });

  it("renders compact attachment mosaics and overflow overlay", () => {
    const html = renderMessageAttachments([
      { src: "https://example.com/1.png", label: "Image #1" },
      { src: "https://example.com/2.png", label: "Image #2" },
      { src: "https://example.com/3.png", label: "Image #3" },
      { src: "https://example.com/4.png", label: "Image #4" },
      { src: "https://example.com/5.png", label: "Image #5" },
    ]);
    expect(html).toContain('class="msgAttachments mosaic"');
    expect(html).toContain(">+1</div>");
    expect(html).toContain(">#1</div>");
  });
});
