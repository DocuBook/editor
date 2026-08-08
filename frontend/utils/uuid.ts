/** Secure-context-safe UUID v4.
 *  `crypto.randomUUID` only exists in secure contexts (https / localhost) —
 *  on plain HTTP (e.g. http://<ip>:8080) it is undefined and the AI stream
 *  crashed with "crypto.randomUUID is not a function". Fall back to
 *  `crypto.getRandomValues` (available everywhere), then Math.random. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
