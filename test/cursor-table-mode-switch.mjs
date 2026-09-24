/**
 * Cursor preservation across the Editor ↔ Markdown switch, driven through a
 * table.
 *
 * Why a real browser: the failure this guards was geometric only in the sense
 * that it needed a live ProseMirror document. A BlockNote table is ONE block
 * holding every cell, while the raw editor measures offsets across the whole
 * table. Capturing the position of the paragraph under the caret (the old
 * behaviour) reported a cell-local offset, so the raw caret came back to the
 * FIRST cell — silently, with no error. Asserting on the mapping utility alone
 * would pass while the component fed it the wrong offset, so the round trip is
 * driven here end to end.
 *
 * Run: npm run build && node test/cursor-table-mode-switch.mjs
 *
 * Logs: test/artifacts/cursor-table-mode-switch.{server,browser}.log
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser, stubBackend, PORTS, ok as createOk } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = PORTS.cursorTable
const BASE = `http://localhost:${PORT}`
const VIEWPORT = { width: 1000, height: 820 }

/** Frontmatter shifts every absolute offset; the cells and the trailing
 *  paragraph are unique strings so `indexOf` cannot land on another word. */
const NOTE_TEXT = [
  '---',
  'title: Cursor',
  '---',
  '',
  '# Heading',
  '',
  '| alpha | bravo |',
  '| --- | --- |',
  '',
  'After table',
  '',
].join('\n')

const BRAVO_END = NOTE_TEXT.indexOf('bravo') + 'bravo'.length
const ALPHA_END = NOTE_TEXT.indexOf('alpha') + 'alpha'.length

const results = []
const ok = createOk(results)

const server = startServer('cursor-table-mode-switch', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-cursor-table', wwwDir: 'dist',
})

let browser
let page

/** Where the WYSIWYG caret sits: the anchor text node and offset inside it. */
const editorCaret = () => page.evaluate(() => {
  const selection = window.getSelection()
  const node = selection?.anchorNode ?? null
  return { text: node?.textContent ?? '', offset: selection?.anchorOffset ?? -1 }
})

/** Put the caret at the end of the second cell, checking after every key press
 *  instead of counting presses blind.
 *
 *  A dropped key used to decide the outcome: the click already lands past the
 *  last glyph (offset 5), so when `Home` was missed the five `ArrowRight`s ran
 *  out of the cell and into the next paragraph, and the caret came back as
 *  "After table" offset 4. Both steps below are therefore observation-driven —
 *  `Home` retries while the caret is not at the cell start (idempotent there),
 *  and `ArrowRight` is only sent while the caret is short of the target, so no
 *  retry can overshoot into the following block. */
async function placeCaretAtBravoEnd() {
  const target = 'bravo'
  await page.getByText(target, { exact: true }).click()
  for (let i = 0; i < 5 && (await editorCaret()).offset !== 0; i++) {
    await page.keyboard.press('Home')
    await page.waitForTimeout(50)
  }
  for (let i = 0; i < 10; i++) {
    const caret = await editorCaret()
    if (caret.text !== target || caret.offset >= target.length) break
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
  }
  return editorCaret()
}

async function openNote() {
  const entry = page.getByText('notes', { exact: true }).first()
  await entry.waitFor({ timeout: 15000 })
  await entry.click()
  await page.waitForTimeout(2500)
}

async function run() {
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: VIEWPORT })
  const logging = attachLogging(page, 'cursor-table-mode-switch')
  await stubBackend(page, { email: 'cursor@example.test', noteText: NOTE_TEXT })
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await openNote()

  // ── 1. Put the WYSIWYG caret at the end of the SECOND cell ──
  await page.locator('.ProseMirror').waitFor({ timeout: 15000 })
  const placed = await placeCaretAtBravoEnd()
  ok('caret starts inside the second cell', placed.text === 'bravo' && placed.offset === 5, JSON.stringify(placed))

  // ── 2. Switch to raw Markdown; the caret must land on the same character ──
  await page.locator('button[aria-label="Markdown mode"]').click()
  const textarea = page.locator('textarea.editor-raw-markdown')
  await textarea.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(400)
  const rawOffset = await textarea.evaluate((el) => el.selectionStart)
  ok('raw caret lands after the second cell, not the first',
    rawOffset === BRAVO_END && rawOffset !== ALPHA_END,
    `raw=${rawOffset} bravoEnd=${BRAVO_END} alphaEnd=${ALPHA_END}`)

  // ── 3. Switch back; the caret must return to the same cell ──
  await page.locator('button[aria-label="Editor (WYSIWYG) mode"]').click()
  await page.locator('.ProseMirror').waitFor({ timeout: 15000 })
  await page.waitForTimeout(600)
  const restored = await editorCaret()
  ok('WYSIWYG caret returns to the second cell', restored.text === 'bravo' && restored.offset === 5, JSON.stringify(restored))

  ok('no browser errors', logging.errors.length === 0, logging.errors.slice(0, 2).join(' | '))

  summary('cursor-table-mode-switch', results, { serverLog: server.logPath })
}

try {
  await waitForServer(BASE, 60)
  await run()
} catch (error) {
  ok('harness', false, String(error))
  summary('cursor-table-mode-switch', results, { serverLog: server.logPath })
} finally {
  await browser?.close()
  server.bin.kill()
}
