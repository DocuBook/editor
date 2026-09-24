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

export const PORTS = {
  theme: 4173,
  overlay: 4176,
  toolbar: 4179,
  rawMarkdown: 4180,
  cursorTable: 4181,
  mobileShell: 4182,
  webSmoke: 4273,
  trash: 4274,
  aiDebug: 4275,
  aiPreFlicker: 4277,
  aiChatFocus: 4288,
  aiMultiblock: 4289,
  aiMention: 4290,
  gitBranch: 4281,
}

export function ok(results) {
  return (name, condition, extra = '') => {
    results.push([condition ? 'PASS' : 'FAIL', name, extra])
    if (!condition) process.exitCode = 1
  }
}

const API_FIXTURES = {
  setup_status: { setupRequired: false, setupToken: false },
  list_tree: [{ path: 'notes.md', name: 'notes.md', type: 'file' }],
  open_vault: { name: 'demo' },
  git_status: { status: '', isRepo: false, hasRemote: false, ahead: 0, upstream: '', repoState: 'clean' },
  list_trash: [],
  get_backlinks: [],
  wiki_backlinks: [],
}
const RAW_RESULTS = new Set(['read_file'])

export async function stubBackend(page, { email, noteText }) {
  const api = { ...API_FIXTURES, setup_admin: { email }, account_get: { email }, read_file: noteText }
  await page.route('**/api/**', async route => {
    const command = route.request().url().split('/api/')[1]?.split('?')[0] || ''
    const result = Object.prototype.hasOwnProperty.call(api, command) ? api[command] : {}
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ result: RAW_RESULTS.has(command) ? result : JSON.stringify(result) }),
    })
  })
}

