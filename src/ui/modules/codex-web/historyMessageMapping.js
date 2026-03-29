import { clonePlanState, extractPlanUpdate } from "./runtimePlan.js";
import { extractProposedPlanArtifacts } from "./proposedPlan.js";
import {
  buildCommentaryArchiveMessage,
  cloneArchiveBlock,
  createSummaryArchiveBlock,
  finalizeArchiveBlocks,
  updateArchiveBlock,
} from "./historyCommentary.js";

export async function mapThreadReadMessages(thread, deps = {}) {
  const {
    nextFrame,
    performanceRef,
    parseUserMessageParts,
    isBootstrapAgentsPrompt,
    normalizeThreadItemText,
    pushHistoryMessage,
    isVisibleAssistantHistoryPhase,
    pushLiveDebugEvent = () => {},
  } = deps;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  let lastYieldMs = performanceRef.now();
  const yieldBudgetMs = 7.5;
  if (turns.length >= 40) await nextFrame();

  for (let ti = 0; ti < turns.length; ti += 1) {
    if (turns.length >= 40 && performanceRef.now() - lastYieldMs >= yieldBudgetMs) {
      lastYieldMs = performanceRef.now();
      await nextFrame();
    }
    const turn = turns[ti];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    let commentaryBlocks = [];
    let currentCommentaryBlock = null;
    let pendingPlan = null;
    let pendingTools = [];
    for (const item of items) {
      const type = String(item?.type || "").trim();
      if (type === "userMessage") {
        const parsed = parseUserMessageParts(item);
        const text = parsed.text;
        if (text && isBootstrapAgentsPrompt(text)) continue;
        if (text || parsed.images.length) {
          pushHistoryMessage(messages, { role: "user", text, kind: "", images: parsed.images });
        }
        continue;
      }
      const threadId = String(thread?.id || "").trim();
      const planUpdate = extractPlanUpdate(item, { threadId });
      if (planUpdate) {
        if (currentCommentaryBlock) {
          currentCommentaryBlock = {
            ...currentCommentaryBlock,
            plan: clonePlanState(planUpdate, threadId),
          };
        } else {
          pendingPlan = clonePlanState(planUpdate, threadId);
        }
        continue;
      }
      const text = normalizeThreadItemText(item);
      if (type === "agentMessage" || type === "assistantMessage") {
        const phase = String(item?.phase || "").trim().toLowerCase();
        if (phase && phase !== "final_answer") {
          if (currentCommentaryBlock) {
            const finalized = cloneArchiveBlock(currentCommentaryBlock);
            if (finalized) commentaryBlocks.push(finalized);
          }
          currentCommentaryBlock = updateArchiveBlock(
            {
              key: String(item.id || item.messageId || item.message_id || text.slice(0, 80)).trim(),
              text: "",
              tools: pendingTools,
              plan: pendingPlan,
            },
            item,
            text
          );
          pendingPlan = null;
          pendingTools = [];
          continue;
        }
        if (!text) continue;
        const trailingPlanOnlyBlock =
          !currentCommentaryBlock
            ? createSummaryArchiveBlock(
                pendingPlan,
                pendingTools,
                threadId,
                String(turn?.id || "").trim()
              )
            : null;
        const archiveMessage = buildCommentaryArchiveMessage(
          turn?.id,
          finalizeArchiveBlocks(commentaryBlocks, trailingPlanOnlyBlock || currentCommentaryBlock, true)
        );
        if (archiveMessage) pushHistoryMessage(messages, archiveMessage);
        commentaryBlocks = [];
        currentCommentaryBlock = null;
        pendingPlan = null;
        if (!isVisibleAssistantHistoryPhase(item?.phase)) continue;
        const proposedPlan = extractProposedPlanArtifacts(text, {
          threadId,
          turnId: String(turn?.id || "").trim(),
          itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
        });
        pushLiveDebugEvent("history.inspect:proposed_plan_detection", {
          source: "history.thread",
          threadId,
          turnId: String(turn?.id || "").trim(),
          itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
          hasPlan: !!proposedPlan.planMessage?.plan,
          hasPendingUserInput: !!proposedPlan.pendingConfirmation,
          rawPreview: String(text || "").replace(/\s+/g, " ").trim().slice(0, 220),
          cleanedPreview: String(proposedPlan.cleanedText || "").replace(/\s+/g, " ").trim().slice(0, 220),
        });
        if (proposedPlan.cleanedText) {
          pushHistoryMessage(messages, { role: "assistant", text: proposedPlan.cleanedText, kind: "" });
        }
        if (proposedPlan.planMessage?.plan) {
          pushHistoryMessage(messages, proposedPlan.planMessage);
        }
        if (!proposedPlan.cleanedText && !proposedPlan.planMessage?.plan) {
          pushHistoryMessage(messages, { role: "assistant", text, kind: "" });
        }
        continue;
      }
      const toolText = String(normalizeThreadItemText(item, { compact: true }) || "").trim();
      if (!toolText) continue;
      if (!currentCommentaryBlock) {
        pendingTools = [...pendingTools, toolText];
        continue;
      }
      currentCommentaryBlock = {
        ...currentCommentaryBlock,
        tools: [...(Array.isArray(currentCommentaryBlock.tools) ? currentCommentaryBlock.tools : []), toolText],
      };
    }
  }
  return messages;
}

