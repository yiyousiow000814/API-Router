import { renderPlanCardHtml } from "./runtimePlan.js";
import {
  getPendingUserInputProgress,
  getVisiblePendingUserInputs,
  normalizePendingUserInputQuestions,
  parsePendingOptionDisplay,
} from "./connectionFlows.js";
import { renderMessageRichHtml } from "./messageRender.js";
import { getProposedPlanConfirmation } from "./proposedPlan.js";

import { resetPendingTurnRuntime, resetTurnPresentationState } from "./runtimeState.js";

export function summarizeChatTimeline(box) {
  const nodes = Array.from(box?.children || []).filter((child) => child?.classList?.contains?.("msg"));
  const messages = nodes.map((child, index) => {
    const role = String(child.__webCodexRole || "").trim();
    const kind = String(child.__webCodexKind || "").trim();
    const source = String(child.__webCodexSource || "").trim();
    const key =
      typeof child.getAttribute === "function"
        ? String(child.getAttribute("data-msg-key") || "").trim()
        : "";
    const text = String(child.__webCodexRawText || child.textContent || "").replace(/\s+/g, " ").trim();
    return {
      index,
      role,
      kind,
      source,
      key,
      text: text.slice(0, 80),
    };
  });
  const userIndexes = messages
    .filter((item) => item.role === "user")
    .map((item) => item.index);
  const connectionIndexes = messages
    .filter((item) => item.key === "live-thread-connection-status" || /reconnecting/i.test(item.text))
    .map((item) => item.index);
  const errorIndexes = messages
    .filter((item) => item.kind === "error")
    .map((item) => item.index);
  const lastUserIndex = userIndexes.length ? userIndexes[userIndexes.length - 1] : -1;
  const firstConnectionIndex = connectionIndexes.length ? connectionIndexes[0] : -1;
  const firstErrorIndex = errorIndexes.length ? errorIndexes[0] : -1;
  const lastUserText = lastUserIndex >= 0 ? String(messages[lastUserIndex]?.text || "") : "";
  const duplicateLastUserCount = lastUserText
    ? messages.filter((item) => item.role === "user" && item.text === lastUserText).length
    : 0;
  return {
    count: messages.length,
    messages: messages.slice(-12),
    userIndexes,
    connectionIndexes,
    errorIndexes,
    userAfterConnection: lastUserIndex >= 0 && firstConnectionIndex >= 0 && lastUserIndex > firstConnectionIndex,
    userAfterError: lastUserIndex >= 0 && firstErrorIndex >= 0 && lastUserIndex > firstErrorIndex,
    duplicateLastUserCount,
  };
}

