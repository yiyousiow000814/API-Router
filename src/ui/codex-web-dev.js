import {
  registerPendingThreadResume as registerPendingThreadResumeInStore,
  waitPendingThreadResume as waitPendingThreadResumeInStore,
} from "./modules/codex-web/pendingThreadResume.js";
import {
  escapeHtml,
  findNextInlineCodeSpan,
  renderInlineMessageText,
  renderMessageAttachments,
  renderMessageBody,
} from "./modules/codex-web/messageRender.js";
import {
  buildThreadRenderSig,
  detectThreadWorkspaceTarget,
  detectWorkspaceAvailabilityFromThreads,
  filterThreadsForWorkspace,
  normalizeWorkspaceTarget as normalizeWorkspaceTargetInModule,
  pickThreadTimestamp,
  sortThreadsByNewest,
} from "./modules/codex-web/threadMeta.js";
import {
  normalizeThreadTokenUsage,
  renderComposerContextLeft as renderComposerContextLeftInNode,
} from "./modules/codex-web/contextLeft.js";
import {
  clearPromptInput,
  readPromptValue,
  resolveMobilePromptLayout,
} from "./modules/codex-web/promptState.js";
import { normalizeModelOption } from "./modules/codex-web/modelPicker.js";
import {
  isBootstrapAgentsPrompt,
  normalizeInline,
  normalizeMultiline,
  normalizeTextPayload,
  toolItemToMessage,
  normalizeThreadItemText,
  normalizeType,
  parseUserMessageParts,
  stripCodexImageBlocks,
  toStructuredPreview,
} from "./modules/codex-web/messageData.js";
import { resetPendingTurnRuntime, resetTurnPresentationState } from "./modules/codex-web/runtimeState.js";
import { normalizeStartCwd } from "./modules/codex-web/workspaceUi.js";
import {
  createWsClientModule,
  ensureArrayItems,
  nextFrame,
  nextReqId,
} from "./modules/codex-web/wsClient.js";
import { resolveCodexWebTransportMode } from "./modules/codex-web/transportMode.js";
import { createWorkspaceUiModule } from "./modules/codex-web/workspaceUi.js";
import { createChatViewportModule } from "./modules/codex-web/chatViewport.js";
import { createImageViewerModule } from "./modules/codex-web/imageViewer.js";
import { createChatTimelineModule } from "./modules/codex-web/chatTimeline.js";
import { createHistoryLoaderModule } from "./modules/codex-web/historyLoader.js";
import { createModelPickerModule } from "./modules/codex-web/modelPicker.js";
import { createThreadListRefreshModule } from "./modules/codex-web/threadListRefresh.js";
import { createThreadListViewModule } from "./modules/codex-web/threadListView.js";
import { createFolderPickerModule } from "./modules/codex-web/folderPicker.js";
import { createConnectionFlowsModule } from "./modules/codex-web/connectionFlows.js";
import { createTurnActionsModule } from "./modules/codex-web/turnActions.js";
import { createActionBindingsModule } from "./modules/codex-web/actionBindings.js";
import { createDebugToolsModule } from "./modules/codex-web/debugTools.js";
import { createThreadLiveModule } from "./modules/codex-web/threadLive.js";
import { createBootstrapModule } from "./modules/codex-web/bootstrapApp.js";
import { createCodexWebComposition } from "./modules/codex-web/composition.js";
import { createCodexWebDiagnostics } from "./modules/codex-web/webDiagnostics.js";
import { installMobileViewportSync } from "./modules/codex-web/mobileViewport.js";
import {
  ACTIVE_MAIN_TAB_KEY,
  ACTIVE_THREAD_LIVE_POLL_MS,
  ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS,
  ACTIVE_THREAD_REFRESH_DEBOUNCE_MS,
  CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS,
  CHAT_LIVE_FOLLOW_MAX_STEP_PX,
  CHAT_STICKY_BOTTOM_PX,
  CODEX_VERSION_CACHE_KEY,
  EFFORT_USER_SELECTED_KEY,
  FAVORITE_THREADS_KEY,
  FAST_MODE_DEVICE_DEFAULT_KEY,
  GUIDE_DISMISSED_KEY,
  HISTORY_WINDOW_THRESHOLD,
  LAST_EVENT_ID_KEY,
  LIVE_INSPECTOR_ENABLED_KEY,
  MODEL_LOADING_MIN_MS,
  MODELS_CACHE_KEY,
  MODEL_USER_SELECTED_KEY,
  REASONING_EFFORT_KEY,
  PERMISSION_PRESET_STORAGE_KEY,
  RECENT_EVENT_ID_CACHE_SIZE,
  SANDBOX_MODE,
  SELECTED_MODEL_KEY,
  START_CWD_BY_WORKSPACE_KEY,
  state,
  THREADS_CACHE_KEY,
  THREAD_AUTO_REFRESH_CONNECTED_MS,
  THREAD_AUTO_REFRESH_DISCONNECTED_MS,
  THREAD_FORCE_REFRESH_MIN_INTERVAL_MS,
  THREAD_PULL_HINT_CLEAR_DELAY_MS,
  THREAD_PULL_REFRESH_MAX_PX,
  THREAD_PULL_REFRESH_MIN_MS,
  THREAD_PULL_REFRESH_TRIGGER_PX,
  THREAD_REFRESH_DEBOUNCE_MS,
  threadAnimDebug,
  TOKEN_STORAGE_KEY,
  WEB_CODEX_DEV_DEBUG_VERSION,
  WORKSPACE_TARGET_KEY,
} from "./modules/codex-web/appState.js";
import { createUiHelpersModule } from "./modules/codex-web/uiHelpers.js";
import { createHeaderUiModule } from "./modules/codex-web/headerUi.js";
import { createComposerUiModule } from "./modules/codex-web/composerUi.js";
import { createAppPersistenceModule } from "./modules/codex-web/appPersistence.js";
import { createLiveNotificationsModule } from "./modules/codex-web/liveNotifications.js";
import { createMobileShellModule } from "./modules/codex-web/mobileShell.js";
import { createSlashCommandsModule } from "./modules/codex-web/slashCommands.js";
import {
  extractNotificationEventId,
  extractNotificationThreadId,
  shouldRefreshActiveThreadFromNotification,
  shouldRefreshThreadsFromNotification,
} from "./modules/codex-web/notificationRouting.js";

