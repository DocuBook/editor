/**
 * Mobile open-focus contract (<640px): opening a note from the drawer must not
 * move focus into the document surface where the platform raises an on-screen
 * keyboard — and must keep the caret restore where it cannot.
 *
 * That surface is what raises the IME on a phone, and the open it follows is the
 * drawer the note was picked from: `WysiwygEditor`'s caret restore used to focus
 * the editable (keyboard up), then the drawer's exit handoff focused the sidebar
 * toggle (keyboard down) — a keyboard flash on every reopen, reported from a
 * phone that only meant to read. Focus is sampled every frame across the whole
 * open, so the transient — the bug shape — is a red frame, not something the
 * final `activeElement` can show.
 *
 * Touch emulation is NOT what marks the phone: the platform is, because touch
 * availability and on-focus IME behavior are different questions. The
 * touchscreen-desktop leg is the counter-case that keeps the two apart — same
 * touch input, same drawer, same open, but no IME to raise, so the caret
 * restore must keep its focus (a pointer-media predicate fails exactly there).
 *
 * Logs: test/artifacts/mobile-open-focus.{server,browser}.log
 */
import { runSuite, mockAiSettings, stubBackend, PORTS } from './lib.mjs'

const VIEWPORT = { width: 390, height: 720 }
const TREE = [
  { path: 'alpha.md', name: 'alpha.md', type: 'file' },
  { path: 'bravo.md', name: 'bravo.md', type: 'file' },
]
const NOTE = { 'alpha.md': 'alpha note paragraph', 'bravo.md': 'bravo note paragraph' }
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Routes and storage a leg needs before its first paint. */
async function prepare(page, email) {
  await stubBackend(page, { email, noteText: NOTE['alpha.md'], tree: TREE })
  /* One text per path — the shared stub answers every read with the SAME note,
     and a leg has to know which note finished opening. Registered after
     `stubBackend`: Playwright lets the last matching route win. */
  await page.route('**/api/read_file', async route => {
    const path = route.request().postDataJSON()?.path ?? ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: NOTE[path] ?? '' }) })
  })
  await mockAiSettings(page)
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })
}

/** Frame-by-frame record of whether focus sits on the document surface. One
 *  `true` frame is the IME-raising focus, however briefly it lasted. */
const watch = (page) => page.evaluate(() => {
  window.__focusTrail = []
  const sample = () => {
    const active = document.activeElement
    window.__focusTrail.push(!!(active instanceof HTMLElement && active.closest('.editor-content')))
    window.__focusFrame = requestAnimationFrame(sample)
  }
  sample()
})
const unwatch = (page) => page.evaluate(() => {
  cancelAnimationFrame(window.__focusFrame)
  return window.__focusTrail
})

/** The open the users reported: pick the note in the drawer, land in it. */
async function openFromDrawer(page, name) {
  await page.locator('[data-testid="sidebar-toggle"]').click()
  await page.getByText(name, { exact: true }).first().click()
  /* Text lands in the DOM in WYSIWYG and in the textarea's VALUE in code mode,
     so readiness is checked against both rather than against a rendering. */
  await page.waitForFunction((text) => {
    const raw = document.querySelector('.editor-raw-markdown')
    if (raw instanceof HTMLTextAreaElement && raw.value.includes(text)) return true
    return document.querySelector('.editor-content')?.textContent?.includes(text) ?? false
  }, NOTE[`${name}.md`], { timeout: 15000 })
  /* 600ms: past the drawer's exit transition and the app's focus handoff to the
     toggle, so the sampled window covers the whole reported flash. */
  await page.waitForTimeout(600)
}

/** Alpha first (no caret remembered yet), away to Bravo — leaving Alpha is what
 *  records its caret — then back to Alpha: the reopen that used to flash. */
async function reopenAlpha(page) {
  await openFromDrawer(page, 'alpha')
  await openFromDrawer(page, 'bravo')
  await watch(page)
  await openFromDrawer(page, 'alpha')
  return unwatch(page)
}

await runSuite('mobile-open-focus', {
  port: PORTS.mobileOpenFocus,
  server: 'preview',
  viewport: VIEWPORT,
  context: { hasTouch: true, isMobile: true, userAgent: PHONE_UA },
}, async ({ page, ok, base, browser }) => {
  await prepare(page, 'focus@example.test')
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  const wysiwyg = await reopenAlpha(page)
  ok('phone: reopening a note never focuses the editable (no IME flash)',
    wysiwyg.length > 0 && wysiwyg.every(focused => !focused),
    `${wysiwyg.filter(Boolean).length}/${wysiwyg.length} frames focused`)

  /* The guard must not make the surface unfocusable: a tap is the user asking
     for the caret (and the keyboard), and it still places it. */
  await page.getByText(NOTE['alpha.md'], { exact: true }).click()
  const tapped = await page.evaluate(() => !!document.activeElement?.closest?.('.editor-content'))
  ok('phone: a tap on the note still focuses the editor', tapped)

  /* The raw editor restores its caret unconditionally, so its open is asserted
     too — not assumed to inherit the WYSIWYG guard. */
  await page.getByRole('button', { name: 'Editor actions' }).click()
  await page.getByRole('button', { name: 'Switch to markdown' }).click()
  await page.locator('.editor-raw-markdown').waitFor({ timeout: 15000 })

  await watch(page)
  await openFromDrawer(page, 'bravo')
  const code = await unwatch(page)
  ok('phone: opening a note never focuses the raw editor (no IME flash)',
    code.length > 0 && code.every(focused => !focused),
    `${code.filter(Boolean).length}/${code.length} frames focused`)

  /* Counter-case (review): a touchscreen desktop has no IME to raise, so the
     platform must be what decides — a pointer-media predicate withholds the
     caret restore here and this leg fails. */
  const desktopTouch = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, userAgent: DESKTOP_UA })
  try {
    const desktopPage = await desktopTouch.newPage()
    await prepare(desktopPage, 'focus-desktop@example.test')
    await desktopPage.goto(base, { waitUntil: 'domcontentloaded' })

    const trail = await reopenAlpha(desktopPage)
    ok('touch-desktop: the caret restore keeps its focus where no IME can rise',
      trail.some(Boolean),
      `${trail.filter(Boolean).length}/${trail.length} frames focused`)
  } finally {
    await desktopTouch.close()
  }
})