export async function mapSessionHistoryMessages(items, deps = {}) {
  const {
    nextFrame,
    performanceRef,
    parseUserMessageParts,
    isBootstrapAgentsPrompt,
    normalizeSessionAssistantText,
    normalizeType,
    stripCodexImageBlocks,
    pushHistoryMessage,
    isVisibleAssistantHistoryPhase,
    pushLiveDebugEvent = () => {},
  } = deps;
  const historyItems = Array.isArray(items) ? items : [];
  const messages = [];
  let lastYieldMs = performanceRef.now();
  const yieldBudgetMs = 7.5;
  if (historyItems.length >= 40) await nextFrame();

  for (let index = 0; index < historyItems.length; index += 1) {
    if (historyItems.length >= 40 && performanceRef.now() - lastYieldMs >= yieldBudgetMs) {
      lastYieldMs = performanceRef.now();
      await nextFrame();
    }
    const item = historyItems[index];
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "").trim();
    if (type !== "message") continue;
    const role = String(item.role || "").trim();
    if (role === "user") {
      const parsed = parseUserMessageParts({ content: item.content });
      const text = parsed.text;
      if (text && isBootstrapAgentsPrompt(text)) continue;
      if (text || parsed.images.length) {
        pushHistoryMessage(messages, { role: "user", text, kind: "", images: parsed.images });
      }
      continue;
    }
    if (role === "assistant") {
      if (!isVisibleAssistantHistoryPhase(item.phase)) continue;
      const text = normalizeSessionAssistantText(item.content, {
        normalizeType,
        stripCodexImageBlocks,
      });
      const proposedPlan = extractProposedPlanArtifacts(text, {
        itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
      });
      pushLiveDebugEvent("history.inspect:proposed_plan_detection", {
        source: "history.session",
        itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
        hasPlan: !!proposedPlan.planMessage?.plan,
        hasPendingUserInput: !!proposedPlan.pendingConfirmation,
        rawPreview: String(text || "").replace(/\s+/g, " ").trim().slice(0, 220),
        cleanedPreview: String(proposedPlan.cleanedText || "").replace(/\s+/g, " ").trim().slice(0, 220),
      });
      if (proposedPlan.cleanedText) pushHistoryMessage(messages, { role: "assistant", text: proposedPlan.cleanedText, kind: "" });
      if (proposedPlan.planMessage?.plan) pushHistoryMessage(messages, proposedPlan.planMessage);
      if (text && !proposedPlan.cleanedText && !proposedPlan.planMessage?.plan) {
        pushHistoryMessage(messages, { role: "assistant", text, kind: "" });
      }
    }
  }
  return messages;
}
