// @vitest-environment jsdom
/**
 * Pasting into the WYSIWYG editor is a supported feature. What it accepts is
 * BlockNote's own format, raw Markdown, and HTML that has been reduced to the
 * schema's blocks — so nothing a clipboard carries can run script or load what
 * the app did not ask for.
 *
 * These tests drive the REAL editor (`createBlockEditor` through `BlockNoteView`)
 * with real `paste` events, and inspect the live DOM it renders: the document
 * model alone would not show a stray attribute or a link target. Every hostile
 * payload goes through every clipboard format that can carry markup.
 *
 * The tests only mean something if the payloads are really hostile and the audit
 * really notices — both are checked below, together with positive controls (a
 * paste that does nothing would satisfy "nothing dangerous got in").
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { serializeMarkdown } from '../../../frontend/utils/markdownSerialization'
import { mathDollarToMathML } from '../../../frontend/utils/mathMarkdown'
import { mountAppEditor, type AppEditor, type ClipboardPayload } from '../appEditor'

vi.mock('../../../frontend/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../frontend/lib/ipc')>()),
  invoke: vi.fn().mockResolvedValue(''),
  fileUrl: async (url: string) => `/api/file?path=${encodeURIComponent(url)}`,
}))

let app: AppEditor
let editor: any

beforeAll(async () => {
  app = await mountAppEditor()
  editor = app.editor
})

beforeEach(async () => { await app.reset() })

// ─── Audit of rendered markup ────────────────────────────────────────────────

const FORBIDDEN_ELEMENTS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'style', 'form', 'base', 'meta', 'link', 'template', 'noscript'])
const URL_ATTRIBUTES = new Set(['href', 'src', 'data', 'action', 'formaction', 'xlink:href', 'poster', 'background'])

/** Browsers ignore whitespace and control characters inside a scheme. */
const compact = (value: string) => Array.from(value).filter(char => char.charCodeAt(0) > 0x20).join('').toLowerCase()

/** Everything in `root` that could execute, navigate, submit or load something
 *  the app did not ask for. Empty means clean. The editor's own controls are not
 *  findings: task-list checkboxes, and the language/title fields of a REAL code
 *  block's header (a pasted `.code-block-header` elsewhere is still flagged). */
function auditDom(root: ParentNode): string[] {
  const findings: string[] = []
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase()
    if (FORBIDDEN_ELEMENTS.has(tag)) findings.push(`<${tag}>`)
    if (tag === 'input' && element.getAttribute('type') !== 'checkbox' && !element.closest('[data-content-type="codeBlock"] .code-block-header')) findings.push('<input>')
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      const value = compact(attribute.value)
      if (name.startsWith('on')) findings.push(`${tag}[${name}]`)
      if (name === 'srcdoc') findings.push(`${tag}[srcdoc]`)
      if (name === 'style' && /url\(|expression\(|javascript:/.test(value)) findings.push(`${tag}[style=${value.slice(0, 30)}]`)
      if (URL_ATTRIBUTES.has(name) && /^(?:javascript|vbscript|file):/.test(value)) findings.push(`${tag}[${name}=${value.slice(0, 30)}]`)
      if ((name === 'href' || name === 'action' || name === 'formaction') && value.startsWith('data:')) findings.push(`${tag}[${name}=data:]`)
    }
  }
  return findings
}

