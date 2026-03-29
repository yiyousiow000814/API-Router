export const MOBILE_PROMPT_MIN_HEIGHT_PX = 40;
export const MOBILE_PROMPT_MAX_HEIGHT_PX = 420;
const MOBILE_PROMPT_VIEWPORT_RATIO = 0.45;
const MOBILE_PROMPT_MIN_VIEWPORT_CLAMP_PX = 132;

export function resolveMobilePromptMaxHeight(viewportHeight) {
  if (!Number.isFinite(viewportHeight)) return MOBILE_PROMPT_MAX_HEIGHT_PX;
  const fromViewport = Math.floor(viewportHeight * MOBILE_PROMPT_VIEWPORT_RATIO);
  return Math.max(MOBILE_PROMPT_MIN_VIEWPORT_CLAMP_PX, Math.min(MOBILE_PROMPT_MAX_HEIGHT_PX, fromViewport));
}

export function resolveMobilePromptLayout(scrollHeight, viewportHeight) {
  const maxHeight = resolveMobilePromptMaxHeight(viewportHeight);
  const normalizedScrollHeight = Number.isFinite(scrollHeight) ? scrollHeight : MOBILE_PROMPT_MIN_HEIGHT_PX;
  const nextHeight = Math.min(Math.max(normalizedScrollHeight, MOBILE_PROMPT_MIN_HEIGHT_PX), maxHeight);
  return {
    heightPx: nextHeight,
    overflowY: normalizedScrollHeight > nextHeight ? "auto" : "hidden",
  };
}

export function readPromptValue(input) {
  return String(input?.value || "").trim();
}

export function clearPromptInput(input) {
  if (!input) return;
  input.value = "";
}
