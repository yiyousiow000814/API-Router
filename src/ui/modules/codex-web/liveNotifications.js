export function workspaceKeyOfThread(thread) {
  const raw = thread.cwd || thread.workspace || thread.project || thread.directory || thread.path || "";
  const text = String(raw || "").trim();
  if (!text) return "Default folder";
  const normalized = text
    .replace(/^\\\\\?\\/, "")
    .replace(/^\\\\\?\\UNC\\/, "\\\\")
    .replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "Default folder";
}

export function createLiveNotificationsModule(deps) {
  const {
    state,
    byId,
    addChat,
    scheduleChatLiveFollow,
    normalizeType,
    normalizeInline,
    normalizeMultiline,
    readNumber,
    toRecord,
    toStructuredPreview,
    extractNotificationThreadId,
  } = deps;

  function toToolLikeMessage(item) {
    const itemType = normalizeType(item?.type);
    if (!itemType) return null;
    if (itemType === "plan") return normalizeMultiline(item?.text, 1800) || null;
    if (itemType === "commandexecution") {
      const command = normalizeInline(item?.command, 240) ?? "command";
      const status = normalizeType(item?.status);
      const output =
        normalizeMultiline(item?.aggregatedOutput, 2400) ??
        normalizeMultiline(item?.aggregated_output, 2400) ??
        normalizeMultiline(item?.output, 2400);
      const exitCode = readNumber(item?.exitCode) ?? readNumber(item?.exit_code);
      const title =
        status === "failed" || status === "error"
          ? `- Command failed \`${command}\``
          : `- Ran \`${command}\``;
      const lines = [title];
      if (exitCode !== null) lines.push(`  - exit code ${String(exitCode)}`);
      if (output) lines.push(`  - ${output.replace(/\n/g, "\n    ")}`);
      return lines.join("\n");
    }
    if (itemType === "mcptoolcall") {
      const server = normalizeInline(item?.server, 120);
      const tool = normalizeInline(item?.tool, 120);
      const label = [server, tool].filter(Boolean).join(" / ") || "MCP tool call";
      const status = normalizeType(item?.status);
      const err = toRecord(item?.error);
      const errMsg = normalizeInline(err?.message, 240) ?? normalizeInline(item?.error, 240);
      const result = toStructuredPreview(item?.result, 240);
      const detail = status === "failed" || status === "error" ? errMsg ?? result : result ?? errMsg;
      const title =
        status === "failed" || status === "error"
          ? `- Tool failed \`${label}\``
          : `- Called tool \`${label}\``;
      return detail ? `${title}\n  - ${detail.replace(/\n/g, "\n    ")}` : title;
    }
    if (itemType === "websearch") {
      const query = normalizeInline(item?.query, 180);
      const action = toRecord(item?.action);
      const actionType = normalizeType(action?.type);
      let detail = query;
      if (actionType === "openpage") detail = normalizeInline(action?.url, 240) ?? detail;
      else if (actionType === "findinpage") {
        const url = normalizeInline(action?.url, 180);
        const pattern = normalizeInline(action?.pattern, 120);
        detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(" | ") || detail;
      }
      const title = query ? `- Searched web for "${query}"` : "- Searched web";
      return detail && detail !== query ? `${title}\n  - ${detail}` : title;
    }
    if (itemType === "filechange") {
      const status = normalizeType(item?.status);
      const changeCount = Array.isArray(item?.changes) ? item.changes.length : 0;
      const title = status === "failed" || status === "error" ? "- File changes failed" : "- Applied file changes";
      return changeCount > 0 ? `${title}\n  - ${String(changeCount)} file(s) changed` : title;
    }
    if (itemType === "enteredreviewmode") return "- Entered review mode";
    if (itemType === "exitedreviewmode") return "- Exited review mode";
    if (itemType === "contextcompaction") return "- Compacted conversation context";
    return null;
  }

  function notificationToToolItem(notification) {
    const record = toRecord(notification);
    const params = toRecord(record?.params) || toRecord(record?.payload) || null;
    if (!params) return null;
    return (
      toRecord(params?.msg) || toRecord(params?.item) || toRecord(params?.delta) || toRecord(params?.event) || null
    );
  }

  function renderLiveNotification(notification) {
    const record = toRecord(notification);
    const method = String(record?.method || "");
    if (!method) return;
    const threadId = extractNotificationThreadId(record);
    if (!threadId || threadId !== state.activeThreadId) return;

    const toolItem = notificationToToolItem(record);
    if (toolItem) {
      const toolLike = toToolLikeMessage(toolItem);
      if (toolLike) {
        addChat("system", toolLike, { kind: "tool", scroll: false });
        scheduleChatLiveFollow(900);
        return;
      }
    }

    const params = toRecord(record?.params) || null;
    const status =
      normalizeType(params?.status) || normalizeType(params?.turn?.status) || normalizeType(params?.thread?.status);
    const isRunning = /running|inprogress|working|queued/.test(status || "") || method.includes("turn/started");
    if (isRunning) {
      const box = byId("chatBox");
      if (!box) return;
      const existing = box.querySelector('.msg.system.kind-thinking[data-thinking="1"]');
      if (!existing) {
        addChat("system", "- Thinkingâ€¦", { kind: "thinking", scroll: false });
        try {
          const last = box.lastElementChild;
          if (last?.classList?.contains("kind-thinking")) last.setAttribute("data-thinking", "1");
        } catch {}
        scheduleChatLiveFollow(800);
      }
      return;
    }
    if (method.includes("turn/completed") || method.includes("turn/finished") || method.includes("turn/failed") || method.includes("turn/cancelled")) {
      try {
        const box = byId("chatBox");
        box?.querySelector?.('.msg.system.kind-thinking[data-thinking="1"]')?.remove?.();
      } catch {}
    }
  }

  return { notificationToToolItem, renderLiveNotification, toToolLikeMessage, workspaceKeyOfThread };
}
