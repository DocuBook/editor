/**
 * Raw markdown highlighting e2e — proves the colour layer sits exactly behind
 * the textarea it decorates.
 *
 * Why a real browser: the failure mode is geometric and font-driven. The
 * highlight layer is a <pre> painted behind a transparent <textarea>, so any
 * metric the two do not share (font, size, leading, wrapping, gutter padding)
 * shifts every glyph away from the caret the browser draws. Asserting on the
 * React tree or on `innerHTML` alone would pass while the caret sits on the
 * wrong character. Every check below therefore reads computed styles and
 * `getBoundingClientRect()`, and the DOM text of the layer is compared against
 * the textarea's own value so a dropped or invented character fails the run.
 *
 * Harness: serves `dist/` through `vite preview` (same as
 * test/formatting-toolbar-compact.mjs) and answers the `/api/<cmd>` bridge with
 * fixtures, so the suite drives the real editor with no vault and no server.
 *
 * Run: npm run build && node test/raw-markdown-highlight.mjs
 *      BROWSER=webkit node test/raw-markdown-highlight.mjs
 *
 * Logs: test/artifacts/raw-markdown-highlight.{server,browser}.log
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = 4180
const BASE = `http://localhost:${PORT}`
const VIEWPORT = { width: 1000, height: 820 }

/** Fixture note: frontmatter, and one of every construct the tokenizer colours. */
const NOTE_TEXT = [
  '---',
  'title: Notes',
  'tags: demo',
  '---',
  '',
  '# Heading',
  '',
  'Body with **bold**, *italic*, `code`, ~~gone~~, [[Wiki Note]], $x^2$ and [a link](https://example.com "t").',
  'Escaped \\*asterisk\\* and \\_underscore\\_ stay literal.',
  '',
  '> quoted line',
  '',
  '- [x] done',
  '- plain bullet',
  '',
  '| a | b |',
  '| --- | --- |',
  '',
  '```mermaid',
  'graph TD;',
  '```',
  '',
  '---',
  '',
].join('\n')

const API = {
  setup_admin: { email: 'raw-md@example.test' },
  setup_status: { setupRequired: false, setupToken: false },
  account_get: { email: 'raw-md@example.test' },
  list_tree: [{ path: 'notes.md', name: 'notes.md', type: 'file' }],
  read_file: NOTE_TEXT,
  open_vault: { name: 'demo' },
  git_status: { status: '', isRepo: false, hasRemote: false, ahead: 0, upstream: '', repoState: 'clean' },
  list_trash: [],
  get_backlinks: [],
  wiki_backlinks: [],
}
/** Commands whose `result` is passed through verbatim instead of JSON-encoded. */
const RAW_RESULT = new Set(['read_file'])

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = startServer('raw-markdown-highlight', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-raw-md', wwwDir: 'dist',
})

/** Geometry + typography of both layers, in one round trip. */
const measure = () => page.evaluate(() => {
  const textarea = document.querySelector('textarea.editor-raw-markdown')
  const overlay = document.querySelector('[data-testid="raw-markdown-highlight"]')
  if (!textarea || !overlay) return null
  const box = (element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
  const metrics = (element) => {
    const style = getComputedStyle(element)
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap || style.wordWrap,
    }
  }
  const colorOf = (selector) => {
    const element = overlay.querySelector(selector) || textarea.querySelector(selector)
    return element ? getComputedStyle(element).color : ''
  }
  return {
    overlayText: overlay.textContent || '',
    textareaValue: textarea.value,
    overlayBox: box(overlay),
    textareaBox: box(textarea),
    overlayMetrics: metrics(overlay),
    textareaMetrics: metrics(textarea),
    overlayScrollHeight: overlay.scrollHeight,
    textareaScrollHeight: textarea.scrollHeight,
    counts: {
      heading: overlay.querySelectorAll('.md-heading').length,
      strong: overlay.querySelectorAll('.md-strong').length,
      emphasis: overlay.querySelectorAll('.md-emphasis').length,
      strike: overlay.querySelectorAll('.md-strike').length,
      code: overlay.querySelectorAll('.md-code').length,
      codeSpan: overlay.querySelectorAll('.md-code-span').length,
      codeLang: overlay.querySelectorAll('.md-code-lang').length,
      wikilink: overlay.querySelectorAll('.md-wikilink').length,
      math: overlay.querySelectorAll('.md-math').length,
      linkUrl: overlay.querySelectorAll('.md-link-url').length,
      quote: overlay.querySelectorAll('.md-quote').length,
      listMarker: overlay.querySelectorAll('.md-list-marker').length,
      taskMarker: overlay.querySelectorAll('.md-task-marker').length,
      tablePipe: overlay.querySelectorAll('.md-table-pipe').length,
      tableSeparator: overlay.querySelectorAll('.md-table-separator').length,
      escape: overlay.querySelectorAll('.md-escape').length,
      frontmatterKey: overlay.querySelectorAll('.md-frontmatter-key').length,
      hr: overlay.querySelectorAll('.md-hr').length,
      marker: overlay.querySelectorAll('.md-marker').length,
    },
    headingColor: colorOf('.md-heading'),
    codeSpanColor: colorOf('.md-code-span'),
    /* Plain tokens render as bare text nodes, so their colour is the layer's
       own. Reading the textarea here would return its transparent colour. */
    plainColor: getComputedStyle(overlay).color,
    caretColor: getComputedStyle(textarea).caretColor,
    textareaTextColor: getComputedStyle(textarea).color,
  }
})

