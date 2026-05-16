import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveWindowsSdkTool } from '../windows/win-sdk-env.mjs';

const root = process.cwd();

function argValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || '';
  return '';
}

async function resolveMtPath() {
  if (process.env.MT && existsSync(process.env.MT)) {
    return process.env.MT;
  }
  const result = await resolveWindowsSdkTool('mt.exe');
  if (!result.path) {
    const checked = Array.isArray(result.checkedPaths) && result.checkedPaths.length
      ? ` Checked: ${result.checkedPaths.join(', ')}`
      : '';
    throw new Error(`mt.exe not found in Windows SDK.${checked}`);
  }
  return result.path;
}

const exePath = path.resolve(
  root,
  argValue('--exe') || path.join('src-tauri', 'target', 'release', 'api_router_updater.exe'),
);

if (!existsSync(exePath)) {
  console.error(`[check-updater-manifest] missing updater exe: ${exePath}`);
  process.exit(1);
}

let mtPath;
try {
  mtPath = await resolveMtPath();
} catch (error) {
  console.error(`[check-updater-manifest] ${error?.message || error}`);
  process.exit(1);
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'api-router-updater-manifest-'));
const manifestPath = path.join(tempDir, 'manifest.xml');

try {
  const result = spawnSync(mtPath, ['-nologo', `-inputresource:${exePath};#1`, `-out:${manifestPath}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !existsSync(manifestPath)) {
    console.error('[check-updater-manifest] failed to extract updater manifest');
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
    process.exit(1);
  }
  const manifest = readFileSync(manifestPath, 'utf8');
  if (!/<requestedExecutionLevel\b[^>]*\blevel=["']asInvoker["']/i.test(manifest)) {
    console.error('[check-updater-manifest] updater manifest must request asInvoker execution level');
    process.exit(1);
  }
  console.log('[check-updater-manifest] ok');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
