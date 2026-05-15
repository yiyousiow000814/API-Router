import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

if (!existsSync(exePath)) {
  console.error(`[check-updater-manifest] missing updater exe: ${exePath}`);
  process.exit(1);
}

const mtPath = findMt();
if (!mtPath) {
  console.error('[check-updater-manifest] mt.exe not found in Windows SDK');
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
