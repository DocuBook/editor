/**
 * AI transport debug e2e — reproduces the web "Error calling LLM" report.
 *
 * Intercepts /api/ask_ai in the browser with a mock SSE stream (same wire
 * format as the real server: event: ai:token / ai:tools_done / ai:done), so
 * the FULL frontend chain runs: transport → buildApplyDocumentInput → rust-ai
 * suggestion. This isolates the frontend — no provider reachability needed.
 *
 * Guards the two paths that matter for safety: a text-only request renders a
 * review, a tool request applies operations, hostile HTML in a tool payload
 * stays inert, and a semantic no-op is rejected instead of offering Accept.
 *
 * Run: npm run build && node test/ai-debug.mjs
 * Cross-browser: BROWSER=webkit node test/ai-debug.mjs (also chromium, the
 * default) — lib.mjs resolves the engine binary.
 */
import { readFileSync } from 'node:fs'

import { runSuite, mockAiSettings, mockAskAi, openNote, PORTS, sseFrames } from './lib.mjs'

const ORIGINAL_MARKDOWN = '# _Notes_\n\nhello world'
/* Both are produced by the transport mocks in `setup` and read by the body. */
let askAiHits
let aiState

await runSuite('ai-debug', {
  port: PORTS.aiDebug,
  seed: [
    { path: 'notes.md', content: ORIGINAL_MARKDOWN },
    { path: 'other.md', content: '# Other page\n\nseparate content' },
  ],
  setup: async ({ page, vaultPath }) => {
    /** Mock Path B text output and Path A tool calls at browser fetch level. */
    askAiHits = await mockAskAi(page, request => {
      const messages = String(request?.messages || '')
      const useTools = typeof request?.tools === 'string' && request.tools.length > 0
      const noOp = messages.toLowerCase().includes('leave unchanged')
      if (!useTools) {
        /** Path B content rides inside the delimiters the text-mode prompt asks
         *  for — the transport only writes a delimited payload. */
        return [
          ['ai:token', { token: '<content>## Summary\n\n- point one\n- point two\n- point three</content>' }],
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

    // AI config lives in the server's config.json now — the browser keeps no copy,
    // so the backend is mocked instead of seeding localStorage. No probe result yet
    // → the custom provider is text-only → Path B (no tools).
    aiState = await mockAiSettings(page)
    await page.addInitScript((path) => {
      if (!localStorage.getItem('docubook:vault')) {
        localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
      }
    }, vaultPath)
  },
}, async ({ page, ok, base, vaultPath }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await openNote(page)

  // Opening/closing the prompt list only toggles editor editability. TipTap emits
  // an update for that UI-only change; it must not dirty and lossy-serialize the file.
  await page.getByRole('button', { name: 'Show AI prompts' }).click()
  await page.locator('textarea[aria-label="AI prompt"]').waitFor()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(2200)
  ok('prompt open/close preserves raw Markdown bytes', readFileSync(`${vaultPath}/notes.md`, 'utf8') === ORIGINAL_MARKDOWN)

  // Select the document content so the AI edit path (update ops) is exercised
  await page.keyboard.press('Meta+a')

  // Open the AI menu (Ctrl+Alt+L) and submit — the menu input autofocuses
  await page.keyboard.press('Control+Alt+L')
  await page.waitForTimeout(900)
  const promptBox = page.locator('textarea[aria-label="AI prompt"]')
  await promptBox.waitFor()
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
  await openNote(page)
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
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // Reset the editor after Path A so its save/conflict UI and no-op toast do not
  // intercept pointer actions in the independent SSE lifecycle scenarios.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openNote(page)

  // Keep the frontend fetch pending so this suite can verify page-owned stream
  // lifetime: switching preserves it, while each explicit close/Stop cancels it.
  await page.unroute('**/api/ask_ai')
  const holds = []
  const failedRequestIds = new Set()
  page.on('requestfailed', request => {
    if (!request.url().endsWith('/api/ask_ai')) return
    try { failedRequestIds.add(String(request.postDataJSON()?.requestId ?? '')) } catch {}
  })
  const holdNextAsk = () => {
    let markStarted
    let releaseResponse
    const hold = {
      requestId: '',
      started: new Promise(resolve => { markStarted = resolve }),
      response: new Promise(resolve => { releaseResponse = resolve }),
      markStarted: () => markStarted(),
      release: () => releaseResponse(),
    }
    holds.push(hold)
    return hold
  }
  await page.route('**/api/ask_ai', async route => {
    const request = route.request().postDataJSON() || {}
    const hold = holds.shift()
    if (!hold) throw new Error('Unexpected ask_ai request in lifecycle scenario')
    hold.requestId = String(request.requestId || '')
    hold.markStarted()
    await hold.response
    const ids = [...String(request.messages || '').matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi)]
    const blockId = ids[0]?.[0] || 'missing'
    const events = typeof request.tools === 'string' && request.tools.length > 0
      ? [
          ['ai:tool_call', { toolCallId: 'lifecycle-tool', toolName: 'applyDocumentOperations', input: { operations: [{ type: 'update', id: `${blockId}$`, block: '<p>Lifecycle result</p>' }] } }],
          ['ai:tools_done', {}],
          ['ai:done', { provider: 'mock', truncated: false }],
        ]
      : [
          ['ai:token', { token: '<content>## Lifecycle result</content>' }],
          ['ai:tools_done', {}],
          ['ai:done', { provider: 'mock', truncated: false }],
        ]
    try {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseFrames(hold.requestId, events) })
    } catch (error) {
      if (!route.request().failure()) throw error
    }
  })
  const waitForAbort = async hold => {
    for (let i = 0; i < 100 && !failedRequestIds.has(hold.requestId); i++) await page.waitForTimeout(50)
    return failedRequestIds.has(hold.requestId)
  }
  const sendHeldRequest = async (hold, promptText) => {
    const box = page.locator('textarea[aria-label="AI prompt"]')
    await box.fill(promptText)
    await page.keyboard.press('Enter')
    await hold.started
  }

  const background = holdNextAsk()
  await sendHeldRequest(background, 'keep running in the background')
  await page.getByText('other', { exact: true }).first().click()
  await page.locator('[data-tab-path="other.md"]').waitFor()
  await page.waitForTimeout(250)
  ok('switching to another file keeps the owner SSE alive', !failedRequestIds.has(background.requestId))
  await page.locator('[data-tab-path="notes.md"]').click()
  await page.getByRole('button', { name: 'Stop' }).waitFor()
  background.release()
  await page.getByText('Accept', { exact: true }).waitFor()
  ok('the background page receives its completed AI result', true)
  await page.getByText('Revert', { exact: true }).click()

  const stopped = holdNextAsk()
  await sendHeldRequest(stopped, 'stop this request')
  await page.getByRole('button', { name: 'Stop' }).click()
  const stopAborted = await waitForAbort(stopped)
  stopped.release()
  ok('Stop cancels the active page SSE', stopAborted, stopped.requestId)

  const closingTab = holdNextAsk()
  await sendHeldRequest(closingTab, 'close only this page request')
  await page.getByText('other', { exact: true }).first().click()
  await page.locator('[data-tab-path="other.md"]').waitFor()
  await page.getByRole('button', { name: 'Keep my version' }).click()
  await page.getByRole('alertdialog', { name: 'Resolve file conflict' }).waitFor({ state: 'detached' })
  const neighbour = holdNextAsk()
  await sendHeldRequest(neighbour, 'keep the neighbouring page request')
  await page.getByRole('button', { name: 'Close notes.md' }).click()
  await page.locator('[data-tab-path="notes.md"]').waitFor({ state: 'detached' })
  const tabAborted = await waitForAbort(closingTab)
  await page.waitForTimeout(250)
  const neighbourSurvived = !failedRequestIds.has(neighbour.requestId)
  closingTab.release()
  neighbour.release()
  ok('closing a tab cancels only its own SSE', tabAborted && neighbourSurvived, `owner=${closingTab.requestId}, neighbour=${neighbour.requestId}`)
  await page.getByText('Accept', { exact: true }).waitFor()
  await page.getByText('Revert', { exact: true }).click()

  const vaultPageA = holdNextAsk()
  await sendHeldRequest(vaultPageA, 'close vault cancels all pages')
  await page.getByText('notes', { exact: true }).first().click()
  await page.locator('[data-tab-path="notes.md"]').waitFor()
  const vaultPageB = holdNextAsk()
  await sendHeldRequest(vaultPageB, 'second page in the same vault')
  await page.getByRole('button', { name: 'Switch vault' }).click()
  await page.getByRole('button', { name: 'Close Vault', exact: true }).click()
  await page.getByRole('alertdialog', { name: 'Close vault' }).getByRole('button', { name: 'Close', exact: true }).click()
  const vaultAbortedA = await waitForAbort(vaultPageA)
  const vaultAbortedB = await waitForAbort(vaultPageB)
  vaultPageA.release()
  vaultPageB.release()
  ok('closing the vault cancels every page SSE', vaultAbortedA && vaultAbortedB, `A=${vaultAbortedA}, B=${vaultAbortedB}`)
})
