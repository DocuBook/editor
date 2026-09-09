#!/usr/bin/env node
/**
 * Git branch switcher E2E — boots the real server with a pre-seeded git vault
 * and exercises the status-bar branch switcher end to end.
 *
 * Seed (all refs created locally, no network):
 * - local `main` pushed to origin → upstream + `origin/main`
 * - remote-only `dev` (+ `origin/HEAD` symbolic default pointer)
 * - nested `feature/nested` with BOTH local and remote refs
 *
 * Asserts the switcher contract (see `src-tauri/git/branches.rs`):
 * local + remote entries with a "remote" badge, `<remote>/HEAD` never listed, nested
 * remote deduped when its local branch exists, remote → local tracking branch
 * switch, and dedupe after switching.
 *
 * Run:
 *   npm run build && \
 *   CHROMIUM_EXE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *   node test/git-branch-e2e.mjs
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4281
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }); } catch {};
const DATA = '/tmp/docubook-git-e2e'
const VAULT = `${DATA}/vaults/gitvault`
const ORIGIN = '/tmp/docubook-git-e2e-origin.git'
const BASE = `http://localhost:${PORT}`

const ADMIN = { email: 'e2e@test.dev', password: 'password1' }
const click = (name) => `button:has-text("${name}")`
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

// ── Seed: a git vault with local `main` + remote-only `dev` ──
rmSync(DATA, { recursive: true, force: true })
rmSync(ORIGIN, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
const sh = (cmd) => execSync(cmd, { cwd: VAULT, stdio: 'ignore' })
execSync(`git init -q --bare ${ORIGIN}`, { stdio: 'ignore' })
sh('git init -q -b main')
sh('git config user.email e2e@test.dev && git config user.name E2E')
sh("printf '# hello\\n' > hello.md && git add -A && git commit -qm seed")
sh(`git remote add origin ${ORIGIN}`)
sh('git push -q -u origin main')
execSync(`git --git-dir=${ORIGIN} update-ref refs/heads/dev refs/heads/main`, { stdio: 'ignore' })
sh('git fetch -q origin')
// origin/HEAD symbolic default pointer (created on clone) must never be listed
sh('git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main')
// Nested branch with local + remote refs of the same name
sh('git switch -q -c feature/nested && git commit -qm nested --allow-empty && git push -q -u origin feature/nested && git switch -q main')

const longBranch = 'feature/' + 'long-branch-name-'.repeat(12)
sh(`git branch ${longBranch}`)
for (let i = 0; i < 20; i++) sh(`git branch layout-${i}`)

let server, browser, page
try {
  server = startServer('git-branch-e2e', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist', env: { DB_SETUP_TOKEN: 'git-branch-e2e-setup-token' } })
  await waitForServer(BASE)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  attachLogging(page, 'git-branch-e2e')

  // ── Setup wizard ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(click('Create admin account'), { timeout: 12000 })
  await page.fill('input[placeholder="Setup token (DB_SETUP_TOKEN)"]', 'git-branch-e2e-setup-token')
  await page.fill('input[type="email"]', ADMIN.email)
  await page.fill('input[placeholder="Password (min 8 chars)"]', ADMIN.password)
  await page.fill('input[placeholder="Confirm password"]', ADMIN.password)
  await page.locator(click('Create admin account')).click()
  await page.waitForFunction(() => /Open Folder|Open a vault/i.test(document.body.innerText), { timeout: 10000 })
  ok('setup: admin created, welcome shown', true)

  // ── Open the seeded vault through the UI picker ──
  await page.locator(click('Open Folder')).click()
  await page.waitForSelector('text=Open Vault', { timeout: 6000 })
  await page.waitForSelector(click('gitvault'), { timeout: 6000 })
  await page.locator(click('gitvault')).click()
  const chip = page.locator('[aria-label="Switch branch"]')
  await chip.waitFor({ timeout: 10000 })
  const chipText = await chip.innerText()
  ok('status bar: branch chip shows local branch main', chipText.includes('main'), chipText)
  ok('status bar: upstream known (no "no upstream" hint)', !chipText.includes('no upstream'), chipText)

  // ── Switcher: local + remote entries ──
  await chip.click()
  await page.waitForTimeout(1000)
  await page.waitForSelector(click('origin/dev'), { timeout: 6000 })
  const hasLocal = await page.locator(click('main')).count()
  ok('switcher: lists local branch main', hasLocal > 0)
  ok('switcher: lists remote branch origin/dev', true)
  const badge = await page.locator('text=remote').count()
  ok('switcher: remote entry has "remote" badge', badge > 0)
  // Regression: local + remote with the same nested name — the remote row must
  // be deduped, otherwise switching hits "a branch named ... already exists".
  const nestedLocalRows = await page.locator(click('feature/nested')).count()
  ok('switcher: nested local branch listed', nestedLocalRows > 0)
  const nestedRemoteRows = await page.locator(click('origin/feature/nested')).count()
  ok('switcher: nested remote deduped when local exists', nestedRemoteRows === 0, `rows: ${nestedRemoteRows}`)
  const headRows = await page.locator(click('origin/HEAD')).count()
  ok('switcher: origin/HEAD symbolic ref never listed', headRows === 0, `rows: ${headRows}`)

  const checkDropdownLayout = async (sidebarId, label) => {
    const sidebar = page.locator(sidebarId)
    const menu = sidebar.locator('button').filter({ hasText: longBranch }).locator('..')
    const bounds = await menu.evaluate(el => {
      const rect = el.getBoundingClientRect()
      const aside = el.closest('aside').getBoundingClientRect()
      return {
        fits: rect.left >= aside.left && rect.right <= aside.right && rect.top >= aside.top && rect.bottom <= aside.bottom,
        followsWidth: Math.abs(rect.width - (aside.width - 16)) <= 1,
        noHorizontalOverflow: el.scrollWidth <= el.clientWidth,
        scrollable: el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto',
      }
    })
    ok(`${label}: dropdown fits sidebar`, bounds.fits, JSON.stringify(bounds))
    ok(`${label}: dropdown follows sidebar width`, bounds.followsWidth)
    ok(`${label}: long branch has no horizontal overflow`, bounds.noHorizontalOverflow)
    ok(`${label}: long list scrolls`, bounds.scrollable)
    const longRow = sidebar.locator('button').filter({ hasText: longBranch })
    await longRow.scrollIntoViewIfNeeded()
    const name = longRow.locator('span[title]')
    ok(`${label}: long name truncated with full title`, await name.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis' && el.title === el.textContent))
  }
  await checkDropdownLayout('#desktop-sidebar', 'desktop')

  // ── Switch to the remote branch → local tracking branch created ──
  await page.locator(click('origin/dev')).click()
  await page.waitForSelector('text=Switched to origin/dev', { timeout: 6000 })
  ok('switch: success toast shown', true)
  await page.waitForFunction(
    (sel) => (document.querySelector(sel)?.textContent || '').includes('dev'),
    '[aria-label="Switch branch"]',
    { timeout: 8000 },
  )
  const after = await chip.innerText()
  ok('status bar: chip now shows dev', after.includes('dev') && !after.includes('main'), after)

  // ── Dedupe: local "dev" now shadows origin/dev ──
  await chip.click()
  await page.waitForTimeout(600)
  const devCount = await page.locator(click('dev')).count()
  const originDevCount = await page.locator(click('origin/dev')).count()
  ok('switcher: local dev listed', devCount > 0)
  ok('switcher: origin/dev deduped now local dev exists', originDevCount === 0, `origin/dev rows: ${originDevCount}`)

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 360 }]) {
    await page.setViewportSize(viewport)
    const sidebar = page.locator('#mobile-sidebar')
    if (!(await sidebar.isVisible())) {
      await page.getByRole('button', { name: 'Open sidebar drawer', exact: true }).click()
      await sidebar.getByRole('button', { name: 'Switch branch', exact: true }).click()
    }
    await sidebar.locator('button').filter({ hasText: longBranch }).waitFor()
    await checkDropdownLayout('#mobile-sidebar', `drawer ${viewport.width}x${viewport.height}`)
  }
} catch (e) {
  results.push(['FAIL', 'run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server?.bin.kill()
}

if (!summary('git-branch-e2e', results, { serverLog: server?.logPath })) process.exitCode = 1
