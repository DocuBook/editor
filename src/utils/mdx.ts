// ── Flame MDX components ──
const MDX_TAGS = [
  'Accordion','Accordions','Button','Card','Cards','CodeBlock','File','Files','Folder',
  'Kbd','Mermaid','Changes','Release','Step','Steps','Tab','Tabs',
  'Tooltip','Note',
]

/** Extract MDX component tags into numbered placeholders so BlockNote doesn't mangle them. */
export function extractMdxBlocks(content: string): [string, Map<string, string>] {
  const blocks = new Map<string, string>()
  let uid = 0
  let result = content.replace(/<([A-Z][a-zA-Z]*)([^>]*?)\/>\s*/g, (m, tag) => {
    if (!MDX_TAGS.includes(tag)) return m
    const k = `<<<MDX_${uid++}>>>`; blocks.set(k, m); return k + '\n'
  })
  result = result.replace(/<([A-Z][a-zA-Z]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, (m, tag) => {
    if (!MDX_TAGS.includes(tag)) return m
    const k = `<<<MDX_${uid++}>>>`; blocks.set(k, m); return k + '\n'
  })
  return [result, blocks]
}

/** Restore MDX placeholders back to original component tags after BlockNote round-trip. */
export function restoreMdxBlocks(md: string, blocks: Map<string, string>): string {
  let r = md
  for (const [k, v] of blocks) r = r.replace(k, v)
  return r
}