try {
  window.__webCodexScriptLoaded = true;
} catch {}

let setStatus = () => {};
let updateHeaderUi = () => {};
let updateNotificationState = () => {};
let maybeNotifyTurnDone = () => {};
let blockInSandbox = () => false;
let escapeAttr = (value) => String(value || "");
let compactModelLabel = (value) => String(value || "");
let pickLatestModelId = () => "";
let inModelMenu = () => false;
let getPromptValue = () => "";
let clearPromptValue = () => {};
let hideWelcomeCard = () => {};
let showWelcomeCard = () => {};
let renderComposerContextLeft = () => {};
let renderRuntimePanels = () => {};
let clearRuntimeState = () => {};
let setRuntimeActivity = () => {};
let setActiveCommands = () => {};
let setActivePlan = () => {};
let setThreadStatusCard = () => {};
let clearThreadStatusCard = () => {};
let syncRuntimeStateFromHistory = () => {};
let applyToolItemRuntimeUpdate = () => {};
let applyPlanDeltaUpdate = () => {};
let applyPlanSnapshotUpdate = () => {};
let finalizeRuntimeState = () => {};
let updateMobileComposerState = () => {};
let setComposerActionMenuOpen = () => {};
let setMainTab = () => {};
let syncSettingsControlsFromMain = () => {};
let updateWelcomeSelections = () => {};
let persistModelsCache = () => {};
let restoreModelsCache = () => false;
let restoreCodexVersionCache = () => false;
let persistThreadsCache = () => {};
let restoreThreadsCache = () => false;
let refreshCodexVersions = async () => {};
let applyManagedTokenUi = () => {};
let truncateLabel = (value) => String(value || "");
let relativeTimeLabel = () => "";
let renderAttachmentPills = () => {};
let clearTransientToolMessages = () => {};
let renderCommentaryArchive = () => {};
let renderAssistantLiveBody = () => {};
let toToolLikeMessage = () => null;
let notificationToToolItem = () => null;
let renderLiveNotification = () => {};
let clearLiveThreadConnectionStatus = () => {};
let clearTransientThinkingMessages = () => {};
let showTransientThinkingMessage = () => {};
let showTransientToolMessage = () => {};
let workspaceKeyOfThread = () => "Default folder";
let setMobileTab = () => {};
let hideSlashCommandMenu = () => {};
let handleSlashCommandKeyDown = () => false;
let syncSlashCommandMenu = () => {};
let executeSlashCommand = async () => null;
let refreshSlashCommandsState = async () => [];
let slashStateRefreshTimer = 0;
let getWorkspaceTarget = () => normalizeWorkspaceTarget(state.workspaceTarget || "windows");
let getStartCwdForWorkspace = () => "";
let syncActiveThreadMetaFromList = () => {};
let refreshThreads = async () => {};
let loadThreadMessages = async () => {};
let renderThreads = () => {};

