/**
 * Web UI smoke — boots the real server, walks the setup-wizard + login flow
 * through the browser, verifies the main UI renders, the admin-creation
 * contract cannot be bypassed through the config API, and that persistent
 * sessions survive a server restart.
 *
 * Logs: test/artifacts/web-smoke.{server,browser}.log
 * Run: npm run build && node test/web-smoke.mjs
 */
import { runSuite, PORTS } from './lib.mjs'

const ADMIN = { email: 'e2e@test.dev', password: 'password1' }
const SETUP_TOKEN = 'web-smoke-setup-token'
const click = (name) => `button:has-text("${name}")`
/** The post-auth shell: setup done and a vault prompt is showing. */
const MAIN_UI = 'Open Folder|Open a vault|Open project'
const mainUiOutput = (text) => new RegExp(MAIN_UI, 'i').test(text)

await runSuite('web-smoke', {
  port: PORTS.webSmoke,
  /* The wizard itself is under test — no API-side session bootstrap. */
  session: false,
  server: { binary: 'server/target/debug/docubook-server', env: { DB_SETUP_TOKEN: SETUP_TOKEN } },
}, async ({ page, ok, base, restart }) => {
  // ── Health ──
  const h = await (await fetch(`${base}/api/health`)).json()
  ok('health: returns JSON', h && typeof h.result === 'string' && h.result.includes('version'))

  // ── Setup wizard ──
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(click('Create admin account'), { timeout: 12000 })
  await page.waitForSelector('input[placeholder="Setup token (DB_SETUP_TOKEN)"]', { timeout: 12000 })
  await page.screenshot({ path: 'test/artifacts/web-smoke-setup-token-no-skip.png', fullPage: false })
  ok('setup wizard: admin creation is required',
    await page.getByRole('button', { name: 'Create admin account' }).isVisible())
  ok('setup wizard: no account Skip control',
    await page.getByRole('button', { name: /^Skip/ }).count() === 0 &&
    await page.locator('input[type="checkbox"]').count() === 0)
  const configBeforeSetup = await fetch(`${base}/api/config_set`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'session_ttl_hours', value: 24 }),
  })
  ok('setup contract: config cannot bypass admin creation', configBeforeSetup.status === 401, String(configBeforeSetup.status))
  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password (min 8 chars)"]', ADMIN.password)
  await page.fill('input[placeholder="Confirm password"]', ADMIN.password)
  await page.fill('input[placeholder="Setup token (DB_SETUP_TOKEN)"]', SETUP_TOKEN)
  await page.locator(click('Create admin account')).click()
  await page.waitForFunction((ui) => new RegExp(ui, 'i').test(document.body.innerText), MAIN_UI, { timeout: 10000 })
  const afterSetup = await page.locator('body').innerText()
  ok('setup wizard: admin created', mainUiOutput(afterSetup), afterSetup.slice(0, 80))

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
  await page.waitForFunction((ui) => new RegExp(ui, 'i').test(document.body.innerText), MAIN_UI, { timeout: 10000 })
  const afterLogin = await page.locator('body').innerText()
  ok('login: main UI visible', mainUiOutput(afterLogin), afterLogin.slice(0, 80))

  // ── Restart: admin config AND session must persist (sessions.json on /data) ──
  await restart()
  const stResponse = await (await fetch(`${base}/api/setup_status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })).json()
  const st = JSON.parse(stResponse.result)
  ok('redeploy: admin persisted with minimal setup contract',
    st.setupRequired === false && Object.keys(st).sort().join(',') === 'setupRequired,setupToken',
    JSON.stringify(st))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const afterReload = await page.locator('body').innerText()
  ok('restart: session persists — still logged in (no login page)', mainUiOutput(afterReload) && !/Sign in/i.test(afterReload), afterReload.slice(0, 80))
})
