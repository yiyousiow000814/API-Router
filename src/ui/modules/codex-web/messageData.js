export function normalizeTextPayload(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result.output_text === "string") return result.output_text;
  if (Array.isArray(result.output_text)) return result.output_text.join("\n");
  if (typeof result.text === "string") return result.text;
  return JSON.stringify(result, null, 2);
}

export function compactAttachmentLabel(value, maxLen = 38) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^data:/i.test(text)) return "";
  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      const pathname = parsed.pathname || "";
      const segments = pathname.split("/").filter(Boolean);
      candidate = segments[segments.length - 1] || parsed.hostname || text;
    } catch {
      candidate = text;
    }
  } else {
    const normalized = text.replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    candidate = segments[segments.length - 1] || normalized || text;
  }
  if (candidate.length <= maxLen) return candidate;
  return `${candidate.slice(0, maxLen - 1)}…`;
}

export function stripCodexHarnessWrappers(text) {
  const source = String(text || "");
  if (!source) return "";
  const trimmed = source.trim();
  const wholeEnvelope = /^<\s*(turn_aborted|subagent_notification)\s*>[\s\S]*?<\s*\/\s*\1\s*>\s*$/i.test(trimmed);
  if (wholeEnvelope) return "";
  if (!/[<](?:\s*turn_aborted|\s*subagent_notification)\b/i.test(source)) return source;
  let replaced = source.replace(
    /<\s*(turn_aborted|subagent_notification)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    ""
  );
  replaced = replaced
    .replace(/<\s*\/\s*(turn_aborted|subagent_notification)\s*>/gi, "")
    .replace(/<\s*(turn_aborted|subagent_notification)\s*>/gi, "")
    .replace(/<\s*(turn_aborted|subagent_notification)\s*\/\s*>/gi, "");
  return replaced;
}

export function stripCodexImageBlocks(text) {
  const source = stripCodexHarnessWrappers(text);
  if (!source) return "";
  let replaced = source.replace(
    /<image\s+name=(?:\[[^\]]+\]|"[^"]+"|'[^']+')\s*>[\s\S]*?<\/image>/gi,
    (match) => {
      const name = /name=(?:\[([^\]]+)\]|"([^"]+)"|'([^']+)')/i.exec(match);
      const label = (name?.[1] || name?.[2] || name?.[3] || "").trim();
      return label ? `[${label}]` : "[image]";
    }
  );
  replaced = replaced.replace(
    /<image\s+name=(?:\[([^\]]+)\]|"([^"]+)"|'([^']+)')\s*\/?>/gi,
    (_m, a, b, c) => {
      const label = String(a || b || c || "").trim();
      return label ? `[${label}]` : "[image]";
    }
  );
  replaced = replaced.replace(/<\/image>/gi, "");
  return replaced;
}

export function isBootstrapAgentsPrompt(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  const head = s.slice(0, 320);
  if (/^#\s*AGENTS\.md instructions\b/i.test(head)) return true;
  if (/<INSTRUCTIONS>/i.test(head) && /Agents Documentation|Agent Defaults|PR-first/i.test(head)) {
    return true;
  }
  return false;
}

export function stripStandaloneImageRefs(text) {
  return String(text || "")
    .replace(/^\s*\[(?:Image\s*#\d+|image:[^\]]+)\]\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeType(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function normalizeInline(value, maxChars) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function normalizeMultiline(value, maxChars) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function toStructuredPreview(value, maxChars) {
  if (value == null) return null;
  if (typeof value === "string") return normalizeMultiline(value, maxChars);
  try {
    return normalizeMultiline(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return null;
  }
}

export function parseUserMessageParts(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const lines = [];
  const images = [];
  const mentions = [];
  const pendingImageLabels = [];
  const norm = (value) => String(value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const partType = norm(part.type);
    if (partType === "text" || partType === "inputtext") {
      const raw = stripCodexImageBlocks(String(part.text || "")).trim();
      if (raw) {
        const kept = [];
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const m = /^\[(Image\s*#\d+)\]$/i.exec(trimmed);
          if (m) {
            pendingImageLabels.push(m[1].replace(/\s+/g, " ").trim());
            continue;
          }
          if (/^\[(image:[^\]]+)\]$/i.test(trimmed)) continue;
          kept.push(line);
        }
        const text = kept.join("\n").trim();
        if (text) lines.push(text);
      }
      continue;
    }
    if (partType === "mention") {
      const fileName = compactAttachmentLabel(part.path);
      if (fileName) {
        mentions.push({ kind: "file", label: fileName, path: String(part.path || "") });
      }
      continue;
    }
    if (partType === "localimage") {
      const fileName = compactAttachmentLabel(part.path);
      const path = String(part.path || "").trim();
      if (path) {
        const label = pendingImageLabels.shift() || `Image #${images.length + 1}`;
        const src = `/codex/file?path=${encodeURIComponent(path)}`;
        images.push({ src, label, kind: "path", rawPath: path, fileName });
      }
      continue;
    }
    if (partType === "image") {
      const url = String(part.url || "").trim();
      if (url) {
        const label =
          pendingImageLabels.shift() ||
          compactAttachmentLabel(url) ||
          `Image #${images.length + 1}`;
        images.push({ src: url, label, kind: "url" });
      }
      continue;
    }
    if (partType === "inputimage") {
      const url = String(part.image_url || "").trim();
      if (url) {
        const label = pendingImageLabels.shift() || `Image #${images.length + 1}`;
        images.push({ src: url, label, kind: "url" });
      }
    }
  }
  let text = lines.join("\n").trim();
  if (images.length) text = stripStandaloneImageRefs(text);
  return { text, images, mentions };
}

export function normalizeThreadItemText(item) {
  if (!item || typeof item !== "object") return "";
  const type = String(item.type || "").trim();
  if (!type) return "";
  if (type === "agentMessage" || type === "assistantMessage") {
    return stripCodexImageBlocks(String(item.text || "")).trim();
  }
  if (type !== "userMessage") return "";
  return parseUserMessageParts(item).text;
}
