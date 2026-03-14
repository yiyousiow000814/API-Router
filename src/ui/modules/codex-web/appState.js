export const WEB_CODEX_DEV_DEBUG_VERSION = "2026-03-09-debug-7";

export const GUIDE_DISMISSED_KEY = "web_codex_guide_dismissed_v2";
export const TOKEN_STORAGE_KEY = "web_codex_token_v1";
export const WORKSPACE_TARGET_KEY = "web_codex_workspace_target_v1";
export const START_CWD_BY_WORKSPACE_KEY = "web_codex_start_cwd_by_workspace_v1";
export const FAVORITE_THREADS_KEY = "web_codex_favorite_threads_v1";
export const SELECTED_MODEL_KEY = "web_codex_selected_model_v1";
export const MODELS_CACHE_KEY = "web_codex_models_cache_v1";
export const THREADS_CACHE_KEY = "web_codex_threads_cache_v1";
export const REASONING_EFFORT_KEY = "web_codex_reasoning_effort_v1";
export const LAST_EVENT_ID_KEY = "web_codex_last_event_id_v1";
export const LIVE_INSPECTOR_ENABLED_KEY = "web_codex_live_inspector_enabled_v1";
export const MODEL_USER_SELECTED_KEY = "web_codex_model_user_selected_v1";
export const EFFORT_USER_SELECTED_KEY = "web_codex_effort_user_selected_v1";
const WINDOW_REF = typeof window === "undefined" ? null : window;
export const SANDBOX_MODE =
  WINDOW_REF?.__WEB_CODEX_SANDBOX__ === true ||
  WINDOW_REF?.location?.pathname?.startsWith("/sandbox/") ||
  new URLSearchParams(WINDOW_REF?.location?.search || "").get("sandbox") === "1";
export const THREAD_PULL_REFRESH_TRIGGER_PX = 44;
export const THREAD_PULL_REFRESH_MAX_PX = 84;
export const THREAD_PULL_REFRESH_MIN_MS = 520;
export const THREAD_PULL_HINT_CLEAR_DELAY_MS = 160;
export const THREAD_REFRESH_DEBOUNCE_MS = 260;
export const THREAD_FORCE_REFRESH_MIN_INTERVAL_MS = 1800;
export const THREAD_AUTO_REFRESH_CONNECTED_MS = 20000;
export const THREAD_AUTO_REFRESH_DISCONNECTED_MS = 3500;
export const ACTIVE_THREAD_REFRESH_DEBOUNCE_MS = 380;
export const ACTIVE_THREAD_LIVE_POLL_MS = 800;
export const MODEL_LOADING_MIN_MS = 1000;
export const RECENT_EVENT_ID_CACHE_SIZE = 2048;
export const CHAT_LIVE_FOLLOW_MAX_STEP_PX = 64;
export const CHAT_LIVE_FOLLOW_BTN_THROTTLE_MS = 66;
export const CHAT_STICKY_BOTTOM_PX = 12;
export const HISTORY_WINDOW_THRESHOLD = 180;

