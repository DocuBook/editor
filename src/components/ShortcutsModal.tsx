import { useEffect } from 'react'
import { X } from 'lucide-react'

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
    { keys: '\u2318\u21E7Z', desc: 'Redo' },
    { keys: '\u2318E', desc: 'Toggle WYSIWYG / Markdown' },
    { keys: '\u2318\u23CE', desc: 'Run AI prompt' },
  ]},
  { category: 'AI & Settings', items: [
    { keys: '\u02C6\u2325L', desc: 'Toggle AI panel' },
    { keys: '\u2318,', desc: 'AI Settings' },
  ]},
  { category: 'Files', items: [
    { keys: '\u2318N', desc: 'New file' },
    { keys: '\u2318\u2325N', desc: 'New folder' },
  ]},
]

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '10vh' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, width: 480, maxHeight: '70vh', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Keyboard Shortcuts</span>
          <button onClick={onClose} style={{ padding: 4, borderRadius: 4, cursor: 'pointer', background: 'transparent', color: 'var(--text-muted)', border: 'none' }}><X size={16} /></button>
        </div>
        <div style={{ padding: '8px 0', overflowY: 'auto', maxHeight: 'calc(70vh - 55px)' }}>
          {SHORTCUTS.map(group => (
            <div key={group.category}>
              <div style={{ padding: '8px 20px 4px', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{group.category}</div>
              {group.items.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 20px', fontSize: 13, color: 'var(--text-secondary)' }}>
                  <span>{item.desc}</span>
                  <kbd style={{ background: 'var(--bg-primary)', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontFamily: 'inherit' }}>{item.keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
