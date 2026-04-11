import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatWindowsSdkProbeSummary,
  resolveWindowsSdkBinDir,
  resolveWindowsSdkTool,
} from "./win-sdk-env.mjs";

describe("resolveWindowsSdkBinDir", () => {
  it("prefers WindowsSdkDir and WindowsSDKVersion when rc.exe exists there", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-router-win-sdk-"));
    const sdkRoot = join(root, "kits");
    const sdkBin = join(sdkRoot, "bin", "10.0.99999.0", "x64");
    await mkdir(sdkBin, { recursive: true });
    await writeFile(join(sdkBin, "rc.exe"), "");
    await writeFile(join(sdkBin, "mt.exe"), "");

    const result = await resolveWindowsSdkBinDir({
      env: {
        "ProgramFiles(x86)": root,
        WindowsSdkDir: sdkRoot,
        WindowsSDKVersion: "10.0.99999.0\\",
      },
      preferredVersions: [],
    });

    expect(result.binDir).toBe(sdkBin);
    expect(result.rcPath).toBe(join(sdkBin, "rc.exe"));
    expect(result.mtPath).toBe(join(sdkBin, "mt.exe"));
    expect(result.checkedPaths[0]).toBe(join(sdkBin, "rc.exe"));
  });

  it("falls back to the newest discovered Windows Kits version", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-router-win-sdk-"));
    const kitsBin = join(root, "Windows Kits", "10", "bin");
    const oldBin = join(kitsBin, "10.0.19041.0", "x64");
    const newBin = join(kitsBin, "10.0.30000.0", "x64");
    await mkdir(oldBin, { recursive: true });
    await mkdir(newBin, { recursive: true });
    await writeFile(join(oldBin, "rc.exe"), "");
    await writeFile(join(newBin, "rc.exe"), "");

    const result = await resolveWindowsSdkBinDir({
      env: { "ProgramFiles(x86)": root },
      preferredVersions: [],
    });

    expect(result.binDir).toBe(newBin);
    expect(result.checkedPaths[0]).toBe(join(newBin, "rc.exe"));
  });

  it("returns checked paths for missing tool probes", async () => {
    const root = await mkdtemp(join(tmpdir(), "api-router-win-sdk-"));
    const tool = await resolveWindowsSdkTool("rc.exe", {
      env: { "ProgramFiles(x86)": root },
      preferredVersions: ["10.0.26100.0"],
    });

    expect(tool.path).toBeNull();
    expect(tool.checkedPaths).toContain(
      join(root, "Windows Kits", "10", "bin", "10.0.26100.0", "x64", "rc.exe"),
    );
  });

  it("formats probe summaries with checked paths", () => {
    const summary = formatWindowsSdkProbeSummary({
      binDir: "C:\\sdk\\bin\\x64",
      rcPath: "C:\\sdk\\bin\\x64\\rc.exe",
      mtPath: "C:\\sdk\\bin\\x64\\mt.exe",
      checkedPaths: ["C:\\sdk\\bin\\x64\\rc.exe"],
    });

    expect(summary).toContain("bin_dir=C:\\sdk\\bin\\x64");
    expect(summary).toContain("checked=C:\\sdk\\bin\\x64\\rc.exe");
  });
});
