/**
 * Run all e2e suites sequentially — one entry point for local AND CI.
 *
 *   BROWSER=chromium npm run test:e2e   # default
 *   BROWSER=webkit  npm run test:e2e    # CI matrix (macos-14)
 *
 * Each suite spawns its own server on its own port, writes its logs to
 * test/artifacts/, and this runner fails the run (exit 1) if any
 * suite fails — so CI gates on the whole set, not just the first.
 */
import { spawnSync } from 'node:child_process'

const SUITES = ['web-smoke', 'trash', 'theme-check', 'ai-debug']
const results = []

for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [`test/${suite}.mjs`], {
    stdio: 'inherit',
    env: process.env,
  })
  results.push([suite, r.status === 0])
}

console.log(`\n=== E2E ALL (BROWSER=${process.env.BROWSER || 'chromium'}) ===`)
for (const [s, ok] of results) console.log(` ${ok ? 'PASS' : 'FAIL'}  ${s}`)

if (results.some(([, ok]) => !ok)) process.exit(1)
