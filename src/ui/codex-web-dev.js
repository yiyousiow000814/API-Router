import { waitPendingThreadResume as waitPendingThreadResumeInStore } from "./modules/codex-web/pendingThreadResume.js";
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
  normalizeThreadItemText,
  normalizeType,
  parseUserMessageParts,
  stripCodexImageBlocks,
  toStructuredPreview,
} from "./modules/codex-web/messageData.js";
import { normalizeStartCwd } from "./modules/codex-web/workspaceUi.js";
import {
  createWsClientModule,
  ensureArrayItems,
  nextFrame,
  nextReqId,
} from "./modules/codex-web/wsClient.js";
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
import {
  ACTIVE_THREAD_LIVE_POLL_MS,
  ACTIVE_THREAD_LIVE_POLL_WS_FALLBACK_MS,
  ACTIVE_THREAD_REFRESH_DEBOUNCE_MS,
  CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS,
  CHAT_LIVE_FOLLOW_MAX_STEP_PX,
  CHAT_STICKY_BOTTOM_PX,
  EFFORT_USER_SELECTED_KEY,
  FAVORITE_THREADS_KEY,
  GUIDE_DISMISSED_KEY,
  HISTORY_WINDOW_THRESHOLD,
  LAST_EVENT_ID_KEY,
  MODEL_LOADING_MIN_MS,
  MODELS_CACHE_KEY,
  MODEL_USER_SELECTED_KEY,
  REASONING_EFFORT_KEY,
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
let updateMobileComposerState = () => {};
let setMainTab = () => {};
let syncSettingsControlsFromMain = () => {};
let updateWelcomeSelections = () => {};
let persistModelsCache = () => {};
let restoreModelsCache = () => false;
let persistThreadsCache = () => {};
let restoreThreadsCache = () => false;
let refreshCodexVersions = async () => {};
let applyManagedTokenUi = () => {};
let truncateLabel = (value) => String(value || "");
let relativeTimeLabel = () => "";
let renderAttachmentPills = () => {};
let toToolLikeMessage = () => null;
let notificationToToolItem = () => null;
let renderLiveNotification = () => {};
let workspaceKeyOfThread = () => "Default folder";
let setMobileTab = () => {};
let getWorkspaceTarget = () => normalizeWorkspaceTarget(state.workspaceTarget || "windows");
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

function extractNotificationEventId(notification) {
  const record = toRecord(notification);
  const id = readNumber(record?.eventId) ?? readNumber(record?.event_id);
  if (id === null) return null;
  const normalized = Math.floor(id);
  return normalized > 0 ? normalized : null;
}

function extractNotificationThreadId(notification) {
  const record = toRecord(notification);
  const params = toRecord(record?.params);
  const msg = toRecord(params?.msg);
  const thread = toRecord(params?.thread) || toRecord(params?.threadState) || toRecord(params?.thread_state);
  const turn = toRecord(params?.turn) || toRecord(params?.turnState) || toRecord(params?.turn_state);
  const item = toRecord(params?.item) || toRecord(params?.itemState) || toRecord(params?.item_state);
  const source = toRecord(params?.source) || toRecord(msg?.source);
  const subagent = toRecord(toRecord(source?.subagent)?.thread_spawn);
  const keys = new Set(["thread_id", "threadId", "conversation_id", "conversationId"]);
  const seen = new Set();
  const deepFindThreadId = (root, depth = 0) => {
    if (!root || depth > 6 || typeof root !== "object" || seen.has(root)) return null;
    seen.add(root);
    if (Array.isArray(root)) {
      for (let i = 0; i < Math.min(root.length, 40); i += 1) {
        const found = deepFindThreadId(root[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const key of Object.keys(root)) {
      if (keys.has(key)) {
        const found = readString(root[key]);
        if (found) return found;
      }
    }
    for (const key of Object.keys(root)) {
      const found = deepFindThreadId(root[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return (
    readString(msg?.thread_id) ||
    readString(msg?.threadId) ||
    readString(msg?.conversation_id) ||
    readString(msg?.conversationId) ||
    readString(params?.thread_id) ||
    readString(params?.threadId) ||
    readString(thread?.id) ||
    readString(thread?.thread_id) ||
    readString(thread?.threadId) ||
    readString(turn?.thread_id) ||
    readString(turn?.threadId) ||
    readString(item?.thread_id) ||
    readString(item?.threadId) ||
    readString(source?.thread_id) ||
    readString(source?.threadId) ||
    readString(source?.parent_thread_id) ||
    readString(source?.parentThreadId) ||
    readString(subagent?.parent_thread_id) ||
    deepFindThreadId(params) ||
    null
  );
}

function shouldRefreshThreadsFromNotification(method) {
  return (
    method.startsWith("thread/") ||
    method.startsWith("turn/") ||
    method.startsWith("item/") ||
    method.startsWith("codex/event/")
  );
}

function shouldRefreshActiveThreadFromNotification(method) {
  return shouldRefreshThreadsFromNotification(method) || method === "thread/name/updated" || method === "thread/status/changed";
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

function setActiveThread(id) {
  const prev = state.activeThreadId || "";
  state.activeThreadId = id || "";
  if (prev !== state.activeThreadId) state.activeThreadRenderSig = "";
  if (!state.activeThreadId) {
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = getWorkspaceTarget();
  } else {
    syncActiveThreadMetaFromList(state.activeThreadId);
  }
  const activeThreadLabel = byId("activeThreadId");
  if (activeThreadLabel) activeThreadLabel.textContent = state.activeThreadId || "(none)";
  updateHeaderUi();
}

const composition = createCodexWebComposition({
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
  blockInSandbox: (...args) => blockInSandbox(...args),
  getEmbeddedToken,
  refreshCodexVersions: (...args) => refreshCodexVersions(...args),
  getPromptValue: (...args) => getPromptValue(...args),
  waitPendingThreadResume,
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
  normalizeModelOption,
  isThreadAnimDebugEnabled,
  threadAnimDebug,
  WEB_CODEX_DEV_DEBUG_VERSION,
  normalizeStartCwd,
  restoreModelsCache: (...args) => restoreModelsCache(...args),
  restoreThreadsCache: (...args) => restoreThreadsCache(...args),
  applyManagedTokenUi: (...args) => applyManagedTokenUi(...args),
  updateMobileComposerState: (...args) => updateMobileComposerState(...args),
  syncSettingsControlsFromMain: (...args) => syncSettingsControlsFromMain(...args),
  updateWelcomeSelections: (...args) => updateWelcomeSelections(...args),
  GUIDE_DISMISSED_KEY,
  TOKEN_STORAGE_KEY,
  WORKSPACE_TARGET_KEY,
  START_CWD_BY_WORKSPACE_KEY,
  FAVORITE_THREADS_KEY,
  SELECTED_MODEL_KEY,
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
  localStorageRef: localStorage,
  documentRef: document,
  requestAnimationFrameRef: requestAnimationFrame,
  MutationObserverRef: MutationObserver,
});

const {
  api,
  addChat,
  bootstrap,
  getActiveWorkspaceBadgeLabel,
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
syncActiveThreadMetaFromList = (...args) => syncActiveThreadMetaFromListFromComposition(...args);
refreshThreads = (...args) => refreshThreadsFromComposition(...args);
loadThreadMessages = (...args) => loadThreadMessagesFromComposition(...args);
renderThreads = (...args) => renderThreadsFromComposition(...args);

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
  setMainTab,
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
  updateHeaderUi: (...args) => updateHeaderUi(...args),
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
  THREADS_CACHE_KEY,
  REASONING_EFFORT_KEY,
  localStorageRef: localStorage,
  documentRef: document,
}));

({
  notificationToToolItem,
  renderLiveNotification,
  toToolLikeMessage,
  workspaceKeyOfThread,
} = createLiveNotificationsModule({
  state,
  byId,
  addChat: (...args) => addChat(...args),
  scheduleChatLiveFollow: (...args) => scheduleChatLiveFollow(...args),
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
}));

bootstrap();
