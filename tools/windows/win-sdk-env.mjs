import { readdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const DEFAULT_PREFERRED_VERSIONS = [
  "10.0.26100.0",
  "10.0.22621.0",
  "10.0.22000.0",
  "10.0.19041.0",
];

export function findEnvKey(env, name) {
  const lowered = String(name).toLowerCase();
  return Object.keys(env).find((key) => key.toLowerCase() === lowered) || null;
}

export function getEnvValue(env, name) {
  const key = findEnvKey(env, name);
  return key ? env[key] : undefined;
}

export function setEnvValue(env, name, value) {
  const existingKey = findEnvKey(env, name);
  if (existingKey && existingKey !== name) {
    delete env[existingKey];
  }
  env[name] = value;
}

export function prependPathEntry(env, entry) {
  if (!entry) return;
  const pathKey = findEnvKey(env, "PATH") || "PATH";
  const current = String(env[pathKey] || "");
  const parts = current.split(";").filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === String(entry).toLowerCase())) {
    const next = [entry, ...parts].join(";");
    setEnvValue(env, pathKey, next);
    if (pathKey !== "PATH") {
      env.PATH = next;
    }
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeSdkVersion(rawVersion) {
  return String(rawVersion || "").trim().replace(/[\\/]+$/, "");
}

async function listInstalledSdkVersions(kitsBin) {
  try {
    const entries = await readdir(kitsBin, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
      )
      .reverse();
  } catch {
    return [];
  }
}

export async function resolveWindowsSdkBinDir(options = {}) {
  const env = options.env || process.env;
  const preferredVersions = options.preferredVersions || DEFAULT_PREFERRED_VERSIONS;
  const pf86 = getEnvValue(env, "ProgramFiles(x86)") || "C:\\Program Files (x86)";
  const kitsBin = join(pf86, "Windows Kits", "10", "bin");
  const sdkDir = getEnvValue(env, "WindowsSdkDir");
  const sdkVersion = normalizeSdkVersion(getEnvValue(env, "WindowsSDKVersion"));
  const checked = [];

  const candidates = [];
  if (sdkDir && sdkVersion) {
    candidates.push(join(sdkDir, "bin", sdkVersion, "x64"));
  }
  for (const version of preferredVersions) {
    candidates.push(join(kitsBin, version, "x64"));
  }
  const discoveredVersions = await listInstalledSdkVersions(kitsBin);
  for (const version of discoveredVersions) {
    candidates.push(join(kitsBin, version, "x64"));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = String(candidate);
    const key = normalizedCandidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rcPath = join(normalizedCandidate, "rc.exe");
    checked.push(rcPath);
    if (await exists(rcPath)) {
      return {
        binDir: normalizedCandidate,
        rcPath,
        mtPath: join(normalizedCandidate, "mt.exe"),
        checkedPaths: checked,
      };
    }
  }

  return {
    binDir: null,
    rcPath: null,
    mtPath: null,
    checkedPaths: checked,
  };
}

export async function resolveWindowsSdkTool(toolName, options = {}) {
  const result = await resolveWindowsSdkBinDir(options);
  if (!result.binDir) {
    return {
      path: null,
      checkedPaths: result.checkedPaths.map((path) =>
        path.replace(/rc\.exe$/i, toolName),
      ),
    };
  }
  const toolPath = join(result.binDir, toolName);
  if (await exists(toolPath)) {
    return {
      path: toolPath,
      checkedPaths: [toolPath],
    };
  }
  return {
    path: null,
    checkedPaths: [toolPath],
  };
}

export function formatWindowsSdkProbeSummary(result) {
  const checked = Array.isArray(result?.checkedPaths) ? result.checkedPaths : [];
  return [
    `bin_dir=${result?.binDir || "<none>"}`,
    `rc=${result?.rcPath || "<none>"}`,
    `mt=${result?.mtPath || "<none>"}`,
    `checked=${checked.length ? checked.join(", ") : "<none>"}`,
  ].join("; ");
}
