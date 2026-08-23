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

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Open a vault to start', { timeout: 5000 })

  // Stored preference is applied on reload.
  await page.evaluate(() => localStorage.setItem('docubook:theme', 'light'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  ok('stored theme loads', (await theme()) === 'light')

  // ── Appearance picker (Settings → Appearance tab) ──
  await page.keyboard.press('Meta+,')
  await page.waitForSelector('button:has-text("Appearance")', { timeout: 5000 })
  await page.locator('button:has-text("Appearance")').click()
  await page.locator('button:has-text("Midnight")').click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  const storedTheme = await page.evaluate(() => localStorage.getItem('docubook:theme'))
  ok('picker changes and persists theme', (await theme()) === 'dark' && storedTheme === 'dark')
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('theme-check', results, { serverLog: server.logPath })) process.exitCode = 1
