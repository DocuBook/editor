/**
 * Shared e2e helpers — CI-friendly. Two artifacts matter:
 *   - a FAILING run writes artifacts/<name>.gif: one frame per assertion, so the
 *     rule that broke is visible instead of inferred from a wall of text
 *   - artifacts/<name>.server.log / .browser.log keep the text evidence a GIF
 *     cannot carry (a Rust 500, a refused request, an engine warning)
 *   - pass/fail lines -> artifacts/<name>.results.txt, and the failing run prints
 *     the tail of the server log to stdout
 */
import { execFileSync, execSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export const PORTS = {
  mobileShell: 4182,
  webSmoke: 4273,
  trash: 4274,
  aiDebug: 4275,
  aiMention: 4290,
}

const ARTIFACTS = 'test/artifacts'

/**
 * Assertion frame trail: every `ok()` queues one JPEG frame (never awaited —
 * assertions stay synchronous), and a failing run assembles them into
 * artifacts/<name>.gif — the frames that lead to the broken rule, and the frame
 * of the gap itself. A passing run deletes the frames.
 *
 * The GIF needs a full ffmpeg: Playwright ships a deliberately minimal build
 * (no gif muxer, no palettegen) for video recording only. With no system ffmpeg
 * the frames are kept instead, so the evidence is never lost.
 */
function frameTrail(page, name) {
  const dir = `${ARTIFACTS}/${name}.frames`
  const frames = []
  let queue = Promise.resolve()
  return {
    capture(label, passed) {
      mkdirSync(dir, { recursive: true })
      /* Numbered only: `%03d.jpg` is the image2 sequence every ffmpeg reads.
         Frame N is assertion N of artifacts/<name>.results.txt — that file is
         the caption line for the GIF. */
      const file = `${dir}/${String(frames.length).padStart(3, '0')}.jpg`
      frames.push({ file, label, passed })
      queue = queue.then(() => page.screenshot({ path: file, type: 'jpeg', quality: 82 }).catch(() => {}))
    },
    /** Returns the GIF path when the run failed, else undefined. */
    async finish(failed) {
      await queue
      if (!failed || frames.length === 0) {
        rmSync(dir, { recursive: true, force: true })
        return undefined
      }
      const gap = frames.findIndex(frame => !frame.passed) + 1
      const gif = `${ARTIFACTS}/${name}.gif`
      const ffmpeg = systemFfmpeg()
      if (!ffmpeg) {
        console.log(`\nNo system ffmpeg — kept ${frames.length} JPEG frames. Encode with:\n  ffmpeg -framerate 1 -i ${dir}/%03d.jpg -vf fps=2,scale=520:-1 -loop 0 ${gif}`)
        return dir
      }
      try {
        execFileSync(ffmpeg, [
          '-y', '-loglevel', 'error',
          '-framerate', '1', '-i', `${dir}/%03d.jpg`,
          '-vf', 'fps=2,scale=520:-1:flags=lanczos',
          '-loop', '0', gif,
        ], { stdio: 'inherit' })
      } catch {
        console.log(`\nGIF assembly failed — kept ${frames.length} JPEG frames in ${dir}`)
        return dir
      }
      rmSync(dir, { recursive: true, force: true })
      console.log(`\nRULE GAP ${gap}/${frames.length} → ${gif}`)
      return gif
    },
  }
}

/** A full ffmpeg (gif muxer + palette filters) — Playwright's own build cannot
 *  encode GIF, so the system one is required. `FFMPEG_EXE` overrides. */
function systemFfmpeg() {
  if (process.env.FFMPEG_EXE) return process.env.FFMPEG_EXE
  try {
    const found = execSync('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (found) return found
  } catch {}
  return undefined
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

/** JSON response in the IPC bridge's `{ result }` envelope. */
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

export async function stubBackend(page, { email, noteText }) {
  const api = { ...API_FIXTURES, setup_admin: { email }, account_get: { email }, read_file: noteText }
  await page.route('**/api/**', async route => {
    const command = route.request().url().split('/api/')[1]?.split('?')[0] || ''
    const result = Object.prototype.hasOwnProperty.call(api, command) ? api[command] : {}
    await route.fulfill(json({ result: RAW_RESULTS.has(command) ? result : JSON.stringify(result) }))
  })
}

/** Open the seeded `notes.md` from the tree and wait for its text to render —
 *  every suite that boots the server seeds that file before boot. */
export async function openNote(page, text = 'hello world') {
  const entry = page.getByText('notes', { exact: true }).first()
  await entry.waitFor({ timeout: 15000 })
  await entry.click()
  await page.getByText(text, { exact: true }).waitFor({ timeout: 15000 })
}

/** Free the port a previous (aborted) run may still hold. */
export function killPort(port) {
  try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }) } catch {}
}

