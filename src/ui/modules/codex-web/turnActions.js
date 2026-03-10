export function buildTurnPayload({
  activeThreadId,
  prompt,
  startCwd,
  shouldSendStartCwd,
  selectedModel,
  selectedReasoningEffort,
}) {
  return {
    threadId: activeThreadId || null,
    prompt,
    cwd: shouldSendStartCwd ? startCwd || undefined : undefined,
    model: selectedModel || undefined,
    reasoningEffort: selectedReasoningEffort || undefined,
    collaborationMode: "default",
  };
}

export function createTurnActionsModule(deps) {
  const {
    state,
    byId,
    api,
    wsSend,
    wsCall,
    nextReqId,
    connectWs,
    getPromptValue,
    getWorkspaceTarget,
    getStartCwdForWorkspace,
    waitPendingThreadResume,
    updateHeaderUi,
    addChat,
    clearChatMessages,
    hideWelcomeCard,
    showWelcomeCard,
    clearPromptValue,
    renderComposerContextLeft,
    scrollToBottomReliable,
    scheduleChatLiveFollow,
    createAssistantStreamingMessage,
    appendStreamingDelta,
    finalizeAssistantMessage,
    normalizeTextPayload,
    maybeNotifyTurnDone,
    renderAttachmentPills,
    refreshThreads,
    refreshHosts,
    refreshPending,
    setStatus,
    setActiveThread,
    setMainTab,
    setMobileTab,
    setChatOpening,
    blockInSandbox,
    TextDecoderRef = TextDecoder,
  } = deps;

  async function addHost() {
    if (blockInSandbox("host changes")) return;
    const name = byId("hostNameInput").value.trim();
    const baseUrl = byId("hostUrlInput").value.trim();
    if (!name || !baseUrl) throw new Error("host name and base URL are required");
    await api("/codex/hosts", { method: "POST", body: { name, baseUrl, tokenHint: "" } });
    byId("hostNameInput").value = "";
    byId("hostUrlInput").value = "";
    await refreshHosts();
  }

  async function newThread() {
    if (blockInSandbox("new thread")) return;
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    setChatOpening(false);
    setActiveThread("");
    state.activeThreadStarted = false;
    state.activeThreadWorkspace = workspace;
    state.activeThreadTokenUsage = null;
    renderComposerContextLeft();
    clearChatMessages();
    showWelcomeCard();
    updateHeaderUi();

    const data = await api("/codex/threads", {
      method: "POST",
      body: {
        workspace,
        cwd: startCwd || undefined,
      },
    });
    const id = data.id || data.threadId || data?.thread?.id || "";
    if (id) {
      setActiveThread(id);
      state.activeThreadStarted = false;
      state.activeThreadWorkspace = workspace;
      state.activeThreadTokenUsage = null;
      renderComposerContextLeft();
      clearChatMessages();
      showWelcomeCard();
      updateHeaderUi();
    }
    await refreshThreads();
    setMainTab("chat");
  }

  async function sendTurn() {
    if (blockInSandbox("send turn")) return;
    const prompt = getPromptValue();
    if (!prompt) return;
    const workspace = getWorkspaceTarget();
    const startCwd = getStartCwdForWorkspace(workspace);
    const shouldSendStartCwd = !String(state.activeThreadId || "").trim();
    await waitPendingThreadResume(state.activeThreadId);
    const payload = buildTurnPayload({
      activeThreadId: state.activeThreadId,
      prompt,
      startCwd,
      shouldSendStartCwd,
      selectedModel: state.selectedModel,
      selectedReasoningEffort: state.selectedReasoningEffort,
    });
    const shouldAnimateWorkspaceBadge = !state.activeThreadStarted;
    state.activeThreadStarted = true;
    state.activeThreadWorkspace = workspace;
    updateHeaderUi(shouldAnimateWorkspaceBadge);
    addChat("user", prompt);
    state.chatShouldStickToBottom = true;
    scrollToBottomReliable();
    setMainTab("chat");
    clearPromptValue();
    connectWs();

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      const reqId = nextReqId();
      let text = "";
      hideWelcomeCard();
      const { msg, body } = createAssistantStreamingMessage();
      if (!body) return;
      byId("chatBox").appendChild(msg);
      scheduleChatLiveFollow(900);
      await new Promise((resolve) => {
        state.wsReqHandlers.set(reqId, (evt) => {
          const type = evt.type;
          const data = evt.payload || {};
          if (type === "delta") {
            if (typeof data.text === "string" && data.text) {
              const chunk = (text ? " " : "") + data.text;
              text += chunk;
              appendStreamingDelta(body, chunk);
            }
            scheduleChatLiveFollow(700);
            if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
          } else if (type === "completed") {
            const result = data.result || {};
            const threadId =
              result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
            if (threadId) setActiveThread(threadId);
            if (!text.trim()) text = normalizeTextPayload(result);
            finalizeAssistantMessage(msg, body, text);
            scheduleChatLiveFollow(800);
            maybeNotifyTurnDone(text || "");
            state.wsReqHandlers.delete(reqId);
            resolve();
          } else if (type === "error") {
            setStatus(evt.message || "WS stream error.", true);
            finalizeAssistantMessage(msg, body, text);
            scheduleChatLiveFollow(800);
            state.wsReqHandlers.delete(reqId);
            resolve();
          }
        });
        if (!wsSend({ type: "turn.stream", reqId, payload })) {
          state.wsReqHandlers.delete(reqId);
          resolve();
        }
      });
      await refreshThreads();
      return;
    }

    const headers = { "Content-Type": "application/json" };
    if (state.token.trim()) headers.Authorization = `Bearer ${state.token.trim()}`;
    const res = await fetch("/codex/turns/stream", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok || !res.body) {
      const fallback = await api("/codex/turns/start", { method: "POST", body: payload });
      const threadId =
        fallback.threadId || fallback.thread_id || fallback?.thread?.id || state.activeThreadId;
      if (threadId) setActiveThread(threadId);
      addChat("assistant", normalizeTextPayload(fallback.result || fallback));
      await refreshThreads();
      return;
    }

    let text = "";
    hideWelcomeCard();
    const { msg, body } = createAssistantStreamingMessage();
    if (!body) return;
    byId("chatBox").appendChild(msg);
    scheduleChatLiveFollow(900);

    const reader = res.body.getReader();
    const decoder = new TextDecoderRef();
    let sseBuffer = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      sseBuffer += decoder.decode(part.value, { stream: true });
      const chunks = sseBuffer.split("\n\n");
      sseBuffer = chunks.pop() || "";
      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let evtName = "message";
        let dataLine = "";
        for (const line of lines) {
          if (line.startsWith("event:")) evtName = line.slice(6).trim();
          if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let data = {};
        try {
          data = JSON.parse(dataLine);
        } catch {
          data = {};
        }
        if (evtName === "delta") {
          const delta = typeof data.text === "string" ? data.text : "";
          if (delta) {
            const piece = (text ? " " : "") + delta;
            text += piece;
            appendStreamingDelta(body, piece);
          }
          scheduleChatLiveFollow(700);
          if (typeof data.threadId === "string" && data.threadId) setActiveThread(data.threadId);
        } else if (evtName === "completed") {
          const result = data.result || {};
          const threadId =
            result.threadId || result.thread_id || result?.thread?.id || state.activeThreadId;
          if (threadId) setActiveThread(threadId);
          if (!text.trim()) text = normalizeTextPayload(result);
          finalizeAssistantMessage(msg, body, text);
          scheduleChatLiveFollow(800);
          maybeNotifyTurnDone(text || "");
        } else if (evtName === "error") {
          setStatus(data?.message || "Stream error.", true);
        }
      }
    }
    if (body.childNodes.length === 0) finalizeAssistantMessage(msg, body, text);
    await refreshThreads();
  }

  async function uploadAttachment(file) {
    if (blockInSandbox("attachment upload")) return;
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    const base64Data = btoa(binary);
    const data = await api("/codex/attachments/upload", {
      method: "POST",
      body: {
        threadId: state.activeThreadId || "unassigned",
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        base64Data,
      },
    });
    renderAttachmentPills([file]);
    setStatus(`Attachment uploaded: ${data.fileName || file.name}`);
  }

  async function resolveApproval() {
    if (blockInSandbox("approval resolve")) return;
    const id = byId("approvalIdInput").value.trim();
    const decision = byId("approvalDecisionSelect").value;
    if (!id) throw new Error("approval id required");
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("approval.resolve", { id, decision }, "approval.resolved");
    } else {
      data = await api(`/codex/approvals/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { decision },
      });
    }
    addChat("system", `approval resolved: ${JSON.stringify(data)}`);
    await refreshPending();
  }

  async function resolveUserInput() {
    if (blockInSandbox("user input resolve")) return;
    const id = byId("userInputIdInput").value.trim();
    const answerKey = byId("userInputAnswerKeyInput").value.trim();
    const answerValue = byId("userInputAnswerValueInput").value.trim();
    if (!id || !answerKey) throw new Error("user_input id and answer key required");
    const answers = { [answerKey]: answerValue };
    connectWs();
    let data;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      data = await wsCall("user_input.resolve", { id, answers }, "user_input.resolved");
    } else {
      data = await api(`/codex/user-input/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: { answers },
      });
    }
    addChat("system", `user input resolved: ${JSON.stringify(data)}`);
    await refreshPending();
  }

  return {
    addHost,
    newThread,
    resolveApproval,
    resolveUserInput,
    sendTurn,
    uploadAttachment,
  };
}
