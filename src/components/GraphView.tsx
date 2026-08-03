import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { X } from 'lucide-react'
import { useEditorStore } from '../stores/editor'

interface GraphData {
  nodes: { id: string; title: string; group: number }[]
  links: { source: string; target: string }[]
}

/**
 * Full-screen graph overlay showing vault note connections.
 * Renders nodes as SVG circles with titles.
 */
export default function GraphView({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<GraphData | null>(null)
  const { openFile } = useEditorStore()

  useEffect(() => {
    invoke<string>('wiki_backlinks', { path: '' }).then(raw => {
      try {
        const links = JSON.parse(raw) as { path: string; name: string }[]
        const nodes = links.map(l => ({ id: l.path, title: l.name, group: 1 }))
        setData({ nodes, links: [] })
      } catch { setData({ nodes: [], links: [] }) }
    }).catch(() => setData({ nodes: [], links: [] }))
  }, [])

  return (
    <div className="fixed inset-0 z-40 bg-[var(--bg-primary)]" onClick={onClose}>
      <div className="absolute top-3 right-3 z-10" onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-hover)] text-zinc-500 cursor-pointer">
          <X size={20} />
        </button>
      </div>
      <div className="flex items-center justify-center h-full" onClick={e => e.stopPropagation()}>
        {!data ? (
          <div className="text-zinc-500">Loading graph...</div>
        ) : data.nodes.length === 0 ? (
          <div className="text-zinc-500">No notes to graph</div>
        ) : (
          <svg width="100%" height="100%" viewBox="0 0 800 600" className="max-w-full max-h-full">
            {data.nodes.map((node, i) => (
              <g key={node.id} onClick={() => { openFile(node.id, node.title + '.md'); onClose() }} className="cursor-pointer">
                <circle cx={100 + (i % 10) * 70} cy={50 + Math.floor(i / 10) * 70} r="8" fill="var(--accent)" stroke="var(--accent-hover)" strokeWidth="1.5" />
                <text x={100 + (i % 10) * 70 + 12} y={50 + Math.floor(i / 10) * 70 + 3} fill="var(--text-secondary)" fontSize="10">{node.title}</text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  )
}
