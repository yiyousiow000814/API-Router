import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const rustAssetsFile = path.join(
  repoRoot,
  "src-tauri",
  "src",
  "orchestrator",
  "gateway",
  "web_codex_assets.rs"
);
const upstreamRoot = path.join(
  repoRoot,
  "third_party",
  "codex-web",
  "scratch",
  "asar",
  "webview"
);
const requiredFiles = [
  path.join(upstreamRoot, "index.html"),
  path.join(upstreamRoot, "manifest.json"),
  path.join(upstreamRoot, "favicon.svg"),
  path.join(upstreamRoot, "assets", "electronBridge-compat.js"),
];
const vendoredBridgeCompatPath = path.join(
  repoRoot,
  "third_party",
  "codex-web",
  "assets",
  "electronBridge-compat.js"
);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function fail(message, extra = []) {
  console.error(`[check-web-codex-assets] ${message}`);
  for (const line of extra) console.error(line);
  process.exit(1);
}

if (!fs.existsSync(rustAssetsFile)) {
  fail("Rust asset bridge file is missing.", [
    `Expected: ${normalizeSlashes(path.relative(repoRoot, rustAssetsFile))}`,
  ]);
}

const rustSource = readText(rustAssetsFile);
if (!rustSource.includes("third_party/codex-web/scratch/asar/webview")) {
  fail("Rust asset bridge is not pointing at upstream Codex Web webview assets.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, rustAssetsFile))}`,
  ]);
}

if (!fs.existsSync(upstreamRoot)) {
  fail("Prepared upstream Codex Web asset root is missing.", [
    `Expected directory: ${normalizeSlashes(path.relative(repoRoot, upstreamRoot))}`,
    "Run: npm run codex-web:prepare-upstream",
  ]);
}

if (!fs.existsSync(vendoredBridgeCompatPath)) {
  fail("Vendored electronBridge-compat.js source is missing.", [
    `Expected: ${normalizeSlashes(path.relative(repoRoot, vendoredBridgeCompatPath))}`,
  ]);
}

const missingFiles = requiredFiles.filter((filePath) => !fs.existsSync(filePath));
if (missingFiles.length) {
  fail("Prepared upstream Codex Web assets are incomplete.", [
    ...missingFiles.map((filePath) => `- missing ${normalizeSlashes(path.relative(repoRoot, filePath))}`),
    "Run: npm run codex-web:prepare-upstream",
  ]);
}

const assetEntries = fs.readdirSync(path.join(upstreamRoot, "assets"), { withFileTypes: true });
const hasJsBundle = assetEntries.some(
  (entry) =>
    entry.isFile() &&
    entry.name.startsWith("index-") &&
    entry.name.endsWith(".js")
);
if (!hasJsBundle) {
  fail("Prepared upstream Codex Web assets are missing the main JS bundle.", [
    `Checked assets dir: ${normalizeSlashes(path.relative(repoRoot, path.join(upstreamRoot, "assets")))}`,
  ]);
}

const electronBridgeCompatPath = path.join(upstreamRoot, "assets", "electronBridge-compat.js");
const electronBridgeCompatSource = readText(electronBridgeCompatPath);
if (!electronBridgeCompatSource.includes("const resolvedWindowType = resolveCodexWindowType();")) {
  fail("electronBridge-compat.js is missing dynamic Codex window type resolution.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
  ]);
}
if (!electronBridgeCompatSource.includes("document.documentElement.dataset.codexWindowType = resolvedWindowType;")) {
  fail("electronBridge-compat.js is not syncing the resolved window type onto <html>.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
  ]);
}
if (electronBridgeCompatSource.includes('return "browser";')) {
  fail("electronBridge-compat.js is downgrading the Codex window type to browser.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
    "Mobile overlay and drawer behavior must continue using the electron app-shell path.",
  ]);
}
if (!electronBridgeCompatSource.includes("const compactTouchViewport = isCompactTouchViewport();")) {
  fail("electronBridge-compat.js is missing compact touch viewport detection.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
  ]);
}
if (!electronBridgeCompatSource.includes("function isCompactTouchViewport() {")) {
  fail("electronBridge-compat.js is missing the compact touch viewport helper.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
  ]);
}
if (!electronBridgeCompatSource.includes("...(compactTouchViewport")) {
  fail("electronBridge-compat.js is not suppressing the application menu on compact touch viewports.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, electronBridgeCompatPath))}`,
  ]);
}
const indexBundleName = assetEntries.find(
  (entry) => entry.isFile() && entry.name.startsWith("index-") && entry.name.endsWith(".js")
)?.name;
if (!indexBundleName) {
  fail("Prepared upstream Codex Web assets are missing the main JS bundle.", [
    `Checked assets dir: ${normalizeSlashes(path.relative(repoRoot, path.join(upstreamRoot, "assets")))}`,
  ]);
}
const indexBundlePath = path.join(upstreamRoot, "assets", indexBundleName);
const indexBundleSource = readText(indexBundlePath);
if (!indexBundleSource.includes("dataset.codexWindowType")) {
  fail("The upstream index bundle is not reading the resolved Codex window type from <html>.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, indexBundlePath))}`,
  ]);
}
if (
  indexBundleSource.includes("document.documentElement.dataset.codexWindowType = `electron`") ||
  indexBundleSource.includes("document.documentElement.dataset.windowType = `electron`")
) {
  fail("The upstream index bundle is still hardcoding the Codex window type to electron.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, indexBundlePath))}`,
    "Expected the prepared bundle to resolve window type from electronBridge/codexWindowType.",
  ]);
}
if (
  !indexBundleSource.includes("window.electronBridge?.windowType") &&
  !indexBundleSource.includes("window.codexWindowType")
) {
  fail("The upstream index bundle is not resolving the Codex window type from the bridge.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, indexBundlePath))}`,
  ]);
}
if (!indexBundleSource.includes("__apiRouterCodexWindowType")) {
  fail("The upstream index bundle is missing the canonical API Router mobile window type binding.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, indexBundlePath))}`,
  ]);
}
if (
  indexBundleSource.includes(",ep=window.electronBridge?.windowType") ||
  indexBundleSource.includes(" ep = window.electronBridge?.windowType")
) {
  fail("The upstream index bundle is still using the colliding ep binding for window type resolution.", [
    `Checked: ${normalizeSlashes(path.relative(repoRoot, indexBundlePath))}`,
    "Expected the prepared bundle to use __apiRouterCodexWindowType instead.",
  ]);
}

console.log(
  `[check-web-codex-assets] ok (${normalizeSlashes(path.relative(repoRoot, upstreamRoot))})`
);
