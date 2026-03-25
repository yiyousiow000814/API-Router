import { renderStructuredToolPreviewHtml, renderToolPreviewHtml } from "./messageRender.js";
import { extractPlanUpdate, renderPlanCardHtml } from "./runtimePlan.js";

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
    LIVE_INSPECTOR_ENABLED_KEY,
    localStorageRef,
    documentRef,
    windowRef,
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

  function renderActivityHtml(activity) {
    if (!activity) return "";
    const dots = '<span class="runtimeActivityDots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';
    const enterClass = state.chatOpening === true ? "" : " runtimeActivityEnter";
    return (
      `<div class="runtimeActivity${enterClass}" data-activity-tone="running">` +
        `<span class="runtimeActivityText"><strong>working</strong></span>` +
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
    const animationKey = `${String(state.activeThreadId || "")}::${animationIdentity}`;
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
    const planAnimationKey = `${String(state.activeThreadId || "")}::runtime-plan`;
    const shouldAnimateEnter = planAnimationKey && !animatedRuntimePlanKeys.has(planAnimationKey);
    if (shouldAnimateEnter) animatedRuntimePlanKeys.add(planAnimationKey);
    return renderPlanCardHtml(plan, {
      escapeHtml,
      normalizeType,
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
    if (!dock || !activityNode) return;
    const inChat = state.activeMainTab !== "settings";
    const commands = Array.isArray(state.activeThreadActiveCommands)
      ? state.activeThreadActiveCommands.slice(-MAX_VISIBLE_ACTIVE_COMMANDS)
      : [];
    const plan = state.activeThreadPlan && state.activeThreadPlan.threadId === state.activeThreadId
      ? state.activeThreadPlan
      : null;
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === String(state.activeThreadId || "").trim()
      ? state.activeThreadCommentaryCurrent
      : null;
    const thinkingText = String(state.activeThreadTransientThinkingText || commentary?.text || "").trim();
    const explicitActivity = state.activeThreadActivity && state.activeThreadActivity.threadId === state.activeThreadId
      ? state.activeThreadActivity
      : null;
    const pendingThreadId = String(state.activeThreadPendingTurnThreadId || "").trim();
    const pendingTurnRunning = state.activeThreadPendingTurnRunning === true;
    const pendingTurnActivity = pendingTurnRunning && pendingThreadId && pendingThreadId === String(state.activeThreadId || "").trim()
      ? {
          threadId: String(state.activeThreadId || ""),
          title: "Thinking",
          detail: "",
          tone: "running",
        }
      : null;
    const fallbackActivity = pendingTurnActivity
      || explicitActivity
      || (plan ? { threadId: state.activeThreadId, title: "Planning", detail: plan.explanation || "", tone: "running" } : null)
      || (commands.length ? toActivityFromEntry(commands[commands.length - 1]) : null);
    const activity = fallbackActivity
      ? {
          threadId: String(fallbackActivity.threadId || state.activeThreadId || ""),
          title: fallbackActivity.title || "",
          detail: fallbackActivity.detail || "",
          tone: fallbackActivity.tone || "running",
        }
      : null;
    const runtimeRenderSig = JSON.stringify({
      threadId: String(state.activeThreadId || ""),
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
    updateHtmlIfChanged(activityNode, activity ? renderActivityHtml(activity) : "");
    activityNode.style.display = activity ? "" : "none";
    if (chatMount && chatBox) {
      if (plan || thinkingText || commands.length) {
        const lastChild = Array.isArray(chatBox.children) ? chatBox.children[chatBox.children.length - 1] : null;
        if (lastChild !== chatMount) chatBox.appendChild(chatMount);
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
      ? { threadId: String(activity.threadId || state.activeThreadId || ""), title: activity.title || "", detail: activity.detail || "", tone: activity.tone || "running" }
      : null;
  }

  function setRuntimeActivity(activity) {
    assignRuntimeActivity(activity);
    renderRuntimePanels();
  }

  function upsertActiveCommand(entry) {
    if (!entry) return;
    const next = Array.isArray(state.activeThreadActiveCommands) ? [...state.activeThreadActiveCommands] : [];
    const hasRunning = next.some((item) => item && item.state === "running");
    const index = next.findIndex((item) => item && item.key === entry.key);
    const commentaryThreadId = String(state.activeThreadCommentaryCurrent?.threadId || "").trim();
    const commentaryActive = !!commentaryThreadId && commentaryThreadId === String(state.activeThreadId || "").trim();
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
          threadId: String(plan.threadId || state.activeThreadId || ""),
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

  function syncRuntimeActivityFromState(threadId = state.activeThreadId) {
    const currentThreadId = String(threadId || state.activeThreadId || "").trim();
    const plan = state.activeThreadPlan && state.activeThreadPlan.threadId === currentThreadId
      ? state.activeThreadPlan
      : null;
    const commands = Array.isArray(state.activeThreadActiveCommands)
      ? state.activeThreadActiveCommands.filter((entry) => entry && entry.state === "running")
      : [];
    const latestRunning = commands.length ? commands[commands.length - 1] : null;
    if (latestRunning) {
      setRuntimeActivity({ threadId: currentThreadId, ...toActivityFromEntry(latestRunning) });
      return;
    }
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === currentThreadId
      ? state.activeThreadCommentaryCurrent
      : null;
    if (commentary) {
      setRuntimeActivity({
        threadId: currentThreadId,
        title: String(commentary.text || "").trim() ? "Thinking" : "Working",
        detail: String(commentary.text || "").trim(),
        tone: "running",
      });
      return;
    }
    if (plan) {
      setRuntimeActivity({
        threadId: currentThreadId,
        title: "Planning",
        detail: plan.explanation || "",
        tone: "running",
      });
      return;
    }
    setRuntimeActivity(null);
  }

  function syncRuntimeStateFromHistory(thread) {
    const threadId = String(thread?.id || state.activeThreadId || "").trim();
    const pageIncomplete = !!thread?.page?.incomplete;
    if (!pageIncomplete || !threadId || threadId !== state.activeThreadId) {
      clearRuntimeState();
      return;
    }
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    const items = Array.isArray(lastTurn?.items) ? lastTurn.items : [];
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
      if (String(state.activeThreadCommentaryCurrent?.threadId || "").trim() === threadId) {
        state.activeThreadCommentaryCurrent = null;
      }
      if (String(state.activeThreadTransientThinkingText || "").trim()) {
        state.activeThreadTransientThinkingText = "";
      }
      clearRuntimeState();
      return;
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const type = String(item?.type || "").trim();
      if (!type) continue;
      const updatePlan = extractPlanUpdate(item, { threadId, normalizeType });
      if (updatePlan) {
        plan = updatePlan;
        continue;
      }
      if (type === "userMessage" || type === "assistantMessage" || type === "agentMessage") continue;
      if (latestCommentaryIndex >= 0 && !hasVisibleAssistant && index < latestCommentaryIndex) continue;
      const entry = toActiveCommandEntry(item);
      if (!entry) continue;
      commands.push(entry);
      if (isRuntimeActiveState(entry.state)) latestRunning = entry;
    }
    assignActivePlan(plan);
    assignActiveCommands(commands);
    if (latestRunning) {
      assignRuntimeActivity({ threadId, ...toActivityFromEntry(latestRunning) });
      renderRuntimePanels();
      return;
    }
    const commentary = state.activeThreadCommentaryCurrent &&
      String(state.activeThreadCommentaryCurrent.threadId || "").trim() === threadId
      ? state.activeThreadCommentaryCurrent
      : null;
    if (commentary) {
      assignRuntimeActivity({
        threadId,
        title: String(commentary.text || "").trim() ? "Thinking" : "Working",
        detail: String(commentary.text || "").trim(),
        tone: "running",
      });
      renderRuntimePanels();
      return;
    }
    if (plan) {
      assignRuntimeActivity({ threadId, title: "Thinking", detail: "", tone: "running" });
      renderRuntimePanels();
      return;
    }
    if (pageIncomplete && commands.length === 0) {
      assignRuntimeActivity({ threadId, title: "Thinking", detail: "", tone: "running" });
      renderRuntimePanels();
      return;
    }
    assignRuntimeActivity(null);
    renderRuntimePanels();
  }

  function applyToolItemRuntimeUpdate(item, options = {}) {
    const threadId = String(options.threadId || state.activeThreadId || "").trim();
    if (!threadId || threadId !== state.activeThreadId) return;
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
    const threadId = String(payload.threadId || payload.thread_id || state.activeThreadId || "").trim();
    if (!threadId || threadId !== state.activeThreadId) return;
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
    const threadId = String(payload.threadId || payload.thread_id || state.activeThreadId || "").trim();
    if (!threadId || threadId !== state.activeThreadId) return;
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
    const current = String(threadId || state.activeThreadId || "").trim();
    if (current && current !== state.activeThreadId) return;
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
    const permissionPreset = String(
      state.permissionPresetByWorkspace?.[String(state.activeThreadWorkspace || state.workspaceTarget || "windows").trim().toLowerCase() === "wsl2"
        ? "wsl2"
        : "windows"] || ""
    ).trim().toLowerCase();
    if (permissionPreset === "/permission full-access") annotations.push("full access");
    else if (permissionPreset === "/permission auto") annotations.push("auto");
    else if (permissionPreset === "/permission read-only") annotations.push("read only");
    if (state.fastModeEnabled === true) annotations.push("fast");
    if (state.planModeEnabled === true) annotations.push("plan mode");
    renderComposerContextLeftInNode(node, state.activeThreadTokenUsage, doc, {
      annotation: annotations.join(" · "),
    });
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
    const promptText = String(input.value || "").trim();
    const hasText = !!promptText;
    const running = state.activeThreadPendingTurnRunning === true;
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
  }

  function setComposerActionMenuOpen(open) {
    state.composerActionMenuOpen = open === true;
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
    const workspaceNode = byId("settingsDefaultsWorkspace");
    const previewPlanBtn = byId("previewUpdatedPlanBtn");
    const fullAccessOnBtn = byId("settingsFullAccessOnBtn");
    const fullAccessOffBtn = byId("settingsFullAccessOffBtn");
    const fastOnBtn = byId("settingsFastOnBtn");
    const fastOffBtn = byId("settingsFastOffBtn");
    const open = !!doc?.getElementById?.("webCodexLiveInspector");
    let enabled = false;
    try {
      enabled = String(storage.getItem(LIVE_INSPECTOR_ENABLED_KEY) || "") === "1";
    } catch {}
    const workspace =
      String(state.activeThreadWorkspace || state.workspaceTarget || "windows").trim().toLowerCase() === "wsl2"
        ? "wsl2"
        : "windows";
    const workspaceLabel = workspace === "wsl2" ? "WSL2" : "Windows";
    const permissionPreset = String(state.permissionPresetByWorkspace?.[workspace] || "").trim().toLowerCase();
    const fullAccessEnabled = permissionPreset === "/permission full-access";
    const fastEnabled = state.fastModeEnabled === true;
    const previewPlanOpen = !!win.__webCodexDebug?.isPreviewUpdatedPlanActive?.();
    if (toggleBtn) toggleBtn.textContent = `Live inspector: ${enabled ? "On" : "Off"}`;
    if (stateNode) stateNode.textContent = open ? "Visible" : "Hidden";
    if (workspaceNode) workspaceNode.textContent = `Applies to current ${workspaceLabel} chat`;
    if (previewPlanBtn) previewPlanBtn.textContent = `Plan Preview: ${previewPlanOpen ? "On" : "Off"}`;
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
    setActiveCommands,
    setActivePlan,
    setComposerActionMenuOpen,
    setRuntimeActivity,
    setMainTab,
    showWelcomeCard,
    syncRuntimeStateFromHistory,
    syncSettingsControlsFromMain,
    updateMobileComposerState,
    updateWelcomeSelections,
  };
}
