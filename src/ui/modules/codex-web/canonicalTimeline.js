function normalizeString(value) {
  return String(value ?? "").trim();
}

function normalizeThreadId(value) {
  return normalizeString(value);
}

function cloneMessage(message) {
  return {
    ...message,
    sources: Array.isArray(message?.sources) ? message.sources.slice() : [],
  };
}

function mergeSources(existingSources, incomingSource) {
  const merged = Array.isArray(existingSources) ? existingSources.slice() : [];
  const next = normalizeString(incomingSource);
  if (next && !merged.includes(next)) {
    merged.push(next);
  }
  return merged;
}

function isCanonicalThreadMetaSource(source) {
  const normalized = normalizeString(source).toLowerCase();
  if (!normalized) return false;
  return normalized !== "live-provisional";
}

function isUserPreviewSource(source) {
  const normalized = normalizeString(source).toLowerCase();
  return normalized === "user" || normalized === "user-message" || normalized === "client";
}

function resolveThreadLabel(existingValue, incomingValue, canOverride) {
  const existing = normalizeString(existingValue);
  if (existing && !canOverride) return existing;
  const incoming = normalizeString(incomingValue);
  if (incoming) return incoming;
  return existing;
}

function chooseIncomingThreadMeta(existing, incoming) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const next = incoming && typeof incoming === "object" ? { ...incoming } : {};
  const existingCanonical = isCanonicalThreadMetaSource(base.source) || base.provisional === false;
  const incomingCanonical = isCanonicalThreadMetaSource(next.source) || next.provisional === false;
  const incomingUserPreview = next.provisional === true && isUserPreviewSource(next.previewSource);
  const canOverrideLabel = !existingCanonical || incomingCanonical;
  const shouldSeedLabel = incomingCanonical || incomingUserPreview || !normalizeString(base.title);
  const merged = { ...base, ...next };

  merged.id = normalizeThreadId(next.id || next.threadId || base.id || base.threadId);
  merged.title = resolveThreadLabel(
    base.title || base.name,
    shouldSeedLabel ? (next.title || next.name || next.preview) : "",
    canOverrideLabel,
  );
  merged.preview = resolveThreadLabel(
    base.preview,
    shouldSeedLabel ? (next.preview || next.title || next.name) : "",
    canOverrideLabel,
  );

  if (!normalizeString(merged.title) && normalizeString(merged.preview)) {
    merged.title = normalizeString(merged.preview);
  }
  if (!normalizeString(merged.preview) && normalizeString(merged.title)) {
    merged.preview = normalizeString(merged.title);
  }

  if (incomingCanonical) {
    merged.provisional = false;
  } else if (base.provisional === true || next.provisional === true) {
    merged.provisional = true;
  }

  if (existingCanonical && !incomingCanonical) {
    merged.source = base.source || next.source;
    merged.previewSource = base.previewSource || next.previewSource;
  } else if (next.source) {
    merged.source = next.source;
    if (next.previewSource) merged.previewSource = next.previewSource;
  }

  return merged;
}

function buildOptimisticUserMessage(event, state) {
  const threadId = normalizeThreadId(event.threadId || state.threadId);
  const clientMessageId = normalizeThreadId(event.clientMessageId);
  const text = normalizeString(event.text);
  const id = clientMessageId || `client:${threadId}:user:${String((state.messages || []).length + 1)}`;
  return {
    id,
    role: "user",
    text,
    optimistic: true,
    clientMessageId: id,
    threadId,
    source: "client",
    sources: ["client"],
  };
}

