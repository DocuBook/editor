/** Policy for media URLs embedded in notes.
 *
 *  Local vault files are read through the app's own IPC/HTTP path and `data:`
 *  URLs are already in the document, so neither touches the network. Remote
 *  media (http/https, and protocol-relative `//host`) does — which is why it is
 *  gated behind an explicit opt-in. */

/** True for URLs that would make the reader's browser contact another host. */
export function isRemoteMediaUrl(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(url.trim())
}

/** Resolve a protocol-relative URL to HTTPS. The document is served from an app
 *  scheme (`tauri://`, `http://tauri.localhost`), so a bare `//host` would
 *  inherit THAT scheme instead of the web's, producing an unreachable URL. */
export function normalizeRemoteMediaUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?)(?:[?#]|$)/i
const ANY_EXT = /\.[a-z0-9]{2,5}(?:[?#]|$)/i

/** Whether the blocked-image placeholder can stand in for this URL, for a block
 *  that is NOT an image (video, audio, file).
 *
 *  Every file block shares one `resolveFileUrl` that receives only the URL, but
 *  the placeholder is an SVG *image*: handing it to `<video>`, `<audio>`, or a
 *  file block yields a broken player/link instead of a click target. So only
 *  image-looking URLs — an image extension, or no extension at all (the CDN
 *  case, where the type is unknowable) — get the placeholder; a URL that names
 *  itself as another kind of file resolves as it did before.
 *
 *  An image block never asks: the extension says nothing about what a server
 *  sends back (`pixel.php`, `pixel.pdf` and `pixel.mp4` all render as images), so
 *  every remote image is gated — see `runForImageBlock`. */
export function canUseImagePlaceholder(url: string): boolean {
  return IMAGE_EXT.test(url) || !ANY_EXT.test(url)
}

let resolvingForImageBlock = false

/** Run `render` — an image block's render — so that `isResolvingForImageBlock`
 *  is true for any `resolveFileUrl` call it makes synchronously.
 *
 *  `resolveFileUrl` is shared by the image, video and audio blocks and gets only
 *  a URL, so it cannot tell them apart. BlockNote's image block calls it from
 *  inside its own `render` (before the first await), which is the one place the
 *  block type is knowable; this marks that window. Nested calls restore the
 *  previous state, and a throwing render cannot leave it set. */
export function runForImageBlock<T>(render: () => T): T {
  const previous = resolvingForImageBlock
  resolvingForImageBlock = true
  try {
    return render()
  } finally {
    resolvingForImageBlock = previous
  }
}

/** True only while an image block's render is running (see `runForImageBlock`).
 *  Read it synchronously at the top of `resolveFileUrl`. */
export function isResolvingForImageBlock(): boolean {
  return resolvingForImageBlock
}

/** Marker left inside the placeholder SVG so the blocked state is identifiable
 *  from the `src` attribute (`encodeURIComponent` leaves it intact) — used for
 *  the pointer cursor in index.css. */
export const BLOCKED_REMOTE_MEDIA_MARKER = 'docubook-blocked-media'

/** Placeholder shown in place of blocked remote media. A `data:` SVG never
 *  leaves the machine, so rendering it cannot leak anything — unlike an empty
 *  `src`, which some browsers resolve against the current document URL. */
export const BLOCKED_REMOTE_MEDIA = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120">`
  + `<!--${BLOCKED_REMOTE_MEDIA_MARKER}-->`
  + '<rect width="480" height="120" fill="#e5e7eb"/>'
  + '<text x="240" y="56" fill="#6b7280" font-family="sans-serif" font-size="14" text-anchor="middle">'
  + 'Remote image blocked'
  + '</text>'
  + '<text x="240" y="78" fill="#9ca3af" font-family="sans-serif" font-size="12" text-anchor="middle">'
  + 'Click to load this image'
  + '</text></svg>',
)}`

/** Placeholder for ONE specific URL. The fragment carries the URL so a click can
 *  recover exactly which image the reader opted into — the DOM never holds the
 *  remote URL before consent, and browsers ignore the fragment when rendering. */
export function blockedRemoteMediaPlaceholder(url: string): string {
  return `${BLOCKED_REMOTE_MEDIA}#${encodeURIComponent(url)}`
}

/** The original URL carried by a placeholder produced above, or null when `src`
 *  is not one of ours (a real image, an inline `data:` image, or empty). */
export function blockedRemoteMediaUrl(src: string | null): string | null {
  if (!src || !src.startsWith(`${BLOCKED_REMOTE_MEDIA}#`)) return null
  try {
    const url = decodeURIComponent(src.slice(BLOCKED_REMOTE_MEDIA.length + 1))
    return isRemoteMediaUrl(url) ? url : null
  } catch {
    return null
  }
}

/** Images the reader opted into for THIS session, by URL. In-memory only:
 *  closing the app returns to "nothing is allowed", so a note cannot accumulate
 *  third-party contacts across runs. */
const allowedForSession = new Set<string>()

/** Record a per-image opt-in. Scoped to the URL, not the host: the reader chose
 *  one image, so no other URL on the same host is contacted on their behalf. */
export function allowRemoteMediaForSession(url: string): void {
  allowedForSession.add(normalizeRemoteMediaUrl(url))
}

export function isRemoteMediaAllowedForSession(url: string): boolean {
  return allowedForSession.has(normalizeRemoteMediaUrl(url))
}

/** Undo a session opt-in. Used when the host fails to serve the image: keeping
 *  the URL allowed would make the next render try again and paint a broken
 *  image instead of the retryable placeholder. */
export function forgetRemoteMediaForSession(url: string): void {
  allowedForSession.delete(normalizeRemoteMediaUrl(url))
}

/** Test seam: forget every session opt-in. */
export function resetSessionRemoteMediaAllowlist(): void {
  allowedForSession.clear()
}
