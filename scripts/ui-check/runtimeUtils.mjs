import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const repoRoot = path.resolve(__dirname, '..', '..')

export function runOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, windowsHide: true, ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    throw new Error(`Command failed (${res.status}): ${joined}`)
  }
}

export function runQuietOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', shell: false, windowsHide: true, encoding: 'utf-8', ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    const stderr = String(res.stderr || '').trim()
    throw new Error(`Command failed (${res.status}): ${joined}${stderr ? `\n${stderr}` : ''}`)
  }
}

export function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', shell: false, windowsHide: true, ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    throw new Error(`Command failed (${res.status}): ${joined}\n${res.stderr || ''}`)
  }
  return String(res.stdout ?? '')
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

export function findFileRecursive(dir, filenameLower) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFileRecursive(full, filenameLower)
      if (hit) return hit
      continue
    }
    if (e.isFile() && e.name.toLowerCase() === filenameLower) return full
  }
  return null
}

export function getWebView2Version() {
  // WebView2 Runtime (stable) client GUID.
  const guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  const keys = [
    `HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
    `HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
  ]
  for (const k of keys) {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', `if (Test-Path '${k}') { (Get-ItemProperty '${k}').pv }`], {
      cwd: repoRoot,
      shell: false,
      encoding: 'utf-8',
    })
    const v = String(res.stdout ?? '').trim()
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return v
  }
  throw new Error('WebView2 Runtime version not found in registry (expected EdgeUpdate Clients pv).')
}

export function edgeDriverUrl(ver) {
  return `https://msedgedriver.microsoft.com/${ver}/edgedriver_win64.zip`
}

export function urlExists(url) {
  const res = spawnSync('curl.exe', ['-fsI', url], { cwd: repoRoot, shell: false, windowsHide: true })
  return res.status === 0
}

export function pickEdgeDriverVersion() {
  // Prefer an exact-match driver for the installed WebView2 runtime; if not hosted,
  // try lower patch versions within the same major.minor.build.
  const webview2 = getWebView2Version()
  const [maj, min, build, patch] = webview2.split('.').map((x) => Number(x))
  if (![maj, min, build, patch].every((n) => Number.isFinite(n))) throw new Error(`Invalid WebView2 version: ${webview2}`)

  const prefix = `${maj}.${min}.${build}.`
  for (let p = patch; p >= 0; p--) {
    const v = `${prefix}${p}`
    if (urlExists(edgeDriverUrl(v))) return v
  }

  // Last resort: fall back to LATEST_RELEASE_<major>.
  const latestMajor = runCapture('curl.exe', ['-sL', `https://msedgedriver.microsoft.com/LATEST_RELEASE_${maj}`], { cwd: repoRoot })
    .replace(/\u0000/g, '')
    .trim()
  if (/^\d+\.\d+\.\d+\.\d+$/.test(latestMajor) && urlExists(edgeDriverUrl(latestMajor))) return latestMajor

  throw new Error(`Could not find a downloadable EdgeDriver for WebView2 ${webview2} (prefix ${prefix}*).`)
}

export function ensureMsEdgeDriver() {
  if (process.platform !== 'win32') {
    throw new Error('This UI check currently supports Windows only (needs msedgedriver.exe).')
  }

  const driversDir = path.join(repoRoot, 'user-data', 'drivers')
  ensureDir(driversDir)

  // Prefer a pinned path; if it's missing, (re)download.
  const preferred = path.join(driversDir, 'msedgedriver.exe')
  const verFile = path.join(driversDir, 'msedgedriver.version')
  const wantVer = pickEdgeDriverVersion()
  const haveVer = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf-8').trim() : ''
  if (fs.existsSync(preferred) && haveVer === wantVer) return preferred

  const zipPath = path.join(driversDir, `edgedriver_win64_${wantVer}.zip`)
  const url = edgeDriverUrl(wantVer)

  console.log(`[ui:tauri] WebView2=${getWebView2Version()} -> EdgeDriver=${wantVer}`)
  console.log(`[ui:tauri] Downloading msedgedriver ${wantVer}...`)
  runOrThrow('curl.exe', ['-fL', url, '-o', zipPath], { cwd: repoRoot })

  // Use Windows' built-in tar (bsdtar) to extract the .zip.
  runOrThrow('tar.exe', ['-xf', zipPath, '-C', driversDir], { cwd: repoRoot })
  fs.rmSync(zipPath, { force: true })

  const found = findFileRecursive(driversDir, 'msedgedriver.exe')
  if (!found) throw new Error('Downloaded EdgeDriver zip, but msedgedriver.exe not found after extraction.')
  if (found.toLowerCase() !== preferred.toLowerCase()) {
    fs.copyFileSync(found, preferred)
  }
  fs.writeFileSync(verFile, `${wantVer}\n`, 'utf-8')
  return preferred
}

