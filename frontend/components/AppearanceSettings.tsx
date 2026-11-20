import { useEffect, useRef } from 'react'
import { useTheme, type ThemePreference } from '../stores/theme'
import { FONT_LEVELS, MAX_FONT_PX, MIN_FONT_PX, defaultFontPx, useTypography, type FontLevel } from '../stores/typography'

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

const subheading = 'text-xs font-medium text-foreground mb-2 block'

/** Settings → General → Appearance: theme and editor font sizes. */
export default function AppearanceSettings() {
  return (
    <div className="flex flex-col gap-6">
      <ThemePicker />
      <FontSizes />
    </div>
  )
}

function ThemePicker() {
  const { preference, name, setTheme } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme">
      <span className={subheading}>Theme</span>
      <div className="flex gap-2">
        {THEME_OPTIONS.map(option => {
          const selected = preference === option.id
          return (
            <button key={option.id} type="button" role="radio" aria-checked={selected} onClick={() => setTheme(option.id)}
              className={'flex-1 px-3 py-2 rounded-md cursor-pointer border text-[13px] transition-colors ' +
                (selected ? 'border-accent text-foreground' : 'border-border text-foreground-secondary hover:bg-surface-active hover:text-foreground')}>
              {option.label}
            </button>
          )
        })}
      </div>
      {preference === 'system' && <p className="mt-1.5 text-[11px] text-muted">Following your system — currently {name === 'dark' ? 'Dark' : 'Light'}.</p>}
    </div>
  )
}

function FontSizes() {
  const { sizes, setSize, reset } = useTypography()
  const overridden = Object.keys(sizes).length > 0
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className={subheading + ' mb-0'}>Font size</span>
        {overridden && (
          <button type="button" onClick={reset} className="cursor-pointer border-none bg-transparent p-0 text-[11px] text-muted hover:text-foreground">Reset to defaults</button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {FONT_LEVELS.map(level => (
          <FontSizeRow key={level.id} id={level.id} label={level.label} value={sizes[level.id]} onCommit={px => setSize(level.id, px)} />
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">Empty uses the default. Applies to every screen size.</p>
    </div>
  )
}

/** Uncontrolled while typing: the size is committed on blur or Enter, so an
 *  in-between value ("3" on the way to "32") is never applied or rejected. The
 *  row is never remounted (Enter keeps focus); the field is rewritten instead,
 *  with the applied value after a commit and the stored one after a reset. */
function FontSizeRow({ id, label, value, onCommit }: { id: FontLevel; label: string; value: number | undefined; onCommit: (px: number | undefined) => void }) {
  const inputId = `font-size-${id}`
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (inputRef.current) inputRef.current.value = value === undefined ? '' : String(value)
  }, [value])
  const commit = (input: HTMLInputElement) => {
    const raw = input.value.trim()
    const number = raw === '' ? NaN : Number(raw)
    const px = Number.isFinite(number) ? Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, number)) : undefined
    input.value = px === undefined ? '' : String(px)
    if (px !== value) onCommit(px)
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={inputId} className="text-[13px] text-foreground-secondary">{label}</label>
      <div className="flex items-center gap-1.5">
        <input ref={inputRef} id={inputId} type="number" inputMode="decimal" min={MIN_FONT_PX} max={MAX_FONT_PX} step={1}
          defaultValue={value ?? ''} placeholder={String(defaultFontPx(id))}
          onBlur={event => commit(event.currentTarget)}
          onKeyDown={event => { if (event.key === 'Enter') commit(event.currentTarget) }}
          className="w-20 bg-background border border-border rounded-md px-2 py-1 text-right text-[13px] text-foreground outline-none focus:border-accent placeholder:text-muted" />
        <span className="text-[11px] text-muted">px</span>
      </div>
    </div>
  )
}
