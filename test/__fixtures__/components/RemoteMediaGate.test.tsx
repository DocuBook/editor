// @vitest-environment jsdom
/**
 * The remote-media opt-in, checked in the live DOM of the REAL editor.
 *
 * `resolveFileUrl` is shared by the image, video and audio blocks and receives
 * only a URL, so a gate that looked at the URL's extension could be dodged by a
 * tracker named `pixel.php`, `pixel.pdf` or `pixel.mp4`. The image block is
 * therefore gated by block type (see `runForImageBlock`), which relies on
 * BlockNote calling `resolveFileUrl` from inside the block's `render` — these
 * tests fail loudly if an upgrade changes that.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { allowRemoteMediaForSession, blockedRemoteMediaUrl, resetSessionRemoteMediaAllowlist } from '../../../frontend/utils/mediaPolicy'
import { mountAppEditor, type AppEditor } from '../appEditor'

vi.mock('../../../frontend/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../frontend/lib/ipc')>()),
  invoke: vi.fn().mockResolvedValue(''),
  fileUrl: async (url: string) => `/api/file?path=${encodeURIComponent(url)}`,
}))

let app: AppEditor
let editor: any
const settle = () => app.settle()

beforeAll(async () => {
  app = await mountAppEditor()
  editor = app.editor
})

afterEach(() => { resetSessionRemoteMediaAllowlist() })

/** The `src` the browser would be given for one media block. */
async function renderedSrc(block: { type: string; props: { url: string } }): Promise<string> {
  // Start from an empty document so a block with the same URL as the previous
  // test is rendered afresh (ProseMirror keeps an unchanged node view as it is).
  await act(async () => { editor.replaceBlocks(editor.document, [{ type: 'paragraph' }]) })
  await act(async () => { editor.replaceBlocks(editor.document, [block]) })
  await settle()
  const element = (editor.domElement as HTMLElement).querySelector('img.bn-visual-media, video, audio')
  return element?.getAttribute('src') ?? '(no media element)'
}
const image = (url: string) => renderedSrc({ type: 'image', props: { url } })

describe('remote images in an image block are always behind the opt-in', () => {
  it.each([
    ['an image extension', 'https://evil.example/pixel.gif'],
    ['no extension', 'https://evil.example/pixel'],
    ['a script extension', 'https://evil.example/open.php?id=1'],
    ['an .aspx tracker', 'https://evil.example/open.aspx?u=1'],
    ['an .html page', 'https://evil.example/t.html'],
    ['an upper-case extension', 'https://evil.example/P.PHP'],
    ['a document extension', 'https://evil.example/pixel.pdf'],
    ['a media extension', 'https://evil.example/pixel.mp4'],
  ])('%s', async (_name, url) => {
    expect(blockedRemoteMediaUrl(await image(url))).toBe(url)
  })

  it('normalizes a protocol-relative URL to https for the opt-in', async () => {
    expect(blockedRemoteMediaUrl(await image('//evil.example/p.php'))).toBe('https://evil.example/p.php')
  })

  it('gates an image that arrives by paste', async () => {
    await act(async () => { editor.replaceBlocks(editor.document, [{ type: 'paragraph' }]); editor.setTextCursorPosition(editor.document[0], 'start') })
    await act(async () => { editor.pasteHTML('<img src="https://evil.example/p.php?id=1">') })
    await settle()

    const src = (editor.domElement as HTMLElement).querySelector('img.bn-visual-media')?.getAttribute('src')

    expect(blockedRemoteMediaUrl(src ?? null)).toBe('https://evil.example/p.php?id=1')
  })

  it('loads the image once the reader has opted into that URL', async () => {
    const url = 'https://evil.example/p.php?id=1'
    allowRemoteMediaForSession(url)

    expect(await image(url)).toBe(url)
  })
})

describe('what the image gate leaves alone', () => {
  it('keeps unsafe schemes blocked outright', async () => {
    expect(await image('javascript:window.__pwned=1')).toBe('')
    expect(await image('file:///etc/passwd')).toBe('')
    expect(await image('http://evil.example/p.php')).toBe('')
  })

  it('resolves a vault-relative image through the app, not the network', async () => {
    expect(await image('pics/a.png')).toBe('/api/file?path=pics%2Fa.png')
  })

  it('leaves an inline data: image as it is', async () => {
    const url = 'data:image/png;base64,AAAA'
    expect(await image(url)).toBe(url)
  })

  /** Video and audio keep the URL-shape rule: a URL that names a media file loads
   *  as before, and one with no extension gets the placeholder (a broken player). */
  it('does not change video or audio blocks', async () => {
    expect(await renderedSrc({ type: 'video', props: { url: 'https://cdn.example/v.mp4' } })).toBe('https://cdn.example/v.mp4')
    expect(await renderedSrc({ type: 'audio', props: { url: 'https://cdn.example/a.mp3' } })).toBe('https://cdn.example/a.mp3')
    expect(blockedRemoteMediaUrl(await renderedSrc({ type: 'video', props: { url: 'https://cdn.example/v' } }))).toBe('https://cdn.example/v')
  })
})
