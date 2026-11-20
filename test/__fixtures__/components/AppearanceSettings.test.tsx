// @vitest-environment jsdom
/** Settings → Appearance: one section for the theme (System / Light / Dark) and
 *  the editor font sizes, which commit on blur or Enter, never mid-typing. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from '../memoryStorage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.stubGlobal('localStorage', createMemoryStorage().storage)
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('dark'), media: query, addEventListener: () => {}, removeEventListener: () => {} })))

const { default: AppearanceSettings } = await import('../../../frontend/components/AppearanceSettings')
const { useTheme } = await import('../../../frontend/stores/theme')
const { useTypography } = await import('../../../frontend/stores/typography')

let root: Root
/** Mantine's SegmentedControl: a native radio per option, labelled by its text. */
const radio = (value: string) => document.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!
const input = (id: string) => document.getElementById(`font-size-${id}`) as HTMLInputElement
const type = (element: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  useTheme.getState().setTheme('system')
  useTypography.getState().reset()
  document.body.innerHTML = '<div id="root"></div>'
  root = createRoot(document.getElementById('root')!)
  act(() => root.render(<MantineProvider><AppearanceSettings /></MantineProvider>))
})

afterEach(() => act(() => root.unmount()))

describe('AppearanceSettings', () => {
  it('defaults to System and pins Light or Dark', () => {
    expect(radio('system').checked).toBe(true)
    expect(document.body.textContent).toContain('currently Dark')
    // Each option carries its icon next to its label.
    for (const value of ['system', 'light', 'dark']) expect(document.querySelector(`label[for="${radio(value).id}"] svg`)).not.toBeNull()

    act(() => radio('light').click())

    expect(useTheme.getState()).toMatchObject({ preference: 'light', name: 'light' })
    expect(radio('light').checked).toBe(true)
    expect(document.body.textContent).not.toContain('currently')
  })

  it('lists h1–h5 and paragraph, with the default as placeholder', () => {
    for (const id of ['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'paragraph']) expect(input(id)).not.toBeNull()
    expect(input('paragraph').placeholder).toBe('16')
    expect(input('paragraph').value).toBe('')
  })

  it('commits a size on blur or Enter only, and an empty field clears it', () => {
    act(() => type(input('heading-1'), '3'))
    expect(useTypography.getState().sizes).toEqual({})

    act(() => type(input('heading-1'), '32'))
    act(() => { input('heading-1').dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(useTypography.getState().sizes).toEqual({ 'heading-1': 32 })

    act(() => type(input('paragraph'), '18'))
    act(() => { input('paragraph').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(useTypography.getState().sizes).toEqual({ 'heading-1': 32, paragraph: 18 })

    act(() => type(input('heading-1'), ''))
    act(() => { input('heading-1').dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(useTypography.getState().sizes).toEqual({ paragraph: 18 })
  })

  it('keeps focus on the field after Enter', () => {
    const field = input('heading-1')
    act(() => field.focus())
    act(() => type(field, '30'))
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })

    expect(useTypography.getState().sizes).toEqual({ 'heading-1': 30 })
    expect(field.isConnected).toBe(true)
    expect(document.activeElement).toBe(field)
  })

  it('shows the clamped value even when it equals the stored one', () => {
    act(() => useTypography.getState().setSize('heading-2', 96))
    act(() => type(input('heading-2'), '500'))
    act(() => { input('heading-2').dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })

    expect(useTypography.getState().sizes).toEqual({ 'heading-2': 96 })
    expect(input('heading-2').value).toBe('96')
  })

  it('clamps an out-of-range size and offers a reset', () => {
    act(() => type(input('heading-2'), '500'))
    act(() => { input('heading-2').dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(useTypography.getState().sizes).toEqual({ 'heading-2': 96 })
    expect(input('heading-2').value).toBe('96')

    const reset = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Reset to defaults')!
    act(() => reset.click())

    expect(useTypography.getState().sizes).toEqual({})
    expect(input('heading-2').value).toBe('')
  })
})
