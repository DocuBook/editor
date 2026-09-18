// @vitest-environment jsdom
/**
 * Cursor mapping across every common Markdown shape, checked against the REAL
 * BlockNote parser.
 *
 * The table shift was one instance of a class: the raw source and the WYSIWYG
 * block structure can disagree about which characters are visible. A caret that
 * silently lands somewhere else is invisible in the UI, so each block is driven
 * through a full round trip — WYSIWYG offset → raw offset → WYSIWYG offset —
 * against structures the editor actually produces, not hand-written guesses.
 *
 * A caret inside real text must round-trip EXACTLY. The only characters allowed
 * to be approximate are the break artifacts the source has no glyph for: a
 * quote's paragraph break and the space BlockNote keeps after a hard break (both
 * are the character right after a `\n`).
 */
import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { getSchema } from '../../../frontend/components/editor/setup'
import { mathDollarToMathML } from '../../../frontend/utils/mathMarkdown'
import { blockText, cursorPositionAtMarkdownOffset, markdownOffsetForCursor } from '../../../frontend/utils/markdownCursor'

type AnyBlock = { id: string; type: string; content?: unknown; children?: AnyBlock[] }

/** Source markdown for each shape, and whether the app pre-converts math before
 *  parsing it (the raw file keeps `$`, so the mapping must too). */
const CASES: [string, string][] = [
  ['heading', '# Section heading\n'],
  ['inline markup', 'Intro with **boldwords** then trailer\n'],
  ['italic', 'A *italicword* tail\n'],
  ['strikethrough', 'A ~~goneword~~ tail\n'],
  ['inline code', 'Use `codefrag` here\n'],
  ['link', 'Go to [linktext](https://x.test) now\n'],
  ['wikilink', 'See [[NoteName]] here\n'],
  ['bullet', '- bulletbanana two\n'],
  ['numbered', '1. numberedcherry one\n'],
  ['task', '- [ ] taskdragonfruit todo\n'],
  ['quote', '> quoteline one\n>\n> quoteline two\n'],
  ['code block', '```js\nconst codevalue = 42\n```\n'],
  ['divider', 'Aboveword\n\n---\n\nBelowword\n'],
  ['nested list', '- parentitem\n  - childitem nested\n'],
  ['loose list', '- firstpara\n\n  secondpara\n'],
  /* BlockNote splits a list item's paragraph at its line breaks into the item's
     own content plus a nested paragraph. The item must not swallow the
     continuation, or a caret in either half lands in the other. */
  ['list continuation', '- a\n  b\n'],
  ['list continuation, following block', '- a\n  b\n\nafterword\n'],
  ['list multi-line continuation', '- a\n  b\n  c\n'],
  ['ordered list continuation', '1. a\n   b\n'],
  ['list continuation then loose paragraph', '- a\n  b\n\n  c\n'],
  ['list continuation, inline markup', '- a\n  **boldb**\n'],
  ['nested list inner continuation', '- p\n  - a\n    b\n'],
  ['list continuation between blocks', 'intro\n\n- a\n  b\n\noutro\n'],
  ['table', '| tabletalpha | tabletbravo |\n| --- | --- |\n| tabletcharlie | tabletdelta |\n'],
  ['table inline markup', '| **boldcell** | `codecell` |\n| --- | --- |\n'],
  ['two tables', '| aa | bb |\n| --- | --- |\n\nmiddleword\n\n| cc | dd |\n| --- | --- |\n'],
  ['empty table', '|  |  |\n| --- | --- |\n'],
  ['empty table then paragraph', '|  |  |\n| --- | --- |\n\nafteremptyword\n'],
  ['hard break', 'line one\\\nline two\n'],
  ['two hard breaks', 'one\\\ntwo\\\nthree\n'],
  ['trailing hard break', 'line one\\\n'],
  /* BlockNote normalises whatever whitespace follows a break into one inserted
     space, so indentation and tabs on the continuation line must not drift the
     alignment (the space BlockNote keeps is the one the Markdown has no glyph
     for; a real source space there is folded away by the parser). */
  ['hard break, indented continuation', 'a\\\n   b\n'],
  ['hard break, tab continuation', 'a\\\n\tb\n'],
  ['soft break, leading space', 'a\n b\n'],
  ['nested quote hard break', '> > deep a\\\n> > deep b\n'],
  ['soft break', 'line one\nline two\n'],
  ['image', '![alttext](pic.png)\n'],
  ['block math', '$$x^2 + 1$$\n'],
  ['inline math', 'Formula $x^2$ here\n'],
]

function walk(blocks: AnyBlock[], visit: (block: AnyBlock) => void) {
  for (const block of blocks) {
    visit(block)
    if (block.children?.length) walk(block.children, visit)
  }
}

describe('markdown cursor mapping across real BlockNote block shapes', () => {
  const editor = BlockNoteEditor.create({ schema: getSchema() })

  it.each(CASES)('%s round-trips every caret', (_name, markdown) => {
    const parsed = editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown)) as unknown as AnyBlock[]
    const document = { document: parsed }

    walk(parsed, (block) => {
      const text = blockText(block)
      for (let textOffset = 0; textOffset <= text.length; textOffset++) {
        const offset = markdownOffsetForCursor(document, markdown, block.id, textOffset)
        const back = cursorPositionAtMarkdownOffset(document, markdown, offset)
        expect(back?.block.id, `${block.type} t=${textOffset} text=${JSON.stringify(text)}`).toBe(block.id)
        // A break artifact (the char right after `\n`, or the `\n` itself) has no
        // source glyph; every other caret must land back on the exact position.
        const artifact = textOffset > 0 && (text[textOffset - 1] === '\n' || text[textOffset] === '\n')
        if (!artifact) {
          expect(back?.textOffset, `${block.type} t=${textOffset} text=${JSON.stringify(text)} offset=${offset}`).toBe(textOffset)
        } else {
          expect(back?.textOffset, `${block.type} t=${textOffset}`).toBeGreaterThanOrEqual(textOffset)
        }
      }
    })
  })
})
