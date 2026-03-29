import { buildPermissionRuntimeOptions } from "./turnActions.js";

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function listDataArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function readQuery(path) {
  const [, search = ""] = String(path || "").split("?");
  return new URLSearchParams(search);
}

function normalizeWorkspace(value, fallback = "windows") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "windows" || text === "wsl2") return text;
  return fallback === "wsl2" ? "wsl2" : "windows";
}

function threadTitleFromPrompt(prompt, fallback = "New chat") {
  const text = String(prompt || "").trim().replace(/\s+/g, " ");
  if (!text) return fallback;
  return text.length > 48 ? `${text.slice(0, 47)}...` : text;
}

function buildMockResponseText(payload, prompt) {
  const userPrompt = String(prompt || "").trim() || "your request";
  if (payload?.collaborationMode === "plan") {
    return [
      "Plan mode is active in this local mock preview.",
      "I am intentionally streaming more slowly so you can test stop, steer, queue, and send-now interactions before the turn finishes.",
      `Current request: ${userPrompt}.`,
      "Step 1: inspect the current context and confirm the runtime options for this Web chat.",
      "Step 2: map the likely codepath changes and identify the files that would need edits.",
      "Step 3: verify the result, then send a concise follow-up once the current tool flow completes.",
      "This longer mock response is only for preview behavior and does not touch the live backend.",
    ].join(" ");
  }
  if (payload?.serviceTier === "fast") {
    return [
      "Fast mode is active in this local mock preview.",
      "Even though the mock is labelled fast, this turn is intentionally extended so you have enough time to test steer, stop, queued follow-up, edit, and interrupt-and-send-now behavior.",
      `Current request: ${userPrompt}.`,
      "I am simulating an assistant that keeps working for several beats instead of finishing immediately.",
      "That gives the composer enough time to expose the same runtime controls you would expect during a real long-running turn.",
      "Nothing from this preview is sent to the real Codex backend.",
    ].join(" ");
  }
  return [
    "This is a local mock assistant reply for the Codex Web preview.",
    "The response is intentionally longer and slower now, so you can test stop, steer, follow-up queue, queued edit, and send-now interactions without racing the stream.",
    `Current request: ${userPrompt}.`,
    "The preview keeps the main UI codepath, but the transport is mocked and isolated from the real backend.",
    "That means the controls should feel realistic while remaining safe to click during development.",
  ].join(" ");
}

function buildMockChunks(text) {
  const normalized = String(text || "").trim().replace(/\s+/g, " ");
  if (!normalized) return ["Done."];
  return (
    normalized.match(/.{1,18}(?:\s+|$)/g)?.map((chunk) => chunk.trim()).filter(Boolean) || [normalized]
  );
}

function buildMockCommentaryText(payload, prompt) {
  const userPrompt = String(prompt || "").trim() || "your request";
  if (payload?.collaborationMode === "plan") {
    return `Inspecting the workspace and breaking down "${userPrompt}" into a concrete plan.`;
  }
  if (payload?.serviceTier === "fast") {
    return `Fast mode is on, so I am quickly scanning context for "${userPrompt}" before responding.`;
  }
  return `Inspecting local context for "${userPrompt}" before I answer.`;
}

function buildMockToolSteps(payload) {
  const failedCommand = String(payload?.mockScenario || "").trim().toLowerCase() === "failed-command";
  return [
    {
      startAt: 420,
      completeAt: 1500,
      running: {
        id: "mock-web-search-1",
        type: "web_search",
        query: "local mock transport",
        status: "running",
      },
      completed: {
        id: "mock-web-search-1",
        type: "web_search",
        query: "local mock transport",
        status: "completed",
      },
    },
    {
      startAt: 2400,
      completeAt: 3600,
      running: {
        id: "mock-command-1",
        type: "command_execution",
        command: "Get-ChildItem -Recurse -Filter *.js",
        status: "running",
      },
      completed: {
        id: "mock-command-1",
        type: "command_execution",
        command: "Get-ChildItem -Recurse -Filter *.js",
        status: "completed",
        output: "src/ui/modules/codex-web/wsClient.js\nsrc/ui/modules/codex-web/mockTransport.js",
        exitCode: 0,
      },
    },
    failedCommand
      ? {
          startAt: 4700,
          completeAt: 5900,
          running: {
            id: "mock-command-2",
            type: "command_execution",
            command: "node scripts/run-with-win-sdk.mjs cargo test --manifest-path src-tauri/Cargo.toml web_codex_ws --lib",
            status: "running",
          },
          completed: {
            id: "mock-command-2",
            type: "command_execution",
            command: "node scripts/run-with-win-sdk.mjs cargo test --manifest-path src-tauri/Cargo.toml web_codex_ws --lib",
            status: "failed",
            output: "test failed: mock websocket timeout",
            exitCode: 1,
          },
        }
      : {
          startAt: 4700,
          completeAt: 5900,
          running: {
            id: "mock-command-2",
            type: "command_execution",
            command: "Get-Content src/ui/modules/codex-web/actionBindings.js",
            status: "running",
          },
          completed: {
            id: "mock-command-2",
            type: "command_execution",
            command: "Get-Content src/ui/modules/codex-web/actionBindings.js",
            status: "completed",
            output: "export function createActionBindingsModule(deps) { ... }",
            exitCode: 0,
          },
        },
  ];
}

