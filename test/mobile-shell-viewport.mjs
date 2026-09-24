/**
 * Mobile shell viewport contract (<640px): compact chrome is pinned to the app
 * shell — the AI composer to its bottom edge, the tab bar at its top — so the
 * shell MUST track the visible viewport. On a phone `100vh` is the LARGE viewport
 * (browser UI and soft keyboard retracted), which leaves that shell taller than
 * the screen: the page gains scroll range, the browser scrolls it to reveal the
 * focused composer, and the tab bar is dragged off screen while the composer rises
 * — the two move in opposite directions at once, and the offset sticks.
 *
 * Two rules that looked like fixes could not work, and this suite keeps them gone:
 *   - `position: sticky; top: 0` on the tab bar: its scrollport is the shell's own
 *     `overflow: hidden`, so it only ever moves WITH the shell (caniuse: sticky
 *     sticks to the nearest ancestor with a scrolling mechanism "even if that
 *     ancestor isn't the nearest actually scrolling ancestor").
 *   - `bottom: max(calc(100% - 100vh), 1.25rem)` on the composer: its containing
 *     block `.editor-ai-rail` is `h-0`, so `100%` was 0, the term was always
 *     negative and the rule always resolved to the `1.25rem` `bottom-5` already
 *     sets — dead code that hid the real problem.
 *
 * Why the fix is asserted as a CSS/meta artifact AND as live geometry: headless
 * engines have no dynamic browser UI, so `100vh === dvh` there and the runtime
 * geometry of the bug is identical to the fix. The difference only shows on a
 * device, so this suite pins the two artifacts that make it (`dvh`-sized shell
 * behind its `@supports` gate, `interactive-widget=resizes-content`) plus the
 * geometry that must hold on every engine: nothing may scroll, and the document
 * must reserve room for the tallest the composer can get.
 *
 * Logs: test/artifacts/mobile-shell-viewport.{server,browser}.log
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser, mockAiSettings } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = 4182
const BASE = `http://localhost:${PORT}`
const PHONE = { width: 390, height: 720 }
const WIDE = { width: 1280, height: 800 }
const NOTE = 'alpha bravo charlie delta'

/** Fixture responses for the web IPC bridge (`POST /api/<cmd>`). */
const NOTE_TEXT = `# Notes\n\n${NOTE}\n`
const API = {
  setup_admin: { email: 'shell@example.test' },
  setup_status: { setupRequired: false, setupToken: false },
  account_get: { email: 'shell@example.test' },
  list_tree: [{ path: 'notes.md', name: 'notes.md', type: 'file' }],
  read_file: NOTE_TEXT,
  open_vault: { name: 'demo' },
  git_status: { status: '', isRepo: false, hasRemote: false, ahead: 0, upstream: '', repoState: 'clean' },
  list_trash: [],
  get_backlinks: [],
  wiki_backlinks: [],
}
const RAW_RESULT = new Set(['read_file'])

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = startServer('mobile-shell-viewport', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-shell', wwwDir: 'dist',
})
let browser
let page

async function stubBackend(page) {
  await page.route('**/api/**', async (route) => {
    const cmd = route.request().url().split('/api/')[1]?.split('?')[0] || ''
    const result = Object.prototype.hasOwnProperty.call(API, cmd) ? API[cmd] : {}
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ result: RAW_RESULT.has(cmd) ? result : JSON.stringify(result) }),
    })
  })
}

/** Shell/composer/tab-bar box model. `composerHeight` is measured live, so the
 *  room assertion below cannot drift from the composer's real markup. */
const measure = () => page.evaluate(() => {
  const q = (sel) => document.querySelector(sel)
  const shell = q('.editor-shell')
  const rail = q('.editor-ai-rail')
  const ai = q('.editor-ai-floating')
  const bar = q('.editor-tab-bar')
  const content = q('.editor-content')
  const ta = q('.editor-ai-floating textarea')
  if (!shell || !rail || !ai || !bar || !content || !ta) return null
  const aiStyle = getComputedStyle(ai)
  const taStyle = getComputedStyle(ta)
  const shellRect = shell.getBoundingClientRect()
  return {
    viewportHeight: document.documentElement.clientHeight,
    shellHeight: shellRect.height,
    shellBottom: shellRect.bottom,
    railHeight: rail.getBoundingClientRect().height,
    aiBottom: ai.getBoundingClientRect().bottom,
    offset: parseFloat(aiStyle.bottom),
    barPosition: getComputedStyle(bar).position,
    barTop: bar.getBoundingClientRect().top,
    composerHeight: ai.getBoundingClientRect().height,
    textareaHeight: ta.getBoundingClientRect().height,
    maxHeight: parseFloat(taStyle.maxHeight),
    contentPaddingBottom: parseFloat(getComputedStyle(content).paddingBottom),
    docScrollHeight: document.scrollingElement.scrollHeight,
    docClientHeight: document.scrollingElement.clientHeight,
    scrollY: window.scrollY,
  }
})

