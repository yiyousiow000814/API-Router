import { clonePlanState, extractPlanUpdate } from "./runtimePlan.js";
import { extractProposedPlanArtifacts } from "./proposedPlan.js";
import {
  buildCommentaryArchiveMessage,
  cloneArchiveBlock,
  createSummaryArchiveBlock,
  finalizeArchiveBlocks,
  updateArchiveBlock,
} from "./historyCommentary.js";

function withCanonicalMessageIds(message, meta = {}, deps = {}) {
  if (deps.includeCanonicalIds !== true || !message || typeof message !== "object") return message;
  const threadId = String(meta.threadId || "").trim();
  const turnId = String(meta.turnId || "").trim();
  const itemId = String(meta.itemId || "").trim();
  const role = String(message.role || "").trim();
  const next = { ...message };
  if (threadId) next.threadId = threadId;
  if (turnId) next.turnId = turnId;
  if (itemId) next.itemId = itemId;
  if (role === "assistant") {
    if (!next.id) next.id = `assistant:${turnId || threadId}:${itemId || "message"}`;
    return next;
  }
  if (role === "user") {
    if (!next.id) next.id = `user:${threadId}:${turnId || "turn"}:${itemId || "message"}`;
    return next;
  }
  return next;
}

export async function mapThreadReadMessages(thread, deps = {}) {
  const {
    nextFrame,
    performanceRef,
    parseUserMessageParts,
    isBootstrapAgentsPrompt,
    normalizeThreadItemText,
    pushHistoryMessage,
    isVisibleAssistantHistoryPhase,
    includeCanonicalIds = false,
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
    const threadId = String(thread?.id || "").trim();
    const items = Array.isArray(turn?.items) ? turn.items : [];
    let commentaryBlocks = [];
    let currentCommentaryBlock = null;
    let pendingPlan = null;
    let pendingTools = [];
    let pendingFinalAssistant = null;
    const flushPendingFinalAssistant = () => {
      if (!pendingFinalAssistant) return;
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
      const finalMeta = {
        threadId,
        turnId: pendingFinalAssistant.turnId,
        itemId: pendingFinalAssistant.itemId,
      };
      const proposedPlan = pendingFinalAssistant.proposedPlan;
      if (proposedPlan.cleanedText) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            { role: "assistant", text: proposedPlan.cleanedText, kind: "" },
            finalMeta,
            { includeCanonicalIds }
          )
        );
      }
      if (proposedPlan.planMessage?.plan) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            proposedPlan.planMessage,
            finalMeta,
            { includeCanonicalIds }
          )
        );
      }
      if (!proposedPlan.cleanedText && !proposedPlan.planMessage?.plan) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            { role: "assistant", text: pendingFinalAssistant.text, kind: "" },
            finalMeta,
            { includeCanonicalIds }
          )
        );
      }
      commentaryBlocks = [];
      currentCommentaryBlock = null;
      pendingPlan = null;
      pendingTools = [];
      pendingFinalAssistant = null;
    };
    for (const item of items) {
      const type = String(item?.type || "").trim();
      if (type === "userMessage") {
        flushPendingFinalAssistant();
        const parsed = parseUserMessageParts(item);
        const text = parsed.text;
        if (text && isBootstrapAgentsPrompt(text)) continue;
        if (text || parsed.images.length) {
          pushHistoryMessage(
            messages,
            withCanonicalMessageIds(
              { role: "user", text, kind: "", images: parsed.images },
              {
                threadId,
                turnId: String(turn?.id || "").trim(),
                itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
              },
              { includeCanonicalIds }
            )
          );
        }
        continue;
      }
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
        if (!isVisibleAssistantHistoryPhase(item?.phase)) continue;
        const turnId = String(turn?.id || "").trim();
        const itemId = String(item?.id || item?.messageId || item?.message_id || "").trim();
        const proposedPlan = extractProposedPlanArtifacts(text, {
          threadId,
          turnId,
          itemId,
        });
        pushLiveDebugEvent("history.inspect:proposed_plan_detection", {
          source: "history.thread",
          threadId,
          turnId,
          itemId,
          hasPlan: !!proposedPlan.planMessage?.plan,
          hasPendingUserInput: !!proposedPlan.pendingConfirmation,
          rawPreview: String(text || "").replace(/\s+/g, " ").trim().slice(0, 220),
          cleanedPreview: String(proposedPlan.cleanedText || "").replace(/\s+/g, " ").trim().slice(0, 220),
        });
        pendingFinalAssistant = {
          text,
          proposedPlan,
          turnId,
          itemId,
        };
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
    flushPendingFinalAssistant();
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
    includeCanonicalIds = false,
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
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            { role: "user", text, kind: "", images: parsed.images },
            {
              threadId: String(item?.threadId || item?.thread_id || "").trim(),
              turnId: String(item?.turnId || item?.turn_id || "").trim(),
              itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
            },
            { includeCanonicalIds }
          )
        );
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
      if (proposedPlan.cleanedText) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            { role: "assistant", text: proposedPlan.cleanedText, kind: "" },
            {
              threadId: String(item?.threadId || item?.thread_id || "").trim(),
              turnId: String(item?.turnId || item?.turn_id || "").trim(),
              itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
            },
            { includeCanonicalIds }
          )
        );
      }
      if (proposedPlan.planMessage?.plan) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            proposedPlan.planMessage,
            {
              threadId: String(item?.threadId || item?.thread_id || "").trim(),
              turnId: String(item?.turnId || item?.turn_id || "").trim(),
              itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
            },
            { includeCanonicalIds }
          )
        );
      }
      if (text && !proposedPlan.cleanedText && !proposedPlan.planMessage?.plan) {
        pushHistoryMessage(
          messages,
          withCanonicalMessageIds(
            { role: "assistant", text, kind: "" },
            {
              threadId: String(item?.threadId || item?.thread_id || "").trim(),
              turnId: String(item?.turnId || item?.turn_id || "").trim(),
              itemId: String(item?.id || item?.messageId || item?.message_id || "").trim(),
            },
            { includeCanonicalIds }
          )
        );
      }
    }
  }
  return messages;
}
