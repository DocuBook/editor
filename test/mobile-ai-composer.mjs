/**
 * The AI composer and BlockNote's mobile formatting toolbar share the strip
 * above the on-screen keyboard, and the two must not fight over it.
 *
 * Two contracts:
 *  - While the IME strip is up — the keyboard is open and the EDITOR holds
 *    focus, i.e. the reader is editing the document — the composer collapses
 *    (the same `data-ai-chat-hidden` fade the scroll-direction reveal and the
 *    sidebar drawer use) instead of being lifted above the strip or floating
 *    over it. It comes back, draft intact, the moment the strip goes.  - Focus in the composer keeps the strip down (BlockNote gates it on the
 *  - Focus in the composer keeps the strip down (BlockNote gates it on the
 *    editor's focus), and dismissing the AI menu from there — collapsing the
 *    prompt panel, accepting, Escape — must not pull the strip up: the caret
 *    restore has to leave focus alone on a system whose focus raises the IME
 *    (see utils/softKeyboard), or the programmatic focus opens the keyboard
 *    with the composer still on screen and the strip appears under it.
 *  - A text selection's prompt list on the strip (the AI button) hands off to
 *    the composer: picking a prompt that fills the input reveals the composer,
 *    focused with the prompt in place, and the strip gives way to it.
 *
 * Logs: test/artifacts/mobile-ai-composer.{server,browser}.log
 * Screenshots: test/artifacts/mobile-ai-composer/*.png
 */
import { runSuite, stubBackend, mockAiSettings, openNote, PORTS } from './lib.mjs'

const NOTE = 'alpha bravo charlie'

