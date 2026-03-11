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
    for (const itemLine of listLines) {
      const parsed = parseListLine(itemLine);
      if (!parsed) continue;
      const depth = Math.min(6, Math.floor(Number(parsed.indent || 0) / 2));
      items.push({ depth, type: parsed.type, text: parsed.text });
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
      out += `<li class="msgListItem depth-${Math.min(6, item.depth)}">${renderInlineMessageText(item.text)}`;
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
      flushParagraph();
      flushList();
      inCodeBlock = true;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
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

export function renderMessageBody(role, text) {
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