export function createChatTimelineModule(deps) {
  const {
    byId,
    state,
    escapeHtml,
    renderMessageAttachments,
    renderMessageBody,
    wireMessageLinks,
    wireMessageAttachments,
    scheduleChatLiveFollow,
    updateScrollToBottomBtn,
    scrollChatToBottom,
    renderRuntimePanels = () => {},
    requestAnimationFrameRef = requestAnimationFrame,
    documentRef = document,
  } = deps;
  let archiveViewportAdjustToken = 0;
  let lastCommentaryArchiveRenderSig = "";
  let lastPendingInlineRenderSig = "";

  function pushLiveDebugEvent(kind, payload = {}) {
    if (!Array.isArray(state.liveDebugEvents)) state.liveDebugEvents = [];
    state.liveDebugEvents.push({
      at: Date.now(),
      kind: String(kind || ""),
      ...payload,
    });
    if (state.liveDebugEvents.length > 120) {
      state.liveDebugEvents.splice(0, state.liveDebugEvents.length - 120);
    }
  }

  function attachMessageDebugMeta(node, payload = {}) {
    if (!node) return node;
    try {
      node.__webCodexRole = String(payload.role || "").trim();
      node.__webCodexKind = String(payload.kind || "").trim();
      node.__webCodexRawText = typeof payload.text === "string" ? payload.text : String(payload.text || "");
      node.__webCodexSource = String(payload.source || "").trim();
      node.__webCodexTransient = payload.transient === true;
      if (node.setAttribute) {
        if (node.__webCodexSource) node.setAttribute("data-msg-source", node.__webCodexSource);
        if (node.__webCodexTransient) node.setAttribute("data-msg-transient", "1");
        else node.removeAttribute("data-msg-transient");
      }
    } catch {}
    return node;
  }

  function animateMessageNode(node, delayMs = 0) {
    if (state.chatOpening === true) return;
    if (delayMs > 0) node.style.setProperty("--msg-enter-delay", `${Math.floor(delayMs)}ms`);
    else node.style.removeProperty("--msg-enter-delay");
    node.classList.add("msg-enter");
    node.addEventListener("animationend", () => {
      node.classList.remove("msg-enter");
      node.style.removeProperty("--msg-enter-delay");
    }, { once: true });
  }

  function findMessageNodesByKey(box, messageKey) {
    if (!box || !messageKey) return [];
    const matches = [];
    for (const child of Array.from(box.children || [])) {
      if (!child || typeof child.getAttribute !== "function") continue;
      if (String(child.getAttribute("data-msg-key") || "") !== messageKey) continue;
      matches.push(child);
    }
    return matches;
  }

  function removeChatMessageByKey(messageKey) {
    const box = byId("chatBox");
    const normalizedKey = String(messageKey || "").trim();
    if (!box || !normalizedKey) return false;
    const matches = findMessageNodesByKey(box, normalizedKey);
    if (!matches.length) return false;
    for (const node of matches) node.remove?.();
    return true;
  }

  function createMessageNode(role, text, options = {}) {
    const node = documentRef.createElement("div");
    const kind = typeof options.kind === "string" && options.kind.trim() ? options.kind.trim() : "";
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    const hasAttachments = attachments.length > 0;
    const hasText = !!String(text || "").trim();
    const attachmentClass = role === "user" && hasAttachments && hasText ? " withAttachments" : "";
    node.className = `msg ${role}${kind ? ` kind-${kind}` : ""}${attachmentClass}`.trim();
    const showHead = !(role === "assistant" || role === "user" || (role === "system" && (kind === "tool" || kind === "thinking")));
    const headLabel = kind && role === "system" ? kind : role;
    const attachmentsHtml = renderMessageAttachments(attachments);
    const bodyHtml = renderMessageBody(role, text, { kind });
    node.innerHTML = `${showHead ? `<div class="msgHead">${escapeHtml(headLabel)}</div>` : ""}<div class="msgBody">${attachmentsHtml}${bodyHtml}</div>`;
    attachMessageDebugMeta(node, {
      role,
      kind,
      text,
      source: String(options.source || "").trim() || "createMessageNode",
      transient: options.transient === true,
    });
    wireMessageLinks(node);
    wireMessageAttachments(node);
    return node;
  }

  function buildMsgNode(msg) {
    if (msg?.kind === "commentaryArchive") {
      return createCommentaryArchiveNode(msg?.archiveBlocks, {
        source: "buildMsgNode",
        key: msg?.archiveKey,
      });
    }
    if (msg?.kind === "planCard") {
      return createPlanCardNode(msg?.plan, {
        source: "buildMsgNode",
      });
    }
    return createMessageNode(msg?.role || "", msg?.text || "", {
      kind: msg?.kind || "",
      attachments: msg?.images || [],
      source: "buildMsgNode",
    });
  }

  function removePendingInlineMount() {
    const mount = byId("pendingInlineMount");
    mount?.remove?.();
  }

  function formatPendingInlineSummary() {
    const approvalCount = Array.isArray(state.pendingApprovals) ? state.pendingApprovals.length : 0;
    const inputCount = getVisiblePendingUserInputs(state).length;
    const proposedPlanConfirmation = getProposedPlanConfirmation(state);
    const onlyInput = inputCount === 1 ? getVisiblePendingUserInputs(state)[0] : null;
    const onlyInputProgress = onlyInput ? getPendingUserInputProgress(state, onlyInput) : null;
    if (approvalCount === 0 && inputCount === 0 && proposedPlanConfirmation) {
      return "Plan confirmation";
    }
    if (
      approvalCount === 0 &&
      onlyInputProgress &&
      onlyInputProgress.totalQuestions > 0 &&
      !onlyInputProgress.isComplete
    ) {
      return `Question ${Math.min(onlyInputProgress.completedCount + 1, onlyInputProgress.totalQuestions)}/${onlyInputProgress.totalQuestions}`;
    }
    const parts = [];
    if (approvalCount > 0) parts.push(`${approvalCount} approval${approvalCount === 1 ? "" : "s"}`);
    if (inputCount > 0) parts.push(`${inputCount} question${inputCount === 1 ? "" : "s"}`);
    return parts.join(" · ") || "Pending actions";
  }

  function buildPendingInlineRenderSig() {
    const approvals = Array.isArray(state.pendingApprovals) ? state.pendingApprovals : [];
    const userInputs = getVisiblePendingUserInputs(state);
    const proposedPlanConfirmation = getProposedPlanConfirmation(state);
    return JSON.stringify({
      approvals: approvals.map((item) => ({
        id: String(item?.id || ""),
        prompt: String(item?.prompt || item?.title || item?.message || ""),
      })),
      userInputs: userInputs.map((item) => ({
        id: String(item?.id || ""),
        prompt: String(item?.prompt || item?.title || item?.question || ""),
        questions: normalizePendingUserInputQuestions(item).map((question) => ({
          id: question.id,
          prompt: question.prompt,
          options: question.options.map((option) => option.label),
        })),
      })),
      proposedPlanConfirmation: proposedPlanConfirmation
        ? {
            id: String(proposedPlanConfirmation.id || ""),
            title: String(proposedPlanConfirmation.plan?.title || proposedPlanConfirmation.title || ""),
            prompt: String(proposedPlanConfirmation.prompt || ""),
          }
        : null,
      answers: state.pendingUserInputAnswersById || {},
      completed: state.pendingUserInputCompletedKeysById || {},
      selectedApprovalId: String(state.selectedPendingApprovalId || ""),
      selectedUserInputId: String(state.selectedPendingUserInputId || ""),
    });
  }

  function createPendingInlineMount() {
    const approvals = Array.isArray(state.pendingApprovals) ? state.pendingApprovals : [];
    const userInputs = getVisiblePendingUserInputs(state);
    const proposedPlanConfirmation = getProposedPlanConfirmation(state);
    if (!approvals.length && !userInputs.length && !proposedPlanConfirmation) return null;
    const mount = documentRef.createElement("div");
    mount.id = "pendingInlineMount";
    mount.className = "msg system kind-pending pendingInlineMount";
    const head = documentRef.createElement("div");
    head.className = "msgHead";
    head.textContent = "pending";
    const body = documentRef.createElement("div");
    body.className = "msgBody";
    const card = documentRef.createElement("div");
    card.className = "pendingInlineCard";
    const title = documentRef.createElement("div");
    title.className = "pendingInlineTitle";
    title.textContent = formatPendingInlineSummary();
    card.appendChild(title);

    if (approvals.length) {
      const section = documentRef.createElement("div");
      section.className = "pendingInlineSection";
      section.innerHTML = `<div class="pendingInlineLabel">Permission Requests</div>`;
      for (const item of approvals) {
        const id = String(item?.id || "").trim();
        const row = documentRef.createElement("div");
        row.className = "pendingInlineItem";
        if (String(state.selectedPendingApprovalId || "").trim() === id) row.classList.add("is-selected");
        row.innerHTML =
          `<button class="pendingInlineSelect" type="button" data-pending-approval-select="${escapeHtml(id)}">` +
            `<div class="itemTitle">${escapeHtml(id || "approval")}</div>` +
            `<div class="itemSub">${escapeHtml(item?.prompt || item?.title || item?.message || "Permission request")}</div>` +
          `</button>` +
          `<div class="pendingInlineActions">` +
            `<button class="settingsChoiceBtn" type="button" data-pending-approval-id="${escapeHtml(id)}" data-pending-approval-decision="approve">Approve</button>` +
            `<button class="settingsChoiceBtn" type="button" data-pending-approval-id="${escapeHtml(id)}" data-pending-approval-decision="reject">Reject</button>` +
          `</div>`;
        section.appendChild(row);
      }
      card.appendChild(section);
    }

    if (userInputs.length) {
      const section = documentRef.createElement("div");
      section.className = "pendingInlineSection";
      section.innerHTML = `<div class="pendingInlineLabel">Questions</div>`;
      const showUserInputHeader = userInputs.length > 1;
      for (const item of userInputs) {
        const id = String(item?.id || "").trim();
        const draftAnswers =
          state.pendingUserInputAnswersById && typeof state.pendingUserInputAnswersById === "object"
            ? state.pendingUserInputAnswersById[id] || {}
            : {};
        const progress = getPendingUserInputProgress(state, item);
        const question = progress.currentQuestion;
        const progressLabel = progress.totalQuestions > 0
          ? `Question ${Math.min(progress.completedCount + 1, progress.totalQuestions)}/${progress.totalQuestions}`
          : "Question";
        const submitLabel =
          progress.totalQuestions <= 1 || progress.unansweredCount <= 1
            ? "Submit answer"
            : "Next";
        const summaryLabel = progress.isComplete
          ? "Ready to submit"
          : `${progress.unansweredCount} unanswered`;
        const showInlineQuestionHeader = !(
          approvals.length === 0 &&
          userInputs.length === 1 &&
          progress.totalQuestions > 0 &&
          !progress.isComplete &&
          formatPendingInlineSummary() === progressLabel
        );
        const row = documentRef.createElement("div");
        row.className = "pendingInlineItem";
        if (String(state.selectedPendingUserInputId || "").trim() === id) row.classList.add("is-selected");
        const questionsHtml = question
          ? [question]
          .map((currentQuestion) => {
            const mode =
              String(state.pendingUserInputAnswerModesById?.[id]?.[currentQuestion.id] || "").trim().toLowerCase() === "freeform"
                ? "freeform"
                : "option";
            const typedValue = String(draftAnswers?.[currentQuestion.id] || "");
            const optionsHtml = currentQuestion.options.length
              ? currentQuestion.options
                  .map((option) => {
                    const meta = parsePendingOptionDisplay(option, currentQuestion.options.indexOf(option));
                    const active = mode !== "freeform" && String(draftAnswers?.[currentQuestion.id] || "").trim() === option.label;
                    return `<button class="pendingInlineOptionCard${active ? " is-active" : ""}" type="button" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" data-pending-answer-value="${escapeHtml(option.label)}">
                      <span class="pendingInlineOptionTop">
                        <span class="pendingInlineOptionTitle">${escapeHtml(`${meta.ordinal}. ${meta.label}`)}</span>
                        ${meta.recommended ? '<span class="pendingInlineOptionBadge">Recommended</span>' : ""}
                      </span>
                      ${meta.description ? `<span class="pendingInlineOptionDesc">${escapeHtml(meta.description)}</span>` : ""}
                    </button>`;
                  })
                  .join("")
              : `<div class="itemSub">No preset options.</div>`;
            return (
              `<div class="pendingInlineQuestion">` +
                `${showInlineQuestionHeader ? `<div class="pendingInlineQuestionHeader">${escapeHtml(progressLabel)}</div>` : ""}` +
                `<div class="pendingInlineQuestionPrompt">${escapeHtml(currentQuestion.prompt || item?.prompt || item?.title || item?.question || "Question")}</div>` +
                `<div class="pendingInlineOptions">${optionsHtml}</div>` +
                `<div class="pendingInlineOptions"><button class="pendingInlineOptionCard pendingInlineOptionCard-ghost${mode === "freeform" ? " is-active" : ""}" type="button" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" data-pending-answer-mode="freeform"><span class="pendingInlineOptionTop"><span class="pendingInlineOptionTitle">None of the above</span></span><span class="pendingInlineOptionDesc">Add your own answer in a note below.</span></button></div>` +
                `<div class="pendingInlineFreeformWrap${mode === "freeform" ? " is-visible" : ""}"><div class="pendingInlineFreeformInner"><textarea class="pendingInlineFreeform" data-pending-freeform-input="1" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" placeholder="Type your answer...">${escapeHtml(mode === "freeform" ? typedValue : "")}</textarea></div></div>` +
              `</div>`
            );
          })
          .join("")
          : `<div class="pendingInlineQuestion"><div class="pendingInlineQuestionHeader">${escapeHtml(progressLabel)}</div><div class="pendingInlineQuestionPrompt">${escapeHtml(summaryLabel)}</div></div>`;
        row.innerHTML =
          `${showUserInputHeader ? (
            `<button class="pendingInlineSelect" type="button" data-pending-user-input-select="${escapeHtml(id)}">` +
              `<div class="itemTitle">${escapeHtml(progressLabel)}</div>` +
              `<div class="itemSub">${escapeHtml(summaryLabel)}</div>` +
            `</button>`
          ) : ""}` +
          `<div class="pendingInlineQuestions">${questionsHtml}</div>` +
          `<div class="pendingInlineActions">` +
            `<button class="settingsChoiceBtn" type="button" data-pending-user-input-submit="${escapeHtml(id)}">${submitLabel}</button>` +
          `</div>`;
        section.appendChild(row);
      }
      card.appendChild(section);
    }

    if (proposedPlanConfirmation) {
      const section = documentRef.createElement("div");
      section.className = "pendingInlineSection";
      const planTitle = String(proposedPlanConfirmation.plan?.title || "").trim();
      const planPrompt = String(proposedPlanConfirmation.prompt || proposedPlanConfirmation.title || "").trim();
      section.innerHTML =
        `<div class="pendingInlineLabel">Plan Review</div>` +
        `<div class="pendingInlineItem">` +
          `<div class="pendingInlineQuestions">` +
            `<div class="pendingInlineQuestion">` +
              `<div class="pendingInlineQuestionHeader">${escapeHtml(planTitle || "Proposed Plan")}</div>` +
              `<div class="pendingInlineQuestionPrompt">${escapeHtml(planPrompt || "Implement this plan?")}</div>` +
            `</div>` +
          `</div>` +
          `<div class="pendingInlineActions">` +
            `<button class="settingsChoiceBtn" type="button" data-proposed-plan-decision="approve">Implement</button>` +
            `<button class="settingsChoiceBtn" type="button" data-proposed-plan-decision="stay">Stay in Plan</button>` +
          `</div>` +
        `</div>`;
      card.appendChild(section);
    }

    body.appendChild(card);
    mount.appendChild(head);
    mount.appendChild(body);
    attachMessageDebugMeta(mount, {
      role: "system",
      kind: "pending",
      text: formatPendingInlineSummary(),
      source: "pendingInline",
      transient: false,
    });
    return mount;
  }

  function renderPendingInline() {
    const box = byId("chatBox");
    if (!box) return;
    const approvals = Array.isArray(state.pendingApprovals) ? state.pendingApprovals : [];
    const userInputs = getVisiblePendingUserInputs(state);
    const proposedPlanConfirmation = getProposedPlanConfirmation(state);
    const renderSig = buildPendingInlineRenderSig();
    if (lastPendingInlineRenderSig === renderSig && byId("pendingInlineMount")) return;
    lastPendingInlineRenderSig = renderSig;
    removePendingInlineMount();
    const mount = createPendingInlineMount();
    if (!mount) {
      pushLiveDebugEvent("pending.inline:render", {
        threadId: String(state.activeThreadId || "").trim(),
        approvalCount: approvals.length,
        userInputCount: userInputs.length,
        proposedPlanConfirmation: !!proposedPlanConfirmation,
        visible: false,
      });
      return;
    }
    box.appendChild(mount);
    const children = Array.isArray(box.children) ? box.children : [];
    pushLiveDebugEvent("pending.inline:render", {
      threadId: String(state.activeThreadId || "").trim(),
      approvalCount: approvals.length,
      userInputCount: userInputs.length,
      proposedPlanConfirmation: !!proposedPlanConfirmation,
      visible: true,
      pendingIndex: children.indexOf(mount),
      runtimeIndex: children.findIndex((node) => String(node?.id || "").trim() === "runtimeChatPanels"),
      commentaryIndex: children.findIndex((node) => String(node?.id || "").trim() === "commentaryArchiveMount"),
    });
  }

  function removeCommentaryArchiveMount() {
    const mount = byId("commentaryArchiveMount");
    mount?.remove?.();
  }

  function buildCommentaryArchiveRenderSig(archive, options = {}, box = null) {
    const assistantCount = Array.from(box?.querySelectorAll?.(".assistant") || []).length;
    return JSON.stringify({
      inlineArchiveCount: Math.max(0, Number(state.activeThreadInlineCommentaryArchiveCount || 0)),
      visible: state.activeThreadCommentaryArchiveVisible === true && Array.isArray(archive) && archive.length > 0,
      expanded: state.activeThreadCommentaryArchiveExpanded === true,
      assistantCount,
      explicitAnchor: !!(options.anchorNode && options.anchorNode.parentElement === box),
      archive: Array.isArray(archive)
        ? archive.map((block) => ({
            key: String(block?.key || ""),
            text: String(block?.text || ""),
            summaryOnly: block?.summaryOnly === true,
            tools: Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "")) : [],
            plan: block?.plan
              ? {
                  threadId: String(block.plan.threadId || ""),
                  turnId: String(block.plan.turnId || ""),
                  title: String(block.plan.title || ""),
                  explanation: String(block.plan.explanation || ""),
                  deltaText: String(block.plan.deltaText || ""),
                  steps: Array.isArray(block.plan.steps)
                    ? block.plan.steps.map((step) => ({
                        step: String(step?.step || ""),
                        status: String(step?.status || ""),
                      }))
                    : [],
                }
              : null,
          }))
        : [],
    });
  }

  function formatCommentaryArchiveSummary(commentaryCount, toolCount) {
    const normalizedCommentaryCount = Math.max(0, Number(commentaryCount || 0));
    const normalizedToolCount = Math.max(0, Number(toolCount || 0));
    return `${String(normalizedCommentaryCount)} commentary message${normalizedCommentaryCount === 1 ? "" : "s"}, ${String(normalizedToolCount)} used tool${normalizedToolCount === 1 ? "" : "s"}`;
  }

  function getChatDistanceFromBottom(box) {
    if (!box) return 0;
    return Math.max(0, Number(box.scrollHeight || 0) - (Number(box.scrollTop || 0) + Number(box.clientHeight || 0)));
  }

  function getViewportTop(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return null;
    const rect = node.getBoundingClientRect();
    const top = Number(rect?.top);
    return Number.isFinite(top) ? top : null;
  }

  function prepareArchiveViewportAfterToggle(toggle) {
    const box = byId("chatBox");
    if (!box || !toggle) {
      return () => updateScrollToBottomBtn();
    }
    const lockBottom = !!state.chatShouldStickToBottom || getChatDistanceFromBottom(box) <= 80;
    const anchorTop = lockBottom ? null : getViewportTop(toggle);
    return () => {
      const token = (archiveViewportAdjustToken + 1) | 0;
      archiveViewportAdjustToken = token;
      const startedAt = Date.now();
      const tick = () => {
        if (archiveViewportAdjustToken !== token) return;
        const liveBox = byId("chatBox");
        if (!liveBox || !toggle.parentElement) return;
        if (lockBottom) {
          state.chatShouldStickToBottom = true;
          state.chatUserScrolledAwayAt = 0;
          scrollChatToBottom({ force: true });
          scheduleChatLiveFollow(380);
          updateScrollToBottomBtn();
        } else if (anchorTop != null) {
          const nextTop = getViewportTop(toggle);
          if (nextTop != null) {
            const delta = nextTop - anchorTop;
            if (Math.abs(delta) > 0.5) {
              state.chatProgrammaticScrollUntil = Date.now() + 180;
              liveBox.scrollTop += delta;
            }
          }
          updateScrollToBottomBtn();
        } else {
          updateScrollToBottomBtn();
        }
        if (Date.now() - startedAt < 320) requestAnimationFrameRef(tick);
      };
      requestAnimationFrameRef(tick);
    };
  }

  function createCommentaryArchiveNode(blocks, options = {}) {
    const archive = Array.isArray(blocks)
      ? blocks.filter((block) => {
          const tools = Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
          return !!(block && (block?.summaryOnly === true || String(block.text || "").trim() || block?.plan || tools.length));
        })
      : [];
    const expandableArchive = archive.filter((block) => block?.summaryOnly !== true && (String(block?.text || "").trim() || block?.plan));
    const totalToolCount = archive.reduce((count, block) => {
      return count + (Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean).length : 0);
    }, 0);
    const mount = documentRef.createElement("div");
    mount.className = "commentaryArchiveMount";
    attachMessageDebugMeta(mount, {
      role: "system",
      kind: "commentaryArchive",
      text: archive
        .map((block) => [
          String(block?.text || "").trim(),
          ...(Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()) : []),
        ].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n"),
      source: String(options.source || "").trim() || "commentaryArchive",
      transient: false,
    });
    if (options.key) {
      try { mount.setAttribute("data-commentary-archive-key", String(options.key)); } catch {}
    }
    if (!expandableArchive.length) {
      const summary = documentRef.createElement("div");
      summary.className = "commentaryArchiveSummary";
      summary.textContent = formatCommentaryArchiveSummary(0, totalToolCount);
      mount.appendChild(summary);
      return mount;
    }
    const expandedState = { value: false };
    const toggle = documentRef.createElement("button");
    toggle.type = "button";
    toggle.className = "commentaryArchiveToggle is-collapsed";
    toggle.setAttribute("aria-expanded", "false");
    const countLabel = documentRef.createElement("span");
    countLabel.className = "commentaryArchiveCount";
    countLabel.textContent = formatCommentaryArchiveSummary(expandableArchive.length, totalToolCount);
    const chevron = documentRef.createElement("span");
    chevron.className = "commentaryArchiveChevron is-collapsed";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    toggle.appendChild(countLabel);
    toggle.appendChild(chevron);
    mount.appendChild(toggle);

    const body = documentRef.createElement("div");
    body.className = "commentaryArchiveBody collapsed";
    body.setAttribute("aria-hidden", "true");
    const bodyInner = documentRef.createElement("div");
    bodyInner.className = "commentaryArchiveBodyInner";
    for (const block of expandableArchive) {
      const blockNode = documentRef.createElement("div");
      blockNode.className = "commentaryArchiveBlock";
      if (block?.plan) {
        const planNode = documentRef.createElement("div");
        planNode.className = "commentaryArchivePlan";
        planNode.innerHTML = renderPlanCardHtml(block.plan, {
          escapeHtml,
          renderRichTextHtml: renderMessageRichHtml,
          cardClass: "commentaryArchivePlanCard",
        });
        blockNode.appendChild(planNode);
      }
      if (String(block?.text || "").trim()) {
        blockNode.appendChild(createMessageNode("system", block.text, {
          kind: "thinking",
          source: "commentaryArchive",
        }));
      }
      bodyInner.appendChild(blockNode);
    }
    const finalDivider = documentRef.createElement("div");
    finalDivider.className = "commentaryArchiveFinalDivider";
    finalDivider.innerHTML = '<span class="commentaryArchiveFinalLabel">Final message</span>';
    bodyInner.appendChild(finalDivider);
    body.appendChild(bodyInner);
    mount.appendChild(body);

    const syncExpandedUi = () => {
      toggle.className = `commentaryArchiveToggle${expandedState.value ? "" : " is-collapsed"}`;
      chevron.className = `commentaryArchiveChevron${expandedState.value ? "" : " is-collapsed"}`;
      body.className = `commentaryArchiveBody${expandedState.value ? "" : " collapsed"}`;
      toggle.setAttribute("aria-expanded", expandedState.value ? "true" : "false");
      body.setAttribute("aria-hidden", expandedState.value ? "false" : "true");
    };
    toggle.addEventListener("click", () => {
      const syncViewport = prepareArchiveViewportAfterToggle(toggle);
      expandedState.value = !(expandedState.value === true);
      syncExpandedUi();
      syncViewport();
    });
    syncExpandedUi();
    return mount;
  }

  function createPlanCardNode(plan, options = {}) {
    const mount = documentRef.createElement("div");
    mount.className = "msg system kind-planCard";
    mount.innerHTML = `<div class="msgBody">${renderPlanCardHtml(plan, {
      escapeHtml,
      renderRichTextHtml: renderMessageRichHtml,
      cardClass: "commentaryArchivePlanCard",
    })}</div>`;
    attachMessageDebugMeta(mount, {
      role: "system",
      kind: "planCard",
      text: String(options.text || ""),
      source: String(options.source || "").trim() || "planCard",
      transient: false,
    });
    return mount;
  }

  function renderCommentaryArchive(options = {}) {
    const box = byId("chatBox");
    if (!box) return;
    const inlineArchiveCount = Math.max(0, Number(state.activeThreadInlineCommentaryArchiveCount || 0));
    const archive = Array.isArray(state.activeThreadCommentaryArchive)
      ? state.activeThreadCommentaryArchive.filter((block) => {
          const tools = Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
          return !!(block && (block?.summaryOnly === true || String(block.text || "").trim() || block?.plan || tools.length));
        })
      : [];
    const visible = state.activeThreadCommentaryArchiveVisible === true && archive.length > 0;
    const renderSig = buildCommentaryArchiveRenderSig(archive, options, box);
    const existingMount = byId("commentaryArchiveMount");
    if (lastCommentaryArchiveRenderSig === renderSig) {
      if ((!visible || inlineArchiveCount > 0) && !existingMount) return;
      if (visible && inlineArchiveCount === 0 && existingMount) return;
    }
    lastCommentaryArchiveRenderSig = renderSig;
    removeCommentaryArchiveMount();
    if (!visible || inlineArchiveCount > 0) return;

    const mount = createCommentaryArchiveNode(archive, { source: "commentaryArchiveMount" });
    mount.id = "commentaryArchiveMount";
    const toggle = mount.querySelector(".commentaryArchiveToggle");
    const chevron = mount.querySelector(".commentaryArchiveChevron");
    const body = mount.querySelector(".commentaryArchiveBody");
    const syncExpandedUi = () => {
      if (toggle) toggle.className = `commentaryArchiveToggle${state.activeThreadCommentaryArchiveExpanded ? "" : " is-collapsed"}`;
      if (chevron) chevron.className = `commentaryArchiveChevron${state.activeThreadCommentaryArchiveExpanded ? "" : " is-collapsed"}`;
      if (body) body.className = `commentaryArchiveBody${state.activeThreadCommentaryArchiveExpanded ? "" : " collapsed"}`;
      if (toggle) toggle.setAttribute("aria-expanded", state.activeThreadCommentaryArchiveExpanded ? "true" : "false");
      if (body) body.setAttribute("aria-hidden", state.activeThreadCommentaryArchiveExpanded ? "false" : "true");
    };
    if (toggle) {
      toggle.addEventListener("click", () => {
        const syncViewport = prepareArchiveViewportAfterToggle(toggle);
        state.activeThreadCommentaryArchiveExpanded = !(state.activeThreadCommentaryArchiveExpanded === true);
        syncExpandedUi();
        syncViewport();
      });
    }
    syncExpandedUi();

    const fallbackAssistantAnchor = (() => {
      const assistantNodes = Array.from(box.querySelectorAll(".assistant"));
      return assistantNodes.length ? assistantNodes[assistantNodes.length - 1] : null;
    })();
    const anchorNode =
      (options.anchorNode && options.anchorNode.parentElement === box ? options.anchorNode : null) ||
      fallbackAssistantAnchor ||
      box.querySelector("#runtimeChatPanels") ||
      null;
    const pendingMount = byId("pendingInlineMount");
    if (anchorNode) box.insertBefore(mount, anchorNode);
    else if (pendingMount && pendingMount.parentElement === box) box.insertBefore(mount, pendingMount);
    else box.appendChild(mount);
  }

  function addChat(role, text, options = {}) {
    const box = byId("chatBox");
    const welcome = byId("welcomeCard");
    if (!box) return;
    const messageKey = String(options.messageKey || "").trim();
    const existingNodes = messageKey ? findMessageNodesByKey(box, messageKey) : [];
    if (welcome) welcome.style.display = "none";
    const node = options.kind === "commentaryArchive"
      ? createCommentaryArchiveNode(options.archiveBlocks, {
          source: String(options.source || "").trim() || "addChat",
          key: options.archiveKey,
        })
      : options.kind === "planCard"
        ? createPlanCardNode(options.plan, {
            source: String(options.source || "").trim() || "addChat",
            text,
          })
      : createMessageNode(role, text, {
          kind: options.kind,
          attachments: options.attachments,
          source: String(options.source || "").trim() || "addChat",
          transient: options.transient === true,
        });
    if (messageKey) {
      node.setAttribute("data-msg-key", messageKey);
    }
    if (options.animate !== false && !existingNodes.length) {
      const defaultDelay = role === "assistant" || role === "system" ? 50 : 0;
      const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : defaultDelay;
      animateMessageNode(node, delayMs);
    }
    const pendingMount = byId("pendingInlineMount");
    if (existingNodes.length > 0) {
      const anchorNode = existingNodes[existingNodes.length - 1];
      anchorNode.replaceWith(node);
      for (let index = 0; index < existingNodes.length - 1; index += 1) {
        existingNodes[index].remove?.();
      }
    } else {
      const connectionStatusNode =
        messageKey === "live-thread-connection-status"
          ? null
          : findMessageNodesByKey(box, "live-thread-connection-status")[0] || null;
      if (connectionStatusNode && connectionStatusNode.parentElement === box) {
        box.insertBefore(node, connectionStatusNode);
      } else if (pendingMount && pendingMount.parentElement === box) {
        box.insertBefore(node, pendingMount);
      } else {
        box.appendChild(node);
      }
    }
    const source = String(options.source || "").trim() || "addChat";
    const shouldPersistTimelineTrace =
      role === "user" ||
      messageKey === "live-thread-connection-status" ||
      options.kind === "error" ||
      /reconnecting/i.test(String(text || ""));
    pushLiveDebugEvent("chat.timeline:add", {
      __tracePersist: shouldPersistTimelineTrace,
      role: String(role || ""),
      messageKind: String(options.kind || ""),
      source,
      messageKey,
      replacedExistingCount: existingNodes.length,
      text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 120),
      timeline: summarizeChatTimeline(box),
    });
    renderRuntimePanels();
    if (options.scroll !== false) {
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      box.scrollTop = box.scrollHeight;
      scheduleChatLiveFollow(800);
    }
    updateScrollToBottomBtn();
  }

  function createAssistantStreamingMessage() {
    const msg = documentRef.createElement("div");
    msg.className = "msg assistant";
    msg.innerHTML = `<div class="msgHead">assistant</div><div class="msgBody"></div>`;
    animateMessageNode(msg, 50);
    attachMessageDebugMeta(msg, { role: "assistant", kind: "", text: "", source: "streaming" });
    const body = msg.querySelector(".msgBody");
    return { msg, body };
  }

  function ensureStreamingBody(body) {
    if (!body) return null;
    try {
      body.setAttribute("data-streaming", "1");
    } catch {}
    let box = body.querySelector(".streamChunks");
    if (!box) {
      box = documentRef.createElement("div");
      box.className = "streamChunks";
      body.textContent = "";
      body.appendChild(box);
    }
    if (!body.__streaming) {
      body.__streaming = { pending: "", scheduled: false };
    }
    return { box, st: body.__streaming };
  }

  function flushStreamingBody(body) {
    const prepared = ensureStreamingBody(body);
    if (!prepared) return;
    const { box, st } = prepared;
    const pending = String(st.pending || "");
    st.pending = "";
    st.scheduled = false;
    if (!pending) return;

    const parts = pending.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part) {
        const span = documentRef.createElement("span");
        span.className = "streamChunk";
        span.textContent = part;
        box.appendChild(span);
      }
      if (i !== parts.length - 1) box.appendChild(documentRef.createElement("br"));
    }
  }

  function appendStreamingDelta(body, text) {
    const prepared = ensureStreamingBody(body);
    if (!prepared) return;
    const { st } = prepared;
    st.pending += String(text || "");
    if (st.scheduled) return;
    st.scheduled = true;
    requestAnimationFrameRef(() => flushStreamingBody(body));
  }

  function renderAssistantLiveBody(msgNode, bodyNode, text) {
    if (!msgNode || !bodyNode) return;
    const liveText = String(text || "");
    try {
      bodyNode.setAttribute("data-streaming", "1");
      bodyNode.__streaming = null;
    } catch {}
    bodyNode.innerHTML = renderMessageBody("assistant", liveText, { kind: "" });
    attachMessageDebugMeta(msgNode, {
      role: "assistant",
      kind: "",
      text: liveText,
      source: "renderAssistantLiveBody",
    });
    wireMessageLinks(msgNode);
  }

  function finalizeAssistantMessage(msgNode, bodyNode, text) {
    if (!msgNode || !bodyNode) return;
    const finalText = String(text || "").trim();
    try {
      bodyNode.removeAttribute("data-streaming");
      bodyNode.__streaming = null;
    } catch {}
    try {
      msgNode.removeAttribute("data-live-assistant");
      msgNode.removeAttribute("data-live-thread-id");
    } catch {}
    bodyNode.innerHTML = renderMessageBody("assistant", finalText, { kind: "" });
    attachMessageDebugMeta(msgNode, { role: "assistant", kind: "", text: finalText, source: "finalizeAssistantMessage" });
    wireMessageLinks(msgNode);
  }

  function clearChatMessages(options = {}) {
    pushLiveDebugEvent("chat.clear", {
      activeThreadId: String(state.activeThreadId || ""),
      pendingThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      pendingUser: String(state.activeThreadPendingUserMessage || ""),
      pendingAssistant: String(state.activeThreadPendingAssistantMessage || ""),
      preservePendingTurn: !!(options && options.preservePendingTurn === true),
    });
    const box = byId("chatBox");
    if (!box) return;
    const preserveScroll = options && options.preserveScroll === true;
    const preservePendingTurn = options && options.preservePendingTurn === true;
    const welcome = byId("welcomeCard");
    const overlay = byId("chatOpeningOverlay");
    const keep = [];
    if (welcome && welcome.parentElement === box) keep.push(welcome);
    if (overlay && overlay.parentElement === box) keep.push(overlay);
    box.replaceChildren(...keep);
    if (!preserveScroll) box.scrollTop = 0;
    lastCommentaryArchiveRenderSig = "";
    state.activeThreadRenderSig = "";
    state.activeThreadMessages = [];
    if (!preservePendingTurn) {
      resetTurnPresentationState(state, { bumpLiveEpoch: true, resetLiveRuntimeEpoch: true });
      resetPendingTurnRuntime(state, { reason: "chat.clear" });
    }
    state.historyWindowEnabled = false;
    state.historyWindowThreadId = "";
    state.historyWindowStart = 0;
    state.historyWindowLoading = false;
    state.historyAllMessages = [];
    state.activeThreadHistoryTurns = [];
    state.activeThreadHistoryThreadId = "";
    state.activeThreadHistoryHasMore = false;
    state.activeThreadHistoryIncomplete = false;
    state.activeThreadHistoryStatusType = "";
    state.activeThreadHistoryBeforeCursor = "";
    state.activeThreadHistoryTotalTurns = 0;
    state.activeThreadHistoryUserCount = 0;
    state.activeThreadHistoryReqSeq = 0;
    state.activeThreadHistoryInFlightPromise = null;
    state.activeThreadHistoryInFlightThreadId = "";
    state.activeThreadHistoryPendingRefresh = null;
    renderRuntimePanels();
    lastPendingInlineRenderSig = "";
    renderPendingInline();
  }

  function setChatOpening(isOpening) {
    const overlay = byId("chatOpeningOverlay");
    const box = byId("chatBox");
    if (!overlay) return;
    state.chatOpening = isOpening === true;
    if (isOpening) {
      clearChatMessages();
      const welcome = byId("welcomeCard");
      if (welcome) welcome.style.display = "none";
      state.chatShouldStickToBottom = true;
      state.chatUserScrolledAwayAt = 0;
      state.chatProgrammaticScrollUntil = Date.now() + 260;
      if (box) {
        box.scrollTop = 0;
        box.classList.add("chat-opening");
        box.classList.remove("chat-opening-reveal");
      }
    } else if (box) {
      const hadOpeningClass = box.classList.contains("chat-opening");
      box.classList.remove("chat-opening");
      if (hadOpeningClass) {
        box.classList.remove("chat-opening-reveal");
        box.classList.add("chat-opening-reveal");
        const clearRevealClass = () => box.classList.remove("chat-opening-reveal");
        if (typeof box.addEventListener === "function") {
          box.addEventListener("animationend", clearRevealClass, { once: true });
        }
      }
    }
    overlay.classList.toggle("show", !!isOpening);
  }

  return {
    addChat,
    appendStreamingDelta,
    attachMessageDebugMeta,
    animateMessageNode,
    buildMsgNode,
    clearChatMessages,
    createAssistantStreamingMessage,
    ensureStreamingBody,
    finalizeAssistantMessage,
    flushStreamingBody,
    renderCommentaryArchive,
    renderAssistantLiveBody,
    renderPendingInline,
    removeCommentaryArchiveMount,
    removePendingInlineMount,
    removeChatMessageByKey,
    setChatOpening,
  };
}