await runSuite('mobile-ai-composer', {
  port: PORTS.mobileAiComposer,
  server: 'preview',
  viewport: { width: 390, height: 720 },
  context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
}, async ({ page, ok, base }) => {
  await stubBackend(page, { email: 'ai-composer@test.dev', noteText: `# Notes\n\n${NOTE}\n` })
  /** A configured provider: the prompt panel and its toggle stay enabled. */
  await mockAiSettings(page)
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
    /* Touch capability. BlockNote's mobile toolbar keys off
       `isTouchDevice()` = maxTouchPoints > 0 AND `(pointer: coarse)`, and
       Playwright's WebKit does not report coarse for `hasTouch` — without the
       stub the desktop bubble menu is chosen instead of the IME strip. Other
       queries (the app's own breakpoints) delegate to the real matcher. */
    const originalMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query) => query.includes('pointer: coarse')
      ? {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }
      : originalMatchMedia(query)
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 1, configurable: true })

    /* The keyboard, as every consumer of it sees it: BlockNote's
       useVirtualKeyboard compares the current height against the tallest seen
       (this starts at the full 720 here). A real device needs no script. */
    const vp = new EventTarget()
    Object.assign(vp, { width: 390, height: window.innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0 })
    Object.defineProperty(window, 'visualViewport', { value: vp, configurable: true })
    window.__vvHeight = window.innerHeight
    window.__setKeyboard = (height) => {
      vp.height = height
      window.__vvHeight = height
      vp.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    }
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="sidebar-toggle"]').click()
  await openNote(page, NOTE)
  /* The composer is its own lazy chunk (Suspense), so wait for it explicitly. */
  await page.locator('.editor-ai-floating textarea').waitFor({ timeout: 15000 })

  /** What holds focus, whether the strip is up, and how the composer reads. */
  const read = () => page.evaluate(() => {
    const strip = document.querySelector('.bn-mobile-formatting-toolbar')
    const composer = document.querySelector('.editor-ai-floating')
    const textarea = composer?.querySelector('textarea')
    const editorEl = document.querySelector('.bn-editor')
    const active = document.activeElement
    return {
      editorFocused: !!(active && editorEl && (active === editorEl || editorEl.contains(active))),
      composerFocused: !!(active && composer && composer.contains(active)),
      strip: !!strip,
      // The fade class is only half the collapse: without `pointer-events: none`
      // (set by the same CSS rule) the composer would still swallow taps.
      pointerEvents: composer ? getComputedStyle(composer).pointerEvents : null,
      hidden: composer ? composer.getAttribute('data-ai-chat-hidden') : null,
      value: textarea ? textarea.value : null,
      selectedText: window.getSelection()?.toString() ?? '',
      prompts: document.querySelectorAll('.editor-ai-floating .ui-popover').length,
      suggestions: document.querySelectorAll('[id^="ai-toolbar-suggestion-"]').length,
    }
  })

  /* ── 1. Editing the note: the strip is up, so the composer steps out ── */
  await page.evaluate(() => window.__setKeyboard(320))
  await page.waitForTimeout(200)
  await page.locator('.bn-editor').first().click()
  /* WebKit does not always move focus into the contenteditable on a synthetic
     click; the strip needs the editor focused, so claim it if the click did
     not (the reader's tap does exactly this on a device). */
  await page.evaluate(() => {
    const el = document.querySelector('.bn-editor')
    if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus()
  })
  await page.waitForTimeout(700)
  const editing = await read()
  ok('premise: the IME strip is up over the focused editor', editing.strip && editing.editorFocused,
    JSON.stringify(editing))
  ok('the composer collapses under the strip instead of being lifted into it',
    editing.hidden === 'true' && editing.pointerEvents === 'none', JSON.stringify(editing))
  await page.screenshot({ path: 'test/artifacts/mobile-ai-composer/composer-collapsed.png' })

  /* ── 2. Leaving the editor drops the strip and the composer returns ──
     Dismissing the IME is a blur on a device (Done / a tap outside), and the
     strip is gated on the editor's focus — blurring drops it without moving
     the fake viewport, whose boot-time height BlockNote has already banked as
     its "keyboard closed" baseline. */
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.waitForTimeout(600)
  const released = await read()
  ok('leaving the editor drops the strip and reveals the composer',
    !released.strip && released.hidden === 'false' && released.pointerEvents !== 'none',
    JSON.stringify(released))

  /* ── 3. Focus in the composer keeps the strip down ── */
  await page.locator('.editor-ai-floating textarea').tap()
  await page.waitForTimeout(600)
  const composing = await read()
  ok('focus in the AI composer keeps the IME strip down and the composer up',
    composing.composerFocused && !composing.strip && composing.hidden === 'false',
    JSON.stringify(composing))

  /* ── 4. Collapsing the prompt panel must not pull the strip up ── */
  await page.locator('[aria-label="Show AI prompts"]').tap()
  await page.waitForTimeout(600)
  const opened = await read()
  ok('the prompt panel opens above the composer', opened.prompts > 0 && !opened.strip, JSON.stringify(opened))
  await page.screenshot({ path: 'test/artifacts/mobile-ai-composer/prompts-open.png' })

  await page.locator('[aria-label="Hide AI prompts"]').tap()
  await page.waitForTimeout(700)
  const collapsed = await read()
  ok('collapsing the prompt panel leaves focus out of the editor (no IME, no strip)',
    !collapsed.editorFocused && !collapsed.strip, JSON.stringify(collapsed))
  ok('the composer stays up through the dismissal', collapsed.hidden === 'false', JSON.stringify(collapsed))
  await page.screenshot({ path: 'test/artifacts/mobile-ai-composer/prompts-collapsed.png' })

  /* ── 5. Escape is the other dismissal that closes the menu ── */
  await page.locator('.editor-ai-floating textarea').tap()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const escaped = await read()
  ok('Escape from the composer keeps the strip down too',
    !escaped.editorFocused && !escaped.strip, JSON.stringify(escaped))

  /* ── 6. Back to the note: the strip returns and the composer steps aside ── */
  await page.locator('.bn-editor').first().click()
  await page.evaluate(() => {
    const el = document.querySelector('.bn-editor')
    if (el && document.activeElement !== el && !el.contains(document.activeElement)) el.focus()
  })
  await page.waitForTimeout(700)
  const resumed = await read()
  ok('tapping back into the note raises the strip and collapses the composer again',
    resumed.strip && resumed.hidden === 'true', JSON.stringify(resumed))

  /* ── 7. A selection prompt on the strip hands off to the composer ── */
  await page.keyboard.down('Shift')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.up('Shift')
  await page.waitForTimeout(300)
  const selecting = await read()
  ok('premise: text is selected behind the strip', selecting.strip && selecting.selectedText.length >= 4,
    JSON.stringify(selecting))

  /* The button's `data-test` is BlockNote's Mantine toolbar button deriving it
     from `mainTooltip` — "Edit with AI" → `editwithAI`. */
  await page.locator('[data-test="editwithAI"]').tap()
  await page.waitForTimeout(600)
  const promptUi = await read()
  ok('the AI button opens the selection prompt list over the strip',
    promptUi.suggestions >= 4 && promptUi.strip, JSON.stringify(promptUi))
  await page.screenshot({ path: 'test/artifacts/mobile-ai-composer/selection-prompts.png' })

  /* "Translate…" pre-fills the composer instead of firing the request (§items
     that call `setPrompt`), which is the hand-off this state pins. */
  await page.locator('#ai-toolbar-suggestion-2').tap()
  await page.waitForTimeout(700)
  const handedOff = await read()
  ok('picking a prompt opens the composer, focused, with the prompt filled in',
    handedOff.hidden === 'false' && handedOff.composerFocused && handedOff.value === 'Translate into ',
    JSON.stringify(handedOff))
  ok('the strip gives way to the composer', !handedOff.strip && !handedOff.editorFocused,
    JSON.stringify(handedOff))
  await page.screenshot({ path: 'test/artifacts/mobile-ai-composer/selection-handoff.png' })
})
