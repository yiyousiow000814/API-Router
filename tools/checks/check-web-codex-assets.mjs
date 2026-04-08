import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const entryFile = path.join(repoRoot, "src", "ui", "codex-web-dev.js");
const rustAssetsFile = path.join(
  repoRoot,
  "src-tauri",
  "src",
  "orchestrator",
  "gateway",
  "web_codex_assets.rs"
);
const codexModulesRoot = path.join(repoRoot, "src", "ui", "modules", "codex-web");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function collectRelativeImports(filePath) {
  const source = readText(filePath);
  const imports = new Set();
  const pattern =
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = String(match[1] || match[2] || "").trim();
    if (!specifier.startsWith(".")) continue;
    let resolved = path.resolve(path.dirname(filePath), specifier);
    if (!path.extname(resolved)) resolved += ".js";
    imports.add(resolved);
  }
  return [...imports];
}

function collectReachableCodexModules() {
  const pending = [entryFile];
  const visited = new Set();
  const requiredModules = new Set();

  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current) || !fs.existsSync(current)) continue;
    visited.add(current);
    for (const dependency of collectRelativeImports(current)) {
      if (!fs.existsSync(dependency)) continue;
      pending.push(dependency);
      if (!normalizeSlashes(dependency).startsWith(normalizeSlashes(codexModulesRoot + path.sep))) continue;
      const relative = normalizeSlashes(path.relative(codexModulesRoot, dependency));
      requiredModules.add(`codex-web/${relative}`);
    }
  }

  return [...requiredModules].sort();
}

function collectRegisteredRustModules() {
  const source = readText(rustAssetsFile);
  const registered = new Set();
  const pattern = /"((?:codex-web\/)[^"]+\.js)"\s*=>/g;
  for (const match of source.matchAll(pattern)) {
    registered.add(match[1]);
  }
  return [...registered].sort();
}

const requiredModules = collectReachableCodexModules();
const registeredModules = new Set(collectRegisteredRustModules());
const missingModules = requiredModules.filter((modulePath) => !registeredModules.has(modulePath));

if (missingModules.length) {
  console.error("[check-web-codex-assets] Missing Rust runtime registrations for reachable Web Codex modules:");
  for (const modulePath of missingModules) {
    console.error(`- ${modulePath}`);
  }
  console.error(`Checked entry: ${normalizeSlashes(path.relative(repoRoot, entryFile))}`);
  console.error(`Checked assets table: ${normalizeSlashes(path.relative(repoRoot, rustAssetsFile))}`);
  process.exit(1);
}

console.log(`[check-web-codex-assets] ok (${requiredModules.length} modules registered)`);