const {
  armSyntheticClickSuppression,
  bindClick,
  bindInput,
  bindResponsiveClick,
  byId,
  dbgSet,
  getEmbeddedToken,
  isThreadAnimDebugEnabled,
  pushThreadAnimDebug,
  shouldSuppressSyntheticClick,
  swapText,
  waitMs,
  wireBlurBackdropShield,
} = createUiHelpersModule({
  state,
  threadAnimDebug,
  normalizeWorkspaceTarget: normalizeWorkspaceTargetInModule,
  setStatus: (...args) => setStatus(...args),
});

function wireMessageLinks(container) {
  if (!container) return;
}

async function waitPendingThreadResume(threadId) {
  await waitPendingThreadResumeInStore(state.pendingThreadResumes, threadId);
}

function toRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function readString(value) {
  return typeof value === "string" ? value : null;
}

function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resetEventReplayState() {
  state.wsLastEventId = 0;
  state.wsRecentEventIds = new Set();
  state.wsRecentEventIdQueue = [];
  try {
    localStorage.removeItem(LAST_EVENT_ID_KEY);
  } catch {}
}

function markEventIdSeen(eventId) {
  if (!Number.isInteger(eventId) || eventId < 1) return;
  state.wsRecentEventIds.add(eventId);
  state.wsRecentEventIdQueue.push(eventId);
  while (state.wsRecentEventIdQueue.length > RECENT_EVENT_ID_CACHE_SIZE) {
    const removed = state.wsRecentEventIdQueue.shift();
    if (Number.isInteger(removed)) state.wsRecentEventIds.delete(removed);
  }
}

function scheduleThreadRefresh(delayMs = THREAD_REFRESH_DEBOUNCE_MS) {
  if (state.scheduledRefreshTimer) clearTimeout(state.scheduledRefreshTimer);
  state.scheduledRefreshTimer = setTimeout(() => {
    state.scheduledRefreshTimer = null;
    refreshThreads(getWorkspaceTarget(), { force: false, silent: true }).catch(() => {});
  }, delayMs);
}

function scheduleActiveThreadRefresh(threadId, delayMs = ACTIVE_THREAD_REFRESH_DEBOUNCE_MS) {
  if (!threadId || threadId !== state.activeThreadId) return;
  if (state.activeThreadRefreshTimer) clearTimeout(state.activeThreadRefreshTimer);
  state.activeThreadRefreshTimer = setTimeout(() => {
    state.activeThreadRefreshTimer = null;
    if (!threadId || threadId !== state.activeThreadId) return;
    loadThreadMessages(threadId, {
      animateBadge: false,
      workspace: state.activeThreadWorkspace,
      rolloutPath: state.activeThreadRolloutPath,
    }).catch(() => {});
  }, delayMs);
}

function normalizeWorkspaceTarget(value) {
  return normalizeWorkspaceTargetInModule(value);
}

