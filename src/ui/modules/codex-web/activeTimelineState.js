function cloneMessage(message) {
  return message && typeof message === "object"
    ? {
        ...message,
        images: Array.isArray(message.images) ? message.images.slice() : message.images,
      }
    : message;
}

function hasImages(message) {
  return Array.isArray(message?.images) && message.images.length > 0;
}

function mergeMessage(previous, next) {
  const merged = {
    ...previous,
    ...next,
  };
  if (hasImages(previous) && !hasImages(next)) {
    merged.images = previous.images.slice();
  }
  return merged;
}

function normalizeIdentity(value) {
  return String(value || "").trim();
}

function messageIdentity(message) {
  return normalizeIdentity(
    message?.id ||
    message?.messageKey ||
    message?.messageId ||
    message?.clientMessageId ||
    message?.client_message_id ||
    ""
  );
}

function sameAdjacentMessage(a, b) {
  const role = String(a?.role || "").trim();
  if (role === "user") return false;
  return (
    !!a &&
    !!b &&
    role === String(b.role || "").trim() &&
    String(a.kind || "").trim() === String(b.kind || "").trim() &&
    String(a.text || "") === String(b.text || "")
  );
}

function canonicalizeMessages(messages = []) {
  const canonical = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const next = cloneMessage(raw);
    const identity = messageIdentity(next);
    if (identity) {
      const existingIndex = canonical.findIndex((item) => messageIdentity(item) === identity);
      if (existingIndex >= 0) {
        canonical[existingIndex] = mergeMessage(canonical[existingIndex], next);
        continue;
      }
    }
    if (sameAdjacentMessage(canonical[canonical.length - 1], next)) {
      const index = canonical.length - 1;
      canonical[index] = mergeMessage(canonical[index], next);
      continue;
    }
    canonical.push(next);
  }
  return canonical;
}

export function ensureActiveTimelineMessages(state = {}) {
  if (!Array.isArray(state.activeThreadMessages)) {
    state.activeThreadMessages = [];
  }
  return state.activeThreadMessages;
}

export function setActiveTimelineMessages(state = {}, messages = []) {
  state.activeThreadMessages = canonicalizeMessages(messages);
  return state.activeThreadMessages;
}

export function appendActiveTimelineMessage(state = {}, message = {}, options = {}) {
  const messages = ensureActiveTimelineMessages(state);
  const next = cloneMessage(message);
  const identity = messageIdentity(next);
  if (identity) {
    const existingIndex = messages.findIndex((item) => messageIdentity(item) === identity);
    if (existingIndex >= 0) {
      messages[existingIndex] = mergeMessage(messages[existingIndex], next);
      return { index: existingIndex, message: messages[existingIndex], appended: false };
    }
  }
  if (options.dedupeAdjacent !== false && sameAdjacentMessage(messages[messages.length - 1], next)) {
    const index = messages.length - 1;
    messages[index] = mergeMessage(messages[index], next);
    return { index, message: messages[index], appended: false };
  }
  messages.push(next);
  return { index: messages.length - 1, message: next, appended: true };
}

export function updateActiveTimelineMessageAt(state = {}, index, updater) {
  const messages = ensureActiveTimelineMessages(state);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length) {
    return null;
  }
  const current = messages[idx];
  const next = typeof updater === "function" ? updater(current) : updater;
  messages[idx] = cloneMessage(next);
  return messages[idx];
}

export function removeActiveTimelineMessageAt(state = {}, index) {
  const messages = ensureActiveTimelineMessages(state);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length) {
    return null;
  }
  const [removed] = messages.splice(idx, 1);
  return removed || null;
}
