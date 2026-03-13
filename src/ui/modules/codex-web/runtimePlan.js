function defaultNormalizeType(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readText(value) {
  return value == null ? "" : String(value).trim();
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function normalizePlanSteps(value, normalizeType = defaultNormalizeType) {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((step) => ({
      step: readText(step?.step),
      status: normalizeType(step?.status) || "pending",
    }))
    .filter((step) => step.step);
}

export function parsePlanStepsFromText(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  return lines
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
    .map((step) => ({ step, status: "pending" }));
}

export function clonePlanState(plan, fallbackThreadId = "") {
  if (!plan || typeof plan !== "object") return null;
  const title = readText(plan.title || "Updated Plan") || "Updated Plan";
  const explanation = readText(plan.explanation);
  const steps = normalizePlanSteps(plan.steps);
  const deltaText = readText(plan.deltaText);
  if (!title && !explanation && !steps.length && !deltaText) return null;
  return {
    threadId: readText(plan.threadId || fallbackThreadId),
    turnId: readText(plan.turnId),
    title,
    explanation,
    steps,
    deltaText,
  };
}

export function extractPlanUpdate(item, options = {}) {
  const normalizeType = typeof options.normalizeType === "function" ? options.normalizeType : defaultNormalizeType;
  const threadId = readText(options.threadId || options.fallbackThreadId || item?.threadId || item?.thread_id);
  const itemType = normalizeType(item?.type);
  if (itemType === "plan") {
    return {
      threadId,
      turnId: readText(item?.turnId || item?.turn_id),
      title: "Updated Plan",
      explanation: "",
      steps: parsePlanStepsFromText(item?.text),
      deltaText: "",
    };
  }
  if (itemType !== "toolcall" && itemType !== "mcptoolcall") return null;
  const toolName = normalizeType(item?.tool || item?.name);
  if (toolName !== "updateplan") return null;
  const payload =
    parseJsonObject(item?.arguments) ||
    parseJsonObject(item?.input) ||
    parseJsonObject(item?.args);
  if (!payload) return null;
  const steps = normalizePlanSteps(payload.plan, normalizeType);
  const explanation = readText(payload.explanation);
  const deltaText = readText(payload.delta);
  if (!steps.length && !explanation && !deltaText) return null;
  return {
    threadId,
    turnId: readText(item?.turnId || item?.turn_id || payload.turnId || payload.turn_id),
    title: "Updated Plan",
    explanation,
    steps,
    deltaText,
  };
}

export function buildPlanSignature(plan) {
  const snapshot = clonePlanState(plan);
  if (!snapshot) return "";
  return [
    readText(snapshot.title),
    readText(snapshot.explanation),
    ...snapshot.steps.map((step) => readText(step?.step)),
    readText(snapshot.deltaText),
  ].filter(Boolean).join("\n");
}

export function renderPlanCardHtml(plan, deps = {}) {
  const escapeHtml = typeof deps.escapeHtml === "function" ? deps.escapeHtml : (value) => String(value || "");
  const normalizeType = typeof deps.normalizeType === "function" ? deps.normalizeType : defaultNormalizeType;
  const snapshot = clonePlanState(plan);
  if (!snapshot) return "";
  const title = escapeHtml(snapshot.title || "Updated Plan");
  const explanation = readText(snapshot.explanation);
  const deltaText = readText(snapshot.deltaText);
  const enterClass = deps.animateEnter === true ? String(deps.enterClass || " runtimePlanCardEnter") : "";
  const extraClass = readText(deps.cardClass);
  const renderedSteps = snapshot.steps.map((step) => {
    const status = escapeHtml(normalizeType(step?.status) || "pending");
    const text = escapeHtml(readText(step?.step));
    return (
      `<div class="runtimePlanStep status-${status}">` +
        `<span class="runtimePlanGlyph" aria-hidden="true"></span>` +
        `<span class="runtimePlanStepText">${text}</span>` +
      `</div>`
    );
  }).join("");
  return (
    `<div class="runtimePlanCard${extraClass ? ` ${escapeHtml(extraClass)}` : ""}${enterClass}">` +
      `<div class="runtimePlanHeader">${title}</div>` +
      `${explanation ? `<div class="runtimePlanExplanation">${escapeHtml(explanation)}</div>` : ""}` +
      `${renderedSteps ? `<div class="runtimePlanSteps">${renderedSteps}</div>` : ""}` +
      `${!renderedSteps && deltaText ? `<div class="runtimePlanDelta">${escapeHtml(deltaText)}</div>` : ""}` +
    `</div>`
  );
}
