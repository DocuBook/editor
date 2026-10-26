#!/usr/bin/env node
/**
 * Release-notes guard: the GitHub release body that ci.yml `publish` builds
 * with .github/scripts/release-notes.mjs.
 *
 *   1. It is the tag's own CHANGELOG section (`## v0.5.1` never picks up
 *      `## v0.5.10`), so a release never ships an empty or foreign body.
 *   2. No heading carries an icon, including release-please's hardcoded
 *      "### ⚠ BREAKING CHANGES" and the emoji sections of older releases.
 *   3. A Contributors section lists each human author once, as an @mention
 *      (what GitHub renders as the contributor avatars), and is left out when
 *      there is nobody to list.
 *   4. release-please-config.json's section names carry no icon either, so the
 *      changelog and the release PR match the release body.
 *
 * Run: node test/check-release-notes.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNotes, cleanHeadings, extractSection } from '../.github/scripts/release-notes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const fail = (msg) => failures.push(msg)
const ICON = /[\p{Extended_Pictographic}\p{So}️]/u

const changelog = `# Changelog

## v0.5.10 — 2026-11-02

### Features

* wrong release

## v0.5.1 — 2026-10-26


### ⚠ BREAKING CHANGES

* **ai:** something breaks

### 🐛 Bug Fixes

* **ai:** Return starts a new line ([#351](https://x/351))

### 🛡️ Security

* tighten a check

### CI

* publish the image

## v0.5.0 — 2026-10-26

* older
`

// --- 1. Section boundaries
const section = extractSection(changelog, 'v0.5.1')
if (!section.startsWith('### ⚠ BREAKING CHANGES') || !section.endsWith('* publish the image')) {
  fail(`extractSection did not return exactly the v0.5.1 section: ${JSON.stringify(section)}`)
}
if (/wrong release|older/.test(section)) fail('extractSection leaked a neighbouring release into v0.5.1')
if (extractSection(changelog, 'v9.9.9') !== '') fail('extractSection returned text for a tag with no section')

// --- 2. Headings without icons, bullets untouched
const notes = buildNotes(changelog, 'v0.5.1', 'gitfromwildan\nsomeone\n@GitFromWildan\ngithub-actions[bot]\n\n')
for (const line of notes.split('\n').filter((l) => /^#{1,6} /.test(l))) {
  if (ICON.test(line)) fail(`heading still carries an icon: ${JSON.stringify(line)}`)
}
for (const heading of ['### BREAKING CHANGES', '### Bug Fixes', '### Security', '### CI']) {
  if (!notes.split('\n').includes(heading)) fail(`expected heading ${JSON.stringify(heading)} in the notes`)
}
if (!notes.includes('* **ai:** Return starts a new line ([#351](https://x/351))')) fail('a changelog bullet was altered')
if (cleanHeadings('### [0.5.1](https://x) (2026-10-26)') !== '### [0.5.1](https://x) (2026-10-26)') {
  fail('cleanHeadings altered a heading that has no icon')
}

// --- 3. Contributors
if (!/\n### Contributors\n\n\* @gitfromwildan\n\* @someone\n$/.test(notes)) {
  fail(`Contributors section wrong (deduplicated, no bots, @mentions, last): ${JSON.stringify(notes.slice(notes.indexOf('### Contributors')))}`)
}
if (buildNotes(changelog, 'v0.5.1', 'renovate[bot]\n').includes('Contributors')) {
  fail('an empty Contributors section was added when only bots contributed')
}

// The real changelog's latest release builds cleanly too.
const real = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const latest = real.match(/^## (v\d+\.\d+\.\d+\S*)/m)?.[1]
if (!latest) fail('CHANGELOG.md has no release heading')
else {
  const built = buildNotes(real, latest, 'someone\n')
  if (built.split('\n').some((l) => /^#{1,6} /.test(l) && ICON.test(l))) fail(`${latest}: a heading kept its icon`)
  if (built.trim() === '### Contributors\n\n* @someone') fail(`${latest}: the changelog section came out empty`)
}

// --- 4. The config the changelog is generated from
const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'))
for (const { type, section: name } of config['changelog-sections'] ?? []) {
  if (ICON.test(name)) fail(`release-please-config.json: section for "${type}" carries an icon: ${JSON.stringify(name)}`)
}

// --- The publish step must use this builder.
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
if (!/node \.github\/scripts\/release-notes\.mjs "\$TAG" CHANGELOG\.md \/tmp\/contributors\.txt/.test(ci)) {
  fail('ci.yml publish does not build the release body with .github/scripts/release-notes.mjs')
}

if (failures.length) {
  console.error('Release-notes guard FAILED:\n')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('Release-notes guard OK — the release body is its own changelog section, headings carry no icon, and Contributors lists each human author once')
