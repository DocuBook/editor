import { useEffect, useState } from 'react'
import { NumberInput, SegmentedControl } from '@mantine/core'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from '../stores/theme'
import { FONT_LEVELS, MAX_FONT_PX, MIN_FONT_PX, defaultFontPx, useTypography, type FontLevel } from '../stores/typography'

const THEME_OPTIONS: { value: ThemePreference; label: string; Icon: typeof Monitor }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
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
    <div>
      <span className={subheading} id="appearance-theme-label">Theme</span>
      <SegmentedControl
        fullWidth
        withItemsBorders={false}
        aria-labelledby="appearance-theme-label"
        value={preference}
        onChange={value => setTheme(value as ThemePreference)}
        classNames={{ root: 'appearance-segmented', indicator: 'appearance-segmented-indicator', label: 'appearance-segmented-label' }}
        data={THEME_OPTIONS.map(({ value, label, Icon }) => ({
          value,
          label: <span className="flex items-center justify-center gap-1.5"><Icon size={14} aria-hidden="true" />{label}</span>,
        }))}
      />
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

/** The size is committed on blur or Enter, so an in-between value ("3" on the
 *  way to "32") is never applied or rejected. The draft is rewritten with the
 *  applied value after a commit (clamped or cleared) and with the stored one
 *  after a reset. Mantine's own clamp is off: it would rewrite the draft on
 *  blur before this commit reads it. */
function FontSizeRow({ id, label, value, onCommit }: { id: FontLevel; label: string; value: number | undefined; onCommit: (px: number | undefined) => void }) {
  const inputId = `font-size-${id}`
  const [draft, setDraft] = useState<string | number>(value ?? '')
  /* oxlint-disable react/set-state-in-effect -- rewrites the draft after a commit or reset */
  useEffect(() => { setDraft(value ?? '') }, [value])
  /* oxlint-enable react/set-state-in-effect */
  const commit = () => {
    const number = typeof draft === 'number' ? draft : draft.trim() === '' ? NaN : Number(draft)
    const px = Number.isFinite(number) ? Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, number)) : undefined
    setDraft(px ?? '')
    if (px !== value) onCommit(px)
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={inputId} className="text-[13px] text-foreground-secondary">{label}</label>
      <NumberInput
        id={inputId}
        size="xs"
        w={88}
        hideControls
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        min={MIN_FONT_PX}
        max={MAX_FONT_PX}
        value={draft}
        onChange={setDraft}
        placeholder={String(defaultFontPx(id))}
        rightSection={<span className="text-[11px] text-muted">px</span>}
        onBlur={commit}
        onKeyDown={event => { if (event.key === 'Enter') commit() }}
        classNames={{ input: 'web-search-picker-input text-right placeholder:text-muted' }}
      />
    </div>
  )
}
