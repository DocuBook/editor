import { useEffect } from 'react'
import { X, Command, ArrowBigUp, Option, ChevronUp, ArrowUp, ArrowDown } from 'lucide-react'
import { isTauri } from '../lib/ipc'

/** Render shortcut key glyphs (⌘⇧⌥⌃↑↓) as lucide icons — consistent with TabBar tooltips. */
const KEY_ICONS: Record<string, { Icon: any; size?: number }> = {
  '\u2318': { Icon: Command, size: 11 },
  '\u21E7': { Icon: ArrowBigUp, size: 11 },
  '\u2325': { Icon: Option, size: 11 },
  '\u02C6': { Icon: ChevronUp, size: 10 },
  '\u2191': { Icon: ArrowUp, size: 11 },
  '\u2193': { Icon: ArrowDown, size: 11 },
}
function ShortcutKeys({ keys }: { keys: string }) {
  const parts = keys.split(/([\u2318\u21E7\u2325\u02C6\u2191\u2193])/)
  return (
    <kbd className="bg-background px-1.5 py-0.5 rounded text-[11px] font-inherit inline-flex items-center gap-0.5 whitespace-nowrap">
      {parts.map((p, i) => {
        const def = KEY_ICONS[p]
        return def ? <def.Icon key={i} size={def.size} /> : <span key={i}>{p}</span>
      })}
    </kbd>
  )
}

const SHORTCUTS = [
  { category: 'Navigation', items: [
    { keys: '\u2318J', desc: 'Toggle sidebar' },
  ]},
  { category: 'Search & Open', items: [
    { keys: '\u2318F', desc: 'Search files' },
    { keys: '\u2318P', desc: 'Search files (alt)' },
    { keys: '\u2318O', desc: 'Open vault' },
  ]},
  { category: 'Editor', items: [
    { keys: '\u2318Z', desc: 'Undo' },
    { keys: '\u2318\u21E7Z / \u2318Y', desc: 'Redo' },
    { keys: '\u2318\u21E7E', desc: 'Toggle WYSIWYG / Markdown' },
  ]},
  { category: 'AI & Settings', items: [
    { keys: '\u02C6\u2325L', desc: 'Ask AI / Write with AI (toggles floating chat)' },
    { keys: '\u2318,', desc: 'Settings' },
  ]},
  { category: 'Writing', items: [
    { keys: 'Tab / \u21E7Tab', desc: 'Indent / outdent block' },
    { keys: 'Enter', desc: 'New block' },
    { keys: '\u21E7Enter', desc: 'Line break in block' },
    { keys: '\u2318B / \u2318I / \u2318U / \u2318K / \u2318\u21E7S', desc: 'Bold / Italic / Underline / Link / Strike' },
    { keys: '\u2318E', desc: 'Inline code' },
    { keys: '\u2318\u21E7\u2191 / \u2318\u21E7\u2193', desc: 'Move block up / down' },
    { keys: '\u2318\u23250', desc: 'Paragraph' },
    { keys: '\u2318\u23251-5', desc: 'Heading level 1-5' },
    { keys: '\u2318\u2325Q', desc: 'Quote' },
    { keys: '\u2318\u21E76', desc: 'Toggle list' },
    { keys: '\u2318\u21E77', desc: 'Numbered list' },
    { keys: '\u2318\u21E78', desc: 'Bullet list' },
    { keys: '\u2318\u21E79', desc: 'Checklist' },
    { keys: '# + space', desc: 'Toggle heading' },
    { keys: '- + space', desc: 'Toggle bullet list' },
    { keys: '1. + space', desc: 'Toggle numbered list' },
    { keys: '[] + space', desc: 'Toggle checklist' },
    { keys: '> + space', desc: 'Toggle quote' },
    { keys: '``` + space', desc: 'Toggle code block' },
  ]},
  { category: 'Files', items: [
    /** Canonical ⌘⇧F / ⌘⌥⇧F work on every platform (browsers reserve ⌘N /
     *  ⌘⇧N / ⌘⌥N — new/private window — and never deliver them to the page).
     *  Native keeps ⌘N / ⌘⌥N as an alias, shown here per platform. */
    { keys: isTauri ? '\u2318N / \u2318\u21E7F' : '\u2318\u21E7F', desc: 'New file' },
    { keys: isTauri ? '\u2318\u2325N / \u2318\u2325\u21E7F' : '\u2318\u2325\u21E7F', desc: 'New folder' },
  ]},
]

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="bg-surface border border-border rounded-xl w-[480px] max-h-[70vh] overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <span className="text-[13px] font-semibold text-foreground">Keyboard Shortcuts</span>
          <button onClick={onClose} className="p-1 rounded cursor-pointer bg-transparent text-muted border-none hover:text-foreground-secondary"><X size={16} /></button>
        </div>
        <div className="py-2 overflow-y-auto max-h-[calc(70vh-55px)]">
          {SHORTCUTS.map(group => (
            <div key={group.category}>
              <div className="px-5 pt-2 pb-1 text-[10px] text-muted uppercase tracking-[0.05em] font-semibold">{group.category}</div>
              {group.items.map((item, i) => (
                <div key={i} className="flex items-center justify-between px-5 py-1.5 text-[13px] text-foreground-secondary">
                  <span>{item.desc}</span>
                  <ShortcutKeys keys={item.keys} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
