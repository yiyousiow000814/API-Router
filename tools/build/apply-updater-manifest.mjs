import { existsSync } from 'node:fs';
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
const manifestPath = path.resolve(
  root,
  argValue('--manifest') || path.join('src-tauri', 'windows', 'api-router-updater.manifest'),
);

if (!existsSync(exePath)) {
  console.error(`[apply-updater-manifest] missing updater exe: ${exePath}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  console.error(`[apply-updater-manifest] missing updater manifest: ${manifestPath}`);
  process.exit(1);
}

let mtPath;
try {
  mtPath = await resolveMtPath();
} catch (error) {
  console.error(`[apply-updater-manifest] ${error?.message || error}`);
  process.exit(1);
}

const result = spawnSync(mtPath, ['-nologo', '-manifest', manifestPath, `-outputresource:${exePath};#1`], {
  encoding: 'utf8',
  windowsHide: true,
});

if (result.status !== 0) {
  console.error('[apply-updater-manifest] failed to embed updater manifest');
  if (result.stderr) console.error(result.stderr.trim());
  if (result.stdout) console.error(result.stdout.trim());
  process.exit(1);
}

console.log('[apply-updater-manifest] ok');
