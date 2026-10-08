/** Minimal line diff for the read-only Changes view — deliberately dependency-free
 *  (no `diff`/Myers package), matching the app's "compute it ourselves" rule for
 *  previews (`ConflictDialog`). */

export type DiffRow = { type: 'context' | 'add' | 'del' | 'gap'; text: string }

/** Upper bound on the LCS table (old×new middle lines). Above it the middle is
 *  reported as a deletion block followed by an insertion block, which is what a
 *  wholesale rewrite renders as anyway. */
const MAX_LCS_CELLS = 4_000_000
/** Unchanged lines kept around each change before a run is collapsed to `⋯`. */
const CONTEXT_LINES = 3

/** Split into lines, dropping the empty trailing element a final newline creates
 *  so an unchanged file does not read as one phantom change. */
const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function lineDiff(oldText: string, newText: string): DiffRow[] {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  // Trim the shared head/tail first: the LCS then only walks the changed middle,
  // which is tiny for a typical edit in an otherwise long note.
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)

  const rows: DiffRow[] = oldLines.slice(0, prefix).map(text => ({ type: 'context', text }))
  if (oldMid.length * newMid.length > MAX_LCS_CELLS) {
    rows.push(...oldMid.map(text => ({ type: 'del' as const, text })))
    rows.push(...newMid.map(text => ({ type: 'add' as const, text })))
  } else {
    rows.push(...lcsRows(oldMid, newMid))
  }
  rows.push(...oldLines.slice(oldLines.length - suffix).map(text => ({ type: 'context' as const, text })))

  return rows.some(row => row.type !== 'context') ? collapseContext(rows) : []
}

/** Classic LCS table walk, emitting context/deletion/insertion rows in order. */
function lcsRows(oldMid: string[], newMid: string[]): DiffRow[] {
  const n = oldMid.length
  const m = newMid.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = oldMid[i] === newMid[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldMid[i] === newMid[j]) { rows.push({ type: 'context', text: oldMid[i] }); i++; j++ }
    else if (table[i + 1][j] >= table[i][j + 1]) { rows.push({ type: 'del', text: oldMid[i] }); i++ }
    else { rows.push({ type: 'add', text: newMid[j] }); j++ }
  }
  while (i < n) { rows.push({ type: 'del', text: oldMid[i] }); i++ }
  while (j < m) { rows.push({ type: 'add', text: newMid[j] }); j++ }
  return rows
}

/** Keep `CONTEXT_LINES` around every change; fold longer unchanged runs into one
 *  `gap` row so the view stays a diff rather than a coloured copy of the file. */
function collapseContext(rows: DiffRow[]): DiffRow[] {
  const keep = new Array<boolean>(rows.length).fill(false)
  rows.forEach((row, index) => {
    if (row.type === 'context') return
    for (let i = Math.max(0, index - CONTEXT_LINES); i <= Math.min(rows.length - 1, index + CONTEXT_LINES); i++) keep[i] = true
  })
  const out: DiffRow[] = []
  let skipping = false
  rows.forEach((row, index) => {
    if (keep[index]) { out.push(row); skipping = false }
    else if (!skipping) { out.push({ type: 'gap', text: '' }); skipping = true }
  })
  return out
}
