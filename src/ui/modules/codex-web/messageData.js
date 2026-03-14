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
    || normalized === "execcommand"
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

function splitShellPipeline(command) {
  return String(command || "")
    .split(/\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readLikelyFilePathToken(command) {
  const parts = String(command || "")
    .split(/\s+/)
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index]
      .replace(/^[("'`]+|[)"'`;,]+$/g, "")
      .trim();
    if (!token) continue;
    if (/^\|$/.test(token)) continue;
    if (/^-/.test(token)) continue;
    if (/^(?:cat|tail|head|sed|awk|grep|rg|less|more)$/i.test(token)) continue;
    if (/^(?:\d+|true|false)$/i.test(token)) continue;
    if (/[/\\]/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(token)) return token;
  }
  return null;
}

function summarizeReadOnlyCommand(command) {
  const source = String(command || "").trim();
  if (!source) return null;
  const pipeline = splitShellPipeline(source);
  const first = String(pipeline[0] || "").trim();
  if (!first) return null;
  let filePath = null;
  if (/^(?:cat|less|more)\s+/i.test(first)) {
    filePath = readLikelyFilePathToken(first);
  } else if (/^(?:tail|head)\s+/i.test(first)) {
    filePath = readLikelyFilePathToken(first);
  } else if (/^sed\s+/i.test(first) && pipeline.length === 1) {
    filePath = readLikelyFilePathToken(first);
  } else if (/^(?:grep|rg|awk)\s+/i.test(first) && pipeline.length === 1) {
    filePath = readLikelyFilePathToken(first);
  }
  if (!filePath) {
    for (const part of pipeline.slice(1)) {
      if (!/^(?:sed|head|tail|cat|less|more|grep|rg|awk)\b/i.test(part)) continue;
      filePath = readLikelyFilePathToken(part);
      if (filePath) break;
    }
  }
  const label = compactAttachmentLabel(filePath);
  return label ? `Read \`${label}\`` : null;
}

function readWriteStdinPayload(item) {
  const payload =
    parseToolPayload(item?.arguments) ??
    parseToolPayload(item?.input) ??
    parseToolPayload(item?.args);
  return payload && typeof payload === "object" ? payload : null;
}

function readToolTextValues(item) {
  return [
    normalizeTextPayload(item?.result),
    normalizeTextPayload(item?.output),
    normalizeTextPayload(item?.error?.message),
    normalizeTextPayload(item?.error),
  ].filter(Boolean);
}

function readToolObjectValues(item) {
  return [
    parseToolPayload(item?.result),
    parseToolPayload(item?.output),
    parseToolPayload(item?.error),
  ].filter((value) => value && typeof value === "object");
}

function hasFailedStatusText(value) {
  const text = normalizeType(value);
  return text === "failed" || text === "error" || text === "cancelled" || text === "timeout" || text === "denied";
}

function isConservativeFailureText(toolName, value) {
  const normalizedTool = normalizeType(toolName);
  const text = String(value || "").toLowerCase().trim();
  if (!text) return false;
  if (normalizedTool === "spawnagent") {
    return (
      text.includes("spawn failed")
      || text.includes("agent spawn failed")
      || text.includes("failed to spawn")
    );
  }
  if (normalizedTool === "sendinput") {
    return (
      text.includes("send input failed")
      || text.includes("failed to send input")
      || text.includes("submission failed")
    );
  }
  return false;
}

function inferToolFailure(toolName, item, status) {
  if (hasFailedStatusText(status)) return true;
  for (const value of readToolObjectValues(item)) {
    if (hasFailedStatusText(value?.status) || hasFailedStatusText(value?.state)) return true;
    if (value?.success === false || value?.ok === false) return true;
    if (typeof value?.error === "string" && value.error.trim()) return true;
    if (value?.error && typeof value.error === "object") return true;
  }
  for (const value of readToolTextValues(item)) {
    if (isConservativeFailureText(toolName, value)) return true;
  }
  return false;
}

function readAgentTargetName(item) {
  const values = [
    parseToolPayload(item?.arguments),
    ...readToolObjectValues(item),
  ].filter((value) => value && typeof value === "object");
  for (const value of values) {
    for (const key of ["nickname", "agent_name", "agentName", "target_name", "targetName", "name"]) {
      const candidate = normalizeInline(value?.[key], 120);
      if (candidate) return candidate;
    }
  }
  return null;
}

function formatSpawnAgentTitle(item, status, compact) {
  const failed = inferToolFailure("spawn_agent", item, status);
  const nickname = readAgentTargetName(item);
  if (failed) return "Agent spawn failed";
  if (compact && (status === "running" || status === "inprogress" || status === "working" || status === "started")) {
    return nickname ? `Spawning agent ${nickname}` : "Spawning agent";
  }
  if (nickname) return `Spawned agent ${nickname}`;
  return compact ? "Spawning agent" : "Spawned agent";
}

function formatSendInputTitle(item, status, compact) {
  const payload =
    parseToolPayload(item?.arguments) ??
    parseToolPayload(item?.input) ??
    parseToolPayload(item?.args) ??
    {};
  const failed = inferToolFailure("send_input", item, status);
  const target = readAgentTargetName(item) || "agent";
  const interruptOnly = payload?.interrupt === true && !normalizeInline(payload?.message, 40);
  if (failed) return interruptOnly ? `Failed to interrupt ${target}` : `Failed to send input to ${target}`;
  if (compact && (status === "running" || status === "inprogress" || status === "working" || status === "started")) {
    return interruptOnly ? `Interrupting ${target}` : `Sending input to ${target}`;
  }
  return interruptOnly ? `Interrupted ${target}` : `Sent input to ${target}`;
}

function formatCommandTitle(command, status, compact) {
  const readSummary = summarizeReadOnlyCommand(command);
  if (readSummary) {
    if (status === "failed" || status === "error") return `Read failed ${readSummary.slice("Read ".length)}`;
    if (compact && (status === "running" || status === "inprogress" || status === "working" || status === "started")) {
      return readSummary;
    }
    return readSummary;
  }
  if (status === "failed" || status === "error") return `Command failed \`${command}\``;
  if (compact && (status === "running" || status === "inprogress" || status === "working" || status === "started")) {
    return `Running \`${command}\``;
  }
  return `Ran \`${command}\``;
}

function formatGenericToolTitle(label, tool, status, compact, item) {
  const normalizedTool = normalizeType(tool);
  if (normalizedTool === "spawnagent") return formatSpawnAgentTitle(item, status, compact);
  if (normalizedTool === "sendinput") return formatSendInputTitle(item, status, compact);
  if (status === "failed" || status === "error") return `Tool failed \`${label}\``;
  if (compact) {
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
    const path = shortenApplyPatchDisplayPath(match[1]);
    if (path) files.push(path);
  }
  return Array.from(new Set(files));
}

function shortenApplyPatchDisplayPath(value) {
  const raw = String(value || "")
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "");
  if (!raw) return "";
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(raw)) return raw;
  const separator = raw.includes("\\") && !raw.includes("/") ? "\\" : "/";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return raw;
  const markers = new Set([
    ".codex",
    ".github",
    "docs",
    "scripts",
    "src",
    "src-tauri",
    "test",
    "tests",
  ]);
  const lowerParts = parts.map((part) => String(part || "").toLowerCase());
  const markerIndex = lowerParts.findIndex((part, index) => {
    if (markers.has(part)) return true;
    if (index !== parts.length - 1) return false;
    return /^(?:package\.json|cargo\.toml|readme(?:\.[^\\/]+)?|package-lock\.json|pnpm-lock\.yaml|tsconfig(?:\.[^\\/]+)?\.json)$/i.test(part);
  });
  if (markerIndex >= 0) return parts.slice(markerIndex).join(separator);
  return parts[parts.length - 1] || raw;
}

function readApplyPatchSource(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return readApplyPatchSource(parsed);
    } catch {}
    return value;
  }
  if (typeof value !== "object") return String(value || "");
  for (const key of ["patch", "input", "arguments", "text", "value"]) {
    if (typeof value?.[key] === "string" && value[key].trim()) return value[key];
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function extractApplyPatchEdits(item) {
  const sources = [item?.arguments, item?.input, item?.args]
    .map(readApplyPatchSource)
    .filter((value) => String(value || "").trim());
  for (const source of sources) {
    const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
    const edits = [];
    let current = null;
    for (const line of lines) {
      const text = String(line || "");
      const addMatch = text.match(/^\*\*\* Add File:\s+(.+)$/);
      if (addMatch) {
        current = { path: shortenApplyPatchDisplayPath(addMatch[1]), additions: 0, deletions: 0 };
        if (current.path) edits.push(current);
        continue;
      }
      const updateMatch = text.match(/^\*\*\* Update File:\s+(.+)$/);
      if (updateMatch) {
        current = { path: shortenApplyPatchDisplayPath(updateMatch[1]), additions: 0, deletions: 0 };
        if (current.path) edits.push(current);
        continue;
      }
      const deleteMatch = text.match(/^\*\*\* Delete File:\s+(.+)$/);
      if (deleteMatch) {
        current = null;
        edits.push({ path: shortenApplyPatchDisplayPath(deleteMatch[1]), additions: 0, deletions: 0 });
        continue;
      }
      const moveMatch = text.match(/^\*\*\* Move to:\s+(.+)$/);
      if (moveMatch && current) {
        current.path = shortenApplyPatchDisplayPath(moveMatch[1]) || current.path;
        continue;
      }
      if (!current) continue;
      if (/^\+\+\+/.test(text) || /^---/.test(text)) continue;
      if (/^\+/.test(text)) {
        current.additions += 1;
        continue;
      }
      if (/^-/.test(text)) {
        current.deletions += 1;
      }
    }
    const normalized = edits.filter((edit) => String(edit?.path || "").trim());
    if (normalized.length) return normalized;
  }
  return [];
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
    if (normalizedTool === "writestdin") {
      const payload = readWriteStdinPayload(item);
      const chars = typeof payload?.chars === "string" ? payload.chars : "";
      if (!chars) return null;
      const title = chars === "\u0003" ? "Interrupted running command" : "Sent input to running command";
      if (compact) return title;
      const detail =
        toStructuredPreview(item?.result, 2400) ??
        toStructuredPreview(item?.output, 2400);
      return detail ? `${title}\n  - ${String(detail).replace(/\n/g, "\n    ")}` : title;
    }
    if (compact && normalizedTool === "applypatch") {
      const edits = extractApplyPatchEdits(item);
      if (edits.length === 1) {
        const edit = edits[0];
        const delta = ` (+${String(edit.additions || 0)} -${String(edit.deletions || 0)})`;
        return `Edited \`${edit.path}\`${delta}`;
      }
      if (edits.length > 1) {
        const additions = edits.reduce((sum, edit) => sum + Number(edit?.additions || 0), 0);
        const deletions = edits.reduce((sum, edit) => sum + Number(edit?.deletions || 0), 0);
        const delta = ` (+${String(additions)} -${String(deletions)})`;
        return `Edited ${String(edits.length)} files${delta}`;
      }
      const files = extractApplyPatchFiles(item);
      if (files.length === 1) return `Edited \`${files[0]}\``;
      if (files.length > 1) return `Edited ${String(files.length)} files`;
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
    const title = formatGenericToolTitle(label, tool, status, compact, item);
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
    const title = query ? `Searched web for \`${query}\`` : "Searched web";
    if (compact) return title;
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
  if (itemType === "contextcompaction") return "Compacted conversation context";

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
