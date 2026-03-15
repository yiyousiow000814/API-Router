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
    addChat = () => {},
    renderInlineMessageText,
    findNextInlineCodeSpan,
    normalizeWorkspaceTarget,
    normalizeModelOption,
    ensureArrayItems,
    pickLatestModelId,
    REASONING_EFFORT_KEY,
    MODEL_LOADING_MIN_MS,
    normalizeThreadTokenUsage,
    renderRuntimePanels = () => {},
    renderCommentaryArchive = () => {},
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
    setActivePlan = () => {},
    setActiveCommands = () => {},
    setRuntimeActivity = () => {},
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
    LIVE_INSPECTOR_ENABLED_KEY = "web_codex_live_inspector_enabled_v1",
    localStorageRef,
    documentRef,
    windowRef,
    performanceRef,
  } = deps;
  const storage = localStorageRef ?? globalThis.localStorage ?? { getItem() { return ""; }, setItem() {} };
  const doc = documentRef ?? globalThis.document;
  const win = windowRef ?? globalThis.window ?? {};
  const perf = performanceRef ?? globalThis.performance;

  function getActiveState() {
    return {
      activeThreadId: String(state.activeThreadId || ""),
      activeThreadWorkspace: String(state.activeThreadWorkspace || ""),
      activeThreadRolloutPath: String(state.activeThreadRolloutPath || ""),
      activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
      activeThreadPendingTurnThreadId: String(state.activeThreadPendingTurnThreadId || ""),
      activeThreadPendingTurnRunning: state.activeThreadPendingTurnRunning === true,
      activeThreadPendingUserMessage: String(state.activeThreadPendingUserMessage || ""),
      activeThreadPendingAssistantMessage: String(state.activeThreadPendingAssistantMessage || ""),
      wsSubscribedEvents: !!state.wsSubscribedEvents,
      wsReadyState: Number(state.ws?.readyState ?? -1),
      messageCount: doc?.querySelectorAll?.("#chatBox .msg")?.length || 0,
      statusLine: String(doc?.getElementById?.("statusLine")?.textContent || "").trim(),
    };
  }

  function getLivePipelineSnapshot(limit = 24) {
    const max = Math.max(1, Number(limit || 24) | 0);
    const events = Array.isArray(state.liveDebugEvents) ? state.liveDebugEvents : [];
    const recent = events.slice(Math.max(0, events.length - max));
    const reverse = recent.slice().reverse();
    const pickLast = (predicate) => reverse.find(predicate) || null;
    const isTurnLifecycleEvent = (event) => {
      const kind = String(event?.kind || "");
      if (kind === "turn.start.ack" || kind === "turn.send" || kind === "live.render:turn_terminal") return true;
      if (kind !== "rpc.notification" && kind !== "ui.event") return false;
      const method = String(event?.method || "");
      return /(^|\/)turn\/(started|completed|finished|failed|cancelled)\b/.test(method);
    };
    return {
      active: getActiveState(),
      lastReceived:
        pickLast(
          (event) =>
            event?.kind === "rpc.notification" ||
            event?.kind === "ui.event" ||
            event?.kind === "history.receive" ||
            String(event?.kind || "").startsWith("history.load")
        ) || null,
      lastRender:
        pickLast(
          (event) =>
            String(event?.kind || "").startsWith("live.render:") ||
            String(event?.kind || "").startsWith("history.render:")
        ) || null,
      lastDrop: pickLast((event) => /^(live|ws)\.drop:/.test(String(event?.kind || ""))) || null,
      lastHistory:
        pickLast((event) => String(event?.kind || "").startsWith("history.load")) ||
        pickLast((event) => event?.kind === "history.apply") ||
        null,
      lastTurn:
        pickLast(isTurnLifecycleEvent) ||
        null,
      commentary: {
        currentKey: String(state.activeThreadCommentaryCurrent?.key || ""),
        currentChars: String(state.activeThreadCommentaryCurrent?.text || "").length,
        currentToolCount: Array.isArray(state.activeThreadCommentaryCurrent?.tools)
          ? state.activeThreadCommentaryCurrent.tools.length
          : 0,
        currentTextPreview: String(state.activeThreadCommentaryCurrent?.text || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        liveThinkingPreview: String(state.activeThreadTransientThinkingText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        liveToolPreview: String(state.activeThreadTransientToolText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120),
        archiveCount: Array.isArray(state.activeThreadCommentaryArchive) ? state.activeThreadCommentaryArchive.length : 0,
        archiveVisible: state.activeThreadCommentaryArchiveVisible === true,
        archiveExpanded: state.activeThreadCommentaryArchiveExpanded === true,
        lastItemCandidate:
          pickLast(
            (event) =>
              event?.kind === "live.inspect:item_candidate" || event?.kind === "live.inspect:no_item_candidate"
          ) || null,
        lastAssistantCandidate: pickLast((event) => event?.kind === "live.inspect:assistant_candidate") || null,
        lastState: pickLast((event) => event?.kind === "live.inspect:commentary_state") || null,
      },
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
    if (event.paramsSource) bits.push(`params=${String(event.paramsSource).slice(0, 40)}`);
    if (event.itemSource) bits.push(`source=${String(event.itemSource).slice(0, 40)}`);
    if (event.phase) bits.push(`phase=${String(event.phase).slice(0, 40)}`);
    if (event.itemId) bits.push(`itemId=${String(event.itemId).slice(0, 40)}`);
    if (event.mode) bits.push(`mode=${String(event.mode).slice(0, 20)}`);
    if (typeof event.visible === "boolean") bits.push(`visible=${event.visible ? "yes" : "no"}`);
    if (event.action) bits.push(`action=${String(event.action).slice(0, 30)}`);
    if (typeof event.count === "number") bits.push(`count=${event.count}`);
    if (typeof event.toolCount === "number") bits.push(`tools=${event.toolCount}`);
    if (typeof event.archiveCount === "number") bits.push(`archive=${event.archiveCount}`);
    if (typeof event.chars === "number") bits.push(`chars=${event.chars}`);
    if (event.paramsKeys) bits.push(`paramsKeys=${String(event.paramsKeys).slice(0, 80)}`);
    if (event.itemKeys) bits.push(`itemKeys=${String(event.itemKeys).slice(0, 80)}`);
    if (event.preview) bits.push(`preview=${String(event.preview).replace(/\s+/g, " ").slice(0, 80)}`);
    if (event.gap === true) bits.push("gap=yes");
    if (typeof event.code === "number" && event.code > 0) bits.push(`code=${event.code}`);
    if (typeof event.wasClean === "boolean") bits.push(`clean=${event.wasClean}`);
    if (typeof event.eventId === "number") bits.push(`eventId=${event.eventId}`);
    return bits.join(" | ");
  }

  function installLiveInspector() {
    try {
      const previous = win.__webCodexLiveInspector || null;
      if (previous?.destroy) {
        previous.destroy();
      }
    } catch {}

    let root = null;
    let body = null;
    let timer = 0;
    let backendSnapshot = null;
    let backendInflight = false;
    let collapsed = false;
    let expandedHeight = "";
    let gripDragging = false;
    let gripStartY = 0;
    let gripStartHeight = 0;

    const refreshBackendSnapshot = async () => {
      if (backendInflight) return;
      backendInflight = true;
      try {
        const res = await win.fetch("/codex/debug/live", {
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
      root = doc.createElement("div");
      root.id = "webCodexLiveInspector";
      root.setAttribute("aria-live", "off");
      body = doc.createElement("pre");
      const header = doc.createElement("div");
      const title = doc.createElement("div");
      const actions = doc.createElement("div");
      const collapseBtn = doc.createElement("button");
      const closeBtn = doc.createElement("button");
      const grip = doc.createElement("div");

      Object.assign(root.style, {
        position: "fixed",
        right: "12px",
        bottom: "12px",
        width: "min(420px, calc(100vw - 24px))",
        maxHeight: "calc(100vh - 12px)",
        minWidth: "280px",
        minHeight: "120px",
        overflow: "hidden",
        borderRadius: "12px",
        border: "1px solid rgba(90, 120, 180, 0.45)",
        background: "rgba(7, 11, 18, 0.94)",
        color: "#d7e4ff",
        boxShadow: "0 12px 36px rgba(0,0,0,0.34)",
        backdropFilter: "blur(12px)",
        zIndex: "var(--z-modal, 120)",
        display: "flex",
        flexDirection: "column",
        resize: "none",
        paddingTop: "0",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "11px",
        lineHeight: "1.45",
        boxSizing: "border-box",
      });

      Object.assign(header.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        padding: "10px 12px 8px",
        borderBottom: "1px solid rgba(90, 120, 180, 0.2)",
        flex: "0 0 auto",
      });
      Object.assign(title.style, {
        fontWeight: "700",
        letterSpacing: "0.04em",
        color: "#edf4ff",
      });
      title.textContent = "LIVE PIPELINE";
      Object.assign(actions.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flex: "0 0 auto",
      });
      const buttonStyle = {
        appearance: "none",
        border: "1px solid rgba(120, 154, 218, 0.35)",
        background: "rgba(25, 36, 58, 0.9)",
        color: "#d7e4ff",
        borderRadius: "8px",
        padding: "2px 8px",
        minWidth: "30px",
        cursor: "pointer",
        font: "inherit",
        lineHeight: "1.4",
      };
      Object.assign(collapseBtn.style, buttonStyle);
      Object.assign(closeBtn.style, buttonStyle);
      collapseBtn.textContent = "−";
      closeBtn.textContent = "×";
      collapseBtn.setAttribute("type", "button");
      closeBtn.setAttribute("type", "button");
      root.__webCodexLiveInspectorCollapseBtn = collapseBtn;
      collapseBtn.addEventListener("click", () => {
        collapsed = !collapsed;
        collapseBtn.textContent = collapsed ? "+" : "−";
        if (collapsed) {
          expandedHeight = String(root.style.height || "");
          root.style.height = "";
        } else if (expandedHeight) {
          root.style.height = expandedHeight;
        }
        if (body) body.style.display = collapsed ? "none" : "block";
        root.style.minHeight = collapsed ? "0" : "120px";
      });
      closeBtn.addEventListener("click", () => {
        try {
          storage.setItem(LIVE_INSPECTOR_ENABLED_KEY, "0");
        } catch {}
        win.__webCodexLiveInspector?.destroy?.();
      });
      actions.appendChild(collapseBtn);
      actions.appendChild(closeBtn);
      header.appendChild(title);
      header.appendChild(actions);

      Object.assign(body.style, {
        margin: "0",
        padding: "10px 12px 12px",
        overflowX: "hidden",
        overflowY: "auto",
        flex: "1 1 auto",
        minHeight: "0",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      });
      root.__webCodexLiveInspectorBody = body;
      Object.assign(grip.style, {
        position: "absolute",
        top: "-3px",
        left: "0",
        right: "0",
        height: "6px",
        cursor: "ns-resize",
        background: "transparent",
      });
      root.__webCodexLiveInspectorGrip = grip;
      const stopGripDrag = () => {
        gripDragging = false;
        try {
          win.removeEventListener?.("pointermove", onGripPointerMove);
          win.removeEventListener?.("pointerup", stopGripDrag);
          win.removeEventListener?.("pointercancel", stopGripDrag);
        } catch {}
      };
      const onGripPointerMove = (event) => {
        if (!gripDragging || !root) return;
        const pointerY = Number(event?.clientY ?? gripStartY);
        const delta = gripStartY - pointerY;
        const nextHeight = Math.max(120, Math.round(gripStartHeight + delta));
        root.style.height = `${nextHeight}px`;
      };
      grip.addEventListener("pointerdown", (event) => {
        gripDragging = true;
        gripStartY = Number(event?.clientY ?? 0);
        gripStartHeight =
          Number.parseFloat(String(root?.style?.height || "").replace(/px$/i, "")) ||
          root?.offsetHeight ||
          320;
        try {
          grip.setPointerCapture?.(event.pointerId);
        } catch {}
        win.addEventListener?.("pointermove", onGripPointerMove);
        win.addEventListener?.("pointerup", stopGripDrag);
        win.addEventListener?.("pointercancel", stopGripDrag);
      });
      root.appendChild(header);
      root.appendChild(grip);
      root.appendChild(body);
      doc.body.appendChild(root);
      try {
        win.dispatchEvent?.(
          new CustomEvent("web-codex-live-inspector-changed", {
            detail: { open: true },
          })
        );
      } catch {}
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
        `thread: ${snap.active.activeThreadId || "(none)"}`,
        `workspace: ${snap.active.activeThreadWorkspace || "(none)"}`,
        `rollout: ${snap.active.activeThreadRolloutPath || "(empty)"}`,
        `ws: ${snap.active.wsReadyState} | subscribed: ${snap.active.wsSubscribedEvents ? "yes" : "no"}`,
        `messages: ${snap.active.messageCount} | status: ${snap.active.statusLine || "(empty)"}`,
        `pendingThread: ${snap.active.activeThreadPendingTurnThreadId || "(none)"} | running=${snap.active.activeThreadPendingTurnRunning ? "yes" : "no"}`,
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
      const commentaryLines = [
        "COMMENTARY",
        `current: key=${snap.commentary.currentKey || "(none)"} | chars=${snap.commentary.currentChars} | tools=${snap.commentary.currentToolCount}`,
        `live thinking: ${snap.commentary.liveThinkingPreview || "(empty)"}`,
        `live tool: ${snap.commentary.liveToolPreview || "(empty)"}`,
        `archive: count=${snap.commentary.archiveCount} | visible=${snap.commentary.archiveVisible ? "yes" : "no"} | expanded=${snap.commentary.archiveExpanded ? "yes" : "no"}`,
        `last item candidate: ${formatLiveEventLine(snap.commentary.lastItemCandidate) || "(none)"}`,
        `last assistant candidate: ${formatLiveEventLine(snap.commentary.lastAssistantCandidate) || "(none)"}`,
        `last commentary state: ${formatLiveEventLine(snap.commentary.lastState) || "(none)"}`,
      ];
      const lines = [
        ...summaryLines,
        "",
        ...backendLines,
        "",
        ...clientLines,
        "",
        ...commentaryLines,
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
      if (host.__webCodexLiveInspectorBody) {
        host.__webCodexLiveInspectorBody.textContent = lines.join("\n");
      } else {
        host.textContent = lines.join("\n");
      }
    };

    render();
    refreshBackendSnapshot().catch(() => {});
    timer = win.setInterval(() => {
      render();
      refreshBackendSnapshot().catch(() => {});
    }, 250);
    win.__webCodexLiveInspector = {
      destroy() {
        if (timer) {
          win.clearInterval(timer);
          timer = 0;
        }
        try {
          root?.remove?.();
        } catch {}
        try {
          win.dispatchEvent?.(
            new CustomEvent("web-codex-live-inspector-changed", {
              detail: { open: false },
            })
          );
        } catch {}
      },
      render,
    };
  }

  function installWebCodexDebug() {
    try {
      const isPreviewUpdatedPlanActive = () =>
        String(state.activeThreadPlan?.turnId || "").trim() === "debug-preview-plan";
      const emitPreviewUpdatedPlanChanged = () => {
        try {
          win.dispatchEvent?.(
            new CustomEvent("web-codex-preview-plan-changed", {
              detail: { open: isPreviewUpdatedPlanActive() },
            })
          );
        } catch {}
      };
      const previous = win.__webCodexDebug || {};
      win.__webCodexDebug = {
        ...previous,
        version: WEB_CODEX_DEV_DEBUG_VERSION,
        scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
        loadedAt: new Date().toISOString(),
        getScriptInfo() {
          return {
            version: WEB_CODEX_DEV_DEBUG_VERSION,
            scriptUrl: typeof import.meta !== "undefined" ? String(import.meta.url || "") : "",
            loadedAt: String(win.__webCodexDebug?.loadedAt || ""),
            activeThreadId: String(state.activeThreadId || ""),
            activeThreadWorkspace: String(state.activeThreadWorkspace || ""),
            activeThreadRolloutPath: String(state.activeThreadRolloutPath || ""),
            activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
            messageCount: doc?.querySelectorAll?.("#chatBox .msg")?.length || 0,
          };
        },
        getActiveState,
        getLivePipelineSnapshot,
        dumpMessages(limit = 8) {
          const max = Math.max(1, Number(limit || 8) | 0);
          const nodes = Array.from(doc?.querySelectorAll?.("#chatBox .msg") || []);
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
          const nodes = Array.from(doc?.querySelectorAll?.("#chatBox .msg") || []);
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
          return String(doc?.getElementById?.("chatBox")?.innerHTML || "");
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
              : !doc?.getElementById?.("webCodexLiveInspector");
          if (shouldOpen) installLiveInspector();
          else win.__webCodexLiveInspector?.destroy?.();
          return {
            ok: true,
            open: !!doc?.getElementById?.("webCodexLiveInspector"),
          };
        },
        isPreviewUpdatedPlanActive,
        previewUpdatedPlan(force) {
          const threadId = String(state.activeThreadId || "").trim();
          const shouldOpen =
            typeof force === "boolean" ? force : !isPreviewUpdatedPlanActive();
          setMainTab("chat");
          setMobileTab("chat");
          if (!shouldOpen) {
            setActivePlan(null);
            setRuntimeActivity(null);
            emitPreviewUpdatedPlanChanged();
            return { ok: true, threadId, open: false };
          }
          setActiveCommands([]);
          setActivePlan({
            threadId,
            turnId: "debug-preview-plan",
            title: "Updated Plan",
            explanation: "Preview sample for runtime plan styling.",
            steps: [
              { step: "Trace runtime panel rendering", status: "completed" },
              { step: "Validate Updated Plan card layout", status: "in_progress" },
              { step: "Review spacing and animation", status: "pending" },
            ],
            deltaText: "",
          });
          setRuntimeActivity({
            threadId,
            title: "Updated Plan",
            detail: "Preview sample for runtime plan styling.",
            tone: "running",
          });
          emitPreviewUpdatedPlanChanged();
          return { ok: true, threadId, open: true };
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
        const res = await win.fetch("/codex/debug/live/client", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sessionId,
            page: String(win.location?.pathname || ""),
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

    win.setInterval(() => {
      flush().catch(() => {});
    }, 1500);
    win.addEventListener?.("visibilitychange", () => {
      if (doc?.visibilityState === "hidden") {
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
      const debugLiveEnabled =
        hasQueryFlag(win.location?.search || "", "debuglive") ||
        String(storage.getItem(LIVE_INSPECTOR_ENABLED_KEY) || "").trim() === "1";
      if (debugLiveEnabled) {
        installLiveInspector();
      }
      const params = new URLSearchParams(win.location?.search || "");
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
      if (params.get("e2e") !== "1" || win.__webCodexE2E) return;
      const historyByThreadId = new Map();
      win.__webCodexE2E = {
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
        seedPendingTurn(config = {}) {
          const threadId = String(config.threadId || this._activeThreadId || state.activeThreadId || "").trim();
          const prompt = String(config.prompt || "").trim();
          if (!threadId) return { ok: false, error: "missing threadId" };
          if (!prompt) return { ok: false, error: "missing prompt" };
          this._activeThreadId = threadId;
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(threadId);
          setChatOpening(false);
          state.activeThreadStarted = true;
          state.activeThreadPendingTurnThreadId = threadId;
          state.activeThreadPendingTurnRunning = true;
          state.activeThreadPendingUserMessage = prompt;
          state.activeThreadPendingAssistantMessage = "";
          state.activeThreadTransientToolText = "";
          state.activeThreadTransientThinkingText = "";
          state.activeThreadCommentaryCurrent = null;
          state.activeThreadCommentaryArchive = [];
          state.activeThreadCommentaryArchiveVisible = false;
          state.activeThreadCommentaryArchiveExpanded = false;
          state.activeThreadActivity = null;
          state.activeThreadActiveCommands = [];
          state.activeThreadPlan = null;
          state.activeThreadLiveAssistantThreadId = "";
          state.activeThreadLiveAssistantIndex = -1;
          state.activeThreadLiveAssistantMsgNode = null;
          state.activeThreadLiveAssistantBodyNode = null;
          state.activeThreadLiveAssistantText = "";
          renderCommentaryArchive();
          renderRuntimePanels();
          if (!Array.isArray(state.activeThreadMessages)) state.activeThreadMessages = [];
          const last = state.activeThreadMessages.length
            ? state.activeThreadMessages[state.activeThreadMessages.length - 1]
            : null;
          const alreadyVisible =
            last &&
            last.role === "user" &&
            !String(last.kind || "").trim() &&
            String(last.text || "") === prompt;
          if (!alreadyVisible) {
            addChat("user", prompt, { animate: false });
            state.activeThreadMessages = state.activeThreadMessages.concat([{ role: "user", text: prompt, kind: "" }]);
          }
          scrollToBottomReliable();
          return { ok: true, threadId, prompt };
        },
        seedRuntimePanels(config = {}) {
          const threadId = String(config.threadId || this._activeThreadId || state.activeThreadId || "").trim();
          if (!threadId) return { ok: false, error: "missing threadId" };
          this._activeThreadId = threadId;
          setMainTab("chat");
          setMobileTab("chat");
          setActiveThread(threadId);
          const commands = Array.isArray(config.commands)
            ? config.commands
              .map((item) => (item && typeof item === "object" ? { ...item } : null))
              .filter(Boolean)
              .map((item, index) => ({
                key: String(item.key || `e2e-command-${index + 1}`),
                text: String(item.text || item.label || item.detail || item.title || "Working"),
                state: String(item.state || "running"),
                icon: String(item.icon || "command"),
                title: String(item.title || "Working"),
                detail: String(item.detail || item.label || item.text || ""),
                label: String(item.label || item.detail || item.text || item.title || ""),
                presentation: item.presentation === "code" ? "code" : "text",
                timestamp: Number(item.timestamp || Date.now()),
              }))
            : [];
          const plan = config.plan && typeof config.plan === "object"
            ? {
                threadId,
                turnId: String(config.plan.turnId || "e2e-runtime-plan"),
                title: String(config.plan.title || "Updated Plan"),
                explanation: String(config.plan.explanation || ""),
                steps: Array.isArray(config.plan.steps) ? config.plan.steps.slice() : [],
                deltaText: String(config.plan.deltaText || ""),
              }
            : null;
          state.activeThreadActiveCommands = commands;
          state.activeThreadPlan = plan;
          if (plan) {
            state.activeThreadActivity = {
              threadId,
              title: String(plan.title || "Updated Plan"),
              detail: String(plan.explanation || ""),
              tone: "running",
            };
          } else if (commands.length) {
            const last = commands[commands.length - 1];
            state.activeThreadActivity = {
              threadId,
              title: String(last.title || "Working"),
              detail: String(last.detail || ""),
              tone: String(last.state || "running"),
            };
          } else {
            state.activeThreadActivity = null;
          }
          renderRuntimePanels();
          return { ok: true, threadId, commandCount: commands.length, hasPlan: !!plan };
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