try {
  await waitForServer(BASE, 50)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: PHONE })
  attachLogging(page, 'mobile-shell-viewport')
  await stubBackend(page)
  /** A configured provider, so the composer's prompt field is enabled and can be
   *  grown to its real maximum height for the room assertion below. */
  await mockAiSettings(page)
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="sidebar-toggle"]').click()
  const noteEntry = page.getByText('notes', { exact: true }).first()
  await noteEntry.waitFor({ timeout: 15000 })
  await noteEntry.click()
  await page.waitForSelector(`text=${NOTE}`, { timeout: 15000 })
  /* The composer is its own lazy chunk (Suspense), so wait for it explicitly instead
     of assuming the note text implies it is mounted — WebKit in CI is slower here. */
  await page.locator('.editor-ai-floating textarea').waitFor({ timeout: 15000 })

  // ── 1. Shipped artifacts: the shell is sized against the VISIBLE viewport ──
  const shipped = await page.evaluate(async () => {
    const hrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.href)
    const css = (await Promise.all(hrefs.map(async h => (await fetch(h)).text()))).join('\n').replace(/\s+/g, '')
    return { css, meta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '' }
  })
  ok('meta: viewport carries interactive-widget=resizes-content',
    shipped.meta.includes('interactive-widget=resizes-content'), shipped.meta)
  ok('css: shell height is dvh-gated (Safari 15 / chrome105 keep the 100vh fallback)',
    /@supports\(height:100dvh\)\{[^}]*\.editor-shell\{height:100dvh\}/.test(shipped.css))
  ok('css: the inert composer override is gone',
    !/\.editor-ai-floating\{bottom:max\(/.test(shipped.css))
  ok('css: the tab bar is not sticky (it cannot pin against the shell it lives in)',
    !/\.editor-tab-bar\{position:sticky/.test(shipped.css))

  /* Page is already at PHONE (context viewport); let the first layout settle. */
  await page.waitForTimeout(400)
  const phone = await measure()
  ok('phone: the composer is rendered', !!phone)
  if (phone) {
    ok('phone: shell height equals the visible viewport height',
      Math.abs(phone.shellHeight - phone.viewportHeight) < 0.5,
      `shell=${phone.shellHeight} viewport=${phone.viewportHeight}`)
    ok('phone: the page has no scroll range to be scrolled out of place',
      phone.docScrollHeight - phone.docClientHeight <= 1,  // 1px: sub-pixel rounding across engines
      `scrollHeight=${phone.docScrollHeight} clientHeight=${phone.docClientHeight}`)
    ok('phone: tab bar is not sticky',
      phone.barPosition !== 'sticky', `position=${phone.barPosition}`)
    ok('phone: the composer stays anchored 20px above the shell bottom edge',
      Math.abs(phone.shellBottom - phone.aiBottom - 20) < 0.5,
      `shell.bottom=${phone.shellBottom} composer.bottom=${phone.aiBottom} offset=${phone.offset}`)
    ok('phone: composer containing block (rail) has height 0 — `100%` in it resolves to 0',
      phone.railHeight === 0, `rail=${phone.railHeight}`)
    ok('phone: document reserves room for the resting composer',
      phone.contentPaddingBottom >= phone.composerHeight + phone.offset,
      `padding-bottom=${phone.contentPaddingBottom} composer=${phone.composerHeight}+${phone.offset}`)
  }

  // ── 2. The composer at its tallest: a prompt grown to the textarea's max-h ──
  await page.locator('.editor-ai-floating textarea').fill(
    Array.from({ length: 14 }, (_, i) => `prompt line ${i}`).join('\n'))
  await page.waitForTimeout(400)
  const grown = await measure()
  ok('phone: a grown prompt reaches the textarea max-h',
    grown && grown.textareaHeight >= 100,
    grown ? `textarea=${grown.textareaHeight} (max ${grown.maxHeight})` : 'no composer')
  ok('phone: document reserves room for the composer at its tallest',
    grown && grown.contentPaddingBottom >= grown.composerHeight + grown.offset,
    grown ? `padding-bottom=${grown.contentPaddingBottom} composer=${grown.composerHeight}+${grown.offset}` : 'no composer')

  // ── 3. Focusing the composer must not scroll the page (the reported tug) ──
  await page.locator('.editor-ai-floating textarea').focus()
  await page.waitForTimeout(300)
  const focused = await measure()
  ok('phone: focusing the composer scrolls nothing',
    focused && focused.scrollY === 0 && Math.abs(focused.barTop) < 0.5,
    focused ? `scrollY=${focused.scrollY} tabBar.top=${focused.barTop}` : 'no composer')

  // ── 4. Wide keeps the same reservation (the composer's max height is width-independent) ──
  await page.setViewportSize(WIDE)
  await page.waitForTimeout(400)
  const wide = await measure()
  ok('wide: document reserves room for the composer at its tallest',
    wide && wide.contentPaddingBottom >= wide.composerHeight + wide.offset,
    wide ? `padding-bottom=${wide.contentPaddingBottom} composer=${wide.composerHeight}+${wide.offset}` : 'no composer')
  ok('wide: shell height equals the visible viewport height',
    wide && Math.abs(wide.shellHeight - wide.viewportHeight) < 0.5,
    wide ? `shell=${wide.shellHeight} viewport=${wide.viewportHeight}` : 'no composer')
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('mobile-shell-viewport', results, { serverLog: server.logPath })) process.exitCode = 1
