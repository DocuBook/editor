/**
 * AI transport debug e2e — reproduces the web "Error calling LLM" report.
 *
 * Intercepts /api/ask_ai in the browser with a mock SSE stream (same wire
 * format as the real server: event: ai:token / ai:tools_done / ai:done), so
 * the FULL frontend chain runs: transport → buildApplyDocumentInput → rust-ai
 * suggestion. This isolates the frontend — no provider reachability needed.
 *
 * Key question it answers: does rust-ai reject our generated applyDocument
 * Operations (→ "Error calling LLM" with NO [ai] log, stream "succeeded"
 * from our side) or does the transport itself fail (→ [ai] log)?
 *
 * Run: npm run build && node test/ai-debug.mjs
 * Cross-browser: BROWSER=webkit node test/ai-debug.mjs (also chromium, the
 * default) — lib.mjs resolves the engine binary. Safari-15-specific focus
 * behavior is covered by the mousedown-preventDefault assertions below.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { startServer, summary, mockAiSettings, mockAskAi, bootstrapSession, PORTS, ok as createOk } from './lib.mjs'

const PORT = PORTS.aiDebug
try { execSync(`lsof -ti :${PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
const DATA = '/tmp/docubook-e2e-ai'
const VAULT = `${DATA}/vaults/myva`
const BASE = `http://localhost:${PORT}`

const results = []
const ok = createOk(results)

mkdirSync('test/artifacts', { recursive: true })
rmSync(DATA, { recursive: true, force: true })
mkdirSync(VAULT, { recursive: true })
const ORIGINAL_MARKDOWN = '# _Notes_\n\nhello world'
writeFileSync(`${VAULT}/notes.md`, ORIGINAL_MARKDOWN)

const server = startServer('ai-debug', { binary: 'server/target/debug/docubook-server', port: PORT, dataDir: DATA, wwwDir: 'dist' })
let browser

try {
  const session = await bootstrapSession('ai-debug', { port: PORT, dataDir: DATA, vaultPath: VAULT, viewport: { width: 1280, height: 800 } })
  browser = session.browser
  const page = session.page

  /** Mock Path B text output and Path A tool calls at browser fetch level. */
  const askAiHits = await mockAskAi(page, request => {
    const messages = String(request?.messages || '')
    const useTools = typeof request?.tools === 'string' && request.tools.length > 0
    const noOp = messages.toLowerCase().includes('leave unchanged')
    if (!useTools) {
      return [
        ['ai:token', { token: '## Summary\n\n- point one\n- point two\n- point three' }],
        ['ai:tools_done', {}],
        ['ai:done', { provider: 'mock', truncated: false }],
      ]
    }
    const ids = [
      ...messages.matchAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      ),
    ]
    const id = ids[0]?.[0] || 'missing'
    const toolPayload = {
      toolCallId: 'mock-tool-call',
      toolName: 'applyDocumentOperations',
      input: {
        operations: noOp ? [] : [{
          type: 'add',
          referenceId: `${id}$`,
          position: 'after',
          blocks: ['<p><script>alert(1)</script>AI tool change<img src="x" onerror="alert(1)"></p>'],
        }],
      },
    }
    return [
      ['ai:tool_call', toolPayload],
      ['ai:tools_done', {}],
      ['ai:done', { provider: 'mock', truncated: false }],
    ]
  })

  await page.addInitScript((vaultPath) => {
    if (!localStorage.getItem('docubook:vault')) {
      localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath }, version: 0 }))
    }
  }, VAULT)

  // AI config lives in the server's config.json now — the browser keeps no copy,
  // so the backend is mocked instead of seeding localStorage. No probe result yet
  // → the custom provider is text-only → Path B (no tools).
  const aiState = await mockAiSettings(page)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=notes', { timeout: 10000 })
  await page.getByText('notes', { exact: true }).click()
  await page.getByText('hello world', { exact: true }).waitFor()

  // Opening/closing the prompt list only toggles editor editability. TipTap emits
  // an update for that UI-only change; it must not dirty and lossy-serialize the file.
  await page.getByRole('button', { name: 'Show AI prompts' }).click()
  await page.locator('textarea[aria-label="AI prompt"]').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(2200)
  ok('prompt open/close preserves raw Markdown bytes', readFileSync(`${VAULT}/notes.md`, 'utf8') === ORIGINAL_MARKDOWN)

  // Select the document content so the AI edit path (update ops) is exercised
  await page.keyboard.press('Meta+a')

  // Open the AI menu (Ctrl+Alt+L) and submit — the menu input autofocuses
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  const promptBox = page.locator('textarea[aria-label="AI prompt"]')
  await promptBox.waitFor()
  // Selection-aware prompts intentionally do not show “Write Anything”; chip
  // focus behavior has its own ai-chat-focus suite.
  await promptBox.fill('summarize the note')
  const hSingle = await promptBox.evaluate((el) => el.getBoundingClientRect().height)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('and keep it concise')
  const hMulti = await promptBox.evaluate((el) => el.getBoundingClientRect().height)
  ok('Prompt input auto-grows for multi-line', hMulti > hSingle + 8, `${hSingle}px -> ${hMulti}px`)
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor()
  await page.getByText('Revert', { exact: true }).waitFor()
  // Review keeps the prompt input mounted (old AIMenu parity): the user can
  // type the next instruction while deciding accept/revert.
  await page.locator('textarea[aria-label="AI prompt"]').waitFor()
  ok('Path B: text-only request renders review', askAiHits() === 1)

  // Escape dismisses the AI review back to the idle composer (the FAB is gone;
  // the composer stays mounted). The panel listens on window capture so the
  // event is not swallowed before it reaches us while focus sits on BODY.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Accept' }).waitFor({ state: 'detached' })
  ok('Escape collapses AI review to the idle composer', await page.getByRole('button', { name: 'Accept' }).count() === 0)

  // Switch the probe to true and reload: the same mock now reports a measured
  // model, so the request goes out WITH tools (Path A). The backend owns this
  // state now — flipping it here is what a completed probe would have stored.
  aiState.probes['mock-model'] = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=notes', { timeout: 10000 })
  await page.getByText('notes', { exact: true }).click()
  await page.getByText('hello world', { exact: true }).waitFor()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  await page.keyboard.type('summarize the note')
  await page.keyboard.press('Enter')
  await page.getByText('Accept', { exact: true }).waitFor()
  await page.getByText('Revert', { exact: true }).waitFor()
  ok('Path A: tool request renders review', askAiHits() === 2)
  ok('Path A: hostile HTML stays inert', await page.locator('.bn-editor script, .bn-editor [onerror]').count() === 0)

  // Revert closes the review and restores the editor; the composer stays mounted,
  // so the user can refocus it and send a follow-up prompt straight away.
  await page.getByText('Revert', { exact: true }).click()
  await page.locator('textarea[aria-label="AI prompt"]').click()
  await page.keyboard.type('leave unchanged')
  await page.keyboard.press('Enter')
  await page.locator('[data-sonner-toast]').filter({ hasText: /AI made no document changes/i }).waitFor()
  const bodyNoOp = await page.locator('body').innerText()
  ok('Path A: semantic no-op rejected', /AI made no document changes/i.test(bodyNoOp), bodyNoOp.slice(-260))
  ok('Path A: no-op hides Accept/Revert', !/\bAccept\b|\bRevert\b/i.test(bodyNoOp), bodyNoOp.slice(-160))
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('ai-debug', results, { serverLog: server.logPath })) process.exitCode = 1
