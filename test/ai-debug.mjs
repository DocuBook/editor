/**
 * AI transport debug e2e — reproduces the web "Error calling LLM" report.
 *
 * Intercepts /api/ask_ai in the browser with a mock SSE stream (same wire
 * format as the real server: event: ai:token / ai:tools_done / ai:done), so
 * the FULL frontend chain runs: transport → buildApplyDocumentInput → xl-ai
 * suggestion. This isolates the frontend — no provider reachability needed.
 *
 * Key question it answers: does xl-ai reject our generated applyDocument
 * Operations (→ "Error calling LLM" with NO [ai] log, stream "succeeded"
 * from our side) or does the transport itself fail (→ [ai] log)?
 *
 * Run: npm run build && node test/ai-debug.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4275
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-ai'
const VAULT = `${DATA}/vaults/myva`
const BASE = `http://localhost:${PORT}`

const ADMIN = { email: 'ai@test.dev', password: 'password1' }
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
writeFileSync(`${VAULT}/notes.md`, '# Notes\n\nhello world')

const server = startServer('ai-debug', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
let browser

async function api(cmd, args = {}, cookie = '') {
  const res = await fetch(`${BASE}/api/${cmd}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(args),
  })
  return { status: res.status, text: await res.text() }
}

try {
  await waitForServer(BASE)
  const sa = await api('setup_admin', { email: ADMIN.email, password: ADMIN.password })
  if (sa.status !== 200) throw new Error(`setup_admin failed: ${sa.text}`)
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  await api('open_vault', { path: VAULT }, cookie)

  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'db_session', value: cookie.split('=').slice(1).join('='), url: BASE }])
  const page = await context.newPage()
  attachLogging(page, 'ai-debug')

  /** Mock Path B text output and Path A tool calls at browser fetch level. */
  let askAiHits = 0
  await page.route('**/api/ask_ai', route => {
    askAiHits++
    const request = route.request().postDataJSON()
    const messages = String(request?.messages || '')
    const useTools = typeof request?.tools === 'string' && request.tools.length > 0
    const noOp = messages.toLowerCase().includes('leave unchanged')
    if (!useTools) {
      const mockSSE = [
        'event: ai:token', 'data: "## Summary\\n\\n- point one\\n- point two\\n- point three"', '',
        'event: ai:tools_done', 'data: ""', '',
        'event: ai:done', 'data: {"provider":"mock","truncated":false}', '',
      ].join('\n')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: mockSSE })
    }
    const ids = [
      ...messages.matchAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      ),
    ]
    const id = ids[0]?.[0] || 'missing'
    const toolPayload = {
      toolCallId: 'mock-tool-call',
      toolName: 'applyDocumentOperations',
      input: {
        operations: noOp ? [] : [{
          type: 'add',
          referenceId: `${id}$`,
          position: 'after',
          blocks: ['<p><script>alert(1)</script>AI tool change<img src="x" onerror="alert(1)"></p>'],
        }],
      },
    }
    const mockSSE = [
      'event: ai:tool_call', `data: ${JSON.stringify(toolPayload)}`, '',
      'event: ai:tools_done', 'data: ""', '',
      'event: ai:done', 'data: {"provider":"mock","truncated":false}', '',
    ].join('\n')
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: mockSSE })
  })

  await page.addInitScript((vaultPath) => {
    if (!localStorage.getItem('docubook:vault')) {
      localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
    }
    if (!localStorage.getItem('docubook:ai-settings')) {
      localStorage.setItem('docubook:ai-settings', JSON.stringify({ state: {
        provider: 'openai-compatible', model: 'mock-model',
        savedProviders: ['openai-compatible'],
        // No probe result → custom provider is text-only → Path B (no tools)
        probeTools: {},
        baseUrls: { 'openai-compatible': 'http://mock.invalid/v1' },
        models: {},
      }, version: 0 }))
    }
  }, VAULT)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=notes', { timeout: 10000 })
  await page.getByText('notes', { exact: true }).click()
  await page.getByText('hello world', { exact: true }).waitFor()

  // Select the document content so the AI edit path (update ops) is exercised
  await page.keyboard.press('Meta+a')

  // Open the AI menu (Ctrl+Alt+L) and submit — the menu input autofocuses
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  await page.keyboard.type('summarize the note')
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor()
  await page.getByText('Revert', { exact: true }).waitFor()
  ok('Path B: text-only request renders review', askAiHits === 1)

  // Switch the persisted probe to true and reload: same mock response now
  // exercises Path A (tools are sent, model returns text, no second ask_ai).
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('docubook:ai-settings') || '{}')
    s.state = s.state || {}
    s.state.probeTools = { 'openai-compatible': { 'mock-model': true } }
    localStorage.setItem('docubook:ai-settings', JSON.stringify(s))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=notes', { timeout: 10000 })
  await page.getByText('notes', { exact: true }).click()
  await page.getByText('hello world', { exact: true }).waitFor()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  await page.keyboard.type('summarize the note')
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor()
  await page.getByText('Revert', { exact: true }).waitFor()
  ok('Path A: tool request renders review', askAiHits === 2)
  ok('Path A: hostile HTML stays inert', await page.locator('.bn-editor script, .bn-editor [onerror]').count() === 0)

  await page.getByText('Revert', { exact: true }).click()
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  await page.keyboard.type('leave unchanged')
  await page.keyboard.press('Enter')
  await page.getByText(/AI made no document changes/i).waitFor()
  const bodyNoOp = await page.locator('body').innerText()
  ok('Path A: semantic no-op rejected', /AI made no document changes/i.test(bodyNoOp), bodyNoOp.slice(-260))
  ok('Path A: no-op hides Accept/Revert', !/\bAccept\b|\bRevert\b/i.test(bodyNoOp), bodyNoOp.slice(-160))
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-debug', results, { serverLog: server.logPath })) process.exitCode = 1
