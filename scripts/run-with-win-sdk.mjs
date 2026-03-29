#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

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

async function findRcDir() {
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const kitsBin = join(pf86, "Windows Kits", "10", "bin");
  const preferredVersion = "10.0.26100.0";
  const preferred = join(kitsBin, preferredVersion, "x64", "rc.exe");
  if (await exists(preferred)) return join(kitsBin, preferredVersion, "x64");

  // Fallback: walk a short list of likely SDK versions.
  const candidates = [
    "10.0.26100.0",
    "10.0.22621.0",
    "10.0.22000.0",
    "10.0.19041.0",
  ];
  for (const version of candidates) {
    const rc = join(kitsBin, version, "x64", "rc.exe");
    if (await exists(rc)) return join(kitsBin, version, "x64");
  }
  return null;
}

async function findWinSdkTool(toolName) {
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const kitsBin = join(pf86, "Windows Kits", "10", "bin");
  const preferredVersion = "10.0.26100.0";
  const preferred = join(kitsBin, preferredVersion, "x64", toolName);
  if (await exists(preferred)) return preferred;

  const candidates = [
    "10.0.26100.0",
    "10.0.22621.0",
    "10.0.22000.0",
    "10.0.19041.0",
  ];
  for (const version of candidates) {
    const candidate = join(kitsBin, version, "x64", toolName);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const [command, ...commandArgs] = args;
  const env = { ...process.env };

  if (process.platform === "win32") {
    const rcDir = await findRcDir();
    if (rcDir) {
      const parts = String(env.PATH || "").split(";").filter(Boolean);
      if (!parts.some((part) => part.toLowerCase() === rcDir.toLowerCase())) {
        env.PATH = `${rcDir};${env.PATH || ""}`;
      }
    }
    const rcExe = await findWinSdkTool("rc.exe");
    const mtExe = await findWinSdkTool("mt.exe");
    if (rcExe && !env.RC) env.RC = rcExe;
    if (mtExe && !env.MT) env.MT = mtExe;
  }

  const launch = (cmd) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, commandArgs, {
        stdio: "inherit",
        shell: false,
        env,
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
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

  try {
    const result = await launch(command);
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exit(result.code ?? 1);
  } catch (error) {
    if (process.platform === "win32" && error?.code === "ENOENT" && !/[.](cmd|exe|bat)$/i.test(command)) {
      let result;
      try {
        result = await launch(`${command}.cmd`);
      } catch (inner) {
        if (inner?.code === "EINVAL") {
          result = await launchWithShell(`${command}.cmd`);
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
