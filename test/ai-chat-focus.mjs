/**
 * AI chat focus audit — reproduces the "Write anything" UX bug: clicking the
 * suggestion chip should leave the prompt input focused so the user can keep
 * typing (one click, not two).
 *
 * Boots the real server + dist (like trash.mjs), opens a vault with one .md,
 * opens the WYSIWYG tab, opens the floating AI chat via the ✨ FAB, clicks the
 * "Write anything" chip and asserts `document.activeElement` is the input.
 *
 * Run: npm run build && node test/ai-chat-focus.mjs
 * Logs: test/artifacts/ai-chat-focus.{server,browser}.log
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

const PORT = 4288
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-aichat'
const VAULT = `${DATA}/vaults/myvault`
const BASE = `http://localhost:${PORT}`

const ADMIN = { email: 'aichat@test.dev', password: 'password1' }
const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
writeFileSync(`${VAULT}/test.md`, '# Hello\n\nSome content for the AI chat audit.\n')

const server = startServer('ai-chat-focus', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
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
  attachLogging(page, 'ai-chat-focus')
  // Seed persisted vault so the app auto-resumes it on boot (trash.mjs pattern)
  await page.addInitScript((vaultPath) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
  }, VAULT)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Open the .md file in the sidebar → WYSIWYG editor mounts (sidebar shows
  // names without the .md extension)
  await page.click('text=test', { timeout: 12000 })
  // The ✨ FAB appears once the WYSIWYG editor is mounted (lazy chunk)
  const fab = page.locator('button[aria-label="Ask AI"]')
  await fab.waitFor({ state: 'visible', timeout: 15000 })
  ok('fab: visible after opening .md file', true)

  await fab.click()
  const input = page.locator('input[placeholder="Send message to AI writing..."]')
  await input.waitFor({ state: 'visible', timeout: 8000 })
  // Panel auto-focuses the input on open
  await page.waitForFunction(() => {
    const el = document.activeElement
    return !!el && el.matches('input') && (el.getAttribute('placeholder') || '').includes('Send message')
  }, { timeout: 4000 })
  ok('input: auto-focused when chat opens', true)

  // ── Case A: no selection — clicking "Write anything" must keep the input focused ──
  await page.click('button:has-text("Write anything")', { timeout: 4000 })
  // Give the chip onClick + rAF-based refocus a moment to settle
  await page.waitForTimeout(150)
  const focusInfo = await page.evaluate(() => {
    const el = document.activeElement
    if (el && el.matches('input')) return `input:${el.getAttribute('placeholder')}`
    if (!el) return 'none'
    return `${el.tagName}.${(el.getAttribute('aria-label') || el.className || '').toString().slice(0, 50)}`
  })
  ok('write-anything: input stays focused after chip click', /^input:Send message/.test(focusInfo), focusInfo)

  // ── Case B: WITH selection — "Translate" (pre-fill chip) must behave the same ──
  await page.click('button[aria-label="Close AI chat"]')
  // Select the whole document so the selection-aware chip set renders
  await page.locator('.ProseMirror').click({ position: { x: 60, y: 40 } })
  await page.keyboard.press('Meta+a')
  await page.waitForTimeout(100)
  const fab2 = page.locator('button[aria-label="Ask AI"]')
  await fab2.waitFor({ state: 'visible', timeout: 5000 })
  await fab2.click()
  await input.waitFor({ state: 'visible', timeout: 8000 })
  await page.click('button:has-text("Translate")', { timeout: 4000 })
  await page.waitForTimeout(150)
  const focusInfo2 = await page.evaluate(() => {
    const el = document.activeElement
    if (el && el.matches('input')) return `input:${el.getAttribute('placeholder')}:${el.value}`
    if (!el) return 'none'
    return `${el.tagName}.${(el.getAttribute('aria-label') || el.className || '').toString().slice(0, 50)}`
  })
  ok('translate: input stays focused and pre-filled after chip click', /^input:Send message/.test(focusInfo2) && !focusInfo2.endsWith(':'), focusInfo2)
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-chat-focus', results, { serverLog: server.logPath })) process.exitCode = 1