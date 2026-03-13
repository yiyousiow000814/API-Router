export function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

const FILE_REF_SEGMENT_PATTERN = String.raw`(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}`;
const FILE_REF_PREFIX_PATTERN = String.raw`(?:%[A-Za-z0-9_]+%|[A-Za-z]:|\\\\[^\\\s]+|\.{1,2}|~|\/)`;
const FILE_REF_WHOLE_PATTERN = new RegExp(
  String.raw`^(?:(?:${FILE_REF_PREFIX_PATTERN})[\\/])?${FILE_REF_SEGMENT_PATTERN}(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?$`,
  "i"
);

function isDottedIdentifierPath(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("/") || text.includes("\\") || text.includes(":")) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(text);
}

export function looksLikeFileRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  const text = quoted ? String(quoted[2] || "").trim() : raw;
  if (!text) return false;
  if (isHttpUrl(text)) return false;
  if (isDottedIdentifierPath(text)) return false;
  if (/^[\\/]+$/.test(text)) return false;
  if (/^\/[^\/\s.?#]+$/.test(text)) return false;
  if (/^%[A-Za-z0-9_]+%(?:[\\/]+)?$/.test(text)) return false;
  if (/^[a-z]:(?:[\\/]+)?$/i.test(text)) return false;
  return FILE_REF_WHOLE_PATTERN.test(text);
}

export function normalizeCodeSpanContent(value) {
  const raw = String(value || "").replace(/\r?\n/g, " ");
  if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && /[^\s]/.test(raw)) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isMarkdownEscapedAt(source, index) {
  const text = String(source || "");
  let slashCount = 0;
  for (let i = Number(index || 0) - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

export function findNextInlineCodeSpan(source, fromIndex = 0) {
  const text = String(source || "");
  for (let start = Math.max(0, Number(fromIndex) || 0); start < text.length; start += 1) {
    if (text[start] !== "`") continue;
    if (isMarkdownEscapedAt(text, start)) continue;
    let fenceLen = 1;
    while (text[start + fenceLen] === "`") fenceLen += 1;
    for (let cursor = start + fenceLen; cursor < text.length; cursor += 1) {
      if (text[cursor] !== "`") continue;
      if (isMarkdownEscapedAt(text, cursor)) continue;
      let closeLen = 1;
      while (text[cursor + closeLen] === "`") closeLen += 1;
      if (closeLen === fenceLen) {
        return {
          start,
          end: cursor + closeLen,
          fenceLen,
          content: text.slice(start + fenceLen, cursor),
        };
      }
      cursor += closeLen - 1;
    }
    start += fenceLen - 1;
  }
  return null;
}

export function unescapeMarkdownText(value) {
  return String(value || "").replace(/\\([\\!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

export function fileRefDisplayLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let suffix = "";
  let base = text;
  const hashMatch = base.match(/(#L\d+(?:C\d+)?)$/i);
  if (hashMatch) {
    suffix = hashMatch[1];
    base = base.slice(0, -suffix.length);
  } else {
    const colonMatch = base.match(/(:\d+(?::\d+)?)$/);
    if (colonMatch) {
      suffix = colonMatch[1];
      base = base.slice(0, -suffix.length);
    }
  }
  const normalized = base.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  const fileName = parts[parts.length - 1] || normalized || text;
  return `${fileName}${suffix}`;
}

export function buildMessageLink(label, href, preferFileLabel = false) {
  const rawHref = String(href || "").trim();
  const rawLabel = String(label || rawHref).trim();
  const shouldUseFileLabel =
    !!preferFileLabel || looksLikeFileRef(rawLabel) || looksLikeFileRef(rawHref);
  const fileLabelSource = looksLikeFileRef(rawLabel) ? rawLabel : rawHref;
  const resolvedLabel = shouldUseFileLabel
    ? fileRefDisplayLabel(fileLabelSource || rawLabel || rawHref)
    : rawLabel;
  const safeLabel = escapeHtml(resolvedLabel || rawHref || "link");
  const openExternal = isHttpUrl(rawHref);
  if (!openExternal) return `<span class="msgPseudoLink">${safeLabel}</span>`;
  const safeHref = escapeHtml(rawHref);
  return `<a class="msgLink" href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
}

export function renderInlineCodeSpan(content, fenceLen = 1) {
  const normalized = normalizeCodeSpanContent(content);
  if (Number(fenceLen || 0) === 1 && looksLikeFileRef(normalized)) {
    return buildMessageLink(normalized, normalized, true);
  }
  return `<code class="msgInlineCode">${escapeHtml(normalized)}</code>`;
}

const INLINE_MESSAGE_PLAIN_TOKEN_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>()]+)|((?:(?:(?:%[A-Za-z0-9_]+%|[A-Za-z]:|\\\\[^\\\s]+|\.{1,2}|~|\/)[\\/])?(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?)/g;
const INLINE_HTTP_URL_CHAR_PATTERN = /^[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]$/;

function splitPlainHttpUrlToken(value) {
  const raw = String(value || "");
  let end = 0;
  while (end < raw.length && INLINE_HTTP_URL_CHAR_PATTERN.test(raw[end])) end += 1;
  return {
    url: raw.slice(0, end),
    remainder: raw.slice(end),
  };
}

function renderPlainInlineToken(match) {
  if (match[1] && match[2]) {
    const href = String(match[2] || "").trim();
    return buildMessageLink(match[1], href, looksLikeFileRef(href) || looksLikeFileRef(match[1]));
  }
  if (match[3]) {
    return `<strong>${escapeHtml(match[3])}</strong>`;
  }
  if (match[4]) {
    const { url, remainder } = splitPlainHttpUrlToken(match[4]);
    if (!url) return escapeHtml(String(match[4] || ""));
    return `${buildMessageLink(url, url, false)}${escapeHtml(remainder)}`;
  }
  if (match[5]) {
    const candidate = String(match[5] || "").trim();
    return looksLikeFileRef(candidate)
      ? buildMessageLink(candidate, candidate, true)
      : escapeHtml(candidate);
  }
  return escapeHtml(String(match[0] || ""));
}

function renderPlainTextSegment(text) {
  const source = String(text || "");
  let cursor = 0;
  let html = "";
  for (const match of source.matchAll(INLINE_MESSAGE_PLAIN_TOKEN_PATTERN)) {
    const full = String(match[0] || "");
    const index = match.index || 0;
    if (index > cursor) html += escapeHtml(unescapeMarkdownText(source.slice(cursor, index)));
    html += renderPlainInlineToken(match);
    cursor = index + full.length;
  }
  if (cursor < source.length) html += escapeHtml(unescapeMarkdownText(source.slice(cursor)));
  return html;
}

export function renderInlineMessageText(text) {
  const source = String(text || "");
  let cursor = 0;
  let html = "";
  while (cursor < source.length) {
    const span = findNextInlineCodeSpan(source, cursor);
    if (!span) {
      html += renderPlainTextSegment(source.slice(cursor));
      break;
    }
    if (span.start > cursor) {
      html += renderPlainTextSegment(source.slice(cursor, span.start));
    }
    html += renderInlineCodeSpan(span.content, span.fenceLen);
    cursor = span.end;
  }
  return html;
}

export function renderMessageRichHtml(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return "";
  let html = "";
  let pendingBlankLines = 0;
  const parseListLine = (line) => {
    const match = String(line || "").match(/^(\s*)([-*•]|\d+\.)\s+(.+)$/);
    if (!match) return null;
    const indent = String(match[1] || "").replace(/\t/g, "  ").length;
    const marker = String(match[2] || "").trim();
    const type = /^\d+\.$/.test(marker) ? "ol" : "ul";
    return { indent, marker, type, text: match[3] };
  };
  const isListLine = (line) => !!parseListLine(line);
  const renderListBlock = (listLines) => {
    const items = [];
    let pendingGapBefore = 0;
    for (const itemLine of listLines) {
      if (itemLine && typeof itemLine === "object" && itemLine.type === "blank") {
        pendingGapBefore += Math.max(1, Number(itemLine.count || 1));
        continue;
      }
      const parsed = parseListLine(itemLine);
      if (!parsed) continue;
      const depth = Math.min(6, Math.floor(Number(parsed.indent || 0) / 2));
      items.push({
        depth,
        type: parsed.type,
        marker: parsed.marker,
        text: parsed.text,
        gapBefore: pendingGapBefore,
      });
      pendingGapBefore = 0;
    }
    if (!items.length) return "";
    const minDepth = items.reduce((lowest, item) => Math.min(lowest, item.depth), items[0].depth);
    if (minDepth > 0) {
      for (const item of items) item.depth -= minDepth;
    }

    let out = "";
    const openLists = [];
    const openLi = [];
    const closeDepth = (targetDepthInclusive) => {
      while (openLists.length - 1 > targetDepthInclusive) {
        const depth = openLists.length - 1;
        if (openLi[depth]) {
          out += "</li>";
          openLi[depth] = false;
        }
        out += `</${openLists[depth]}>`;
        openLists.pop();
        openLi.pop();
      }
    };

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const next = items[idx + 1] || null;
      closeDepth(item.depth);
      while (openLists.length - 1 < item.depth) {
        const parentDepth = openLists.length - 1;
        if (parentDepth >= 0 && !openLi[parentDepth]) {
          out += `<li class="msgListItem depth-${Math.min(6, parentDepth)}">`;
          openLi[parentDepth] = true;
        }
        out += `<${item.type}>`;
        openLists.push(item.type);
        openLi.push(false);
      }
      if (openLists[item.depth] !== item.type) {
        if (openLi[item.depth]) {
          out += "</li>";
          openLi[item.depth] = false;
        }
        out += `</${openLists[item.depth]}>`;
        openLists[item.depth] = item.type;
        out += `<${item.type}>`;
      }
      if (openLi[item.depth]) {
        out += "</li>";
        openLi[item.depth] = false;
      }
      const gapClass = item.gapBefore > 0 ? " has-gap-before" : "";
      const gapStyle = item.gapBefore > 0
        ? ` style="margin-top:${String(Math.min(28, 10 * Number(item.gapBefore || 1)))}px"`
        : "";
      const markerAttr = escapeHtml(String(item.marker || (item.type === "ol" ? "1." : "•")));
      out += `<li class="msgListItem depth-${Math.min(6, item.depth)}${gapClass}" data-list-marker="${markerAttr}"${gapStyle}>${renderInlineMessageText(item.text)}`;
      openLi[item.depth] = true;
      if (!next || next.depth <= item.depth) {
        out += "</li>";
        openLi[item.depth] = false;
      }
    }

    closeDepth(-1);
    while (openLists.length) {
      const depth = openLists.length - 1;
      if (openLi[depth]) {
        out += "</li>";
        openLi[depth] = false;
      }
      out += `</${openLists[depth]}>`;
      openLists.pop();
      openLi.pop();
    }
    return out;
  };
  const lines = source.split("\n");
  let paragraphLines = [];
  let listLines = [];
  let codeLines = [];
  let inCodeBlock = false;
  const flushBlankLines = () => {
    if (pendingBlankLines <= 0) return;
    html += '<div class="msgBlankLine" aria-hidden="true"></div>'.repeat(pendingBlankLines);
    pendingBlankLines = 0;
  };
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    html += `<p>${paragraphLines.map((line) => renderInlineMessageText(line)).join("<br>")}</p>`;
    paragraphLines = [];
  };
  const flushList = () => {
    if (!listLines.length) return;
    html += renderListBlock(listLines);
    listLines = [];
  };
  const flushCode = () => {
    const code = codeLines.join("\n").replace(/\n$/, "");
    html += `<pre class="msgCodeBlock"><code>${escapeHtml(code)}</code></pre>`;
    codeLines = [];
  };
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    const trimmedStart = String(line || "").trimStart();
    const isFenceLine = trimmedStart.startsWith("```");
    if (inCodeBlock) {
      if (isFenceLine) {
        flushCode();
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (isFenceLine) {
      flushBlankLines();
      flushParagraph();
      flushList();
      inCodeBlock = true;
      continue;
    }
    if (!line.trim()) {
      if (listLines.length) {
        let nextIndex = lineIdx + 1;
        while (nextIndex < lines.length && !String(lines[nextIndex] || "").trim()) nextIndex += 1;
        if (nextIndex < lines.length && isListLine(lines[nextIndex])) {
          listLines.push({ type: "blank", count: 1 });
          continue;
        }
      }
      flushParagraph();
      flushList();
      if (html) pendingBlankLines += 1;
      continue;
    }
    flushBlankLines();
    if (isListLine(line)) {
      flushParagraph();
      listLines.push(line);
      continue;
    }
    flushList();
    paragraphLines.push(line);
  }
  if (inCodeBlock) flushCode();
  flushParagraph();
  flushList();
  return html || `<p>${escapeHtml(source)}</p>`;
}

function classifyToolSummaryText(text) {
  const source = String(text || "").trim();
  const lower = source.toLowerCase();
  if (!source) return { state: "idle", icon: "tool", text: "" };
  if (lower.startsWith("running `")) return { state: "running", icon: "command", text: source, mono: true };
  if (lower.startsWith("ran `")) return { state: "complete", icon: "command", text: source, mono: true };
  if (lower.startsWith("command failed `")) return { state: "error", icon: "command", text: source, mono: true };
  if (lower.startsWith("searching web")) return { state: "running", icon: "search", text: source, mono: false };
  if (lower.startsWith("searched web")) return { state: "complete", icon: "search", text: source, mono: false };
  if (lower.startsWith("viewing image")) return { state: "running", icon: "image", text: source, mono: false };
  if (lower.startsWith("editing files")) return { state: "running", icon: "patch", text: source, mono: false };
  if (lower.startsWith("updating plan")) return { state: "running", icon: "plan", text: source, mono: false };
  if (lower.startsWith("waiting for input")) return { state: "running", icon: "input", text: source, mono: false };
  if (lower.startsWith("spawning agent")) return { state: "running", icon: "agent", text: source, mono: false };
  if (lower.startsWith("waiting for agent")) return { state: "running", icon: "agent", text: source, mono: false };
  if (lower.startsWith("running tool `")) return { state: "running", icon: "tool", text: source, mono: false };
  if (lower.startsWith("called tool `")) return { state: "complete", icon: "tool", text: source, mono: false };
  if (lower.startsWith("tool failed `")) return { state: "error", icon: "tool", text: source, mono: false };
  return { state: "complete", icon: "tool", text: source, mono: false };
}

function stripToolWrappingBackticks(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^`([\s\S]+)`$/);
  return match ? String(match[1] || "").trim() : raw;
}

function parseEditedToolSummary(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  let match = source.match(/^Edited\s+`([^`]+)`(?:\s+\(\+(\d+)\s+-(\d+)\))?$/);
  if (match) {
    return {
      mode: "single",
      label: `Edited ${String(match[1] || "").trim()}`,
      path: String(match[1] || "").trim(),
      additions: Number(match[2] || 0),
      deletions: Number(match[3] || 0),
    };
  }
  match = source.match(/^Edited\s+(\d+)\s+files?(?:\s+\(\+(\d+)\s+-(\d+)\))?$/i);
  if (match) {
    return {
      mode: "multiple",
      label: `Edited ${String(match[1] || "").trim()} files`,
      fileCount: Number(match[1] || 0),
      additions: Number(match[2] || 0),
      deletions: Number(match[3] || 0),
    };
  }
  return null;
}

function renderDiffSummaryHtml(additions, deletions, prefix = "msgTool") {
  const plus = Number.isFinite(Number(additions)) ? Number(additions) : 0;
  const minus = Number.isFinite(Number(deletions)) ? Number(deletions) : 0;
  if (plus <= 0 && minus <= 0) return "";
  return (
    `<span class="${prefix}Diff" aria-label="diff summary">(` +
      `<span class="${prefix}DiffAdd">+${String(plus)}</span>` +
      ` ` +
      `<span class="${prefix}DiffDel">-${String(minus)}</span>` +
    `)</span>`
  );
}

export function renderToolPreviewHtml(text, options = {}) {
  const source = String(text || "").trim();
  const className = String(options.className || "").trim();
  const edited = parseEditedToolSummary(source);
  if (edited) {
    const label = escapeHtml(edited.label || source);
    const diffHtml = renderDiffSummaryHtml(edited.additions, edited.deletions, String(options.diffPrefix || "msgTool"));
    const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
    return `<span${classAttr}>${label}${diffHtml ? ` ${diffHtml}` : ""}</span>`;
  }
  if (options.code === true) {
    return `<code class="msgInlineCode">${escapeHtml(source)}</code>`;
  }
  const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
  return `<span${classAttr}>${escapeHtml(source)}</span>`;
}

function summarizeToolSnippet(value, maxChars = 92) {
  const raw = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { preview: "", extraLines: 0 };
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const isWrapperLine = (line) => {
    const trimmed = String(line || "").trim();
    return /^@['"]$/.test(trimmed) || /^['"]@$/.test(trimmed) || /^<<[-~]?\w+$/.test(trimmed);
  };
  const visibleLines = lines.filter((line) => String(line || "").trim());
  const previewLine = String(visibleLines.find((line) => !isWrapperLine(line)) || visibleLines[0] || lines[0] || "").trim();
  const preview = previewLine.length > maxChars
    ? `${previewLine.slice(0, Math.max(0, maxChars - 1))}…`
    : previewLine;
  return {
    preview,
    extraLines: Math.max(0, visibleLines.length - 1),
  };
}

function parseStructuredToolSummary(text) {
  const source = String(text || "").trim();
  const lower = source.toLowerCase();
  const prefixes = [
    { prefix: "Running ", state: "running", icon: "command", kind: "command" },
    { prefix: "Ran ", state: "complete", icon: "command", kind: "command" },
    { prefix: "Command failed ", state: "error", icon: "command", kind: "command" },
    { prefix: "Running tool ", state: "running", icon: "tool", kind: "tool" },
    { prefix: "Called tool ", state: "complete", icon: "tool", kind: "tool" },
    { prefix: "Tool failed ", state: "error", icon: "tool", kind: "tool" },
  ];
  for (const entry of prefixes) {
    if (!lower.startsWith(entry.prefix.toLowerCase())) continue;
    const detail = stripToolWrappingBackticks(source.slice(entry.prefix.length));
    const snippet = summarizeToolSnippet(detail);
    return {
      state: entry.state,
      icon: entry.icon,
      mono: true,
      preview: snippet.preview,
      extraLines: snippet.extraLines,
      kind: entry.kind,
    };
  }
  return null;
}

export function renderToolSummaryHtml(text) {
  const edited = parseEditedToolSummary(text);
  if (edited) {
    return (
      `<div class="msgToolLine state-complete icon-patch" data-tool-state="complete" data-tool-icon="patch">` +
        `<span class="msgToolLead" aria-hidden="true"></span>` +
        `<span class="msgToolText">${renderToolPreviewHtml(text, { diffPrefix: "msgTool" })}</span>` +
        `<span class="msgToolTail" aria-hidden="true"></span>` +
      `</div>`
    );
  }
  const structured = parseStructuredToolSummary(text);
  if (structured) {
    const safeState = escapeHtml(structured.state || "idle");
    const safeIcon = escapeHtml(structured.icon || "tool");
    const monoClass = structured.mono ? " mono" : "";
    const previewHtml = structured.preview
      ? `<code class="msgInlineCode">${escapeHtml(structured.preview)}</code>`
      : "";
    const moreHtml = structured.extraLines > 0
      ? `<span class="msgToolMore">+${String(structured.extraLines)} lines</span>`
      : "";
    return (
      `<div class="msgToolLine state-${safeState} icon-${safeIcon}${monoClass}" data-tool-state="${safeState}" data-tool-icon="${safeIcon}">` +
        `<span class="msgToolLead" aria-hidden="true"></span>` +
        `<span class="msgToolText">${previewHtml}${moreHtml}</span>` +
        `<span class="msgToolTail" aria-hidden="true"></span>` +
      `</div>`
    );
  }
  const summary = classifyToolSummaryText(text);
  const safeState = escapeHtml(summary.state || "idle");
  const safeIcon = escapeHtml(summary.icon || "tool");
  const body = renderInlineMessageText(summary.text || "");
  const monoClass = summary.mono ? " mono" : "";
  return (
    `<div class="msgToolLine state-${safeState} icon-${safeIcon}${monoClass}" data-tool-state="${safeState}" data-tool-icon="${safeIcon}">` +
      `<span class="msgToolLead" aria-hidden="true"></span>` +
      `<span class="msgToolText">${body}</span>` +
      `<span class="msgToolTail" aria-hidden="true"></span>` +
    `</div>`
  );
}

export function renderMessageBody(role, text, options = {}) {
  if (options && options.kind === "tool") return renderToolSummaryHtml(text);
  if (role === "assistant" || role === "system" || role === "user") return renderMessageRichHtml(text);
  return `<p>${escapeHtml(text || "").replace(/\n/g, "<br>")}</p>`;
}

export function renderMessageAttachments(attachments) {
  const items = Array.isArray(attachments) ? attachments : [];
  const imgs = items.filter((it) => it && typeof it === "object" && typeof it.src === "string" && it.src.trim());
  if (!imgs.length) return "";
  const nodes = [];
  const canShowPreview = (src) =>
    /^data:image\//i.test(src) ||
    /^https?:\/\//i.test(src) ||
    /^\/codex\/file\b/i.test(src) ||
    /^blob:/i.test(src);
  const displayAttachmentLabel = (label) => {
    const s = String(label || "").trim();
    const m = /^Image\s*#(\d+)\s*$/i.exec(s);
    if (m) return `#${m[1]}`;
    return s;
  };
  const renderMissingTile = (label, extraHtml = "") =>
    `<button class="msgAttachmentCard msgAttachmentCard-missing tile" type="button" data-image-src="" data-image-label="${escapeHtml(label)}">` +
      `<div class="msgAttachmentChip mono">[image]</div>` +
      `<div class="msgAttachmentLabelBadge mono">${escapeHtml(displayAttachmentLabel(label) || "image")}</div>` +
      `${extraHtml}` +
    `</button>`;
  const renderTile = (src, label, overlay = "") => {
    if (canShowPreview(src)) {
      return (
        `<button class="msgAttachmentCard tile" type="button" data-image-src="${escapeHtml(src)}" data-image-label="${escapeHtml(label)}">` +
          `<img class="msgAttachmentImage" alt="${escapeHtml(label || "image")}" src="${escapeHtml(src)}" />` +
          `<div class="msgAttachmentLabelBadge mono">${escapeHtml(displayAttachmentLabel(label) || "image")}</div>` +
          `${overlay}` +
        `</button>`
      );
    }
    return renderMissingTile(label, overlay);
  };
  const shown = imgs.length > 4 ? imgs.slice(0, 4) : imgs;
  const remaining = Math.max(0, imgs.length - shown.length);
  for (let idx = 0; idx < shown.length; idx += 1) {
    const img = shown[idx];
    const src = img.src.trim();
    const label = String(img.label || "").trim() || `Image #${idx + 1}`;
    const overlay = idx === 3 && remaining > 0 ? `<div class="msgAttachmentMoreOverlay">+${remaining}</div>` : "";
    nodes.push(renderTile(src, label, overlay));
  }
  const mosaicClass =
    shown.length === 1 ? "mosaic single" :
    shown.length === 3 ? "mosaic cols-3" :
    "mosaic";
  return `<div class="msgAttachments ${mosaicClass}">${nodes.join("")}</div>`;
}
