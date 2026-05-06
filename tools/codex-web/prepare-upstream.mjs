import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import https from 'node:https'

const repoRoot = process.cwd()
const codexWebRoot = path.join(repoRoot, 'third_party', 'codex-web')
const codexWebNodeModules = path.join(codexWebRoot, 'node_modules')
const scratchRoot = path.join(codexWebRoot, 'scratch')
const asarRoot = path.join(scratchRoot, 'asar')
const webviewRoot = path.join(asarRoot, 'webview')
const tempExtractRoot = path.join('C:\\', 'ar-cw')
const tempZipExtractRoot = path.join(tempExtractRoot, 'zip')
const defaultHostedZipUrl =
  process.env.CODEX_WEB_HOSTED_ZIP_URL ||
  'https://persistent.oaistatic.com/codex-app-prod/Codex-darwin-arm64-26.422.71525.zip'
const hostedZipEnv = process.env.HOSTED_CODEX_APP_ZIP || ''
const windowsAsarOverride = process.env.CODEX_WEB_WINDOWS_APP_ASAR || ''

function ensureTool(name, command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', windowsHide: true })
  } catch {
    throw new Error(`Missing required tool: ${name}`)
  }
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  })
}

function runCapture(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath)
    https
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close()
          fs.rmSync(targetPath, { force: true })
          downloadFile(response.headers.location, targetPath).then(resolve, reject)
          return
        }
        if (response.statusCode !== 200) {
          file.close()
          fs.rmSync(targetPath, { force: true })
          reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage || ''}`.trim()))
          return
        }
        response.pipe(file)
        file.on('finish', () => {
          file.close()
          resolve()
        })
      })
      .on('error', (error) => {
        file.close()
        fs.rmSync(targetPath, { force: true })
        reject(error)
      })
  })
}

function copyDirContents(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const name of fs.readdirSync(fromDir)) {
    const source = path.join(fromDir, name)
    const target = path.join(toDir, name)
    fs.cpSync(source, target, { recursive: true, force: true })
  }
}

function collectPatchedFiles(patchesDir) {
  const patchedFiles = new Set()
  for (const entry of fs.readdirSync(patchesDir)) {
    if (!entry.endsWith('.patch')) continue
    const body = fs.readFileSync(path.join(patchesDir, entry), 'utf8')
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('+++ b/')) continue
      patchedFiles.add(path.join(asarRoot, line.slice('+++ b/'.length)))
    }
  }
  return [...patchedFiles]
}

function chunk(values, size) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function applyPatchFile(patchName) {
  const patchFile = path.join(codexWebRoot, 'patches', patchName)
  const patchBody = fs.readFileSync(patchFile, 'utf8')
  execFileSync('git', ['apply', '--whitespace=nowarn', '--directory', asarRoot, '-'], {
    cwd: codexWebRoot,
    input: patchBody,
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  })
}

function enforcePreparedMobileWindowType() {
  const assetsRoot = path.join(webviewRoot, 'assets')
  const indexBundleName = fs
    .readdirSync(assetsRoot)
    .find((name) => name.startsWith('index-') && name.endsWith('.js'))
  if (!indexBundleName) {
    throw new Error(`Unable to find prepared webview index bundle under ${assetsRoot}`)
  }

  const indexBundlePath = path.join(assetsRoot, indexBundleName)
  let source = fs.readFileSync(indexBundlePath, 'utf8')
  const resolver = 'window.electronBridge?.windowType ?? window.codexWindowType ?? `electron`'
  const resolvedWindowTypeVar = '__apiRouterCodexWindowType'

  if (!source.includes(resolvedWindowTypeVar)) {
    source = source.replace(
      /var Kj = Fn\(\),\s*qj = new URL\(window\.location\.href\)\.searchParams;/,
      `var Kj = Fn(),\n  qj = new URL(window.location.href).searchParams,\n  ${resolvedWindowTypeVar} = ${resolver};`,
    )
    source = source.replace(
      'document.documentElement.dataset.codexWindowType = `electron`',
      `document.documentElement.dataset.codexWindowType = ${resolvedWindowTypeVar}`,
    )
    source = source.replace(
      'document.documentElement.dataset.windowType = `electron`',
      `document.documentElement.dataset.windowType = ${resolvedWindowTypeVar}`,
    )
  }

  if (
    source.includes('document.documentElement.dataset.codexWindowType = `electron`') ||
    source.includes('document.documentElement.dataset.windowType = `electron`') ||
    !source.includes(resolvedWindowTypeVar)
  ) {
    throw new Error(
      `Failed to enforce mobile window type bridge in prepared bundle ${indexBundlePath}`,
    )
  }

  fs.writeFileSync(indexBundlePath, source)
}

function resolveAppAsarPath() {
  const macAsar = path.join(tempZipExtractRoot, 'app.asar')
  if (fs.existsSync(macAsar)) {
    return macAsar
  }
  throw new Error(`Unsupported hosted app archive layout. Expected extracted app.asar at ${macAsar}`)
}

function extractMacAppAsarFromZip(zipPath, outputPath) {
  const command = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try {
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'Codex.app/Contents/Resources/app.asar' } | Select-Object -First 1
  if ($null -eq $entry) { throw 'Codex.app/Contents/Resources/app.asar not found in hosted zip' }
  $outDir = Split-Path -Parent '${outputPath.replace(/'/g, "''")}'
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${outputPath.replace(/'/g, "''")}', $true)
}
finally {
  $zip.Dispose()
}`.trim()
  run('powershell.exe', ['-NoProfile', '-Command', command], codexWebRoot)
}

