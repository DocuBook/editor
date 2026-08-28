#!/usr/bin/env node
/**
 * Git branch switcher E2E — boots the real server with a pre-seeded git vault
 * (a local branch `main` pushed to origin, plus a remote-only branch `dev`),
 * opens the vault through the UI and exercises the status-bar branch switcher:
 * local + remote entries, remote badge, switch → tracking branch, dedupe.
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
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
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
// Nested branch with local + remote refs of the same name
sh('git switch -q -c feature/nested && git commit -qm nested --allow-empty && git push -q -u origin feature/nested && git switch -q main')

let server, browser, page
try {
  server = startServer('git-branch-e2e', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
  await waitForServer(BASE)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  attachLogging(page, 'git-branch-e2e')

  // ── Setup wizard ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(click('Create admin account'), { timeout: 12000 })
  await page.locator('input[type="checkbox"]').check()
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
} catch (e) {
  results.push(['FAIL', 'run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server?.bin.kill()
}

if (!summary('git-branch-e2e', results, { serverLog: server?.logPath })) process.exitCode = 1
