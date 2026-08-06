/**
 * Theme E2E check — verifies the named-theme system (dark/light) renders the
 * whole app without regression and that the Appearance picker works.
 *
 * Run: npm run build && node e2e/theme-check.mjs
 * (serves dist/ via vite preview; uses the cached Playwright Chromium)
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = 'frontend/e2e/screenshot'
mkdirSync(OUT, { recursive: true })

const PORT = 4173
const BASE = `http://localhost:${PORT}`
const CHROMIUM = process.env.CHROMIUM_EXE
  || '/Users/wildan/Library/Caches/ms-playwright/chromium-1091/chrome-mac/Chromium.app/Contents/MacOS/Chromium'

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { shell: true, stdio: 'ignore' })
let browser

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE); if (r.status < 500) return } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('vite preview did not start')
}

try {
  await waitForServer()
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)) })
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 140)))

  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  // ── DARK (default) ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok('dark: data-theme=dark (default)', (await theme()) === 'dark', await theme())
  ok('dark: body background token', (await bodyBg()) === 'rgb(12, 12, 13)', await bodyBg())
  const darkMeta = await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content)
  ok('dark: browser chrome color (meta theme-color)', darkMeta === '#0c0c0d', darkMeta)
  const darkText = await page.locator('body').innerText()
  ok('dark: main UI rendered', /Open a vault to start/i.test(darkText), darkText.slice(0, 80))
  await page.screenshot({ path: `${OUT}/dark.png`, fullPage: true })

  // ── LIGHT via stored preference (simulates returning light user) ──
  await page.evaluate(() => localStorage.setItem('docubook:theme', 'light'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  ok('light: data-theme=light from storage', (await theme()) === 'light', await theme())
  ok('light: body background token', (await bodyBg()) === 'rgb(255, 255, 255)', await bodyBg())
  const lightMeta = await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content)
  ok('light: browser chrome color (meta theme-color)', lightMeta === '#ffffff', lightMeta)
  const lightText = await page.locator('body').innerText()
  ok('light: main UI rendered', /Open a vault to start/i.test(lightText), lightText.slice(0, 80))
  await page.screenshot({ path: `${OUT}/light.png`, fullPage: true })

  // ── Picker interaction: Settings → Appearance → Light/Dark ──
  await page.evaluate(() => localStorage.removeItem('docubook:theme'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.keyboard.press('Meta+,')
  await page.waitForSelector('button:has-text("Appearance")', { timeout: 4000 })
  await page.locator('button:has-text("Appearance")').click()
  await page.waitForTimeout(400)
  await page.locator('button:has-text("Bright Surfaces")').click()
  await page.waitForTimeout(400)
  ok('picker: switches to light', (await theme()) === 'light', await theme())
  ok('picker: persists to localStorage', (await page.evaluate(() => localStorage.getItem('docubook:theme'))) === 'light')
  ok('picker: body bg updated', (await bodyBg()) === 'rgb(255, 255, 255)', await bodyBg())
  await page.screenshot({ path: `${OUT}/picker-light.png` })
  await page.locator('button:has-text("Midnight")').click()
  await page.waitForTimeout(400)
  ok('picker: back to dark', (await theme()) === 'dark', await theme())

  const noise = consoleErrors.filter(e => !/404|Failed to load resource|net::ERR|favicon/.test(e))
  console.log(`\nconsole errors (filtered noise): ${noise.length ? '' : 'none'}`)
  noise.slice(0, 8).forEach(e => console.log('  ⚠', e))
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.kill()
}

console.log('\n=== THEME E2E RESULTS ===')
for (const [s, n, e] of results) console.log(` ${s}  ${n}${e ? ' — ' + e : ''}`)
