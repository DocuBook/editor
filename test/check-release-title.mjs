#!/usr/bin/env node
/**
 * Release PR title guard (.github/scripts/release-title.mjs).
 *
 *   1. The subject is the most prominent entry (breaking > feature > fix > …),
 *      cleaned of scope, links and trailing PR/commit refs. No "+N more": the
 *      rest of the list belongs in the body, not the title.
 *   2. Every title it produces still parses back to its version under the
 *      configured `pull-request-title-pattern`, with release-please's own
 *      matcher. If it did not, the merged release PR would not be tagged.
 *
 * Run: node test/check-release-title.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseSubject, releaseTitle } from '../.github/scripts/release-title.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const expectEqual = (name, actual, expected) => {
  if (actual !== expected) failures.push(`${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
}

const body = `:robot: I have created a release *beep* *boop*
---

## [0.9.0](https://github.com/o/r/compare/v0.8.1...v0.9.0) (2026-11-20)

### Bug Fixes

* **deps:** bump libz-sys to 1.1.33 ([#474](https://github.com/o/r/issues/474)) ([85b6abe](https://github.com/o/r/commit/85b6abe6673e))
* **deps:** bump libz-sys to 1.1.33 for RUSTSEC-2026-0544 ([85b6abe](https://github.com/o/r/commit/85b6abe6673e))

### Features

* **ai:** animated bot icon for the AI status line ([#478](https://github.com/o/r/issues/478)) ([2995a44](https://github.com/o/r/commit/2995a440ff31))

### Refactor

* **sidebar:** replace the profile menu with a settings icon ([#476](https://github.com/o/r/issues/476)) ([f80a697](https://github.com/o/r/commit/f80a69753a94))
`

// 1. A feature beats a fix section that comes before it.
expectEqual('feature headline', releaseSubject(body), 'animated bot icon for the AI status line')

expectEqual('breaking change outranks features',
  releaseSubject(`${body}\n### ⚠ BREAKING CHANGES\n\n* **api:** drop the v1 endpoints ([1111111](https://github.com/o/r/commit/1111111aaaa))\n`),
  'drop the v1 endpoints')

expectEqual('inline links become their text',
  releaseSubject('### Features\n\n* **ai:** [@mention](https://github.com/mention) list in the composer ([2222222](https://github.com/o/r/commit/2222222bbbb))\n'),
  '@mention list in the composer')

expectEqual('a long headline is cut on a word boundary',
  releaseSubject('### Features\n\n* remove MCP context servers; the built-in web_search and web_fetch tools replace them ([3333333](https://github.com/o/r/commit/3333333cccc))\n'),
  'remove MCP context servers; the built-in web_search and…')

expectEqual('no entries: bare title', releaseTitle('0.9.0', ':robot: release\n\n## [0.9.0](x) (2026-11-20)\n'), 'chore(release): v0.9.0')
expectEqual('title joins version and subject', releaseTitle('0.9.0', body), 'chore(release): v0.9.0 — animated bot icon for the AI status line')

// 2. release-please 17's matcher, verbatim (build/src/util/pull-request-title.js
//    generateMatchPattern + build/src/version.js VERSION_REGEX).
function generateMatchPattern(pattern) {
  return new RegExp(`^${pattern.replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace('${scope}', '(\\((?<branch>[\\w-./]+)\\))?')
    .replace('${component}', ' ?(?<component>@?[\\w-./]*)?')
    .replace('${version}', 'v?(?<version>[0-9].*)')
    .replace('${branch}', '(?<branch>[\\w-./]+)?')}$`)
}
const VERSION_REGEX = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(-(?<preRelease>[^+]+))?(\+(?<build>.*))?/
const parsedVersion = (title, pattern) => {
  const version = title.match(generateMatchPattern(pattern))?.groups?.version?.match(VERSION_REGEX)?.groups
  return version ? `${version.major}.${version.minor}.${version.patch}${version.preRelease ? `-${version.preRelease}` : ''}` : null
}

const pattern = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'))['pull-request-title-pattern']
for (const title of [
  releaseTitle('0.9.0', body),
  releaseTitle('0.9.0', ''),
  releaseTitle('1.0.0', '### Features\n\n* 2-step login + build-cache ([4444444](https://github.com/o/r/commit/4444444dddd))\n'),
  'chore(release): v0.8.1 — DocuBook', // titles of releases merged before this change
]) {
  const expected = title.match(/v(\d+\.\d+\.\d+)/)[1]
  expectEqual(`release-please reads ${JSON.stringify(title)} as its version`, parsedVersion(title, pattern), expected)
}

if (failures.length) {
  console.error(`✗ release title guard — ${failures.length} failure(s):\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('✓ release title guard')
