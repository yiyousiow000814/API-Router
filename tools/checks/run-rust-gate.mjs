#!/usr/bin/env node
import { spawn } from "node:child_process";

const cargoArgs = process.argv.slice(2);
if (!cargoArgs.length) {
  console.error("[run-rust-gate] Missing cargo arguments.");
  process.exit(2);
}

const env = {
  ...process.env,
  RUSTFLAGS: [process.env.RUSTFLAGS, "-D warnings"].filter(Boolean).join(" "),
};

const command =
  process.platform === "win32" ? process.execPath : "cargo";
const args =
  process.platform === "win32"
    ? ["tools/windows/run-with-win-sdk.mjs", "cargo", ...cargoArgs]
    : cargoArgs;

const child = spawn(command, args, {
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  console.error(`[run-rust-gate] ${error?.message || error}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
