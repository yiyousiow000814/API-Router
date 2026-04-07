import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { Builder, By } from 'selenium-webdriver'
import edge from 'selenium-webdriver/edge.js'
import { ensureMsEdgeDriver, repoRoot } from '../../support/runtime-utils.mjs'

const BASE_URL = String(process.env.CODEX_WEB_URL || 'http://127.0.0.1:5173/codex-web?e2e=1').trim()
const KEEP_VISIBLE = String(process.env.UI_TAURI_VISIBLE || '').trim() === '1'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await predicate()
    if (ok) return true
    // eslint-disable-next-line no-await-in-loop
    await sleep(100)
  }
  throw new Error(`Timeout waiting for ${label}`)
}

async function canReach(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    clearTimeout(timer)
    return res.ok || res.status === 401 || res.status === 403
  } catch {
    return false
  }
}

function killProcessTree(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {}
}

async function ensureDevServerReady() {
  if (await canReach(BASE_URL)) return null
  const devProc = spawn(
    'cmd.exe',
    ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'],
    {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      stdio: KEEP_VISIBLE ? 'inherit' : 'ignore',
      env: { ...process.env, BROWSER: 'none' },
    },
  )
  await waitFor(() => canReach(BASE_URL), 45000, `dev server ${BASE_URL}`)
  return devProc
}

