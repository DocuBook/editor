import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4277
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-ai-pre'
const VAULT = `${DATA}/vaults/myva`
const BASE = `http://localhost:${PORT}`
const ADMIN = { email: 'ai-pre@test.dev', password: 'password1' }
const code = (label, lines) => `\`\`\`js\n${Array.from({ length: lines }, (_, i) => `const ${label}${i} = "${'x'.repeat(18)}"`).join('\n')}\n\`\`\``
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
writeFileSync(`${VAULT}/notes.md`, code('before', 45))

const server = startServer('ai-pre-flicker', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
let browser

async function api(cmd, args = {}, cookie = '') {
  const response = await fetch(`${BASE}/api/${cmd}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(args),
  })
  return { status: response.status, text: await response.text() }
}

try {
  await waitForServer(BASE)
  const setup = await api('setup_admin', ADMIN)
  if (setup.status !== 200) throw new Error(`setup_admin failed: ${setup.text}`)
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  await api('open_vault', { path: VAULT }, cookie)

  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 900, height: 320 } })
  await context.addCookies([{ name: 'db_session', value: cookie.split('=').slice(1).join('='), url: BASE }])
  const page = await context.newPage()
  attachLogging(page, 'ai-pre-flicker')

  await page.route('**/api/ask_ai', route => {
    const output = code('after', 45)
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ['event: ai:token', `data: ${JSON.stringify(output)}`, '', 'event: ai:tools_done', 'data: ""', '', 'event: ai:done', 'data: {"provider":"mock","truncated":false}', ''].join('\n'),
    })
  })

  await page.addInitScript((vaultPath) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
    localStorage.setItem('docubook:ai-settings', JSON.stringify({ state: {
      provider: 'openai-compatible', model: 'mock-model', savedProviders: ['openai-compatible'],
      probeTools: {}, baseUrls: { 'openai-compatible': 'http://mock.invalid/v1' }, models: {},
    }, version: 0 }))
  }, VAULT)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.getByText('notes', { exact: true }).click()
  const pre = page.locator('.bn-block-content[data-content-type="codeBlock"] pre')
  await pre.waitFor({ timeout: 10000 })
  const initialHeight = await pre.evaluate(el => el.getBoundingClientRect().height)
  ok('fixture: pre lebih tinggi dari viewport pendek', initialHeight > 320, `${Math.round(initialHeight)}px`)

  await page.evaluate(() => {
    const initialPre = document.querySelector('.bn-block-content[data-content-type="codeBlock"] pre')
    const originalRect = Element.prototype.getBoundingClientRect
    const metrics = { initialPre, preDetached: false, blockRectReads: 0, cursorRectReads: 0 }
    Object.defineProperty(window, '__aiPreMetrics', { value: metrics })
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches?.('.bn-collaboration-cursor__base[data-active="true"]')) metrics.cursorRectReads++
      if (this.matches?.('[data-node-type="blockContainer"]') && this.querySelector?.('pre')) metrics.blockRectReads++
      return originalRect.call(this)
    }
    new MutationObserver(() => { if (metrics.initialPre && !metrics.initialPre.isConnected) metrics.preDetached = true })
      .observe(document.querySelector('.bn-editor'), { childList: true, subtree: true })
  })

  await page.locator('.bn-editor').click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Control+Alt+L')
  const prompt = page.locator('textarea[placeholder="Send message to AI writing..."]')
  await prompt.waitFor()
  await prompt.fill('rewrite this code')
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor({ timeout: 60000 })

  const metrics = await page.evaluate(() => {
    const m = window.__aiPreMetrics
    return {
      preDetached: m.preDetached,
      samePre: m.initialPre === document.querySelector('.bn-block-content[data-content-type="codeBlock"] pre'),
      blockRectReads: m.blockRectReads,
      cursorRectReads: m.cursorRectReads,
    }
  })
  ok('pre tetap terpasang selama streaming', !metrics.preDetached && metrics.samePre, JSON.stringify(metrics))
  ok(
    'pengukuran blok panjang tidak mengikuti setiap token',
    metrics.cursorRectReads > 0 && metrics.blockRectReads < metrics.cursorRectReads / 5,
    JSON.stringify(metrics),
  )
  await page.screenshot({ path: 'test/artifacts/ai-pre-flicker.png', fullPage: true })
} catch (error) {
  results.push(['FAIL', 'setup/run', String(error).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-pre-flicker', results, { serverLog: server.logPath })) process.exitCode = 1