function buildSlashCatalog(state) {
  const workspace = normalizeWorkspace(state.activeThreadWorkspace || state.workspaceTarget || "windows");
  const permission = String(state.permissionPresetByWorkspace?.[workspace] || "/permission auto").trim().toLowerCase();
  return {
    commands: [
      {
        command: "/fast",
        description: "Switch the current Web chat service tier.",
        children: [
          { command: "/fast on", description: "Use fast service tier.", active: state.fastModeEnabled === true },
          { command: "/fast off", description: "Use standard routing.", active: state.fastModeEnabled !== true },
        ],
      },
      {
        command: "/plan",
        description: "Switch collaboration mode.",
        children: [
          { command: "/plan on", description: "Plan mode.", active: state.planModeEnabled === true },
          { command: "/plan off", description: "Default mode.", active: state.planModeEnabled !== true },
        ],
      },
      {
        command: "/permission",
        description: "Set runtime permissions for this Web chat.",
        children: [
          { command: "/permission auto", description: "Workspace write.", active: permission === "/permission auto" },
          { command: "/permission read-only", description: "Read only.", active: permission === "/permission read-only" },
          { command: "/permission full-access", description: "Full access.", active: permission === "/permission full-access" },
        ],
      },
      { command: "/diff", description: "Show current diff.", usage: "/diff" },
      { command: "/compact", description: "Compact the conversation context.", usage: "/compact" },
      { command: "/review", description: "Open review helpers.", usage: "/review" },
    ],
  };
}

function buildReviewItems(kind) {
  if (kind === "branches") {
    return {
      items: [
        { value: "main", label: "HEAD -> main", description: "Recommended" },
        { value: "release/5.5", label: "HEAD -> release/5.5", description: "Stable" },
        { value: "feat/mock-transport", label: "HEAD -> feat/mock-transport", description: "Current work" },
      ],
    };
  }
  return {
    items: [
      { value: "HEAD", label: "HEAD", description: "Current checkout" },
      { value: "abc1234", label: "abc1234", description: "Latest local commit" },
      { value: "def5678", label: "def5678", description: "Previous commit" },
    ],
  };
}

function buildFolderItems(workspace, cwd = "") {
  const base = workspace === "wsl2" ? "/home/yiyou/project" : "C:\\Users\\yiyou\\API-Router";
  const current = String(cwd || base).trim() || base;
  const slash = workspace === "wsl2" ? "/" : "\\";
  const parent = current.includes(slash) ? current.split(slash).slice(0, -1).join(slash) || current : current;
  const join = (...parts) => parts.filter(Boolean).join(slash).replace(/\\\\+/g, "\\");
  const folders = workspace === "wsl2"
    ? ["src", "tests", ".codex", "docs"]
    : ["src", "user-data", ".codex", "scripts"];
  return {
    cwd: current,
    parent,
    items: folders.map((name) => ({
      name,
      path: workspace === "wsl2" ? `${current}/${name}`.replace(/\/+/g, "/") : join(current, name),
      kind: "directory",
    })),
  };
}

