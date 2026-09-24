import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser, mockAiSettings, mockAskAi, bootstrapSession, PORTS, ok as createOk } from './lib.mjs'

const PORT = PORTS.aiPreFlicker
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-ai-pre'
const VAULT = `${DATA}/vaults/myva`
const BASE = `http://localhost:${PORT}`
const code = (label, lines) => `\`\`\`js\n${Array.from({ length: lines }, (_, i) => `const ${label}${i} = "${'x'.repeat(18)}"`).join('\n')}\n\`\`\``
const results = []
const ok = createOk(results)

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
  const session = await bootstrapSession('ai-pre-flicker', { port: PORT, dataDir: DATA, vaultPath: VAULT, viewport: { width: 900, height: 320 } })
  browser = session.browser
  const page = session.page

  await mockAskAi(page, () => [
    ['ai:token', { token: code('after', 45) }],
    ['ai:tools_done', {}],
    ['ai:done', { provider: 'mock', truncated: false }],
  ])

  await mockAiSettings(page)

  await page.addInitScript((vaultPath) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
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
    const metrics = {
      initialPre, preDetached: false, blockRectReads: 0, cursorRectReads: 0,
      cursorFrames: 0, cursorOvershoot: 0, scrollerTag: null,
    }
    Object.defineProperty(window, '__aiPreMetrics', { value: metrics })
    Element.prototype.getBoundingClientRect = function () {
      if (this.matches?.('.bn-collaboration-cursor__base[data-active="true"]')) metrics.cursorRectReads++
      if (this.matches?.('[data-node-type="blockContainer"]') && this.querySelector?.('pre')) metrics.blockRectReads++
      return originalRect.call(this)
    }
    new MutationObserver(() => { if (metrics.initialPre && !metrics.initialPre.isConnected) metrics.preDetached = true })
      .observe(document.querySelector('.bn-editor'), { childList: true, subtree: true })

    // Probe: largest distance the writing caret travels past its scroller's
    // bottom edge on any painted frame, and how many frames carried a caret.
    // Reads go through `originalRect` so the probe stays out of the counters
    // the assertions above depend on.
    const sample = () => {
      requestAnimationFrame(sample)
      const cursor = document.querySelector('.bn-collaboration-cursor__base[data-active="true"]')
      if (!cursor) return
      metrics.cursorFrames++
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
      cursorFrames: m.cursorFrames,
      cursorOvershoot: Math.round(m.cursorOvershoot),
      scrollerTag: m.scrollerTag,
    }
  })
  ok('pre tetap terpasang selama streaming', !metrics.preDetached && metrics.samePre, JSON.stringify(metrics))
  ok(
    'pengukuran blok panjang tidak mengikuti setiap token',
    metrics.cursorRectReads > 0 && metrics.blockRectReads < metrics.cursorRectReads / 5,
    JSON.stringify(metrics),
  )
  ok('cursor tulis tetap terlihat selama streaming', metrics.cursorFrames > 5 && metrics.cursorOvershoot <= 32, JSON.stringify(metrics))
  await page.screenshot({ path: 'test/artifacts/ai-pre-flicker.png', fullPage: true })
} catch (error) {
  results.push(['FAIL', 'setup/run', String(error).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-pre-flicker', results, { serverLog: server.logPath })) process.exitCode = 1
