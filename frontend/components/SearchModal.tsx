import { useState, useEffect, useRef } from 'react'
import { invoke } from '../lib/ipc'
import { Search, X, FileText } from 'lucide-react'
import { useEditorStore } from '../stores/editor'
import { stripMarkdownExt } from '../utils/fileKind'

/** Search modal overlay — command-palette style search. */
export default function SearchModal({ onClose, onSelect }: { onClose: () => void; onSelect: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{path:string;name:string}[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const { openFile } = useEditorStore()

  useEffect(() => { inputRef.current?.focus() }, [])

  // Search vault when query changes
  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const timer = setTimeout(() => {
      invoke<string>('search_vault', { query }).then(s => {
        try { const r = JSON.parse(s).slice(0, 20); setResults(r); setSelectedIdx(0) } catch {}
      }).catch(e => console.error('Search:', e))
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  // Keyboard navigation
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && results[selectedIdx]) {
        const p = results[selectedIdx].path
        const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : ''
        onSelect(parent)
        openFile(p, results[selectedIdx].name)
        onClose()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, results, selectedIdx, openFile, onSelect])

  /** Keep the highlighted result in view when navigating with the keyboard. */
  useEffect(() => {
    const el = resultsRef.current?.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] w-[500px] max-h-[50vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <Search size={16} className="text-muted shrink-0" />
          <input ref={inputRef} type="text" value={query} onChange={e => setQuery(e.target.value)}
            className="w-full bg-transparent text-sm text-foreground outline-none border-none" placeholder="Search files..." />
          <button onClick={onClose} className="p-1 rounded cursor-pointer bg-transparent text-muted hover:text-foreground-secondary"><X size={16} /></button>
        </div>
        <div ref={resultsRef} className="overflow-y-auto max-h-[40vh] p-2">
          {results.length === 0 && query && <div className="py-6 px-3 text-sm text-muted text-center">No files found</div>}
          {results.map((item, i) => (
            <div key={item.path} onClick={() => { 
              const parent = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) : ''
              onSelect(parent)
              openFile(item.path, item.name); onClose() }}
              className={'flex items-center gap-3 px-3 py-2 cursor-pointer text-sm rounded ' + (i === selectedIdx ? 'bg-surface-active text-foreground' : 'text-foreground-secondary')}>
              <FileText size={14} className="text-muted shrink-0" />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{stripMarkdownExt(item.name)}</span>
              <span className="text-xs text-muted overflow-hidden text-ellipsis whitespace-nowrap ml-auto">{item.path}</span>
            </div>
          ))}
          {!query && <div className="py-6 px-3 text-sm text-muted text-center">Type to search files...</div>}
        </div>
      </div>
    </div>
  )
}