export async function bootstrapSession(name, { port, dataDir, vaultPath = `${dataDir}/vaults/myva`, viewport }) {
  const base = `http://localhost:${port}`
  const api = async (command, args = {}, cookie = '') => {
    const response = await fetch(`${base}/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
    })
    return { status: response.status, text: await response.text() }
  }

  await waitForServer(base)
  const admin = { email: `${name}@test.dev`, password: 'password1' }
  const setup = await api('setup_admin', admin)
  if (setup.status !== 200) throw new Error(`setup_admin failed: ${setup.text}`)
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(admin),
  })
  const setCookie = login.headers.get('set-cookie') || ''
  const cookie = setCookie.split(';')[0]
  if (login.status !== 200 || !cookie.startsWith('db_session=')) {
    throw new Error(`login failed: ${login.status} ${setCookie}`)
  }
  const opened = await api('open_vault', { path: vaultPath }, cookie)
  if (opened.status !== 200) throw new Error(`open_vault failed: ${opened.text}`)

  const browser = await launchBrowser()
  const context = await browser.newContext({ viewport })
  await context.addCookies([{ name: 'db_session', value: cookie.slice('db_session='.length), url: base }])
  const page = await context.newPage()
  const logging = attachLogging(page, name)
  return { browser, context, page, logging, base, api }
}

const ARTIFACTS = 'test/artifacts'

/** Locate the Playwright browser binary — env override (CHROMIUM_EXE /
 *  WEBKIT_EXE / BROWSER_EXE), then the standard ms-playwright cache on
 *  macOS/Linux. Undefined → Playwright auto-resolves its own pinned browser
 *  (after `npx playwright install chromium|webkit`). */
export function browserPath(engine = process.env.BROWSER || 'chromium', launcher) {
  const e = engine.toLowerCase()
  const envExe = process.env[`${e.toUpperCase()}_EXE`]
  if (envExe) return envExe
  // Driver-canonical executable for the installed Playwright version — tried
  // FIRST. GitHub macOS runners pre-install OLD playwright builds in the
  // cache; the dir-scan below would pick those, and a stale webkit rejects
  // the driver's `PushAPIEnabled` context setting (protocol error).
  try {
    const p = launcher?.executablePath?.()
    if (p && existsSync(p)) return p
  } catch {}
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
  const exe = browserPath(engine, launcher)
  return launcher.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, timeout: 60_000 })
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
    if (m.type() === 'error' && !/Viewport argument key "interactive-widget" not recognized/.test(m.text())) {
      errors.push(m.text().slice(0, 200))
      process.exitCode = 1
    }
  })
  page.on('pageerror', e => {
    sink('pageerror', String(e))
    errors.push('pageerror: ' + String(e).slice(0, 200))
    process.exitCode = 1
  })
  return { errors, logPath }
}

/** Mock the AI config backend for the browser.
 *
 * AI connection data lives in the server's config.json — the browser keeps NO
 * copy (there is no localStorage persistence any more), so a harness that used
 * to seed `docubook:ai-settings` must answer the read commands instead. The
 * mock is stateful so a test can flip a probe or revoke a provider between
 * reloads, exactly like the real backend would.
 *
 * @param page   Playwright page.
 * @param opts.provider      provider id (default: the custom OpenAI-compatible one,
 *                           which is text-only until probed true).
 * @param opts.model         model id the backend reports as active.
 * @param opts.baseUrl       endpoint URL bound to the provider.
 * @param opts.hasKey        whether the backend holds a key (default true).
 * @param opts.probes        probe map `{ [model]: supportsTools }`.
 * @param opts.env           env override for the custom provider, if any.
 * @returns a mutable `state` object: change `state.probes` / `state.saved`
 *          and the next /api/ai_settings call reports it.
 */
export async function mockAiSettings(page, opts = {}) {
  const {
    provider = 'openai-compatible',
    model = 'mock-model',
    baseUrl = 'http://mock.invalid/v1',
    hasKey = true,
    probes = {},
    env,
  } = opts
  const state = { probes: { ...probes }, hasKey, saved: [provider] }

  const aiSettings = () => JSON.stringify({
    active: state.saved.length ? provider : '',
    endpoints: state.hasKey && state.saved.includes(provider)
      ? { [provider]: { baseUrl, model, probes: state.probes, hasKey: true } }
      : {},
    savedProviders: [...state.saved],
    ...(env ? { env } : {}),
  })

  await page.route('**/api/ai_settings', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: aiSettings() }) }))
  await page.route('**/api/custom_ai_config', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: JSON.stringify({ source: env ? 'env' : 'file', baseUrl, model, hasKey }) }),
    }))
  await page.route('**/api/list_api_keys', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: JSON.stringify([]) }) }))
  return state
}

/**
 * Frame one mock SSE event in the server's wire format.
 *
 * Every event carries the `requestId` the frontend sent with the request: the
 * transport drops frames whose id does not match the turn it is currently
 * streaming (a late event from a stopped/retried turn must not be folded in),
 * and tokens arrive wrapped as `{ requestId, token }` rather than a bare string.
 */
export function sseFrames(requestId, events) {
  return events.flatMap(([name, payload]) => {
    const tagged = payload.requestId ? payload : { requestId, ...payload }
    return [`event: ${name}`, `data: ${JSON.stringify(tagged)}`, '']
  }).join('\n')
}

/**
 * Mock `POST /api/ask_ai` with a scripted SSE stream.
 *
 * `build(request, hits)` returns the event list for that call, so a suite can
 * switch between a text answer and tool calls by inspecting the request body.
 * Each frame is tagged with the request's own id (see `sseFrames`).
 *
 *   await mockAskAi(page, () => [['ai:token', { token: 'hi' }], ['ai:done', { provider: 'mock', truncated: false }]])
 */
export async function mockAskAi(page, build) {
  let hits = 0
  await page.route('**/api/ask_ai', route => {
    hits++
    const request = route.request().postDataJSON() || {}
    const events = build(request, hits) || []
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseFrames(String(request.requestId || ''), events),
    })
  })
  return () => hits
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
