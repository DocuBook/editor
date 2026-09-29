/**
 * Open-flash contract: opening a note paints the note, never BlockNote's
 * default document.
 *
 * A created block editor starts as BlockNote's default document — ONE empty
 * paragraph — which renders the "Enter text or type '/' for commands"
 * placeholder. The file's markdown used to be parsed in a mount effect, i.e.
 * AFTER the first paint, so the first open of every note painted that
 * placeholder for as long as the parse + re-render took (seven frames measured
 * on a two-paragraph note; longer notes sit in the parse). The instance is now
 * created WITH its markdown (editorFactory.loadMarkdownIntoEditor), and this
 * suite is the frame trail that keeps it that way.
 *
 * Sampling is per rAF across the whole open, because one painted frame IS the
 * defect — an end-state assertion cannot see it. The empty document is read
 * from the decorations that drive the placeholder
 * (`[data-is-only-empty-block]`, `[data-is-empty-and-focused]`), which exist
 * exactly while the document is a single empty block.
 *
 * Counter-case: a note with NO content still shows that state — the
 * placeholder is the whole UI for it — and opens without the load-failure
 * toast, so the rule cannot be satisfied by refusing to render empty documents.
 *
 * Logs: test/artifacts/note-open-flash.{server,browser}.log
 */
import { runSuite, stubBackend, mockAiSettings, PORTS } from './lib.mjs'

const TREE = [
  { path: 'alpha.md', name: 'alpha.md', type: 'file' },
  { path: 'bravo.md', name: 'bravo.md', type: 'file' },
  { path: 'empty.md', name: 'empty.md', type: 'file' },
]
const NOTE = {
  'alpha.md': 'alpha paragraph one\n\nalpha paragraph two',
  'bravo.md': 'bravo note paragraph',
  'empty.md': '',
}

async function prepare(page) {
  await stubBackend(page, { email: 'open-flash@example.test', noteText: NOTE['alpha.md'], tree: TREE })
  /* One text per path — the shared stub answers every read with the SAME note,
     and each leg has to know which note finished opening. Registered after
     `stubBackend`: Playwright lets the last matching route win. */
  await page.route('**/api/read_file', async route => {
    const path = route.request().postDataJSON()?.path ?? ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: NOTE[path] ?? '' }) })
  })
  await mockAiSettings(page)
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })
}

/** Frame-by-frame record of whether the editor is painting its empty document.
 *  Both decorations mark a document that is a single empty block: the first
 *  while it is the only block, the second while the empty block holds an empty
 *  selection. Either one draws the placeholder. */
const watch = (page) => page.evaluate(() => {
  window.__emptyTrail = []
  const sample = () => {
    const empty = document.querySelector('.bn-editor') !== null &&
      document.querySelector('[data-is-only-empty-block], [data-is-empty-and-focused]') !== null
    window.__emptyTrail.push(empty)
    window.__emptyFrame = requestAnimationFrame(sample)
  }
  sample()
})
const unwatch = (page) => page.evaluate(() => {
  cancelAnimationFrame(window.__emptyFrame)
  return window.__emptyTrail
})

const emptyFrames = (trail) => `${trail.filter(Boolean).length}/${trail.length} frames empty`

/** Pick a note in the tree and sample until it has rendered — the window then
 *  covers the whole open, including the editor's first paint. `text` is the
 *  note's content; an empty string waits for the editor element instead, since
 *  an empty note's textContent cannot be told apart from a missing one. */
async function openFromTree(page, name, text) {
  await watch(page)
  await page.getByText(name, { exact: true }).first().click()
  await page.waitForFunction((expected) => {
    if (!expected) return document.querySelector('.bn-editor') !== null
    return document.querySelector('.editor-content')?.textContent?.includes(expected) ?? false
  }, text, { timeout: 15000 })
  await page.waitForTimeout(300)
  return unwatch(page)
}

await runSuite('note-open-flash', {
  port: PORTS.noteOpenFlash,
  server: 'preview',
}, async ({ page, ok, base }) => {
  await prepare(page)
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByText('alpha', { exact: true }).first().waitFor({ timeout: 15000 })

  /* Cache miss: the editor instance is created for this open. */
  const first = await openFromTree(page, 'alpha', NOTE['alpha.md'].split('\n\n')[1])
  ok('first open: the empty document is never painted (cache miss)',
    first.length > 0 && first.every(empty => !empty), emptyFrames(first))

  const second = await openFromTree(page, 'bravo', NOTE['bravo.md'])
  ok('second open: the empty document is never painted',
    second.length > 0 && second.every(empty => !empty), emptyFrames(second))

  /* Cache hit: this open paints the instance the cache kept. A fix that
     re-parsed on every mount, or cleared the document before re-parsing, would
     paint the empty document here even though the first open stayed clean. */
  const cached = await openFromTree(page, 'alpha', NOTE['alpha.md'].split('\n\n')[1])
  ok('reopen (cache hit): the empty document is never painted',
    cached.length > 0 && cached.every(empty => !empty), emptyFrames(cached))

  /* Counter-case: an empty note IS the empty document, placeholder included. */
  const emptyNote = await openFromTree(page, 'empty', '')
  ok('empty note: still renders the empty document (placeholder path intact)',
    emptyNote.some(Boolean) && await page.getByText('Failed to load editor').count() === 0, emptyFrames(emptyNote))
})
