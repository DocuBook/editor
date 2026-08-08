/**
 * Trash UI e2e (web/Docker) — server-side trash contract:
 *   1. Trash button reads the REAL trash state: disabled while `.trash/` empty.
 *   2. With `.trash/` content → enabled + count badge.
 *   3. Restore from the panel → file back in the tree, button disabled again.
 *
 * Note: the Linux-only delete→`.trash/` move is covered by the cfg(target_os
 * = "linux") Rust unit test. On macOS dev the delete path goes to the system
 * Trash, so this e2e seeds `.trash/` directly — the UI contract (list/restore/
 * empty state) is platform-independent.
 *
 * Logs: test/artifacts/trash.{server,browser}.log
 * Run: npm run build && node test/trash.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4274
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-trash'
const VAULT = `${DATA}/vaults/myvault`
const BASE = `http://localhost:${PORT}`

const ADMIN = { email: 'trash@test.dev', password: 'password1' }
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true }) // empty vault — no .trash yet

const server = startServer('trash', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
let browser
let page

async function api(cmd, args = {}, cookie = '') {
  const res = await fetch(`${BASE}/api/${cmd}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(args),
  })
  return { status: res.status, text: await res.text() }
}

try {
  await waitForServer(BASE)
  // API bootstrap: admin → session → open vault (vault dir pre-created on disk)
  const sa = await api('setup_admin', { email: ADMIN.email, password: ADMIN.password })
  ok('setup_admin: ok', sa.status === 200, sa.text.slice(0, 80))
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN),
  })
  const setCookie = login.headers.get('set-cookie') || ''
  ok('login: session cookie issued', login.status === 200 && /db_session=/.test(setCookie), String(login.status))
  const cookie = setCookie.split(';')[0]
  const ov = await api('open_vault', { path: VAULT }, cookie)
  ok('open_vault: ok', ov.status === 200, ov.text.slice(0, 80))

  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  // The API login cookie must reach the browser context (Node fetch ≠ browser).
  await context.addCookies([{ name: 'db_session', value: cookie.split('=').slice(1).join('='), url: BASE }])
  page = await context.newPage()
  attachLogging(page, 'trash')
  // Seed persisted vault so resumeVault auto-opens it on boot
  await page.addInitScript((vaultPath) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
  }, VAULT)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Empty vault', { timeout: 10000 })
  ok('vault open: empty vault shown', true)

  // 1. Empty trash → button disabled (real state read from list_trash)
  const trashBtn = page.locator('button:has-text("Trash")')
  await page.waitForTimeout(1200) // let the mount-time list_trash settle
  ok('trash button: disabled when empty', await trashBtn.isDisabled(), '')
  ok('trash button: no badge when empty', !(await trashBtn.innerText()).includes('1'))

  // 2. Seed the server-side trash → reload → button enabled + badge
  mkdirSync(`${VAULT}/.trash`, { recursive: true })
  writeFileSync(`${VAULT}/.trash/1700000000000-notes.md`, '# Notes\n\ncontent')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=Empty vault', { timeout: 10000 })
  await page.waitForTimeout(1200)
  ok('trash button: enabled when trash has files', await trashBtn.isEnabled(), '')
  ok('trash button: badge shows 1', (await trashBtn.innerText()).includes('1'))

  // 3. Open the panel → restore → back in the tree, button disabled again
  await trashBtn.click()
  await page.waitForSelector('text=Trash (1)', { timeout: 5000 })
  await page.getByText('notes.md', { exact: true }).click() // restore row
  await page.waitForTimeout(1500)
  ok('trash button: disabled again after restore', await trashBtn.isDisabled(), '')
  await page.getByRole('button', { name: 'Back' }).click()
  await page.waitForSelector('text=notes', { timeout: 5000 })
  ok('restore: notes.md back in the tree', await page.getByText('notes', { exact: true }).count() >= 1)
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('trash', results, { serverLog: server.logPath })) process.exitCode = 1
