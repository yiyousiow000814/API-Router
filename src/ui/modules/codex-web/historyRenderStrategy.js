function messageShapeMatches(a, b) {
  return !!a && !!b && a.role === b.role && a.kind === b.kind;
}

function messageFullyMatches(a, b) {
  return messageShapeMatches(a, b) && a.text === b.text;
}

function allButLastMatch(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length || previous.length === 0) return false;
  for (let index = 0; index < previous.length - 1; index += 1) {
    if (!messageFullyMatches(previous[index], next[index])) return false;
  }
  return true;
}

function isSamePrefix(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (!messageFullyMatches(previous[index], next[index])) return false;
  }
  return true;
}

function shouldUpdateLastMessage(previous, next) {
  if (!allButLastMatch(previous, next)) return false;
  const previousLast = previous[previous.length - 1];
  const nextLast = next[next.length - 1];
  return messageShapeMatches(previousLast, nextLast) && previousLast.text !== nextLast.text;
}

export function decideHistoryRenderStrategy({
  previousMessages = [],
  nextMessages = [],
  alreadyWindowed = false,
  windowed = false,
} = {}) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const next = Array.isArray(nextMessages) ? nextMessages : [];

  if (windowed) {
    if (!alreadyWindowed || next.length < previous.length) return "window_full";
    if (next.length === previous.length) {
      return shouldUpdateLastMessage(previous, next) ? "window_update_last" : "window_unchanged";
    }
    return "window_append";
  }

  if (shouldUpdateLastMessage(previous, next)) return "full_update_last";
  if (isSamePrefix(previous, next)) return "full_append";
  return "full_rerender";
}