let browser
let page

/** Serve fixtures for every bridge call the editor makes while booting. */
async function stubBackend(page) {
  await page.route('**/api/**', async (route) => {
    const cmd = route.request().url().split('/api/')[1]?.split('?')[0] || ''
    const result = Object.prototype.hasOwnProperty.call(API, cmd) ? API[cmd] : {}
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ result: RAW_RESULT.has(cmd) ? result : JSON.stringify(result) }),
    })
  })
}

async function run() {
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: VIEWPORT })
  const logging = attachLogging(page, 'raw-markdown-highlight')
  await stubBackend(page)
  /* Seed the persisted vault so `resumeVault` on zustand rehydrate opens it,
     and skip the onboarding guide so the fixture note renders. */
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const noteEntry = page.getByText('notes', { exact: true }).first()
  await noteEntry.waitFor({ timeout: 15000 })
  await noteEntry.click()
  await page.waitForTimeout(2500)

  // ── 1. Raw mode paints a highlight layer behind the textarea ──
  await page.locator('button[aria-label="Markdown mode"]').click()
  const textarea = page.locator('textarea.editor-raw-markdown')
  await textarea.waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForSelector('[data-testid="raw-markdown-highlight"]', { timeout: 10000 })
  await page.waitForTimeout(400)

  const first = await measure()
  ok('raw mode: highlight layer is rendered', !!first)
  if (!first) throw new Error('highlight layer missing')

  ok('raw mode: layer is hidden from assistive tech',
    await page.locator('[data-testid="raw-markdown-highlight"]').getAttribute('aria-hidden') === 'true')

  // ── 2. Losslessness in the live DOM: same text, same box, same metrics ──
  ok('layer text matches the textarea value exactly',
    first.overlayText === first.textareaValue,
    `overlay=${first.overlayText.length} textarea=${first.textareaValue.length}`)

  const boxDelta = Math.max(
    Math.abs(first.overlayBox.left - first.textareaBox.left),
    Math.abs(first.overlayBox.top - first.textareaBox.top),
    Math.abs(first.overlayBox.width - first.textareaBox.width),
    Math.abs(first.overlayBox.height - first.textareaBox.height),
  )
  ok('layer and textarea occupy the same box', boxDelta < 0.5, `max delta ${boxDelta.toFixed(2)}px`)

  for (const key of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'whiteSpace', 'overflowWrap']) {
    ok(`layer and textarea agree on ${key}`,
      first.overlayMetrics[key] === first.textareaMetrics[key],
      `${first.overlayMetrics[key]} vs ${first.textareaMetrics[key]}`)
  }

  /* Wrapping agreement: both wrap the same text with the same metrics, so the
     rendered column height must match the textarea's own content height. */
  ok('layer wraps to the same height as the textarea',
    Math.abs(first.overlayScrollHeight - first.textareaScrollHeight) <= 1,
    `${first.overlayScrollHeight} vs ${first.textareaScrollHeight}`)

  const textareaTextColor = first.textareaTextColor.replace(/\s/g, '')
  ok('textarea text is transparent so only the layer shows glyphs',
    textareaTextColor === 'rgba(0,0,0,0)', textareaTextColor)
  ok('caret stays visible over the layer', first.caretColor !== 'rgba(0, 0, 0, 0)' && first.caretColor !== '', first.caretColor)

  // ── 3. Every construct gets its own token class ──
  for (const [kind, count] of Object.entries(first.counts)) {
    ok(`colours \`${kind}\``, count > 0, `count=${count}`)
  }

  ok('heading, code span and plain text are coloured differently',
    first.headingColor !== first.plainColor && first.codeSpanColor !== first.plainColor && first.codeSpanColor !== first.headingColor,
    `heading=${first.headingColor} code=${first.codeSpanColor} plain=${first.plainColor}`)

  // ── 4. Typing re-tokenises and stays lossless ──
  await textarea.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('typed **bold** and [[Link]]')
  await page.waitForTimeout(400)
  const typed = await measure()
  ok('typing colourises the new markdown',
    typed.counts.strong > 1 && typed.counts.wikilink > 1,
    `strong=${typed.counts.strong} wikilink=${typed.counts.wikilink}`)
  ok('typing keeps layer text identical to the textarea value',
    typed.overlayText === typed.textareaValue,
    `overlay=${typed.overlayText.length} textarea=${typed.textareaValue.length}`)

  // ── 5. The syntax palette belongs to the theme, not to the layer ──
  /* Colour is the layer's whole job, so both theme blocks get pinned: a role
     that loses its variable falls back to inherited text and would sail
     through a counts-only check with every glyph the wrong colour. */
  const EXPECTED_PALETTE = {
    dark: {
      '.md-marker': 'rgb(113,113,122)',
      '.md-heading': 'rgb(244,244,245)',
      '.md-strong': 'rgb(244,244,245)',
      '.md-emphasis': 'rgb(244,244,245)',
      '.md-quote': 'rgb(161,161,170)',
      '.md-code': 'rgb(45,212,191)',
      '.md-code-span': 'rgb(45,212,191)',
      '.md-code-lang': 'rgb(161,161,170)',
      '.md-frontmatter-key': 'rgb(244,244,245)',
      '.md-frontmatter-value': 'rgb(161,161,170)',
      '.md-list-marker': 'rgb(113,113,122)',
      '.md-task-marker': 'rgb(34,197,94)',
      '.md-table-pipe': 'rgb(113,113,122)',
      '.md-link': 'rgb(59,130,246)',
      '.md-link-url': 'rgb(59,130,246)',
      '.md-wikilink': 'rgb(192,132,252)',
      '.md-math': 'rgb(251,191,36)',
      '.md-escape': 'rgb(113,113,122)',
      '.md-hr': 'rgb(113,113,122)',
    },
    light: {
      '.md-marker': 'rgb(82,82,91)',
      '.md-heading': 'rgb(9,9,11)',
      '.md-strong': 'rgb(9,9,11)',
      '.md-emphasis': 'rgb(9,9,11)',
      '.md-quote': 'rgb(63,63,70)',
      '.md-code': 'rgb(15,118,110)',
      '.md-code-span': 'rgb(15,118,110)',
      '.md-code-lang': 'rgb(63,63,70)',
      '.md-frontmatter-key': 'rgb(9,9,11)',
      '.md-frontmatter-value': 'rgb(63,63,70)',
      '.md-list-marker': 'rgb(82,82,91)',
      '.md-task-marker': 'rgb(4,120,87)',
      '.md-table-pipe': 'rgb(82,82,91)',
      '.md-link': 'rgb(37,99,235)',
      '.md-link-url': 'rgb(37,99,235)',
      '.md-wikilink': 'rgb(124,58,237)',
      '.md-math': 'rgb(180,83,9)',
      '.md-escape': 'rgb(82,82,91)',
      '.md-hr': 'rgb(82,82,91)',
    },
  }

  const readPalette = (selectors) => page.evaluate((list) => {
    const overlay = document.querySelector('[data-testid="raw-markdown-highlight"]')
    const colours = {}
    for (const selector of list) {
      const element = overlay?.querySelector(selector)
      colours[selector] = element ? getComputedStyle(element).color.replace(/\s/g, '') : ''
    }
    return colours
  }, selectors)

  for (const themeName of ['dark', 'light']) {
    await page.evaluate((name) => localStorage.setItem('docubook:theme', name), themeName)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction((name) => document.documentElement.dataset.theme === name, themeName)
    const entry = page.getByText('notes', { exact: true }).first()
    await entry.waitFor({ timeout: 15000 })
    await entry.click()
    await page.waitForTimeout(2500)
    await page.locator('button[aria-label="Markdown mode"]').click()
    await page.waitForSelector('[data-testid="raw-markdown-highlight"]', { timeout: 10000 })
    await page.waitForTimeout(400)

    const expected = EXPECTED_PALETTE[themeName]
    const actual = await readPalette(Object.keys(expected))
    for (const [selector, colour] of Object.entries(expected)) {
      ok(`${themeName} theme: ${selector} keeps its syntax role`,
        actual[selector] === colour, `${actual[selector]} vs ${colour}`)
    }
  }

  ok('no browser errors', logging.errors.length === 0, logging.errors.slice(0, 2).join(' | '))

  summary('raw-markdown-highlight', results, { serverLog: server.logPath })
}

try {
  await waitForServer(BASE, 60)
  await run()
} catch (error) {
  ok('harness', false, String(error))
  summary('raw-markdown-highlight', results, { serverLog: server.logPath })
} finally {
  await browser?.close()
  server.bin.kill()
}
