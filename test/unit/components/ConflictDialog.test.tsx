// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ConflictDialog from '../../../frontend/components/ConflictDialog'
import type { Conflict } from '../../../frontend/stores/sync'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')!
const button = (text: string) => Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text)!

const baseConflict: Conflict = {
  id: 'conflict-test',
  path: 'notes/plan.md',
  mine: 'my line\nshared line',
  theirs: 'their line\nshared line',
  theirsVersion: 'v9',
  baseContent: 'shared line',
  detectedAt: 0,
}

function renderDialog(conflict: Partial<Conflict> = {}, onResolve = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  const props = { conflict: { ...baseConflict, ...conflict }, onResolve, onClose }
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<ConflictDialog {...props} />))
  return { ...props, onResolve, onClose }
}

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('ConflictDialog', () => {
  it('names the file so the user knows which note changed', () => {
    renderDialog()
    expect(dialog().textContent).toContain('plan.md')
  })

  it('promises that nothing was overwritten', () => {
    renderDialog()
    expect(dialog().textContent).toContain('Nothing has been overwritten')
  })

  /** Both sides must be visible: the whole point is an informed choice, and a
   *  dialog that only showed one side would be an unannounced overwrite. */
  it('shows both the local and the disk version', () => {
    renderDialog()

    const mine = document.querySelector('[data-testid="conflict-mine"]')!
    const theirs = document.querySelector('[data-testid="conflict-theirs"]')!
    expect(mine.textContent).toContain('my line')
    expect(theirs.textContent).toContain('their line')
  })

  it('offers exactly the three safe resolutions', () => {
    renderDialog()

    const labels = Array.from(dialog().querySelectorAll('button')).map(b => b.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Keep my version', 'Use the disk version', 'Keep both', 'Decide later']))
  })

  it('reports the chosen side back to the caller', async () => {
    const { onResolve } = renderDialog()

    await act(async () => { button('Keep my version').click() })

    expect(onResolve).toHaveBeenCalledWith('mine')
  })

  it('reports keep-both so the local edit can be saved as a copy', async () => {
    const { onResolve } = renderDialog()

    await act(async () => { button('Keep both').click() })

    expect(onResolve).toHaveBeenCalledWith('both')
  })

  it('reports the disk side when the user adopts it', async () => {
    const { onResolve } = renderDialog()

    await act(async () => { button('Use the disk version').click() })

    expect(onResolve).toHaveBeenCalledWith('theirs')
  })

  /** A resolve that fails must not close: closing would look like success and
   *  the conflict would silently disappear from the user's view. */
  it('stays open and reports the error when resolution fails', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('disk full'))
    renderDialog({}, onResolve)

    await act(async () => { button('Keep my version').click() })

    expect(dialog()).toBeTruthy()
    expect(dialog().textContent).toContain('disk full')
  })

  it('closes without resolving when the user defers', () => {
    const { onResolve, onClose } = renderDialog()

    act(() => { button('Decide later').click() })

    expect(onClose).toHaveBeenCalled()
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('marks an empty side instead of rendering a blank panel', () => {
    renderDialog({ mine: '' })
    expect(document.querySelector('[data-testid="conflict-mine"]')!.textContent).toContain('(empty file)')
  })
})