export function resolveTauriAppPath(mode) {
  const dir = mode === 'debug' ? 'debug' : 'release'
  const candidates = [
    path.join(repoRoot, 'src-tauri', 'target', dir, 'api_router.exe'),
    path.join(repoRoot, 'src-tauri', 'target', dir, 'api-router.exe'),
    path.join(repoRoot, 'src-tauri', 'target', dir, 'api_router'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  // Fallback: search for a debug binary in the target folder.
  const targetDir = path.join(repoRoot, 'src-tauri', 'target', dir)
  if (fs.existsSync(targetDir)) {
    const hit = findFileRecursive(targetDir, 'api_router.exe')
    if (hit) return hit
  }
  throw new Error(`Tauri ${mode} binary not found. Did the build step succeed?`)
}

export function sampleBorderLuma(png, rectPx) {
  const { width, height, data } = png
  const x0 = Math.max(0, Math.floor(rectPx.x + 10))
  const x1 = Math.min(width - 1, Math.floor(rectPx.x + rectPx.w - 10))
  const y = Math.min(height - 1, Math.max(0, Math.floor(rectPx.y + rectPx.h - 1)))

  let sum = 0
  let min = 255
  let n = 0

  // Sample 3 rows around the bottom border to reduce 1px rounding issues.
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy
    if (yy < 0 || yy >= height) continue
    for (let x = x0; x <= x1; x++) {
      const idx = (yy * width + x) * 4
      const r = data[idx + 0]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      sum += luma
      if (luma < min) min = luma
      n++
    }
  }

  return { avg: n ? sum / n : 0, min, samples: n }
}

export function killProcessImage(imageName) {
  const res = spawnSync('taskkill.exe', ['/IM', imageName, '/F'], {
    cwd: repoRoot,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  })
  return res.status === 0
}

export function hideWindowByProcessName(processName) {
  if (process.platform !== 'win32') return false
  const ps = `
    $p = Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Select-Object -First 1;
    if (-not $p) { exit 2 }
    $h = $p.MainWindowHandle;
    if ($h -eq 0) { exit 3 }
    Add-Type -Namespace Win32 -Name User32 -MemberDefinition @'
      [System.Runtime.InteropServices.DllImport("user32.dll")]
      public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
'@ -ErrorAction SilentlyContinue | Out-Null;
    [Win32.User32]::ShowWindowAsync($h, 0) | Out-Null;
  `.trim()
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { cwd: repoRoot, shell: false, stdio: 'ignore' })
  return res.status === 0
}

export function startHideWebView2ConsoleWatcher() {
  if (process.platform !== 'win32') return null

  // WebView2 / Chromium sometimes spawns a visible console window that prints logs like
  // "DevTools listening on ...". We can't reliably prevent its creation when running UI automation,
  // so we hide it as soon as it appears.
  const ps = `
    Add-Type -Namespace Win32 -Name User32 -MemberDefinition @'
      using System;
      using System.Text;
      using System.Runtime.InteropServices;
      public static class User32 {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
      }
'@ -ErrorAction SilentlyContinue | Out-Null;

    $deadline = [DateTime]::UtcNow.AddSeconds(25);
    while ([DateTime]::UtcNow -lt $deadline) {
      [Win32.User32]::EnumWindows({
        param($hWnd, $lParam)
        try {
          $len = [Win32.User32]::GetWindowTextLength($hWnd);
          if ($len -le 0) { return $true }
          $sb = New-Object System.Text.StringBuilder ($len + 1);
          [void][Win32.User32]::GetWindowText($hWnd, $sb, $sb.Capacity);
          $title = $sb.ToString();
          if ($title -notlike '*msedgewebview2.exe*') { return $true }

          $csb = New-Object System.Text.StringBuilder 256;
          [void][Win32.User32]::GetClassName($hWnd, $csb, $csb.Capacity);
          $cls = $csb.ToString();
          if ($cls -ne 'ConsoleWindowClass') { return $true }

          # SW_HIDE = 0
          [void][Win32.User32]::ShowWindowAsync($hWnd, 0);
        } catch {}
        return $true
      }, [IntPtr]::Zero) | Out-Null;
      Start-Sleep -Milliseconds 200;
    }
  `.trim()

  // Detached watcher; hidden window; no output.
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', ps],
    { cwd: repoRoot, windowsHide: true, stdio: 'ignore', detached: true },
  )
  child.unref()
  return child.pid
}

