import { useEffect, useState } from 'react'
import { Collapse } from '@mantine/core'
import { ChevronDown, FileText, Link2 } from 'lucide-react'

import { invoke } from '../../lib/ipc'
import { useEditorStore } from '../../stores/editor'
import FileMetaLabel from '../FileMetaLabel'

/** `name` is the file stem (core/wiki `backlinks`), so it is shown as-is but never used as a tab title. */
type Backlink = { path: string; name: string; snippet: string }

/** Wikilinks property: notes linking to `path`, as a label plus a trigger
 *  that expands the list in place below it. */
function WikilinksProperty({ path }: { path: string }) {
  const [items, setItems] = useState<Backlink[]>([])
  const [open, setOpen] = useState(false)
  const openFile = useEditorStore(s => s.openFile)

  useEffect(() => {
    let cancelled = false
    invoke<string>('wiki_backlinks', { path })
      .then(s => { if (!cancelled) setItems(JSON.parse(s)) })
      .catch(e => console.error('Backlinks:', e))
    return () => { cancelled = true }
  }, [path])

  if (items.length === 0) return null
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted">
          <Link2 size={13} className="shrink-0" />
          Wikilinks
        </span>
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          aria-label={`Wikilinks: ${items.length} linked ${items.length === 1 ? 'note' : 'notes'}`}
          className={'flex items-center gap-1 cursor-pointer rounded px-1.5 py-0.5 border-none transition-colors hover:bg-surface-active ' + (open ? 'bg-surface-active text-foreground' : 'bg-transparent text-foreground-secondary')}>
          {items.length} {items.length === 1 ? 'note' : 'notes'}
          <ChevronDown size={12} className={'shrink-0 transition-transform ' + (open ? 'rotate-180' : '')} />
        </button>
      </div>
      <Collapse expanded={open}>
        {/* Tree guides: each row draws a rounded elbow (├/└) from the trunk under
            the Link2 icon; `after` continues the trunk past every row but the last.
            The elbow height (12px) is the first text line's center: py-1 + half of leading-4. */}
        <ul className="mt-0.5 ml-[6px] max-h-72 overflow-y-auto list-none p-0">
          {items.map(item => {
            const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
            return (
              <li key={item.path} className="relative pl-3.5 before:absolute before:left-0 before:top-0 before:h-3 before:w-2.5 before:rounded-bl-md before:border-l before:border-b before:border-border after:absolute after:left-0 after:top-3 after:bottom-0 after:border-l after:border-border last:after:hidden">
                <button type="button" onClick={() => { void openFile(item.path, item.path.split('/').pop() || item.path) }} title={item.path}
                  className="group flex items-start gap-1.5 w-full min-w-0 cursor-pointer rounded px-1.5 py-1 text-left bg-transparent border-none hover:bg-surface-active transition-colors">
                  <FileText size={12} className="mt-0.5 shrink-0 text-foreground-subtle group-hover:text-syntax-wikilink" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5 min-w-0 text-[12px] leading-4">
                      <FileMetaLabel name={item.name} meta={dir}
                        nameClassName="truncate text-foreground-secondary group-hover:text-foreground"
                        metaClassName="truncate shrink-[2] text-[11px] text-muted" />
                    </span>
                    {item.snippet && <span className="block truncate text-[11px] leading-4 text-muted">{item.snippet}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Collapse>
    </div>
  )
}

/** Inline properties block above the document body. Holds the computed
 *  Wikilinks row today; frontmatter properties join here later (raw mode
 *  shows them as frontmatter instead, so the editor only renders this in rich mode). */
export default function InlineProperties({ path }: { path: string }) {
  return (
    <div className="px-(--editor-gutter) mb-1 empty:hidden">
      <WikilinksProperty path={path} />
    </div>
  )
}
