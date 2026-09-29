/**
 * The IME formatting toolbar's color menu must open where it can be tapped.
 *
 * The strip is pinned to the bottom edge of the visual viewport — right above
 * the soft keyboard. The stock color menu anchors to its default "bottom"
 * placement, i.e. into the keyboard's band; floating-ui then measures the room
 * below the trigger (~0px) and hands the skin a NEGATIVE available height,
 * which becomes an invalid `max-height` the browser drops. Unclamped, and with
 * Mantine's fallback to the initial placement when nothing fits, the menu was
 * neither sized nor flipped: the whole swatch list rendered outside the
 * visible viewport, behind the keyboard, so a tap could never reach a color.
 * The fix anchors the menu to the top (see ColorStyleButtonAboveKeyboard).
 *
 * Headless engines have no keyboard, so both viewport models are simulated:
 *  - ios:     only `visualViewport` shrinks (Safari — layout viewport intact)
 *  - android: the layout viewport itself shrinks (`resizes-content`)
 * Either way the menu must sit inside the visible viewport, be clamped to a
 * positive height, and a tap must apply the mark to the next typed character.
 *
 * Logs: test/artifacts/mobile-color-menu.{server,browser}.log
 * Screenshots: test/artifacts/mobile-color-menu/{model}-{menu,typed}.png
 */
import { runSuite, stubBackend, PORTS, openNote } from './lib.mjs'

const NOTE = 'alpha bravo charlie'

/** The suite's viewport — also the simulated keyboard's "closed" baseline. */
const VIEWPORT = { width: 390, height: 720 }

