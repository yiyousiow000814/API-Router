import { buildPlanSignature, parsePlanStepsFromText } from "./runtimePlan.js";

function readText(value) {
  return value == null ? "" : String(value).trim();
}

function hashText(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

function cloneConfirmation(confirmation) {
  if (!confirmation || typeof confirmation !== "object") return null;
  return {
    id: readText(confirmation.id),
    threadId: readText(confirmation.threadId),
    turnId: readText(confirmation.turnId),
    prompt: readText(confirmation.prompt),
    title: readText(confirmation.title),
    plan:
      confirmation.plan && typeof confirmation.plan === "object"
        ? {
            threadId: readText(confirmation.plan.threadId),
            turnId: readText(confirmation.plan.turnId),
            title: readText(confirmation.plan.title),
            explanation: readText(confirmation.plan.explanation),
            steps: Array.isArray(confirmation.plan.steps)
              ? confirmation.plan.steps.map((step) => ({
                  step: readText(step?.step),
                  status: readText(step?.status) || "pending",
                }))
              : [],
            kind: readText(confirmation.plan.kind),
            markdownBody: readText(confirmation.plan.markdownBody),
            deltaText: readText(confirmation.plan.deltaText),
          }
        : null,
  };
}

function stripPlanDecisionPrompt(text) {
  const source = String(text || "");
  if (!source) return "";
  const withPromptRemoved = source.replace(
    /\n*\s*Implement this plan\?\s*\n+\s*1\.\s*Yes,\s*implement this plan[\s\S]*?2\.\s*No,\s*stay in Plan mode[\s\S]*?(?:Press enter to confirm or esc to go back)?\s*$/i,
    ""
  );
  return withPromptRemoved.trim();
}

function hasPlanDecisionPrompt(text) {
  return /Implement this plan\?/i.test(String(text || ""));
}

function looksLikeStandalonePlanMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!source) return false;
  const lines = source.split("\n").map((line) => String(line || "").trim()).filter(Boolean);
  if (!lines.length) return false;
  const headingCount = lines.filter((line) => /^#{1,6}\s+\S+/.test(line)).length;
  const bulletCount = lines.filter((line) => /^[-*•]\s+\S+/.test(line) || /^\d+\.\s+\S+/.test(line)).length;
  return headingCount >= 1 && (bulletCount >= 1 || lines.length >= 3);
}

