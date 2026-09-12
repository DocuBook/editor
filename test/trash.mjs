/**
 * Trash UI e2e (web/Docker) — server-side trash contract:
 *   1. Trash tab is DISABLED while `.trash/` is empty (web has no native trash).
 *   2. With `.trash/` content → tab enabled and selectable.
 *   3. Restore from the panel → file back in the tree, tab disabled again.
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
  const initialTrash = page.waitForResponse(r => r.url().endsWith('/api/list_trash') && r.ok())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="desktop-sidebar"]', { timeout: 10000 })
  await initialTrash
  ok('vault open: empty vault shown', true)

  // Responsive sidebar journey: desktop inline/collapsible, mobile Mantine Drawer.
  const sidebarToggle = page.getByTestId('sidebar-toggle')
  ok('sidebar desktop: inline by default', await page.getByTestId('desktop-sidebar').isVisible())
  await sidebarToggle.click()
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'detached' })
  ok('sidebar desktop: collapses inline', await sidebarToggle.getAttribute('aria-expanded') === 'false')

  await page.setViewportSize({ width: 639, height: 800 })
  ok('sidebar mobile: starts closed', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await sidebarToggle.click()
  const mobileSidebar = page.getByTestId('mobile-sidebar')
  await mobileSidebar.waitFor({ state: 'visible' })
  const drawerClose = page.getByTestId('mobile-sidebar-drawer').getByRole('button', { name: 'Close sidebar drawer' })
  await drawerClose.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Close sidebar drawer')
  await page.waitForFunction(() => Math.abs(document.querySelector('.mobile-sidebar-drawer-content')?.getBoundingClientRect().x ?? -1) < 0.5)
  const drawerBox = await page.locator('.mobile-sidebar-drawer-content').boundingBox()
  const closeBox = await drawerClose.boundingBox()
  ok('sidebar mobile: close control sits outside Drawer', !!drawerBox && !!closeBox && closeBox.x >= drawerBox.x + drawerBox.width)
  ok('sidebar mobile: Drawer traps initial focus', await drawerClose.evaluate(el => document.activeElement === el))
  ok('sidebar mobile: locks body scroll', await page.locator('body').getAttribute('data-scroll-locked') !== null)

  const vaultSwitcher = mobileSidebar.getByRole('button', { name: 'Switch vault' })
  const createButton = mobileSidebar.getByRole('button', { name: 'Create file or folder' })
  const settingsButton = mobileSidebar.getByRole('button', { name: 'Open settings' })
  const [vaultBox, createBox, settingsBox] = await Promise.all([vaultSwitcher.boundingBox(), createButton.boundingBox(), settingsButton.boundingBox()])
  ok('sidebar mobile: controls ordered vault, create, settings', !!vaultBox && !!createBox && !!settingsBox && vaultBox.x < createBox.x && createBox.x < settingsBox.x)
  await vaultSwitcher.click()
  const vaultMenuBox = await mobileSidebar.locator('[data-vault-menu]').boundingBox()
  ok('sidebar mobile: vault menu opens upward inside Drawer', !!drawerBox && !!vaultBox && !!vaultMenuBox && vaultMenuBox.y + vaultMenuBox.height <= vaultBox.y && vaultMenuBox.x >= drawerBox.x && vaultMenuBox.x + vaultMenuBox.width <= drawerBox.x + drawerBox.width, JSON.stringify({ drawerBox, vaultBox, vaultMenuBox }))
  await vaultSwitcher.click()

  await page.keyboard.press('Escape')
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'sidebar-toggle')
  ok('sidebar mobile: Escape closes and restores focus', await sidebarToggle.evaluate(el => document.activeElement === el))

  await sidebarToggle.click()
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'visible' })
  await page.locator('.mobile-sidebar-drawer-overlay').click({ position: { x: 500, y: 400 } })
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  ok('sidebar mobile: backdrop closes Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')

  await sidebarToggle.click()
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'visible' })
  await page.getByTestId('sidebar-settings').click()
  await page.getByTestId('settings-modal').waitFor({ state: 'visible' })
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  ok('sidebar mobile: competing modal excludes Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await page.getByTestId('settings-modal').click({ position: { x: 5, y: 5 } })
  await page.getByTestId('settings-modal').waitFor({ state: 'detached' })

  await page.setViewportSize({ width: 640, height: 800 })
  ok('sidebar boundary: desktop collapse preference restored', await page.getByTestId('desktop-sidebar').count() === 0)
  await sidebarToggle.click()
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 639, height: 800 })
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'detached' })
  ok('sidebar boundary: resize to mobile never force-opens Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' })

  // 1. Empty trash → Trash tab disabled (web: no native trash, count 0)
  const trashTab = page.getByTestId('trash-toggle')
  ok('trash tab: disabled when empty', await trashTab.isDisabled(), '')
  ok('trash tab: not selected while the vault panel is active', await trashTab.getAttribute('aria-selected') === 'false')

  // 2. Seed the server-side trash → reload → tab enabled
  mkdirSync(`${VAULT}/.trash`, { recursive: true })
  writeFileSync(`${VAULT}/.trash/1700000000000-notes.md`, '# Notes\n\ncontent')
  const refreshedTrash = page.waitForResponse(r => r.url().endsWith('/api/list_trash') && r.ok())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await refreshedTrash
  await page.waitForSelector('text=Empty vault', { timeout: 10000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="trash-toggle"]')?.disabled)
  ok('trash tab: enabled when trash has files', await trashTab.isEnabled(), '')

  // 3. Open the panel → tab selected → restore → back in the tree, tab disabled again
  await trashTab.click()
  ok('trash tab: selected after opening the panel', await trashTab.getAttribute('aria-selected') === 'true')
  const trashPanel = page.locator('section[aria-label="Trash"]')
  await trashPanel.getByText('Trash (1)').waitFor({ timeout: 5000 })
  const restoreRow = trashPanel.getByRole('button', { name: 'Put back notes.md' })
  await restoreRow.waitFor({ timeout: 5000 })
  const restoreResponse = page.waitForResponse(r => r.url().endsWith('/api/restore_file') && r.ok())
  await restoreRow.click()
  await restoreResponse
  await page.waitForFunction(() => document.querySelector('[data-testid="trash-toggle"]')?.disabled)
  ok('trash tab: disabled again after restore', await trashTab.isDisabled(), '')
  ok('restore: row removed from the panel', await restoreRow.count() === 0)
  await trashPanel.getByRole('button', { name: 'Back' }).click()
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
