const UI_ACTIVITY_STACK_KEY = "__API_ROUTER_UI_ACTIVITY_STACK__";

function getWindowRef(windowRef) {
  if (windowRef) return windowRef;
  if (typeof window !== "undefined") return window;
  return null;
}

function normalizeFields(fields) {
  return fields && typeof fields === "object" ? { ...fields } : {};
}

export function beginUiActivity(windowRef, kind, fields = {}) {
  const win = getWindowRef(windowRef);
  const activityKind = String(kind || "").trim();
  if (!win || !activityKind) return () => {};

  const stack = Array.isArray(win[UI_ACTIVITY_STACK_KEY]) ? win[UI_ACTIVITY_STACK_KEY] : [];
  if (!Array.isArray(win[UI_ACTIVITY_STACK_KEY])) {
    win[UI_ACTIVITY_STACK_KEY] = stack;
  }

  const entry = {
    kind: activityKind,
    fields: normalizeFields(fields),
    startedAtUnixMs: Date.now(),
  };
  stack.push(entry);

  return () => {
    const currentStack = Array.isArray(win[UI_ACTIVITY_STACK_KEY]) ? win[UI_ACTIVITY_STACK_KEY] : [];
    for (let index = currentStack.length - 1; index >= 0; index -= 1) {
      if (currentStack[index] === entry) {
        currentStack.splice(index, 1);
        break;
      }
    }
  };
}

export function readUiActivitySnapshot(windowRef) {
  const win = getWindowRef(windowRef);
  if (!win) return null;
  const stack = Array.isArray(win[UI_ACTIVITY_STACK_KEY]) ? win[UI_ACTIVITY_STACK_KEY] : [];
  if (!stack.length) return null;
  const current = stack[stack.length - 1];
  if (!current || typeof current !== "object") return null;
  return {
    kind: String(current.kind || "").trim(),
    fields: normalizeFields(current.fields),
    startedAtUnixMs: Math.max(0, Math.round(Number(current.startedAtUnixMs || 0))),
    depth: stack.length,
  };
}
