import { useTheme, type ThemeName } from '../stores/theme'

/** Named themes, Zed-style — each entry is a theme NAME (no Light/Dark
 *  suffix; the name itself describes the look). Selected entry is highlighted. */
const THEMES: { id: ThemeName; name: string; hint: string }[] = [
  { id: 'dark', name: 'Midnight', hint: 'Low-light default' },
  { id: 'light', name: 'Bright Surfaces', hint: 'Daytime' },
]

export default function AppearanceSettings() {
  const { name, setTheme } = useTheme()
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold text-foreground uppercase tracking-wide mb-1">Theme</div>
      {THEMES.map(t => (
        <button key={t.id} onClick={() => setTheme(t.id)}
          className={'flex items-center justify-between px-3 py-2.5 rounded-md cursor-pointer border text-[13px] transition-colors text-left ' +
            (name === t.id ? 'border-accent text-foreground' : 'border-border text-foreground-secondary hover:bg-surface-active hover:text-foreground')}>
          <span className="font-medium">{t.name}</span>
          <span className="text-[11px] text-muted flex items-center gap-2">
            {t.hint}
            {name === t.id && <span className="text-accent">✓</span>}
          </span>
        </button>
      ))}
    </div>
  )
}
