/**
 * The IME strip's overflow panel ("More formatting") must paint behaviour
 * state the same way the row it unfolds from does.
 *
 * The panel's buttons are portalled outside `.bn-toolbar`
 * (FormattingToolbarPopover → Generic.Popover.Content), and BlockNote scopes
 * every toolbar-button rule to `.bn-toolbar` (blocknoteStyles.css). Without the
 * re-scope in index.css the buttons keep Mantine's filled default — all of them
 * read as pressed — while `data-selected` (the current alignment) and
 * `data-disabled` (nest/unnest) paint nothing. The state attributes and the
 * commands were always right; this suite pins the PAINT to them, against the
 * theme tokens resolved in the panel itself, so restyling cannot make the
 * assertions lie.
 *
 * Logs: test/artifacts/mobile-more-panel.{server,browser}.log
 * Screenshots: test/artifacts/mobile-more-panel/panel*.png
 */
import { runSuite, stubBackend, PORTS, openNote } from './lib.mjs'

const NOTE = 'alpha bravo charlie'

/** Panel buttons' paint + the toolbar tokens, resolved inside the panel's own
 *  scope (theme-independent: assertions compare against these, never against
 *  baked-in colors). `rowBold` guards the re-scope against leaking. */
const readPaint = (page) => page.evaluate(() => {
  const panel = document.querySelector('[data-testid="formatting-toolbar-more-panel"]')
  if (!panel) return null
  const resolve = (name) => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(' + name + ')'
    panel.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  }
  const paint = (el) => ({
    test: el.getAttribute('data-test'),
    disabled: el.disabled === true,
    dataSelected: el.getAttribute('data-selected'),
    bg: getComputedStyle(el).backgroundColor,
    fg: getComputedStyle(el).color,
  })
  const rowBold = document.querySelector('.bn-toolbar button[data-test="bold"]')
  return {
    inToolbar: !!panel.closest('.bn-toolbar'),
    tokens: {
      menu: resolve('--bn-colors-menu-background'),
      selected: resolve('--bn-colors-selected-background'),
      disabled: resolve('--bn-colors-disabled-background'),
      mantineDisabled: resolve('--mantine-color-disabled'),
      mantineFill: resolve('--mantine-primary-color-filled'),
    },
    buttons: [...panel.querySelectorAll('button')].map(paint),
    rowBold: rowBold ? paint(rowBold) : null,
  }
})

await runSuite('mobile-more-panel', {
  port: PORTS.mobileMorePanel,
  server: 'preview',
  viewport: { width: 480, height: 720 },
  context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
}, async ({ page, ok, base }) => {
  await stubBackend(page, { email: 'more-panel@test.dev', noteText: `# Notes\n\n${NOTE}\n\nsecond block\n` })
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
    Object.assign(vp, { width: 480, height: window.innerHeight, scale: 1, offsetTop: 0, offsetLeft: 0 })
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

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="sidebar-toggle"]').click()
  await openNote(page, NOTE)

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
  ok('IME strip is up', await page.locator('.bn-mobile-formatting-toolbar').count() > 0)
  ok('more trigger is on the strip', await page.locator('[data-test="moreformatting"]').count() > 0)

  await page.locator('[data-test="moreformatting"]').tap()
  await page.waitForTimeout(500)
  const fresh = await readPaint(page)
  ok('overflow panel opens', fresh !== null)
  if (!fresh) return
  await page.screenshot({ path: 'test/artifacts/mobile-more-panel/panel.png' })

  ok('panel is portalled outside .bn-toolbar (the re-scope\'s premise)', !fresh.inToolbar)
  ok('tokens: editor palette is distinguishable in this theme',
    fresh.tokens.selected !== fresh.tokens.menu && fresh.tokens.disabled !== fresh.tokens.mantineDisabled,
    JSON.stringify(fresh.tokens))

  const by = (state, test) => state.buttons.find(b => b.test === test)
  const cursor = fresh.buttons.find(b => b.test === 'alignTextLeft')
  ok('cursor sits in a left-aligned, top-level, nestable block',
    cursor?.dataSelected === 'true' && by(fresh, 'unnestBlock')?.disabled === true && by(fresh, 'nestBlock')?.disabled === false,
    JSON.stringify(fresh.buttons.map(b => ({ t: b.test, sel: b.dataSelected, dis: b.disabled }))))

  /* The regression: with Mantine's filled default every button read as
     pressed — the active alignment identical to its neighbours. */
  ok('align: only the active alignment paints selected',
    by(fresh, 'alignTextLeft').bg === fresh.tokens.selected &&
    by(fresh, 'alignTextCenter').bg === fresh.tokens.menu &&
    by(fresh, 'alignTextRight').bg === fresh.tokens.menu,
    JSON.stringify(fresh.buttons.filter(b => b.test?.startsWith('align')).map(b => [b.test, b.bg])))
  ok('enabled buttons paint the toolbar palette — menu, selected only where data-selected',
    fresh.buttons.filter(b => !b.disabled)
      .every(b => b.bg === (b.dataSelected === 'true' ? fresh.tokens.selected : fresh.tokens.menu)) &&
    fresh.buttons.every(b => b.bg !== fresh.tokens.mantineFill),
    JSON.stringify({ fill: fresh.tokens.mantineFill, buttons: fresh.buttons.map(b => [b.test, b.bg]) }))
  ok('unnest: disabled paints the editor palette, not Mantine\'s',
    by(fresh, 'unnestBlock').bg === fresh.tokens.disabled &&
    by(fresh, 'unnestBlock').fg !== by(fresh, 'nestBlock').fg,
    JSON.stringify({ disabled: by(fresh, 'unnestBlock').bg, editor: fresh.tokens.disabled, mantine: fresh.tokens.mantineDisabled }))

  await page.locator('[data-testid="formatting-toolbar-more-panel"] [data-test="alignTextCenter"]').tap()
  await page.waitForTimeout(400)
  const after = await readPaint(page)
  ok('align: tapping centre moves data-selected AND the selected paint',
    by(after, 'alignTextCenter').dataSelected === 'true' && by(after, 'alignTextCenter').bg === after.tokens.selected &&
    by(after, 'alignTextLeft').bg === after.tokens.menu,
    JSON.stringify(after.buttons.filter(b => b.test?.startsWith('align')).map(b => [b.test, b.dataSelected, b.bg])))
  const centered = await page.evaluate(() => [...document.querySelectorAll('.bn-editor [data-text-alignment="center"]')]
    .map(el => (el.textContent || '').slice(0, 40)))
  ok('align: the paragraph itself is centred', centered.some(text => text.includes('alpha bravo charlie')), JSON.stringify(centered))
  await page.screenshot({ path: 'test/artifacts/mobile-more-panel/panel-centred.png' })

  ok('row buttons keep their own flat paint (re-scope did not leak)',
    after.rowBold !== null && after.rowBold.bg === after.tokens.menu, JSON.stringify(after.rowBold))
})
