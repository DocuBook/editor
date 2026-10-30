/**
 * Web unload save e2e — an edit typed just before the browser tab reloads or
 * goes away must reach disk. The desktop shell asks the frontend before it
 * closes (`app:before-close`); a browser tab has no such handshake, and the
 * WYSIWYG edit lives only in the editor until the 2 s autosave fires.
 *
 * Run: npm run build && node test/unload-save.mjs
 */
import { readFileSync } from 'node:fs'

import { runSuite, openNote, PORTS } from './lib.mjs'

const ORIGINAL_MARKDOWN = '# Notes\n\nhello world\n'
/* Caret to the end of the line. On macOS `End` scrolls instead of moving the
   caret (CI runs there); Cmd+Right is the macOS line end. */
const LINE_END = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'

await runSuite('unload-save', {
  port: PORTS.unloadSave,
  seed: [{ path: 'notes.md', content: ORIGINAL_MARKDOWN }],
  setup: async ({ page, vaultPath }) => {
    await page.addInitScript((path) => {
      if (!localStorage.getItem('docubook:vault')) {
        localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
      }
    }, vaultPath)
  },
}, async ({ page, ok, base, vaultPath }) => {
  const disk = () => readFileSync(`${vaultPath}/notes.md`, 'utf8')
  /** Leaving with a dirty tab asks to confirm; the reader confirms. */
  let prompts = 0
  page.on('dialog', dialog => {
    if (dialog.type() === 'beforeunload') prompts++
    void dialog.accept()
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await openNote(page)

  // Type and reload at once: well inside the autosave debounce.
  await page.getByText('hello world', { exact: true }).click()
  await page.keyboard.press(LINE_END)
  await page.keyboard.type(' typed before reload')
  await page.reload({ waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 40 && !disk().includes('typed before reload'); i++) await page.waitForTimeout(100)
  ok('an edit typed just before a reload is saved', disk().includes('typed before reload'), JSON.stringify(disk()))
  ok('leaving with unsaved edits asks to confirm', prompts === 1, `prompts=${prompts}`)

  // Nothing pending: leaving needs no confirmation and writes nothing.
  await openNote(page, 'hello world typed before reload')
  const before = disk()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openNote(page, 'hello world typed before reload')
  ok('a clean page leaves without a prompt', prompts === 1, `prompts=${prompts}`)
  ok('a clean page writes nothing on the way out', disk() === before)
})
