import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

function argValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || '';
  return '';
}

function candidateMtPaths() {
  const paths = [];
  if (process.env.MT) paths.push(process.env.MT);
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const kitsBin = path.join(programFilesX86, 'Windows Kits', '10', 'bin');
  try {
    for (const version of readdirSync(kitsBin).sort().reverse()) {
      paths.push(path.join(kitsBin, version, 'x64', 'mt.exe'));
    }
  } catch {
    // Windows SDK is not installed.
  }
  return paths;
}

function findMt() {
  return candidateMtPaths().find((candidate) => candidate && existsSync(candidate));
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

const mtPath = findMt();
if (!mtPath) {
  console.error('[apply-updater-manifest] mt.exe not found in Windows SDK');
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
