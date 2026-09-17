import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4289
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-ai-multiblock'
const VAULT = `${DATA}/vaults/myva`
const BASE = `http://localhost:${PORT}`
const ADMIN = { email: 'ai-multiblock@test.dev', password: 'password1' }
const code = (label, lines) => `\`\`\`js\n${Array.from({ length: lines }, (_, i) => `const ${label}${i} = "${'x'.repeat(18)}"`).join('\n')}\n\`\`\``
/** Three fences → the selection path turns the first into an `update` on the
 *  anchor and the rest into one `add` after it, so the agent writes into blocks
 *  the prompt was never anchored to. */
const MULTI_BLOCK = [code('first', 30), code('second', 30), code('third', 30)].join('\n\n')
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
writeFileSync(`${VAULT}/notes.md`, code('before', 12))

const server = startServer('ai-multiblock-follow', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
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
  attachLogging(page, 'ai-multiblock-follow')

  await page.route('**/api/ask_ai', route => {
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ['event: ai:token', `data: ${JSON.stringify(MULTI_BLOCK)}`, '', 'event: ai:tools_done', 'data: ""', '', 'event: ai:done', 'data: {"provider":"mock","truncated":false}', ''].join('\n'),
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
  await page.locator('.bn-block-content[data-content-type="codeBlock"] pre').waitFor({ timeout: 10000 })

  await page.evaluate(() => {
    const anchor = document.querySelector('.bn-block-content[data-content-type="codeBlock"]')?.closest('[data-node-type="blockContainer"]')
    const anchorId = anchor?.getAttribute('data-id') ?? null
    const originalRect = Element.prototype.getBoundingClientRect
    const metrics = { anchorId, cursorFrames: 0, cursorOutsideAnchorFrames: 0, cursorOvershoot: 0, scrollerTag: null }
    Object.defineProperty(window, '__aiFollowMetrics', { value: metrics })

    /** Same frame rate as the follower: how far the writing caret travels past
     *  its scroller's bottom edge, and whether it ever left the anchor block. */
    const sample = () => {
      requestAnimationFrame(sample)
      const cursor = document.querySelector('.bn-collaboration-cursor__base[data-active="true"]')
      if (!cursor) return
      metrics.cursorFrames++
      const block = cursor.closest('[data-node-type="blockContainer"]')
      if (block?.getAttribute('data-id') !== anchorId) metrics.cursorOutsideAnchorFrames++
      let scroller = cursor
      while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
      scroller = scroller || document.documentElement
      metrics.scrollerTag = scroller.className || scroller.tagName
      const overshoot = originalRect.call(cursor).bottom - originalRect.call(scroller).bottom
      if (overshoot > metrics.cursorOvershoot) metrics.cursorOvershoot = overshoot
    }
    requestAnimationFrame(sample)
  })

  await page.locator('.bn-editor').click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Control+Alt+L')
  const prompt = page.locator('textarea[aria-label="AI prompt"]')
  await prompt.waitFor()
  await prompt.fill('expand the snippet into three blocks')
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor({ timeout: 60000 })

  const metrics = await page.evaluate(() => {
    const m = window.__aiFollowMetrics
    return {
      blocks: document.querySelectorAll('.bn-block-content[data-content-type="codeBlock"]').length,
      cursorFrames: m.cursorFrames,
      cursorOutsideAnchorFrames: m.cursorOutsideAnchorFrames,
      cursorOvershoot: Math.round(m.cursorOvershoot),
      scrollerTag: m.scrollerTag,
    }
  })
  ok('fixture: tulisan AI mendarat di beberapa block', metrics.blocks >= 3, JSON.stringify(metrics))
  ok('fixture: caret sempat keluar dari block anchor selama reveal', metrics.cursorOutsideAnchorFrames > 5, JSON.stringify(metrics))
  ok('caret tetap di dalam scroller walau menulis di block baru', metrics.cursorFrames > 5 && metrics.cursorOvershoot <= 32, JSON.stringify(metrics))
  await page.screenshot({ path: 'test/artifacts/ai-multiblock-follow.png', fullPage: true })
} catch (error) {
  results.push(['FAIL', 'setup/run', String(error).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-multiblock-follow', results, { serverLog: server.logPath })) process.exitCode = 1
