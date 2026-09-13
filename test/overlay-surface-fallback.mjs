/**
 * Overlay surface fallback check — proves the Safari 15 path without needing an
 * old WebKit binary.
 *
 * The shared .ui-popover / .ui-dialog surfaces must satisfy two invariants on
 * EVERY engine, including ones where backdrop-filter does not render:
 *   1. an opaque background, so content behind the panel cannot bleed through
 *   2. a box-shadow, so the panel still reads as elevated
 *
 * Strategy: load the REAL built stylesheet twice —
 *   - as-is                              → modern engine (blur path)
 *   - with backdrop-filter @supports blocks removed
 *                                        → engine lacking blur (Safari 15 path)
 * Removing the @supports block is exactly what an engine does when its
 * condition is false, so variant 2 yields the Safari 15 computed styles.
 *
 * Run: npm run build && node test/overlay-surface-fallback.mjs
 *      BROWSER=webkit node test/overlay-surface-fallback.mjs
 * Engine-agnostic: follows BROWSER like the other suites, but only needs CSS
 * parsing (`setContent`), so it does not depend on the app boot API.
 * Logs: test/artifacts/overlay-surface-fallback.results.txt
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'

import { launchBrowser, summary } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

/** Brace-matched removal of @supports blocks whose condition mentions backdrop-filter. */
function stripBlurSupports(src) {
  let out = src
  for (;;) {
    const i = out.indexOf('@supports')
    if (i === -1) break
    const condEnd = out.indexOf('{', i)
    const cond = out.slice(i, condEnd)
    if (!/backdrop-filter/i.test(cond)) {
      // Not a blur guard — neutralise this occurrence and keep scanning.
      out = out.slice(0, i) + ' '.repeat(condEnd - i) + out.slice(condEnd)
      continue
    }
    let depth = 0
    let j = condEnd
    for (; j < out.length; j++) {
      if (out[j] === '{') depth++
      else if (out[j] === '}') { depth--; if (depth === 0) break }
    }
    out = out.slice(0, i) + out.slice(j + 1)
  }
  return out
}

let browser
try {
  const cssFile = readdirSync('dist/assets').find(f => f.startsWith('index-') && f.endsWith('.css'))
  if (!cssFile) throw new Error('built stylesheet not found — run `npm run build` first')
  const css = readFileSync(`dist/assets/${cssFile}`, 'utf8')
  const stripped = stripBlurSupports(css)
  writeFileSync('test/artifacts/overlay-surface-fallback.no-blur.css', stripped)

  browser = await launchBrowser()
  const page = await browser.newPage()

  /** Compute the surface styles for one stylesheet variant. */
  async function probe(label, stylesheet) {
    await page.setContent(`<!doctype html><html data-theme="dark"><head><style>${stylesheet}</style></head>
      <body><div id="p" class="ui-popover"></div><div id="d" class="ui-dialog"></div></body></html>`)
    const r = await page.evaluate(() => {
      const read = id => {
        const cs = getComputedStyle(document.getElementById(id))
        return {
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
          radius: cs.borderRadius,
          blur: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        }
      }
      return { popover: read('p'), dialog: read('d') }
    })
    return { label, r }
  }

  const modern = await probe('modern', css)
  const legacy = await probe('safari15', stripped)
  const engineSupportsBlur = await page.evaluate(() =>
    CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'))

  console.log(`[engine ${process.env.BROWSER || 'chromium'}] supportsBlur=${engineSupportsBlur}`)
  console.log(`[modern stylesheet] bg=${modern.r.popover.bg} blur=${modern.r.popover.blur}`)
  console.log(`[safari15 fallback] bg=${legacy.r.popover.bg} blur=${legacy.r.popover.blur}`)

  for (const kind of ['popover', 'dialog']) {
    // ── Untouched stylesheet: behavior tracks the engine's own support ──
    if (engineSupportsBlur) {
      ok(`modern ${kind}: blur applied`, /blur/.test(modern.r[kind].blur), modern.r[kind].blur)
      ok(`modern ${kind}: translucent surface`, /rgba\(/.test(modern.r[kind].bg), modern.r[kind].bg)
    } else {
      ok(`modern ${kind}: opaque without engine blur`, /^rgb\(/.test(modern.r[kind].bg.trim()), modern.r[kind].bg)
    }
    ok(`modern ${kind}: shadow retained`, modern.r[kind].shadow !== 'none', modern.r[kind].shadow)

    // ── Safari 15: the two invariants that must never regress ──
    ok(`safari15 ${kind}: opaque surface`, /^rgb\(/.test(legacy.r[kind].bg.trim()), legacy.r[kind].bg)
    ok(`safari15 ${kind}: shadow separation cue retained`, legacy.r[kind].shadow !== 'none', legacy.r[kind].shadow)
    ok(`safari15 ${kind}: blur correctly absent`, legacy.r[kind].blur === 'none', legacy.r[kind].blur)
    ok(`safari15 ${kind}: radius still applied`, parseFloat(legacy.r[kind].radius) > 0, legacy.r[kind].radius)
  }
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
}

if (!summary('overlay-surface-fallback', results)) process.exitCode = 1