/** The markup as a browser would parse it, inert (a template never runs script). */
function parsed(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

const editorDom = () => editor.domElement as HTMLElement
const editorText = () => editorDom().textContent ?? ''
const anchors = () => Array.from(editorDom().querySelectorAll('a')).map(a => a.getAttribute('href') ?? '')

const shape = (blocks: any[]): any[] => blocks.map(block => ({
  type: block.type,
  ...(block.props?.level ? { level: block.props.level } : {}),
  ...(block.type === 'checkListItem' ? { checked: block.props.checked } : {}),
  text: Array.isArray(block.content)
    ? block.content.map((item: any) => `${item.text ?? item.content?.map?.((x: any) => x.text).join('') ?? item.type}${Object.keys(item.styles ?? {}).sort().map((s: string) => `~${s}`).join('')}`).join('|')
    : block.type === 'table' ? 'table' : '',
  children: shape(block.children ?? []),
}))

// ─── Hostile payloads and the clipboard formats that carry markup ────────────

interface Payload { name: string; html: string; keeps?: string[] }

const HOSTILE: Payload[] = [
  { name: 'script element', html: '<p>keep-a</p><script>window.__pwned=1</script><p>keep-b</p>', keeps: ['keep-a', 'keep-b'] },
  { name: 'inline event handlers', html: '<p onclick="window.__pwned=1" onmouseover="window.__pwned=1">keep-a</p>', keeps: ['keep-a'] },
  { name: 'img onerror', html: '<img src="x" onerror="window.__pwned=1">' },
  { name: 'style attribute with url()', html: '<p style="background:url(https://evil.example/x)">keep-a</p>', keeps: ['keep-a'] },
  { name: 'iframe', html: '<iframe src="https://evil.example"></iframe><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'iframe srcdoc', html: '<iframe srcdoc="<script>1</script>"></iframe><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'svg with script and onload', html: '<svg onload="window.__pwned=1"><script>1</script></svg><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'svg use with a javascript: href', html: '<svg><use href="javascript:1"></use></svg><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'object and embed', html: '<object data="javascript:1"></object><embed src="javascript:1"><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'form with a javascript: formaction', html: '<form action="https://evil.example"><input name="p"><button formaction="javascript:1">go</button></form>' },
  { name: 'style element', html: '<style>body{display:none}</style><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'base element', html: '<base href="https://evil.example/"><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'meta refresh', html: '<meta http-equiv="refresh" content="0;url=https://evil.example"><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'stylesheet link', html: '<link rel="stylesheet" href="https://evil.example/x.css"><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'template and noscript', html: '<template><script>1</script></template><noscript><img src=x onerror=1></noscript><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'img smuggled inside math markup', html: '<math><annotation encoding="application/x-tex"><img src=x onerror=1></annotation></math>' },
  { name: 'input dressed as the code block header', html: '<div class="code-block-header"><input name="p" autofocus></div><p>keep-a</p>', keeps: ['keep-a'] },
  { name: 'handler on a block container', html: '<div data-node-type="blockContainer" data-id="x" onclick="window.__pwned=1"><p>keep-a</p></div>', keeps: ['keep-a'] },
]

/** Clipboard formats BlockNote reads as markup (or as Markdown, which allows raw
 *  HTML). `text/plain` is read as Markdown too, so it carries markup the same way. */
const PATHS: [string, (html: string) => ClipboardPayload][] = [
  ['text/html', html => ({ data: { 'text/html': html } })],
  ['text/html with a text/plain fallback', html => ({ data: { 'text/html': html, 'text/plain': 'fallback' } })],
  ['blocknote/html', html => ({ data: { 'blocknote/html': html } })],
  ['text/markdown', html => ({ data: { 'text/markdown': html } })],
  ['text/plain read as Markdown', html => ({ data: { 'text/plain': html } })],
]

describe('the audit and the payloads can be trusted', () => {
  it('flags every kind of dangerous markup in a hostile fragment', () => {
    const findings = auditDom(parsed([
      '<script>1</script><iframe></iframe><object></object><embed><style></style><form></form><base><meta><link>',
      '<p onclick="1" style="background:url(x)">x</p><a href=" JaVa&#9;Script:1">x</a>',
      '<a href="data:text/html,x">x</a><img src="file:///etc/passwd"><input name="p"><iframe srcdoc="x"></iframe>',
    ].join('')))

    for (const expected of ['<script>', '<iframe>', '<object>', '<embed>', '<style>', '<form>', '<base>', '<meta>', '<link>', '<input>', 'p[onclick]', 'iframe[srcdoc]']) {
      expect(findings, expected).toContain(expected)
    }
    expect(findings.some(f => f.startsWith('p[style='))).toBe(true)
    expect(findings.some(f => f.startsWith('a[href=javascript:'))).toBe(true)
    expect(findings).toContain('a[href=data:]')
    expect(findings.some(f => f.startsWith('img[src=file:'))).toBe(true)
  })

  it('leaves ordinary content and the task-list checkbox alone', () => {
    expect(auditDom(parsed('<h2>t</h2><p>a <strong>b</strong> <a href="https://example.com/">l</a></p><input type="checkbox" checked>'))).toEqual([])
  })

  it("leaves a real code block's header fields alone, but not a lookalike", () => {
    const header = '<div class="code-block-header"><input class="code-block-title"></div>'

    expect(auditDom(parsed(`<div data-content-type="codeBlock">${header}</div>`))).toEqual([])
    expect(auditDom(parsed(header))).toEqual(['<input>'])
  })

  it('audits the live editor root, not just fragments', () => {
    editorDom().insertAdjacentHTML('beforeend', '<p onclick="1">x</p><a href="javascript:1">x</a>')

    expect(auditDom(editorDom())).toEqual(expect.arrayContaining(['p[onclick]', expect.stringContaining('a[href=javascript:')]))
  })

  it.each(HOSTILE)('payload "$name" is hostile as a browser would parse it', ({ html }) => {
    expect(auditDom(parsed(html)).length).toBeGreaterThan(0)
  })

  it('a paste that lands is visible (positive control)', async () => {
    expect(await app.paste({ data: { 'text/html': '<p>hello <strong>world</strong></p>' } })).toBe(true)

    expect(editorText()).toContain('hello world')
    expect(editorDom().querySelector('strong')).not.toBeNull()
  })
})

describe.each(PATHS)('hostile markup pasted as %s', (_path, payload) => {
  it.each(HOSTILE)('$name never reaches the DOM', async ({ html, keeps = [] }) => {
    expect(await app.paste(payload(html))).toBe(true)

    expect(auditDom(editorDom())).toEqual([])
    for (const text of keeps) expect(editorText(), `"${text}" should survive as plain content`).toContain(text)
  })
})

// ─── Links ───────────────────────────────────────────────────────────────────

const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i

const UNSAFE_HREFS: [string, string][] = [
  ['javascript:', 'javascript:window.__pwned=1'],
  ['an upper-case scheme', 'JaVaScRiPt:window.__pwned=1'],
  ['an entity-encoded scheme', 'jav&#x61;script:window.__pwned=1'],
  ['a tab inside the scheme', 'java&#9;script:window.__pwned=1'],
  ['leading whitespace', '  javascript:window.__pwned=1'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  ['data: html', 'data:text/html,<script>1</script>'],
  ['file:', 'file:///etc/passwd'],
]

describe.each(PATHS)('link targets pasted as %s', (_path, payload) => {
  it.each(UNSAFE_HREFS)('%s is not turned into a link', async (_name, href) => {
    await app.paste(payload(`<p><a href="${href}">keep-link</a></p>`))

    expect(editorText()).toContain('keep-link')
    expect(anchors().filter(target => !SAFE_LINK.test(target))).toEqual([])
    expect(auditDom(editorDom())).toEqual([])
  })
})

describe('link targets written as Markdown syntax', () => {
  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['an upper-case scheme', 'JAVASCRIPT:alert(1)'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['data:', 'data:text/html,x'],
  ])('%s is not turned into a link', async (_name, href) => {
    await app.paste({ data: { 'text/markdown': `[keep-link](${href}) and ![keep-image](${href})` } })

    expect(editorText()).toContain('keep-link')
    expect(anchors().filter(target => !SAFE_LINK.test(target))).toEqual([])
    expect(auditDom(editorDom())).toEqual([])
  })
})

describe('safe links survive (positive control)', () => {
  it.each(['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com', 'tel:+15551234'])('%s', async (href) => {
    await app.paste({ data: { 'text/html': `<p><a href="${href}">keep-link</a></p>` } })

    expect(anchors()).toEqual([href])
  })
})

// ─── Media sources ───────────────────────────────────────────────────────────

describe('media pasted with a source that is not safe to load', () => {
  it.each([
    ['img', 'javascript:window.__pwned=1'],
    ['img', 'file:///etc/passwd'],
    ['img', 'http://evil.example/p.gif'],
    ['video', 'javascript:1'],
    ['video', 'file:///etc/passwd'],
    ['audio', 'javascript:1'],
    ['audio', 'http://evil.example/a.mp3'],
  ])('<%s src="%s"> renders with an empty source', async (tag, src) => {
    await app.paste({ data: { 'text/html': `<${tag} src="${src}"></${tag}>` } })

    const element = editorDom().querySelector('img.bn-visual-media, video, audio')
    expect(element, 'the media block exists').not.toBeNull()
    expect(element!.getAttribute('src')).toBe('')
    expect(auditDom(editorDom())).toEqual([])
  })
})

// ─── Other entry points ──────────────────────────────────────────────────────

describe('other clipboard entry points', () => {
  it('pastes into a code block as literal text, never as markup', async () => {
    const code = '<script>window.__pwned=1</script><img src=x onerror=1>'
    await act(async () => {
      editor.replaceBlocks(editor.document, [{ type: 'codeBlock', props: { language: 'html' } }])
      editor.setTextCursorPosition(editor.document[0], 'start')
      editor.focus()
    })

    await app.paste({ data: { 'text/html': code, 'text/plain': code } })

    expect(editor.document[0].type).toBe('codeBlock')
    expect((editor.document[0].content ?? []).map((c: any) => c.text).join('')).toBe(code)
    expect(auditDom(editorDom())).toEqual([])
  })

  it('takes no files: there is no upload target', async () => {
    const handled = await app.paste({ files: [new File(['x'], 'p.png', { type: 'image/png' })] })

    expect(handled).toBe(true)
    expect(shape(editor.document)).toEqual([{ type: 'paragraph', text: '', children: [] }])
  })

  it('reads the HTML, not the file, when both are on the clipboard', async () => {
    await app.paste({ data: { 'text/html': '<p>keep-a</p>' }, files: [new File(['x'], 'p.png', { type: 'image/png' })] })

    expect(editorText()).toContain('keep-a')
    expect(editorDom().querySelector('img')).toBeNull()
  })

  /** BlockNote writes the editor's language into HTML around the pasted code
   *  without escaping it. The schema drops what that could inject, so the DOM
   *  stays clean; what the pasted code itself looks like afterwards is a
   *  separate matter and not asserted here. */
  it('keeps a VS Code language name from injecting markup', async () => {
    await app.paste({ data: { 'vscode-editor-data': JSON.stringify({ mode: '"><img src=x onerror=1>' }), 'text/plain': 'const a = 1' } })

    expect(auditDom(editorDom())).toEqual([])
    expect(editorDom().querySelector('img')).toBeNull()
  })
})

// ─── The supported formats work ──────────────────────────────────────────────

describe('the supported formats paste as BlockNote blocks (positive controls)', () => {
  it('HTML', async () => {
    await app.paste({ data: { 'text/html': '<h2>Title</h2><p>a <strong>b</strong> <em>c</em></p><ul><li>x</li></ul>' } })

    expect(shape(editor.document).slice(0, 3)).toEqual([
      { type: 'heading', level: 2, text: 'Title', children: [] },
      { type: 'paragraph', text: 'a |b~bold| |c~italic', children: [] },
      { type: 'bulletListItem', text: 'x', children: [] },
    ])
  })

  it('Markdown, sent as text/markdown', async () => {
    await app.paste({ data: { 'text/markdown': '## Title\n\n- a\n- b\n\n| x | y |\n| - | - |\n| 1 | 2 |' } })

    expect(shape(editor.document).map(b => b.type + (b.level ?? ''))).toEqual(expect.arrayContaining(['heading2', 'bulletListItem', 'table']))
  })

  it('Markdown, sent as plain text', async () => {
    await app.paste({ data: { 'text/plain': '## Title\n\n**bold** text' } })

    expect(shape(editor.document).slice(0, 2)).toEqual([
      { type: 'heading', level: 2, text: 'Title', children: [] },
      { type: 'paragraph', text: 'bold~bold| text', children: [] },
    ])
  })

  it('a markdown-looking plain text wins over the HTML beside it', async () => {
    await app.paste({ data: { 'text/html': '<p>html side</p>', 'text/plain': '# md side\n\n- a\n- b' } })

    expect(shape(editor.document).map(b => b.type)).toEqual(['heading', 'bulletListItem', 'bulletListItem'])
  })

  it("BlockNote's own format, with nesting and styles", async () => {
    await app.reset()
    editor.replaceBlocks(editor.document, [
      { type: 'heading', props: { level: 3 }, content: 'Title' },
      { type: 'bulletListItem', content: [{ type: 'text', text: 'item', styles: { bold: true } }], children: [{ type: 'bulletListItem', content: 'nested' }] },
      { type: 'checkListItem', props: { checked: true }, content: 'done' },
    ])
    const before = shape(editor.document)
    const html = editor.blocksToFullHTML(editor.document)
    await app.reset()

    await app.paste({ data: { 'blocknote/html': html } })

    expect(shape(editor.document).slice(0, before.length)).toEqual(before)
  })
})

// ─── What is written to disk ─────────────────────────────────────────────────

/** Raw HTML that could run or load, and anything that names an executing scheme
 *  (`javascript:`, `vbscript:`) or an active `data:` document. `file:` and custom
 *  schemes are not here on purpose: a note legitimately links to them. */
const DANGEROUS_MARKDOWN = /<script|<iframe|<svg|<style|<object|<embed|<form|\bon[a-z]+\s*=|(?:javascript|vbscript):|data:text\/html/i

/** Load Markdown into the editor the way the app does when a note opens. */
async function reloadFromMarkdown(markdown: string) {
  await act(async () => { editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(mathDollarToMathML(markdown))) })
  await app.settle()
}

describe('the Markdown saved after a hostile paste', () => {
  it.each(HOSTILE)('carries nothing from "$name", and reloads clean', async ({ html }) => {
    await app.paste({ data: { 'text/html': html } })

    const markdown = serializeMarkdown(editor)
    expect(markdown).not.toBeNull()
    expect(markdown!).not.toMatch(DANGEROUS_MARKDOWN)

    await reloadFromMarkdown(markdown!)
    expect(auditDom(editorDom())).toEqual([])
    expect(anchors().filter(target => !SAFE_LINK.test(target))).toEqual([])
  })

  /** A pasted file or media block keeps its URL whatever the scheme, so the open
   *  note holds it (it renders with an empty source). What is WRITTEN is neutral:
   *  the export drops an executing URL instead of saving a `[name](javascript:…)`
   *  link, an `![](javascript:…)` image or a raw `<img src>` for the next reader of
   *  the vault. See `escapeBlocksForMarkdown`. */
  describe('unsafe URLs of file and media blocks are not written to the note', () => {
    it.each([
      ['a file block', 'blocknote/html', '<div data-node-type="blockContainer"><div data-content-type="file" data-url="javascript:alert(1)" data-name="doc"></div></div>', 'file'],
      ['a video', 'text/html', '<video src="javascript:alert(1)" title="doc"></video>', 'video'],
      ['an audio block', 'text/html', '<audio src="vbscript:msgbox(1)"></audio>', 'audio'],
      ['an image', 'text/html', '<img src="javascript:alert(1)" alt="doc">', 'image'],
      ['a captioned image, which is exported as HTML', 'text/html', '<figure><img src="javascript:alert(1)"><figcaption>cap</figcaption></figure>', 'image'],
      ['a file block with an active data: URL', 'blocknote/html', '<div data-node-type="blockContainer"><div data-content-type="file" data-url="data:text/html,<script>1</script>" data-name="doc"></div></div>', 'file'],
    ])('%s', async (_name, mime, html, blockType) => {
      await app.paste({ data: { [mime]: html } })
      const block = editor.document[0]
      expect(block.type, 'the unsafe block is created in the open note').toBe(blockType)
      expect(block.props.url, 'with its URL, which the open note renders as empty').toMatch(/^(?:javascript|vbscript|data):/i)

      const markdown = serializeMarkdown(editor)!
      expect(markdown).not.toMatch(DANGEROUS_MARKDOWN)
      expect(editor.document[0].props.url, 'the open note is not modified by saving').toBe(block.props.url)

      await reloadFromMarkdown(markdown)
      expect(auditDom(editorDom())).toEqual([])
      expect(anchors().filter(target => !SAFE_LINK.test(target))).toEqual([])
    })

    it('keeps the URLs a note legitimately holds', async () => {
      const urls = ['https://example.com/f.pdf', 'http://example.com/f.pdf', 'pics/a.png', 'obsidian://open?vault=x', 'file:///Users/me/doc.pdf']
      await act(async () => { editor.replaceBlocks(editor.document, urls.map(url => ({ type: 'file', props: { url, name: 'doc' } }))) })

      const markdown = serializeMarkdown(editor)!

      for (const url of urls) expect(markdown, url).toContain(`](${url})`)
    })
  })
})