async function recordWebTransportEventToGateway(eventType, detail) {
  const normalizedEventType = String(eventType || "").trim();
  if (!normalizedEventType) return;
  const headers = {
    "Content-Type": "application/json",
  };
  const token = String(state.token || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = {
    eventType: normalizedEventType,
    detail: detail == null ? null : String(detail),
  };
  try {
    await fetch("/codex/transport/events", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch {}
}

const webDiagnostics = createCodexWebDiagnostics({
  state,
  windowRef: window,
  documentRef: document,
  fetchRef: fetch,
});
webDiagnostics.install();

function setActiveThread(id) {
  const prev = state.activeThreadId || "";
  state.activeThreadId = id || "";
  try {
    if (state.activeThreadAttachPendingTimer) clearTimeout(state.activeThreadAttachPendingTimer);
  } catch {}
  state.activeThreadAttachPendingTimer = 0;
  if (prev !== state.activeThreadId) {
    clearPromptValue();
    hideSlashCommandMenu();
    state.activeThreadRenderSig = "";
    clearLiveThreadConnectionStatus();
    clearRuntimeState();
    state.activeThreadQueuedTurns = [];
    state.queuedTurnsExpanded = true;
    state.queuedTurnEditingId = "";
    state.queuedTurnEditingDraft = "";
    state.queuedTurnDeferredComposerRestoreId = "";
    resetPendingTurnRuntime(state, { reason: "thread.active.switch" });
    resetTurnPresentationState(state);
  }
  if (!state.activeThreadId) {
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = getWorkspaceTarget();
    state.activeThreadAttachTransport = "";
    state.activeThreadAttachPendingUntil = 0;
  } else {
    state.activeThreadAttachPendingUntil = Date.now() + 2000;
    syncActiveThreadMetaFromList(state.activeThreadId);
    state.activeThreadAttachTransport = String(
      state.threadAttachTransportById?.get?.(state.activeThreadId) || ""
    ).trim();
    state.activeThreadAttachPendingTimer = setTimeout(() => {
      state.activeThreadAttachPendingTimer = 0;
      if (!state.activeThreadId) return;
      updateHeaderUi();
    }, 2050);
  }
  const activeThreadLabel = byId("activeThreadId");
  if (activeThreadLabel) activeThreadLabel.textContent = state.activeThreadId || "(none)";
  updateHeaderUi();
  if (slashStateRefreshTimer) clearTimeout(slashStateRefreshTimer);
  slashStateRefreshTimer = setTimeout(() => {
    slashStateRefreshTimer = 0;
    refreshSlashCommandsState({ force: true, silent: true })
      .then(() => {
        renderComposerContextLeft();
        syncSettingsControlsFromMain();
        updateHeaderUi();
      })
      .catch(() => {});
  }, 0);
}

const composition = createCodexWebComposition({
  transportMode: resolveCodexWebTransportMode({
    importMetaEnv: import.meta.env,
    windowRef: window,
  }),
  state,
  byId,
  setStatus: (...args) => setStatus(...args),
  toRecord,
  readString,
  readNumber,
  resetEventReplayState,
  markEventIdSeen,
  extractNotificationEventId,
  extractNotificationThreadId,
  shouldRefreshThreadsFromNotification,
  shouldRefreshActiveThreadFromNotification,
  scheduleThreadRefresh,
  scheduleActiveThreadRefresh,
  renderLiveNotification: (...args) => renderLiveNotification(...args),
  normalizeWorkspaceTargetInModule,
  updateHeaderUi: (...args) => updateHeaderUi(...args),
  dbgSet,
  waitMs,
  nextFrame,
  nextReqId,
  normalizeThreadTokenUsage,
  renderComposerContextLeft: (...args) => renderComposerContextLeft(...args),
  renderRuntimePanels: (...args) => renderRuntimePanels(...args),
  clearRuntimeState: (...args) => clearRuntimeState(...args),
  setRuntimeActivity: (...args) => setRuntimeActivity(...args),
  setActiveCommands: (...args) => setActiveCommands(...args),
  setActivePlan: (...args) => setActivePlan(...args),
  setThreadStatusCard: (...args) => setThreadStatusCard(...args),
  clearThreadStatusCard: (...args) => clearThreadStatusCard(...args),
  syncRuntimeStateFromHistory: (...args) => syncRuntimeStateFromHistory(...args),
  applyToolItemRuntimeUpdate: (...args) => applyToolItemRuntimeUpdate(...args),
  applyPlanDeltaUpdate: (...args) => applyPlanDeltaUpdate(...args),
  applyPlanSnapshotUpdate: (...args) => applyPlanSnapshotUpdate(...args),
  upsertSyntheticPendingUserInput: (...args) => upsertSyntheticPendingUserInput(...args),
  finalizeRuntimeState: (...args) => finalizeRuntimeState(...args),
  parseUserMessageParts,
  isBootstrapAgentsPrompt,
  normalizeThreadItemText,
  normalizeType,
  stripCodexImageBlocks,
  hideWelcomeCard: (...args) => hideWelcomeCard(...args),
  showWelcomeCard: (...args) => showWelcomeCard(...args),
  renderMessageBody,
  renderMessageAttachments,
  ensureArrayItems,
  escapeHtml,
  escapeAttr: (...args) => escapeAttr(...args),
  compactModelLabel: (...args) => compactModelLabel(...args),
  persistModelsCache: (...args) => persistModelsCache(...args),
  pickLatestModelId: (...args) => pickLatestModelId(...args),
  normalizeWorkspaceTarget,
  sortThreadsByNewest,
  filterThreadsForWorkspace,
  detectWorkspaceAvailabilityFromThreads,
  buildThreadRenderSig,
  detectThreadWorkspaceTarget,
  persistThreadsCache: (...args) => persistThreadsCache(...args),
  pushThreadAnimDebug,
  workspaceKeyOfThread: (...args) => workspaceKeyOfThread(...args),
  truncateLabel: (...args) => truncateLabel(...args),
  relativeTimeLabel: (...args) => relativeTimeLabel(...args),
  pickThreadTimestamp,
  setMainTab: (...args) => setMainTab(...args),
  setMobileTab: (...args) => setMobileTab(...args),
  setActiveThread,
  renderAttachmentPills: (...args) => renderAttachmentPills(...args),
  clearTransientToolMessages: (...args) => clearTransientToolMessages(...args),
  blockInSandbox: (...args) => blockInSandbox(...args),
  getEmbeddedToken,
  refreshCodexVersions: (...args) => refreshCodexVersions(...args),
  getPromptValue: (...args) => getPromptValue(...args),
  waitPendingThreadResume,
  registerPendingThreadResume: registerPendingThreadResumeInStore,
  clearPromptValue: (...args) => clearPromptValue(...args),
  normalizeTextPayload,
  maybeNotifyTurnDone: (...args) => maybeNotifyTurnDone(...args),
  updateNotificationState: (...args) => updateNotificationState(...args),
  armSyntheticClickSuppression,
  shouldSuppressSyntheticClick,
  wireBlurBackdropShield,
  bindClick,
  bindResponsiveClick,
  bindInput,
  wireMessageLinks,
  renderInlineMessageText,
  findNextInlineCodeSpan,
  showTransientThinkingMessage: (...args) => showTransientThinkingMessage(...args),
  clearTransientThinkingMessages: (...args) => clearTransientThinkingMessages(...args),
  showTransientToolMessage: (...args) => showTransientToolMessage(...args),
  clearLiveThreadConnectionStatus: (...args) => clearLiveThreadConnectionStatus(...args),
  hideSlashCommandMenu: (...args) => hideSlashCommandMenu(...args),
  handleSlashCommandKeyDown: (...args) => handleSlashCommandKeyDown(...args),
  syncSlashCommandMenu: (...args) => syncSlashCommandMenu(...args),
  normalizeModelOption,
  isThreadAnimDebugEnabled,
  threadAnimDebug,
  WEB_CODEX_DEV_DEBUG_VERSION,
  normalizeStartCwd,
  restoreCodexVersionCache: (...args) => restoreCodexVersionCache(...args),
  restoreModelsCache: (...args) => restoreModelsCache(...args),
  restoreThreadsCache: (...args) => restoreThreadsCache(...args),
  applyManagedTokenUi: (...args) => applyManagedTokenUi(...args),
  updateMobileComposerState: (...args) => updateMobileComposerState(...args),
  refreshActiveThreadGitMeta: (...args) => refreshActiveThreadGitMeta(...args),
  setComposerActionMenuOpen: (...args) => setComposerActionMenuOpen(...args),
  refreshSlashCommandsState: (...args) => refreshSlashCommandsState(...args),
  syncSettingsControlsFromMain: (...args) => syncSettingsControlsFromMain(...args),
  updateWelcomeSelections: (...args) => updateWelcomeSelections(...args),
  GUIDE_DISMISSED_KEY,
  TOKEN_STORAGE_KEY,
  WORKSPACE_TARGET_KEY,
  START_CWD_BY_WORKSPACE_KEY,
  FAVORITE_THREADS_KEY,
  SELECTED_MODEL_KEY,
  ACTIVE_MAIN_TAB_KEY,
  FAST_MODE_DEVICE_DEFAULT_KEY,
  PERMISSION_PRESET_STORAGE_KEY,
  SANDBOX_MODE,
  CHAT_STICKY_BOTTOM_PX,
  HISTORY_WINDOW_THRESHOLD,
  CHAT_LIVE_FOLLOW_MAX_STEP_PX,
  CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS,
  REASONING_EFFORT_KEY,
  MODEL_USER_SELECTED_KEY,
  EFFORT_USER_SELECTED_KEY,
  MODEL_LOADING_MIN_MS,
  THREAD_FORCE_REFRESH_MIN_INTERVAL_MS,
  THREAD_PULL_REFRESH_TRIGGER_PX,
  THREAD_PULL_REFRESH_MAX_PX,
  THREAD_PULL_REFRESH_MIN_MS,
  THREAD_PULL_HINT_CLEAR_DELAY_MS,
  THREAD_AUTO_REFRESH_CONNECTED_MS,
  THREAD_AUTO_REFRESH_DISCONNECTED_MS,
  ACTIVE_THREAD_LIVE_POLL_MS,
  ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS,
  LAST_EVENT_ID_KEY,
  LIVE_INSPECTOR_ENABLED_KEY,
  createWsClientModule,
  createWorkspaceUiModule,
  createChatViewportModule,
  createImageViewerModule,
  createChatTimelineModule,
  createHistoryLoaderModule,
  createModelPickerModule,
  createThreadListRefreshModule,
  createThreadListViewModule,
  createFolderPickerModule,
  createConnectionFlowsModule,
  createTurnActionsModule,
  createActionBindingsModule,
  createDebugToolsModule,
  createThreadLiveModule,
  createBootstrapModule,
  recordWebTransportEvent: (...args) => recordWebTransportEventToGateway(...args),
  recordApiResult: (...args) => webDiagnostics.recordApiResult(...args),
  recordLocalTask: (...args) => webDiagnostics.recordLocalTask(...args),
  installMobileViewportSync: () => installMobileViewportSync({
    windowRef: window,
    documentRef: document,
    updateMobileComposerState: (...args) => updateMobileComposerState(...args),
  }),
  localStorageRef: localStorage,
  documentRef: document,
  requestAnimationFrameRef: requestAnimationFrame,
  MutationObserverRef: MutationObserver,
});

const {
  api,
  addChat,
  appendStreamingDelta,
  bootstrap,
  clearPendingUserInputs,
  createAssistantStreamingMessage,
  suppressSyntheticPendingUserInputs: suppressSyntheticPendingUserInputsFromComposition,
  setSyntheticPendingUserInputs,
  upsertSyntheticPendingUserInput,
  executeSlashCommand: executeSlashCommandFromComposition,
  finalizeAssistantMessage,
  flushQueuedTurn,
  renderCommentaryArchive: renderCommentaryArchiveFromComposition,
  renderAssistantLiveBody: renderAssistantLiveBodyFromComposition,
  renderPendingInline: renderPendingInlineFromComposition,
  removeChatMessageByKey,
  getActiveWorkspaceBadgeLabel,
  getStartCwdForWorkspace: getStartCwdForWorkspaceFromComposition,
  getWorkspaceTarget: getWorkspaceTargetFromComposition,
  isThreadListActuallyVisible,
  loadThreadMessages: loadThreadMessagesFromComposition,
  refreshThreads: refreshThreadsFromComposition,
  renderThreads: renderThreadsFromComposition,
  scheduleChatLiveFollow,
  setHeaderModelMenuOpen,
  syncActiveThreadMetaFromList: syncActiveThreadMetaFromListFromComposition,
  updateWorkspaceAvailability,
} = composition;

getWorkspaceTarget = (...args) => getWorkspaceTargetFromComposition(...args);
getStartCwdForWorkspace = (...args) => getStartCwdForWorkspaceFromComposition(...args);
syncActiveThreadMetaFromList = (...args) => syncActiveThreadMetaFromListFromComposition(...args);
refreshThreads = (...args) => refreshThreadsFromComposition(...args);
loadThreadMessages = async (...args) => {
  const result = await loadThreadMessagesFromComposition(...args);
  await refreshSlashCommandsState({ force: true, silent: true }).catch(() => {});
  renderComposerContextLeft();
  updateHeaderUi();
  return result;
};
renderThreads = (...args) => renderThreadsFromComposition(...args);
executeSlashCommand = (...args) => executeSlashCommandFromComposition(...args);
renderCommentaryArchive = (...args) => renderCommentaryArchiveFromComposition(...args);
renderAssistantLiveBody = (...args) => renderAssistantLiveBodyFromComposition(...args);
const renderPendingInline = (...args) => renderPendingInlineFromComposition(...args);

({
  blockInSandbox,
  compactModelLabel,
  escapeAttr,
  inModelMenu,
  maybeNotifyTurnDone,
  pickLatestModelId,
  setStatus,
  updateHeaderUi,
  updateNotificationState,
} = createHeaderUiModule({
  state,
  byId,
  swapText,
  getActiveWorkspaceBadgeLabel: (...args) => getActiveWorkspaceBadgeLabel(...args),
  setHeaderModelMenuOpen: (...args) => setHeaderModelMenuOpen(...args),
  escapeHtml,
  REASONING_EFFORT_KEY,
  EFFORT_USER_SELECTED_KEY,
  SANDBOX_MODE,
  localStorageRef: localStorage,
  documentRef: document,
}));

({
  clearPromptValue,
  getPromptValue,
  hideWelcomeCard,
  renderComposerContextLeft,
  renderRuntimePanels,
  clearRuntimeState,
  setRuntimeActivity,
  setActiveCommands,
  setActivePlan,
  setThreadStatusCard,
  clearThreadStatusCard,
  syncRuntimeStateFromHistory,
  applyToolItemRuntimeUpdate,
  applyPlanDeltaUpdate,
  applyPlanSnapshotUpdate,
  finalizeRuntimeState,
  setMainTab,
  setComposerActionMenuOpen,
  showWelcomeCard,
  syncSettingsControlsFromMain,
  updateMobileComposerState,
  updateWelcomeSelections,
} = createComposerUiModule({
  state,
  byId,
  readPromptValue,
  clearPromptInput,
  resolveMobilePromptLayout,
  renderComposerContextLeftInNode,
  renderInlineMessageText,
  toolItemToMessage,
  normalizeType,
  escapeHtml,
  api,
  detectThreadWorkspaceTarget,
  updateHeaderUi: (...args) => updateHeaderUi(...args),
  setSyntheticPendingUserInputs: (...args) => setSyntheticPendingUserInputs(...args),
  upsertSyntheticPendingUserInput: (...args) => upsertSyntheticPendingUserInput(...args),
  LIVE_INSPECTOR_ENABLED_KEY,
  localStorageRef: localStorage,
  documentRef: document,
  windowRef: window,
}));

({
  applyManagedTokenUi,
  persistModelsCache,
  persistThreadsCache,
  refreshCodexVersions,
  relativeTimeLabel,
  renderAttachmentPills,
  restoreCodexVersionCache,
  restoreModelsCache,
  restoreThreadsCache,
  truncateLabel,
} = createAppPersistenceModule({
  state,
  byId,
  api,
  setStatus: (...args) => setStatus(...args),
  updateWorkspaceAvailability: (...args) => updateWorkspaceAvailability(...args),
  getEmbeddedToken,
  ensureArrayItems,
  normalizeModelOption,
  pickLatestModelId: (...args) => pickLatestModelId(...args),
  buildThreadRenderSig,
  sortThreadsByNewest,
  isThreadListActuallyVisible: (...args) => isThreadListActuallyVisible(...args),
  MODELS_CACHE_KEY,
  CODEX_VERSION_CACHE_KEY,
  THREADS_CACHE_KEY,
  REASONING_EFFORT_KEY,
  recordLocalTask: (...args) => webDiagnostics.recordLocalTask(...args),
  localStorageRef: localStorage,
  documentRef: document,
}));

({
  clearLiveThreadConnectionStatus,
  clearTransientThinkingMessages,
  clearTransientToolMessages,
  notificationToToolItem,
  renderLiveNotification,
  showTransientThinkingMessage,
  showTransientToolMessage,
  toToolLikeMessage,
  workspaceKeyOfThread,
} = createLiveNotificationsModule({
  state,
  byId,
  setStatus: (...args) => setStatus(...args),
  addChat: (...args) => addChat(...args),
  removeChatMessageByKey: (...args) => removeChatMessageByKey(...args),
  scheduleChatLiveFollow: (...args) => scheduleChatLiveFollow(...args),
  hideWelcomeCard: (...args) => hideWelcomeCard(...args),
  createAssistantStreamingMessage: (...args) => createAssistantStreamingMessage(...args),
  appendStreamingDelta: (...args) => appendStreamingDelta(...args),
  renderAssistantLiveBody: (...args) => renderAssistantLiveBody(...args),
  finalizeAssistantMessage: (...args) => finalizeAssistantMessage(...args),
  setRuntimeActivity: (...args) => setRuntimeActivity(...args),
  setActiveCommands: (...args) => setActiveCommands(...args),
  applyToolItemRuntimeUpdate: (...args) => applyToolItemRuntimeUpdate(...args),
  applyPlanDeltaUpdate: (...args) => applyPlanDeltaUpdate(...args),
  applyPlanSnapshotUpdate: (...args) => applyPlanSnapshotUpdate(...args),
  clearPendingUserInputs: (...args) => clearPendingUserInputs(...args),
  setSyntheticPendingUserInputs: (...args) => setSyntheticPendingUserInputs(...args),
  suppressSyntheticPendingUserInputs: (...args) => suppressSyntheticPendingUserInputsFromComposition(...args),
  upsertSyntheticPendingUserInput: (...args) => upsertSyntheticPendingUserInput(...args),
  finalizeRuntimeState: (...args) => finalizeRuntimeState(...args),
  flushQueuedTurn: (...args) => flushQueuedTurn(...args),
  renderPendingInline: (...args) => renderPendingInline(...args),
  renderCommentaryArchive: (...args) => renderCommentaryArchive(...args),
  normalizeType,
  normalizeInline,
  normalizeMultiline,
  readNumber,
  toRecord,
  toStructuredPreview,
  extractNotificationThreadId,
}));

({ setMobileTab } = createMobileShellModule({
  state,
  byId,
  documentRef: document,
  normalizeWorkspaceTarget,
  getWorkspaceTarget: (...args) => getWorkspaceTarget(...args),
  pushThreadAnimDebug,
  renderThreads: (...args) => renderThreads(...args),
  hideSlashCommandMenu: (...args) => hideSlashCommandMenu(...args),
}));

({
  hideSlashCommandMenu,
  handleSlashCommandKeyDown,
  refreshSlashCommands: refreshSlashCommandsState,
  syncSlashCommandMenu,
} = createSlashCommandsModule({
  state,
  byId,
  api,
  armSyntheticClickSuppression,
  executeSlashCommand: (...args) => executeSlashCommand(...args),
  getWorkspaceTarget: (...args) => getWorkspaceTarget(...args),
  getStartCwdForWorkspace: (...args) => getStartCwdForWorkspace(...args),
  escapeHtml,
  updateMobileComposerState: (...args) => updateMobileComposerState(...args),
  setStatus: (...args) => setStatus(...args),
  documentRef: document,
  windowRef: window,
}));

bootstrap();