export function createInitialState() {
  return {
    token: "",
    activeHostId: "",
    activeThreadId: "",
    activeThreadRolloutPath: "",
    openingThreadAbort: null,
    ws: null,
    wsPingTimer: null,
    wsReconnectTimer: null,
    wsReconnectAttempt: 0,
    wsConnectSeq: 0,
    wsReqHandlers: new Map(),
    pendingApprovals: [],
    pendingUserInputs: [],
    threadItemsAll: [],
    threadItems: [],
    threadItemsByWorkspace: { windows: [], wsl2: [] },
    threadWorkspaceHydratedByWorkspace: { windows: false, wsl2: false },
    threadListRenderSigByWorkspace: { windows: "", wsl2: "" },
    threadListLoading: false,
    threadListLoadingTarget: "",
    threadListAnimateNextRender: false,
    threadListAnimateThreadIds: new Set(),
    threadListExpandAnimateGroupKeys: new Set(),
    threadListPendingSidebarOpenAnimation: false,
    threadListPendingVisibleAnimationByWorkspace: { windows: false, wsl2: false },
    threadListVisibleOpenAnimationUntil: 0,
    threadListVisibleAnimationTimer: 0,
    threadListAnimationHoldUntilByWorkspace: { windows: 0, wsl2: 0 },
    threadListDeferredRenderTimerByWorkspace: { windows: 0, wsl2: 0 },
    threadListSkipScrollRestoreOnce: false,
    threadListPreferLoadingPlaceholder: false,
    drawerOpenPhaseTimer: 0,
    threadRefreshAbortByWorkspace: { windows: null, wsl2: null },
    threadRefreshReqSeqByWorkspace: { windows: 0, wsl2: 0 },
    threadAutoRefreshLastMsByWorkspace: { windows: 0, wsl2: 0 },
    threadForceRefreshLastMsByWorkspace: { windows: 0, wsl2: 0 },
    threadAutoRefreshInFlight: false,
    scheduledRefreshTimer: null,
    activeThreadRefreshTimer: null,
    activeThreadLivePolling: false,
    activeThreadLiveLastPollMs: 0,
    activeThreadLiveAssistantThreadId: "",
    activeThreadLiveAssistantIndex: -1,
    activeThreadLiveAssistantMsgNode: null,
    activeThreadLiveAssistantBodyNode: null,
    activeThreadLiveAssistantText: "",
    activeThreadRenderSig: "",
    activeThreadMessages: [],
    activeThreadPendingTurnThreadId: "",
    activeThreadPendingTurnRunning: false,
    activeThreadPendingUserMessage: "",
    activeThreadPendingAssistantMessage: "",
    activeThreadPendingTurnBaselineTurnCount: 0,
    activeThreadLiveStateEpoch: 0,
    activeThreadLiveRuntimeEpoch: 0,
    activeThreadCommentaryPendingPlan: null,
    activeThreadCommentaryPendingTools: [],
    activeThreadCommentaryPendingToolKeys: [],
    liveDebugEvents: [],
    liveTraceUploadedCount: 0,
    liveTraceSyncInFlight: false,
    wsLastEventId: 0,
    wsRecentEventIds: new Set(),
    wsRecentEventIdQueue: [],
    wsSubscribedEvents: false,
    collapsedWorkspaceKeys: new Set(),
    collapsedWorkspaceKeysByWorkspace: { windows: new Set(), wsl2: new Set() },
    threadGroupCollapseInitializedByWorkspace: { windows: false, wsl2: false },
    sidebarCollapsed: false,
    threadSearchQuery: "",
    activeMainTab: "chat",
    workspaceTarget: "windows",
    workspaceAvailability: { windowsInstalled: false, wsl2Installed: false },
    gatewayBuildStaleWarned: false,
    startCwdByWorkspace: { windows: "", wsl2: "" },
    folderPickerOpen: false,
    folderPickerWorkspace: "windows",
    folderPickerCurrentPath: "",
    folderPickerParentPath: "",
    folderPickerItems: [],
    folderPickerLoading: false,
    folderPickerError: "",
    folderPickerReqSeq: 0,
    folderPickerListRenderSig: "",
    folderPickerKeepContentWhileLoading: true,
    favoriteThreadIds: new Set(),
    threadListChevronOpenAnimateKeys: new Set(),
    threadListChevronCloseAnimateKeys: new Set(),
    threadListCollapseAnimateGroupKeys: new Set(),
    threadPullRefreshing: false,
    activeThreadStarted: false,
    chatOpening: false,
    chatRenderToken: 0,
    chatSmoothScrollUntil: 0,
    chatSmoothScrollToken: 0,
    chatLiveFollowUntil: 0,
    chatLiveFollowToken: 0,
    chatLiveFollowRaf: 0,
    chatLiveFollowLastBtnMs: 0,
    chatLastScrollTop: 0,
    chatLastUserGestureAt: 0,
    chatUserScrolledAwayAt: 0,
    chatShouldStickToBottom: true,
    chatProgrammaticScrollUntil: 0,
    activeThreadWorkspace: "windows",
    planModeEnabled: false,
    modelOptions: [],
    modelOptionsLoading: true,
    modelOptionsLoadingSeq: 0,
    modelOptionsLoadingStartedAt: 0,
    headerModelWasLoading: true,
    headerModelSwapInProgress: false,
    headerModelSwapTimer: 0,
    selectedModel: "",
    selectedReasoningEffort: "",
    inlineEffortMenuOpen: false,
    inlineEffortMenuForModel: "",
    openingThreadReqId: 0,
    pendingThreadResumes: new Map(),
    suppressSyntheticClickUntil: 0,
    historyWindowEnabled: false,
    historyWindowThreadId: "",
    historyWindowStart: 0,
    historyWindowSize: 60,
    historyWindowChunk: 60,
    historyWindowLoading: false,
    historyAllMessages: [],
    activeThreadHistoryTurns: [],
    activeThreadHistoryThreadId: "",
    activeThreadHistoryHasMore: false,
    activeThreadHistoryIncomplete: false,
    activeThreadHistoryBeforeCursor: "",
    activeThreadHistoryTotalTurns: 0,
    activeThreadHistoryReqSeq: 0,
    activeThreadHistoryInFlightPromise: null,
    activeThreadHistoryInFlightThreadId: "",
    activeThreadHistoryPendingRefresh: null,
    activeThreadTokenUsage: null,
    activeThreadNeedsResume: false,
    activeThreadTransientToolText: "",
    activeThreadTransientThinkingText: "",
    activeThreadCommentaryCurrent: null,
    activeThreadCommentaryArchive: [],
    activeThreadCommentaryArchiveVisible: false,
    activeThreadCommentaryArchiveExpanded: false,
    activeThreadInlineCommentaryArchiveCount: 0,
    activeThreadActivity: null,
    activeThreadActiveCommands: [],
    activeThreadPlan: null,
    slashCommands: [],
    slashCommandsLoaded: false,
    slashCommandsLoading: false,
    slashCommandsError: "",
    slashMenuItems: [],
    slashMenuOpen: false,
    slashMenuSelectedIndex: 0,
  };
}

export function createThreadAnimDebugState() {
  return { enabled: false, events: [], seq: 0 };
}

export const state = createInitialState();
export const threadAnimDebug = createThreadAnimDebugState();