async function main() {
  const devProc = await ensureDevServerReady()
  let driver = null
  try {
    const msedgedriverPath = ensureMsEdgeDriver()
    const options = new edge.Options()
    options.addArguments('--window-size=390,900')
    if (!KEEP_VISIBLE) {
      options.addArguments('--headless=new')
      options.addArguments('--disable-gpu')
    }

    driver = await new Builder()
      .forBrowser('MicrosoftEdge')
      .setEdgeOptions(options)
      .setEdgeService(new edge.ServiceBuilder(msedgedriverPath))
      .build()

    await driver.get(BASE_URL)
    await waitFor(async () => {
      try {
        await driver.findElement(By.id('mobilePromptInput'))
        return await driver.executeScript('return !!window.__webCodexE2E && !!window.__webCodexDebug')
      } catch {
        return false
      }
    }, 20000, '__webCodexE2E ready')

    const prepared = await driver.executeAsyncScript(`
      const done = arguments[0];
      void (async () => {
        const h = window.__webCodexE2E;
        if (!h || typeof h.setThreadHistory !== 'function' || typeof h.openThread !== 'function') {
          return done({ ok: false, error: 'missing e2e history hooks' });
        }
        const threadId = '019c8000-0000-7000-8000-0000000000d1';
        h.setThreadHistory(threadId, {
          id: threadId,
          modelName: 'gpt-5.3-codex',
          page: { incomplete: true },
          turns: [
            {
              id: 'turn-1',
              items: [
                { type: 'userMessage', content: [{ type: 'input_text', text: 'show commentary archive line 1\\n\\nline 2' }] },
              ],
            },
          ],
        });
        await h.openThread(threadId);
        done({ ok: true, threadId });
      })().catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)
    if (!prepared?.ok) throw new Error(`prepare failed: ${prepared?.error || 'unknown'}`)

    await waitFor(async () => {
      const initial = await driver.executeScript(`
        const firstUser = document.querySelector('#chatBox .msg.user .msgBody');
        return {
          bodyHtml: String(firstUser?.innerHTML || ''),
          bodyText: String(firstUser?.textContent || '').trim(),
        };
      `)
      return initial.bodyHtml.includes('msgBlankLine') && initial.bodyText.includes('line 1') && initial.bodyText.includes('line 2')
    }, 5000, 'user blank lines visible')

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = '019c8000-0000-7000-8000-0000000000d1';
      if (!h || typeof h.emitWsPayload !== 'function') {
        return done({ ok: false, error: 'emitWsPayload missing' });
      }
      const emit = (payload) => h.emitWsPayload({ type: 'rpc.notification', payload });
      emit({
        method: 'codex/event/agent_message',
        params: {
          payload: {
            id: 'commentary-1',
            type: 'agent_message',
            thread_id: threadId,
            phase: 'commentary',
            message: 'thinking block one',
          },
        },
      });
      emit({
        method: 'turn/plan/updated',
        params: {
          threadId,
          turnId: 'turn-1',
          explanation: 'Investigate runtime display',
          plan: [{ step: 'Inspect live stack', status: 'in_progress' }],
        },
      });
      emit({
        method: 'item/updated',
        params: {
          threadId,
          item: {
            id: 'cmd-1',
            type: 'commandExecution',
            command: 'npm test',
            status: 'running',
          },
        },
      });
      setTimeout(() => done({ ok: true }), 200);
    `)

    await waitFor(async () => {
      const live = await driver.executeScript(`
        return {
          planText: String(document.querySelector('#runtimePlanInline')?.textContent || '').trim(),
          thinkingText: String(document.querySelector('#runtimeThinkingInline')?.textContent || '').trim(),
          runtimeText: String(document.querySelector('#runtimeToolInline')?.textContent || '').trim(),
        };
      `)
      return live.planText.includes('Updated Plan') && live.thinkingText.includes('thinking block one') && live.runtimeText.includes('npm test')
    }, 5000, 'initial live commentary visible')

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = '019c8000-0000-7000-8000-0000000000d1';
      if (!h || typeof h.setThreadHistory !== 'function' || typeof h.refreshActiveThread !== 'function') {
        return done({ ok: false, error: 'history refresh hooks missing' });
      }
      h.setThreadHistory(threadId, {
        id: threadId,
        modelName: 'gpt-5.3-codex',
        page: { incomplete: true },
        turns: [
          {
            id: 'turn-1',
            items: [
              { type: 'userMessage', content: [{ type: 'input_text', text: 'show commentary archive line 1\\n\\nline 2' }] },
            ],
          },
        ],
      });
      Promise.resolve(h.refreshActiveThread())
        .then(() => done({ ok: true }))
        .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)

    await waitFor(async () => {
      const live = await driver.executeScript(`
        return {
          thinkingText: String(document.querySelector('#runtimeThinkingInline')?.textContent || '').trim(),
        };
      `)
      return live.thinkingText.includes('thinking block one')
    }, 5000, 'live commentary survives history refresh')

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = '019c8000-0000-7000-8000-0000000000d1';
      if (!h || typeof h.emitWsPayload !== 'function') {
        return done({ ok: false, error: 'emitWsPayload missing' });
      }
      const emit = (payload) => h.emitWsPayload({ type: 'rpc.notification', payload });
      emit({
        method: 'codex/event/response_item',
        params: {
          payload: {
            id: 'commentary-2',
            type: 'message',
            role: 'assistant',
            thread_id: threadId,
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'thinking block two' }],
          },
        },
      });
      emit({
        method: 'item/updated',
        params: {
          threadId,
          item: {
            id: 'cmd-2',
            type: 'commandExecution',
            command: 'cargo test',
            status: 'running',
          },
        },
      });
      emit({
        method: 'item.completed',
        params: {
          item: {
            id: 'final-1',
            type: 'agent_message',
            thread_id: threadId,
            phase: 'final_answer',
            text: 'final answer',
          },
        },
      });
      emit({
        method: 'turn.completed',
        params: { threadId },
      });
      setTimeout(() => done({ ok: true }), 200);
    `)

    await driver.executeAsyncScript(`
      const done = arguments[0];
      const h = window.__webCodexE2E;
      const threadId = '019c8000-0000-7000-8000-0000000000d1';
      if (!h || typeof h.setThreadHistory !== 'function' || typeof h.refreshActiveThread !== 'function') {
        return done({ ok: false, error: 'history refresh hooks missing' });
      }
      h.setThreadHistory(threadId, {
        id: threadId,
        modelName: 'gpt-5.3-codex',
        page: { incomplete: false },
        turns: [
          {
            id: 'turn-1',
            items: [
              { type: 'userMessage', content: [{ type: 'input_text', text: 'show commentary archive line 1\\n\\nline 2' }] },
              { type: 'agentMessage', id: 'commentary-1', phase: 'commentary', text: 'thinking block one' },
              {
                type: 'toolCall',
                tool: 'update_plan',
                arguments: JSON.stringify({
                  explanation: 'Investigate runtime display',
                  plan: [{ step: 'Inspect live stack', status: 'in_progress' }],
                }),
              },
              { type: 'commandExecution', id: 'cmd-1', command: 'npm test', status: 'running' },
              { type: 'agentMessage', id: 'commentary-2', phase: 'commentary', text: 'thinking block two' },
              { type: 'commandExecution', id: 'cmd-2', command: 'cargo test', status: 'running' },
              { type: 'assistantMessage', id: 'final-1', phase: 'final_answer', text: 'final answer' },
            ],
          },
          {
            id: 'turn-2',
            items: [
              { type: 'userMessage', content: [{ type: 'input_text', text: 'second turn question' }] },
              { type: 'agentMessage', id: 'commentary-3', phase: 'commentary', text: 'thinking block three' },
              { type: 'commandExecution', id: 'cmd-3', command: 'pnpm lint', status: 'running' },
              { type: 'assistantMessage', id: 'final-2', phase: 'final_answer', text: 'second final answer' },
            ],
          },
        ],
      });
      Promise.resolve(h.refreshActiveThread())
        .then(() => done({ ok: true }))
        .catch((error) => done({ ok: false, error: String(error && error.message ? error.message : error) }));
    `)

    try {
      await waitFor(async () => {
        const result = await driver.executeScript(`
          const assistantNodes = Array.from(document.querySelectorAll('#chatBox .msg.assistant .msgBody')).map((node) => String(node?.textContent || '').trim());
          const archiveNodes = Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount'));
          return {
            assistantNodes,
            finalAnswerCount: assistantNodes.filter((text) => text === 'final answer').length,
            archiveCount: archiveNodes.length,
            archiveTexts: archiveNodes.map((node) => String(node.querySelector('.commentaryArchiveCount')?.textContent || '').trim()),
            globalArchiveExists: !!document.querySelector('#commentaryArchiveMount'),
            runtimeHtml: String(document.querySelector('#runtimeToolInline')?.innerHTML || ''),
          };
        `)
        return result.finalAnswerCount === 1 &&
          result.assistantNodes.includes('final answer') &&
          result.assistantNodes.includes('second final answer') &&
          result.archiveCount === 2 &&
          result.archiveTexts[0] === '2 commentary messages, 2 used tools' &&
          result.archiveTexts[1] === '1 commentary message, 1 used tool' &&
          result.globalArchiveExists === false
      }, 5000, 'final answers and inline commentary archives')
    } catch (error) {
      const debug = await driver.executeScript(`
        return {
          dump: window.__webCodexDebug?.dumpMessages?.(12) || [],
          liveEvents: window.__webCodexDebug?.getRecentLiveEvents?.(40) || [],
          archiveHtml: String(document.querySelector('#commentaryArchiveMount')?.outerHTML || ''),
          inlineArchives: Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount')).map((node) => String(node.outerHTML || '')),
          runtimeHtml: String(document.querySelector('#runtimeToolInline')?.outerHTML || ''),
          chatHtml: String(document.getElementById('chatBox')?.innerHTML || ''),
        };
      `)
      throw new Error(`${error.message}; debug=${JSON.stringify(debug)}`)
    }

    const liveSnapshot = await driver.executeScript(`
      return {
        runtimeText: String(document.querySelector('#runtimeToolInline')?.textContent || '').trim(),
        runtimeHtml: String(document.querySelector('#runtimeToolInline')?.innerHTML || ''),
        thinkingText: String(document.querySelector('#runtimeThinkingInline')?.textContent || '').trim(),
        archiveTexts: Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount .commentaryArchiveCount')).map((node) => String(node?.textContent || '').trim()),
      };
    `)

    if (String(liveSnapshot.runtimeText || '').includes('npm test')) {
      throw new Error(`expected previous commentary tools to disappear before final archive, got ${JSON.stringify(liveSnapshot)}`)
    }

    await driver.executeScript(`
      const toggles = Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount .commentaryArchiveToggle'));
      if (toggles.length !== 2) throw new Error('missing inline commentary archive toggles');
      toggles.forEach((toggle) => toggle.click());
    `)

    await waitFor(async () => {
      const expanded = await driver.executeScript(`
        const bodies = Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount .commentaryArchiveBody'));
        const texts = bodies.map((body) => String(body?.textContent || '').trim());
        return bodies.length === 2 &&
          bodies.every((body) => !!body && !body.classList.contains('collapsed')) &&
          texts.some((text) => text.includes('thinking block one') && text.includes('thinking block two')) &&
          texts.some((text) => text.includes('Updated Plan') && text.includes('Inspect live stack')) &&
          texts.some((text) => text.includes('thinking block three'));
      `)
      return !!expanded
    }, 5000, 'expanded commentary archive contents')

    const finalSnapshot = await driver.executeScript(`
      return {
        archiveTexts: Array.from(document.querySelectorAll('#chatBox .commentaryArchiveMount .commentaryArchiveBody')).map((node) => String(node?.textContent || '').trim()),
        dump: window.__webCodexDebug?.dumpMessages?.(12) || [],
      };
    `)

    console.log('[ui:e2e:codex-commentary-archive] PASS')
    console.log(JSON.stringify({ liveSnapshot, finalSnapshot }))
  } finally {
    if (driver) await driver.quit().catch(() => {})
    if (devProc) killProcessTree(devProc)
  }
}

main().catch((error) => {
  console.error(`[ui:e2e:codex-commentary-archive] FAIL: ${error?.stack || error}`)
  process.exitCode = 1
})

