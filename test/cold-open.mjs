/**
 * Cold open e2e — a note opened for the first time never paints the raw source
 * of its math, diagram or code blocks.
 *
 * Each of those blocks is a React node view whose editable source (the LaTeX,
 * the Mermaid text, the code) is attached to the page before its React render
 * lands. When the commit that mounted the editor was not a sync one, that
 * render waited for a passive effect that React runs after the paint, so the
 * first frame showed every such block as bare source text (see the mount gate
 * in WysiwygEditorHost). The source is visible in that window only as a DIRECT
 * child of the node view's `.react-renderer` element; once React has rendered,
 * it sits inside the block's own markup (popup or `pre > code`).
 *
 * A requestAnimationFrame sampler records every frame from the first one, so a
 * single painted frame of raw source fails the run.
 *
 * Run: npm run build && node test/cold-open.mjs
 */
import { runSuite, PORTS } from './lib.mjs'

const note = (title) => `# ${title}

hello world

\`\`\`js
const codeLine = 1
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

$$
\\frac{1}{2}
$$

inline $x^2$ math
`

await runSuite('cold-open', {
  port: PORTS.coldOpen,
  seed: [
    { path: 'notes.md', content: note('First note') },
    { path: 'other.md', content: note('Second note') },
  ],
  setup: async ({ page, vaultPath }) => {
    await page.addInitScript((path) => {
      if (!localStorage.getItem('docubook:vault')) {
        localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
      }
      /* Every frame in which a node view's source is still outside its React
         render, and visible. rAF runs right before the frame is painted. */
      const rawFrames = []
      window.__rawSourceFrames = rawFrames
      const sample = () => {
        for (const source of document.querySelectorAll('.bn-editor .react-renderer > [data-node-view-content-react]')) {
          const box = source.getBoundingClientRect()
          if (box.width > 0 && box.height > 0 && source.textContent.trim()) {
            rawFrames.push(`${source.parentElement.className}: ${source.textContent.slice(0, 30)}`)
          }
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, vaultPath)
  },
}, async ({ page, ok, base }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })

  /** Open a note from the tree, then wait until all of its previews rendered. */
  const open = async (name, title) => {
    const entry = page.getByText(name, { exact: true }).first()
    await entry.waitFor({ timeout: 15000 })
    await entry.click()
    await page.getByRole('heading', { name: title }).waitFor({ timeout: 15000 })
    const editor = page.locator('.bn-editor')
    await editor.locator('[data-content-type="diagram"] .bn-preview-container svg').waitFor({ timeout: 15000 })
    await editor.locator('[data-content-type="mathBlock"] .bn-preview-container .katex').waitFor({ timeout: 15000 })
    await editor.locator('[data-content-type="codeBlock"] .code-block-header').waitFor({ timeout: 15000 })
    // The sampler's next frame, so the settled state is in the record too.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    return page.evaluate(() => window.__rawSourceFrames.splice(0))
  }

  const first = await open('notes', 'First note')
  ok('first note opened in a cold editor: no frame shows raw block source', first.length === 0, first.slice(0, 3).join(' | '))

  /* A second cold editor, created while the first one is mounted. */
  const second = await open('other', 'Second note')
  ok('second note opened in a cold editor: no frame shows raw block source', second.length === 0, second.slice(0, 3).join(' | '))
})
