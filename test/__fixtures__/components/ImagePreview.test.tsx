// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ipc = vi.hoisted(() => ({
  fileUrl: vi.fn(),
  mediaErrorMessage: vi.fn(),
  mediaFailureReason: vi.fn(),
}))

vi.mock('../../../frontend/lib/ipc', () => ipc)

import { ImagePreview } from '../../../frontend/components/editor/previews'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ipc.fileUrl.mockReset().mockImplementation(async (_vaultPath: string, relPath: string) => `/api/file?path=${relPath}`)
  ipc.mediaErrorMessage.mockReset().mockReturnValue('Could not load preview')
  ipc.mediaFailureReason.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ImagePreview', () => {
  it('ignores a media failure probe after switching to another file', async () => {
    let resolveFailure!: (message: string) => void
    ipc.mediaFailureReason.mockReturnValueOnce(new Promise(resolve => { resolveFailure = resolve }))

    await act(async () => {
      root.render(<ImagePreview fileName="old.png" vaultPath="/vault" relPath="old.png" />)
      await Promise.resolve()
    })
    const oldImage = container.querySelector('img')!
    await act(async () => {
      oldImage.dispatchEvent(new Event('error'))
    })

    await act(async () => {
      root.render(<ImagePreview fileName="new.png" vaultPath="/vault" relPath="new.png" />)
      await Promise.resolve()
    })
    expect(container.querySelector('img')?.alt).toBe('new.png')

    await act(async () => {
      resolveFailure('File not found')
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('File not found')
    expect(container.querySelector('img')?.alt).toBe('new.png')
  })
})