export function createMockCodexTransport(deps) {
  const {
    state,
    setStatus = () => {},
    transportMode = "mock",
    seedDefaultThreads = false,
    liveApi = async () => {
      throw new Error("Live API is unavailable.");
    },
    handleWsPayload = () => {},
    connectLiveWsFallback = () => {},
  } = deps;

  const safeModeEnabled = transportMode === "safe";

  const mockState = {
    seq: 3,
    turnSeq: 1,
    threads: new Map(),
    order: { windows: [], wsl2: [] },
    turns: new Map(),
  };

  function nextThreadId() {
    mockState.seq += 1;
    return `mock-thread-${mockState.seq}`;
  }

  function nextTurnId() {
    const id = `mock-turn-${mockState.turnSeq}`;
    mockState.turnSeq += 1;
    return id;
  }

  function seedThread(config) {
    const workspace = normalizeWorkspace(config.workspace);
    const thread = {
      id: String(config.id || nextThreadId()),
      workspace,
      cwd: String(config.cwd || (workspace === "wsl2" ? "/home/yiyou/project" : "C:\\Users\\yiyou\\API-Router")),
      title: String(config.title || "New chat"),
      updatedAt: String(config.updatedAt || nowIso()),
      createdAt: String(config.createdAt || nowIso()),
      rolloutPath: String(
        config.rolloutPath ||
          (workspace === "wsl2"
            ? `/home/yiyou/.codex/sessions/${String(config.id || "mock").replace(/[^a-z0-9-]/gi, "-")}.jsonl`
            : `C:\\Users\\yiyou\\.codex\\sessions\\${String(config.id || "mock").replace(/[^a-z0-9-]/gi, "-")}.jsonl`)
      ),
      serviceTier: config.serviceTier === "fast" ? "fast" : null,
      collaborationMode: config.collaborationMode === "plan" ? "plan" : "default",
      permissionPreset: String(config.permissionPreset || "/permission auto"),
      history: Array.isArray(config.history) ? clone(config.history) : [],
      runningTurnId: "",
      pendingPrompt: "",
      assistantDraft: "",
      tokenUsage: config.tokenUsage || null,
    };
    mockState.threads.set(thread.id, thread);
    const list = mockState.order[workspace];
    const existingIndex = list.indexOf(thread.id);
    if (existingIndex >= 0) list.splice(existingIndex, 1);
    list.unshift(thread.id);
    return thread;
  }

  function initSeedData() {
    if (mockState.threads.size > 0) return;
    if (!seedDefaultThreads) return;
    seedThread({
      id: "mock-thread-1",
      workspace: "windows",
      title: "Review mock transport flow",
      updatedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      history: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Check the current routing flow." }] },
            { type: "assistantMessage", text: "The Web preview is using a local mock transport in dev mode." },
          ],
        },
      ],
      tokenUsage: { usedPct: 42, display: "58% context left" },
    });
    seedThread({
      id: "mock-thread-2",
      workspace: "windows",
      title: "Plan next refactor",
      updatedAt: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
      collaborationMode: "plan",
      serviceTier: "fast",
      permissionPreset: "/permission full-access",
      history: [
        {
          id: "turn-1",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Draft a migration plan." }] },
            { type: "assistantMessage", text: "Plan drafted with three concrete steps." },
          ],
        },
      ],
      tokenUsage: { usedPct: 18, display: "82% context left" },
    });
  }

  function getThread(threadId) {
    initSeedData();
    return mockState.threads.get(String(threadId || "").trim()) || null;
  }

  function ensureShadowThread(threadId, config = {}) {
    const normalizedId = String(threadId || "").trim();
    if (!normalizedId) return null;
    const existing = getThread(normalizedId);
    if (existing) return existing;
    return seedThread({
      id: normalizedId,
      workspace: normalizeWorkspace(config.workspace || state.activeThreadWorkspace || state.workspaceTarget || "windows"),
      cwd: String(
        config.cwd ||
          (normalizeWorkspace(config.workspace || state.activeThreadWorkspace || state.workspaceTarget || "windows") === "wsl2"
            ? "/home/yiyou/project"
            : "C:\\Users\\yiyou\\API-Router")
      ),
      title: String(config.title || state.activeThreadId || "Sandbox preview"),
      rolloutPath: String(config.rolloutPath || "sandbox-preview"),
      serviceTier: config.serviceTier,
      permissionPreset: config.permissionPreset || state.permissionPresetByWorkspace?.[normalizeWorkspace(config.workspace || state.activeThreadWorkspace || state.workspaceTarget || "windows")],
      history: [],
      tokenUsage: config.tokenUsage || null,
    });
  }

  async function maybeLiveRead(path, options = {}) {
    if (!safeModeEnabled) return null;
    const method = String(options.method || "GET").trim().toUpperCase();
    const url = String(path || "");
    const isRead =
      method === "GET" ||
      (method === "POST" && /^\/codex\/threads\/[^/]+\/resume(?:\?|$)/.test(url)) ||
      (method === "POST" && url === "/codex/auth/verify");
    if (!isRead) return null;
    return liveApi(path, options);
  }

  function updateThreadOrder(thread) {
    const workspace = normalizeWorkspace(thread?.workspace);
    const list = mockState.order[workspace];
    const id = String(thread?.id || "");
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1);
    list.unshift(id);
    thread.updatedAt = nowIso();
  }

  function listThreads(workspace) {
    initSeedData();
    return mockState.order[workspace]
      .map((id) => mockState.threads.get(id))
      .filter(Boolean)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        preview: thread.title,
        updatedAt: thread.updatedAt,
        createdAt: thread.createdAt,
        workspace: thread.workspace,
        cwd: thread.cwd,
        path: thread.rolloutPath,
        project: thread.cwd,
        pinned: false,
        status: { type: thread.runningTurnId ? "running" : "idle" },
      }));
  }

  function mergeSafeThreadList(livePayload, workspace) {
    const payload = clone(livePayload) || {};
    const liveItems = listDataArray(payload?.items);
    const merged = new Map();
    for (const item of liveItems) {
      const id = String(item?.id || item?.threadId || "").trim();
      if (!id) continue;
      merged.set(id, clone(item));
    }
    for (const item of listThreads(workspace)) {
      const id = String(item?.id || "").trim();
      if (!id) continue;
      const existing = merged.get(id);
      merged.set(id, existing ? { ...existing, ...item, status: item.status || existing.status } : item);
    }
    const data = Array.from(merged.values()).sort((a, b) => {
      const left = Date.parse(String(a?.updatedAt || "")) || 0;
      const right = Date.parse(String(b?.updatedAt || "")) || 0;
      return right - left;
    });
    return {
      ...payload,
      items: {
        ...(payload?.items && typeof payload.items === "object" ? payload.items : {}),
        data,
        nextCursor: payload?.items?.nextCursor ?? null,
      },
    };
  }

  function historyPayload(thread) {
    const running = !!String(thread.runningTurnId || "").trim();
    const turns = clone(thread.history);
    if (running && thread.pendingPrompt) {
      const record = mockState.turns.get(String(thread.runningTurnId || "").trim());
      if (record?.historyTurn?.items?.length) {
        turns.push(clone(record.historyTurn));
      } else {
        turns.push({
          id: `pending-${thread.runningTurnId}`,
          items: [
            { type: "userMessage", content: [{ type: "text", text: thread.pendingPrompt }] },
          ],
        });
      }
    }
    return {
      id: thread.id,
      path: thread.rolloutPath,
      cwd: thread.cwd,
      workspace: thread.workspace,
      modelName: state.selectedModel || "gpt-5.5-codex",
      turns,
      hasMore: false,
      totalTurns: turns.length,
      beforeCursor: "",
      incomplete: running,
      tokenUsage: thread.tokenUsage || null,
    };
  }

  function historyResponsePayload(thread) {
    const payload = historyPayload(thread);
    return {
      thread: payload,
      page: {
        hasMore: payload.hasMore,
        totalTurns: payload.totalTurns,
        beforeCursor: payload.beforeCursor,
        incomplete: payload.incomplete,
      },
    };
  }

  function isMockOnlyThread(threadId) {
    return /^mock-thread-\d+$/.test(String(threadId || "").trim());
  }

  function mergeSafeHistoryPayload(livePayload, thread) {
    const payload = clone(livePayload) || {};
    const liveThread =
      payload?.thread && typeof payload.thread === "object"
        ? payload.thread
        : payload;
    const liveTurns = Array.isArray(liveThread?.turns) ? liveThread.turns : [];
    const mockTurns = Array.isArray(thread?.history) ? clone(thread.history) : [];
    if (thread?.runningTurnId && thread?.pendingPrompt) {
      const record = mockState.turns.get(String(thread.runningTurnId || "").trim());
      if (record?.historyTurn?.items?.length) {
        mockTurns.push(clone(record.historyTurn));
      } else {
        mockTurns.push({
          id: `pending-${thread.runningTurnId}`,
          items: [{ type: "userMessage", content: [{ type: "text", text: thread.pendingPrompt }] }],
        });
      }
    }
    const mergedTurns = liveTurns.concat(mockTurns);
    const mergedThread = {
      ...liveThread,
      id: String(liveThread?.id || thread?.id || ""),
      path: String(liveThread?.path || liveThread?.rolloutPath || thread?.rolloutPath || ""),
      rolloutPath: String(liveThread?.rolloutPath || liveThread?.path || thread?.rolloutPath || ""),
      cwd: String(liveThread?.cwd || thread?.cwd || ""),
      workspace: String(liveThread?.workspace || thread?.workspace || ""),
      turns: mergedTurns,
      tokenUsage: liveThread?.tokenUsage || thread?.tokenUsage || null,
    };
    return payload?.thread && typeof payload.thread === "object"
      ? {
          ...payload,
          thread: mergedThread,
          page: {
            ...(payload?.page && typeof payload.page === "object" ? payload.page : {}),
            totalTurns: mergedTurns.length,
            incomplete:
              payload?.page?.incomplete === true || !!String(thread?.runningTurnId || "").trim(),
          },
        }
      : {
          ...payload,
          ...mergedThread,
          incomplete:
            payload?.incomplete === true || !!String(thread?.runningTurnId || "").trim(),
          totalTurns: Number(payload?.totalTurns || mergedTurns.length) || mergedTurns.length,
        };
  }

  function emitNotification(method, threadId, params = {}) {
    handleWsPayload({
      type: "rpc.notification",
      payload: {
        method,
        params: {
          threadId,
          conversationId: threadId,
          ...clone(params),
        },
      },
    });
  }

  function clearTurnTimers(record) {
    if (!record) return;
    for (const timer of Array.isArray(record.timers) ? record.timers : []) clearTimeout(timer);
    record.timers = [];
  }

  function pushHistoryItem(record, item) {
    if (!record || !item || typeof item !== "object") return;
    if (!record.historyTurn || typeof record.historyTurn !== "object") {
      record.historyTurn = { id: record.turnId, items: [] };
    }
    if (!Array.isArray(record.historyTurn.items)) record.historyTurn.items = [];
    record.historyTurn.items.push(clone(item));
  }

  function finalizeTurn(record, outcome = "completed") {
    if (!record) return;
    clearTurnTimers(record);
    const thread = getThread(record.threadId);
    if (!thread) return;
    mockState.turns.delete(record.turnId);
    thread.runningTurnId = "";
    thread.assistantDraft = "";
    if (outcome === "completed") {
      const finalText = String(record.finalText || "Done.").trim() || "Done.";
      pushHistoryItem(record, { type: "assistantMessage", text: finalText, phase: "final_answer" });
      thread.history.push(clone(record.historyTurn));
      thread.title = threadTitleFromPrompt(record.prompt, thread.title);
      thread.tokenUsage = {
        usedPct: Math.min(92, Math.max(8, (thread.history.length * 13) % 100)),
        display: `${Math.max(8, 100 - Math.min(92, Math.max(8, (thread.history.length * 13) % 100)))}% context left`,
      };
      updateThreadOrder(thread);
      emitNotification("turn/completed", thread.id, { status: "completed", message: "Turn completed." });
      return;
    }
    emitNotification("turn/cancelled", thread.id, { status: "cancelled", message: "Turn cancelled." });
  }

  function scheduleInterruptedTurnCompletion(record, delayMs = 1400) {
    if (!record || record.cancelRequested === true) return;
    record.cancelRequested = true;
    clearTurnTimers(record);
    record.timers.push(setTimeout(() => {
      const current = mockState.turns.get(record.turnId);
      if (!current) return;
      const thread = getThread(current.threadId);
      if (thread) thread.pendingPrompt = "";
      finalizeTurn(current, "cancelled");
    }, delayMs));
  }

  function startMockTurn(thread, payload) {
    const turnId = nextTurnId();
    const prompt = String(payload?.prompt || "").trim();
    const responseText = buildMockResponseText(payload, prompt);
    const commentaryText = buildMockCommentaryText(payload, prompt);
    const toolSteps = buildMockToolSteps(payload);
    const chunks = buildMockChunks(responseText);
    const chunkDelayMs = 760;
    const streamStartDelayMs = 900;
    const record = {
      turnId,
      threadId: thread.id,
      prompt,
      finalText: responseText,
      cancelRequested: false,
      timers: [],
      historyTurn: {
        id: turnId,
        items: [
          { type: "userMessage", content: [{ type: "text", text: prompt }] },
        ],
      },
    };
    mockState.turns.set(turnId, record);
    thread.runningTurnId = turnId;
    thread.pendingPrompt = prompt;
    thread.assistantDraft = "";
    thread.serviceTier = payload?.serviceTier === "fast" ? "fast" : null;
    thread.collaborationMode = payload?.collaborationMode === "plan" ? "plan" : "default";
    const permission = payload?.sandboxPolicy?.type || payload?.sandbox || "workspaceWrite";
    thread.permissionPreset =
      permission === "dangerFullAccess"
        ? "/permission full-access"
        : permission === "readOnly"
          ? "/permission read-only"
          : "/permission auto";
    updateThreadOrder(thread);
    emitNotification("turn/started", thread.id, { status: "running", message: "Running..." });
    record.timers.push(setTimeout(() => {
      emitNotification("item/updated", thread.id, {
        item: {
          id: `commentary-${turnId}`,
          type: "agent_message",
          phase: "commentary",
          text: commentaryText,
        },
      });
    }, 420));
    pushHistoryItem(record, {
      id: `commentary-${turnId}`,
      type: "agentMessage",
      phase: "commentary",
      text: commentaryText,
    });
    for (const step of toolSteps) {
      record.timers.push(setTimeout(() => {
        emitNotification("item/started", thread.id, { item: clone(step.running) });
        pushHistoryItem(record, step.running);
      }, step.startAt));
      record.timers.push(setTimeout(() => {
        emitNotification("item/completed", thread.id, { item: clone(step.completed) });
        const items = Array.isArray(record.historyTurn?.items) ? record.historyTurn.items : [];
        const itemId = String(step.completed?.id || "").trim();
        const existingIndex = items.findIndex((item) => String(item?.id || "").trim() === itemId);
        if (existingIndex >= 0) items[existingIndex] = clone(step.completed);
        else pushHistoryItem(record, step.completed);
      }, step.completeAt));
    }
    chunks.forEach((chunk, index) => {
      record.timers.push(setTimeout(() => {
        const current = mockState.turns.get(turnId);
        if (!current) return;
        thread.assistantDraft += `${thread.assistantDraft ? " " : ""}${chunk}`;
        emitNotification("turn/assistant/delta", thread.id, { delta: `${index === 0 ? "" : " "}${chunk}` });
      }, streamStartDelayMs + index * chunkDelayMs));
    });
    record.timers.push(setTimeout(() => {
      const current = mockState.turns.get(turnId);
      if (!current) return;
      thread.pendingPrompt = "";
      finalizeTurn(current, "completed");
    }, streamStartDelayMs + chunks.length * chunkDelayMs + 1100));
    return { threadId: thread.id, turnId, path: thread.rolloutPath };
  }

  function ensureMockWs() {
    if (state.ws && state.ws.__webCodexMock === true && state.ws.readyState === 1) return state.ws;
    const ws = {
      __webCodexMock: true,
      readyState: 1,
      send() {},
      close() {
        this.readyState = 3;
      },
    };
    state.ws = ws;
    state.wsSubscribedEvents = true;
    state.wsReconnectAttempt = 0;
    setStatus("Connected to local mock preview.");
    return ws;
  }

  async function api(path, options = {}) {
    initSeedData();
    const method = String(options.method || "GET").trim().toUpperCase();
    const url = String(path || "");
    const query = readQuery(url);
    const historyMatch = url.match(/^\/codex\/threads\/([^/]+)\/history(?:\?|$)/);
    const historyThreadId = historyMatch ? decodeURIComponent(historyMatch[1] || "") : "";
    const skipLiveReadForMockHistory =
      safeModeEnabled && method === "GET" && historyThreadId && isMockOnlyThread(historyThreadId);
    const liveRead = skipLiveReadForMockHistory
      ? null
      : await maybeLiveRead(path, options).catch(() => null);

    if (liveRead && url === "/codex/models") return liveRead;
    if (liveRead && url === "/codex/version-info") return liveRead;
    if (liveRead && url.startsWith("/codex/threads?") && method === "GET") {
      const workspace = normalizeWorkspace(query.get("workspace") || state.workspaceTarget || "windows");
      return mergeSafeThreadList(liveRead, workspace);
    }
    if (liveRead && url.startsWith("/codex/slash/commands?") && method === "GET") return liveRead;
    if (liveRead && url.startsWith("/codex/slash/review/branches?") && method === "GET") return liveRead;
    if (liveRead && url.startsWith("/codex/slash/review/commits?") && method === "GET") return liveRead;
    if (liveRead && url.startsWith("/codex/folders?") && method === "GET") return liveRead;
    if (liveRead && url === "/codex/hosts" && method === "GET") return liveRead;
    if (liveRead && url === "/codex/approvals/pending" && method === "GET") return liveRead;
    if (liveRead && url === "/codex/user-input/pending" && method === "GET") return liveRead;
    if (liveRead && /^\/codex\/threads\/[^/]+\/resume(?:\?|$)/.test(url) && method === "POST") return liveRead;
    if (liveRead && /^\/codex\/threads\/[^/]+\/transport(?:\?|$)/.test(url) && method === "GET") return liveRead;

    if (liveRead && url === "/codex/auth/verify" && method === "POST") {
      return { ...liveRead, mode: "safe" };
    }
    if (url === "/codex/auth/verify" && method === "POST") return { ok: true, mode: "mock" };
    if (url === "/codex/models") {
      return {
        items: [
          {
            id: "gpt-5.5-codex",
            name: "5.5 Codex",
            recommended: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          },
          {
            id: "gpt-5.5-codex-mini",
            name: "5.5 Codex Mini",
            supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }],
          },
          {
            id: "gpt-5.5",
            name: "5.5",
            supportedReasoningEfforts: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          },
        ],
      };
    }
    if (url === "/codex/version-info") {
      return {
        windows: "Codex v0.29.0",
        wsl2: "Codex v0.29.0",
        windowsInstalled: true,
        wsl2Installed: true,
        buildStale: false,
      };
    }
    if (url.startsWith("/codex/threads?") && method === "GET") {
      const workspace = normalizeWorkspace(query.get("workspace") || state.workspaceTarget || "windows");
      return { items: { data: listThreads(workspace), nextCursor: null } };
    }
    if (url === "/codex/threads" && method === "POST") {
      const workspace = normalizeWorkspace(options.body?.workspace || state.workspaceTarget || "windows");
      const thread = seedThread({
        workspace,
        cwd: String(options.body?.cwd || (workspace === "wsl2" ? "/home/yiyou/project" : "C:\\Users\\yiyou\\API-Router")),
        serviceTier: options.body?.serviceTier,
        permissionPreset: state.permissionPresetByWorkspace?.[workspace],
      });
      updateThreadOrder(thread);
      return { id: thread.id, threadId: thread.id, thread: { id: thread.id, path: thread.rolloutPath } };
    }
    if (historyMatch && method === "GET") {
      const threadId = historyThreadId;
      const thread = getThread(threadId);
      if (safeModeEnabled && thread && isMockOnlyThread(threadId)) {
        return historyResponsePayload(thread);
      }
      if (safeModeEnabled && liveRead) {
        if (!thread) return liveRead;
        return mergeSafeHistoryPayload(liveRead, thread);
      }
      if (!thread) throw new Error("Mock thread not found");
      return safeModeEnabled ? historyResponsePayload(thread) : historyPayload(thread);
    }
    const resumeMatch = url.match(/^\/codex\/threads\/([^/]+)\/resume(?:\?|$)/);
    if (resumeMatch && method === "POST") {
      const thread = getThread(decodeURIComponent(resumeMatch[1] || ""));
      if (!thread) throw new Error("Mock thread not found");
      return { threadId: thread.id, id: thread.id, thread: { id: thread.id, path: thread.rolloutPath } };
    }
    const transportMatch = url.match(/^\/codex\/threads\/([^/]+)\/transport(?:\?|$)/);
    if (transportMatch && method === "GET") {
      const thread = getThread(decodeURIComponent(transportMatch[1] || ""));
      if (!thread) throw new Error("Mock thread not found");
      return { ok: true, threadId: thread.id, attached: false, transport: null };
    }
    const managedTerminalMatch = url.match(/^\/codex\/threads\/([^/]+)\/managed-terminal$/);
    if (managedTerminalMatch && method === "POST") {
      const thread = getThread(decodeURIComponent(managedTerminalMatch[1] || ""));
      if (!thread) throw new Error("Mock thread not found");
      return {
        ok: true,
        threadId: thread.id,
        attached: true,
        transport: "terminal-session",
        cwd: thread.cwd,
        path: thread.rolloutPath,
      };
    }
    if (url.startsWith("/codex/slash/commands?") && method === "GET") return buildSlashCatalog(state);
    if (url.startsWith("/codex/slash/review/branches?") && method === "GET") return buildReviewItems("branches");
    if (url.startsWith("/codex/slash/review/commits?") && method === "GET") return buildReviewItems("commits");
    if (url === "/codex/slash/execute" && method === "POST") {
      const command = String(options.body?.command || "").trim().toLowerCase();
      const workspace = normalizeWorkspace(options.body?.workspace || state.activeThreadWorkspace || state.workspaceTarget || "windows");
      if (command === "/fast on" || command === "/fast") {
        return { method: "thread/fastMode/set", result: { enabled: true } };
      }
      if (command === "/fast off") {
        return { method: "thread/fastMode/set", result: { enabled: false } };
      }
      if (command === "/plan on" || command === "/plan") {
        return { method: "thread/collaborationMode/set", result: { mode: "plan" } };
      }
      if (command === "/plan off") {
        return { method: "thread/collaborationMode/set", result: { mode: "default" } };
      }
      if (command.startsWith("/permission ")) {
        const preset = command.replace("/permission ", "").trim();
        const runtime = buildPermissionRuntimeOptions(`/permission ${preset}`);
        return {
          method: "thread/permission/set",
          result: {
            preset,
            approvalPolicy: runtime.approvalPolicy,
            sandbox: runtime.sandbox,
          },
        };
      }
      return { method: "slash/executed", result: { command, workspace } };
    }
    if (url === "/codex/turns/start" && method === "POST") {
      const thread =
        getThread(options.body?.threadId) ||
        ensureShadowThread(options.body?.threadId, {
          workspace: options.body?.workspace,
          cwd: options.body?.cwd,
          serviceTier: options.body?.serviceTier,
        });
      if (!thread) throw new Error("Mock thread not found");
      return startMockTurn(thread, options.body || {});
    }
    const interruptMatch = url.match(/^\/codex\/turns\/([^/]+)\/interrupt$/);
    if (interruptMatch && method === "POST") {
      const turnId = decodeURIComponent(interruptMatch[1] || "");
      const record = mockState.turns.get(turnId);
      if (!record) return { ok: true, interrupted: false };
      scheduleInterruptedTurnCompletion(record);
      return { ok: true, interrupted: true };
    }
    if (url.startsWith("/codex/folders?") && method === "GET") {
      const workspace = normalizeWorkspace(query.get("workspace") || state.workspaceTarget || "windows");
      const cwd = String(query.get("cwd") || "");
      return buildFolderItems(workspace, cwd);
    }
    if (url === "/codex/hosts" && method === "GET") return { items: [] };
    if (url === "/codex/approvals/pending" && method === "GET") return { items: [] };
    if (url === "/codex/user-input/pending" && method === "GET") return { items: [] };
    if (url === "/codex/attachments/upload" && method === "POST") {
      return { ok: true, fileName: options.body?.fileName || "attachment.txt" };
    }
    throw new Error(`Mock transport has no route for ${method} ${url}`);
  }

  function connectWs() {
    ensureMockWs();
  }

  function syncEventSubscription() {
    ensureMockWs();
    return true;
  }

  function wsSend(value) {
    if (value?.type === "events.refresh") return true;
    return !!ensureMockWs();
  }

  function wsCall(type, payload) {
    ensureMockWs();
    if (type === "approval.resolve") return Promise.resolve({ ok: true, id: payload?.id || "mock-approval" });
    if (type === "user_input.resolve") return Promise.resolve({ ok: true, id: payload?.id || "mock-user-input" });
    return Promise.resolve({ ok: true });
  }

  return {
    api,
    connectWs,
    isMockTransport: true,
    syncEventSubscription,
    wsCall,
    wsSend,
  };
}
