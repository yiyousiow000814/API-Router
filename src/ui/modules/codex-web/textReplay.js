export function splitReplayText(text, options = {}) {
  const maxChunkSize = Math.max(1, Number(options.maxChunkSize || 80) | 0);
  const requestedChunkSize = Number(options.chunkSize || 14) | 0;
  const size = Math.max(1, Math.min(maxChunkSize, requestedChunkSize || 14));
  const chars = Array.from(String(text || ""));
  const chunks = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks;
}
