import { buildPlanSignature, clonePlanState, extractPlanUpdate } from "./runtimePlan.js";

export function cloneArchiveBlock(block) {
  if (!block || typeof block !== "object") return null;
  const text = String(block.text || "").trim();
  const tools = Array.isArray(block.tools) ? block.tools.map((tool) => String(tool || "").trim()).filter(Boolean) : [];
  const plan = clonePlanState(block.plan, String(block.threadId || "").trim());
  const summaryOnly = block.summaryOnly === true;
  if (!text && !tools.length && !plan && !summaryOnly) return null;
  const cloned = {
    key: String(block.key || "").trim(),
    text,
    tools,
    plan,
  };
  if (summaryOnly) cloned.summaryOnly = true;
  return cloned;
}

export function createSummaryArchiveBlock(plan, tools, threadId, turnId = "", options = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  const snapshot = clonePlanState(plan, normalizedThreadId);
  const normalizedTools = Array.isArray(tools)
    ? tools.map((tool) => String(tool || "").trim()).filter(Boolean)
    : [];
  const allowEmpty = options.allowEmpty === true;
  if (!snapshot && !normalizedTools.length && !allowEmpty) return null;
  const seed = String(snapshot?.turnId || turnId || normalizedThreadId || "summary").trim() || "summary";
  const block = {
    key: `commentary-summary:${seed}`,
    text: "",
    tools: normalizedTools,
    plan: snapshot,
  };
  if (!snapshot && !normalizedTools.length) block.summaryOnly = true;
  return block;
}

export function finalizeArchiveBlocks(currentBlocks, currentBlock, hasFinalAssistant) {
  const blocks = Array.isArray(currentBlocks) ? currentBlocks.slice() : [];
  const clonedCurrent = cloneArchiveBlock(currentBlock);
  if (clonedCurrent) blocks.push(clonedCurrent);
  if (!hasFinalAssistant || !blocks.length) return [];
  return blocks;
}

export function buildCommentaryArchiveSignature(blocks) {
  const archive = Array.isArray(blocks) ? blocks : [];
  return archive
    .map((block) => [
      buildPlanSignature(block?.plan),
      String(block?.key || "").trim(),
      String(block?.text || "").trim(),
      ...(Array.isArray(block?.tools) ? block.tools.map((tool) => String(tool || "").trim()) : []),
    ].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

export function buildCommentaryArchiveMessage(turnId, blocks) {
  const archive = Array.isArray(blocks) ? blocks.map((block) => cloneArchiveBlock(block)).filter(Boolean) : [];
  if (!archive.length) return null;
  return {
    role: "system",
    kind: "commentaryArchive",
    text: buildCommentaryArchiveSignature(archive),
    archiveKey: String(turnId || "").trim() || `commentary-archive-${archive.length}`,
    archiveBlocks: archive,
  };
}

export function updateArchiveBlock(block, item, nextText) {
  const toolText = String(nextText || "").trim();
  if (!toolText && !String(block?.text || "").trim() && !clonePlanState(block?.plan)) return block;
  const nextBlock = block && typeof block === "object"
    ? {
        key: String(block.key || "").trim(),
        text: String(block.text || "").trim(),
        tools: Array.isArray(block.tools) ? block.tools.slice() : [],
        plan: clonePlanState(block.plan),
      }
    : {
        key: String(item?.id || item?.messageId || item?.message_id || "").trim(),
        text: "",
        tools: [],
        plan: null,
      };
  if (toolText) nextBlock.text = toolText;
  return nextBlock;
}

export function extractLatestCommentaryState(thread, helpers = {}) {
  const normalizeThreadItemText =
    typeof helpers.normalizeThreadItemText === "function"
      ? helpers.normalizeThreadItemText
      : () => "";
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  let latestState = {
    current: null,
    archive: [],
    visible: false,
  };

  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    let blocks = [];
    let currentBlock = null;
    let hasFinalAssistant = false;
    let pendingPlan = null;
    let pendingTools = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const type = String(item.type || "").trim();
      if (!type || type === "userMessage") continue;
      const planUpdate = extractPlanUpdate(item, { threadId: String(thread?.id || "").trim() });
      if (planUpdate) {
        if (currentBlock) currentBlock = { ...currentBlock, plan: clonePlanState(planUpdate, String(thread?.id || "").trim()) };
        else pendingPlan = clonePlanState(planUpdate, String(thread?.id || "").trim());
        continue;
      }
      if (type === "agentMessage" || type === "assistantMessage") {
        const phase = String(item.phase || "").trim().toLowerCase();
        const text = String(normalizeThreadItemText(item) || "").trim();
        if (!text) continue;
        if (!phase || phase === "final_answer") {
          hasFinalAssistant = true;
          continue;
        }
        if (currentBlock) {
          const finalized = cloneArchiveBlock(currentBlock);
          if (finalized) blocks.push(finalized);
        }
        currentBlock = updateArchiveBlock(
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
      const toolText = String(normalizeThreadItemText(item, { compact: true }) || "").trim();
      if (!toolText) continue;
      if (!currentBlock) {
        pendingTools = [...pendingTools, toolText];
        continue;
      }
      currentBlock = {
        ...currentBlock,
        tools: [...(Array.isArray(currentBlock.tools) ? currentBlock.tools : []), toolText],
      };
    }

    const trailingPlanOnlyBlock =
      !currentBlock && hasFinalAssistant
        ? createSummaryArchiveBlock(
            pendingPlan,
            pendingTools,
            String(thread?.id || "").trim(),
            String(turn?.id || "").trim()
          )
        : null;
    const archive = finalizeArchiveBlocks(blocks, trailingPlanOnlyBlock || currentBlock, hasFinalAssistant);
    latestState = {
      current: hasFinalAssistant ? null : cloneArchiveBlock(currentBlock),
      archive,
      visible: hasFinalAssistant && archive.length > 0,
    };
  }

  return latestState;
}

export function extractLatestCommentaryArchive(thread, helpers = {}) {
  return extractLatestCommentaryState(thread, helpers).archive;
}
