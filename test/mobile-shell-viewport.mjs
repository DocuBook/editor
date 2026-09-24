/**
 * Mobile shell viewport contract (<640px): compact chrome is pinned to the app
 * shell — the AI composer to its bottom edge, the tab bar at its top — so the
 * shell MUST track the visible viewport. On a phone `100vh` is the LARGE viewport
 * (browser UI and soft keyboard retracted), which leaves that shell taller than
 * the screen: the page gains scroll range, the browser scrolls it to reveal the
 * focused composer, and the tab bar is dragged off screen while the composer rises
 * — the two move in opposite directions at once, and the offset sticks.
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
import { runSuite, mockAiSettings, stubBackend, openNote, PORTS } from './lib.mjs'

const NOTE = 'alpha bravo charlie delta'
const NOTE_TEXT = `# Notes\n\n${NOTE}\n`

await runSuite('mobile-shell-viewport', {
  port: PORTS.mobileShell,
  /* Static frontend only: every /api/** call is stubbed in the browser. */
  server: 'preview',
  viewport: { width: 390, height: 720 },
}, async ({ page, ok, base }) => {
  await stubBackend(page, { email: 'shell@example.test', noteText: NOTE_TEXT })
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

  /** Shell/composer/tab-bar box model. `composerHeight` is measured live, so the
   *  room assertions cannot drift from the composer's real markup. */
  const measure = () => page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const shell = q('.editor-shell')
    const ai = q('.editor-ai-floating')
    const bar = q('.editor-tab-bar')
    const content = q('.editor-content')
    const ta = q('.editor-ai-floating textarea')
    if (!shell || !ai || !bar || !content || !ta) return null
    const aiStyle = getComputedStyle(ai)
    const taStyle = getComputedStyle(ta)
    const shellRect = shell.getBoundingClientRect()
    return {
      viewportHeight: document.documentElement.clientHeight,
      shellHeight: shellRect.height,
      shellBottom: shellRect.bottom,
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

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  /* A phone starts with the sidebar closed; the note tree lives inside it. */
  await page.locator('[data-testid="sidebar-toggle"]').click()
  await openNote(page, NOTE)
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

  /* Page is already at the phone viewport; let the first layout settle. */
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
})