function extractMarkdownProposedPlanBlock(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  if (!source) return null;
  const match = /(^|\n)\s*(?:[-*•]\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?Proposed Plan(?:\*\*|__)?\s*(?:\n+|$)([\s\S]*)$/i.exec(source);
  if (!match) return null;
  const full = String(match[0] || "");
  const body = stripPlanDecisionPrompt(String(match[2] || "")).trim();
  if (!body) return null;
  const start = Math.max(0, Number(match.index || 0));
  const cleanedBase = `${source.slice(0, start)}\n${source.slice(start + full.length)}`;
  return {
    inner: body,
    cleanedBase,
  };
}

function parsePlanMarkdown(markdown, threadId = "", turnId = "") {
  const source = String(markdown || "").replace(/\r\n/g, "\n").trim();
  if (!source) return null;
  const lines = source.split("\n").map((line) => String(line || "").trim());
  const titleLine = lines.find((line) => /^#{1,6}\s+/.test(line));
  const title = titleLine
    ? titleLine.replace(/^#{1,6}\s+/, "").trim()
    : "Proposed Plan";
  const bodyLines = lines.filter((line) => line && line !== titleLine);
  const steps = bodyLines
    .filter((line) => /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean)
    .map((step) => ({ step, status: "pending" }));
  const explanation = bodyLines
    .filter((line) => line && !/^#{1,6}\s+/.test(line) && !/^[-*•]\s+/.test(line) && !/^\d+\.\s+/.test(line))
    .slice(0, 2)
    .join(" ")
    .trim();
  return {
    threadId: readText(threadId),
    turnId: readText(turnId),
    title: readText(title) || "Proposed Plan",
    explanation,
    steps: steps.length ? steps : parsePlanStepsFromText(""),
    kind: "proposed",
    markdownBody: source,
    deltaText: "",
  };
}

export function extractProposedPlanArtifacts(text, options = {}) {
  const source = String(text || "");
  const threadId = readText(options.threadId);
  const turnId = readText(options.turnId);
  const itemId = readText(options.itemId);
  if (!source) {
    return {
      cleanedText: "",
      plan: null,
      pendingConfirmation: null,
      planMessage: null,
    };
  }
  const fullMatch = source.match(/<\s*proposed_plan\s*>([\s\S]*?)<\s*\/\s*proposed_plan\s*>/i);
  const markdownMatch = fullMatch ? null : extractMarkdownProposedPlanBlock(source);
  const heuristicPlanBody = (() => {
    if (fullMatch || markdownMatch || !hasPlanDecisionPrompt(source)) return "";
    const body = stripPlanDecisionPrompt(source);
    return looksLikeStandalonePlanMarkdown(body) ? body : "";
  })();
  const inner = readText(fullMatch?.[1] || markdownMatch?.inner || heuristicPlanBody);
  const cleanedBase = fullMatch
    ? `${source.slice(0, fullMatch.index)}\n${source.slice((fullMatch.index || 0) + fullMatch[0].length)}`
    : (markdownMatch?.cleanedBase ?? (heuristicPlanBody
      ? ""
      : source.replace(/<\s*\/?\s*proposed_plan\s*>/gi, "")));
  const cleanedText = stripPlanDecisionPrompt(cleanedBase)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!inner) {
    return {
      cleanedText,
      plan: null,
      pendingConfirmation: null,
      planMessage: null,
    };
  }
  const seed = itemId || hashText(inner);
  const plan = parsePlanMarkdown(inner, threadId, turnId);
  if (!plan) {
    return {
      cleanedText,
      plan: null,
      pendingConfirmation: null,
      planMessage: null,
    };
  }
  const signature = buildPlanSignature(plan) || inner;
  return {
    cleanedText,
    plan,
    pendingConfirmation: {
      id: `plan_confirm:${threadId || "thread"}:${seed}`,
      threadId,
      turnId,
      prompt: "Implement this plan?",
      title: "Implement this plan?",
      plan,
    },
    planMessage: {
      role: "system",
      kind: "planCard",
      text: signature,
      plan,
    },
  };
}

export function getProposedPlanConfirmation(state, threadId = "") {
  const normalizedThreadId = readText(threadId || state?.activeThreadId);
  if (!normalizedThreadId) return null;
  const all =
    state?.proposedPlanConfirmationsByThreadId &&
    typeof state.proposedPlanConfirmationsByThreadId === "object"
      ? state.proposedPlanConfirmationsByThreadId
      : {};
  return cloneConfirmation(all[normalizedThreadId]);
}

export function setProposedPlanConfirmation(state, threadId, confirmation) {
  const normalizedThreadId = readText(threadId || confirmation?.threadId || state?.activeThreadId);
  if (!normalizedThreadId || !state || typeof state !== "object") return false;
  const nextConfirmation = cloneConfirmation(confirmation);
  if (!nextConfirmation) return false;
  state.proposedPlanConfirmationsByThreadId = {
    ...(state.proposedPlanConfirmationsByThreadId && typeof state.proposedPlanConfirmationsByThreadId === "object"
      ? state.proposedPlanConfirmationsByThreadId
      : {}),
    [normalizedThreadId]: nextConfirmation,
  };
  return true;
}

export function clearProposedPlanConfirmation(state, threadId = "") {
  const normalizedThreadId = readText(threadId || state?.activeThreadId);
  if (!normalizedThreadId || !state || typeof state !== "object") return false;
  const current =
    state.proposedPlanConfirmationsByThreadId && typeof state.proposedPlanConfirmationsByThreadId === "object"
      ? state.proposedPlanConfirmationsByThreadId
      : {};
  if (!current[normalizedThreadId]) return false;
  const next = { ...current };
  delete next[normalizedThreadId];
  state.proposedPlanConfirmationsByThreadId = next;
  return true;
}
