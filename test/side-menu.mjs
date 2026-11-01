/**
 * Side menu alignment e2e — the drag handle and plus button sit vertically
 * centred on the first row of the block they belong to: the first line of text,
 * or a code block's header. Upstream hard-codes an offset per block type tuned
 * to its own CSS (headings 1–3 only, nothing for code blocks), which left the
 * menu ~13px above h4–h6 text and ~10px above the code block header. Math and
 * diagram blocks keep it on the block's top edge, not on the source below.
 *
 * Run: npm run build && node test/side-menu.mjs
 */
import { runSuite, openNote, PORTS } from './lib.mjs'

const MARKDOWN = `# Heading one

## Heading two

### Heading three

#### Heading four

##### Heading five

###### Heading six

hello world

- bullet item

> quote text

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

| cell a | cell b |
| - | - |
| cell c | cell d |
`

/** Text line box vs glyph box, and sub-pixel rounding: well under the 13px
 *  miss this suite guards against. */
const TOLERANCE_PX = 2

await runSuite('side-menu', {
  port: PORTS.sideMenu,
  seed: [{ path: 'notes.md', content: MARKDOWN }],
  setup: async ({ page, vaultPath }) => {
    await page.addInitScript((path) => {
      if (!localStorage.getItem('docubook:vault')) {
        localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
      }
    }, vaultPath)
  },
}, async ({ page, ok, base }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await openNote(page, 'Heading one')

  const ids = await page.$$eval('.bn-editor .bn-block[data-id]', blocks => blocks.map(block => block.getAttribute('data-id')))
  for (const id of ids) {
    const block = page.locator(`.bn-block[data-id="${id}"]`)
    // Centred rather than merely visible: a block left at the bottom of the
    // viewport sits under the floating AI chat, which then takes the hover.
    await block.evaluate(element => element.scrollIntoView({ block: 'center' }))
    /** The centre of the block's first row, measured from the text itself (a
     *  one-character range), not from the line-height arithmetic under test.
     *  Math and diagram blocks have no text row — their text is the source in
     *  the popup below the preview — so the menu stays on the block's top edge
     *  (`edge`), as upstream places it. */
    const row = await block.evaluate(element => {
      const content = element.querySelector('.bn-block-content')
      const header = content.querySelector('.code-block-header')
      const label = content.dataset.contentType + (content.dataset.level ? ` h${content.dataset.level}` : '')
      if (content.querySelector('.bn-preview-with-source-popup')) {
        const box = content.getBoundingClientRect()
        return { label, x: box.left + box.width / 2, hoverY: box.top + box.height / 2, y: element.getBoundingClientRect().top, edge: true }
      }
      if (header) {
        const box = header.getBoundingClientRect()
        return { label, x: box.left + box.width / 2, y: box.top + box.height / 2 }
      }
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: node => (node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      })
      const text = walker.nextNode()
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 1)
      const box = range.getBoundingClientRect()
      return { label, x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })
    let menuY = null
    for (let i = 0; i < 20; i++) {
      /* A fresh pointer move every try, 1px apart: one synthetic move after the
         scroll (which hides the menu) is sometimes not taken as a hover, and
         the menu then never shows. Read without a locator, whose auto-wait
         would block for its full timeout on every try while no menu exists. */
      await page.mouse.move(row.x + (i % 2), row.hoverY ?? row.y)
      await page.waitForTimeout(50)
      menuY = await page.evaluate(edge => {
        const box = document.querySelector('.bn-side-menu')?.getBoundingClientRect()
        return box ? (edge ? box.top : box.top + box.height / 2) : null
      }, row.edge ?? false)
      if (menuY !== null && Math.abs(menuY - row.y) <= TOLERANCE_PX) break
    }
    const delta = menuY === null ? null : menuY - row.y
    ok(row.edge ? `side menu sits on the top edge of ${row.label}` : `side menu is centred on the first row of ${row.label}`,
      delta !== null && Math.abs(delta) <= TOLERANCE_PX,
      delta === null ? 'menu not shown' : `menu − row = ${delta.toFixed(1)}px`)
  }
})
