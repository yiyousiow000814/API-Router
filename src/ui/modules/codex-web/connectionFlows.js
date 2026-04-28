import { isTerminalHistoryStatus } from "./historyLiveCommentaryState.js";
import { getProposedPlanConfirmation } from "./proposedPlan.js";

export function pickPendingDefaults(approvals, userInputs) {
  const approvalId = Array.isArray(approvals) && approvals[0]?.id ? approvals[0].id : "";
  const userInputId = Array.isArray(userInputs) && userInputs[0]?.id ? userInputs[0].id : "";
  return { approvalId, userInputId };
}

export function normalizePendingSelection(items, selectedId, fallbackId = "") {
  const normalizedSelectedId = String(selectedId || "").trim();
  if (
    normalizedSelectedId &&
    Array.isArray(items) &&
    items.some((item) => String(item?.id || "").trim() === normalizedSelectedId)
  ) {
    return normalizedSelectedId;
  }
  return String(fallbackId || "").trim();
}

export function normalizePendingUserInputQuestions(item) {
  if (Array.isArray(item?.questions) && item.questions.length) {
    return item.questions
      .filter((question) => question && typeof question === "object")
      .map((question, index) => ({
        id: String(question.id || `question_${index + 1}`).trim(),
        header: String(question.header || `Question ${index + 1}`).trim(),
        prompt: String(question.question || question.prompt || question.title || "").trim(),
        options: Array.isArray(question.options)
          ? question.options
              .filter((option) => option && typeof option === "object")
              .map((option) => ({
                label: String(option.label || option.value || option.id || "").trim(),
                description: String(option.description || "").trim(),
              }))
              .filter((option) => option.label)
          : [],
      }));
  }
  const fallbackPrompt = String(item?.prompt || item?.title || item?.question || "").trim();
  if (!fallbackPrompt) return [];
  return [{
    id: String(item?.answerKey || item?.key || "answer").trim(),
    header: String(item?.header || "Question").trim(),
    prompt: fallbackPrompt,
    options: Array.isArray(item?.options)
      ? item.options
          .filter((option) => option && typeof option === "object")
          .map((option) => ({
            label: String(option.label || option.value || option.id || "").trim(),
            description: String(option.description || "").trim(),
          }))
          .filter((option) => option.label)
      : [],
  }];
}

export function parsePendingOptionDisplay(option, index = 0) {
  const rawLabel = String(option?.label || "").trim();
  const description = String(option?.description || "").trim();
  const recommended = /\(recommended\)$/i.test(rawLabel);
  const label = recommended
    ? rawLabel.replace(/\s*\(recommended\)\s*$/i, "").trim()
    : rawLabel;
  return {
    label,
    description,
    recommended,
    ordinal: Math.max(1, Number(index || 0) + 1),
  };
}

export function getPendingUserInputCompletedMap(state, id = "") {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return {};
  const map = state?.pendingUserInputCompletedKeysById?.[normalizedId];
  return map && typeof map === "object" ? map : {};
}

export function getPendingUserInputProgress(state, item) {
  const id = String(item?.id || "").trim();
  const questions = normalizePendingUserInputQuestions(item);
  const completed = getPendingUserInputCompletedMap(state, id);
  const completedCount = questions.reduce((count, question) => count + (completed[question.id] === true ? 1 : 0), 0);
  const currentIndex = questions.findIndex((question) => completed[question.id] !== true);
  return {
    id,
    questions,
    totalQuestions: questions.length,
    completedCount,
    unansweredCount: Math.max(0, questions.length - completedCount),
    currentIndex,
    currentQuestion: currentIndex >= 0 ? questions[currentIndex] : null,
    isComplete: questions.length > 0 && completedCount >= questions.length,
  };
}