/**
 * One suite lifecycle — every suite file is assertions only, the boilerplate
 * lives here once: artifacts dir, data reset, seeded vault files, server (web
 * binary or `vite preview`), browser + page, session bootstrap, console gate,
 * results and exit code.
 *
 * opts:
 *   port      listen port (use PORTS)
 *   server    'preview' = `vite preview` serving the static frontend and no API
 *             (the suite stubs /api/** in the browser), or `{ binary, env }` for
 *             the web server — which is also the default
 *   session   setup_admin + login + open_vault and drop the cookie into the
 *             browser context; defaults to true for the real server, false for
 *             'preview' (web-smoke drives the wizard itself: session: false)
 *   viewport  browser viewport (default 1280×800)
 *   dataDir   reset before boot (default /tmp/docubook-e2e-<name>)
 *   vaultPath default <dataDir>/vaults/myva
 *   seed      [{ path, content }] written into the vault before boot
 *   allow     console errors the suite provokes on purpose (see attachLogging)
 *   setup     async (ctx) => {} — route mocks / init scripts, before the body
 *
 * body receives ctx: { base, api, page, context, browser, server, restart, ok,
 * results, vaultPath, admin }.
 */
export async function runSuite(name, opts, body) {
  const {
    port,
    server = { binary: 'server/target/debug/docubook-server' },
    session = typeof server === 'object',
    viewport = { width: 1280, height: 800 },
    dataDir = `/tmp/docubook-e2e-${name}`,
    vaultPath = `${dataDir}/vaults/myva`,
    admin = { email: `${name}@test.dev`, password: 'password1' },
    seed = [],
    setup,
    allow = [],
  } = opts
  const base = `http://localhost:${port}`
  const results = []
  let trail
  const ok = (label, condition, extra = '') => {
    results.push([condition ? 'PASS' : 'FAIL', label, extra])
    if (!condition) process.exitCode = 1
    trail?.capture(label, condition)
  }

  ensureArtifacts()
  killPort(port)
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(vaultPath, { recursive: true })
  for (const file of seed) {
    const path = `${vaultPath}/${file.path}`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }

  /* One server per suite, restarted in place by ctx.restart(). */
  const spawnServer = () => (server === 'preview'
    ? startServer(name, { cmd: 'npx', args: ['vite', 'preview', '--port', String(port), '--strictPort'], shell: true, port, dataDir, wwwDir: 'dist' })
    : startServer(name, { binary: server.binary, port, dataDir, wwwDir: 'dist', env: server.env }))
  let running = spawnServer()

  const api = async (command, args = {}, cookie = '') => {
    const response = await fetch(`${base}/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(args),
    })
    return { status: response.status, text: await response.text() }
  }

  let browser
  let page
  let logging
  const ctx = {
    base, api, ok, results, vaultPath, admin,
    get page() { return page },
    get browser() { return browser },
    get server() { return running },
    /** Restart on the same data dir — credentials and sessions must persist. */
    async restart() {
      running.bin.kill()
      await new Promise(r => setTimeout(r, 1500))
      running = spawnServer()
      await waitForServer(base)
    },
  }

  try {
    await waitForServer(base)
    browser = await launchBrowser()
    ctx.context = await browser.newContext({ viewport })
    if (session) {
      const created = await api('setup_admin', admin)
      ok('setup_admin: ok', created.status === 200, created.text.slice(0, 80))
      const login = await fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(admin),
      })
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
      ok('login: session cookie issued', login.status === 200 && cookie.startsWith('db_session='), String(login.status))
      const opened = await api('open_vault', { path: vaultPath }, cookie)
      ok('open_vault: ok', opened.status === 200, opened.text.slice(0, 80))
      await ctx.context.addCookies([{ name: 'db_session', value: cookie.slice('db_session='.length), url: base }])
    }
    page = await ctx.context.newPage()
    logging = attachLogging(page, name, { allow })
    trail = frameTrail(page, name)
    if (setup) await setup(ctx)
    await body(ctx)
  } catch (error) {
    results.push(['FAIL', 'setup/run', String(error).split('\n')[0]])
    process.exitCode = 1
  }

  /* Frames need a live page: build the GIF before the browser goes away. */
  const failed = results.some(([status]) => status === 'FAIL') || (logging?.errors.length ?? 0) > 0
  await trail?.finish(failed)
  await browser?.close().catch(() => {})
  running.bin.kill()

  if (!summary(name, results, { serverLog: running.logPath, logging })) process.exitCode = 1
}

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

/**
 * Console noise every engine emits and the app cannot fix, matched on exact text
 * so a NEW message is never swallowed by a broad filter.
 *
 * WebKit cannot parse the Chromium-only `interactive-widget` viewport key and
 * logs it as an error; Chromium honors the key (it is what keeps the composer
 * above the soft keyboard on Android) and other engines ignore it.
 */
const ENGINE_NOISE = [/Viewport argument key "interactive-widget" not recognized/]

/**
 * Capture browser console + pageerrors to artifacts/<name>.browser.log.
 *
 * `allow` declares errors the suite itself provokes (a deliberately injected API
 * failure, a harness that serves no backend). Everything outside that and
 * ENGINE_NOISE lands in `errors`, which `summary(..., { logging })` reports as a
 * counted assertion — never as a bare exit code, so a suite can no longer fail
 * while printing "all assertions pass".
 */
export function attachLogging(page, name, { allow = [] } = {}) {
  ensureArtifacts()
  const logPath = `${ARTIFACTS}/${name}.browser.log`
  appendFileSync(logPath, `\n===== ${name} browser console ${new Date().toISOString()} =====\n`)
  const errors = []
  const allowed = [...ENGINE_NOISE, ...allow]
  const sink = (tag, line) => appendFileSync(logPath, `[${tag}] ${line}\n`)
  page.on('console', m => {
    sink(m.type(), m.text())
    if (m.type() === 'error' && !allowed.some(re => re.test(m.text()))) errors.push(m.text().slice(0, 200))
  })
  page.on('pageerror', e => {
    sink('pageerror', String(e))
    errors.push('pageerror: ' + String(e).slice(0, 200))
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
    route.fulfill(json({ result: aiSettings() })))
  await page.route('**/api/custom_ai_config', route =>
    route.fulfill(json({ result: JSON.stringify({ source: env ? 'env' : 'file', baseUrl, model, hasKey }) })))
  await page.route('**/api/list_api_keys', route =>
    route.fulfill(json({ result: JSON.stringify([]) })))
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

/** CI summary: write results file, print pass/fail, print server-log tail on failure.
 *
 * Pass the `attachLogging` handle as `logging` to have the browser-console gate
 * counted and printed like any other assertion — the only way a suite can go red
 * for a console error is by naming it in the results file and stdout. */
export function summary(name, results, { serverLog, logging } = {}) {
  ensureArtifacts()
  if (logging) {
    results.push([
      logging.errors.length ? 'FAIL' : 'PASS',
      'no unexpected browser errors',
      logging.errors.slice(0, 2).join(' | '),
    ])
  }
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
