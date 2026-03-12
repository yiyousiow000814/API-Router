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

function parseToolPayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function joinCommandParts(parts) {
  if (!Array.isArray(parts)) return null;
  const joined = parts
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (part == null) return "";
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .filter(Boolean)
    .join(" ");
  return joined || null;
}

function isShellLikeToolName(name) {
  const normalized = normalizeType(name);
  return normalized === "shell"
    || normalized.endsWith("shellcommand")
    || normalized.endsWith("localshell")
    || normalized.endsWith("containerexec")
    || normalized.endsWith("unifiedexec");
}

function readCommandFromToolPayload(value) {
  const payload = parseToolPayload(value);
  if (!payload) return null;
  const command = payload.command ?? payload.cmd ?? payload.args;
  if (typeof command === "string") return command.trim() || null;
  return joinCommandParts(command);
}

function readCommandFromToolLikeItem(item, maxChars) {
  const direct =
    normalizeInline(item?.command, maxChars) ??
    normalizeInline(item?.cmd, maxChars);
  if (direct) return direct;
  return (
    normalizeInline(readCommandFromToolPayload(item?.arguments), maxChars) ??
    normalizeInline(readCommandFromToolPayload(item?.input), maxChars) ??
    normalizeInline(readCommandFromToolPayload(item?.args), maxChars)
  );
}

function formatCommandTitle(command, status, compact) {
  if (status === "failed" || status === "error") return `Command failed \`${command}\``;
  if (compact && (status === "running" || status === "inprogress" || status === "working" || status === "started")) {
    return `Running \`${command}\``;
  }
  return `Ran \`${command}\``;
}

function formatGenericToolTitle(label, tool, status, compact) {
  if (status === "failed" || status === "error") return `Tool failed \`${label}\``;
  if (compact) {
    const normalizedTool = normalizeType(tool);
    if (normalizedTool === "applypatch") return "Editing files";
    if (normalizedTool === "updateplan") return "Updating plan";
    if (normalizedTool === "webrun") return "Searching web";
    if (normalizedTool === "viewimage") return "Viewing image";
    if (normalizedTool === "requestuserinput") return "Waiting for input";
    if (normalizedTool === "spawnagent") return "Spawning agent";
    if (normalizedTool === "wait") return "Waiting for agent";
    if (status === "running" || status === "inprogress" || status === "working" || status === "started") {
      return `Running tool \`${label}\``;
    }
  }
  return `Called tool \`${label}\``;
}

function extractApplyPatchFiles(item) {
  const raw = [
    normalizeTextPayload(item?.result),
    normalizeTextPayload(item?.output),
    normalizeTextPayload(item?.error?.message),
  ]
    .filter(Boolean)
    .join("\n");
  if (!raw) return [];
  const files = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = String(line || "").trim();
    const match = trimmed.match(/^(?:[ACDMRTUX?!]|M)\s+(.+)$/);
    if (!match) continue;
    const path = String(match[1] || "").trim();
    if (path) files.push(path);
  }
  return Array.from(new Set(files));
}

export function toolItemToMessage(item, options = {}) {
  const compact = options && options.compact === true;
  const itemType = normalizeType(item?.type);
  if (!itemType) return null;

  if (itemType === "plan") {
    return normalizeMultiline(item?.text, 1800) || null;
  }

  if (itemType === "commandexecution") {
    const command = normalizeInline(item?.command, 240) ?? "command";
    const status = normalizeType(item?.status);
    const output =
      normalizeMultiline(item?.aggregatedOutput, 2400) ??
      normalizeMultiline(item?.aggregated_output, 2400) ??
      toStructuredPreview(item?.output, 2400);
    const exitCode = Number.isFinite(Number(item?.exitCode))
      ? Number(item.exitCode)
      : (Number.isFinite(Number(item?.exit_code)) ? Number(item.exit_code) : null);
    const title = formatCommandTitle(command, status, compact);
    if (compact) return title;
    const lines = [title];
    if (exitCode !== null) lines.push(`  - exit code ${String(exitCode)}`);
    if (output) lines.push(`  - ${String(output).replace(/\n/g, "\n    ")}`);
    return lines.join("\n");
  }

  if (itemType === "toolcall" || itemType === "mcptoolcall") {
    const rawTool =
      normalizeInline(item?.tool, 120) ??
      normalizeInline(item?.name, 120);
    const status = normalizeType(item?.status);
    const command = isShellLikeToolName(rawTool)
      ? readCommandFromToolLikeItem(item, 240)
      : null;
    if (command) {
      const title = formatCommandTitle(command, status, compact);
      if (compact) return title;
      const output =
        toStructuredPreview(item?.result, 2400) ??
        toStructuredPreview(item?.output, 2400);
      const lines = [title];
      if (output) lines.push(`  - ${String(output).replace(/\n/g, "\n    ")}`);
      return lines.join("\n");
    }
    const server = normalizeInline(item?.server, 120);
    const tool = rawTool;
    const normalizedTool = normalizeType(tool);
    if (compact && normalizedTool === "applypatch") {
      const files = extractApplyPatchFiles(item);
      if (files.length === 1) return `Edited \`${files[0]}\``;
      if (files.length > 1) return `Edited \`${files[0]}\` +${String(files.length - 1)} files`;
      if (status === "running" || status === "inprogress" || status === "working" || status === "started") {
        return "Editing files";
      }
      return "Edited files";
    }
    const label = [server, tool].filter(Boolean).join(" / ") || "tool";
    const errorMessage =
      normalizeInline(item?.error?.message, 240) ??
      normalizeInline(item?.error, 240);
    const result =
      toStructuredPreview(item?.result, 2400) ??
      toStructuredPreview(item?.output, 2400);
    const detail = status === "failed" || status === "error"
      ? (errorMessage ?? result)
      : (result ?? errorMessage);
    const title = formatGenericToolTitle(label, tool, status, compact);
    if (compact) return title;
    return detail ? `${title}\n  - ${detail.replace(/\n/g, "\n    ")}` : title;
  }

  if (itemType === "websearch") {
    const query =
      normalizeInline(item?.query, 180) ??
      normalizeInline(item?.action?.query, 180);
    const actionType = normalizeType(item?.action?.type);
    let detail = query;
    if (actionType === "openpage") {
      detail = normalizeInline(item?.action?.url, 240) ?? detail;
    } else if (actionType === "findinpage") {
      const url = normalizeInline(item?.action?.url, 180);
      const pattern = normalizeInline(item?.action?.pattern, 120);
      detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(" | ") || detail;
    }
    const title = query ? `- Searched web for "${query}"` : "- Searched web";
    return detail && detail !== query ? `${title}\n  - ${detail}` : title;
  }

  if (itemType === "filechange") {
    const status = normalizeType(item?.status);
    const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
    const title = status === "failed" || status === "error" ? "- File changes failed" : "- Applied file changes";
    return changeCount > 0 ? `${title}\n  - ${String(changeCount)} file(s) changed` : title;
  }

  if (itemType === "enteredreviewmode") return "- Entered review mode";
  if (itemType === "exitedreviewmode") return "- Exited review mode";
  if (itemType === "contextcompaction") return "- Compacted conversation context";

  return null;
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
  const options = arguments.length > 1 ? arguments[1] : {};
  if (!item || typeof item !== "object") return "";
  const type = String(item.type || "").trim();
  if (!type) return "";
  if (type === "agentMessage" || type === "assistantMessage") {
    return stripCodexImageBlocks(String(item.text || "")).trim();
  }
  if (type !== "userMessage") return toolItemToMessage(item, options) || "";
  return parseUserMessageParts(item).text;
}
