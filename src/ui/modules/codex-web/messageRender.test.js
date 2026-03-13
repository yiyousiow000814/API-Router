import { describe, expect, it } from "vitest";

import {
  fileRefDisplayLabel,
  findNextInlineCodeSpan,
  looksLikeFileRef,
  renderInlineMessageText,
  renderMessageAttachments,
  renderMessageBody,
  renderMessageRichHtml,
  renderToolSummaryHtml,
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

  it("stops plain http links before adjacent chinese punctuation and text", () => {
    const html = renderInlineMessageText(
      "你去开http://127.0.0.1:5173/codex-web?debuglive=1，然后开目前的sessions"
    );
    expect(html).toContain(
      '<a class="msgLink" href="http://127.0.0.1:5173/codex-web?debuglive=1"'
    );
    expect(html).toContain(
      ">http://127.0.0.1:5173/codex-web?debuglive=1</a>，然后开目前的sessions"
    );
  });

  it("keeps inline command snippets as code when they only contain a trailing file path", () => {
    const command = "- npm test -- --run src/ui/utils/providerCardRenderer.test.tsx";
    expect(looksLikeFileRef(command)).toBe(false);
    expect(renderInlineMessageText(`\`${command}\``)).toBe(
      `<code class="msgInlineCode">${command}</code>`
    );
    expect(renderMessageRichHtml(`- \`${command}\``)).toContain(
      `<li class="msgListItem depth-0" data-list-marker="-"><code class="msgInlineCode">${command}</code></li>`
    );
  });

  it("renders tool command summaries as a single-line tool block instead of a markdown list", () => {
    const command = "Running `cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib`";
    const html = renderToolSummaryHtml(command);
    expect(html).toContain('class="msgToolLine state-running icon-command mono"');
    expect(html).toContain('<code class="msgInlineCode">cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib</code>');
    expect(html).not.toContain("<ul>");
    expect(renderMessageBody("system", command, { kind: "tool" })).toContain('msgToolLine');
  });

  it("summarizes multiline tool commands instead of dumping the full payload", () => {
    const command = "Ran `@'\nimport { x } from \"./file.js\";\nconsole.log(x);\n'@ | node --input-type=module`";
    const html = renderToolSummaryHtml(command);
    expect(html).toContain('<code class="msgInlineCode">import { x } from &quot;./file.js&quot;;</code>');
    expect(html).toContain('</code> <span class="msgToolMore">+3 lines</span>');
    expect(html).toContain("msgToolMore");
    expect(html).toContain("+3 lines");
  });

  it("renders apply_patch summaries with colored diff counts", () => {
    const html = renderToolSummaryHtml("Edited 2 files (+2 -0)");
    expect(html).toContain('class="msgToolLine state-complete icon-patch"');
    expect(html).toContain("Edited 2 files");
    expect(html).toContain('class="msgToolDiffAdd">+2</span>');
    expect(html).toContain('class="msgToolDiffDel">-0</span>');
  });

  it("renders searched web summaries with the search icon", () => {
    const html = renderToolSummaryHtml("Searched web for `openai codex previous messages animation final message divider`");
    expect(html).toContain('class="msgToolLine state-complete icon-search"');
    expect(html).toContain("<code class=\"msgInlineCode\">openai codex previous messages animation final message divider</code>");
  });

  it("unescapes escaped backticks in plain tool-like sentences", () => {
    const html = renderInlineMessageText("runtime tool 卡片不再靠解析 Running \\`...\\` 这种 markdown 文本来反推命令");
    expect(html).toContain("Running `...`");
    expect(html).not.toContain("\\`");
  });

  it("renders nested list blocks without flattening numbering", () => {
    const html = renderMessageRichHtml(["1. top", "  - child", "2. next"].join("\n"));
    expect(html).toContain("<ol>");
    expect(html).toContain("<ul>");
    expect(html).toContain('msgListItem depth-1');
  });

  it("does not create a phantom outer ordered item for indented top-level numbering", () => {
    const html = renderMessageRichHtml(
      [
        "可以， build exe后 然后顺便修正你说的问题",
        "",
        "  1. 去掉/修正 request_user_input/list 这组无效请求",
        "  2. 继续沿着新日志抓 socket_read_error 的真实断链原因",
      ].join("\n")
    );
    expect((html.match(/<ol>/g) || []).length).toBe(1);
    expect(html).not.toContain('<li class="msgListItem depth-0"><ol>');
    expect(html).toContain("去掉/修正 request_user_input/list 这组无效请求");
    expect(html).toContain("继续沿着新日志抓 socket_read_error 的真实断链原因");
  });

  it("keeps ordered list numbering across blank lines between items", () => {
    const html = renderMessageRichHtml(
      [
        "1. first",
        "",
        "2. second",
        "",
        "3. third",
      ].join("\n")
    );
    expect((html.match(/<ol>/g) || []).length).toBe(1);
    expect((html.match(/msgListItem depth-0/g) || []).length).toBe(3);
    expect(html).toContain(">first<");
    expect(html).toContain(">second<");
    expect(html).toContain(">third<");
    expect(html).toContain('data-list-marker="1."');
    expect(html).toContain('data-list-marker="2."');
    expect(html).toContain('data-list-marker="3."');
    expect(html).toContain('has-gap-before');
    expect(html).toContain('margin-top:10px');
  });

  it("preserves the user's explicit ordered markers instead of recomputing them", () => {
    const html = renderMessageRichHtml(
      [
        "1. first",
        "",
        "4. fourth",
        "",
        "9. ninth",
      ].join("\n")
    );

    expect((html.match(/data-list-marker=/g) || []).length).toBe(3);
    expect(html).toContain('data-list-marker="1."');
    expect(html).toContain('data-list-marker="4."');
    expect(html).toContain('data-list-marker="9."');
    expect(html).toContain('has-gap-before');
  });

  it("renders non-chat roles as escaped paragraphs", () => {
    expect(renderMessageBody("tool", "<x>\nline 2")).toBe("<p>&lt;x&gt;<br>line 2</p>");
  });

  it("preserves explicit blank lines between paragraphs", () => {
    const html = renderMessageRichHtml(
      [
        "第一段第一行",
        "第一段第二行",
        "",
        "第二段",
        "",
        "",
        "第三段",
      ].join("\n")
    );

    expect(html).toContain("<p>第一段第一行<br>第一段第二行</p>");
    expect((html.match(/msgBlankLine/g) || []).length).toBe(3);
    expect(html).toContain("<p>第二段</p>");
    expect(html).toContain("<p>第三段</p>");
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
