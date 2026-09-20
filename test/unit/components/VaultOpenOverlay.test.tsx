// @vitest-environment jsdom

/** The delay gate is the whole point of this component: under DELAY_MS a vault
 *  open must render NOTHING, so the fix for the "dead click" does not itself
 *  become a flash of spinner on every small vault. These tests pin that. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultOpenOverlay } from '../../../frontend/components/editor/VaultOpenOverlay'

// React 19 only silences its act() warning when this global is set; without it
// every render below logs noise that hides real failures.
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('VaultOpenOverlay', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = (startedAt: number, name?: string) =>
    act(() => { root.render(<VaultOpenOverlay name={name} startedAt={startedAt} />) })

  it('renders nothing for a fast open (under the delay budget)', () => {
    render(performance.now())

    // 99ms in: still nothing, and nothing was scheduled to appear yet.
    act(() => { vi.advanceTimersByTime(99) })
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('shows the loading state once the open outlives the delay', () => {
    render(performance.now())

    act(() => { vi.advanceTimersByTime(100) })
    const status = container.querySelector('[role="status"]')
    expect(status).not.toBeNull()
    expect(container.textContent).toContain('Opening')
  })

  it('shows immediately when it mounts into an open that already outlived the delay', () => {
    // The welcome screen can mount late (vault store flips openingPath after
    // prepareTransition) — the clock must be measured from the click, not mount.
    render(performance.now() - 500)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('waits only the remainder when it mounts partway through the delay', () => {
    render(performance.now() - 60)

    // 39ms more is still under the original 100ms budget.
    act(() => { vi.advanceTimersByTime(39) })
    expect(container.querySelector('[role="status"]')).toBeNull()

    act(() => { vi.advanceTimersByTime(1) })
    expect(container.querySelector('[role="status"]')).not.toBeNull()
  })

  it('names the vault when one is given, and stays generic otherwise', () => {
    render(performance.now() - 500, 'notes')
    expect(container.textContent).toContain('notes')

    render(performance.now() - 500)
    expect(container.textContent).toContain('a vault')
  })
})
