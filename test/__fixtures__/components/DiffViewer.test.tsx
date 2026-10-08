// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flush } from '../harness'

const invoke = vi.hoisted(() => vi.fn(async (_command?: string, _args?: unknown) => ''))
vi.mock('../../../frontend/lib/ipc', () => ({ invoke }))

import { DiffViewer } from '../../../frontend/components/editor/DiffViewer'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null
const body = () => document.querySelector<HTMLElement>('[data-testid="diff-body"]')
const rowTexts = () => Array.from(body()?.querySelectorAll('div') ?? [], node => node.textContent)

async function renderDiff(staged = false) {
  root = createRoot(document.getElementById('root')!)
  act(() => root!.render(<DiffViewer path="notes/a.md" name="a.md" staged={staged} />))
  await flush()
}

beforeEach(() => { document.body.innerHTML = '<div id="root"></div>' })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; vi.clearAllMocks() })

describe('DiffViewer', () => {
  it('renders an inline +/- line diff from the two sides', async () => {
    invoke.mockResolvedValue(JSON.stringify({ old: 'one\ntwo\n', new: 'one\nTWO\n' }))
    await renderDiff()

    expect(invoke).toHaveBeenCalledWith('git_diff_file', { path: 'notes/a.md', staged: false })
    expect(rowTexts()).toContain('  one')
    expect(rowTexts()).toContain('- two')
    expect(rowTexts()).toContain('+ TWO')
  })

  it('labels a staged range and reports a clean diff', async () => {
    invoke.mockResolvedValue(JSON.stringify({ old: 'same\n', new: 'same\n' }))
    await renderDiff(true)

    expect(invoke).toHaveBeenCalledWith('git_diff_file', { path: 'notes/a.md', staged: true })
    expect(body()).toBeNull()
    expect(document.body.textContent).toContain('No changes.')
  })

  it('surfaces a backend failure instead of an empty diff', async () => {
    invoke.mockRejectedValueOnce(new Error('not a repository'))
    await renderDiff()

    expect(document.querySelector('[role="alert"]')?.textContent).toContain('not a repository')
  })
})
