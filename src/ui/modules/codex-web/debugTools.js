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
            activeThreadRenderSig: String(state.activeThreadRenderSig || ""),
            messageCount: documentRef.querySelectorAll("#chatBox .msg").length,
          };
        },
        dumpMessages(limit = 8) {
          const max = Math.max(1, Number(limit || 8) | 0);
          const nodes = Array.from(documentRef.querySelectorAll("#chatBox .msg"));
          return nodes
            .slice(Math.max(0, nodes.length - max))
            .map((node, index) =>
              readDebugMessageNode(node, nodes.length - Math.min(max, nodes.length) + index)
            );
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
      };
    } catch {}
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
    installDebugAndE2E,
    installThreadAnimDebug,
    installWebCodexDebug,
  };
}
