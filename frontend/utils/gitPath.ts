const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }

/** Readable form of a status path. The backend C-quotes names that contain a
 *  newline, invalid UTF-8 or edge spaces (`"caf\351.md"`); the quoted form stays
 *  the identity sent back to stage and diff, this one is only for display. */
export function displayGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path
  const inner = path.slice(1, -1)
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      const char = String.fromCodePoint(inner.codePointAt(i)!)
      bytes.push(...encoder.encode(char))
      i += char.length - 1
      continue
    }
    const next = inner[++i]
    if (next in ESCAPES) bytes.push(ESCAPES[next])
    else if (/^[0-3][0-7]{2}$/.test(inner.slice(i, i + 3))) { bytes.push(parseInt(inner.slice(i, i + 3), 8)); i += 2 }
    else return path
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}