function buildCanonicalMessage(event) {
  const raw = event?.message && typeof event.message === "object" ? { ...event.message } : {};
  const role = normalizeString(
    raw.role ||
      event.role ||
      (normalizeString(event?.type).startsWith("assistant") ? "assistant" : "")
  );
  const text = normalizeString(raw.text || event.text);
  const threadId = normalizeThreadId(raw.threadId || event.threadId);
  const turnId = normalizeThreadId(raw.turnId || event.turnId);
  const itemId = normalizeThreadId(raw.itemId || event.itemId);
  const clientMessageId = normalizeThreadId(raw.clientMessageId || event.clientMessageId);
  const source = normalizeString(raw.source || event.source);
  const previewSource = normalizeString(raw.previewSource || event.previewSource);
  const correlation = event?.correlation && typeof event.correlation === "object" ? event.correlation : {};
  const correlatedClientMessageId = normalizeThreadId(correlation.clientMessageId || raw.clientMessageId);

  if (role === "assistant") {
    const id = normalizeThreadId(raw.id) || `assistant:${turnId || threadId}:${itemId || "message"}`;
    return {
      ...raw,
      id,
      role: "assistant",
      text,
      threadId,
      turnId,
      itemId,
      source: source || event.type || "assistant",
      previewSource,
      sources: source ? [source] : [],
    };
  }

  const id = normalizeThreadId(raw.id) || correlatedClientMessageId || clientMessageId || `user:${threadId}:${text || "message"}`;
  return {
    ...raw,
    id,
    role: "user",
    text,
    threadId,
    clientMessageId: correlatedClientMessageId || clientMessageId || undefined,
    source: source || event.type || "user",
    previewSource,
    optimistic: raw.optimistic === true,
    sources: source ? [source] : [],
  };
}

function findOptimisticUserIndex(messages, incoming) {
  const items = Array.isArray(messages) ? messages : [];
  const text = normalizeString(incoming.text);
  const clientMessageId = normalizeThreadId(incoming.clientMessageId);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (!candidate || candidate.role !== "user" || candidate.optimistic !== true) continue;
    if (clientMessageId && normalizeThreadId(candidate.clientMessageId) === clientMessageId) return index;
    if (!clientMessageId && normalizeString(candidate.text) === text) return index;
  }
  return -1;
}

function findAssistantMatchIndex(messages, incoming) {
  const items = Array.isArray(messages) ? messages : [];
  const incomingTurnId = normalizeThreadId(incoming.turnId);
  const incomingItemId = normalizeThreadId(incoming.itemId);
  const incomingText = normalizeString(incoming.text);
  const incomingId = normalizeThreadId(incoming.id);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (!candidate || candidate.role !== "assistant") continue;
    if (incomingId && normalizeThreadId(candidate.id) === incomingId) return index;
    if (incomingTurnId && normalizeThreadId(candidate.turnId) === incomingTurnId) {
      if (!incomingItemId || normalizeThreadId(candidate.itemId) === incomingItemId) return index;
      if (normalizeString(candidate.text) === incomingText) return index;
    }
  }
  return -1;
}

function upsertCanonicalMessage(messages, incoming) {
  const items = Array.isArray(messages) ? messages.slice() : [];
  const next = cloneMessage(incoming);
  if (next.role === "user") {
    const optimisticIndex = findOptimisticUserIndex(items, next);
    if (optimisticIndex >= 0) {
      const previous = items[optimisticIndex];
      items[optimisticIndex] = {
        ...previous,
        ...next,
        optimistic: false,
        clientMessageId: previous?.clientMessageId || next.clientMessageId || undefined,
        sources: mergeSources(previous?.sources, next.source),
      };
      return items;
    }
  }

  if (next.role === "assistant") {
    const assistantIndex = findAssistantMatchIndex(items, next);
    if (assistantIndex >= 0) {
      const previous = items[assistantIndex];
      items[assistantIndex] = {
        ...previous,
        ...next,
        sources: mergeSources(previous?.sources, next.source),
      };
      return items;
    }
  }

  const existingIndex = items.findIndex((message) => normalizeThreadId(message?.id) === normalizeThreadId(next.id));
  if (existingIndex >= 0) {
    const previous = items[existingIndex];
    items[existingIndex] = {
      ...previous,
      ...next,
      optimistic: next.optimistic === true ? true : previous?.optimistic === true,
      sources: mergeSources(previous?.sources, next.source),
    };
    return items;
  }

  items.push(next);
  return items;
}

export function createCanonicalTimelineState(threadId = "") {
  const id = normalizeThreadId(threadId);
  return {
    threadId: id,
    messages: [],
    threadMeta: {
      id,
      title: "",
      preview: "",
      provisional: false,
      source: "",
    },
  };
}

export function mergeCanonicalThreadMeta(existing, incoming) {
  return chooseIncomingThreadMeta(existing, incoming);
}

