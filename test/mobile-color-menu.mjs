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
  await page.waitForTimeout(600)
  ok(`${model}: IME toolbar is up`, await page.locator(strip).count() > 0)

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
  const caretClosed = await page.evaluate(() => ({
    flag: document.documentElement.hasAttribute('data-toolbar-popup-open'),
    color: getComputedStyle(document.querySelector('.bn-editor')).caretColor,
  }))
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
  viewport: { width: 390, height: 720 },
  context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
}, async ({ page, ok, base }) => {
  await stubBackend(page, { email: 'color-menu@test.dev', noteText: `# Notes\n\n${NOTE}\n` })
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
       (this starts at the full 720 here), and floating-ui clips to what it
       reports. A real device needs no script — headless does. */
    const vp = new EventTarget()
    Object.assign(vp, { width: 390, height: window.innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0 })
    Object.defineProperty(window, 'visualViewport', { value: vp, configurable: true })
    window.__fakeVp = true
    window.__vvHeight = window.innerHeight
    window.__setKeyboard = (height) => {
      vp.height = height
      window.__vvHeight = height
      vp.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    }
  })

  await scenario(page, ok, base, 'ios')
  await scenario(page, ok, base, 'android')
})
