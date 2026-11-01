#!/usr/bin/env node
/**
 * Builds the GitHub release body for one tag from CHANGELOG.md.
 *
 *   node .github/scripts/release-notes.mjs <tag> <changelog> [authors-file]
 *
 * Prints the tag's changelog section with the icons taken out of its headings,
 * and "by @login" after each bullet whose commit the authors file names
 * ("<sha> <login>" per line; ci.yml `publish` fills it from the commits since
 * the previous release). GitHub turns those mentions into the release page's
 * contributor avatars; a mention hidden in an HTML comment does not count.
 *
 * Icons: the section names in release-please-config.json carry none, but
 * release-please hardcodes "### ⚠ BREAKING CHANGES" and older sections were
 * written with emoji, so every heading is cleaned here rather than trusted.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The lines between `## <tag>` and the next `## ` heading. */
export function extractSection(changelog, tag) {
  const lines = changelog.split('\n')
  const heading = `## ${tag}`
  // `## v0.5.1 — date`, never `## v0.5.10`.
  const start = lines.findIndex((line) => line.startsWith(heading) && /^(\s|$)/.test(line.slice(heading.length)))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

/** "### 🐛 Bug Fixes" → "### Bug Fixes", "### ⚠ BREAKING CHANGES" → "### BREAKING CHANGES". */
export function cleanHeadings(markdown) {
  return markdown.replace(/^(#{1,6})[ \t]+(?:[\p{Extended_Pictographic}\p{So}️‍]+[ \t]*)+/gmu, '$1 ')
}

/** "<sha> <login>" lines → Map(sha → login), bots left out. */
export function parseAuthors(text) {
  const authors = new Map()
  for (const raw of text.split('\n')) {
    const [sha, login] = raw.trim().split(/\s+/)
    if (sha && login && !/\[bot\]$/i.test(login)) authors.set(sha.toLowerCase(), login.replace(/^@/, ''))
  }
  return authors
}

/** Appends " by @login" to each bullet linking a commit the map knows. */
export function attributeBullets(markdown, authors) {
  return markdown.replace(/^(\*.*\/commit\/([0-9a-f]{40})\).*?)[ \t]*$/gim, (line, body, sha) => {
    const login = authors.get(sha.toLowerCase())
    return login ? `${body} by @${login}` : line
  })
}

export function buildNotes(changelog, tag, authorsText = '') {
  return attributeBullets(cleanHeadings(extractSection(changelog, tag)), parseAuthors(authorsText)) + '\n'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tag, changelogPath, authorsPath] = process.argv.slice(2)
  if (!tag || !changelogPath) {
    console.error('usage: release-notes.mjs <tag> <changelog> [authors-file]')
    process.exit(2)
  }
  const changelog = readFileSync(changelogPath, 'utf8')
  if (!extractSection(changelog, tag)) {
    console.error(`::error::${changelogPath} has no "## ${tag}" section`)
    process.exit(1)
  }
  let authors = ''
  try { if (authorsPath) authors = readFileSync(authorsPath, 'utf8') } catch { /* none listed */ }
  process.stdout.write(buildNotes(changelog, tag, authors))
}
