export function readBranchOptionName(value) {
  if (value && typeof value === "object") {
    return String(value.name || value.branch || value.label || "").trim();
  }
  return String(value || "").trim();
}

export function readBranchOptionPrNumber(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value.prNumber ?? value.pr_number ?? null;
  const number = Number(raw);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeBranchOption(value) {
  const name = readBranchOptionName(value);
  if (!name) return null;
  const prNumber = readBranchOptionPrNumber(value);
  return prNumber != null ? { name, prNumber } : { name };
}

export function normalizeBranchOptions(values) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const items = [];
  for (const item of source) {
    const normalized = normalizeBranchOption(item);
    if (!normalized) continue;
    const key = normalized.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(normalized);
  }
  return items;
}
