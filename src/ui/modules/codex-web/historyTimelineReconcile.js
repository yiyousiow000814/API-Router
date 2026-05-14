function messageMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind && a.text === b.text;
}

function isMessagePrefix(previousMessages = [], nextMessages = []) {
  if (!Array.isArray(previousMessages) || !Array.isArray(nextMessages)) return false;
  if (previousMessages.length > nextMessages.length) return false;
  return previousMessages.every((message, index) => messageMatches(message, nextMessages[index]));
}

function isPatchableMessageSequence(previousMessages = [], nextMessages = []) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  if (previous.length > next.length) return false;
  let previousIndex = 0;
  for (const message of next) {
    const previousMessage = previous[previousIndex] || null;
    if (!previousMessage) continue;
    if (previousMessage.role !== message.role || previousMessage.kind !== message.kind) return false;
    if (previousMessage.text !== message.text && previousIndex !== previous.length - 1) return false;
    previousIndex += 1;
  }
  return previousIndex === previous.length;
}

function isCommentaryArchiveMessage(message) {
  return String(message?.kind || "").trim() === "commentaryArchive";
}

function classNameTokens(node) {
  return String(node?.className || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasClass(node, token) {
  return !!node?.classList?.contains?.(token) || classNameTokens(node).includes(token);
}

function roleFromNode(node) {
  const explicitRole = String(node?.__webCodexRole || "").trim();
  if (explicitRole) return explicitRole;
  if (hasClass(node, "assistant")) return "assistant";
  if (hasClass(node, "user")) return "user";
  if (hasClass(node, "system") || hasClass(node, "commentaryArchiveMount")) return "system";
  return "";
}

function kindFromNode(node) {
  const explicitKind = String(node?.__webCodexKind || "").trim();
  if (explicitKind) return explicitKind;
  if (hasClass(node, "commentaryArchiveMount")) return "commentaryArchive";
  const kindToken = classNameTokens(node).find((token) => token.startsWith("kind-"));
  return kindToken ? kindToken.slice("kind-".length) : "";
}

function textFromNode(node) {
  const rawText = node?.__webCodexRawText;
  if (typeof rawText === "string") return rawText;
  const textContent = node?.textContent;
  if (typeof textContent === "string") return textContent;
  const label = String(node?.label || "");
  const separatorIndex = label.indexOf(":");
  return separatorIndex >= 0 ? label.slice(separatorIndex + 1) : label;
}

function messageFromTimelineNode(node) {
  const role = roleFromNode(node);
  const kind = kindFromNode(node);
  if (!role && !kind) return null;
  return {
    role,
    kind,
    text: textFromNode(node),
  };
}

function nodeMatchesMessage(node, message) {
  const nodeMessage = messageFromTimelineNode(node);
  return messageMatches(nodeMessage, message);
}

export function findCommentaryArchivePatch(previousMessages = [], nextMessages = []) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  if (!previous.length || next.length < previous.length) return null;
  const insertions = [];
  let previousIndex = 0;
  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    const nextMessage = next[nextIndex];
    if (isCommentaryArchiveMessage(nextMessage)) {
      const previousMessage = previous[previousIndex];
      if (isCommentaryArchiveMessage(previousMessage)) {
        if (!messageMatches(previousMessage, nextMessage)) return null;
        previousIndex += 1;
        continue;
      }
      insertions.push({ index: nextIndex, message: nextMessage });
      continue;
    }
    const previousMessage = previous[previousIndex];
    if (!previousMessage) return null;
    if (previousMessage.role !== nextMessage.role || previousMessage.kind !== nextMessage.kind) return null;
    if (previousMessage.text !== nextMessage.text && previousIndex !== previous.length - 1) return null;
    previousIndex += 1;
  }
  if (previousIndex !== previous.length || !insertions.length) return null;
  return insertions;
}

function getTimelineDomNodes(box) {
  return Array.from(box?.children || []).filter((node) =>
    hasClass(node, "msg") || hasClass(node, "commentaryArchiveMount")
  );
}

function getTimelineDomMessages(domNodes = []) {
  return domNodes.map(messageFromTimelineNode).filter(Boolean);
}

function updateTimelineMessageNode(node, message, renderMessageBody) {
  if (!node || typeof renderMessageBody !== "function") return false;
  const body = node?.querySelector?.(".msgBody") || null;
  if (!body) return false;
  body.innerHTML = renderMessageBody(message?.role || "", message?.text || "", {
    kind: message?.kind || "",
  });
  try {
    node.__webCodexRole = String(message?.role || "").trim();
    node.__webCodexKind = String(message?.kind || "").trim();
    node.__webCodexRawText = String(message?.text || "");
    const messageKey = String(message?.id || message?.messageKey || "").trim();
    if (messageKey) {
      node.setAttribute?.("data-msg-key", messageKey);
      node.setAttribute?.("data-msg-id", messageKey);
    }
  } catch {}
  return node;
}