export function getSyntheticPendingUserInputsForThread(state, threadId = "") {
  const normalizedThreadId = String(threadId || state?.activeThreadId || "").trim();
  if (!normalizedThreadId) return [];
  const all =
    state?.syntheticPendingUserInputsByThreadId &&
    typeof state.syntheticPendingUserInputsByThreadId === "object"
      ? state.syntheticPendingUserInputsByThreadId
      : {};
  return Array.isArray(all[normalizedThreadId]) ? all[normalizedThreadId] : [];
}

export function getVisiblePendingUserInputs(state, threadId = "") {
  const normalizedThreadId = String(threadId || state?.activeThreadId || "").trim();
  const historyStatusType = String(state?.activeThreadHistoryStatusType || "").trim().toLowerCase();
  if (normalizedThreadId && isTerminalHistoryStatus(historyStatusType)) {
    return [];
  }
  const real = Array.isArray(state?.pendingUserInputs) ? state.pendingUserInputs : [];
  const hasScopedRealItems = real.some((item) =>
    !!String(item?.threadId || item?.thread_id || item?.thread?.id || "").trim()
  );
  const visibleReal = hasScopedRealItems && normalizedThreadId
    ? real.filter((item) => String(item?.threadId || item?.thread_id || item?.thread?.id || "").trim() === normalizedThreadId)
    : real;
  const suppressed = state?.suppressedSyntheticPendingUserInputsByThreadId?.[normalizedThreadId] === true;
  const synthetic = suppressed ? [] : getSyntheticPendingUserInputsForThread(state, normalizedThreadId);
  if (!synthetic.length) return visibleReal;
  const deduped = new Map();
  for (const item of synthetic) {
    const id = String(item?.id || "").trim();
    if (!id || deduped.has(id)) continue;
    deduped.set(id, item);
  }
  for (const item of visibleReal) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    deduped.set(id, item);
  }
  return Array.from(deduped.values());
}

function normalizePendingAnswerMode(value) {
  return String(value || "").trim().toLowerCase() === "freeform" ? "freeform" : "option";
}

