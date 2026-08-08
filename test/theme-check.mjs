/**
 * Theme E2E check — verifies the named-theme system (dark/light) renders the
 * whole app without regression and that the Appearance picker works.
 *
 * Logs: test/artifacts/theme-check.{server,browser}.log
 * Run: npm run build && node test/theme-check.mjs
 * (serves dist/ via vite preview; uses the cached Playwright Chromium)
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = 4173
const BASE = `http://localhost:${PORT}`

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = startServer('theme-check', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-theme', wwwDir: 'dist',
})
let browser
let page

try {
  await waitForServer(BASE, 50)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  attachLogging(page, 'theme-check')

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

  // ── Appearance picker (Settings → Appearance tab) ──
  await page.keyboard.press('Meta+,')
  await page.waitForSelector('button:has-text("Appearance")', { timeout: 5000 })
  await page.locator('button:has-text("Appearance")').click()
  await page.waitForTimeout(400)
  await page.locator('button:has-text("Bright Surfaces")').click()
  await page.waitForTimeout(400)
  ok('picker: switches to light', (await theme()) === 'light', await theme())
  ok('picker: persists to localStorage', (await page.evaluate(() => localStorage.getItem('docubook:theme'))) === 'light')
  ok('picker: body bg updated', (await bodyBg()) === 'rgb(255, 255, 255)', await bodyBg())
  await page.locator('button:has-text("Midnight")').click()
  await page.waitForTimeout(400)
  ok('picker: back to dark', (await theme()) === 'dark', await theme())
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('theme-check', results, { serverLog: server.logPath })) process.exitCode = 1