async function scenario(page, ok, base, model) {
  const strip = '.bn-mobile-formatting-toolbar'
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="sidebar-toggle"]').click()
  await openNote(page, NOTE)

  /* 400px of viewport disappear: comfortably past the 150px keyboard
     threshold BlockNote uses, either by shrinking only the visual viewport
     (iOS) or the layout viewport too (Android). The editor is tapped after
     that, like a reader raising the keyboard by tapping into the note — the
     strip needs both the keyboard and the editor's focus. */
  if (model === 'ios') {
    await page.evaluate(() => window.__setKeyboard(320))
  } else {
    await page.setViewportSize({ width: 390, height: 330 })
    await page.evaluate(() => window.__setKeyboard(330))
  }
  await page.waitForTimeout(200)
  await page.locator('.bn-editor').first().click()
  /* WebKit does not always move focus into the contenteditable on a synthetic
     click; the strip needs the editor focused, so claim it if the click did
     not (the reader's tap does exactly this on a device). */
  const focused = await page.evaluate(() => {
    const el = document.querySelector('.bn-editor')
    if (!el) return false
    if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus()
    return document.activeElement === el || el.contains(document.activeElement)
  })
  const premise = await page.evaluate(() => ({
    coarse: window.matchMedia('(pointer: coarse)').matches,
    touchPoints: navigator.maxTouchPoints,
    fakeVp: window.__fakeVp === true,
  }))
  ok(`${model}: touch shell is active (coarse pointer, touch points, IME viewport)`,
    focused && premise.coarse && premise.touchPoints > 0 && premise.fakeVp, JSON.stringify({ focused, ...premise }))
  /* Bounded wait, not a fixed sleep: the strip mounts once the keyboard and
     focus gates flip, which can lag the tap on a loaded machine — the check
     forgives the lag, never the absence. */
  const stripUp = await page.locator(strip).first()
    .waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false)
  ok(`${model}: IME toolbar is up`, stripUp)

  await page.locator('[data-test="colors"]').first().tap()
  await page.waitForTimeout(500)
  ok(`${model}: color menu opens`, await page.locator('[data-test="text-color-red"]').count() > 0)
  await page.screenshot({ path: `test/artifacts/mobile-color-menu/${model}-menu.png` })

  const geometry = await page.evaluate(() => {
    const menu = document.querySelector('[data-test="text-color-red"]')?.closest('[data-menu-dropdown]')
    const bar = document.querySelector('.bn-mobile-formatting-toolbar')
    if (!menu || !bar) return null
    const box = menu.getBoundingClientRect()
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      maxHeight: getComputedStyle(menu).maxHeight,
      placement: menu.closest('[data-position]')?.getAttribute('data-position'),
      stripTop: Math.round(bar.getBoundingClientRect().top),
      visibleBottom: window.__vvHeight,
    }
  })
  if (!geometry) {
    ok(`${model}: color menu measured`, false)
    return
  }
  /* The regression: bottom-anchored (behind the keyboard), off the visible
     viewport and dropped (`none`) or invalid max-height. */
  ok(`${model}: color menu opens above the toolbar, inside the visible viewport`,
    geometry.placement === 'top' && geometry.top >= 0 && geometry.bottom <= geometry.stripTop,
    JSON.stringify(geometry))
  ok(`${model}: color menu is clamped to a positive height (scrollable)`,
    /^[1-9]\d*(\.\d+)?px$/.test(geometry.maxHeight), JSON.stringify(geometry))

  /* The popup opens over the caret's own line and, on WebKit, the caret would
     paint above it — the toolbar suppresses it while a menu/popover is open. */
  const caretOpen = await page.evaluate(() => ({
    flag: document.documentElement.hasAttribute('data-toolbar-popup-open'),
    color: getComputedStyle(document.querySelector('.bn-editor')).caretColor,
  }))
  ok(`${model}: editor caret suppressed while the menu is open`,
    caretOpen.flag && caretOpen.color === 'rgba(0, 0, 0, 0)', JSON.stringify(caretOpen))

  await page.locator('[data-test="text-color-red"]').first().tap()
  await page.waitForTimeout(400)
  ok(`${model}: tapping a swatch closes the menu`, await page.locator('[data-test="text-color-red"]').count() === 0)
  /* The caret's paint is CSS: with the flag gone the editor's own
     `caret-color` must be back. Read it through a short, bounded wait — in a
     small viewport Chromium can hand back a stale computed style for an
     off-screen subtree until it re-renders; the diagnostics below name which
     element was read if it never comes back. */
  const caretClosed = await page.evaluate(async () => {
    const editors = () => [...document.querySelectorAll('.bn-editor')]
    const rendered = (el) => el.isConnected && el.getClientRects().length > 0
    const target = () => editors().find(rendered) ?? editors()[0]
    const read = () => { const el = target(); return el ? getComputedStyle(el).caretColor : null }
    let color = read()
    const deadline = performance.now() + 2000
    while (color === 'rgba(0, 0, 0, 0)' && performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      color = read()
    }
    return {
      flag: document.documentElement.hasAttribute('data-toolbar-popup-open'),
      color,
      editors: editors().map(el => ({
        rendered: rendered(el),
        focused: el === document.activeElement || el.contains(document.activeElement),
        caret: getComputedStyle(el).caretColor,
      })),
      matchedByRule: document.querySelectorAll('html[data-toolbar-popup-open] .bn-editor').length,
    }
  })
  ok(`${model}: caret restored once the menu closes`,
    !caretClosed.flag && caretClosed.color !== 'rgba(0, 0, 0, 0)', JSON.stringify(caretClosed))
  await page.keyboard.type('Z')
  await page.waitForTimeout(400)
  const marks = await page.evaluate(() => [...document.querySelectorAll('.bn-editor [data-style-type="textColor"]')]
    .map(span => ({ value: span.getAttribute('data-value'), text: span.textContent })))
  ok(`${model}: the tapped color reaches the text`, marks.some(mark => mark.value === 'red' && mark.text === 'Z'), JSON.stringify(marks))
  await page.screenshot({ path: `test/artifacts/mobile-color-menu/${model}-typed.png` })
}

await runSuite('mobile-color-menu', {
  port: PORTS.mobileColorMenu,
  server: 'preview',
  viewport: VIEWPORT,
  context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
}, async ({ page, ok, base }) => {
  await stubBackend(page, { email: 'color-menu@test.dev', noteText: `# Notes\n\n${NOTE}\n` })
  await page.addInitScript(({ width, height }) => {
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
       useVirtualKeyboard compares the current height against the tallest seen,
       and floating-ui clips to what it reports. The baseline is the suite's
       viewport height, NOT `window.innerHeight`: at document start that is the
       ambient window (0, or whatever the OS/CI window happens to be), and a
       baseline within 150px of the simulated keyboard height never registers as
       "keyboard open" — the strip never mounts. A real device needs no
       script — headless does. */
    const vp = new EventTarget()
    Object.assign(vp, { width, height, scale: 1, offsetTop: 0, offsetLeft: 0 })
    Object.defineProperty(window, 'visualViewport', { value: vp, configurable: true })
    window.__fakeVp = true
    window.__vvHeight = height
    window.__setKeyboard = (height) => {
      vp.height = height
      window.__vvHeight = height
      vp.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    }
  }, VIEWPORT)

  await scenario(page, ok, base, 'ios')
  await scenario(page, ok, base, 'android')
})
