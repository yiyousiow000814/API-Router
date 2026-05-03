import { renderMessageRichHtml, renderStructuredToolPreviewHtml, renderToolPreviewHtml } from "./messageRender.js";
import { extractPlanUpdate, renderPlanCardHtml } from "./runtimePlan.js";
import { clearProposedPlanConfirmation } from "./proposedPlan.js";
import { extractRequestUserInput } from "./runtimeUserInput.js";
import { isTerminalHistoryStatus, isTerminalInterruptedHistory } from "./historyLiveCommentaryState.js";
import {
  buildBranchPickerItemState,
  buildBranchPickerState,
} from "./branchPickerState.js";
import { resolveCurrentThreadId } from "./runtimeState.js";
import {
  activeComposerWorkspace,
  applyActiveThreadGitMetaState,
  buildActiveThreadGitMetaKey,
  normalizeGitMetaWorkspace,
} from "./threadGitMetaState.js";

export function createComposerUiModule(deps) {
  const {
    state,
    byId,
    readPromptValue,
    clearPromptInput,
    resolveMobilePromptLayout,
    renderComposerContextLeftInNode,
    renderInlineMessageText = (value) => String(value || ""),
    toolItemToMessage = () => "",
    normalizeType = (value) => String(value || "").trim().toLowerCase(),
    escapeHtml = (value) => String(value || ""),
    updateHeaderUi,
    setSyntheticPendingUserInputs = () => {},
    upsertSyntheticPendingUserInput = () => {},
    LIVE_INSPECTOR_ENABLED_KEY,
    localStorageRef,
    documentRef,
    windowRef,
    api,
    detectThreadWorkspaceTarget = () => "unknown",
  } = deps;
  const storage = localStorageRef ?? globalThis.localStorage ?? { getItem() { return ""; } };
  const doc = documentRef ?? globalThis.document;
  const win = windowRef ?? globalThis.window ?? {};
  const scheduleFrame = typeof win.requestAnimationFrame === "function"
    ? win.requestAnimationFrame.bind(win)
    : ((cb) => cb());
  const MAX_VISIBLE_ACTIVE_COMMANDS = 3;
  const animatedRuntimeEntryKeys = new Set();
  const animatedRuntimePlanKeys = new Set();
  let lastRuntimePanelsRenderSig = "";

  function syncFloatingComposerMetrics() {
    const root = doc?.documentElement;
    const composer = doc?.querySelector?.(".composer");
    if (!root || !composer) return;
    const composerHeight = Math.max(
      Number(composer.offsetHeight || 0),
      Number(composer.getBoundingClientRect?.().height || 0),
      0
    );
    root.style.setProperty("--composer-float-height", `${Math.round(composerHeight)}px`);
  }

  function normalizeRunningState(value, fallback = "complete") {
    const normalized = normalizeType(value);
    if (/failed|error|cancelled|timeout|denied/.test(normalized)) return "error";
    if (/running|inprogress|working|queued|started|streaming|updating/.test(normalized)) return "running";
    if (normalized) return "complete";
    return fallback;
  }

  function isRuntimeActiveState(value) {
    return normalizeRunningState(value, "") === "running";
  }

  function readText(value) {
    return value == null ? "" : String(value).trim();
  }

  function readFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function pctOf(value, total) {
    const v = readFiniteNumber(value);
    const t = readFiniteNumber(total);
    if (v == null || t == null || t <= 0) return null;
    return Math.max(0, Math.min(100, (v / t) * 100));
  }

  function fmtPct(value) {
    const number = readFiniteNumber(value);
    return number == null ? "-" : `${Math.round(number)}%`;
  }

  function fmtAmount(value) {
    const number = readFiniteNumber(value);
    if (number == null) return "-";
    return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(number);
  }

  function fmtUsd(value) {
    const number = readFiniteNumber(value);
    if (number == null) return "-";
    return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(number);
  }

  function describeProviderUsage(quota, hardCap = null, usagePresentation = "standard") {
    const q = quota && typeof quota === "object" ? quota : {};
    const caps = hardCap && typeof hardCap === "object"
      ? {
          daily: hardCap.daily !== false,
          weekly: hardCap.weekly !== false,
          monthly: hardCap.monthly !== false,
        }
      : { daily: true, weekly: true, monthly: true };
    const kind = String(q.kind || "none").trim();
    if (kind === "token_stats") {
      const total = readFiniteNumber(q.today_added);
      const remaining = readFiniteNumber(q.remaining);
      const used = readFiniteNumber(q.today_used) ?? (total != null && remaining != null ? total - remaining : null);
      const remainingPct = pctOf(remaining, total);
      const usedPct = pctOf(used, total);
      return {
        headline: `Remaining ${fmtPct(remainingPct)}`,
        detail: `Today ${fmtAmount(used)} / ${fmtAmount(total)}`,
        sub: usedPct == null ? "" : `Used ${fmtPct(usedPct)}`,
        pct: remainingPct,
      };
    }
    if (kind === "budget_info") {
      if (usagePresentation === "total_only") {
        const total = readFiniteNumber(q.today_added) ?? readFiniteNumber(q.daily_budget_usd);
        const remaining =
          readFiniteNumber(q.remaining) ??
          (total != null &&
          (readFiniteNumber(q.today_used) ?? readFiniteNumber(q.daily_spent_usd)) != null
            ? Math.max(0, total - (readFiniteNumber(q.today_used) ?? readFiniteNumber(q.daily_spent_usd) ?? 0))
            : null);
        const used =
          (total != null && remaining != null ? Math.max(0, total - remaining) : null) ??
          readFiniteNumber(q.today_used) ??
          readFiniteNumber(q.daily_spent_usd);
        const remainingPct = pctOf(remaining, total);
        const usedPct = pctOf(used, total);
        return {
          headline: `Remaining ${fmtPct(remainingPct)}`,
          detail:
            used != null && total != null
              ? `Used $${fmtUsd(used)} / $${fmtUsd(total)}`
              : "Refresh after first request",
          sub: "",
          pct: remainingPct,
        };
      }
      const periods = [
        ["daily", "Daily", readFiniteNumber(q.daily_spent_usd), readFiniteNumber(q.daily_budget_usd)],
        ["weekly", "Weekly", readFiniteNumber(q.weekly_spent_usd), readFiniteNumber(q.weekly_budget_usd)],
        ["monthly", "Monthly", readFiniteNumber(q.monthly_spent_usd), readFiniteNumber(q.monthly_budget_usd)],
      ]
        .filter(([period]) => caps[period] !== false)
        .map(([period, label, spent, budget]) => {
          const hasBudget = spent != null && budget != null;
          const left = hasBudget ? Math.max(0, budget - spent) : null;
          return {
            period,
            label,
            spent,
            budget,
            left,
            leftPct: pctOf(left, budget),
            hasAny:
              (budget != null && budget > 0) ||
              (spent != null && spent > 0),
            hasBudget,
          };
        })
        .filter((period) => period.hasAny);
      const primary = periods.find((period) => period.hasBudget) || periods[0] || null;
      const sub = periods
        .filter((period) => period !== primary)
        .slice(0, 1)
        .map((period) =>
          period.hasBudget
            ? `${period.label} $${fmtUsd(period.spent)} / $${fmtUsd(period.budget)}`
            : period.spent != null
              ? `${period.label} used $${fmtUsd(period.spent)}`
              : `${period.label} budget $${fmtUsd(period.budget)}`
        )
        .join("");
      return {
        headline: primary?.hasBudget
          ? `Remaining ${fmtPct(primary.leftPct)}`
          : q.remaining != null
            ? `Balance $${fmtUsd(q.remaining)}`
            : "Usage available",
        detail: primary?.hasBudget
          ? `${primary.label} $${fmtUsd(primary.spent)} / $${fmtUsd(primary.budget)}`
          : primary?.spent != null
            ? `${primary.label} $${fmtUsd(primary.spent)}`
            : primary?.budget != null
              ? `${primary.label} budget $${fmtUsd(primary.budget)}`
              : "Refresh after first request",
        sub,
        pct: primary?.leftPct ?? null,
      };
    }
    return {
      headline: "No usage data",
      detail: "Refresh after first request",
      sub: "",
      pct: null,
    };
  }

  function readPercentText(value) {
    const match = String(value || "").trim().match(/(\d+(?:\.\d+)?)%/);
    return match ? readFiniteNumber(match[1]) : null;
  }

  function formatProviderResetText(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const numeric = Number(raw);
    const resetMs = Number.isFinite(numeric)
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1000
      : Date.parse(raw);
    if (!Number.isFinite(resetMs)) return "";
    const remainingMs = resetMs - Date.now();
    if (remainingMs <= 0) return "Reset now";
    const totalMinutes = Math.ceil(remainingMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `Reset in ${days}d ${hours}h`;
    if (hours > 0) return `Reset in ${hours}h ${minutes}m`;
    return `Reset in ${minutes}m`;
  }

  function formatProviderEndsText(provider) {
    const quota = provider?.quota && typeof provider.quota === "object" ? provider.quota : {};
    const value =
      quota.package_expires_at_unix_ms ??
      provider?.manual_pricing_expires_at_unix_ms ??
      provider?.package_expires_at_unix_ms ??
      "";
    const raw = String(value || "").trim();
    if (!raw) return "";
    const numeric = Number(raw);
    const endsMs = Number.isFinite(numeric)
      ? numeric > 10_000_000_000
        ? numeric
        : numeric * 1000
      : Date.parse(raw);
    if (!Number.isFinite(endsMs)) return "";
    const remainingMs = endsMs - Date.now();
    if (remainingMs <= 0) return "Ended";
    const totalMinutes = Math.ceil(remainingMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `Ends in ${days}d ${hours}h`;
    if (hours > 0) return `Ends in ${hours}h ${minutes}m`;
    return `Ends in ${minutes}m`;
  }

  function providerHealthStatus(provider) {
    const health = provider?.health && typeof provider.health === "object" ? provider.health : {};
    return String(health.status || provider?.health_status || provider?.status || "unknown").trim().toLowerCase();
  }

  function providerHealthTone(status) {
    const value = String(status || "").trim().toLowerCase();
    if (/^(healthy|effective|yes|ok)$/.test(value)) return "good";
    if (/^(unhealthy|error|failed|down|no)$/.test(value)) return "bad";
    return "neutral";
  }

  function providerHealthLabel(status) {
    const value = String(status || "").trim().toLowerCase();
    if (!value || value === "unknown") return "Health unknown";
    if (value === "cooldown") return "Retrying";
    if (value === "healthy") return "Healthy";
    if (value === "unhealthy") return "Unhealthy";
    return value.replace(/(^|[_\s-])([a-z])/g, (_match, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`).trim();
  }

  function renderOfficialProfilesHtml(profiles, selectedProfileId = "", disabled = false) {
    const items = Array.isArray(profiles) ? profiles.filter((profile) => profile && typeof profile === "object") : [];
    if (!items.length) {
      return '<span class="settingsProviderOfficialEmpty">No account</span>';
    }
    return items
      .map((profile, index) => {
        const id = String(profile.id || profile.email || profile.label || `official-${index + 1}`).trim();
        const email = String(profile.email || "").trim();
        const label = String(profile.label || `Official account ${index + 1}`).trim();
        const planLabel = String(profile.plan_label || "").trim();
        const fiveHour = String(profile.limit_5h_remaining || "").trim();
        const weekly = String(profile.limit_weekly_remaining || "").trim();
        const fiveHourPct = readPercentText(fiveHour);
        const weeklyPct = readPercentText(weekly);
        const fiveHourReset = fiveHourPct != null && fiveHourPct < 100
          ? formatProviderResetText(profile.limit_5h_reset_at)
          : "";
        const weeklyReset = weeklyPct != null && weeklyPct < 100
          ? formatProviderResetText(profile.limit_weekly_reset_at)
          : "";
        const fiveHourStyle = fiveHourPct == null ? "" : ` style="--provider-usage-pct:${Math.max(0, Math.min(100, fiveHourPct))}%"`;
        const weeklyStyle = weeklyPct == null ? "" : ` style="--provider-usage-pct:${Math.max(0, Math.min(100, weeklyPct))}%"`;
        const selected = String(selectedProfileId || "").trim() === id;
        return `<button class="settingsProviderBtn settingsProviderOfficialAccount${selected ? " is-active" : ""}" type="button" data-provider-target="official" data-official-profile-id="${escapeHtml(id)}" aria-pressed="${selected ? "true" : "false"}"${disabled ? " disabled" : ""}>
          <div class="settingsProviderOfficialHead">
            <span class="settingsProviderOfficialIdentity">
              <span class="settingsProviderOfficialEmailLine">
                <span class="settingsProviderOfficialEmail">${escapeHtml(email || label)}</span>
                ${planLabel ? `<small class="settingsProviderPlanBadge">${escapeHtml(planLabel)}</small>` : ""}
              </span>
              <span class="settingsProviderOfficialLabel">${escapeHtml(email ? label : "Official account")}</span>
            </span>
            <span class="settingsProviderOfficialBadges">
              ${profile.active ? '<small class="settingsProviderActiveBadge">Active</small>' : ""}
            </span>
          </div>
          <div class="settingsProviderOfficialMetric">
            <span>5-hour${fiveHourReset ? ` <small>(${escapeHtml(fiveHourReset)})</small>` : ""}</span>
            <strong>${escapeHtml(fiveHour || "-")}</strong>
          </div>
          <span class="settingsProviderUsageTrack"${fiveHourStyle}></span>
          <div class="settingsProviderOfficialMetric">
            <span>Weekly${weeklyReset ? ` <small>(${escapeHtml(weeklyReset)})</small>` : ""}</span>
            <strong>${escapeHtml(weekly || "-")}</strong>
          </div>
          <span class="settingsProviderUsageTrack"${weeklyStyle}></span>
        </button>`;
      })
      .join("");
  }

  function providerModeLabel(mode, provider = "") {
    const value = String(mode || "").trim().toLowerCase();
    if (value === "provider") return provider ? provider : "Direct provider";
    if (value === "gateway") return "Gateway";
    if (value === "official") return "Official";
    if (value === "mixed") return "Mixed";
    if (value === "unavailable") return "Config only";
    return "-";
  }

  function providerScopeLabel(scope) {
    const value = String(scope || "").trim().toLowerCase();
    if (value === "windows") return "Windows";
    if (value === "wsl2") return "WSL2";
    return "Windows";
  }

  function providerDirLabel(dir, index) {
    const raw = String(dir?.cli_home || "").replace(/\//g, "\\").toLowerCase();
    if (raw.includes("\\\\wsl.localhost\\") || raw.includes("\\\\wsl$\\")) return "WSL2";
    if (raw.includes("/home/") || raw.startsWith("/")) return "WSL2";
    if (raw.includes("\\user-data\\codex-home") || raw.endsWith("\\codex-home")) return "Windows";
    if (index === 1) return "WSL2";
    return "Windows";
  }

  function readQueuedTurns() {
    if (Array.isArray(state.activeThreadQueuedTurns)) {
      return state.activeThreadQueuedTurns.filter((item) => item && typeof item === "object");
    }
    if (state.activeThreadQueuedTurn && typeof state.activeThreadQueuedTurn === "object") {
      return [state.activeThreadQueuedTurn];
    }
    return [];
  }

  function queuedModeLabel(mode) {
    const normalized = String(mode || "").trim().toLowerCase();
    if (normalized === "steer") return "Steer";
    if (normalized === "send-now") return "Send now";
    return "Follow-up";
  }

  function queuedModeDescription(mode) {
    const normalized = String(mode || "").trim().toLowerCase();
    if (normalized === "steer") return "After next tool call";
    if (normalized === "send-now") return "Interrupt and send now";
    return "After current turn";
  }

  function readCommandFromPayload(value) {
    if (!value) return "";
    if (typeof value === "string") {
      const raw = value.trim();
      if (!raw) return "";
      try {
        const parsed = JSON.parse(raw);
        return readCommandFromPayload(parsed);
      } catch {
        return raw;
      }
    }
    if (typeof value !== "object") return "";
    return readText(value.command || value.cmd || value.script);
  }

  function summarizeSnippet(value, maxChars = 88) {
    const raw = String(value || "").replace(/\r\n/g, "\n").trim();
    if (!raw) return { preview: "", extraLines: 0, full: "" };
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
      full: raw,
    };
  }

  function buildToolEntryKey(item, text, identity = "") {
    const itemId = String(item?.id || item?.itemId || item?.item_id || item?.callId || item?.call_id || "").trim();
    if (itemId) return itemId;
    const seed = String(identity || "").trim();
    if (seed) return `${String(item?.type || "tool")}::${seed}`;
    return `${String(item?.type || "tool")}::${String(text || "").trim()}`;
  }

  function stripWrappingBackticks(value) {
    const raw = readText(value);
    if (!raw) return "";
    const match = raw.match(/^`(.+)`$/);
    return match ? match[1].trim() : raw;
  }

  function stripInlineCodeMarkdown(value) {
    const raw = readText(value);
    if (!raw) return "";
    return raw
      .replace(/`{1,3}([^`]+?)`{1,3}/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isMeaninglessGenericToolPlaceholder(compactText, toolName, server) {
    if (readText(toolName) || readText(server)) return false;
    const normalized = readText(compactText)
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return (
      !normalized ||
      normalized === "tool" ||
      normalized === "running tool tool" ||
      normalized === "called tool tool" ||
      normalized === "tool failed tool"
    );
  }

  function deriveToolRuntimeState(item, options = {}) {
    const explicitStatus = readText(item?.status);
    if (explicitStatus) return normalizeRunningState(explicitStatus, "complete");
    const method = normalizeType(options.method);
    if (method.endsWith("itemstarted") || method.endsWith("turnstarted")) return "running";
    if (
      method.endsWith("itemcompleted") ||
      method.endsWith("turncompleted") ||
      method.endsWith("turnfinished")
    ) {
      return "complete";
    }
    if (method.endsWith("turnfailed") || method.endsWith("turncancelled")) {
      return "error";
    }
    return "complete";
  }

  function describeToolItem(item, options = {}) {
    const itemType = normalizeType(item?.type);
    if (!itemType || itemType === "plan" || itemType === "usermessage" || itemType === "assistantmessage" || itemType === "agentmessage") {
      return null;
    }
    const compactMessage = toolItemToMessage(item, { compact: true, method: options.method });
    const compactText = readText(compactMessage);
    const status = deriveToolRuntimeState(item, options);
    const toolName = readText(item?.tool || item?.name);
    const lowerToolName = normalizeType(toolName);
    if (compactMessage == null && lowerToolName === "writestdin") {
      return null;
    }
    if (lowerToolName === "requestuserinput") {
      return null;
    }
    const directCommand = readText(item?.command || item?.cmd);
    const payloadCommand = readCommandFromPayload(item?.arguments || item?.input || item?.args);
    const command = directCommand || payloadCommand;
    if (itemType === "commandexecution" || (/shellcommand/.test(lowerToolName) && command)) {
      const identity = command || compactText;
      return {
        key: buildToolEntryKey(item, compactText || command, identity),
        text: compactText || command,
        state: status,
        icon: "command",
        presentation: "code",
        title: status === "error" ? "Command failed" : status === "running" ? "Running command" : "Ran command",
        detail: command,
        label: command || stripWrappingBackticks(compactText),
      };
    }
    if (itemType === "websearch") {
      const query = readText(item?.query || item?.action?.query || item?.action?.url);
      return {
        key: buildToolEntryKey(item, compactText || query || "Searching web", query || compactText),
        text: compactText || (query ? `Searching web: ${query}` : "Searching web"),
        state: status,
        icon: "search",
        presentation: "text",
        title: status === "error" ? "Web search failed" : status === "running" ? "Searching web" : "Searched web",
        detail: query,
        label: query || "Searching web",
      };
    }
    if (itemType === "filechange") {
      const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
      const label = changeCount > 0 ? `${String(changeCount)} file change(s)` : "Apply file changes";
      return {
        key: buildToolEntryKey(item, compactText || label, label),
        text: compactText || label,
        state: status,
        icon: "patch",
        presentation: "text",
        title: status === "error" ? "File changes failed" : status === "running" ? "Applying file changes" : "Applied file changes",
        detail: label,
        label,
      };
    }
    const server = readText(item?.server);
    if (isMeaninglessGenericToolPlaceholder(compactText, toolName, server)) {
      return null;
    }
    const compactLabel = stripInlineCodeMarkdown(compactText);
    const genericLabel = compactLabel || [server, toolName].filter(Boolean).join(" / ") || stripWrappingBackticks(compactText) || "Tool";
    let icon = "tool";
    let title = "Running tool";
    if (lowerToolName === "applypatch") {
      icon = "patch";
      title = status === "complete" ? "Edited files" : "Editing files";
    } else if (lowerToolName === "requestuserinput") {
      icon = "input";
      title = "Waiting for input";
    } else if (lowerToolName === "spawnagent") {
      icon = "agent";
      title = "Spawning agent";
    } else if (lowerToolName === "sendinput") {
      icon = "agent";
      title = "Sending input to agent";
    } else if (lowerToolName === "wait") {
      icon = "agent";
      title = "Waiting for agent";
    } else if (lowerToolName === "viewimage") {
      icon = "image";
      title = "Viewing image";
    }
    const identity = [server, toolName, compactText].filter(Boolean).join(" / ") || genericLabel;
    return {
      key: buildToolEntryKey(item, compactText || genericLabel, identity),
      text: compactText || genericLabel,
      state: status,
      icon,
      presentation: "text",
      title: status === "error" ? "Tool failed" : status === "complete" ? "Tool finished" : title,
      detail: genericLabel,
      label: genericLabel,
    };
  }

  function toActiveCommandEntry(item, options = {}) {
    const meta = describeToolItem(item, options);
    if (!meta) return null;
    return {
      key: meta.key,
      text: meta.text,
      state: meta.state,
      icon: meta.icon,
      title: meta.title,
      detail: meta.detail,
      label: meta.label || meta.detail || meta.text,
      presentation: meta.presentation || "text",
      timestamp: Number(options.timestamp || Date.now()),
    };
  }

  function toActivityFromEntry(entry) {
    if (!entry) return null;
    return {
      title: entry.title || "Working",
      detail: entry.detail || "",
      tone: entry.state || "running",
    };
  }

  function normalizeActivity(activity, threadId) {
    if (!activity) return null;
    return {
      threadId: String(activity.threadId || threadId || resolveCurrentThreadId(state) || ""),
      title: activity.title || "",
      detail: activity.detail || "",
      tone: activity.tone || "running",
    };
  }

  function resolveRuntimeActivity(threadId, options = {}) {
    const currentThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
    const commands = Array.isArray(options.commands) ? options.commands : [];
    const latestRunning = commands.length ? commands[commands.length - 1] : null;
    const plan = options.plan || null;
    const commentary = options.commentary || null;
    const explicitActivity = options.explicitActivity || null;
    const pendingThreadId = String(options.pendingThreadId || state.activeThreadPendingTurnThreadId || "").trim();
    const pendingTurnRunning = options.pendingTurnRunning === true;
    const pendingTurnActivity =
      pendingTurnRunning && pendingThreadId && pendingThreadId === currentThreadId
        ? {
            threadId: currentThreadId,
            title: "Thinking",
            detail: "",
            tone: "running",
          }
        : null;
    return normalizeActivity(
      pendingTurnActivity ||
        explicitActivity ||
        (latestRunning ? { threadId: currentThreadId, ...toActivityFromEntry(latestRunning) } : null) ||
        (commentary
          ? {
              threadId: currentThreadId,
              title: String(commentary.text || "").trim() ? "Thinking" : "Working",
              detail: String(commentary.text || "").trim(),
              tone: "running",
            }
          : null) ||
        (plan
          ? {
              threadId: currentThreadId,
              title: "Planning",
              detail: plan.explanation || "",
              tone: "running",
            }
          : null) ||
        (options.allowIncompletePlaceholder === true
          ? {
              threadId: currentThreadId,
              title: "Thinking",
              detail: "",
              tone: "running",
            }
          : null),
      currentThreadId
    );
  }

  function renderActivityHtml(activity) {
    if (!activity) return "";
    const tone = normalizeRunningState(activity.tone, "running");
    const title = readText(activity.title);
    const detail = readText(activity.detail);
    const shouldShowLabel =
      tone === "error" || /^reconnecting$/i.test(title);
    const dots = '<span class="runtimeActivityDots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
    const enterClass = state.chatOpening === true ? "" : " runtimeActivityEnter";
    const labelHtml = shouldShowLabel
      ? `<span class="runtimeActivityText"><strong>${escapeHtml(title || (tone === "error" ? "Error" : "Reconnecting"))}</strong>${
        detail ? ` <span>${escapeHtml(detail)}</span>` : ""
      }</span>`
      : `<span class="runtimeActivityText"><strong>working</strong></span>`;
    return (
      `<div class="runtimeActivity${enterClass}" data-activity-tone="${escapeHtml(tone)}">` +
        `${labelHtml}` +
        `${dots}` +
      `</div>`
    );
  }

  function buildRuntimeAnimationIdentity(entry) {
    const icon = normalizeType(entry?.icon || "tool");
    const presentation = normalizeType(entry?.presentation || "text");
    const label = readRuntimeEntrySummary(entry)
      .replace(/\s+/g, " ")
      .trim();
    return [icon, presentation, label].filter(Boolean).join("::");
  }

  function readRuntimeEntrySummary(entry) {
    const rawText = String(entry?.text || "").trim();
    if (/^(?:Running|Ran|Read|Command failed|Read failed|Searching web|Searched web)\s+`/i.test(rawText)) {
      return rawText;
    }
    if (normalizeType(entry?.icon || "tool") === "patch" && /^Edited\s+`[^`]+`(?:\s+\(\+\d+\s+-\d+\))?$/i.test(rawText)) {
      return rawText;
    }
    return String(entry?.label || entry?.detail || entry?.text || "");
  }

  function renderCommandEntryHtml(entry) {
    const summaryText = readRuntimeEntrySummary(entry);
    const snippet = summarizeSnippet(summaryText);
    const icon = escapeHtml(String(entry?.icon || "tool"));
    const stateName = escapeHtml(String(entry?.state || "complete"));
    const animationIdentity = buildRuntimeAnimationIdentity(entry) || String(entry?.key || "").trim();
    const animationKey = `${String(resolveCurrentThreadId(state) || "")}::${animationIdentity}`;
    const shouldAnimateEnter = animationKey && !animatedRuntimeEntryKeys.has(animationKey);
    if (shouldAnimateEnter) animatedRuntimeEntryKeys.add(animationKey);
    const usesStructuredToolSummary = /^(?:Running|Ran|Read|Command failed|Read failed|Running tool|Called tool|Tool failed|Searching web|Searched web)\s+/i.test(summaryText);
    const previewHtml = snippet.preview
      ? (
        usesStructuredToolSummary
          ? renderStructuredToolPreviewHtml(summaryText, {
              className: "runtimeToolItemPreview",
              moreClassName: "runtimeToolItemMeta",
            })
          : renderToolPreviewHtml(snippet.preview, {
              code: entry?.presentation === "code",
              className: "runtimeToolItemPreview",
              diffPrefix: "runtimeToolItem",
            })
      )
      : "";
    const moreHtml = snippet.extraLines > 0
      && !usesStructuredToolSummary
      ? `<span class="runtimeToolItemMeta">+${String(snippet.extraLines)} lines</span>`
      : "";
    const moreSpacer = previewHtml && moreHtml ? " " : "";
    const enterClass = shouldAnimateEnter && state.chatOpening !== true ? " runtimeToolItemEnter" : "";
    return (
      `<div class="runtimeToolItem${enterClass} state-${stateName} icon-${icon}" data-command-key="${escapeHtml(entry?.key || "")}">` +
        `<span class="runtimeToolItemLead" aria-hidden="true"></span>` +
        `<span class="runtimeToolItemText">${previewHtml}${moreSpacer}${moreHtml}</span>` +
        `<span class="runtimeToolItemTail" aria-hidden="true"></span>` +
      `</div>`
    );
  }

  function renderQueuedTurnItemHtml(item, options = {}) {
    const queuedId = escapeHtml(String(item?.id || ""));
    const modeLabel = escapeHtml(queuedModeLabel(item?.mode));
    const description = escapeHtml(queuedModeDescription(item?.mode));
    const preview = escapeHtml(String(item?.prompt || ""));
    const isEditing = options.isEditing === true;
    const positionLabel = options.index === 0 ? "Next" : `#${String(options.index + 1)}`;
    const editingDraft = escapeHtml(String(options.editingDraft || ""));
    const canSendNow = options.canSendNow === true && !isEditing;
    const modeName = escapeHtml(String(item?.mode || "queue").trim().toLowerCase() || "queue");
    const actions = isEditing
      ? (
        `<button class="queuedTurnItemBtn primary" type="button" data-queued-action="save" data-queued-id="${queuedId}"><span class="queuedTurnItemBtnLabel">Save</span></button>` +
        `<button class="queuedTurnItemBtn" type="button" data-queued-action="cancel" data-queued-id="${queuedId}"><span class="queuedTurnItemBtnLabel">Cancel</span></button>`
      )
      : (
        `<button class="queuedTurnItemBtn" type="button" data-queued-action="edit" data-queued-id="${queuedId}"><span class="queuedTurnItemBtnLabel">Edit</span></button>` +
        (canSendNow
          ? `<button class="queuedTurnItemBtn" type="button" data-queued-action="send-now" data-queued-id="${queuedId}"><span class="queuedTurnItemBtnLabel">Send now</span></button>`
          : "") +
        `<button class="queuedTurnItemBtn icon" type="button" aria-label="Remove queued message" data-queued-action="remove" data-queued-id="${queuedId}">` +
          `<svg class="queuedTurnItemBtnCloseIcon" viewBox="0 0 12 12" focusable="false" aria-hidden="true">` +
            `<path d="M3 3 9 9M9 3 3 9"></path>` +
          `</svg>` +
        `</button>`
      );
    const body = isEditing
      ? (
        `<div class="queuedTurnItemEditorWrap">` +
          `<textarea class="queuedTurnItemEditor" rows="3" data-queued-editor="${queuedId}" placeholder="Edit queued message">${editingDraft}</textarea>` +
        `</div>`
      )
      : (
        `<div class="queuedTurnItemPromptShell"><div class="queuedTurnItemPrompt">${preview}</div></div>`
      );
    return (
      `<div class="queuedTurnItem${isEditing ? " is-editing" : ""}" data-queued-id="${queuedId}" data-queued-mode="${modeName}">` +
        `<div class="queuedTurnItemTopRow">` +
          `<div class="queuedTurnItemMeta">` +
            `<span class="queuedTurnItemChip">${escapeHtml(positionLabel)}</span>` +
            `<span class="queuedTurnItemMode" data-mode="${modeName}">${modeLabel}</span>` +
            `<span class="queuedTurnItemDesc">${description}</span>` +
          `</div>` +
          `<div class="queuedTurnItemActions">${actions}</div>` +
        `</div>` +
        `<div class="queuedTurnItemBody">${body}</div>` +
      `</div>`
    );
  }

  function renderPlanHtml(plan) {
    if (!plan) return "";
    const planAnimationKey = `${String(resolveCurrentThreadId(state) || "")}::runtime-plan`;
    const shouldAnimateEnter = planAnimationKey && !animatedRuntimePlanKeys.has(planAnimationKey);
    if (shouldAnimateEnter) animatedRuntimePlanKeys.add(planAnimationKey);
    return renderPlanCardHtml(plan, {
      escapeHtml,
      normalizeType,
      renderRichTextHtml: renderMessageRichHtml,
      animateEnter: shouldAnimateEnter && state.chatOpening !== true,
    });
  }

  function renderThinkingHtml(text) {
    const body = renderInlineMessageText(String(text || "").trim());
    if (!body) return "";
    return (
      `<div class="runtimeThinkingCard">` +
        `<div class="runtimeThinkingBody">${body}</div>` +
      `</div>`
    );
  }

  function animateRuntimeSectionRefresh(node) {
    if (!node || !node.classList) return;
    if (state.chatOpening === true) return;
    node.classList.remove("is-refreshing");
    scheduleFrame(() => {
      node.classList.add("is-refreshing");
      const clear = () => node.classList.remove("is-refreshing");
      if (typeof node.addEventListener === "function") {
        node.addEventListener("animationend", clear, { once: true });
      } else {
        clear();
      }
    });
  }

  function setRuntimeSectionVisible(node, visible) {
    if (!node || !node.classList) return;
    const wantsVisible = visible === true;
    if (wantsVisible) {
      if (node.__runtimeSectionVisible === true && !node.classList.contains("is-hidden")) return;
      node.__runtimeSectionVisible = true;
      node.style.display = "";
      if (state.chatOpening === true) {
        node.classList.remove("is-hidden");
        return;
      }
      scheduleFrame(() => {
        if (node.__runtimeSectionVisible === true) node.classList.remove("is-hidden");
      });
      return;
    }
    if (node.__runtimeSectionVisible === false && node.classList.contains("is-hidden")) return;
    node.__runtimeSectionVisible = false;
    node.classList.add("is-hidden");
    const hide = () => {
      if (node.__runtimeSectionVisible === false) node.style.display = "none";
    };
    if (typeof node.addEventListener === "function") {
      node.addEventListener("transitionend", hide, { once: true });
    } else {
      hide();
    }
  }

  function renderRuntimePanels() {
    const dock = byId("runtimeDock");
    const activityNode = byId("runtimeActivityBar");
    const statusTrayMount = byId("statusTrayMount");
    const statusTrayTitle = byId("statusTrayTitle");
    const statusTraySessionValue = byId("statusTraySessionValue");
    if (!dock || !activityNode) return;
    const inChat = state.activeMainTab !== "settings";
    const currentThreadId = resolveCurrentThreadId(state);
    const commands = Array.isArray(state.activeThreadActiveCommands)
      ? state.activeThreadActiveCommands.slice(-MAX_VISIBLE_ACTIVE_COMMANDS)
      : [];
    const plan = state.activeThreadPlan && state.activeThreadPlan.threadId === currentThreadId
      ? state.activeThreadPlan
      : null;
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === currentThreadId
      ? state.activeThreadCommentaryCurrent
      : null;
    const thinkingText = String(state.activeThreadTransientThinkingText || commentary?.text || "").trim();
    const explicitActivity = state.activeThreadActivity && state.activeThreadActivity.threadId === currentThreadId
      ? state.activeThreadActivity
      : null;
    const connectionStatusKind = String(state.activeThreadConnectionStatusKind || "").trim();
    const connectionStatusText = String(state.activeThreadConnectionStatusText || "").trim();
    const statusCard = state.activeThreadStatusCard &&
      String(state.activeThreadStatusCard.threadId || "").trim() === currentThreadId
      ? state.activeThreadStatusCard
      : null;
    const activity = resolveRuntimeActivity(currentThreadId, {
      commands,
      plan,
      commentary,
      explicitActivity,
      pendingThreadId: state.activeThreadPendingTurnThreadId,
      pendingTurnRunning: state.activeThreadPendingTurnRunning === true,
    });
    const runtimeRenderSig = JSON.stringify({
      threadId: String(currentThreadId || ""),
      inChat,
      commands: commands.map((entry) => ({
        key: String(entry?.key || ""),
        state: String(entry?.state || ""),
        text: String(entry?.text || ""),
        label: String(entry?.label || ""),
        detail: String(entry?.detail || ""),
        icon: String(entry?.icon || ""),
      })),
      plan: plan
        ? {
            threadId: String(plan.threadId || ""),
            turnId: String(plan.turnId || ""),
            title: String(plan.title || ""),
            explanation: String(plan.explanation || ""),
            deltaText: String(plan.deltaText || ""),
            steps: Array.isArray(plan.steps)
              ? plan.steps.map((step) => ({
                  step: String(step?.step || ""),
                  status: String(step?.status || ""),
                }))
              : [],
          }
        : null,
      thinkingText,
      activity: activity
        ? {
            threadId: String(activity.threadId || ""),
            title: String(activity.title || ""),
            detail: String(activity.detail || ""),
            tone: String(activity.tone || ""),
          }
        : null,
      statusCard: statusCard
        ? {
            threadId: String(statusCard.threadId || ""),
            title: String(statusCard.title || ""),
            sessionId: String(statusCard.sessionId || ""),
          }
        : null,
      connectionStatusKind,
      connectionStatusText,
      pendingThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      pendingTurnRunning: state.activeThreadPendingTurnRunning === true,
    });
    if (lastRuntimePanelsRenderSig === runtimeRenderSig) return;
    lastRuntimePanelsRenderSig = runtimeRenderSig;
    const chatBox = byId("chatBox");
    let chatMount = null;
    let planNode = null;
    let thinkingNode = null;
    let commandNode = null;
    if (chatBox && inChat) {
      chatMount = chatBox.querySelector("#runtimeChatPanels");
      if (!chatMount) {
        chatMount = doc.createElement("div");
        chatMount.id = "runtimeChatPanels";
        chatMount.className = "runtimeChatPanels";
        planNode = doc.createElement("div");
        planNode.id = "runtimePlanInline";
        planNode.className = "runtimePlanMount runtimeStackSection is-hidden";
        planNode.style.display = "none";
        thinkingNode = doc.createElement("div");
        thinkingNode.id = "runtimeThinkingInline";
        thinkingNode.className = "runtimeThinkingMount runtimeStackSection is-hidden";
        thinkingNode.style.display = "none";
        commandNode = doc.createElement("div");
        commandNode.id = "runtimeToolInline";
        commandNode.className = "runtimeToolPanel runtimeToolPanel-inline runtimeStackSection is-hidden";
        commandNode.style.display = "none";
        chatMount.appendChild(planNode);
        chatMount.appendChild(thinkingNode);
        chatMount.appendChild(commandNode);
      } else {
        planNode = chatMount.querySelector("#runtimePlanInline");
        thinkingNode = chatMount.querySelector("#runtimeThinkingInline");
        commandNode = chatMount.querySelector("#runtimeToolInline");
      }
    }
    const updateHtmlIfChanged = (node, html) => {
      if (!node) return;
      const nextHtml = String(html || "");
      if (node.__runtimeHtml === nextHtml) return;
      const hadHtml = !!String(node.__runtimeHtml || "");
      node.innerHTML = nextHtml;
      node.__runtimeHtml = nextHtml;
      if (hadHtml && nextHtml) animateRuntimeSectionRefresh(node);
    };
    const updateTextIfChanged = (node, text) => {
      if (!node) return;
      const nextText = String(text || "");
      if (node.__runtimeText === nextText) return;
      node.textContent = nextText;
      node.__runtimeText = nextText;
    };

    if (planNode) {
      updateHtmlIfChanged(planNode, plan ? renderPlanHtml(plan) : "");
      setRuntimeSectionVisible(planNode, !!plan);
    }
    if (thinkingNode) {
      updateHtmlIfChanged(thinkingNode, thinkingText ? renderThinkingHtml(thinkingText) : "");
      setRuntimeSectionVisible(thinkingNode, !!thinkingText);
    }
    if (commandNode) {
      updateHtmlIfChanged(commandNode, commands.length ? commands.map(renderCommandEntryHtml).join("") : "");
      setRuntimeSectionVisible(commandNode, commands.length > 0);
    }
    if (statusTrayMount) {
      updateTextIfChanged(statusTrayTitle, statusCard ? String(statusCard.title || "Status").trim() || "Status" : "");
      updateTextIfChanged(statusTraySessionValue, statusCard ? String(statusCard.sessionId || "").trim() || "Unavailable" : "");
      if (statusTraySessionValue?.classList?.toggle) {
        statusTraySessionValue.classList.toggle("is-empty", !!statusCard && !String(statusCard.sessionId || "").trim());
      }
      setRuntimeSectionVisible(statusTrayMount, !!statusCard);
    }
    updateHtmlIfChanged(activityNode, activity ? renderActivityHtml(activity) : "");
    activityNode.style.display = activity ? "" : "none";
    if (chatMount && chatBox) {
      if (plan || thinkingText || commands.length) {
        const pendingMount = chatBox.querySelector?.("#pendingInlineMount") || null;
        const pendingParent = pendingMount?.parentElement || pendingMount?.parentNode || null;
        if (pendingMount && pendingParent === chatBox) {
          if (chatMount.nextSibling !== pendingMount || chatMount.parentElement !== chatBox) {
            chatBox.insertBefore(chatMount, pendingMount);
          }
        } else {
          const lastChild = Array.isArray(chatBox.children) ? chatBox.children[chatBox.children.length - 1] : null;
          if (lastChild !== chatMount) chatBox.appendChild(chatMount);
        }
      } else {
        chatMount.remove();
      }
    }
    dock.style.display = inChat && activity ? "" : "none";
    updateMobileComposerState();
  }

  function clearRuntimeState() {
    animatedRuntimeEntryKeys.clear();
    animatedRuntimePlanKeys.clear();
    state.activeThreadActivity = null;
    state.activeThreadActiveCommands = [];
    state.activeThreadPlan = null;
    lastRuntimePanelsRenderSig = "";
    renderRuntimePanels();
  }

  function assignRuntimeActivity(activity) {
    state.activeThreadActivity = activity
      ? { threadId: String(activity.threadId || resolveCurrentThreadId(state) || ""), title: activity.title || "", detail: activity.detail || "", tone: activity.tone || "running" }
      : null;
  }

  function setRuntimeActivity(activity) {
    assignRuntimeActivity(activity);
    renderRuntimePanels();
  }

  function assignThreadStatusCard(card) {
    const threadId = String(card?.threadId || resolveCurrentThreadId(state) || card?.sessionId || "").trim();
    const sessionId = String(card?.sessionId || card?.session_id || "").trim();
    if (!threadId && !sessionId) {
      state.activeThreadStatusCard = null;
      return null;
    }
    state.activeThreadStatusCard = {
      threadId,
      title: String(card?.title || "Status").trim() || "Status",
      sessionId,
    };
    return state.activeThreadStatusCard;
  }

  function setThreadStatusCard(card) {
    assignThreadStatusCard(card);
    renderRuntimePanels();
  }

  function clearThreadStatusCard(threadId = resolveCurrentThreadId(state)) {
    const current = state.activeThreadStatusCard;
    if (!current) return false;
    const normalizedThreadId = String(threadId || "").trim();
    if (normalizedThreadId && String(current.threadId || "").trim() !== normalizedThreadId) return false;
    state.activeThreadStatusCard = null;
    renderRuntimePanels();
    return true;
  }

  function upsertActiveCommand(entry) {
    if (!entry) return;
    const next = Array.isArray(state.activeThreadActiveCommands) ? [...state.activeThreadActiveCommands] : [];
    const hasRunning = next.some((item) => item && item.state === "running");
    const index = next.findIndex((item) => item && item.key === entry.key);
    const commentaryThreadId = String(state.activeThreadCommentaryCurrent?.threadId || "").trim();
    const commentaryActive = !!commentaryThreadId && commentaryThreadId === resolveCurrentThreadId(state);
    if (entry.state === "running" && !hasRunning && next.length > 0 && index < 0 && !commentaryActive) {
      next.splice(0, next.length);
    }
    if (index >= 0) next[index] = { ...next[index], ...entry };
    else next.push(entry);
    state.activeThreadActiveCommands = next.slice(-Math.max(MAX_VISIBLE_ACTIVE_COMMANDS, 6));
    renderRuntimePanels();
  }

  function removeActiveCommand(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return false;
    const next = Array.isArray(state.activeThreadActiveCommands)
      ? state.activeThreadActiveCommands.filter((item) => String(item?.key || "").trim() !== normalizedKey)
      : [];
    if (next.length === (Array.isArray(state.activeThreadActiveCommands) ? state.activeThreadActiveCommands.length : 0)) {
      return false;
    }
    state.activeThreadActiveCommands = next;
    renderRuntimePanels();
    return true;
  }

  function assignActiveCommands(entries) {
    state.activeThreadActiveCommands = Array.isArray(entries) ? entries.slice(-Math.max(MAX_VISIBLE_ACTIVE_COMMANDS, 6)) : [];
  }

  function setActiveCommands(entries) {
    assignActiveCommands(entries);
    renderRuntimePanels();
  }

  function assignActivePlan(plan) {
    state.activeThreadPlan = plan
      ? {
          threadId: String(plan.threadId || resolveCurrentThreadId(state) || ""),
          turnId: String(plan.turnId || ""),
          title: String(plan.title || "Plan").trim() || "Plan",
          explanation: String(plan.explanation || "").trim(),
          steps: Array.isArray(plan.steps) ? plan.steps : [],
          deltaText: String(plan.deltaText || "").trim(),
        }
      : null;
  }

  function setActivePlan(plan) {
    assignActivePlan(plan);
    renderRuntimePanels();
  }

  function syncRuntimeActivityFromState(threadId = resolveCurrentThreadId(state)) {
    const currentThreadId = String(threadId || resolveCurrentThreadId(state) || "").trim();
    const plan = state.activeThreadPlan && state.activeThreadPlan.threadId === currentThreadId
      ? state.activeThreadPlan
      : null;
    const commands = Array.isArray(state.activeThreadActiveCommands)
      ? state.activeThreadActiveCommands.filter((entry) => entry && entry.state === "running")
      : [];
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === currentThreadId
      ? state.activeThreadCommentaryCurrent
      : null;
    setRuntimeActivity(resolveRuntimeActivity(currentThreadId, {
      commands,
      plan,
      commentary,
    }));
  }

  function syncRuntimeStateFromHistory(thread) {
    const threadId = String(thread?.id || resolveCurrentThreadId(state) || "").trim();
    const currentThreadId = resolveCurrentThreadId(state, threadId);
    const suppressSyntheticPending = state.suppressedSyntheticPendingUserInputsByThreadId?.[threadId] === true;
    const suppressIncompleteRuntime = state.suppressedIncompleteHistoryRuntimeByThreadId?.[threadId] === true;
    const terminalHistory = isTerminalHistoryStatus(thread?.status?.type || state.activeThreadHistoryStatusType);
    const pageIncomplete = !!thread?.page?.incomplete && !terminalHistory;
    const interruptedHistory = isTerminalInterruptedHistory(thread, state);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
    if (!pageIncomplete || interruptedHistory || !threadId || threadId !== currentThreadId) {
      if (threadId) clearProposedPlanConfirmation(state, threadId);
      if (
        threadId &&
        state.suppressedIncompleteHistoryRuntimeByThreadId &&
        state.suppressedIncompleteHistoryRuntimeByThreadId[threadId] === true
      ) {
        delete state.suppressedIncompleteHistoryRuntimeByThreadId[threadId];
      }
      if (threadId) setSyntheticPendingUserInputs(threadId, []);
      clearRuntimeState();
      return;
    }
    if (suppressIncompleteRuntime) {
      clearProposedPlanConfirmation(state, threadId);
      setSyntheticPendingUserInputs(threadId, []);
      clearRuntimeState();
      return;
    }
    const commands = [];
    let latestRunning = null;
    let plan = null;
    let latestCommentaryIndex = -1;
    let hasVisibleAssistant = false;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const type = String(item?.type || "").trim();
      if (type !== "assistantMessage" && type !== "agentMessage") continue;
      const phase = String(item?.phase || "").trim().toLowerCase();
      if (phase && phase !== "final_answer") {
        latestCommentaryIndex = index;
        continue;
      }
      hasVisibleAssistant = true;
    }
    if (hasVisibleAssistant) {
      clearProposedPlanConfirmation(state, threadId);
      setSyntheticPendingUserInputs(threadId, []);
      if (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === threadId) {
        state.activeThreadCommentaryCurrent = null;
      }
      if (String(state.activeThreadTransientThinkingText || "").trim()) {
        state.activeThreadTransientThinkingText = "";
      }
      clearRuntimeState();
      return;
    }
    const syntheticUserInputs = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const type = String(item?.type || "").trim();
      if (!type) continue;
      const updatePlan = extractPlanUpdate(item, { threadId, normalizeType });
      if (updatePlan) {
        plan = updatePlan;
        continue;
      }
      const requestUserInput = extractRequestUserInput(item, { normalizeType });
      if (requestUserInput && !suppressSyntheticPending) {
        syntheticUserInputs.push(requestUserInput);
      }
      if (type === "userMessage" || type === "assistantMessage" || type === "agentMessage") continue;
      if (latestCommentaryIndex >= 0 && !hasVisibleAssistant && index < latestCommentaryIndex) continue;
      const entry = toActiveCommandEntry(item);
      if (!entry) continue;
      commands.push(entry);
      if (isRuntimeActiveState(entry.state)) latestRunning = entry;
    }
    setSyntheticPendingUserInputs(threadId, syntheticUserInputs);
    assignActivePlan(plan);
    assignActiveCommands(commands);
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === threadId
      ? state.activeThreadCommentaryCurrent
      : null;
    assignRuntimeActivity(resolveRuntimeActivity(threadId, {
      commands: latestRunning ? [latestRunning] : [],
      plan,
      commentary,
      allowIncompletePlaceholder: suppressSyntheticPending !== true && pageIncomplete && commands.length === 0 && !syntheticUserInputs.length,
    }));
    renderRuntimePanels();
  }

  function applyToolItemRuntimeUpdate(item, options = {}) {
    const currentThreadId = resolveCurrentThreadId(state);
    const threadId = String(options.threadId || currentThreadId || "").trim();
    if (!threadId || threadId !== currentThreadId) return;
    const planUpdate = extractPlanUpdate(item, { threadId, normalizeType });
    if (planUpdate) {
      setRuntimeActivity({
        threadId,
        title: "Updated Plan",
        detail: planUpdate.explanation || "",
        tone: "running",
      });
      setActivePlan(planUpdate);
      return;
    }
    const requestUserInput = extractRequestUserInput(item, { normalizeType });
    if (requestUserInput) {
      if (state.suppressedSyntheticPendingUserInputsByThreadId?.[threadId] === true) {
        delete state.suppressedSyntheticPendingUserInputsByThreadId[threadId];
      }
      upsertSyntheticPendingUserInput(threadId, requestUserInput);
    }
    const entry = toActiveCommandEntry(item, options);
    if (!entry) return;
    if (isRuntimeActiveState(entry.state)) {
      const activity = toActivityFromEntry(entry);
      if (activity) setRuntimeActivity({ threadId, ...activity });
      upsertActiveCommand(entry);
      return;
    }
    upsertActiveCommand(entry);
    syncRuntimeActivityFromState(threadId);
  }

  function applyPlanDeltaUpdate(payload = {}) {
    const currentThreadId = resolveCurrentThreadId(state);
    const threadId = String(payload.threadId || payload.thread_id || currentThreadId || "").trim();
    if (!threadId || threadId !== currentThreadId) return;
    const turnId = String(payload.turnId || payload.turn_id || "").trim();
    const delta = String(payload.delta || "").trim();
    const previous = state.activeThreadPlan && state.activeThreadPlan.threadId === threadId
      ? state.activeThreadPlan
      : { threadId, turnId, title: "Updated Plan", explanation: "", steps: [], deltaText: "" };
    setActivePlan({
      ...previous,
      threadId,
      turnId: turnId || previous.turnId || "",
      title: previous.title || "Updated Plan",
      deltaText: `${String(previous.deltaText || "")}${delta}`,
    });
    setRuntimeActivity({ threadId, title: "Planning", detail: "", tone: "running" });
  }

  function applyPlanSnapshotUpdate(payload = {}) {
    const currentThreadId = resolveCurrentThreadId(state);
    const threadId = String(payload.threadId || payload.thread_id || currentThreadId || "").trim();
    if (!threadId || threadId !== currentThreadId) return;
    const turnId = String(payload.turnId || payload.turn_id || "").trim();
    const steps = Array.isArray(payload.plan) ? payload.plan : [];
    setActivePlan({
      threadId,
      turnId,
      title: "Updated Plan",
      explanation: String(payload.explanation || "").trim(),
      steps: steps.map((step) => ({
        step: String(step?.step || "").trim(),
        status: normalizeType(step?.status) || "pending",
      })).filter((step) => step.step),
      deltaText: "",
    });
    setRuntimeActivity({
      threadId,
      title: "Planning",
      detail: String(payload.explanation || "").trim(),
      tone: "running",
    });
  }

  function finalizeRuntimeState(threadId = "") {
    const currentThreadId = resolveCurrentThreadId(state);
    const current = String(threadId || currentThreadId || "").trim();
    if (current && current !== currentThreadId) return;
    clearRuntimeState();
  }

  function getPromptValue() {
    return readPromptValue(byId("mobilePromptInput"));
  }

  function clearPromptValue() {
    const mobile = byId("mobilePromptInput");
    clearPromptInput(mobile);
    updateMobileComposerState();
  }

  function hideWelcomeCard() {
    const welcome = byId("welcomeCard");
    if (welcome) welcome.style.display = "none";
  }

  function showWelcomeCard() {
    const welcome = byId("welcomeCard");
    if (welcome) welcome.style.display = "";
  }

  function renderComposerContextLeft() {
    const node = byId("mobileContextLeft");
    if (!node) return;
    const annotations = [];
    if (state.fastModeEnabled === true) annotations.push("fast");
    if (state.planModeEnabled === true) annotations.push("plan mode");
    renderComposerContextLeftInNode(node, state.activeThreadTokenUsage, doc, {
      annotation: annotations.join(" · "),
    });
  }

  function permissionLabelForPreset(value) {
    const preset = String(value || "").trim().toLowerCase();
    if (preset === "/permission full-access") return "Full access";
    if (preset === "/permission read-only") return "Read only";
    if (preset === "/permission auto") return "Auto";
    return "Permission";
  }

  function clearActiveThreadGitMeta() {
    state.activeThreadCurrentBranch = "";
    state.activeThreadBranchOptions = [];
    state.activeThreadUncommittedFileCount = 0;
    state.activeThreadIsWorktree = false;
    state.activeThreadGitMetaLoading = false;
    state.activeThreadGitMetaLoaded = false;
    state.activeThreadGitMetaError = "";
    state.activeThreadGitMetaErrorKey = "";
    state.activeThreadGitMetaKey = "";
    state.activeThreadGitMetaCwd = "";
    state.activeThreadGitMetaSource = "";
  }

  function applyActiveThreadGitMeta(payload) {
    return applyActiveThreadGitMetaState(state, payload);
  }

  function normalizeComposerWorkspaceCandidate(value) {
    const workspace = String(value || "").trim().toLowerCase();
    if (workspace === "wsl2" || workspace === "wsl") return "wsl2";
    if (workspace === "windows" || workspace === "win") return "windows";
    return "";
  }

  function readThreadItemId(item) {
    return String(item?.id || item?.threadId || "").trim();
  }

  function findCachedThreadWorkspace(threadId) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return "";
    const collections = [
      { items: state.threadItemsAll, workspace: "" },
      { items: state.threadItems, workspace: "" },
      { items: state.threadItemsByWorkspace?.windows, workspace: "windows" },
      { items: state.threadItemsByWorkspace?.wsl2, workspace: "wsl2" },
    ];
    for (const collection of collections) {
      if (!Array.isArray(collection.items)) continue;
      const item = collection.items.find((candidate) => readThreadItemId(candidate) === normalizedThreadId);
      if (!item) continue;
      const detectedWorkspace = normalizeComposerWorkspaceCandidate(detectThreadWorkspaceTarget(item));
      if (detectedWorkspace) return detectedWorkspace;
      const itemWorkspace = normalizeComposerWorkspaceCandidate(item?.workspace || item?.__workspaceQueryTarget);
      if (itemWorkspace) return itemWorkspace;
      if (collection.workspace) return collection.workspace;
    }
    return "";
  }

  function resolveActiveThreadGitMetaContext(options = {}) {
    const threadId = String(options.threadId || resolveCurrentThreadId(state) || "").trim();
    const requestedWorkspace = normalizeComposerWorkspaceCandidate(options.workspace);
    const cachedThreadWorkspace = findCachedThreadWorkspace(threadId);
    const workspace = cachedThreadWorkspace || requestedWorkspace || normalizeGitMetaWorkspace(options.workspace, state);
    if (
      threadId &&
      cachedThreadWorkspace &&
      String(state.activeThreadId || "").trim() === threadId &&
      state.activeThreadWorkspace !== cachedThreadWorkspace
    ) {
      state.activeThreadWorkspace = cachedThreadWorkspace;
    }
    const cwd = String(options.cwd || state.startCwdByWorkspace?.[workspace] || "").trim();
    return { threadId, workspace, cwd };
  }

  function shouldRefreshActiveThreadGitMeta(options = {}) {
    if (typeof api !== "function") return false;
    const { threadId, workspace, cwd } = resolveActiveThreadGitMetaContext(options);
    if (workspace !== "windows" && workspace !== "wsl2") return false;
    const useThread = !!threadId && options.preferCwd !== true;
    if (!useThread && !cwd) return false;
    const key = buildActiveThreadGitMetaKey({
      threadId: useThread ? threadId : "",
      workspace,
      cwd: useThread ? "" : cwd,
    });
    if (options.force === true) return true;
    if (state.activeThreadGitMetaLoading === true && state.activeThreadGitMetaKey === key) return false;
    if (state.activeThreadGitMetaLoaded === true && state.activeThreadGitMetaKey === key) return false;
    if (String(state.activeThreadGitMetaErrorKey || "").trim() === key) return false;
    return true;
  }

  function shouldClearActiveThreadGitMeta(options = {}) {
    const { threadId, workspace, cwd } = resolveActiveThreadGitMetaContext(options);
    if (workspace !== "windows" && workspace !== "wsl2") return true;
    return !threadId && !cwd;
  }

  async function refreshActiveThreadGitMeta(options = {}) {
    if (typeof api !== "function") return null;
    const { threadId, workspace, cwd } = resolveActiveThreadGitMetaContext(options);
    if (workspace !== "windows" && workspace !== "wsl2") {
      clearActiveThreadGitMeta();
      return null;
    }
    const useThread = !!threadId && options.preferCwd !== true;
    if (!useThread && !cwd) {
      clearActiveThreadGitMeta();
      return null;
    }
    if (!shouldRefreshActiveThreadGitMeta(options)) return null;
    const key = buildActiveThreadGitMetaKey({
      threadId: useThread ? threadId : "",
      workspace,
      cwd: useThread ? "" : cwd,
    });
    const reqSeq = (Number(state.activeThreadGitMetaReqSeq || 0) || 0) + 1;
    state.activeThreadGitMetaReqSeq = reqSeq;
    state.activeThreadGitMetaLoading = true;
    state.activeThreadGitMetaError = "";
    state.activeThreadGitMetaErrorKey = "";
    state.activeThreadGitMetaKey = key;
    try {
      const payload = useThread
        ? await api(
            `/codex/threads/${encodeURIComponent(threadId)}/git?workspace=${encodeURIComponent(workspace)}`
          )
        : await api(
            `/codex/git?workspace=${encodeURIComponent(workspace)}&cwd=${encodeURIComponent(cwd)}`
          );
      if (state.activeThreadGitMetaReqSeq !== reqSeq) return null;
      applyActiveThreadGitMeta(payload);
      updateMobileComposerState();
      return payload;
    } catch {
      if (useThread && cwd) {
        try {
          const payload = await api(
            `/codex/git?workspace=${encodeURIComponent(workspace)}&cwd=${encodeURIComponent(cwd)}`
          );
          if (state.activeThreadGitMetaReqSeq !== reqSeq) return null;
          applyActiveThreadGitMeta(payload);
          updateMobileComposerState();
          return payload;
        } catch {}
      }
      if (state.activeThreadGitMetaReqSeq !== reqSeq) return null;
      state.activeThreadGitMetaLoading = false;
      state.activeThreadGitMetaLoaded = false;
      state.activeThreadGitMetaError = "git metadata unavailable";
      state.activeThreadGitMetaErrorKey = key;
      updateMobileComposerState();
      return null;
    }
  }

  function renderComposerPickerBar() {
    const bar = byId("composerPickerBar");
    const branchBtn = byId("composerBranchPickerBtn");
    const branchMenu = byId("composerBranchPickerMenu");
    const permissionBtn = byId("composerPermissionPickerBtn");
    const permissionMenu = byId("composerPermissionPickerMenu");
    if (!bar) return;
    const inChat = state.activeMainTab !== "settings";
    if (!inChat) {
      bar.style.display = "none";
      state.composerBranchMenuOpen = false;
      state.composerPermissionMenuOpen = false;
      return;
    }
    bar.style.display = "";
    const branchPickerState = buildBranchPickerState(state);
    const {
      branchLabel,
      canPickBranch,
      visibleBranches,
      branchSwitchLocked,
      uncommittedFileCount,
    } = branchPickerState;
    if (!canPickBranch) state.composerBranchMenuOpen = false;
    if (branchBtn) {
      branchBtn.disabled = !canPickBranch;
      branchBtn.setAttribute("aria-expanded", state.composerBranchMenuOpen === true && canPickBranch ? "true" : "false");
      const animateBranchLabel =
        typeof branchBtn.__pickerLabel === "string" &&
        branchBtn.__pickerLabel.length > 0 &&
        branchBtn.__pickerLabel !== branchLabel;
      const nextButtonHtml =
        `<span class="composerPickerBtnLabel${animateBranchLabel ? " is-animating" : ""}">${escapeHtml(branchLabel)}</span>` +
        `<span class="composerPickerBtnChevron" aria-hidden="true">` +
          `<svg viewBox="0 0 16 16" focusable="false"><path d="M4.5 6.5 8 10l3.5-3.5"></path></svg>` +
        `</span>`;
      if (branchBtn.__pickerHtml !== nextButtonHtml) {
        branchBtn.innerHTML = nextButtonHtml;
        branchBtn.__pickerHtml = nextButtonHtml;
      }
      branchBtn.__pickerLabel = branchLabel;
    }
    if (branchMenu) {
      const branchItemsHtml = visibleBranches.length
        ? visibleBranches.map((branchOption) => {
            const { branchName, prNumber, active, disabled } =
              buildBranchPickerItemState(branchPickerState, branchOption);
            return (
              `<button class="composerPickerMenuItem${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}" type="button" data-composer-branch-option="${escapeHtml(branchName)}"${disabled ? " disabled" : ""}>` +
                `<span class="composerPickerMenuItemRow">` +
                  `<span class="composerPickerMenuItemName">${escapeHtml(branchName)}</span>` +
                  (prNumber != null
                    ? `<span class="composerPickerMenuItemMeta">#${escapeHtml(prNumber)}</span>`
                    : "") +
                `</span>` +
              `</button>`
            );
          }).join("")
        : `<div class="composerPickerMenuState">No branches</div>`;
      const lockStateHtml = branchSwitchLocked
        ? `<div class="composerPickerMenuState composerPickerMenuStateWarning">uncommitted files: ${escapeHtml(uncommittedFileCount)}</div>`
        : "";
      const nextMenuHtml = `<div class="composerPickerMenuScroll">${lockStateHtml}${branchItemsHtml}</div>`;
      if (branchMenu.__pickerHtml !== nextMenuHtml) {
        branchMenu.innerHTML = nextMenuHtml;
        branchMenu.__pickerHtml = nextMenuHtml;
      }
      branchMenu.classList.toggle("open", state.composerBranchMenuOpen === true && canPickBranch);
    }

    const permissionPreset = String(state.permissionPresetByWorkspace?.[activeComposerWorkspace(state)] || "").trim();
    const permissionOptions = [
      { command: "/permission auto", label: "Auto" },
      { command: "/permission read-only", label: "Read only" },
      { command: "/permission full-access", label: "Full access" },
    ];
    if (permissionBtn) {
      permissionBtn.disabled = false;
      permissionBtn.setAttribute("aria-expanded", state.composerPermissionMenuOpen === true ? "true" : "false");
      const permissionLabel = permissionLabelForPreset(permissionPreset);
      const animatePermissionLabel =
        typeof permissionBtn.__pickerLabel === "string" &&
        permissionBtn.__pickerLabel.length > 0 &&
        permissionBtn.__pickerLabel !== permissionLabel;
      const nextButtonHtml =
        `<span class="composerPickerBtnLabel${animatePermissionLabel ? " is-animating" : ""}">${escapeHtml(permissionLabel)}</span>` +
        `<span class="composerPickerBtnChevron" aria-hidden="true">` +
          `<svg viewBox="0 0 16 16" focusable="false"><path d="M4.5 6.5 8 10l3.5-3.5"></path></svg>` +
        `</span>`;
      if (permissionBtn.__pickerHtml !== nextButtonHtml) {
        permissionBtn.innerHTML = nextButtonHtml;
        permissionBtn.__pickerHtml = nextButtonHtml;
      }
      permissionBtn.__pickerLabel = permissionLabel;
    }
    if (permissionMenu) {
      const menuBodyHtml = permissionOptions.map((option) => {
        const active = option.command === permissionPreset;
        return `<button class="composerPickerMenuItem${active ? " is-active" : ""}" type="button" data-composer-permission-option="${escapeHtml(option.command)}">${escapeHtml(option.label)}</button>`;
      }).join("");
      const nextMenuHtml = `<div class="composerPickerMenuScroll">${menuBodyHtml}</div>`;
      if (permissionMenu.__pickerHtml !== nextMenuHtml) {
        permissionMenu.innerHTML = nextMenuHtml;
        permissionMenu.__pickerHtml = nextMenuHtml;
      }
      permissionMenu.classList.toggle("open", state.composerPermissionMenuOpen === true);
    }
  }

  function updateMobileComposerState() {
    const row = byId("mobileComposerRow");
    const wrap = byId("mobilePromptWrap");
    const input = byId("mobilePromptInput");
    const sendBtn = byId("mobileSendBtn");
    const menuBtn = byId("composerActionMenuBtn");
      const menu = byId("composerActionMenu");
      const queuedCard = byId("queuedTurnCard");
      const queuedTitle = byId("queuedTurnCardTitle");
      const queuedCount = byId("queuedTurnCardCount");
      const queuedToggleBtn = byId("queuedTurnToggleBtn");
      const queuedStatus = byId("queuedTurnCardStatus");
      const queuedList = byId("queuedTurnCardList");
      const queuedSummary = byId("queuedTurnCardSummary");
      if (!wrap || !input) return;
    if (shouldClearActiveThreadGitMeta()) {
      clearActiveThreadGitMeta();
    } else if (shouldRefreshActiveThreadGitMeta()) {
      refreshActiveThreadGitMeta().catch(() => null);
    }
    const promptText = String(input.value || "").trim();
    const hasText = !!promptText;
    const currentThreadId = resolveCurrentThreadId(state);
    const running = state.activeThreadPendingTurnRunning === true && !!currentThreadId;
      const queuedTurns = readQueuedTurns();
      const queuedTurn = queuedTurns.length ? queuedTurns[0] : null;
      const queuedPrompt = String(queuedTurn?.prompt || "").trim();
      const hasQueuedTurn = !!queuedPrompt;
    const canOpenMenu = running && hasText && !/^\/\S+/.test(promptText);
    input.style.height = "auto";
    const layout = resolveMobilePromptLayout(
      input.scrollHeight,
      typeof windowRef === "undefined" ? Number.NaN : windowRef.innerHeight,
    );
    input.style.height = `${layout.heightPx}px`;
    input.style.overflowY = layout.overflowY;
    if (row) row.classList.toggle("has-text", hasText);
    wrap.classList.toggle("has-text", hasText);
    wrap.classList.toggle("is-running", running);
    wrap.classList.toggle("has-queued-turn", hasQueuedTurn);
    syncFloatingComposerMetrics();
    if (sendBtn) {
      if (running && !hasText) {
        sendBtn.innerHTML =
          `<svg class="sendStopIcon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">` +
          `<rect x="7" y="7" width="6" height="6" rx="1"></rect>` +
          `</svg>`;
        sendBtn.classList.add("is-stop");
        sendBtn.classList.remove("is-steer");
        sendBtn.setAttribute("aria-label", "Stop current turn");
      } else if (running && hasText) {
        sendBtn.innerHTML =
          `<svg class="sendArrowIcon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">` +
          `<path d="M10 15V5m0 0-4 4m4-4 4 4"></path>` +
          `</svg>`;
        sendBtn.classList.add("is-steer");
        sendBtn.classList.remove("is-stop");
        sendBtn.setAttribute("aria-label", "Steer after the next tool call");
      } else {
        sendBtn.innerHTML =
          `<svg class="sendArrowIcon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">` +
          `<path d="M10 15V5m0 0-4 4m4-4 4 4"></path>` +
          `</svg>`;
        sendBtn.classList.remove("is-textual", "is-stop", "is-steer");
        sendBtn.setAttribute("aria-label", "Send message");
      }
    }
    if (!canOpenMenu) state.composerActionMenuOpen = false;
    if (menuBtn) {
      menuBtn.disabled = !canOpenMenu;
      menuBtn.classList.toggle("is-hidden", !canOpenMenu);
      menuBtn.setAttribute("aria-hidden", canOpenMenu ? "false" : "true");
      menuBtn.setAttribute("aria-expanded", state.composerActionMenuOpen === true ? "true" : "false");
    }
    if (menu) {
      if (menu.__closeTimer) {
        clearTimeout(menu.__closeTimer);
        menu.__closeTimer = 0;
      }
      if (state.composerActionMenuOpen === true && canOpenMenu) {
        menu.classList.add("open");
        menu.classList.remove("closing");
      } else if (menu.classList.contains("open")) {
        menu.classList.remove("open");
        menu.classList.add("closing");
        menu.__closeTimer = setTimeout(() => {
          menu.classList.remove("closing");
          menu.__closeTimer = 0;
        }, 180);
      } else if (!canOpenMenu) {
        menu.classList.remove("open", "closing");
      }
    }
      if (queuedCard && queuedTitle && queuedList) {
        const mode = String(queuedTurn?.mode || "").trim().toLowerCase();
        queuedTitle.textContent = "Queued messages";
        if (queuedCount) {
          const total = queuedTurns.length;
          queuedCount.textContent = total > 1 ? `${String(total)} queued` : "1 queued";
          queuedCount.style.display = hasQueuedTurn ? "" : "none";
        }
        if (queuedStatus) {
          queuedStatus.textContent = "Steer waits for the next tool call. Follow-up waits for the current turn.";
        }
        if (queuedCard.__hideTimer) {
          clearTimeout(queuedCard.__hideTimer);
          queuedCard.__hideTimer = 0;
        }
        if (hasQueuedTurn) {
          queuedCard.style.display = "block";
          queuedCard.classList.remove("is-closing");
          scheduleFrame(() => queuedCard.classList.add("is-visible"));
        } else if (queuedCard.classList.contains("is-visible")) {
          queuedCard.classList.remove("is-visible");
          queuedCard.classList.add("is-closing");
          queuedCard.__hideTimer = setTimeout(() => {
            queuedCard.classList.remove("is-closing");
            queuedCard.style.display = "none";
            queuedCard.__hideTimer = 0;
          }, 220);
        } else {
          queuedCard.classList.remove("is-visible", "is-closing");
          queuedCard.style.display = "none";
        }
        if (queuedToggleBtn) {
          queuedToggleBtn.style.display = hasQueuedTurn ? "inline-flex" : "none";
          const expanded = state.queuedTurnsExpanded !== false;
          queuedToggleBtn.setAttribute("aria-label", expanded ? "Collapse queued messages" : "Expand queued messages");
          queuedToggleBtn.setAttribute("title", expanded ? "Collapse queued messages" : "Expand queued messages");
          queuedToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
          queuedToggleBtn.innerHTML =
            `<span class="queuedTurnToggleChevron" aria-hidden="true">` +
              `<svg class="queuedTurnToggleIcon${expanded ? " is-expanded" : ""}" viewBox="0 0 16 16" focusable="false" aria-hidden="true">` +
                `<path d="M4.5 6.2l3.5 3.6 3.5-3.6"></path>` +
              `</svg>` +
            `</span>`;
        }
        const collapsed = state.queuedTurnsExpanded === false;
        queuedCard.classList.toggle("is-collapsed", collapsed);
        if (queuedStatus) queuedStatus.classList.toggle("is-collapsed", collapsed);
        if (queuedList) queuedList.classList.toggle("is-collapsed", collapsed);
        if (queuedSummary) {
          queuedSummary.classList.toggle("is-visible", collapsed && hasQueuedTurn);
          queuedSummary.textContent = hasQueuedTurn
            ? `${queuedModeLabel(queuedTurn?.mode)} - ${String(queuedTurn?.prompt || "").replace(/\s+/g, " ").trim()}`
            : "";
        }
        const visibleQueue = queuedTurns;
        const editingId = String(state.queuedTurnEditingId || "").trim();
        queuedList.innerHTML = visibleQueue
          .map((item, index) => renderQueuedTurnItemHtml(item, {
            index,
            isEditing: editingId === String(item?.id || "").trim(),
            editingDraft:
              editingId === String(item?.id || "").trim()
                ? state.queuedTurnEditingDraft
                : "",
            canSendNow: index === 0 && running,
          }))
          .join("");
        if (editingId) {
          const focusEditor = () => {
            const editor = queuedList.querySelector?.(`[data-queued-editor="${editingId}"]`);
            if (!editor || doc?.activeElement === editor) return;
            editor.focus?.();
            try {
              const length = String(editor.value || "").length;
              editor.setSelectionRange?.(length, length);
            } catch {}
          };
          scheduleFrame(focusEditor);
          if (typeof setTimeout === "function") setTimeout(focusEditor, 0);
        }
    }
    renderComposerPickerBar();
    scheduleFrame(syncFloatingComposerMetrics);
  }

  function setComposerActionMenuOpen(open) {
    state.composerActionMenuOpen = open === true;
    updateMobileComposerState();
  }

  function setComposerBranchMenuOpen(open) {
    state.composerBranchMenuOpen = open === true;
    if (state.composerBranchMenuOpen === true) {
      state.composerPermissionMenuOpen = false;
    }
    updateMobileComposerState();
  }

  function setComposerPermissionMenuOpen(open) {
    state.composerPermissionMenuOpen = open === true;
    if (state.composerPermissionMenuOpen === true) {
      state.composerBranchMenuOpen = false;
    }
    updateMobileComposerState();
  }

  function setMainTab(tab) {
    state.activeMainTab = tab === "settings" ? "settings" : "chat";
    try {
      storage.setItem("web_codex_active_main_tab_v1", state.activeMainTab);
    } catch {}
    const settingsTab = byId("settingsTab");
    const settingsInfoSection = byId("settingsInfoSection");
    const chatBox = byId("chatBox");
    const composer = documentRef.querySelector(".composer");
    const isSideTab = state.activeMainTab === "settings";
    if (settingsTab) settingsTab.classList.toggle("show", isSideTab);
    if (settingsInfoSection) settingsInfoSection.style.display = "";
    if (chatBox) chatBox.style.display = isSideTab ? "none" : "";
    if (composer) composer.style.display = isSideTab ? "none" : "";
    if (isSideTab) syncSettingsControlsFromMain();
    updateHeaderUi();
    renderRuntimePanels();
  }

  function syncSettingsControlsFromMain() {
    const toggleBtn = byId("toggleLiveInspectorBtn");
    const stateNode = byId("liveInspectorState");
    const previewPlanBtn = byId("previewUpdatedPlanBtn");
    const previewPendingBtn = byId("previewPendingBtn");
    const fullAccessOnBtn = byId("settingsFullAccessOnBtn");
    const fullAccessOffBtn = byId("settingsFullAccessOffBtn");
    const fastOnBtn = byId("settingsFastOnBtn");
    const fastOffBtn = byId("settingsFastOffBtn");
    const providerCurrentMode = byId("settingsProviderCurrentMode");
    const providerCurrentTarget = byId("settingsProviderCurrentTarget");
    const providerError = byId("settingsProviderError");
    const providerDeck = byId("settingsProviderDeck");
    const providerList = byId("settingsProviderList");
    const providerCurrentGrid = byId("settingsProviderCurrentGrid");
    const providerManageBtn = byId("settingsProviderManageBtn");
    const providerDirectCount = byId("settingsProviderDirectCount");
    const providerConfirmBackdrop = byId("settingsProviderConfirmBackdrop");
    const providerConfirmTitle = byId("settingsProviderConfirmTitle");
    const providerConfirmDetail = byId("settingsProviderConfirmDetail");
    const providerConfirmApplyBtn = byId("settingsProviderConfirmApplyBtn");
    const providerManagerBackdrop = byId("settingsProviderManagerBackdrop");
    const providerManagerList = byId("settingsProviderManagerList");
    const officialProfileList = byId("settingsOfficialProfileList");
    const providerScopeRow = byId("settingsProviderScopeRow");
    const providerButtons = [
      ["settingsProviderGatewayBtn", "gateway", ""],
    ];
    const open = !!doc?.getElementById?.("webCodexLiveInspector");
    let enabled = false;
    try {
      enabled = String(storage.getItem(LIVE_INSPECTOR_ENABLED_KEY) || "") === "1";
    } catch {}
    const workspace =
      String(state.activeThreadWorkspace || state.workspaceTarget || "windows").trim().toLowerCase() === "wsl2"
        ? "wsl2"
        : "windows";
    const permissionPreset = String(state.permissionPresetByWorkspace?.[workspace] || "").trim().toLowerCase();
    const fullAccessEnabled = permissionPreset === "/permission full-access";
    const fastEnabled = state.fastModeEnabled === true;
    const previewPlanOpen = !!win.__webCodexDebug?.isPreviewUpdatedPlanActive?.();
    const previewPendingOpen = !!win.__webCodexDebug?.isPreviewPendingActive?.();
    if (toggleBtn) toggleBtn.textContent = `Live inspector: ${enabled ? "On" : "Off"}`;
    if (stateNode) stateNode.textContent = open ? "Visible" : "Hidden";
    if (previewPlanBtn) previewPlanBtn.textContent = `Plan Preview: ${previewPlanOpen ? "On" : "Off"}`;
    if (previewPendingBtn) previewPendingBtn.textContent = `Pending Preview: ${previewPendingOpen ? "On" : "Off"}`;
    if (fullAccessOnBtn) {
      fullAccessOnBtn.classList.toggle("is-active", fullAccessEnabled);
      fullAccessOnBtn.setAttribute("aria-pressed", fullAccessEnabled ? "true" : "false");
    }
    if (fullAccessOffBtn) {
      fullAccessOffBtn.classList.toggle("is-active", !fullAccessEnabled);
      fullAccessOffBtn.setAttribute("aria-pressed", !fullAccessEnabled ? "true" : "false");
    }
    if (fastOnBtn) {
      fastOnBtn.classList.toggle("is-active", fastEnabled);
      fastOnBtn.setAttribute("aria-pressed", fastEnabled ? "true" : "false");
    }
    if (fastOffBtn) {
      fastOffBtn.classList.toggle("is-active", !fastEnabled);
      fastOffBtn.setAttribute("aria-pressed", !fastEnabled ? "true" : "false");
    }
    const providerStatus = state.providerSwitchboardStatus || null;
    const providerWorkspaceAvailability = state.workspaceAvailability || {};
    const providerWindowsAvailable = providerWorkspaceAvailability.windowsInstalled === true;
    const providerWsl2Available = providerWorkspaceAvailability.wsl2Installed === true;
    const providerCanSwitchWorkspace = providerWindowsAvailable && providerWsl2Available;
    const providerMode = String(providerStatus?.mode || "").trim();
    const providerName = String(providerStatus?.model_provider || "").trim();
    const providerRawScope = String(state.providerSwitchboardScope || providerStatus?.scope || "windows").trim().toLowerCase() === "wsl2" ? "wsl2" : "windows";
    const providerScope =
      providerWindowsAvailable && !providerWsl2Available
        ? "windows"
        : !providerWindowsAvailable && providerWsl2Available
          ? "wsl2"
          : providerRawScope;
    const providerDraftTarget = String(state.providerSwitchboardDraftTarget || providerMode || "gateway").trim().toLowerCase();
    const providerDraftProvider = String(state.providerSwitchboardDraftProvider || "").trim();
    const providerDraftOfficialProfileId = String(state.providerSwitchboardDraftOfficialProfileId || "").trim();
    const providerDetails = Array.isArray(providerStatus?.provider_details)
      ? providerStatus.provider_details
      : [];
    const officialProfiles = Array.isArray(providerStatus?.official_profiles)
      ? providerStatus.official_profiles
      : [];
    const providerOptionsFallback = Array.isArray(providerStatus?.provider_options)
      ? providerStatus.provider_options.map((name) => String(name || "").trim()).filter(Boolean)
      : [];
    const providerRowsAll = providerDetails.length
      ? providerDetails
      : providerOptionsFallback.map((name) => ({ name, display_name: name, base_url: "", has_key: false, disabled: false, quota: null }));
    const providerRows = providerRowsAll.filter((provider) => provider.disabled !== true);
    if (providerDeck) {
      providerDeck.classList.toggle("is-loading", state.providerSwitchboardLoading === true);
    }
    if (providerCurrentMode) {
      providerCurrentMode.textContent = state.providerSwitchboardLoading
        ? "Loading..."
        : providerScopeLabel(providerScope);
    }
    if (providerCurrentTarget) {
      providerCurrentTarget.textContent =
        state.providerSwitchboardLoading
          ? "Loading..."
          : providerMode === "unavailable"
            ? `${providerScopeLabel(providerScope)} provider unavailable`
            : providerMode === "mixed"
              ? "Mixed current targets"
              : providerMode
                ? providerModeLabel(providerMode, providerName)
                : "Not loaded";
    }
    if (providerCurrentGrid) {
      const dirs = Array.isArray(providerStatus?.dirs) ? providerStatus.dirs : [];
      providerCurrentGrid.classList.toggle("is-single", dirs.length <= 1);
      providerCurrentGrid.innerHTML = dirs.length
        ? dirs.length === 1
          ? `<small class="settingsProviderCurrentHome">${escapeHtml(String(dirs[0]?.cli_home || "").trim() || "-")}</small>`
          : dirs
              .map((dir, index) => {
                const mode = String(dir?.mode || "").trim();
                const modelProvider = String(dir?.model_provider || "").trim();
                const home = String(dir?.cli_home || "").trim();
                return `
                <div class="settingsProviderCurrentCard">
                  <div class="settingsProviderCurrentHead">
                    <span>${escapeHtml(providerDirLabel(dir, index))}</span>
                    <span>${escapeHtml(mode || "unknown")}</span>
                  </div>
                  <strong>${escapeHtml(providerModeLabel(mode, modelProvider))}</strong>
                  <small>${escapeHtml(home || "-")}</small>
                </div>`;
              })
              .join("")
        : `<span class="settingsSectionNote">Web Codex provider state is not loaded.</span>`;
    }
    if (officialProfileList) {
      const selectedOfficialProfileId =
        providerDraftTarget === "official"
          ? providerDraftOfficialProfileId || String(officialProfiles.find((profile) => profile?.active)?.id || officialProfiles[0]?.id || "").trim()
          : "";
      officialProfileList.innerHTML = renderOfficialProfilesHtml(
        officialProfiles,
        selectedOfficialProfileId,
        state.providerSwitchboardBusy === true
      );
    }
    if (providerManageBtn) {
      providerManageBtn.textContent = "Manage";
    }
    if (providerDirectCount) {
      providerDirectCount.textContent = `${providerRows.length} enabled · ${providerRowsAll.length} total`;
    }
    if (providerScopeRow) {
      providerScopeRow.classList.toggle("is-wsl2", providerScope === "wsl2");
      providerScopeRow.style.display = providerCanSwitchWorkspace ? "" : "none";
    }
    if (providerError) {
      const error = String(state.providerSwitchboardError || "").trim();
      providerError.textContent = error;
      providerError.style.display = error ? "" : "none";
    }
    if (providerList) {
      providerList.innerHTML = providerRows.length
        ? providerRows
            .map((provider) => {
              const name = String(provider.name || "").trim();
              const displayName = String(provider.display_name || name).trim();
              const usage = describeProviderUsage(
                provider.quota,
                provider.quota_hard_cap,
                provider.usage_presentation || "standard",
              );
              const endsText = formatProviderEndsText(provider);
              const healthStatus = providerHealthStatus(provider);
              const healthTone = providerHealthTone(healthStatus);
              const healthLabel = providerHealthLabel(healthStatus);
              const pct = readFiniteNumber(usage.pct);
              const pctStyle = pct == null ? "" : ` style="--provider-usage-pct:${Math.max(0, Math.min(100, pct))}%"`;
              const active = providerDraftTarget === "provider" && providerDraftProvider === name;
              return `<button class="settingsProviderBtn settingsProviderOption${active ? " is-active" : ""}" type="button" data-provider-target="provider" data-provider-name="${escapeHtml(name)}" aria-pressed="${active ? "true" : "false"}">
                <span class="settingsProviderOptionMain">
                  <span class="settingsProviderNameLine">
                    <span class="settingsProviderIdentityLine">
                      <span class="settingsProviderHealthDot is-${escapeHtml(healthTone)}" title="${escapeHtml(healthLabel)}" role="img" aria-label="${escapeHtml(healthLabel)}"></span>
                      <span class="settingsProviderOptionName">${escapeHtml(displayName)}</span>
                    </span>
                    ${endsText ? `<small class="settingsProviderEndsText">${escapeHtml(endsText)}</small>` : ""}
                  </span>
                  <span>${escapeHtml(usage.headline)}</span>
                  <span>${escapeHtml(usage.detail)}</span>
                  ${usage.sub ? `<span>${escapeHtml(usage.sub)}</span>` : ""}
                  <span class="settingsProviderUsageTrack"${pctStyle}></span>
                </span>
              </button>`;
            })
            .join("")
        : `<span class="settingsSectionNote">No enabled direct providers. Manage providers to enable one.</span>`;
    }
    providerButtons.forEach(([id, mode]) => {
      const btn = byId(id);
      if (!btn) return;
      const active = providerDraftTarget === mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.disabled = state.providerSwitchboardBusy === true;
    });
    [
      ["settingsProviderScopeWindowsBtn", "windows"],
      ["settingsProviderScopeWslBtn", "wsl2"],
    ].forEach(([id, scope]) => {
      const btn = byId(id);
      if (!btn) return;
      const active = providerScope === scope || (scope === "windows" && providerScope !== "wsl2");
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
      btn.disabled = state.providerSwitchboardBusy === true || state.providerSwitchboardLoading === true;
    });
    if (providerConfirmBackdrop) {
      const confirm = state.providerSwitchboardConfirm;
      const show = !!confirm;
      providerConfirmBackdrop.classList.toggle("show", show);
      providerConfirmBackdrop.setAttribute("aria-hidden", show ? "false" : "true");
      if (providerConfirmTitle) {
        providerConfirmTitle.textContent = show ? `Apply Web Codex ${providerScopeLabel(confirm.scope)} provider` : "Apply provider change";
      }
      if (providerConfirmDetail) {
        providerConfirmDetail.textContent = show
          ? `Switch Web Codex ${providerScopeLabel(confirm.scope)} to ${
              confirm.target === "official"
                ? String(officialProfiles.find((profile) => String(profile?.id || "").trim() === String(confirm.officialProfileId || "").trim())?.email || "Official")
                : providerModeLabel(confirm.target, confirm.provider)
            }. This only changes Web Codex ${providerScopeLabel(confirm.scope)} and will not change the Codex CLI provider on this PC.`
          : "";
      }
      if (providerConfirmApplyBtn) {
        providerConfirmApplyBtn.disabled = state.providerSwitchboardBusy === true;
        providerConfirmApplyBtn.textContent = state.providerSwitchboardBusy === true ? "Applying..." : "Apply";
      }
    }
    if (providerManagerBackdrop) {
      const show = state.providerSwitchboardProvidersModalOpen === true;
      providerManagerBackdrop.classList.toggle("show", show);
      providerManagerBackdrop.setAttribute("aria-hidden", show ? "false" : "true");
    }
    if (providerManagerList) {
      providerManagerList.innerHTML = providerRowsAll.length
        ? providerRowsAll
            .map((provider) => {
              const name = String(provider.name || "").trim();
              const displayName = String(provider.display_name || name).trim();
              const enabled = provider.disabled !== true;
              const endsText = enabled ? formatProviderEndsText(provider) : "";
              return `<div class="settingsProviderManagerRow${enabled ? "" : " is-disabled"}">
                <span class="settingsProviderManagerNameLine">
                  <span>${escapeHtml(displayName)}</span>
                  ${endsText ? `<small class="settingsProviderEndsText">${escapeHtml(endsText)}</small>` : ""}
                </span>
                <button class="settingsProviderSwitch${enabled ? " is-on" : ""}" type="button" aria-pressed="${enabled ? "true" : "false"}" aria-label="${enabled ? "Disable" : "Enable"} ${escapeHtml(displayName)}" data-provider-enabled-toggle="${enabled ? "false" : "true"}" data-provider-name="${escapeHtml(name)}">
                  <span aria-hidden="true"></span>
                </button>
              </div>`;
            })
            .join("")
        : `<span class="settingsSectionNote">No providers configured.</span>`;
    }
    documentRef.querySelectorAll?.("[data-provider-target]").forEach((btn) => {
      btn.disabled = state.providerSwitchboardBusy === true;
    });
  }

  try {
    if (!win.__webCodexLiveInspectorSettingsSyncInstalled) {
      win.__webCodexLiveInspectorSettingsSyncInstalled = true;
      win.addEventListener?.("web-codex-live-inspector-changed", () => {
        syncSettingsControlsFromMain();
      });
      win.addEventListener?.("web-codex-preview-plan-changed", () => {
        syncSettingsControlsFromMain();
      });
      win.addEventListener?.("web-codex-preview-pending-changed", () => {
        syncSettingsControlsFromMain();
      });
    }
  } catch {}
  function updateWelcomeSelections() {}

  return {
    applyPlanDeltaUpdate,
    applyPlanSnapshotUpdate,
    applyToolItemRuntimeUpdate,
    clearRuntimeState,
    clearPromptValue,
    finalizeRuntimeState,
    getPromptValue,
    hideWelcomeCard,
    renderRuntimePanels,
    renderComposerContextLeft,
    applyActiveThreadGitMeta,
    setActiveCommands,
    setActivePlan,
    setComposerActionMenuOpen,
    setComposerBranchMenuOpen,
    setComposerPermissionMenuOpen,
    setRuntimeActivity,
    setThreadStatusCard,
    setMainTab,
    clearThreadStatusCard,
    showWelcomeCard,
    refreshActiveThreadGitMeta,
    syncRuntimeStateFromHistory,
    syncSettingsControlsFromMain,
    updateMobileComposerState,
    updateWelcomeSelections,
  };
}
