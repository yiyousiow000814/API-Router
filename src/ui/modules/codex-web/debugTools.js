export function readDebugMessageNode(node, index) {
  const body = node?.querySelector?.(".msgBody") || null;
  const inline = body
    ? Array.from(body.querySelectorAll("code.msgInlineCode")).map((n) =>
        String(n.textContent || "").trim()
      )
    : [];
  const pseudo = body
    ? Array.from(body.querySelectorAll(".msgPseudoLink")).map((n) =>
        String(n.textContent || "").trim()
      )
    : [];
  const links = body
    ? Array.from(body.querySelectorAll("a.msgLink")).map((n) => ({
        text: String(n.textContent || "").trim(),
        href: String(n.getAttribute("href") || "").trim(),
      }))
    : [];
  return {
    index,
    className: String(node?.className || ""),
    role: String(node?.__webCodexRole || ""),
    kind: String(node?.__webCodexKind || ""),
    source: String(node?.__webCodexSource || ""),
    rawText: typeof node?.__webCodexRawText === "string" ? node.__webCodexRawText : "",
    headText: String(node?.querySelector?.(".msgHead")?.textContent || "").trim(),
    bodyText: String(body?.textContent || ""),
    bodyHtml: String(body?.innerHTML || ""),
    inline,
    pseudo,
    links,
  };
}

export function hasQueryFlag(search, key, expected = "1") {
  const params = new URLSearchParams(String(search || ""));
  return params.get(key) === expected;
}

export function collectPendingLiveTraceEvents(state, limit = 40) {
  const events = Array.isArray(state?.liveDebugEvents) ? state.liveDebugEvents : [];
  const max = Math.max(1, Number(limit || 40) | 0);
  return events.filter((event) => event && event.__traceUploaded !== true).slice(0, max);
}

