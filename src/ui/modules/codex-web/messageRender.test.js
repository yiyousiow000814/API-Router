import { describe, expect, it } from "vitest";

import {
  fileRefDisplayLabel,
  findNextInlineCodeSpan,
  looksLikeFileRef,
  looksLikePathRef,
  renderInlineMessageText,
  renderMessageAttachments,
  renderMessageBody,
  renderMessageRichHtml,
  renderStructuredToolPreviewHtml,
  renderToolSummaryHtml,
} from "./messageRender.js";

describe("messageRender", () => {
  it("detects file refs and shortens display labels", () => {
    expect(looksLikeFileRef("src/ui/codex-web-dev.js:1714")).toBe(true);
    expect(looksLikePathRef("src/ui/codex-web-dev.js:1714")).toBe(true);
    expect(looksLikePathRef("codex-web-dev.js:1714")).toBe(false);
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

  it("renders inline code paths as pseudo-links and bare file refs as code", () => {
    expect(renderInlineMessageText("例如 `src/ui/codex-web-dev.js:1714`")).toContain(
      '<span class="msgPseudoLink">codex-web-dev.js:1714</span>'
    );
    expect(renderInlineMessageText("例如 `codex-web-dev.js:1714`")).toContain(
      '<code class="msgInlineCode">codex-web-dev.js:1714</code>'
    );
    expect(renderInlineMessageText("打开 https://example.com/docs")).toContain(
      '<a class="msgLink" href="https://example.com/docs"'
    );
  });

  it("does not render Codex desktop git directives in assistant messages", () => {
    const html = renderMessageBody(
      "assistant",
      `已推送
::git-stage{cwd="C:\\Users\\yiyou\\API-Router"}
::git-commit{cwd="C:\\Users\\yiyou\\API-Router"}
::git-push{cwd="C:\\Users\\yiyou\\API-Router" branch="fix/thread-source-allowlist"}`
    );
    expect(html).toContain("已推送");
    expect(html).not.toContain("git-stage");
    expect(html).not.toContain("git-commit");
    expect(html).not.toContain("git-push");
  });

  it("renders Codex code-comment directives as review finding cards", () => {
    const html = renderMessageBody(
      "assistant",
      `Findings
::code-comment{title="[P2] String subagent sources still leak" body="notification_is_subagent only returns true when subagent/subAgent is an object." file="C:/Users/yiyou/API-Router/src-tauri/src/orchestrator/gateway/web_codex_threads/mod.rs" start=554 end=558 priority=2 confidence=0.88}

Checked`
    );
    expect(html).toContain("msgCodeCommentCard");
    expect(html).toContain("msgCodeCommentPriority");
    expect(html).toContain("P2");
    expect(html).toContain("String subagent sources still leak");
    expect(html).toContain("notification_is_subagent only returns true");
    expect(html).toContain("mod.rs:554-558");
    expect(html).not.toContain("::code-comment");
    expect(html).toContain("<p>Findings</p>");
    expect(html).toContain("<p>Checked</p>");
  });

  it("keeps explicit markdown link labels instead of replacing them with href file names", () => {
    expect(
      renderInlineMessageText(
        "[mergePendingLiveMessages](C:/Users/yiyou/API-Router/src/ui/modules/codex-web/historyLoader.js#L263)"
      )
    ).toContain('<code class="msgInlineCode">mergePendingLiveMessages</code>');
    expect(
      renderInlineMessageText(
        "[historyLoader.test.js:307](C:/Users/yiyou/API-Router/src/ui/modules/codex-web/historyLoader.test.js#L307)"
      )
    ).toContain('<span class="msgPseudoLink">historyLoader.test.js:307</span>');
  });

  it("renders markdown file links whose labels are wrapped in inline code", () => {
    expect(
      renderInlineMessageText(
        "[`messageRender.js`](C:/Users/yiyou/API-Router/src/ui/modules/codex-web/messageRender.js#L112)"
      )
    ).toContain('<span class="msgPseudoLink">messageRender.js:112</span>');
    expect(
      renderInlineMessageText(
        "[`mergePendingLiveMessages`](C:/Users/yiyou/API-Router/src/ui/modules/codex-web/historyLoader.js#L263)"
      )
    ).toContain('<code class="msgInlineCode">mergePendingLiveMessages</code>');
  });

  it("does not auto-link bare file-like tokens inside normal prose", () => {
    const html = renderInlineMessageText(
      "这里举例 messageRender.js:112、historyLoader.test.js:307 和 mergePendingLiveMessages，不应该自动变成路径样式。"
    );
    expect(html).toContain("messageRender.js:112");
    expect(html).toContain("historyLoader.test.js:307");
    expect(html).toContain("mergePendingLiveMessages");
    expect(html).not.toContain("msgPseudoLink");
  });

  it("auto-links plain path-like tokens but not bare file names", () => {
    const html = renderInlineMessageText(
      "看 src/ui/modules/codex-web/messageRender.test.js 和 messageRender.test.js。"
    );
    expect(html).toContain('<span class="msgPseudoLink">messageRender.test.js</span>');
    expect(html).toContain(" 和 messageRender.test.js。");
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
    expect(html).toContain("Running ");
    expect(html).toContain('<code class="msgInlineCode">cargo test --manifest-path src-tauri/Cargo.toml web_codex_history --lib</code>');
    expect(html).not.toContain("<ul>");
    expect(renderMessageBody("system", command, { kind: "tool" })).toContain('msgToolLine');
  });

  it("summarizes multiline tool commands instead of dumping the full payload", () => {
    const command = "Ran `@'\nimport { x } from \"./file.js\";\nconsole.log(x);\n'@ | node --input-type=module`";
    const html = renderToolSummaryHtml(command);
    expect(html).toContain("Ran ");
    expect(html).toContain('<code class="msgInlineCode">import { x } from &quot;./file.js&quot;;</code>');
    expect(html).toContain('</code> <span class="msgToolMore">+3 lines</span>');
    expect(html).toContain("msgToolMore");
    expect(html).toContain("+3 lines");
  });

  it("renders apply_patch summaries with colored diff counts", () => {
    const html = renderToolSummaryHtml("Edited 2 files (+2 -0)");
    expect(html).toContain('class="msgToolLine state-complete icon-patch"');
    expect(html).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(html).toContain(">2 files</span>");
    expect(html).toContain('class="msgToolDiffAdd">+2</span>');
    expect(html).toContain('class="msgToolDiffDel">-0</span>');
  });

  it("renders single-file apply_patch summaries with a plain prefix and coded path", () => {
    const html = renderToolSummaryHtml("Edited `src/ui/modules/codex-web/composerUi.js` (+42 -0)");
    expect(html).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(html).toContain('<code class="msgInlineCode">src/ui/modules/codex-web/composerUi.js</code>');
    expect(html).toContain('class="msgToolDiffAdd">+42</span>');
    expect(html).toContain('class="msgToolDiffDel">-0</span>');
  });

  it("renders searched web summaries with the search icon", () => {
    const html = renderToolSummaryHtml("Searched web for `openai codex previous messages animation final message divider`");
    expect(html).toContain('class="msgToolLine state-complete icon-search mono"');
    expect(html).toContain("<code class=\"msgInlineCode\">openai codex previous messages animation final message divider</code>");
  });

  it("renders spawned agent summaries with the agent icon", () => {
    const html = renderToolSummaryHtml("Spawned agent Kierkegaard");
    expect(html).toContain('class="msgToolLine state-complete icon-agent"');
    expect(html).toContain("Spawned agent Kierkegaard");
  });

  it("renders failed agent actions with the agent error state", () => {
    const html = renderToolSummaryHtml("Agent spawn failed");
    expect(html).toContain('class="msgToolLine state-error icon-agent"');
    expect(html).toContain("Agent spawn failed");
  });

  it("renders read summaries with the read prefix intact", () => {
    const html = renderToolSummaryHtml("Read `selflearn_fullsuite_15-03-2026.log`");
    expect(html).toContain('class="msgToolLine state-complete icon-tool mono"');
    expect(html).toContain("Read ");
    expect(html).toContain('<code class="msgInlineCode">selflearn_fullsuite_15-03-2026.log</code>');
  });

  it("renders structured tool previews with a plain prefix and coded detail", () => {
    const html = renderStructuredToolPreviewHtml("Ran `git status --short`", {
      className: "runtimeToolItemPreview",
      moreClassName: "runtimeToolItemMeta",
    });
    expect(html).toContain('<span class="msgToolPrefix">Ran </span>');
    expect(html).toContain('<code class="msgInlineCode">git status --short</code>');
  });

  it("renders edited tool previews with a plain prefix and coded path", () => {
    const html = renderStructuredToolPreviewHtml("Edited `src/ui/modules/codex-web/composerUi.js` (+42 -0)", {
      className: "runtimeToolItemPreview",
      moreClassName: "runtimeToolItemMeta",
      diffPrefix: "runtimeToolItem",
    });
    expect(html).toContain('<span class="msgToolPrefix">Edited </span>');
    expect(html).toContain('<code class="msgInlineCode">src/ui/modules/codex-web/composerUi.js</code>');
    expect(html).toContain('class="runtimeToolItemDiffAdd">+42</span>');
    expect(html).toContain('class="runtimeToolItemDiffDel">-0</span>');
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

  it("renders markdown headings as real heading tags instead of plain paragraphs", () => {
    const html = renderMessageRichHtml(
      [
        "## Summary",
        "Keep the plan card readable.",
        "",
        "### Assumptions",
        "- The turn is awaiting confirmation.",
      ].join("\n")
    );
    expect(html).toContain("<h2>Summary</h2>");
    expect(html).toContain("<h3>Assumptions</h3>");
    expect(html).toContain("<p>Keep the plan card readable.</p>");
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
