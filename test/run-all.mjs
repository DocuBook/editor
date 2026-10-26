/**
 * Run all e2e suites sequentially — one entry point for local AND CI.
 *
 *   BROWSER=chromium npm run test:e2e   # default
 *   BROWSER=webkit  npm run test:e2e    # CI matrix (macos-15)
 *
 * Each suite spawns its own server on its own port, writes its logs to
 * test/artifacts/, and this runner fails the run (exit 1) if any
 * suite fails — so CI gates on the whole set, not just the first.
 *
 * A suite that stops making progress is killed, not waited for. `spawnSync`
 * with `timeout` cannot do that: it sends SIGTERM once and then blocks until
 * the child exits, and a suite that has launched a browser never does —
 * Playwright's own SIGTERM handler closes the browser and does NOT exit the
 * process, so the stuck promise keeps it alive. One such hang held a CI job
 * for the full 6 hours. The suite therefore runs in its own process group and
 * is escalated to SIGKILL, which takes the server and the browser with it.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const SUITES = readdirSync('test')
  .filter(file => file.endsWith('.mjs') && file !== 'run-all.mjs' && !file.startsWith('check-') && file !== 'lib.mjs')
  .map(file => file.slice(0, -4))
  .sort()

/** Per suite. The in-suite deadline (lib.mjs) fires first and reports where it
 *  stuck; this is the backstop for a suite that cannot even do that. */
const SUITE_TIMEOUT_MS = Number(process.env.E2E_SUITE_TIMEOUT_MS) || 240_000
/** SIGTERM first so a healthy-but-slow suite can write its logs. */
const KILL_GRACE_MS = 5_000
const POSIX = process.platform !== 'win32'

let current

/** Signal the suite's whole process group (server, browser, node), or just the
 *  child where process groups do not exist. */
function signalSuite(child, signal) {
  try {
    if (POSIX && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

/** Resolves 'pass' | 'fail' | 'timeout'. Never throws, never waits unbounded. */
function runSuite(suite) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [`test/${suite}.mjs`], {
      stdio: 'inherit',
      env: process.env,
      detached: POSIX,
    })
    current = child
    let timedOut = false
    let killer
    const timer = setTimeout(() => {
      timedOut = true
      console.error(`\n[e2e] ${suite} exceeded ${SUITE_TIMEOUT_MS / 1000}s — terminating its process group`)
      signalSuite(child, 'SIGTERM')
      killer = setTimeout(() => signalSuite(child, 'SIGKILL'), KILL_GRACE_MS)
    }, SUITE_TIMEOUT_MS)
    const finish = outcome => {
      clearTimeout(timer)
      clearTimeout(killer)
      // Whatever the suite left behind (a server on its port, a browser).
      signalSuite(child, 'SIGKILL')
      current = undefined
      resolve(outcome)
    }
    child.on('error', () => finish('fail'))
    child.on('exit', code => finish(timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail'))
  })
}

// CI cancels a job with SIGTERM/SIGINT: take the running suite down with us
// instead of orphaning its server and browser.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (current) signalSuite(current, 'SIGKILL')
    process.exit(130)
  })
}

const results = []
for (const suite of SUITES) results.push([suite, await runSuite(suite)])

console.log(`\n=== E2E ALL (BROWSER=${process.env.BROWSER || 'chromium'}) ===`)
for (const [suite, outcome] of results) {
  console.log(` ${outcome === 'pass' ? 'PASS' : outcome === 'timeout' ? 'TIMEOUT' : 'FAIL'}  ${suite}`)
}

if (results.some(([, outcome]) => outcome !== 'pass')) process.exit(1)
