function messageMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind && a.text === b.text;
}

function isCommentaryArchiveMessage(message) {
  return String(message?.kind || "").trim() === "commentaryArchive";
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
    node?.classList?.contains?.("msg") || node?.classList?.contains?.("commentaryArchiveMount")
  );
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
  } catch {}
  return node;
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
  const patch = findCommentaryArchivePatch(previousMessages, nextMessages);
  if (!patch) return null;
  const liveArchiveMount = typeof box.querySelector === "function" ? box.querySelector("#commentaryArchiveMount") : null;
  if (liveArchiveMount && liveArchiveMount.parentElement === box && typeof liveArchiveMount.remove === "function") {
    liveArchiveMount.remove();
  }
  const domNodes = getTimelineDomNodes(box);
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];
  let previousIndex = 0;
  let domIndex = 0;
  let inserted = 0;
  let updated = 0;
  for (const message of next) {
    const previousMessage = previous[previousIndex] || null;
    if (!isCommentaryArchiveMessage(message)) {
      const node = domNodes[domIndex] || null;
      if (previousMessage && (previousMessage.role !== message.role || previousMessage.kind !== message.kind)) {
        return null;
      }
      if (previousMessage && previousMessage.text !== message.text) {
        if (previousIndex !== previous.length - 1) return null;
        const updatedNode = updateTimelineMessageNode(node, message, renderMessageBody);
        if (!updatedNode) return null;
        replayMessage(updatedNode, message, { fromText: previousMessage.text });
        updated += 1;
      }
      previousIndex += 1;
      domIndex += 1;
      continue;
    }
    if (isCommentaryArchiveMessage(previousMessage)) {
      if (!messageMatches(previousMessage, message)) return null;
      previousIndex += 1;
      domIndex += 1;
      continue;
    }
    const node = buildMsgNode(message);
    const anchorNode = domNodes[domIndex] || null;
    if (anchorNode && anchorNode.parentElement === box && typeof box.insertBefore === "function") {
      box.insertBefore(node, anchorNode);
    } else {
      box.appendChild(node);
    }
    domNodes.splice(domIndex, 0, node);
    inserted += 1;
    domIndex += 1;
  }
  if (previousIndex !== previous.length) return null;
  return { inserted, updated };
}