export function createDebugToolsModule(deps) {
  const {
    state,
    byId,
    renderInlineMessageText,
    findNextInlineCodeSpan,
    normalizeWorkspaceTarget,
    normalizeModelOption,
    ensureArrayItems,
    pickLatestModelId,
    REASONING_EFFORT_KEY,
    MODEL_LOADING_MIN_MS,
    normalizeThreadTokenUsage,
    renderComposerContextLeft,
    clearChatMessages,
    showWelcomeCard,
    updateHeaderUi,
    getWorkspaceTarget,
    parseUserMessageParts,
    renderMessageAttachments,
    setMainTab,
    setMobileTab,
    setActiveThread,
    setChatOpening,
    loadThreadMessages,
    refreshThreads,
    handleWsPayload,
    scrollChatToBottom,
    scrollToBottomReliable,
    createAssistantStreamingMessage,
    appendStreamingDelta,
    setStatus,
    isThreadAnimDebugEnabled,
    pushThreadAnimDebug,
    threadAnimDebug,
    WEB_CODEX_DEV_DEBUG_VERSION,
    documentRef = document,
    windowRef = window,
    performanceRef = performance,
  } = deps;

  function getActiveState() {
    return {
      activeThreadId: String(state.activeThreadId || ""),
      activeThreadWorkspace: String(state.activeThreadWorkspace || ""),
      activeThreadRolloutPath: String(state.activeThreadRolloutPath || ""),
      activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
      activeThreadPendingTurnThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      activeThreadPendingUserMessage: String(state.activeThreadPendingUserMessage || ""),
      activeThreadPendingAssistantMessage: String(state.activeThreadPendingAssistantMessage || ""),
      wsSubscribedEvents: !!state.wsSubscribedEvents,
      wsReadyState: Number(state.ws?.readyState ?? -1),
      messageCount: documentRef.querySelectorAll("#chatBox .msg").length,
      statusLine: String(documentRef.getElementById("statusLine")?.textContent || "").trim(),
    };
  }

  function getLivePipelineSnapshot(limit = 24) {
    const max = Math.max(1, Number(limit || 24) | 0);
    const events = Array.isArray(state.liveDebugEvents) ? state.liveDebugEvents : [];
    const recent = events.slice(Math.max(0, events.length - max));
    const reverse = recent.slice().reverse();
    const pickLast = (predicate) => reverse.find(predicate) || null;
    return {
      active: getActiveState(),
      lastReceived:
        pickLast((event) => event?.kind === "rpc.notification" || event?.kind === "ui.event") || null,
      lastRender: pickLast((event) => String(event?.kind || "").startsWith("live.render:")) || null,
      lastDrop: pickLast((event) => /^(live|ws)\.drop:/.test(String(event?.kind || ""))) || null,
      lastHistory:
        pickLast((event) => String(event?.kind || "").startsWith("history.load")) ||
        pickLast((event) => event?.kind === "history.apply") ||
        null,
      lastTurn:
        pickLast((event) => event?.kind === "turn.start.ack") ||
        pickLast((event) => event?.kind === "turn.send") ||
        null,
      recent,
    };
  }

  function formatLiveEventLine(event) {
    if (!event || typeof event !== "object") return "";
    const time = new Date(Number(event.at || Date.now())).toLocaleTimeString("en-GB", {
      hour12: false,
    });
    const bits = [time, String(event.kind || "")];
    if (typeof event.clientId === "number") bits.push(`client=${event.clientId}`);
    if (event.method) bits.push(`method=${event.method}`);
    if (event.threadId) bits.push(`thread=${event.threadId}`);
    if (event.activeThreadId) bits.push(`active=${event.activeThreadId}`);
    if (event.reason) bits.push(`reason=${String(event.reason).slice(0, 80)}`);
    if (event.message) bits.push(`msg=${String(event.message).slice(0, 80)}`);
    if (event.itemType) bits.push(`item=${event.itemType}`);
    if (typeof event.count === "number") bits.push(`count=${event.count}`);
    if (event.gap === true) bits.push("gap=yes");
    if (typeof event.code === "number" && event.code > 0) bits.push(`code=${event.code}`);
    if (typeof event.wasClean === "boolean") bits.push(`clean=${event.wasClean}`);
    if (typeof event.eventId === "number") bits.push(`eventId=${event.eventId}`);
    return bits.join(" | ");
  }

  function installLiveInspector() {
    try {
      const previous = windowRef.__webCodexLiveInspector || null;
      if (previous?.destroy) {
        previous.destroy();
      }
    } catch {}

    let root = null;
    let timer = 0;
    let backendSnapshot = null;
    let backendInflight = false;

    const refreshBackendSnapshot = async () => {
      if (backendInflight) return;
      backendInflight = true;
      try {
        const res = await windowRef.fetch("/codex/debug/live", {
          credentials: "same-origin",
        });
        if (!res.ok) {
          backendSnapshot = {
            error: `HTTP ${res.status}`,
          };
          return;
        }
        backendSnapshot = await res.json().catch(() => ({ error: "invalid json" }));
      } catch (error) {
        backendSnapshot = {
          error: String(error?.message || error || ""),
        };
      } finally {
        backendInflight = false;
      }
    };

    const ensureRoot = () => {
      if (root?.isConnected) return root;
      root = documentRef.createElement("div");
      root.id = "webCodexLiveInspector";
      root.setAttribute("aria-live", "off");
      Object.assign(root.style, {
        position: "fixed",
        right: "12px",
        bottom: "12px",
        width: "min(520px, calc(100vw - 24px))",
        maxHeight: "min(58vh, 560px)",
        overflow: "hidden",
        borderRadius: "12px",
        border: "1px solid rgba(90, 120, 180, 0.45)",
        background: "rgba(7, 11, 18, 0.94)",
        color: "#d7e4ff",
        boxShadow: "0 12px 36px rgba(0,0,0,0.34)",
        backdropFilter: "blur(12px)",
        zIndex: "var(--z-modal, 120)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "11px",
        lineHeight: "1.45",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      });
      documentRef.body.appendChild(root);
      return root;
    };

    const render = () => {
      const host = ensureRoot();
      const snap = getLivePipelineSnapshot(18);
      const backendState =
        backendSnapshot && typeof backendSnapshot === "object" && backendSnapshot.backend
          ? backendSnapshot.backend
          : backendSnapshot;
      const appState =
        backendSnapshot && typeof backendSnapshot === "object" ? backendSnapshot.app : null;
      const appHomes = Array.isArray(appState?.homes) ? appState.homes : [];
      const appRecent = Array.isArray(appState?.recent) ? appState.recent : [];
      const summaryLines = [
        "LIVE PIPELINE",
        `thread: ${snap.active.activeThreadId || "(none)"}`,
        `workspace: ${snap.active.activeThreadWorkspace || "(none)"}`,
        `rollout: ${snap.active.activeThreadRolloutPath || "(empty)"}`,
        `ws: ${snap.active.wsReadyState} | subscribed: ${snap.active.wsSubscribedEvents ? "yes" : "no"}`,
        `messages: ${snap.active.messageCount} | status: ${snap.active.statusLine || "(empty)"}`,
        `pendingThread: ${snap.active.activeThreadPendingTurnThreadId || "(none)"}`,
      ];
      const backendLines = [
        "BACKEND",
        backendSnapshot?.error
          ? `state: error:${backendSnapshot.error}`
          : `connections: active=${backendState?.connections?.active ?? "(n/a)"} | subscribed=${backendState?.connections?.subscribed ?? "(n/a)"} | total=${backendState?.connections?.total ?? "(n/a)"}`,
        `trace file: ${String(backendSnapshot?.traceFile || "(unknown)")}`,
        `last backend event: ${formatLiveEventLine(Array.isArray(backendState?.recent) ? backendState.recent[backendState.recent.length - 1] : null) || "(none)"}`,
        `app homes: ${appHomes.length || 0}`,
        `last app event: ${formatLiveEventLine(appRecent[appRecent.length - 1]) || "(none)"}`,
      ];
      const clientLines = [
        "CLIENT",
        `trace uploaded: ${Number(state.liveTraceUploadedCount || 0)}`,
        `last received: ${formatLiveEventLine(snap.lastReceived) || "(none)"}`,
        `last render: ${formatLiveEventLine(snap.lastRender) || "(none)"}`,
        `last drop: ${formatLiveEventLine(snap.lastDrop) || "(none)"}`,
        `last history: ${formatLiveEventLine(snap.lastHistory) || "(none)"}`,
        `last turn: ${formatLiveEventLine(snap.lastTurn) || "(none)"}`,
      ];
      const lines = [
        ...summaryLines,
        "",
        ...backendLines,
        "",
        ...clientLines,
        "",
        "APP HOMES",
        ...appHomes.slice(-3).map((home) => {
          const name = String(home?.home || "").trim() || "(default)";
          return `${name}\n  queue=${home?.queueLen ?? "(n/a)"} | next=${home?.nextEventId ?? "(n/a)"} | first=${home?.firstEventId ?? "(none)"} | last=${home?.lastEventId ?? "(none)"}\n  method=${home?.lastMethod || "(none)"} | thread=${home?.lastThreadId || "(none)"}`;
        }),
        "",
        "RECENT EVENTS",
        ...(Array.isArray(backendState?.recent)
          ? backendState.recent.slice(-3).map((event) => `BE  ${formatLiveEventLine(event)}`)
          : []),
        ...appRecent.slice(-4).map((event) => `APP ${formatLiveEventLine(event)}`),
        ...snap.recent.slice(-10).map((event) => `UI  ${formatLiveEventLine(event)}`),
      ];
      host.textContent = lines.join("\n");
    };

    render();
    refreshBackendSnapshot().catch(() => {});
    timer = windowRef.setInterval(() => {
      render();
      refreshBackendSnapshot().catch(() => {});
    }, 250);
    windowRef.__webCodexLiveInspector = {
      destroy() {
        if (timer) {
          windowRef.clearInterval(timer);
          timer = 0;
        }
        try {
          root?.remove?.();
        } catch {}
      },
      render,
    };
  }

  function installWebCodexDebug() {
    try {
      const previous = windowRef.__webCodexDebug || {};
      windowRef.__webCodexDebug = {
        ...previous,
        version: WEB_CODEX_DEV_DEBUG_VERSION,
        scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
        loadedAt: new Date().toISOString(),
        getScriptInfo() {
          return {
            version: WEB_CODEX_DEV_DEBUG_VERSION,
            scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
            loadedAt: String(windowRef.__webCodexDebug?.loadedAt || ""),
            activeThreadId: String(state.activeThreadId || ""),
            activeThreadWorkspace: String(state.activeThreadWorkspace || ""),
            activeThreadRolloutPath: String(state.activeThreadRolloutPath || ""),
            activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
            messageCount: documentRef.querySelectorAll("#chatBox .msg").length,
          };
        },
        getActiveState,
        getLivePipelineSnapshot,
        dumpMessages(limit = 8) {
          const max = Math.max(1, Number(limit || 8) | 0);
          const nodes = Array.from(documentRef.querySelectorAll("#chatBox .msg"));
          return nodes
            .slice(Math.max(0, nodes.length - max))
            .map((node, index) =>
              readDebugMessageNode(node, nodes.length - Math.min(max, nodes.length) + index)
            );
        },
        getRecentLiveEvents(limit = 40) {
          const max = Math.max(1, Number(limit || 40) | 0);
          const events = Array.isArray(state.liveDebugEvents) ? state.liveDebugEvents : [];
          return events.slice(Math.max(0, events.length - max));
        },
        findMessage(needle) {
          const query = String(needle || "");
          const nodes = Array.from(documentRef.querySelectorAll("#chatBox .msg"));
          for (let i = 0; i < nodes.length; i += 1) {
            const info = readDebugMessageNode(nodes[i], i);
            if (
              !query ||
              info.rawText.includes(query) ||
              info.bodyText.includes(query) ||
              info.bodyHtml.includes(query)
            ) {
              return info;
            }
          }
          return null;
        },
        getChatHtml() {
          return String(documentRef.getElementById("chatBox")?.innerHTML || "");
        },
        renderInlineText(text) {
          return renderInlineMessageText(String(text || ""));
        },
        scanInlineText(text) {
          const source = String(text || "");
          const spans = [];
          let cursor = 0;
          while (cursor < source.length) {
            const span = findNextInlineCodeSpan(source, cursor);
            if (!span) break;
            spans.push({
              kind: "code",
              start: span.start,
              end: span.end,
              fenceLen: span.fenceLen || 0,
              content: typeof span.content === "string" ? span.content : "",
              raw: source.slice(span.start, span.end),
            });
            cursor = span.end;
          }
          return spans;
        },
        toggleLiveInspector(force) {
          const shouldOpen =
            typeof force === "boolean"
              ? force
              : !documentRef.getElementById("webCodexLiveInspector");
          if (shouldOpen) installLiveInspector();
          else windowRef.__webCodexLiveInspector?.destroy?.();
          return {
            ok: true,
            open: !!documentRef.getElementById("webCodexLiveInspector"),
          };
        },
      };
    } catch {}
  }

  function installLiveTraceBackgroundSync() {
    try {
      if (windowRef.__webCodexLiveTraceSyncInstalled) return;
      windowRef.__webCodexLiveTraceSyncInstalled = true;
    } catch {}

    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const flush = async () => {
      if (state.liveTraceSyncInFlight) return;
      const batch = collectPendingLiveTraceEvents(state, 40);
      if (!batch.length) return;
      state.liveTraceSyncInFlight = true;
      try {
        const res = await windowRef.fetch("/codex/debug/live/client", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            page: String(windowRef.location?.pathname || ""),
            events: batch.map((event) => {
              const copy = { ...event };
              delete copy.__traceUploaded;
              return copy;
            }),
          }),
        });
        if (!res.ok) return;
        for (const event of batch) event.__traceUploaded = true;
        state.liveTraceUploadedCount = (Number(state.liveTraceUploadedCount || 0) + batch.length) | 0;
      } catch {
      } finally {
        state.liveTraceSyncInFlight = false;
      }
    };

    windowRef.setInterval(() => {
      flush().catch(() => {});
    }, 1500);
    windowRef.addEventListener("visibilitychange", () => {
      if (documentRef.visibilityState === "hidden") {
        flush().catch(() => {});
      }
    });
  }

  function installThreadAnimDebug() {
    if (!isThreadAnimDebugEnabled()) return;
    const list = byId("threadList");
    if (!list || list.__threadAnimDebugInstalled) return;
    list.__threadAnimDebugInstalled = true;
    const recordAnimationEvent = (eventType) => (event) => {
      const target = event?.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.classList.contains("groupCard")) return;
      pushThreadAnimDebug(`animation:${eventType}`, {
        groupKey: target.getAttribute("data-group-key") || "",
        className: target.className,
        animationName: String(event?.animationName || ""),
        elapsedTime: Number(event?.elapsedTime || 0),
      });
    };
    list.addEventListener("animationstart", recordAnimationEvent("start"));
    list.addEventListener("animationcancel", recordAnimationEvent("cancel"));
    list.addEventListener("animationend", recordAnimationEvent("end"));
  }

  function installDebugAndE2E() {
    try {
      installWebCodexDebug();
      installLiveTraceBackgroundSync();
      if (hasQueryFlag(windowRef.location.search, "debuglive")) {
        installLiveInspector();
      }
      const params = new URLSearchParams(windowRef.location.search);
      if (params.get("animdebug") === "1") {
        threadAnimDebug.enabled = true;
        installThreadAnimDebug();
        pushThreadAnimDebug("debug:enabled");
        windowRef.__webCodexAnimDebug = {
          getEvents() {
            return threadAnimDebug.events.slice();
          },
          clear() {
            threadAnimDebug.events = [];
            threadAnimDebug.seq = 0;
            return { ok: true };
          },
        };
      }
      if (params.get("e2e") !== "1" || windowRef.__webCodexE2E) return;
      const historyByThreadId = new Map();
      windowRef.__webCodexE2E = {
        _activeThreadId: "",
        setModelLoading(loading = true) {
          state.modelOptionsLoading = !!loading;
          if (loading) state.modelOptions = [];
          deps.setHeaderModelMenuOpen(false);
          updateHeaderUi();
          return { ok: true, loading: state.modelOptionsLoading };
        },
        setModels(items) {
          state.modelOptions = ensureArrayItems(items).map(normalizeModelOption).filter(Boolean);
          state.modelOptionsLoading = false;
          const options = Array.isArray(state.modelOptions) ? state.modelOptions : [];
          state.selectedModel =
            pickLatestModelId(options) ||
            options.find((x) => x && x.isDefault)?.id ||
            options[0]?.id ||
            "";
          if (state.selectedModel) {
            const active = options.find((x) => x && x.id === state.selectedModel) || options[0] || null;
            const supported = Array.isArray(active?.supportedReasoningEfforts)
              ? active.supportedReasoningEfforts
              : [];
            const persisted = String(localStorage.getItem(REASONING_EFFORT_KEY) || "").trim();
            if (supported.length) {
              const ok = persisted && supported.some((x) => x && x.effort === persisted);
              const hasMedium = supported.some(
                (x) => String(x?.effort || "").trim() === "medium"
              );
              const next = ok
                ? persisted
                : hasMedium
                  ? "medium"
                  : String(active.defaultReasoningEffort || supported[0]?.effort || "").trim();
              state.selectedReasoningEffort = next;
              if (next) localStorage.setItem(REASONING_EFFORT_KEY, next);
            } else {
              state.selectedReasoningEffort = persisted;
            }
          }
          deps.renderHeaderModelMenu();
          updateHeaderUi();
          return { ok: true, count: state.modelOptions.length };
        },
        loadModelsWithMinLoadingMs(items, minLoadingMs = MODEL_LOADING_MIN_MS) {
          const minMs = Math.max(0, Number(minLoadingMs || 0));
          const seq = Number(state.modelOptionsLoadingSeq || 0) + 1;
          state.modelOptionsLoadingSeq = seq;
          state.modelOptionsLoadingStartedAt = performanceRef.now();
          state.modelOptionsLoading = true;
          state.modelOptions = [];
          deps.setHeaderModelMenuOpen(false);
          updateHeaderUi();
          this.setModels(items);
          const elapsed = performanceRef.now() - Number(state.modelOptionsLoadingStartedAt || 0);
          const remaining = Math.max(0, minMs - elapsed);
          setTimeout(() => {
            if (state.modelOptionsLoadingSeq !== seq) return;
            state.modelOptionsLoading = false;
            updateHeaderUi();
          }, remaining);
          return { ok: true, remainingMs: Math.round(remaining) };
        },
        seedThreads(count = 260) {
          const items = [];
          for (let i = 0; i < count; i += 1) {
            items.push({
              id: `thread-${i}`,
              title: `Thread ${i}`,
              updatedAt: Date.now() - i * 1000,
            });
          }
          state.threadItemsAll = items;
          state.threadItems = items;
          return { ok: true, count: items.length };
        },
        seedHistory(threadId, turnsN = 20, itemsPerTurn = 2, textSize = 20) {
          const id = String(threadId || "").trim() || "e2e";
          const mk = (prefix, ti, ii) => `${prefix} ${ti}.${ii} ${"x".repeat(textSize)}`;
          const turns = [];
          for (let ti = 0; ti < turnsN; ti += 1) {
            const items = [{ type: "userMessage", content: [{ type: "text", text: mk("User", ti, 0) }] }];
            for (let ii = 1; ii < itemsPerTurn; ii += 1) {
              items.push({ type: "assistantMessage", text: mk("Assistant", ti, ii) });
            }
            turns.push({ id: `t_${ti}`, items });
          }
          historyByThreadId.set(id, { id, modelName: "gpt-5.3-codex", turns });
          return { ok: true, turns: turnsN, itemsPerTurn, textSize };
        },
        getThreadHistory(threadId) {
          return historyByThreadId.get(String(threadId || ""));
        },
        setThreadHistory(threadId, thread) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          const next = thread && typeof thread === "object" ? { ...thread, id } : { id, turns: [] };
          historyByThreadId.set(id, next);
          return { ok: true, threadId: id };
        },
        getComposerContextLeft() {
          const node = documentRef.getElementById("mobileContextLeft");
          if (!node) return { text: "", top: 0, left: 0, width: 0, height: 0 };
          const rect = node.getBoundingClientRect();
          return {
            text: String(node.getAttribute("aria-label") || node.textContent || "").trim(),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        },
        setComposerTokenUsage(tokenUsage) {
          state.activeThreadTokenUsage = normalizeThreadTokenUsage(tokenUsage);
          renderComposerContextLeft();
          return this.getComposerContextLeft();
        },
        resetComposerToNewChat() {
          setChatOpening(false);
          setActiveThread("");
          state.activeThreadStarted = false;
          state.activeThreadWorkspace = getWorkspaceTarget();
          state.activeThreadTokenUsage = null;
          renderComposerContextLeft();
          clearChatMessages();
          showWelcomeCard();
          updateHeaderUi();
          return this.getComposerContextLeft();
        },
        parseUserContentParts(content) {
          const item = { content: Array.isArray(content) ? content : [] };
          const parsed = parseUserMessageParts(item);
          return { ok: true, text: parsed.text || "", images: parsed.images || [] };
        },
        renderAttachmentsHtml(images) {
          return {
            ok: true,
            html: String(renderMessageAttachments(Array.isArray(images) ? images : []) || ""),
          };
        },
        async openThread(threadId) {
          const id = String(threadId || "").trim();
          if (!id) return { ok: false, error: "missing threadId" };
          this._activeThreadId = id;
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(id);
          state.activeThreadNeedsResume = true;
          setChatOpening(false);
          await loadThreadMessages(id, {
            animateBadge: true,
            forceRender: true,
            stickToBottom: true,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
          });
          return { ok: true };
        },
        async refreshActiveThread() {
          const id = String(state.activeThreadId || this._activeThreadId || "").trim();
          if (!id) return { ok: false, error: "missing active thread" };
          await loadThreadMessages(id, {
            animateBadge: false,
            forceRender: true,
            workspace: state.activeThreadWorkspace,
            rolloutPath: state.activeThreadRolloutPath,
          });
          return { ok: true, threadId: id };
        },
        installMockTurnStream(config = {}) {
          const threadId = String(config.threadId || this._activeThreadId || state.activeThreadId || "").trim();
          if (!threadId) return { ok: false, error: "missing threadId" };
          const chunks = Array.isArray(config.chunks) && config.chunks.length
            ? config.chunks.map((item) => String(item || ""))
            : ["live", " reply"];
          const finalText = String(config.finalText || chunks.join("")).trim() || "live reply";
          const delayMs = Math.max(0, Number(config.delayMs || 40) || 40);
          const completedResult =
            config.completedResult && typeof config.completedResult === "object"
              ? { ...config.completedResult }
              : { threadId, output_text: finalText };
          const notifications = Array.isArray(config.notifications) ? config.notifications.slice() : [];
          state.ws = {
            readyState: 1,
            send(raw) {
              let payload = null;
              try {
                payload = JSON.parse(String(raw || ""));
              } catch {
                return;
              }
              if (payload?.type !== "turn.stream") return;
              const reqId = String(payload?.reqId || "");
              if (!reqId) return;
              const emit = (evt) => {
                const handler = state.wsReqHandlers.get(reqId);
                if (typeof handler === "function") handler(evt);
              };
              chunks.forEach((chunk, index) => {
                setTimeout(() => {
                  emit({
                    type: "delta",
                    payload: {
                      threadId,
                      text: String(chunk || ""),
                    },
                  });
                }, delayMs * (index + 1));
              });
              setTimeout(() => {
                emit({
                  type: "completed",
                  payload: {
                    result: completedResult,
                  },
                });
              }, delayMs * (chunks.length + 2));
              notifications.forEach((notification, index) => {
                setTimeout(() => {
                  handleWsPayload({
                    type: "rpc.notification",
                    payload: notification,
                  });
                }, delayMs * (chunks.length + 3 + index));
              });
            },
            close() {
              this.readyState = 3;
            },
          };
          return { ok: true, threadId, chunks, finalText, delayMs };
        },
        emitWsPayload(payload) {
          handleWsPayload(payload);
          return { ok: true };
        },
        scrollChatToBottomNow() {
          state.chatShouldStickToBottom = true;
          state.chatUserScrolledAwayAt = 0;
          scrollChatToBottom({ force: true });
          scrollToBottomReliable();
          return { ok: true };
        },
        createStreamingMessage() {
          const created = createAssistantStreamingMessage();
          const msg = created?.msg;
          const body = created?.body;
          const box = byId("chatBox");
          if (!msg || !body || !box) return { ok: false };
          box.appendChild(msg);
          return { ok: true };
        },
        appendStreamingDelta(text) {
          const box = byId("chatBox");
          const body = box?.querySelector?.(".msg.assistant:last-of-type .msgBody") || null;
          if (!body) return { ok: false, error: "missing streaming body" };
          appendStreamingDelta(body, String(text || ""));
          return { ok: true };
        },
        async setWorkspaceTarget(target = "windows") {
          await deps.setWorkspaceTarget(target);
          return { ok: true, target: normalizeWorkspaceTarget(target) };
        },
        setMobileTabForE2E(tab = "chat") {
          setMobileTab(String(tab || "chat"));
          return { ok: true, tab: String(tab || "chat") };
        },
        async refreshThreadsWithMock(target = "windows", items = []) {
          const workspace = normalizeWorkspaceTarget(String(target || "windows"));
          const origFetch = windowRef.fetch;
          windowRef.fetch = async (input, init) => {
            const url = typeof input === "string" ? input : input?.url || "";
            if (typeof url === "string" && url.startsWith("/codex/threads")) {
              const body = JSON.stringify({
                items: { data: Array.isArray(items) ? items : [], nextCursor: null },
              });
              return new Response(body, {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return origFetch(input, init);
          };
          try {
            await refreshThreads(workspace, { force: true });
            return { ok: true };
          } finally {
            windowRef.fetch = origFetch;
          }
        },
      };
      setStatus("E2E mode enabled.", true);
    } catch {}
  }

  return {
    collectPendingLiveTraceEvents,
    installDebugAndE2E,
    installLiveTraceBackgroundSync,
    installThreadAnimDebug,
    installWebCodexDebug,
  };
}
