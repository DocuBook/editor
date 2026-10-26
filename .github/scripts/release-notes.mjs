#!/usr/bin/env node
/**
 * Builds the GitHub release body for one tag from CHANGELOG.md.
 *
 *   node .github/scripts/release-notes.mjs <tag> <changelog> [contributors-file]
 *
 * Prints the tag's changelog section with the icons taken out of its headings,
 * followed by a Contributors section when the contributors file lists anyone
 * (one GitHub login per line; ci.yml `publish` fills it from the commits since
 * the previous release). `@login` mentions are what GitHub turns into the
 * release page's contributor avatars.
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

/** Unique logins, in first-seen order, without bots. */
export function parseContributors(text) {
  const seen = new Map()
  for (const raw of text.split('\n')) {
    const login = raw.trim().replace(/^@/, '')
    if (!login || /\[bot\]$/i.test(login) || seen.has(login.toLowerCase())) continue
    seen.set(login.toLowerCase(), login)
  }
  return [...seen.values()]
}

export function contributorsSection(logins) {
  if (!logins.length) return ''
  return `### Contributors\n\n${logins.map((login) => `* @${login}`).join('\n')}`
}

export function buildNotes(changelog, tag, contributorsText = '') {
  const body = cleanHeadings(extractSection(changelog, tag))
  const contributors = contributorsSection(parseContributors(contributorsText))
  return [body, contributors].filter(Boolean).join('\n\n\n') + '\n'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tag, changelogPath, contributorsPath] = process.argv.slice(2)
  if (!tag || !changelogPath) {
    console.error('usage: release-notes.mjs <tag> <changelog> [contributors-file]')
    process.exit(2)
  }
  const changelog = readFileSync(changelogPath, 'utf8')
  if (!extractSection(changelog, tag)) {
    console.error(`::error::${changelogPath} has no "## ${tag}" section`)
    process.exit(1)
  }
  let contributors = ''
  try { if (contributorsPath) contributors = readFileSync(contributorsPath, 'utf8') } catch { /* none listed */ }
  process.stdout.write(buildNotes(changelog, tag, contributors))
}
