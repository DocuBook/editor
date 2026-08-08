/**
 * Shared e2e helpers — CI-friendly. The useful artifact is LOGS, not
 * screenshots:
 *   - server stdout/stderr → artifacts/<name>.server.log (never discarded)
 *   - browser console + pageerrors → artifacts/<name>.browser.log
 *   - pass/fail lines → artifacts/<name>.results.txt
 *   - the failing run prints the tail of the server log to stdout
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const ARTIFACTS = 'test/artifacts'

/** Locate the Playwright browser binary — env override (CHROMIUM_EXE /
 *  WEBKIT_EXE / BROWSER_EXE), then the standard ms-playwright cache on
 *  macOS/Linux. Undefined → Playwright auto-resolves its own pinned browser
 *  (after `npx playwright install chromium|webkit`). */
export function browserPath(engine = process.env.BROWSER || 'chromium') {
  const e = engine.toLowerCase()
  const envExe = process.env[`${e.toUpperCase()}_EXE`]
  if (envExe) return envExe
  const bases = [
    `${homedir()}/Library/Caches/ms-playwright`,
    `${homedir()}/.cache/ms-playwright`,
  ]
  for (const base of bases) {
    try {
      for (const dir of readdirSync(base)) {
        if (!dir.startsWith(`${e}-`)) continue
        for (const c of e === 'chromium'
          ? [
              `${base}/${dir}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
              `${base}/${dir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
              `${base}/${dir}/chrome-linux/chrome`,
            ]
          : [`${base}/${dir}/pw_run.sh`]) {
          if (existsSync(c)) return c
        }
      }
    } catch {}
  }
  // Dev fallback: the pinned Playwright build may not run on older macOS
  // (Playwright 1.62+ drops macOS 12) — drive the system Chrome instead.
  if (e === 'chromium') {
    for (const c of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ]) if (existsSync(c)) return c
  }
  return undefined
}

/** Launch the configured engine (BROWSER env: chromium | webkit), headless. */
export async function launchBrowser() {
  const engine = (process.env.BROWSER || 'chromium').toLowerCase()
  const { chromium, webkit } = await import('playwright')
  const launcher = engine === 'webkit' ? webkit : chromium
  const exe = browserPath(engine)
  return launcher.launch({ ...(exe ? { executablePath: exe } : {}), headless: true })
}

export function ensureArtifacts() {
  mkdirSync(ARTIFACTS, { recursive: true })
}

/** Spawn the server with logs piped to artifacts/<name>.server.log. */
export function startServer(name, { binary, cmd = binary, args = [], env = {}, port, dataDir, wwwDir, shell = false }) {
  ensureArtifacts()
  const logPath = `${ARTIFACTS}/${name}.server.log`
  appendFileSync(logPath, `\n===== ${name} server start ${new Date().toISOString()} =====\n`)
  const bin = spawn(cmd, args, {
    env: { ...process.env, ...env, DATA_DIR: dataDir, WWW_DIR: wwwDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
  })
  bin.stdout?.on('data', d => appendFileSync(logPath, d))
  bin.stderr?.on('data', d => appendFileSync(logPath, d))
  return { bin, logPath }
}

export async function waitForServer(base, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base); if (r.status < 500) return } catch {}
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('server did not start')
}

/** Capture browser console + pageerrors to artifacts/<name>.browser.log. */
export function attachLogging(page, name) {
  ensureArtifacts()
  const logPath = `${ARTIFACTS}/${name}.browser.log`
  appendFileSync(logPath, `\n===== ${name} browser console ${new Date().toISOString()} =====\n`)
  const errors = []
  const sink = (tag, line) => appendFileSync(logPath, `[${tag}] ${line}\n`)
  page.on('console', m => {
    sink(m.type(), m.text())
    if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  })
  page.on('pageerror', e => {
    sink('pageerror', String(e))
    errors.push('pageerror: ' + String(e).slice(0, 200))
  })
  return { errors, logPath }
}

/** CI summary: write results file, print pass/fail, print server-log tail on failure. */
export function summary(name, results, { serverLog } = {}) {
  ensureArtifacts()
  const lines = results.map(([s, n, e]) => `${s}  ${n}${e ? ' — ' + e : ''}`)
  writeFileSync(`${ARTIFACTS}/${name}.results.txt`, lines.join('\n') + '\n')
  const failed = results.filter(([s]) => s === 'FAIL')
  console.log(`\n=== ${name.toUpperCase()} RESULTS (${results.length - failed.length}/${results.length} pass) ===`)
  for (const l of lines) console.log(' ' + l)
  if (failed.length) {
    const log = serverLog ? readFileSync(serverLog, 'utf8') : ''
    const tail = log.trim().split('\n').slice(-30).join('\n')
    console.log(`\n${failed.length} FAILED — tail of ${serverLog || '<no server log>'}:`)
    console.log(tail)
  }
  return failed.length === 0
}
