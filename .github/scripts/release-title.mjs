#!/usr/bin/env node
/**
 * Builds the release PR title from the release PR body (release-please's
 * changelog for the version):
 *
 *   node .github/scripts/release-title.mjs <version> < body.md
 *   → chore(release): v0.9.0 — animated bot icon for the AI status line
 *
 * The subject is the most prominent entry (breaking changes, then features,
 * fixes, security, performance, refactors, anything else); the full list stays
 * in the PR body / CHANGELOG. With no entries the title is the bare
 * `chore(release): vX.Y.Z`.
 *
 * release-please reads the version back out of this title when the PR merges
 * (to tag the release), so release-please-config.json's
 * `pull-request-title-pattern` must END with `${version}`: its version group
 * then swallows the " — subject" and the version still parses. A suffix after
 * `${version}` in the pattern would make this title unparseable and the release
 * would silently not be tagged (test/check-release-title.mjs guards this).
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SECTION_ORDER = ['breaking changes', 'features', 'bug fixes', 'security', 'performance', 'refactor', 'ci']
const MAX_HEADLINE = 60

/** `### ⚠ BREAKING CHANGES` → `breaking changes`. */
const sectionKey = (heading) => heading.replace(/^#+\s*/, '').replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase()

/** `* **ai:** subject ([#478](…)) ([2995a44](…))` → subject. */
function parseEntry(line) {
  let text = line.replace(/^[*-]\s+/, '')
  // Trailing "([#478](url))" / "([sha](url))" link groups.
  while (/\s*\(\[[^\]]*\]\([^)]*\)\)\s*$/.test(text)) text = text.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)\s*$/, '')
  // Scope prefix, then inline links (release-please links every `@name`).
  text = text.replace(/^\*\*[^*]+:\*\*\s*/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
  return text
}

/** Cut on a word boundary so the title stays one readable line. */
function shorten(text) {
  if (text.length <= MAX_HEADLINE) return text
  const cut = text.slice(0, MAX_HEADLINE - 1)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`
}

export function releaseSubject(body) {
  const entries = []
  let section = ''
  for (const line of body.split('\n')) {
    if (/^#{2,4}\s/.test(line)) { section = sectionKey(line); continue }
    if (!section || !/^[*-]\s+\S/.test(line)) continue
    const rank = SECTION_ORDER.indexOf(section)
    const subject = parseEntry(line)
    if (subject) entries.push({ subject, rank: rank === -1 ? SECTION_ORDER.length : rank })
  }
  if (entries.length === 0) return ''
  return shorten(entries.reduce((best, entry) => (entry.rank < best.rank ? entry : best)).subject)
}

export function releaseTitle(version, body) {
  const subject = releaseSubject(body)
  return `chore(release): v${version}${subject ? ` — ${subject}` : ''}`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: release-title.mjs <version> < body.md')
    process.exit(2)
  }
  process.stdout.write(releaseTitle(version, readFileSync(0, 'utf8')) + '\n')
}