export function createConnectionFlowsModule(deps) {
  const {
    state,
    byId,
    api,
    wsSend,
    nextReqId,
    connectWs,
    ensureArrayItems,
    escapeHtml,
    blockInSandbox,
    TOKEN_STORAGE_KEY,
    getEmbeddedToken,
    refreshModels,
    refreshCodexVersions,
    refreshThreads,
    refreshWorkspaceRuntimeState = async () => null,
    getWorkspaceTarget,
    setStatus,
    setMainTab,
    setMobileTab,
    addChat,
    renderPendingInline = () => {},
  } = deps;

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

  function getAllPendingUserInputIds() {
    const ids = new Set();
    for (const item of Array.isArray(state.pendingUserInputs) ? state.pendingUserInputs : []) {
      const id = String(item?.id || "").trim();
      if (id) ids.add(id);
    }
    const syntheticByThread =
      state.syntheticPendingUserInputsByThreadId && typeof state.syntheticPendingUserInputsByThreadId === "object"
        ? state.syntheticPendingUserInputsByThreadId
        : {};
    for (const items of Object.values(syntheticByThread)) {
      for (const item of Array.isArray(items) ? items : []) {
        const id = String(item?.id || "").trim();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  function prunePendingUserInputDrafts() {
    const activeIds = getAllPendingUserInputIds();
    const current =
      state.pendingUserInputAnswersById && typeof state.pendingUserInputAnswersById === "object"
        ? state.pendingUserInputAnswersById
        : {};
    const currentModes =
      state.pendingUserInputAnswerModesById && typeof state.pendingUserInputAnswerModesById === "object"
        ? state.pendingUserInputAnswerModesById
        : {};
    const currentCompleted =
      state.pendingUserInputCompletedKeysById && typeof state.pendingUserInputCompletedKeysById === "object"
        ? state.pendingUserInputCompletedKeysById
        : {};
    const next = {};
    const nextModes = {};
    const nextCompleted = {};
    for (const [id, answers] of Object.entries(current)) {
      if (!activeIds.has(id)) continue;
      next[id] = answers && typeof answers === "object" ? { ...answers } : {};
      nextModes[id] = currentModes[id] && typeof currentModes[id] === "object" ? { ...currentModes[id] } : {};
      nextCompleted[id] =
        currentCompleted[id] && typeof currentCompleted[id] === "object" ? { ...currentCompleted[id] } : {};
    }
    state.pendingUserInputAnswersById = next;
    state.pendingUserInputAnswerModesById = nextModes;
    state.pendingUserInputCompletedKeysById = nextCompleted;
  }

  function setPendingUserInputDraftAnswer(id, answerKey, answerValue, options = {}) {
    const normalizedId = String(id || "").trim();
    const normalizedKey = String(answerKey || "").trim();
    if (!normalizedId || !normalizedKey) return false;
    const current =
      state.pendingUserInputAnswersById && typeof state.pendingUserInputAnswersById === "object"
        ? state.pendingUserInputAnswersById
        : {};
    const nextAnswers = {
      ...(current[normalizedId] && typeof current[normalizedId] === "object"
        ? current[normalizedId]
        : {}),
      [normalizedKey]: String(answerValue || ""),
    };
    const currentModes =
      state.pendingUserInputAnswerModesById && typeof state.pendingUserInputAnswerModesById === "object"
        ? state.pendingUserInputAnswerModesById
        : {};
    const nextModes = {
      ...(currentModes[normalizedId] && typeof currentModes[normalizedId] === "object"
        ? currentModes[normalizedId]
        : {}),
      [normalizedKey]: normalizePendingAnswerMode(options.mode),
    };
    state.pendingUserInputAnswersById = {
      ...current,
      [normalizedId]: nextAnswers,
    };
    state.pendingUserInputAnswerModesById = {
      ...currentModes,
      [normalizedId]: nextModes,
    };
    if (options.complete !== undefined) {
      const currentCompleted =
        state.pendingUserInputCompletedKeysById && typeof state.pendingUserInputCompletedKeysById === "object"
          ? state.pendingUserInputCompletedKeysById
          : {};
      const completedForId =
        currentCompleted[normalizedId] && typeof currentCompleted[normalizedId] === "object"
          ? currentCompleted[normalizedId]
          : {};
      const nextCompletedForId = { ...completedForId };
      if (options.complete === true) nextCompletedForId[normalizedKey] = true;
      else delete nextCompletedForId[normalizedKey];
      state.pendingUserInputCompletedKeysById = {
        ...currentCompleted,
        [normalizedId]: nextCompletedForId,
      };
    }
    renderPendingLists();
    renderPendingInline();
    return true;
  }

  function getPendingUserInputDraftMode(id, answerKey) {
    const normalizedId = String(id || "").trim();
    const normalizedKey = String(answerKey || "").trim();
    if (!normalizedId || !normalizedKey) return "option";
    const value = state.pendingUserInputAnswerModesById?.[normalizedId]?.[normalizedKey];
    return normalizePendingAnswerMode(value);
  }

  function getPendingUserInputDraftAnswers(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return {};
    const answers = state.pendingUserInputAnswersById?.[normalizedId];
    if (!answers || typeof answers !== "object") return {};
    const next = {};
    for (const [key, value] of Object.entries(answers)) {
      const normalizedValue = String(value || "").trim();
      if (!normalizedValue) continue;
      next[key] = normalizedValue;
    }
    return next;
  }

  function setPendingUserInputQuestionCompleted(id, answerKey, completed = true) {
    const normalizedId = String(id || "").trim();
    const normalizedKey = String(answerKey || "").trim();
    if (!normalizedId || !normalizedKey) return false;
    const current =
      state.pendingUserInputCompletedKeysById && typeof state.pendingUserInputCompletedKeysById === "object"
        ? state.pendingUserInputCompletedKeysById
        : {};
    const currentForId =
      current[normalizedId] && typeof current[normalizedId] === "object"
        ? current[normalizedId]
        : {};
    const nextForId = { ...currentForId };
    if (completed === true) nextForId[normalizedKey] = true;
    else delete nextForId[normalizedKey];
    state.pendingUserInputCompletedKeysById = {
      ...current,
      [normalizedId]: nextForId,
    };
    renderPendingLists();
    renderPendingInline();
    return true;
  }

  function getPendingUserInputById(id) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return null;
    const items = getVisiblePendingUserInputs(state);
    return items.find((item) => String(item?.id || "").trim() === normalizedId) || null;
  }

  function getPendingUserInputSubmissionState(id) {
    const item = getPendingUserInputById(id);
    if (!item) {
      return {
        id: String(id || "").trim(),
        item: null,
        questions: [],
        currentQuestion: null,
        currentQuestionId: "",
        currentMode: "option",
        currentAnswer: "",
        currentIndex: -1,
        totalQuestions: 0,
        completedCount: 0,
        unansweredCount: 0,
        isComplete: false,
      };
    }
    const progress = getPendingUserInputProgress(state, item);
    const currentQuestionId = String(progress.currentQuestion?.id || "").trim();
    return {
      id: String(id || "").trim(),
      item,
      questions: progress.questions,
      currentQuestion: progress.currentQuestion,
      currentQuestionId,
      currentMode: currentQuestionId ? getPendingUserInputDraftMode(id, currentQuestionId) : "option",
      currentAnswer: currentQuestionId ? String(getPendingUserInputDraftAnswers(id)?.[currentQuestionId] || "") : "",
      currentIndex: progress.currentIndex,
      totalQuestions: progress.totalQuestions,
      completedCount: progress.completedCount,
      unansweredCount: progress.unansweredCount,
      isComplete: progress.isComplete,
    };
  }

  function suppressSyntheticPendingUserInputs(threadId, suppressed = true) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) return false;
    const current =
      state.suppressedSyntheticPendingUserInputsByThreadId &&
      typeof state.suppressedSyntheticPendingUserInputsByThreadId === "object"
        ? state.suppressedSyntheticPendingUserInputsByThreadId
        : {};
    const next = { ...current };
    if (suppressed) next[normalizedThreadId] = true;
    else delete next[normalizedThreadId];
    state.suppressedSyntheticPendingUserInputsByThreadId = next;
    return true;
  }

  function syncPendingSelectionInputs() {
    const approvalIdInput = byId("approvalIdInput");
    const userInputIdInput = byId("userInputIdInput");
    if (approvalIdInput) approvalIdInput.value = String(state.selectedPendingApprovalId || "").trim();
    if (userInputIdInput) userInputIdInput.value = String(state.selectedPendingUserInputId || "").trim();
  }

  function syncPendingSelectionsForCurrentThread() {
    const visibleUserInputs = getVisiblePendingUserInputs(state);
    const defaults = pickPendingDefaults(state.pendingApprovals, visibleUserInputs);
    state.selectedPendingApprovalId = normalizePendingSelection(
      state.pendingApprovals,
      state.selectedPendingApprovalId,
      defaults.approvalId
    );
    state.selectedPendingUserInputId = normalizePendingSelection(
      visibleUserInputs,
      state.selectedPendingUserInputId,
      defaults.userInputId
    );
    syncPendingSelectionInputs();
  }

  function setSyntheticPendingUserInputs(threadId, items) {
    const normalizedThreadId = String(threadId || "").trim();
    const current =
      state.syntheticPendingUserInputsByThreadId && typeof state.syntheticPendingUserInputsByThreadId === "object"
        ? state.syntheticPendingUserInputsByThreadId
        : {};
    if (!normalizedThreadId) return false;
    const next = { ...current };
    const normalizedItems = ensureArrayItems(items).filter((item) => item && typeof item === "object");
    if (normalizedItems.length) next[normalizedThreadId] = normalizedItems;
    else delete next[normalizedThreadId];
    state.syntheticPendingUserInputsByThreadId = next;
    pushLiveDebugEvent("pending.synthetic:set", {
      threadId: normalizedThreadId,
      count: normalizedItems.length,
      ids: normalizedItems.map((item) => String(item?.id || "").trim()).filter(Boolean).slice(0, 12),
    });
    if (normalizedItems.length) suppressSyntheticPendingUserInputs(normalizedThreadId, false);
    prunePendingUserInputDrafts();
    syncPendingSelectionsForCurrentThread();
    renderPendingLists();
    renderPendingInline();
    return true;
  }

  function upsertSyntheticPendingUserInput(threadId, item) {
    const normalizedThreadId = String(threadId || "").trim();
    const normalizedId = String(item?.id || "").trim();
    if (!normalizedThreadId || !normalizedId) return false;
    suppressSyntheticPendingUserInputs(normalizedThreadId, false);
    const current = getSyntheticPendingUserInputsForThread(state, normalizedThreadId);
    const next = current.filter((entry) => String(entry?.id || "").trim() !== normalizedId);
    next.push(item);
    return setSyntheticPendingUserInputs(normalizedThreadId, next);
  }

  function clearSyntheticPendingUserInputById(id, threadId = "") {
    const normalizedId = String(id || "").trim();
    if (!normalizedId) return false;
    const current =
      state.syntheticPendingUserInputsByThreadId && typeof state.syntheticPendingUserInputsByThreadId === "object"
        ? state.syntheticPendingUserInputsByThreadId
        : {};
    const next = { ...current };
    let changed = false;
    const targetThreadId = String(threadId || "").trim();
    const threadIds = targetThreadId ? [targetThreadId] : Object.keys(next);
    for (const currentThreadId of threadIds) {
      const items = Array.isArray(next[currentThreadId]) ? next[currentThreadId] : [];
      const filtered = items.filter((item) => String(item?.id || "").trim() !== normalizedId);
      if (filtered.length === items.length) continue;
      changed = true;
      if (filtered.length) next[currentThreadId] = filtered;
      else delete next[currentThreadId];
    }
    if (!changed) return false;
    state.syntheticPendingUserInputsByThreadId = next;
    pushLiveDebugEvent("pending.synthetic:clear_id", {
      threadId: targetThreadId || String(state.activeThreadId || "").trim(),
      pendingId: normalizedId,
    });
    prunePendingUserInputDrafts();
    syncPendingSelectionsForCurrentThread();
    renderPendingLists();
    renderPendingInline();
    return true;
  }

  function clearPendingUserInputs(options = {}) {
    const targetThreadId = String(options.threadId || state.activeThreadId || "").trim();
    const current = Array.isArray(state.pendingUserInputs) ? state.pendingUserInputs : [];
    if (!current.length) return false;
    const hasScopedItems = current.some((item) =>
      !!String(item?.threadId || item?.thread_id || item?.thread?.id || "").trim()
    );
    const next = [];
    let changed = false;
    for (const item of current) {
      const itemThreadId = String(item?.threadId || item?.thread_id || item?.thread?.id || "").trim();
      const shouldRemove =
        options.clearAll === true ||
        (!hasScopedItems && !!targetThreadId) ||
        (!!targetThreadId && !!itemThreadId && itemThreadId === targetThreadId);
      if (shouldRemove) {
        changed = true;
        continue;
      }
      next.push(item);
    }
    if (!changed) return false;
    state.pendingUserInputs = next;
    pushLiveDebugEvent("pending.real:clear", {
      threadId: targetThreadId,
      clearAll: options.clearAll === true,
      remaining: next.length,
    });
    prunePendingUserInputDrafts();
    syncPendingSelectionsForCurrentThread();
    renderPendingLists();
    renderPendingInline();
    return true;
  }

  function setActiveHost(id) {
    state.activeHostId = id || "";
    const activeHostLabel = byId("activeHostId");
    if (activeHostLabel) activeHostLabel.textContent = state.activeHostId || "(none)";
  }

  function renderHosts(items) {
    const list = byId("hostList");
    if (!list) return;
    list.innerHTML = "";
    for (const host of items) {
      const row = document.createElement("div");
      row.className = "row wrap";
      const card = document.createElement("button");
      card.className = "itemCard grow";
      card.innerHTML = `<div class="itemTitle">${escapeHtml(host.name || host.id)}</div><div class="itemSub mono">${escapeHtml(host.base_url || "")}</div>`;
      card.onclick = () => setActiveHost(host.id || "");
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Delete";
      del.onclick = async () => {
        if (blockInSandbox("host deletion")) return;
        await api(`/codex/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
        if (state.activeHostId === host.id) setActiveHost("");
        await refreshHosts();
      };
      row.appendChild(card);
      row.appendChild(del);
      list.appendChild(row);
    }
    if (!items.length) list.innerHTML = `<div class="muted">No hosts configured.</div>`;
  }

  function renderPendingLists() {
    const approvalList = byId("approvalPendingList");
    if (!approvalList) return;
    approvalList.innerHTML = "";
    for (const item of state.pendingApprovals) {
      const id = item?.id || "";
      const card = document.createElement("div");
      card.className = "settingsPendingCard";
      if (String(state.selectedPendingApprovalId || "").trim() === String(id).trim()) {
        card.classList.add("is-selected");
      }
      card.innerHTML = `
        <button class="settingsPendingSelect" type="button" data-pending-approval-select="${escapeHtml(id)}">
          <div class="itemTitle">${escapeHtml(id || "approval")}</div>
          <div class="itemSub">${escapeHtml(item?.prompt || item?.title || item?.message || "")}</div>
        </button>
        <div class="settingsPendingActions">
          <button class="settingsChoiceBtn" type="button" data-pending-approval-id="${escapeHtml(id)}" data-pending-approval-decision="approve">Approve</button>
          <button class="settingsChoiceBtn" type="button" data-pending-approval-id="${escapeHtml(id)}" data-pending-approval-decision="reject">Reject</button>
        </div>`;
      card.onclick = (event) => {
        if (event?.target?.closest?.("[data-pending-approval-decision]")) return;
        state.selectedPendingApprovalId = id;
        syncPendingSelectionInputs();
        setStatus(`Selected approval ${id}`);
      };
      approvalList.appendChild(card);
    }
    if (!state.pendingApprovals.length) {
      approvalList.innerHTML = `<div class="muted">No pending approvals.</div>`;
    }

    const userInputList = byId("userInputPendingList");
    if (!userInputList) return;
    userInputList.innerHTML = "";
    const proposedPlanConfirmation = getProposedPlanConfirmation(state);
    if (proposedPlanConfirmation) {
      const title = String(proposedPlanConfirmation.plan?.title || "Proposed Plan").trim();
      const prompt = String(proposedPlanConfirmation.prompt || proposedPlanConfirmation.title || "Implement this plan?").trim();
      const card = document.createElement("div");
      card.className = "settingsPendingCard";
      card.innerHTML = `
        <div class="settingsPendingSelect">
          <div class="itemTitle">${escapeHtml(title)}</div>
          <div class="itemSub">${escapeHtml(prompt)}</div>
        </div>
        <div class="settingsPendingActions">
          <button class="settingsChoiceBtn" type="button" data-proposed-plan-decision="approve">Implement</button>
          <button class="settingsChoiceBtn" type="button" data-proposed-plan-decision="stay">Stay in Plan</button>
        </div>`;
      userInputList.appendChild(card);
    }
    const visibleUserInputs = getVisiblePendingUserInputs(state);
    for (const item of visibleUserInputs) {
      const id = item?.id || "";
      const draftAnswers = getPendingUserInputDraftAnswers(id);
      const progress = getPendingUserInputProgress(state, item);
      const question = progress.currentQuestion;
      const progressLabel = progress.totalQuestions > 0
        ? `Question ${Math.min(progress.completedCount + 1, progress.totalQuestions)}/${progress.totalQuestions}`
        : "Question";
      const summaryLabel = progress.isComplete
        ? "Ready to submit"
        : `${progress.unansweredCount} unanswered`;
      const card = document.createElement("div");
      card.className = "settingsPendingCard";
      if (String(state.selectedPendingUserInputId || "").trim() === String(id).trim()) {
        card.classList.add("is-selected");
      }
      const questionsHtml = question
        ? [question]
        .map((currentQuestion) => {
          const mode = getPendingUserInputDraftMode(id, currentQuestion.id);
          const typedValue = String(draftAnswers?.[currentQuestion.id] || "");
          const optionsHtml = currentQuestion.options.length
            ? currentQuestion.options
                .map((option) => {
                  const meta = parsePendingOptionDisplay(option, currentQuestion.options.indexOf(option));
                  const active = mode !== "freeform" && String(draftAnswers?.[currentQuestion.id] || "").trim() === option.label;
                  return `<button class="settingsPendingOptionCard${active ? " is-active" : ""}" type="button" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" data-pending-answer-value="${escapeHtml(option.label)}">
                    <span class="settingsPendingOptionTop">
                      <span class="settingsPendingOptionTitle">${escapeHtml(`${meta.ordinal}. ${meta.label}`)}</span>
                      ${meta.recommended ? '<span class="settingsPendingOptionBadge">Recommended</span>' : ""}
                    </span>
                    ${meta.description ? `<span class="settingsPendingOptionDesc">${escapeHtml(meta.description)}</span>` : ""}
                  </button>`;
                })
                .join("")
            : `<div class="itemSub">No preset options.</div>`;
          return `
            <div class="settingsPendingQuestion">
              <div class="settingsPendingQuestionHeader">${escapeHtml(progressLabel)}</div>
              <div class="settingsPendingQuestionPrompt">${escapeHtml(currentQuestion.prompt || item?.prompt || item?.title || item?.question || "Question")}</div>
              <div class="settingsPendingOptions">${optionsHtml}</div>
              <div class="settingsPendingOptions">
                <button class="settingsPendingOptionCard settingsPendingOptionCard-ghost${mode === "freeform" ? " is-active" : ""}" type="button" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" data-pending-answer-mode="freeform">
                  <span class="settingsPendingOptionTop">
                    <span class="settingsPendingOptionTitle">None of the above</span>
                  </span>
                  <span class="settingsPendingOptionDesc">Add your own answer in a note below.</span>
                </button>
              </div>
              <textarea class="settingsPendingFreeform${mode === "freeform" ? " is-visible" : ""}" data-pending-freeform-input="1" data-pending-user-input-id="${escapeHtml(id)}" data-pending-answer-key="${escapeHtml(currentQuestion.id)}" placeholder="Type your answer...">${escapeHtml(mode === "freeform" ? typedValue : "")}</textarea>
            </div>`;
        })
        .join("")
        : `<div class="settingsPendingQuestion"><div class="settingsPendingQuestionHeader">${escapeHtml(progressLabel)}</div><div class="settingsPendingQuestionPrompt">${escapeHtml(summaryLabel)}</div></div>`;
      card.innerHTML = `
        <button class="settingsPendingSelect" type="button" data-pending-user-input-select="${escapeHtml(id)}">
          <div class="itemTitle">${escapeHtml(progressLabel)}</div>
          <div class="itemSub">${escapeHtml(summaryLabel)}</div>
        </button>
        <div class="settingsPendingQuestions">${questionsHtml}</div>
        <div class="settingsPendingActions">
          <button class="settingsChoiceBtn" type="button" data-pending-user-input-submit="${escapeHtml(id)}">Submit answer</button>
        </div>`;
      card.onclick = (event) => {
        if (
          event?.target?.closest?.("[data-pending-user-input-submit]") ||
          event?.target?.closest?.("[data-pending-answer-key]")
        ) return;
        state.selectedPendingUserInputId = id;
        syncPendingSelectionInputs();
        setStatus(`Selected user_input ${id}`);
      };
      userInputList.appendChild(card);
    }
    if (!visibleUserInputs.length) {
      userInputList.innerHTML = `<div class="muted">No pending user inputs.</div>`;
    }
  }

  function applyPendingPayloads(approvals, userInputs) {
    state.pendingApprovals = ensureArrayItems(approvals);
    state.pendingUserInputs = ensureArrayItems(userInputs);
    pushLiveDebugEvent("pending.payloads:apply", {
      threadId: String(state.activeThreadId || "").trim(),
      approvalCount: state.pendingApprovals.length,
      userInputCount: state.pendingUserInputs.length,
      approvalIds: state.pendingApprovals.map((item) => String(item?.id || "").trim()).filter(Boolean).slice(0, 12),
      userInputIds: state.pendingUserInputs.map((item) => String(item?.id || "").trim()).filter(Boolean).slice(0, 12),
      historyStatusType: String(state.activeThreadHistoryStatusType || "").trim().toLowerCase(),
    });
    prunePendingUserInputDrafts();
    syncPendingSelectionsForCurrentThread();
    renderPendingLists();
    renderPendingInline();
  }

  async function refreshHosts() {
    const data = await api("/codex/hosts");
    renderHosts(Array.isArray(data.items) ? data.items : []);
  }

  async function refreshPendingFromHttp() {
    const workspace =
      state.activeThreadWorkspace === "wsl2" || state.activeThreadWorkspace === "windows"
        ? state.activeThreadWorkspace
        : getWorkspaceTarget();
    const workspaceQuery = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    const [approvals, userInputs] = await Promise.all([
      api(`/codex/approvals/pending${workspaceQuery}`),
      api(`/codex/user-input/pending${workspaceQuery}`),
    ]);
    applyPendingPayloads(approvals.items, userInputs.items);
  }

  async function refreshPending() {
    connectWs();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      wsSend({
        type: "events.refresh",
        reqId: nextReqId(),
        payload: {
          workspace:
            state.activeThreadWorkspace === "wsl2" || state.activeThreadWorkspace === "windows"
              ? state.activeThreadWorkspace
              : getWorkspaceTarget(),
        },
      });
      return;
    }
    await refreshPendingFromHttp();
  }

  async function refreshAll() {
    const currentTarget = getWorkspaceTarget();
    const tasks = [
      refreshThreads(currentTarget, { force: false, silent: false }),
      refreshHosts(),
      refreshWorkspaceRuntimeState(currentTarget, { silent: true }),
    ];
    await Promise.all(tasks);
    await refreshPending();
  }

  async function connect(options = {}) {
    const inputToken = byId("tokenInput")?.value?.trim() || "";
    const managedToken = getEmbeddedToken();
    state.token = inputToken || (managedToken ? managedToken : String(state.token || "").trim());
    if (managedToken) localStorage.removeItem(TOKEN_STORAGE_KEY);
    else localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
    await api("/codex/auth/verify", { method: "POST", body: {} });
    connectWs();
    setStatus("Connected.");
    refreshModels().catch((e) => setStatus(e.message, true));
    refreshCodexVersions().catch((e) => setStatus(e.message, true));
    await refreshAll();
    if (options.switchToChat !== false) setMainTab("chat");
  }

  return {
    applyPendingPayloads,
    connect,
    getVisiblePendingUserInputs,
    getPendingUserInputDraftAnswers,
    getPendingUserInputDraftMode,
    setPendingUserInputQuestionCompleted,
    getPendingUserInputSubmissionState,
    refreshAll,
    refreshHosts,
    refreshPending,
    refreshPendingFromHttp,
    renderHosts,
    renderPendingLists,
    clearPendingUserInputs,
    clearSyntheticPendingUserInputById,
    setPendingUserInputDraftAnswer,
    setSyntheticPendingUserInputs,
    setActiveHost,
    suppressSyntheticPendingUserInputs,
    upsertSyntheticPendingUserInput,
  };
}
