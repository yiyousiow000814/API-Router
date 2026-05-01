#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  findEnvKey,
  getEnvValue,
  prependPathEntry,
  resolveWindowsSdkBinDir,
  resolveWindowsSdkTool,
  setEnvValue,
} from "./win-sdk-env.mjs";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("[run-with-win-sdk] Missing command.");
  process.exit(2);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalNodeBin(command) {
  if (!command || command.includes("\\") || command.includes("/") || command.includes(":")) {
    return command;
  }
  const suffixes =
    process.platform === "win32"
      ? [".cmd", ".exe", ".bat", ".ps1", ""]
      : [""];
  for (const suffix of suffixes) {
    const candidate = join(process.cwd(), "node_modules", ".bin", `${command}${suffix}`);
    if (await exists(candidate)) return candidate;
  }
  return command;
}

function parseCmdEnvDump(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    env[key] = line.slice(idx + 1);
  }
  return env;
}

function mergeEnvCaseInsensitive(target, source) {
  for (const [key, value] of Object.entries(source)) {
    setEnvValue(target, key, value);
  }
}

const VS_DEV_CMD_ENV_ALLOWLIST = new Set([
  "ExtensionSdkDir",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "Path",
  "UniversalCRTSdkDir",
  "UCRTVersion",
  "VCINSTALLDIR",
  "VCToolsInstallDir",
  "VCToolsRedistDir",
  "VSINSTALLDIR",
  "WindowsLibPath",
  "WindowsSdkBinPath",
  "WindowsSdkDir",
  "WindowsSDKLibVersion",
  "WindowsSDKVersion",
]);

function pickVsBuildEnv(source) {
  const picked = {};
  const allowedKeys = Array.from(VS_DEV_CMD_ENV_ALLOWLIST);
  for (const [key, value] of Object.entries(source)) {
    if (allowedKeys.some((name) => name.toLowerCase() === key.toLowerCase())) {
      picked[key] = value;
    }
  }
  return picked;
}

function findVsDevCmdCandidates() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2019\\Community\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2019\\Professional\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2019\\Enterprise\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\Tools\\VsDevCmd.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\Tools\\VsDevCmd.bat",
  ];
  return candidates;
}

function loadVsDevCmdEnv(currentEnv) {
  for (const candidate of findVsDevCmdCandidates()) {
    try {
      const dump = execFileSync(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          `"call "${candidate}" -arch=x64 -host_arch=x64 >nul && set"`,
        ],
        {
          encoding: "utf8",
          env: currentEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const parsed = parseCmdEnvDump(dump);
      if (parsed.WindowsSdkDir || parsed.WindowsSDKVersion || parsed.VCToolsInstallDir) {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function main() {
  const [command, ...commandArgs] = args;
  const env = { ...process.env };
  const resolvedCommand = await resolveLocalNodeBin(command);

  if (process.platform === "win32") {
    const nodeDir = dirname(process.execPath);
    prependPathEntry(env, nodeDir);
    const userProfile = getEnvValue(env, "USERPROFILE") || "";
    const cargoDir = join(userProfile, ".cargo", "bin");
    prependPathEntry(env, cargoDir);
    const vsDevEnv = loadVsDevCmdEnv(env);
    if (vsDevEnv) {
      mergeEnvCaseInsensitive(env, pickVsBuildEnv(vsDevEnv));
    }
    const sdkProbe = await resolveWindowsSdkBinDir({ env });
    prependPathEntry(env, sdkProbe.binDir);
    const rcTool = await resolveWindowsSdkTool("rc.exe", { env });
    const mtTool = await resolveWindowsSdkTool("mt.exe", { env });
    const rcExe = rcTool.path;
    const mtExe = mtTool.path;
    if (rcExe && !getEnvValue(env, "RC")) {
      setEnvValue(env, "RC", rcExe);
      setEnvValue(env, "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RC", rcExe);
    }
    if (mtExe && !getEnvValue(env, "MT")) {
      setEnvValue(env, "MT", mtExe);
      setEnvValue(env, "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_MT", mtExe);
    }
    if (process.env.API_ROUTER_WIN_SDK_TRACE === "1") {
      const checkedPaths = [...(sdkProbe.checkedPaths || []), ...(mtTool.checkedPaths || [])]
        .filter(Boolean)
        .join(", ");
      console.error(
        `[run-with-win-sdk] sdk bin=${sdkProbe.binDir || "<none>"} rc=${rcExe || "<none>"} mt=${mtExe || "<none>"} checked=${checkedPaths || "<none>"}`,
      );
    }
  }

  const launch = (cmd) =>
    new Promise((resolve, reject) => {
      const useShell =
        process.platform === "win32" && /[.](cmd|bat|ps1)$/i.test(String(cmd));
      const child = spawn(cmd, commandArgs, {
        stdio: "inherit",
        shell: useShell,
        env,
        windowsHide: true,
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  const launchWithShell = (cmd) =>
    new Promise((resolve, reject) => {
      const joinedArgs = commandArgs.map((v) => (/\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v)).join(" ");
      const shellCmd = joinedArgs ? `${cmd} ${joinedArgs}` : cmd;
      const child = spawn(shellCmd, {
        stdio: "inherit",
        shell: true,
        env,
        windowsHide: true,
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

  try {
    const result = await launch(resolvedCommand);
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exit(result.code ?? 1);
  } catch (error) {
    if (
      process.platform === "win32" &&
      error?.code === "ENOENT" &&
      !/[.](cmd|exe|bat)$/i.test(resolvedCommand)
    ) {
      let result;
      try {
        result = await launch(`${resolvedCommand}.cmd`);
      } catch (inner) {
        if (inner?.code === "EINVAL") {
          result = await launchWithShell(`${resolvedCommand}.cmd`);
        } else {
          throw inner;
        }
      }
      if (result.signal) {
        process.kill(process.pid, result.signal);
        return;
      }
      process.exit(result.code ?? 1);
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`[run-with-win-sdk] ${error?.message || error}`);
  process.exit(1);
});
