/**
 * Web UI smoke — boots the real server, walks setup-wizard + login flow
 * through the browser, verifies the main UI renders.
 *
 * Run: npm run build && node frontend/e2e/web-smoke.mjs
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = 4273
// Kill any stale server from a previous run (port may be held after bin.kill)
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-data'
const BASE = `http://localhost:${PORT}`
const CHROMIUM = process.env.CHROMIUM_EXE
  || '/Users/wildan/Library/Caches/ms-playwright/chromium-1091/chrome-mac/Chromium.app/Contents/MacOS/Chromium'

const ADMIN = { email: 'e2e@test.dev', password: 'password1' }
const click = (name) => `button:has-text("${name}")`

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

rmSync(DATA, { recursive: true, force: true })
mkdirSync('frontend/e2e/screenshot', { recursive: true })

const bin = spawn('server/target/debug/docubook-server', [], {
  env: { ...process.env, DATA_DIR: DATA, WWW_DIR: 'dist', PORT: String(PORT) },
  stdio: 'ignore',
})

let browser

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.status < 500) return } catch {}
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('server did not start')
}

try {
  await waitForServer()
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)) })
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 140)))

  // ── Health ──
  const h = await (await fetch(`${BASE}/api/health`)).json()
  ok('health: returns JSON', h && typeof h.result === 'string' && h.result.includes('version'))

  // ── Setup wizard ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(click('Create admin account'), { timeout: 12000 })
  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password (min 8 chars)"]', ADMIN.password)
  await page.fill('input[placeholder="Confirm password"]', ADMIN.password)
  await page.locator(click('Create admin account')).click()
  await page.waitForTimeout(2000)
  const afterSetup = await page.locator('body').innerText()
  ok('setup wizard: admin created', /Open a vault|NO VAULT|Open project/i.test(afterSetup), afterSetup.slice(0, 80))
  await page.screenshot({ path: 'frontend/e2e/screenshot/setup-done.png', fullPage: true })

  // ── Logout → Login ──
  await page.keyboard.press('Meta+,')
  await page.waitForSelector(click('System'), { timeout: 4000 })
  await page.locator(click('System')).click()
  await page.waitForSelector(click('Sign out'), { timeout: 4000 })
  await page.locator(click('Sign out')).click()
  await page.waitForTimeout(1500)
  const loginVisible = await page.locator('body').innerText()
  ok('logout: login page shown', /Sign in/i.test(loginVisible), loginVisible.slice(0, 60))

  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password"]', ADMIN.password)
  await page.waitForSelector(click('Sign in'), { timeout: 5000 })
  await page.locator(click('Sign in')).click()
  await page.waitForTimeout(2000)
  const afterLogin = await page.locator('body').innerText()
  ok('login: main UI visible', /Open a vault|Open project/i.test(afterLogin), afterLogin.slice(0, 80))
  await page.screenshot({ path: 'frontend/e2e/screenshot/login-done.png', fullPage: true })

  const noise = consoleErrors.filter(e => !/404|Failed to load|net::ERR|favicon|password|401/i.test(e))
  console.log(`\nconsole errors (filtered): ${noise.length ? noise.join('\n  ') : 'none'}`)
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  bin.kill()
}

console.log('\n=== WEB UI SMOKE RESULTS ===')
for (const [s, n, e] of results) console.log(` ${s}  ${n}${e ? ' — ' + e : ''}`)
