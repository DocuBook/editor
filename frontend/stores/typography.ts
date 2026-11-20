import { create } from 'zustand'

/** Editor text levels whose size the user can override. The editor has heading
 *  levels 1–5 (see `createHeadingBlockSpec` in editor/setup.ts). */
export const FONT_LEVELS = [
  { id: 'heading-1', label: 'Heading 1' },
  { id: 'heading-2', label: 'Heading 2' },
  { id: 'heading-3', label: 'Heading 3' },
  { id: 'heading-4', label: 'Heading 4' },
  { id: 'heading-5', label: 'Heading 5' },
  { id: 'paragraph', label: 'Paragraph' },
] as const

export type FontLevel = (typeof FONT_LEVELS)[number]['id']
export type FontSizes = Partial<Record<FontLevel, number>>

export const MIN_FONT_PX = 8
export const MAX_FONT_PX = 96
/** BlockNote's `.bn-default-styles` size: the editor's body text, and the em
 *  base of the heading scale in index.css. */
const EDITOR_BASE_PX = 16
const STORAGE_KEY = 'docubook:font-sizes'

/** The CSS default for a level, in px. Headings read `--<level>-default` from
 *  index.css (an em of the editor's base, phone scale included); a paragraph is
 *  the base itself. */
export function defaultFontPx(level: FontLevel): number {
  if (level === 'paragraph' || typeof document === 'undefined') return EDITOR_BASE_PX
  const em = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${level}-default`))
  return Number.isFinite(em) ? Math.round(em * EDITOR_BASE_PX * 10) / 10 : EDITOR_BASE_PX
}

/** A size the editor can render, or undefined (= use the CSS default). */
function validPx(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_FONT_PX && value <= MAX_FONT_PX ? value : undefined
}

/** Overrides go on `--user-font-<level>`; index.css falls back to its default
 *  when one is unset. */
function applySizes(sizes: FontSizes) {
  if (typeof document === 'undefined') return
  const style = document.documentElement.style
  for (const { id } of FONT_LEVELS) {
    const px = sizes[id]
    if (px === undefined) style.removeProperty(`--user-font-${id}`)
    else style.setProperty(`--user-font-${id}`, `${px}px`)
  }
}

function readStored(): FontSizes {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    const sizes: FontSizes = {}
    for (const { id } of FONT_LEVELS) {
      const px = validPx(raw?.[id])
      if (px !== undefined) sizes[id] = px
    }
    return sizes
  } catch {
    return {}
  }
}

interface TypographyState {
  sizes: FontSizes
  /** `undefined` (or an out-of-range value) clears the override. */
  setSize: (level: FontLevel, px: number | undefined) => void
  reset: () => void
}

function persist(sizes: FontSizes) {
  if (typeof localStorage === 'undefined') return
  if (Object.keys(sizes).length === 0) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes))
}

export const useTypography = create<TypographyState>()((set, get) => ({
  sizes: readStored(),
  setSize: (level, px) => {
    const sizes = { ...get().sizes }
    const valid = validPx(px)
    if (valid === undefined) delete sizes[level]
    else sizes[level] = valid
    persist(sizes)
    applySizes(sizes)
    set({ sizes })
  },
  reset: () => {
    persist({})
    applySizes({})
    set({ sizes: {} })
  },
}))

// Apply on boot (imported from main.tsx) so a note never renders at the
// default size first.
applySizes(useTypography.getState().sizes)
