/**
 * AI floating-composer e2e — focus and dismissal around the always-mounted
 * WYSIWYG composer (there is no ✨ FAB anymore).
 *
 * Guards the regressions that came with the rewrite:
 *   1. the extended prompt list (UI prompts) closes on outside mousedown AND Esc;
 *   2. the formatting-toolbar "Edit with AI" button expands the chips in one
 *      click for a text selection (used to stay hidden behind the "+" toggle);
 *   3. after the AI finishes writing and the user Accepts, the editor is
 *      clickable again (reopening the menu used to re-lock `isEditable`);
 *   4. the AI Chat tab then lists the document-bound thread and its accordion
 *      shows the recorded prompt + AI history, collapsing/expanding on click.
 *
 * Node-selection handling (a selected image, where `editor.getSelection()` is
 * undefined) is covered by the `resolveAIBlockId` unit tests instead — a mouse
 * click on a BlockNote image yields a collapsed caret, so it can't be driven
 * reliably from this e2e.
 *
 * Boots the real server + dist (like trash.mjs); /api/ask_ai is mocked in the
 * browser with the server's SSE wire format so the full transport chain runs
 * without a provider (see ai-debug.mjs for the tool-call variant).
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
const PAGEERRORS = (errors) => errors.filter((e) => e.startsWith('pageerror:'))

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

const textarea = () => page.locator('textarea[placeholder="Send message to AI writing..."]')
const showPrompts = () => page.locator('button[aria-label="Show AI prompts"]')
const aiToolbarBtn = () => page.locator('button[aria-label="Edit with AI"]')
const chip = (name) => page.getByRole('button', { name })

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
  const log = attachLogging(page, 'ai-chat-focus')

  // Mock the AI transport: a plain token stream is enough to reach review.
  await page.route('**/api/ask_ai', (route) => {
    const mockSSE = [
      'event: ai:token', 'data: "## Summary\\n\\n- point one\\n- point two"', '',
      'event: ai:tools_done', 'data: ""', '',
      'event: ai:done', 'data: {"provider":"mock","truncated":false}', '',
    ].join('\n')
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: mockSSE })
  })

  // Seed persisted vault + AI config so the app auto-resumes and the composer
  // is enabled (aiConfigured = provider ∈ savedProviders).
  await page.addInitScript((vaultPath) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
    localStorage.setItem('docubook:ai-settings', JSON.stringify({ state: {
      provider: 'openai-compatible', model: 'mock-model', savedProviders: ['openai-compatible'],
      probeTools: {}, baseUrls: { 'openai-compatible': 'http://mock.invalid/v1' }, models: {},
    }, version: 0 }))
  }, VAULT)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // ── Composer is always mounted in WYSIWYG edit mode ──
  await page.locator('[data-testid="desktop-sidebar"]').getByText('test', { exact: true }).click()
  await page.getByText('Hello', { exact: false }).first().waitFor({ timeout: 12000 })
  await textarea().waitFor({ state: 'visible', timeout: 15000 })
  ok('composer: visible after opening .md file', true)
  ok('composer: enabled when AI is configured', !(await textarea().isDisabled()))

  // ── Case A: UI prompts open from the composer and pre-fill it ──
  await page.locator('.bn-editor').click({ position: { x: 60, y: 40 } })
  await showPrompts().click()
  await chip('Continue Writing').waitFor({ timeout: 4000 })
  await chip('Summarize').waitFor({ timeout: 4000 })
  await chip('Add Action Items').waitFor({ timeout: 4000 })
  await chip(/Write Anything/).waitFor({ timeout: 4000 })
  ok('prompts: no-selection chips render', true)

  await chip(/Write Anything/).click()
  await chip('Continue Writing').waitFor({ state: 'detached', timeout: 4000 })
  const prefilled = await textarea().inputValue()
  ok('write-anything: chip pre-fills the composer', prefilled.trim().length > 0, prefilled.slice(0, 40))

  // ── Case B: extended prompts dismiss on outside click and Esc ──
  await textarea().fill('')
  await showPrompts().click()
  await chip('Continue Writing').waitFor({ timeout: 4000 })
  await page.locator('.bn-editor').click({ position: { x: 60, y: 120 } })
  await chip('Continue Writing').waitFor({ state: 'detached', timeout: 4000 })
  ok('prompts: outside mousedown dismisses the list', true)

  await showPrompts().click()
  await chip('Continue Writing').waitFor({ timeout: 4000 })
  await page.keyboard.press('Escape')
  await chip('Continue Writing').waitFor({ state: 'detached', timeout: 4000 })
  ok('prompts: Escape dismisses the list', true)

  // ── Case C: formatting-toolbar AI hand-off with a TEXT selection ──
  await page.locator('.bn-editor').click({ position: { x: 60, y: 40 } })
  await page.keyboard.press('Meta+a')
  await aiToolbarBtn().click({ timeout: 5000 })
  await chip('Improve Writing').waitFor({ timeout: 4000 })
  await chip('Fix Spelling').waitFor({ timeout: 4000 })
  await chip(/Translate/).waitFor({ timeout: 4000 })
  await chip('Simplify').waitFor({ timeout: 4000 })
  ok('toolbar AI: text selection expands chips immediately', true)
  await page.keyboard.press('Escape')
  await chip('Improve Writing').waitFor({ state: 'detached', timeout: 4000 })
  ok('toolbar AI: Escape unlocks the editor', (await page.locator('.ProseMirror').getAttribute('contenteditable')) === 'true')

  // ── Case D: after AI finishes writing + Accept, the editor is clickable again ──
  await page.locator('.bn-editor').click({ position: { x: 60, y: 40 } })
  await textarea().fill('summarize the note')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Accept' }).waitFor({ timeout: 8000 })
  ok('review: Accept/Revert shown after mocked AI write', true)
  await page.getByRole('button', { name: 'Accept' }).click()
  await page.locator('.ProseMirror').waitFor({ timeout: 4000 })
  const editable = await page.locator('.ProseMirror').getAttribute('contenteditable')
  await page.locator('.bn-editor').click({ position: { x: 60, y: 40 } })
  const focusedInside = await page.evaluate(() => {
    const el = document.activeElement
    return !!el && !!el.closest('.ProseMirror')
  })
  ok('post-accept: editor is editable again', editable === 'true', `contenteditable=${editable}`)
  ok('post-accept: click lands a caret inside the editor', focusedInside)

  // ── Case E: AI Chat tab shows the document-bound thread (prompt + AI history) ──
  await page.getByTestId('sidebar-panel-ai').click()
  const chatPanel = page.locator('section[aria-label="AI Chat"]')
  await chatPanel.waitFor({ state: 'visible', timeout: 5000 })
  await chatPanel.getByText('Threads (1)').waitFor({ timeout: 5000 })
  const threadToggle = chatPanel.locator('button[aria-expanded]').first()
  await threadToggle.waitFor({ timeout: 5000 })
  const threadLabel = (await threadToggle.innerText()).replace(/\s+/g, ' ')
  ok('ai chat: thread accordion bound to the document path', threadLabel.includes('summarize the note') && threadLabel.includes('test.md'), threadLabel)
  ok('ai chat: thread starts expanded', await threadToggle.getAttribute('aria-expanded') === 'true')
  // Message role labels are CSS-uppercased in the DOM (innerText === 'PROMPT').
  const promptLabel = chatPanel.getByText(/^prompt$/i)
  await promptLabel.waitFor({ timeout: 5000 })
  // The tool-path marker is the recorded AI message for this document thread.
  await chatPanel.getByText('Document changes ready for review.').waitFor({ timeout: 5000 })
  ok('ai chat: accordion shows prompt + AI history', true)

  await threadToggle.click()
  await promptLabel.waitFor({ state: 'detached', timeout: 5000 })
  ok('ai chat: accordion collapses', await threadToggle.getAttribute('aria-expanded') === 'false')

  await threadToggle.click()
  await promptLabel.waitFor({ state: 'visible', timeout: 5000 })
  await chatPanel.getByText('Document changes ready for review.').waitFor({ timeout: 5000 })
  ok('ai chat: accordion re-expands', await threadToggle.getAttribute('aria-expanded') === 'true')

  ok('no page errors during the whole run', PAGEERRORS(log.errors).length === 0, PAGEERRORS(log.errors).slice(0, 2).join(' | '))
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-chat-focus', results, { serverLog: server.logPath })) process.exitCode = 1
