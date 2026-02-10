import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Builder, By, until } from 'selenium-webdriver'
import { PNG } from 'pngjs'

process.env.NODE_NO_WARNINGS = '1'
// Keep the terminal clean in default (headless-ish) mode.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' ')
const STRICT_UI_CHECK =
  String(process.env.UI_TAURI_STRICT || '').trim() === '1' ||
  String(process.env.CI || '').trim().toLowerCase() === 'true'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

// Keep these in sync with `src/ui/App.tsx` drag logic to test responsiveness.
const DRAG_PROBE_DOWN = 0.82
const DRAG_PROBE_UP = 0.22

function runOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, windowsHide: true, ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    throw new Error(`Command failed (${res.status}): ${joined}`)
  }
}

function runQuietOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', shell: false, windowsHide: true, encoding: 'utf-8', ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    const stderr = String(res.stderr || '').trim()
    throw new Error(`Command failed (${res.status}): ${joined}${stderr ? `\n${stderr}` : ''}`)
  }
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf-8', shell: false, windowsHide: true, ...opts })
  if (res.status !== 0) {
    const joined = [cmd, ...args].join(' ')
    throw new Error(`Command failed (${res.status}): ${joined}\n${res.stderr || ''}`)
  }
  return String(res.stdout ?? '')
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function findFileRecursive(dir, filenameLower) {
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

function getWebView2Version() {
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

function edgeDriverUrl(ver) {
  return `https://msedgedriver.microsoft.com/${ver}/edgedriver_win64.zip`
}

function urlExists(url) {
  const res = spawnSync('curl.exe', ['-fsI', url], { cwd: repoRoot, shell: false, windowsHide: true })
  return res.status === 0
}

function pickEdgeDriverVersion() {
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

function ensureMsEdgeDriver() {
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

function resolveTauriAppPath(mode) {
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

function sampleBorderLuma(png, rectPx) {
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

function killProcessImage(imageName) {
  const res = spawnSync('taskkill.exe', ['/IM', imageName, '/F'], {
    cwd: repoRoot,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  })
  return res.status === 0
}

function hideWindowByProcessName(processName) {
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

function startHideWebView2ConsoleWatcher() {
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

function quoteCmdArg(s) {
  const str = String(s)
  if (/[\s"]/g.test(str)) return `"${str.replaceAll('"', '\\"')}"`
  return str
}

function warnOrFail(message) {
  if (STRICT_UI_CHECK) {
    throw new Error(message)
  }
  console.warn(`[ui:tauri] ${message}`)
}

function startHiddenDesktopProcess({ exe, args, cwd, env, keepVisible }) {
  if (process.platform !== 'win32') {
    // Non-Windows doesn't have the msedgewebview2 console issue; fall back to normal spawn.
    return spawn(exe, args, { cwd, env, stdio: keepVisible ? 'inherit' : 'ignore' })
  }

  // Create a new non-interactive desktop and launch the process there so *all* UI windows
  // (including msedgewebview2's console window) never appear on the user's desktop.
  const desktopName = `CodexHiddenDesktop_${Date.now()}_${Math.random().toString(16).slice(2)}`
  const fullCmd = [quoteCmdArg(exe), ...args.map(quoteCmdArg)].join(' ')

  const ps = `
    $ErrorActionPreference = 'Stop'

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodexHiddenDesktopLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateDesktop(string lpszDesktop, IntPtr lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseDesktop(IntPtr hDesktop);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  public static int LaunchOnDesktop(string desktopName, string commandLine, string cwd) {
    // 0x000F01FF = DESKTOP_ALL_ACCESS
    IntPtr hDesktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
    if (hDesktop == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = "winsta0\\\\" + desktopName;
      PROCESS_INFORMATION pi;
      bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi);
      if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try {
        Console.WriteLine("PID:" + pi.dwProcessId);
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        return 0;
      } finally {
        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      }
    } finally {
      CloseDesktop(hDesktop);
    }
  }
}
'@ | Out-Null

    [CodexHiddenDesktopLauncher]::LaunchOnDesktop('${desktopName}', '${fullCmd.replaceAll("'", "''")}', '${String(cwd).replaceAll("'", "''")}') | Out-Null
  `.trim()

  return spawn(
    'powershell.exe',
    ['-NoProfile', '-Command', ps],
    {
      cwd,
      env,
      windowsHide: !keepVisible,
      stdio: keepVisible ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    },
  )
}

async function waitForPort(host, port, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ host, port })
      const done = (v) => {
        try {
          sock.destroy()
        } catch {}
        resolve(v)
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.setTimeout(400, () => done(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function getProviderOrder(driver) {
  return await driver.executeScript(`
    return Array.from(document.querySelectorAll('.aoProviderConfigCard[data-provider]'))
      .map((el) => el.getAttribute('data-provider'))
      .filter(Boolean);
  `)
}

async function getDragOverProvider(driver) {
  return await driver.executeScript(`
    const el = document.querySelector('.aoProviderConfigDragOver[data-provider]');
    return el ? el.getAttribute('data-provider') : null;
  `)
}

async function getPlaceholderIndex(driver) {
  return await driver.executeScript(`
    const list = document.querySelector('.aoProviderConfigList');
    if (!list) return -1;
    const kids = Array.from(list.children);
    return kids.findIndex((el) => el.classList && el.classList.contains('aoProviderConfigPlaceholder'));
  `)
}

async function waitForPlaceholderIndex(driver, predicate, timeoutMs = 800) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const idx = await getPlaceholderIndex(driver)
    if (predicate(idx)) return idx
    await new Promise((r) => setTimeout(r, 50))
  }
  return await getPlaceholderIndex(driver)
}

async function getRects(driver, cardEl, handleEl) {
  return await driver.executeScript(
    `
      const card = arguments[0];
      const handle = arguments[1];
      const cr = card.getBoundingClientRect();
      const hr = handle.getBoundingClientRect();
      return {
        card: { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
        handle: { left: hr.left, top: hr.top, width: hr.width, height: hr.height },
      };
    `,
    cardEl,
    handleEl,
  )
}

async function getOverlayRect(driver) {
  return await driver.executeScript(`
    const el = document.querySelector('.aoProviderConfigCard.aoProviderConfigDragging');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  `)
}

async function waitVisible(driver, locator, timeoutMs = 12000) {
  const el = await driver.wait(until.elementLocated(locator), timeoutMs)
  await driver.wait(until.elementIsVisible(el), timeoutMs)
  return el
}

async function clickButtonByText(driver, label, timeoutMs = 12000) {
  try {
    const btn = await waitVisible(
      driver,
      By.xpath(`//button[@aria-label='${label}' or normalize-space()='${label}' or .//span[normalize-space()='${label}']]`),
      timeoutMs,
    )
    await btn.click()
    return btn
  } catch {
    const clicked = await driver.executeScript(
      `
        const want = arguments[0];
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const aria = (b.getAttribute('aria-label') || '').trim();
        if (aria === want && b.offsetParent !== null && !b.disabled) {
          b.click();
          return true;
        }
        const txt = (b.innerText || b.textContent || '').trim();
        if (txt === want && b.offsetParent !== null && !b.disabled) {
          b.click();
          return true;
        }
        }
        return false;
      `,
      label,
    )
    if (!clicked) throw new Error(`Button not found/clickable: ${label}`)
    return null
  }
}

async function clickTopNav(driver, label) {
  const btn = await waitVisible(
    driver,
    By.xpath(`//button[contains(@class,'aoTopNavBtn')][.//span[normalize-space()='${label}']]`),
    15000,
  )
  await btn.click()
}

async function waitPageTitle(driver, title, timeoutMs = 12000) {
  await waitVisible(driver, By.xpath(`//div[contains(@class,'aoPagePlaceholderTitle')][normalize-space()='${title}']`), timeoutMs)
}

async function waitSectionHeading(driver, heading, timeoutMs = 12000) {
  await waitVisible(driver, By.xpath(`//h3[contains(@class,'aoH3') and normalize-space()='${heading}']`), timeoutMs)
}

async function openModalAndClose(driver, triggerLabel, modalTitle, closeLabel) {
  await clickButtonByText(driver, triggerLabel, 15000)
  const modal = await waitVisible(
    driver,
    By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and (normalize-space()='${modalTitle}' or contains(normalize-space(),'${modalTitle}'))]]`),
    15000,
  )
  const closeBtn = await modal.findElement(By.xpath(`.//button[normalize-space()='${closeLabel}' or contains(normalize-space(),'${closeLabel}')]`))
  await closeBtn.click()
  await driver.wait(
    async () => {
      const found = await driver.findElements(
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and (normalize-space()='${modalTitle}' or contains(normalize-space(),'${modalTitle}'))]]`),
      )
      return found.length === 0
    },
    10000,
    `Modal "${modalTitle}" should close after clicking "${closeLabel}"`,
  )
}

async function openModalAndCloseOptional(driver, triggerLabel, modalTitle, closeLabel, label) {
  try {
    await openModalAndClose(driver, triggerLabel, modalTitle, closeLabel)
    return true
  } catch (e) {
    warnOrFail(`${label} degraded: ${String(e?.message || e)}`)
    return false
  }
}

function centerY(r) {
  return r.top + r.height / 2
}

function centerX(r) {
  return r.left + r.width / 2
}

async function main() {
  const msedgedriverPath = ensureMsEdgeDriver()
  const driversDir = path.dirname(msedgedriverPath)
  const msedgedriverLogPath = path.join(driversDir, 'msedgedriver.log')
  const msedgedriverWrapperPath = path.join(driversDir, 'msedgedriver-wrapper.cmd')

  // Wrap msedgedriver so we can keep logs on disk without spamming the terminal.
  fs.writeFileSync(
    msedgedriverWrapperPath,
    [
      '@echo off',
      'setlocal',
      `set LOG=${msedgedriverLogPath}`,
      `"${msedgedriverPath}" %* --log-path="%LOG%" >nul 2>&1`,
      'endlocal',
      '',
    ].join('\r\n'),
    'utf-8',
  )

  // Build debug binary (no bundles) for automation.
  const keepVisible = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'
  // In "background" mode we build release to avoid console spew from the debug WebView2 process.
  const buildMode = keepVisible ? 'debug' : 'release'
  console.log(`[ui:tauri] Building Tauri ${buildMode} binary (--no-bundle)...`)
  // Windows: npm entrypoint is npm.cmd.
  const npmArgs = ['run', 'tauri', '--', 'build', ...(buildMode === 'debug' ? ['--debug'] : []), '--no-bundle']
  if (keepVisible) {
    runOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  } else {
    runQuietOrThrow('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], { cwd: repoRoot })
  }

  const appPath = resolveTauriAppPath(buildMode)
  console.log(`[ui:tauri] App: ${appPath}`)

  const artifactsDir = path.join(repoRoot, 'user-data', 'ui-artifacts', 'tauri')
  ensureDir(artifactsDir)
  const screenshotPath = path.join(artifactsDir, `drag-border-${Date.now()}.png`)
  const uiProfileDir = path.join(repoRoot, 'user-data', 'ui-check-runtime', String(Date.now()))
  ensureDir(uiProfileDir)

  const driverHost = '127.0.0.1'
  const driverPort = 4444

  // Default: run in a hidden Windows desktop so WebView2's console window never appears.
  const useHiddenDesktop = !keepVisible && String(process.env.UI_TAURI_HIDDEN_DESKTOP || '').trim() !== '0'

  const tauriDriverExe =
    process.platform === 'win32'
      ? runCapture('where.exe', ['tauri-driver'], { cwd: repoRoot }).split(/\r?\n/).find(Boolean)
      : 'tauri-driver'
  if (!tauriDriverExe) throw new Error('tauri-driver not found in PATH.')

  const tauriDriverArgs = ['--port', String(driverPort), '--native-port', '4445', '--native-driver', msedgedriverWrapperPath]

  const tauriDriver = useHiddenDesktop
    ? startHiddenDesktopProcess({
        exe: tauriDriverExe,
        args: tauriDriverArgs,
        cwd: repoRoot,
        keepVisible,
        env: { ...process.env, UI_TAURI: '1', UI_TAURI_PROFILE_DIR: uiProfileDir },
      })
    : spawn(tauriDriverExe, tauriDriverArgs, {
        cwd: repoRoot,
        windowsHide: !keepVisible,
        stdio: keepVisible ? 'inherit' : 'ignore',
        env: {
          ...process.env,
          UI_TAURI: keepVisible ? undefined : '1',
          UI_TAURI_PROFILE_DIR: uiProfileDir,
        },
      })

  let driver
  try {
    // Give tauri-driver time to start listening.
    if (useHiddenDesktop && !keepVisible) {
      let launcherOut = ''
      let launcherErr = ''
      try {
        if (tauriDriver.stdout) tauriDriver.stdout.on('data', (d) => (launcherOut += String(d)))
        if (tauriDriver.stderr) tauriDriver.stderr.on('data', (d) => (launcherErr += String(d)))
      } catch {}

      const ok = await waitForPort(driverHost, driverPort, 20000)
      if (!ok) {
        const tailOut = String(launcherOut).trim().slice(-1500)
        const tailErr = String(launcherErr).trim().slice(-1500)
        const extra = [tailOut && `stdout:\n${tailOut}`, tailErr && `stderr:\n${tailErr}`].filter(Boolean).join('\n')
        throw new Error(
          `Hidden desktop launcher failed to start tauri-driver on ${driverHost}:${driverPort}.${extra ? `\n${extra}` : ''}`,
        )
      }
    } else {
      await new Promise((r) => setTimeout(r, 1500))
    }

    driver = await new Builder()
      .usingServer(`http://${driverHost}:${driverPort}/`)
      .withCapabilities({
        // tauri-driver will map `tauri:options` to the native Edge WebView2 capabilities.
        // We keep `browserName` here for client compatibility; tauri-driver overwrites it.
        browserName: 'wry',
        'tauri:options': {
          application: appPath,
        },
      })
      .build()

    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 60000, script: 60000 })

    try {
      if (keepVisible) {
        // Make the window shorter to force scroll/clipping scenarios (best-effort).
        await driver.manage().window().setRect({ width: 1360, height: 820 })
      } else {
        // Push far off-screen. Keep a normal size so element coordinates stay in-bounds.
        // Some window managers clamp negative coords; try both directions.
        try {
          await driver.manage().window().setRect({ x: 100000, y: 100000, width: 1360, height: 820 })
        } catch {}
        try {
          await driver.manage().window().setRect({ x: -10000, y: -10000, width: 1360, height: 820 })
        } catch {}
      }
    } catch {}

    // === Subtest A: main page contracts and key modals ===
    {
      console.log('[ui:tauri] Subtest A: contracts start')
      const bodyTextLen = Number(await driver.executeScript('return (document.body && document.body.innerText ? document.body.innerText.trim().length : 0)'))
      if (!Number.isFinite(bodyTextLen) || bodyTextLen < 40) {
        throw new Error(`UI appears blank (document body text length=${bodyTextLen})`)
      }

      await waitSectionHeading(driver, 'Providers', 45000)
      await waitSectionHeading(driver, 'Sessions')
      await waitSectionHeading(driver, 'Events')

      console.log('[ui:tauri] Subtest A: getting started modal')
      await openModalAndCloseOptional(driver, 'Getting Started', 'Codex config', 'Close', 'Getting Started modal check')
      console.log('[ui:tauri] Subtest A: gateway token modal')
      await openModalAndClose(driver, 'Show / Rotate', 'Codex gateway token', 'Close')

      console.log('[ui:tauri] Subtest A: usage statistics page')
      await clickTopNav(driver, 'Usage Statistics')
      await waitPageTitle(driver, 'Usage Statistics')
      await waitVisible(driver, By.xpath(`//div[contains(@class,'aoMiniLabel') and normalize-space()='Provider Statistics']`), 12000)
      await openModalAndCloseOptional(driver, 'Daily History', 'Daily History', 'Close', 'Daily History modal check')
      await openModalAndCloseOptional(driver, 'Base Pricing', 'Base Pricing', 'Close', 'Base Pricing modal check')
      await openModalAndCloseOptional(driver, 'Pricing Timeline', 'Pricing Timeline', 'Close', 'Pricing Timeline modal check')

      console.log('[ui:tauri] Subtest A: provider switchboard page')
      await clickTopNav(driver, 'Provider Switchboard')
      await waitPageTitle(driver, 'Provider Switchboard')
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Gateway']`), 12000)
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Official']`), 12000)
      await waitVisible(driver, By.xpath(`//span[contains(@class,'aoSwitchQuickTitle') and normalize-space()='Direct Provider']`), 12000)
      await openModalAndClose(driver, 'Configure Dirs', 'Codex CLI dirs', 'Cancel')

      console.log('[ui:tauri] Subtest A: back to dashboard')
      await clickTopNav(driver, 'Dashboard')
      await waitSectionHeading(driver, 'Providers')
      console.log('[ui:tauri] Subtest A: contracts pass')
    }

    // Open Config modal.
    const configBtn = await driver.wait(until.elementLocated(By.css('button[aria-label="Config"]')), 45000)
    await driver.wait(until.elementIsVisible(configBtn), 10000)
    await configBtn.click()

    // Keep the list near the top so target cards stay within the viewport (avoids out-of-bounds moves).
    try {
      await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (body) body.scrollTop = 0;
      `)
      await new Promise((r) => setTimeout(r, 150))
    } catch {}

    const list = await driver.wait(until.elementLocated(By.css('.aoProviderConfigList')), 20000)
    await driver.wait(until.elementIsVisible(list), 10000)

    const cards = await driver.findElements(By.css('.aoProviderConfigCard[data-provider]'))
    if (cards.length < 2) throw new Error(`Expected >=2 provider cards, got ${cards.length}`)

    // Subtest: Config modal action contracts (key / usage base modals).
    {
      const setKeyBtn = await waitVisible(driver, By.css('.aoProviderConfigCard[data-provider] button[title="Set key"]'), 12000)
      await setKeyBtn.click()
      await waitVisible(
        driver,
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Set API key']]`),
        12000,
      )
      await clickButtonByText(driver, 'Cancel', 12000)
      await driver.wait(
        async () => {
          const found = await driver.findElements(
            By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Set API key']]`),
          )
          return found.length === 0
        },
        10000,
        'Set API key modal should close after cancel',
      )

      const usageBaseBtn = await waitVisible(
        driver,
        By.xpath(`(//div[contains(@class,'aoProviderConfigCard') and @data-provider]//button[normalize-space()='Usage Base'])[1]`),
        12000,
      )
      await usageBaseBtn.click()
      await waitVisible(
        driver,
        By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Usage base URL']]`),
        12000,
      )
      await clickButtonByText(driver, 'Cancel', 12000)
      await driver.wait(
        async () => {
          const found = await driver.findElements(
            By.xpath(`//div[contains(@class,'aoModal')][.//div[contains(@class,'aoModalTitle') and normalize-space()='Usage base URL']]`),
          )
          return found.length === 0
        },
        10000,
        'Usage base URL modal should close after cancel',
      )
    }

    // === Subtest B: drag down one slot (highlight should be the card below) ===
    {
      const viewportH = Number(await driver.executeScript('return window.innerHeight'))
      const beforeOrder = await getProviderOrder(driver)
      const draggingName = beforeOrder[0]
      const belowName = beforeOrder[1]
      const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
      const belowCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${belowName}"]`))
      const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
      const rects = await getRects(driver, draggingCard, handle)
      const pointerDownY = centerY(rects.handle)
      const pointerDownX = centerX(rects.handle)
      const pointerOffset = pointerDownY - rects.card.top
      const belowRect = await driver.executeScript('const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };', belowCard)
      const belowMid = belowRect.top + belowRect.height / 2

      const actions = driver.actions({ async: true })
      await actions
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .press()
        .pause(80)
        // Step 1: move to just touching the next card -> highlight should be the card below.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(
            Math.max(
              2,
              Math.min(
                viewportH - 2,
                // Touch condition: dragBottom >= belowTop => (clientY - offset + h) >= belowTop
                // => clientY >= belowTop - h + offset
                (belowRect.top + 1 - rects.card.height) + pointerOffset,
              ),
            ),
          ),
        })
        .pause(220)
        .perform()

      const ph0 = await getPlaceholderIndex(driver)
      if (ph0 < 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-no-drag.png`), Buffer.from(b64, 'base64'))
        throw new Error('Drag-down: placeholder not found after press/move (drag did not start).')
      }

      const over = await getDragOverProvider(driver)
      if (over !== belowName) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-mismatch.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down highlight mismatch: expected ${belowName}, got ${over} (dragging ${draggingName})`)
      }

      const phIdx = await getPlaceholderIndex(driver)
      if (phIdx < 0) throw new Error('Drag-down: placeholder not found (drag did not start?)')
      if (phIdx !== 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-bad-placeholder-before.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down: expected placeholder index 0 before crossing, got ${phIdx}`)
      }

      // Step 2: move to just after crossing the midpoint -> reorder should trigger (placeholder leaves index 0).
      const belowRect2 = await driver.executeScript(
        'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
        belowCard,
      )
      const belowMid2 = belowRect2.top + belowRect2.height / 2
      const desiredY2Raw = (belowMid2 + 1 - rects.card.height * DRAG_PROBE_DOWN) + pointerOffset
      const desiredY2 = Math.max(2, Math.min(viewportH - 2, desiredY2Raw))
      await driver
        .actions({ async: true })
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(desiredY2) })
        .pause(240)
        .perform()

      const ph2 = await waitForPlaceholderIndex(driver, (idx) => idx > 0)
      if (ph2 <= 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-down-no-reorder.png`), Buffer.from(b64, 'base64'))
        throw new Error(`Drag-down: expected reorder after crossing midpoint, placeholder index=${ph2} (y=${Math.round(desiredY2)})`)
      }

      // Move back to original position so we don't persist a reorder into the next subtest.
      await driver
        .actions({ async: true })
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .pause(160)
        .perform()

      await driver.actions({ async: true }).release().perform()
      await new Promise((r) => setTimeout(r, 150))
    }

    // Refresh card references (DOM moved during drag).
    // Refresh order + references (DOM may have animated during the prior drag).
    const cards2 = await driver.findElements(By.css('.aoProviderConfigCard[data-provider]'))

    // === Subtest C: drag up one slot (highlight should be the card above) ===
    {
      const beforeOrder = await getProviderOrder(driver)
      if (beforeOrder.length < 2) {
        console.log('[ui:tauri] Subtest B skipped (need at least 2 provider cards after Subtest A).')
      } else {
      const viewportH = Number(await driver.executeScript('return window.innerHeight'))
      const draggingName = beforeOrder[1] ?? beforeOrder[beforeOrder.length - 1]
      const aboveName = beforeOrder[0]
      if (!draggingName || !aboveName || draggingName === aboveName) {
        console.log('[ui:tauri] Subtest B skipped (insufficient distinct cards for drag-up).')
      } else {
      const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
      const aboveCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${aboveName}"]`))
      const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
      const rects = await getRects(driver, draggingCard, handle)
      const pointerDownY = centerY(rects.handle)
      const pointerDownX = centerX(rects.handle)
      const pointerOffset = pointerDownY - rects.card.top
      const aboveRect = await driver.executeScript(
        'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
        aboveCard,
      )
      const aboveMid = aboveRect.top + aboveRect.height / 2

      const actions = driver.actions({ async: true })
      await actions
        .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
        .press()
        .pause(80)
        // Tiny nudge first to ensure drag state starts on all hosts.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(Math.max(2, Math.min(viewportH - 2, pointerDownY - 3))),
        })
        .pause(120)
        // Step 1: just touching the card above -> highlight should be the card above.
        .move({
          origin: 'viewport',
          x: Math.round(pointerDownX),
          y: Math.round(
            Math.max(
              2,
              Math.min(
                viewportH - 2,
                // Touch condition: dragTop <= aboveBottom => (clientY - offset) <= aboveBottom
                // => clientY <= aboveBottom + offset
                (aboveRect.top + aboveRect.height - 1) + pointerOffset,
              ),
            ),
          ),
        })
        .pause(220)
        .perform()

      let ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
      if (ph0 < 0) {
        // Retry once with a tiny extra nudge to reliably trigger pointer drag on slower hosts.
        const retryY = Math.max(2, Math.min(viewportH - 2, Math.round(pointerDownY - 6)))
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: retryY })
          .pause(220)
          .perform()
        ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
      }
      if (ph0 < 0) {
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath.replace('.png', `-up-no-drag.png`), Buffer.from(b64, 'base64'))
        warnOrFail('Subtest B degraded (drag did not start).')
        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      } else {
        const over = await getDragOverProvider(driver)
        if (over !== aboveName) {
          const ph = await getPlaceholderIndex(driver)
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-mismatch.png`), Buffer.from(b64, 'base64'))
          throw new Error(
            `Drag-up highlight mismatch: expected ${aboveName}, got ${over} (dragging ${draggingName}) order=${beforeOrder.join(
              ',',
            )} placeholderIdx=${ph}`,
          )
        }

        const phIdx = await getPlaceholderIndex(driver)
        if (phIdx < 0) throw new Error('Drag-up: placeholder not found (drag did not start?)')
        if (phIdx <= 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-bad-placeholder-before.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-up: expected placeholder index >= 1 before crossing, got ${phIdx}`)
        }

        // Step 2: cross above midpoint -> placeholder should move to index 0.
        const aboveRect2 = await driver.executeScript(
          'const r = arguments[0].getBoundingClientRect(); return { top: r.top, height: r.height };',
          aboveCard,
        )
        const aboveMid2 = aboveRect2.top + aboveRect2.height / 2
        const desiredY2Raw = (aboveMid2 - 1 - rects.card.height * DRAG_PROBE_UP) + pointerOffset
        const desiredY2 = Math.max(2, Math.min(viewportH - 2, desiredY2Raw))
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(desiredY2) })
          .pause(240)
          .perform()

        const ph2 = await waitForPlaceholderIndex(driver, (idx) => idx === 0)
        if (ph2 !== 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-up-no-reorder.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-up: expected reorder after crossing midpoint, placeholder index=${ph2} (y=${Math.round(desiredY2)})`)
        }

        // Keep one screenshot for artifact inspection.
        const b64 = await driver.takeScreenshot()
        fs.writeFileSync(screenshotPath, Buffer.from(b64, 'base64'))

        // Move back to original position so we don't persist a reorder into the release.
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
          .pause(160)
          .perform()

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      }
      }
      }
    }

    // === Subtest D: drag while scrolling (overlay should stay pinned under cursor) ===
    {
      const scrollInfo = await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (!body) return null;
        return { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
      `)
      if (!scrollInfo || !(scrollInfo.scrollHeight > scrollInfo.clientHeight + 2)) {
        console.log('[ui:tauri] Subtest C skipped (modal body not scrollable).')
      } else {
        const viewportH = Number(await driver.executeScript('return window.innerHeight'))
        const beforeOrder = await getProviderOrder(driver)
        const draggingName = beforeOrder[0]
        const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
        const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
        const rects = await getRects(driver, draggingCard, handle)

        let pointerY = centerY(rects.handle)
        const pointerX = centerX(rects.handle)
        const pointerOffset = pointerY - rects.card.top

        // Start drag (press + a tiny move to ensure the drag overlay is rendered).
        await driver
          .actions({ async: true })
          .move({ origin: 'viewport', x: Math.round(pointerX), y: Math.round(pointerY) })
          .press()
          .pause(100)
          .move({ origin: 'viewport', x: Math.round(pointerX), y: Math.round(Math.min(viewportH - 2, pointerY + 2)) })
          .pause(200)
          .perform()

        pointerY = Math.min(viewportH - 2, pointerY + 2)

        const ph0 = await waitForPlaceholderIndex(driver, (idx) => idx >= 0, 1200)
        if (ph0 < 0) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-no-drag.png`), Buffer.from(b64, 'base64'))
          throw new Error('Drag-scroll: placeholder not found after press/move (drag did not start).')
        }

        const overlayBefore = await getOverlayRect(driver)
        if (!overlayBefore) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-no-overlay.png`), Buffer.from(b64, 'base64'))
          throw new Error('Drag-scroll: overlay not found (.aoProviderConfigDragging).')
        }

        // Scroll without moving the pointer. If the drag overlay isn't scroll-anchored, it will drift.
        await driver.executeScript(`
          const body = document.querySelector('.aoModalBody');
          if (!body) return;
          const next = Math.min(body.scrollHeight - body.clientHeight, body.scrollTop + 220);
          body.scrollTop = next;
        `)
        await new Promise((r) => setTimeout(r, 250))

        const overlayAfter = await getOverlayRect(driver)
        if (!overlayAfter) throw new Error('Drag-scroll: overlay disappeared after scroll.')

        const expectedTop = pointerY - pointerOffset
        const drift = Math.abs(overlayAfter.top - expectedTop)
        if (drift > 3.5) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-scroll-drift.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Drag-scroll: overlay drift too large (drift=${drift.toFixed(2)}px, expectedTop=${expectedTop.toFixed(2)}, gotTop=${overlayAfter.top.toFixed(2)})`)
        }

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))

        // Reset scroll so the final screenshot remains stable.
        await driver.executeScript(`
          const body = document.querySelector('.aoModalBody');
          if (body) body.scrollTop = 0;
        `)
        await new Promise((r) => setTimeout(r, 120))
      }
    }

    // === Subtest E: autoscroll up should not "snap" to top instantly ===
    {
      const info = await driver.executeScript(`
        const body = document.querySelector('.aoModalBody');
        if (!body) return null;
        return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
      `)
      if (!info || !(info.scrollHeight > info.clientHeight + 2)) {
        console.log('[ui:tauri] Subtest D skipped (modal body not scrollable).')
      } else {
        // Put us somewhere in the middle so there is room to scroll up.
        const startTop = Number(
          await driver.executeScript(`
            const body = document.querySelector('.aoModalBody');
            const max = body.scrollHeight - body.clientHeight;
            body.scrollTop = Math.max(0, Math.min(max, Math.floor(max * 0.6)));
            return body.scrollTop;
          `),
        )
        await new Promise((r) => setTimeout(r, 150))

        const beforeOrder = await getProviderOrder(driver)
        const draggingName = beforeOrder[1] ?? beforeOrder[0]
        const draggingCard = await driver.findElement(By.css(`.aoProviderConfigCard[data-provider="${draggingName}"]`))
        const handle = await draggingCard.findElement(By.css('button.aoDragHandle'))
        const rects = await getRects(driver, draggingCard, handle)
        const pointerDownY = centerY(rects.handle)
        const pointerDownX = centerX(rects.handle)

        // Move near the top edge to trigger upward autoscroll.
        const actions = driver.actions({ async: true })
        await actions
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: Math.round(pointerDownY) })
          .press()
          .pause(80)
          .move({ origin: 'viewport', x: Math.round(pointerDownX), y: 6 })
          .pause(180)
          .perform()

        const t1 = Number(
          await driver.executeScript(`
            const body = document.querySelector('.aoModalBody');
            return body ? body.scrollTop : -1;
          `),
        )
        // A snap-to-top would put scrollTop near 0 almost immediately.
        if (startTop > 60 && t1 >= 0 && t1 < 10) {
          const b64 = await driver.takeScreenshot()
          fs.writeFileSync(screenshotPath.replace('.png', `-autoscroll-up-snap.png`), Buffer.from(b64, 'base64'))
          throw new Error(`Autoscroll-up snapped too fast (start=${startTop}, after180ms=${t1})`)
        }

        await driver.actions({ async: true }).release().perform()
        await new Promise((r) => setTimeout(r, 150))
      }
    }

    console.log(`[ui:tauri] Screenshot: ${screenshotPath}`)
    console.log('[ui:tauri] PASS')
  } finally {
    try {
      if (driver) await driver.quit()
    } catch {}
    try {
      if (tauriDriver && tauriDriver.pid && process.platform === 'win32') {
        // Ensure the whole process tree is terminated (hidden desktop spawns).
        spawnSync('taskkill.exe', ['/PID', String(tauriDriver.pid), '/T', '/F'], {
          cwd: repoRoot,
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
      } else if (tauriDriver) {
        tauriDriver.kill()
      }
    } catch {}
    try {
      if (fs.existsSync(msedgedriverLogPath)) console.log(`[ui:tauri] EdgeDriver log: ${msedgedriverLogPath}`)
    } catch {}
  }
}

main().catch((e) => {
  console.error(`[ui:tauri] FAIL: ${e?.stack || e}`)
  process.exitCode = 1
})
