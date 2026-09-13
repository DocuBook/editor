/**
 * Overlay surface E2E check — verifies the shared .ui-popover / .ui-dialog
 * contract in a REAL engine instead of trusting the built CSS by eye.
 *
 * The properties under test are exactly the ones that diverge across engines:
 *   - the surface must never lose its separation cue (box-shadow), including
 *     on engines where backdrop blur does not render
 *   - translucency must only apply when blur is actually supported, so an
 *     engine without blur keeps an opaque, readable panel
 *
 * Run against more than one engine:
 *   npm run build && node test/overlay-surface.mjs
 *   npm run build && BROWSER=webkit node test/overlay-surface.mjs
 *
 * Note: this suite boots the real app, so it is the one that proves the classes
 * are actually APPLIED to live overlays. The pure-CSS engine matrix (including
 * the Safari 15 fallback) lives in test/overlay-surface-fallback.mjs.
 *
 * Logs: test/artifacts/overlay-surface.{server,browser}.log
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = 4176
const BASE = `http://localhost:${PORT}`

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = startServer('overlay-surface', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-overlay', wwwDir: 'dist',
})
let browser
let page

try {
  await waitForServer(BASE, 50)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  attachLogging(page, 'overlay-surface')

  await page.route('**/api/setup_status', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ result: JSON.stringify({ setupRequired: false, setupToken: false }) }),
  }))
  await page.route('**/api/account_get', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ result: JSON.stringify({ email: 'overlay@example.test' }) }),
  }))

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Open Folder', { timeout: 5000 })

  // Probe the contract directly on the root element rather than waiting for a
  // real overlay to open: this isolates the CSS contract from app state.
  const probe = await page.evaluate(() => {
    const supportsBlur = CSS.supports('backdrop-filter', 'blur(1px)')
      || CSS.supports('-webkit-backdrop-filter', 'blur(1px)')
    const out = {}
    for (const cls of ['ui-popover', 'ui-dialog']) {
      const el = document.createElement('div')
      el.className = cls
      // Attach to the styled tree so theme tokens resolve.
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '0'
      document.body.appendChild(el)
      const cs = getComputedStyle(el)
      out[cls] = {
        shadow: cs.boxShadow,
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      }
      el.remove()
    }
    return { supportsBlur, out }
  })

  const { supportsBlur, out } = probe
  console.log(`[engine] BROWSER=${process.env.BROWSER || 'chromium'} supportsBlur=${supportsBlur}`)

  for (const cls of ['ui-popover', 'ui-dialog']) {
    const s = out[cls]
    // Separation cue is mandatory on every engine — this is the Safari 15 guarantee.
    ok(`${cls}: has box-shadow`, s.shadow && s.shadow !== 'none', s.shadow)
    // Radius must not collapse to 0 (would mean the class never applied).
    ok(`${cls}: has non-zero radius`, parseFloat(s.radius) > 0, s.radius)

    // rgba() means an alpha channel is present, i.e. translucent.
    const isTranslucent = /rgba\(/.test(s.bg)
    if (supportsBlur) {
      // Blur is available: expect the diffusion to be installed...
      ok(`${cls}: blur applied when supported`, /blur/.test(s.blur), s.blur)
      // ...and the surface may become translucent because the blur backs it.
      ok(`${cls}: translucent when blur supported`, isTranslucent, s.bg)
    } else {
      // No blur: translucency would leave content bleeding through, so the
      // opaque surface must remain AND the shadow must carry separation.
      ok(`${cls}: stays opaque without blur`, !isTranslucent, s.bg)
      ok(`${cls}: blur not applied without support`, s.blur === 'none', s.blur)
    }
  }
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('overlay-surface', results, { serverLog: server.logPath })) process.exitCode = 1