export function reduceTimelineEvent(state, event) {
  const current = state && typeof state === "object" ? state : createCanonicalTimelineState();
  const nextThreadId = normalizeThreadId(event?.threadId || current.threadId);
  if (current.threadId && nextThreadId && current.threadId !== nextThreadId) {
    return current;
  }

  const nextState = {
    ...current,
    threadId: nextThreadId || current.threadId,
    messages: Array.isArray(current.messages) ? current.messages.map(cloneMessage) : [],
    threadMeta: current.threadMeta && typeof current.threadMeta === "object"
      ? { ...current.threadMeta }
      : { id: nextThreadId || current.threadId, title: "", preview: "", provisional: false, source: "" },
  };

  switch (normalizeString(event?.type)) {
    case "optimistic-user": {
      const optimistic = buildOptimisticUserMessage(event, nextState);
      nextState.messages = upsertCanonicalMessage(nextState.messages, optimistic);
      return nextState;
    }
    case "message-upsert":
    case "message":
    case "assistant-final":
    case "assistant-snapshot": {
      const message = buildCanonicalMessage(event);
      nextState.messages = upsertCanonicalMessage(nextState.messages, message);
      return nextState;
    }
    case "messages-snapshot":
    case "history-snapshot": {
      return applyTimelineSnapshot(nextState, event.snapshot || event);
    }
    case "thread-meta": {
      nextState.threadMeta = mergeCanonicalThreadMeta(nextState.threadMeta, event.meta || event.threadMeta || event.thread || event);
      if (!nextState.threadMeta.id) {
        nextState.threadMeta.id = nextThreadId || current.threadId;
      }
      return nextState;
    }
    default:
      return nextState;
  }
}

export function applyTimelineSnapshot(state, snapshot) {
  const current = state && typeof state === "object" ? state : createCanonicalTimelineState();
  const payload = snapshot && typeof snapshot === "object" ? snapshot : {};
  const snapshotThreadId = normalizeThreadId(payload.threadId || payload.id || current.threadId);
  if (current.threadId && snapshotThreadId && current.threadId !== snapshotThreadId) {
    return current;
  }

  const nextState = {
    ...current,
    threadId: snapshotThreadId || current.threadId,
    messages: Array.isArray(current.messages) ? current.messages.map(cloneMessage) : [],
    threadMeta: current.threadMeta && typeof current.threadMeta === "object"
      ? { ...current.threadMeta }
      : { id: snapshotThreadId || current.threadId, title: "", preview: "", provisional: false, source: "" },
  };

  if (payload.threadMeta && typeof payload.threadMeta === "object") {
    nextState.threadMeta = mergeCanonicalThreadMeta(nextState.threadMeta, payload.threadMeta);
  }

  for (const entry of Array.isArray(payload.messages) ? payload.messages : []) {
    const message = buildCanonicalMessage({
      type: entry?.role === "assistant" ? "assistant-snapshot" : "message-upsert",
      threadId: snapshotThreadId || current.threadId,
      message: entry,
      source: entry?.source || payload.source || "history",
    });
    if (entry?.role === "user" && normalizeString(entry.text)) {
      const optimisticIndex = findOptimisticUserIndex(nextState.messages, message);
      if (optimisticIndex >= 0) {
        nextState.messages = upsertCanonicalMessage(nextState.messages, {
          ...message,
          clientMessageId: normalizeThreadId(nextState.messages[optimisticIndex]?.clientMessageId || entry.clientMessageId),
          optimistic: false,
        });
        continue;
      }
    }
    nextState.messages = upsertCanonicalMessage(nextState.messages, message);
  }

  if (payload.running === true || payload.historyIncomplete === true) {
    const optimisticMessages = Array.isArray(current.messages)
      ? current.messages.filter((message) => message?.role === "user" && message?.optimistic === true)
      : [];
    for (const optimistic of optimisticMessages) {
      const matchIndex = nextState.messages.findIndex(
        (message) =>
          message.role === "user" &&
          !message.optimistic &&
          normalizeString(message.text) === normalizeString(optimistic.text)
      );
      if (matchIndex >= 0) {
        continue;
      }
      const optimisticClone = cloneMessage(optimistic);
      if (!nextState.messages.some((message) => normalizeThreadId(message.id) === normalizeThreadId(optimisticClone.id))) {
        nextState.messages.unshift(optimisticClone);
      }
    }
  }

  return nextState;
}
