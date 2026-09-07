/**
 * Web UI smoke — boots the real server, walks setup-wizard + login flow
 * through the browser, verifies the main UI renders and that persistent
 * sessions survive a server restart.
 *
 * Logs: test/artifacts/web-smoke.{server,browser}.log
 * Run: npm run build && node test/web-smoke.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4273
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-data'
const BASE = `http://localhost:${PORT}`

const ADMIN = { email: 'e2e@test.dev', password: 'password1' }
const SETUP_TOKEN = 'web-smoke-setup-token'
const SERVER_ENV = { DB_SETUP_TOKEN: SETUP_TOKEN }
const click = (name) => `button:has-text("${name}")`
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })

let server = startServer('web-smoke', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist', env: SERVER_ENV })
let server2
let browser
let page

try {
  await waitForServer(BASE)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  attachLogging(page, 'web-smoke')

  // ── Health ──
  const h = await (await fetch(`${BASE}/api/health`)).json()
  ok('health: returns JSON', h && typeof h.result === 'string' && h.result.includes('version'))

  // ── Setup wizard ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(click('Create admin account'), { timeout: 12000 })
  await page.waitForSelector('input[placeholder="Setup token (DB_SETUP_TOKEN)"]', { timeout: 12000 })
  await page.screenshot({ path: 'test/artifacts/web-smoke-setup-token-no-skip.png', fullPage: false })
  ok('setup wizard: admin creation is required',
    await page.getByRole('button', { name: 'Create admin account' }).isVisible())
  ok('setup wizard: no account Skip control',
    await page.getByRole('button', { name: /^Skip/ }).count() === 0 &&
    await page.locator('input[type="checkbox"]').count() === 0)
  const configBeforeSetup = await fetch(`${BASE}/api/config_set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'session_ttl_hours', value: 24 }),
  })
  ok('setup contract: config cannot bypass admin creation', configBeforeSetup.status === 401, String(configBeforeSetup.status))
  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password (min 8 chars)"]', ADMIN.password)
  await page.fill('input[placeholder="Confirm password"]', ADMIN.password)
  await page.fill('input[placeholder="Setup token (DB_SETUP_TOKEN)"]', SETUP_TOKEN)
  await page.locator(click('Create admin account')).click()
  await page.waitForFunction(() => /Open Folder|Open a vault|Open project/i.test(document.body.innerText), { timeout: 10000 })
  const afterSetup = await page.locator('body').innerText()
  ok('setup wizard: admin created', /Open Folder|Open a vault|NO VAULT|Open project/i.test(afterSetup), afterSetup.slice(0, 80))

  // ── Logout → Login ──
  await page.keyboard.press('Meta+,')
  await page.waitForSelector(click('System'), { timeout: 4000 })
  await page.locator(click('System')).click()
  await page.waitForSelector(click('Sign out'), { timeout: 4000 })
  await page.locator(click('Sign out')).click()
  await page.waitForSelector('text=Sign in', { timeout: 8000 })
  const loginVisible = await page.locator('body').innerText()
  ok('logout: login page shown', /Sign in/i.test(loginVisible), loginVisible.slice(0, 60))

  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password"]', ADMIN.password)
  await page.waitForSelector(click('Sign in'), { timeout: 5000 })
  await page.locator(click('Sign in')).click()
  // Argon2id login can take >1s — wait for the main UI, not a fixed timeout.
  await page.waitForFunction(() => /Open Folder|Open a vault|Open project/i.test(document.body.innerText), { timeout: 10000 })
  const afterLogin = await page.locator('body').innerText()
  ok('login: main UI visible', /Open Folder|Open a vault|Open project/i.test(afterLogin), afterLogin.slice(0, 80))

  // ── Restart: admin config AND session must persist (sessions.json on /data) ──
  server.bin.kill()
  await new Promise(r => setTimeout(r, 1500))
  server2 = startServer('web-smoke', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist', env: SERVER_ENV })
  await waitForServer(BASE)
  const stResponse = await (await fetch(`${BASE}/api/setup_status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })).json()
  const st = JSON.parse(stResponse.result)
  ok('redeploy: admin persisted with minimal setup contract',
    st.setupRequired === false && Object.keys(st).sort().join(',') === 'setupRequired,setupToken',
    JSON.stringify(st))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const afterReload = await page.locator('body').innerText()
  ok('restart: session persists — still logged in (no login page)', /Open Folder|Open a vault|Open project/i.test(afterReload) && !/Sign in/i.test(afterReload), afterReload.slice(0, 80))
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
  server2?.bin.kill()
}

if (!summary('web-smoke', results, { serverLog: server.logPath })) process.exitCode = 1
