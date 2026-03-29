function defaultNormalizeType(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readText(value) {
  return value == null ? "" : String(value).trim();
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function extractRequestUserInput(item, options = {}) {
  const normalizeType = typeof options.normalizeType === "function" ? options.normalizeType : defaultNormalizeType;
  const itemType = normalizeType(item?.type);
  if (itemType !== "toolcall" && itemType !== "mcptoolcall") return null;
  const toolName = normalizeType(item?.tool || item?.name);
  if (toolName !== "requestuserinput") return null;
  const payload =
    parseJsonObject(item?.arguments) ||
    parseJsonObject(item?.input) ||
    parseJsonObject(item?.args);
  if (!payload) return null;
  const questions = Array.isArray(payload.questions)
    ? payload.questions.filter((question) => question && typeof question === "object")
    : [];
  const prompt = readText(
    payload.prompt ||
    payload.question ||
    payload.title ||
    questions[0]?.question ||
    questions[0]?.prompt ||
    questions[0]?.title
  );
  const id = readText(
    payload.id ||
    item?.id ||
    item?.callId ||
    item?.call_id ||
    item?.toolCallId ||
    item?.tool_call_id ||
    item?.turnId ||
    item?.turn_id
  );
  if (!id || (!prompt && !questions.length)) return null;
  return {
    id,
    prompt,
    title: readText(payload.title),
    questions,
  };
}