function syncTimelineMessageNodeMeta(node, message) {
  if (!node || !message) return false;
  try {
    node.__webCodexRole = String(message?.role || "").trim();
    node.__webCodexKind = String(message?.kind || "").trim();
    node.__webCodexRawText = String(message?.text || "");
    const messageKey = String(message?.id || message?.messageKey || "").trim();
    if (messageKey) {
      node.setAttribute?.("data-msg-key", messageKey);
      node.setAttribute?.("data-msg-id", messageKey);
    }
  } catch {}
  return true;
}

function resolvePatchSource(previousMessages, nextMessages, domNodes) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const domMessages = getTimelineDomMessages(domNodes);
  if (domMessages.length && domMessages.length !== previous.length) {
    if (isMessagePrefix(domMessages, nextMessages) || isPatchableMessageSequence(domMessages, nextMessages)) {
      return { patch: [], previous: domMessages, source: "dom" };
    }
    const domPatch = findCommentaryArchivePatch(domMessages, nextMessages);
    if (domPatch) return { patch: domPatch, previous: domMessages, source: "dom" };
  }
  const statePatch = findCommentaryArchivePatch(previous, nextMessages);
  if (statePatch) return { patch: statePatch, previous, source: "state" };
  if (domMessages.length) {
    const domPatch = findCommentaryArchivePatch(domMessages, nextMessages);
    if (domPatch) return { patch: domPatch, previous: domMessages, source: "dom" };
  }
  return null;
}

function planTimelinePatch({ previousMessages, nextMessages, domNodes }) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  const operations = [];
  let previousIndex = 0;
  let domIndex = 0;
  for (const message of next) {
    const previousMessage = previous[previousIndex] || null;
    if (!isCommentaryArchiveMessage(message)) {
      const node = domNodes[domIndex] || null;
      if (!previousMessage) {
        operations.push({
          type: "insert",
          anchorNode: node,
          message,
        });
        continue;
      }
      if (!node) return null;
      if (previousMessage && (previousMessage.role !== message.role || previousMessage.kind !== message.kind)) {
        return null;
      }
      if (previousMessage && !nodeMatchesMessage(node, previousMessage)) return null;
      if (previousMessage && previousMessage.text !== message.text) {
        if (previousIndex !== previous.length - 1) return null;
        operations.push({
          type: "update",
          node,
          message,
          fromText: previousMessage.text,
        });
      } else {
        operations.push({
          type: "sync",
          node,
          message,
        });
      }
      previousIndex += 1;
      domIndex += 1;
      continue;
    }
    if (isCommentaryArchiveMessage(previousMessage)) {
      const node = domNodes[domIndex] || null;
      if (!node || !messageMatches(previousMessage, message) || !nodeMatchesMessage(node, previousMessage)) return null;
      operations.push({
        type: "sync",
        node,
        message,
      });
      previousIndex += 1;
      domIndex += 1;
      continue;
    }
    operations.push({
      type: "insert",
      anchorNode: domNodes[domIndex] || null,
      message,
    });
  }
  if (previousIndex !== previous.length) return null;
  return operations;
}

export function reconcileTimelineMessages(params = {}) {
  const {
    box,
    previousMessages,
    nextMessages,
    buildMsgNode,
    renderMessageBody,
    replayMessage = () => false,
  } = params;
  if (!box || typeof buildMsgNode !== "function") return null;
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  const liveArchiveMount = typeof box.querySelector === "function" ? box.querySelector("#commentaryArchiveMount") : null;
  const domNodes = getTimelineDomNodes(box).filter((node) => node !== liveArchiveMount);
  const patchSource = resolvePatchSource(previousMessages, next, domNodes);
  if (!patchSource) return null;
  const operations = planTimelinePatch({
    previousMessages: patchSource.previous,
    nextMessages: next,
    domNodes,
  });
  if (!operations) return null;
  if (liveArchiveMount && liveArchiveMount.parentElement === box && typeof liveArchiveMount.remove === "function") {
    liveArchiveMount.remove();
  }
  let inserted = 0;
  let updated = 0;
  for (const operation of operations) {
    if (operation.type === "update") {
      const updatedNode = updateTimelineMessageNode(operation.node, operation.message, renderMessageBody);
      if (!updatedNode) return null;
      replayMessage(updatedNode, operation.message, { fromText: operation.fromText });
      updated += 1;
      continue;
    }
    if (operation.type === "sync") {
      syncTimelineMessageNodeMeta(operation.node, operation.message);
      continue;
    }
    if (operation.type !== "insert") continue;
    const node = buildMsgNode(operation.message);
    const anchorNode = operation.anchorNode || null;
    if (anchorNode && anchorNode.parentElement === box && typeof box.insertBefore === "function") {
      box.insertBefore(node, anchorNode);
    } else {
      box.appendChild(node);
    }
    replayMessage(node, operation.message, { fromText: "" });
    inserted += 1;
  }
  return { inserted, updated, source: patchSource.source };
}
