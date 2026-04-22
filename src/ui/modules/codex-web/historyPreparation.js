import { extractLatestCommentaryState } from "./historyCommentary.js";
import { buildHistoryRenderSig, mergeHistoryTurns, mergePendingLiveMessages } from "./historyLoader.js";
import {
  omitLatestIncompleteTurnArtifacts,
  shouldOmitLatestIncompleteTurnArtifacts,
} from "./historyLiveCommentaryState.js";

export async function prepareThreadHistoryView(thread, options = {}, deps = {}) {
  const {
    state = {},
    mapSessionHistoryMessages,
    mapThreadReadMessages,
    normalizeThreadItemText,
    captureLiveCommentarySnapshot,
    normalizeThreadTokenUsage,
    detectThreadWorkspaceTarget,
  } = deps;

  const threadId = String(thread?.id || state.activeThreadId || "").trim();
  const historyItems = Array.isArray(thread?.historyItems) ? thread.historyItems : [];
  const omitIncompleteTurnArtifacts = shouldOmitLatestIncompleteTurnArtifacts(thread, state);
  const normalizedTurns = mergeHistoryTurns([], Array.isArray(thread?.turns) ? thread.turns : []);
  const normalizedThread = normalizedTurns === thread?.turns
    ? thread
    : { ...thread, turns: normalizedTurns };
  const mappedMessages = historyItems.length
    ? await mapSessionHistoryMessages(historyItems)
    : await mapThreadReadMessages(normalizedThread, { omitIncompleteTurnArtifacts });
  const rawMessages = omitLatestIncompleteTurnArtifacts(mappedMessages, omitIncompleteTurnArtifacts);
  const historyCommentary = extractLatestCommentaryState(thread, { normalizeThreadItemText });
  const turns = normalizedTurns;
  const authoritativeUserCount = rawMessages.filter(
    (message) => String(message?.role || "").trim() === "user"
  ).length;
  const messages = mergePendingLiveMessages(rawMessages, state, threadId, {
    historyIncomplete: thread?.page?.incomplete === true,
    historyTurnCount: turns.length,
  });
  const inlineCommentaryArchiveCount = messages.filter((message) => message?.kind === "commentaryArchive").length;
  const liveCommentarySnapshot = captureLiveCommentarySnapshot(threadId);
  const toolCount = messages.filter((message) => message?.role === "system" && message?.kind === "tool").length;
  const renderSig = buildHistoryRenderSig(threadId, turns, messages);
  const started = messages.length > 0 || turns.length > 0 || historyItems.length > 0;
  const historyStatusType = String(thread?.status?.type || "").trim().toLowerCase();
  const detectedTarget = detectThreadWorkspaceTarget(thread);
  const target = detectedTarget !== "unknown"
    ? detectedTarget
    : ((options.workspace === "windows" || options.workspace === "wsl2") ? options.workspace : "unknown");
  const resolvedRolloutPath = String(thread?.path || options.rolloutPath || "").trim();

  return {
    threadId,
    historyItems,
    turns,
    rawMessages,
    authoritativeUserCount,
    messages,
    historyCommentary,
    inlineCommentaryArchiveCount,
    liveCommentarySnapshot,
    toolCount,
    renderSig,
    started,
    historyStatusType,
    target,
    resolvedRolloutPath,
    tokenUsage: normalizeThreadTokenUsage(thread?.tokenUsage),
  };
}