function detectInstalledWindowsCodexAsar() {
  if (windowsAsarOverride.trim()) {
    return windowsAsarOverride.trim()
  }
  try {
    const command = `
$pkg = Get-AppxPackage OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $pkg) { return }
$asar = Join-Path $pkg.InstallLocation 'app\\resources\\app.asar'
if (Test-Path -LiteralPath $asar) { Write-Output $asar }
`.trim()
    return String(
      runCapture('powershell.exe', ['-NoProfile', '-Command', command], codexWebRoot) || '',
    ).trim()
  } catch {
    return ''
  }
}

function detectInstalledWindowsCodexResourcesDir() {
  const asarPath = detectInstalledWindowsCodexAsar()
  if (!asarPath) {
    return ''
  }
  return path.dirname(asarPath)
}

ensureTool('git', 'git')
ensureTool('node', 'node')

if (fs.existsSync(scratchRoot)) {
  fs.rmSync(scratchRoot, { recursive: true, force: true })
}
fs.mkdirSync(scratchRoot, { recursive: true })
if (fs.existsSync(tempExtractRoot)) {
  fs.rmSync(tempExtractRoot, { recursive: true, force: true })
}
fs.mkdirSync(tempExtractRoot, { recursive: true })
fs.mkdirSync(tempZipExtractRoot, { recursive: true })

const hostedZip = hostedZipEnv.trim() || path.join(scratchRoot, 'hosted-codex-app.zip')
const installedWindowsAsar = detectInstalledWindowsCodexAsar()
if (installedWindowsAsar) {
  console.log(`Using installed Windows Codex app.asar from ${installedWindowsAsar}`)
  fs.copyFileSync(installedWindowsAsar, path.join(tempZipExtractRoot, 'app.asar'))
  const resourcesDir = detectInstalledWindowsCodexResourcesDir()
  const unpackedDir = resourcesDir ? path.join(resourcesDir, 'app.asar.unpacked') : ''
  if (unpackedDir && fs.existsSync(unpackedDir)) {
    fs.cpSync(unpackedDir, path.join(tempZipExtractRoot, 'app.asar.unpacked'), {
      recursive: true,
      force: true,
    })
  }
} else {
  if (!hostedZipEnv.trim()) {
    console.log(`Downloading upstream Codex app zip from ${defaultHostedZipUrl}`)
    await downloadFile(defaultHostedZipUrl, hostedZip)
  }
  extractMacAppAsarFromZip(hostedZip, path.join(tempZipExtractRoot, 'app.asar'))
}

const appAsar = resolveAppAsarPath()
run(
  'node',
  [path.join(codexWebNodeModules, '@electron', 'asar', 'bin', 'asar.mjs'), 'extract', appAsar, asarRoot],
  codexWebRoot,
)

copyDirContents(path.join(codexWebRoot, 'assets'), webviewRoot)
const bridgeCompatSource = path.join(codexWebRoot, 'assets', 'electronBridge-compat.js')
const bridgeCompatTarget = path.join(webviewRoot, 'assets', 'electronBridge-compat.js')
if (fs.existsSync(bridgeCompatSource)) {
  fs.mkdirSync(path.dirname(bridgeCompatTarget), { recursive: true })
  fs.copyFileSync(bridgeCompatSource, bridgeCompatTarget)
}

const patchedFiles = collectPatchedFiles(path.join(codexWebRoot, 'patches'))
if (patchedFiles.length > 0) {
  const prettierBin = path.join(codexWebNodeModules, 'prettier', 'bin', 'prettier.cjs')
  const existingPatchedFiles = patchedFiles.filter((filePath) => fs.existsSync(filePath))
  for (const batch of chunk(existingPatchedFiles, 4)) {
    run('node', [prettierBin, '--ignore-path', 'NUL', '--ignore-unknown', '--write', ...batch], codexWebRoot)
  }
}

const orderedPatches = [
  'webview-remove-csp.patch',
  'webview-style.patch',
  'webview-preload.patch',
  'webview-favicon.patch',
  'webview-pwa.patch',
  'webview-mobile-window-type.patch',
  'webview-thread-title.patch',
  'webview-initial-route.patch',
  'webview-electron-shim-close-sidebar.patch',
  'webview-artifacts-pane.patch',
  'webview-prosemirror-inputmode.patch',
  'webview-use-atfs-for-local-files.patch',
  'webview-prompt-search-param.patch',
  'sentry-disable-shell.patch',
  'sentry-disable-webview.patch',
]

for (const patchName of orderedPatches) {
  applyPatchFile(patchName)
}

enforcePreparedMobileWindowType()

const betterSqliteRoot = path.join(asarRoot, 'node_modules', 'better-sqlite3')
if (fs.existsSync(betterSqliteRoot)) {
  fs.rmSync(betterSqliteRoot, { recursive: true, force: true })
}

if (fs.existsSync(tempExtractRoot)) {
  fs.rmSync(tempExtractRoot, { recursive: true, force: true })
}

console.log(`Prepared upstream codex-web assets in ${asarRoot}`)
