/**
 * Shared e2e helpers — CI-friendly. Two artifacts matter:
 *   - a FAILING run writes screenshots, a passing run writes no images at all:
 *     artifacts/<name>.fail-NN-<check>.png for each failed assertion (the page as
 *     it was at that moment), or <name>.fail-01-final.png when the run failed some
 *     other way (an exception, the suite deadline, a console error)
 *   - artifacts/<name>.server.log / .browser.log keep the text evidence a
 *     screenshot cannot carry (a Rust 500, a refused request, an engine warning)
 *   - pass/fail lines -> artifacts/<name>.results.txt, and the failing run prints
 *     the tail of the server log to stdout
 *
 * Before writing a suite that changes the viewport: `page.setViewportSize()` lies.
 * It can report success (`page.viewportSize()` reads back the new size) while the
 * renderer keeps the old layout viewport — measured: repeated calls at the same
 * width left `innerWidth` at 1280px until a call with a DIFFERENT width was made.
 * Verify the media query (or `innerWidth`) actually flipped before asserting.
 */
import { execSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

export const PORTS = {
  webSmoke: 4273,
  aiDebug: 4275,
  aiMention: 4290,
  unloadSave: 4292,
}

const ARTIFACTS = 'test/artifacts'

/**
 * Failure evidence as screenshots only: no GIF, no video, and nothing at all for
 * a passing run. A failing assertion screenshots the page as it was at that
 * moment (artifacts/<name>.fail-NN-<check>.png); a run that failed without a
 * failing assertion — an exception, the suite deadline, a console error — gets
 * one of its final state (artifacts/<name>.fail-01-final.png).
 */
function failureShots(page, name) {
  /* A suite that falls over takes every later check with it; a handful of
     screenshots shows why, dozens only bury it. */
  const MAX_SHOTS = 10
  let count = 0
  let queue = Promise.resolve()
  const shoot = label => {
    if (count >= MAX_SHOTS) return
    count++
    mkdirSync(ARTIFACTS, { recursive: true })
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'check'
    const file = `${ARTIFACTS}/${name}.fail-${String(count).padStart(2, '0')}-${slug}.png`
    /* Queued, never awaited by the assertion: `ok()` stays synchronous. */
    queue = queue.then(() => page.screenshot({ path: file }).catch(() => {}))
  }
  return {
    /** Every assertion calls this; only a failing one takes a screenshot. */
    capture(label, passed) {
      if (!passed) shoot(label)
    },
    /** After the run: a failure no assertion captured still gets its screenshot. */
    async finish(failed) {
      if (failed && count === 0) shoot('final')
      await queue
    },
  }
}

/** Evidence from an earlier run of this suite — including the GIFs and frame
 *  folders older versions wrote — must not pass for this run's. */
function clearShots(name) {
  try {
    for (const entry of readdirSync(ARTIFACTS)) {
      if (entry.startsWith(`${name}.fail-`) || entry === `${name}.gif` || entry === `${name}.frames`) {
        rmSync(`${ARTIFACTS}/${entry}`, { recursive: true, force: true })
      }
    }
  } catch {
    // No artifacts folder yet.
  }
}

/** JSON response in the IPC bridge's `{ result }` envelope. */
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

/** Open the seeded `notes.md` from the tree and wait for its text to render —
 *  every suite that boots the server seeds that file before boot. */
export async function openNote(page, text = 'hello world') {
  const entry = page.getByText('notes', { exact: true }).first()
  await entry.waitFor({ timeout: 15000 })
  await entry.click()
  await page.getByText(text, { exact: true }).waitFor({ timeout: 15000 })
}

/** Click into the block showing exactly `text` and put the caret at its end.
 *
 *  No key does this on every CI platform: on macOS `End` scrolls instead of
 *  moving the caret in WebKit, and `Meta+ArrowRight` leaves it in place in
 *  Chromium. The caret is set through the DOM selection instead, which
 *  ProseMirror adopts on `selectionchange`; one frame lets it do so before the
 *  next key arrives. */
export async function caretToEnd(page, text) {
  const block = page.getByText(text, { exact: true })
  await block.click()
  await block.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
 *   context   extra browser-context options (e.g. `hasTouch`/`isMobile` for a
 *             phone's input, which is what makes `(pointer: coarse)` match)
 *   dataDir   reset before boot (default /tmp/docubook-e2e-<name>)
 *   vaultPath default <dataDir>/vaults/myva
 *   seed      [{ path, content }] written into the vault before boot
 *   allow     console errors the suite provokes on purpose (see attachLogging)
 *   setup     async (ctx) => {} — route mocks / init scripts, before the body
 *   deadlineMs  hard limit for the whole suite (default 180 s, or the
 *             E2E_SUITE_DEADLINE_MS env). A suite that has not finished by then
 *             fails with the last check it passed, screenshots the stuck page,
 *             keeps its logs,
 *             and the process exits — it is never left waiting on a promise
 *             that cannot settle.
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
    context = {},
    dataDir = `/tmp/docubook-e2e-${name}`,
    vaultPath = `${dataDir}/vaults/myva`,
    admin = { email: `${name}@test.dev`, password: 'Password1!' },
    seed = [],
    setup,
    allow = [],
    deadlineMs = Number(process.env.E2E_SUITE_DEADLINE_MS) || 180_000,
  } = opts
  const base = `http://localhost:${port}`
  const results = []
  let shots
  const ok = (label, condition, extra = '') => {
    results.push([condition ? 'PASS' : 'FAIL', label, extra])
    if (!condition) process.exitCode = 1
    shots?.capture(label, condition)
  }

  ensureArtifacts()
  clearShots(name)
  killPort(port)
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(vaultPath, { recursive: true })
  for (const file of seed) {
    const path = `${vaultPath}/${file.path}`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }

  /* The suite's own setup token, so bootstrapping the admin over the API is
     allowed without reading the boot token from the server log. */
  const setupToken = server.env?.DB_SETUP_TOKEN ?? 'e2e-setup-token'
  /* One server per suite, restarted in place by ctx.restart(). */
  const spawnServer = () => (server === 'preview'
    ? startServer(name, { cmd: 'npx', args: ['vite', 'preview', '--port', String(port), '--strictPort'], shell: true, port, dataDir, wwwDir: 'dist' })
    : startServer(name, { binary: server.binary, port, dataDir, wwwDir: 'dist', env: { DB_SETUP_TOKEN: setupToken, ...server.env } }))
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

  /* Playwright bounds its own actions, but not a promise the suite awaits itself
     (a held request that is never sent, a hook that never fires): without a
     deadline such a suite waits until the CI job is killed, hours later. */
  let deadlineTimer
  let timedOut = false
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      timedOut = true
      const last = [...results].reverse().find(([status]) => status === 'PASS')
      reject(new Error(`suite did not finish within ${Math.round(deadlineMs / 1000)}s — last passing check: ${last ? `"${last[1]}"` : 'none'}`))
    }, deadlineMs)
  })
  const run = async () => {
    await waitForServer(base)
    browser = await launchBrowser()
    ctx.context = await browser.newContext({ viewport, ...context })
    if (session) {
      const created = await api('setup_admin', { ...admin, token: setupToken })
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
    shots = failureShots(page, name)
    if (setup) await setup(ctx)
    await body(ctx)
  }

  try {
    const work = run()
    // The loser must not become an unhandled rejection.
    work.catch(() => {})
    await Promise.race([work, deadline])
  } catch (error) {
    results.push(['FAIL', 'setup/run', error instanceof Error ? error.stack || error.message : String(error)])
    process.exitCode = 1
    // What the stuck page looked like is the evidence for why it stuck.
    if (timedOut) shots?.capture('suite deadline', false)
  } finally {
    clearTimeout(deadlineTimer)
  }

  /* Cleanup is bounded too: a hung page or browser must not be able to keep a
     failed suite from reporting. */
  const bounded = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, ms))])
  /* A screenshot needs a live page: take it before the browser goes away. */
  const failed = results.some(([status]) => status === 'FAIL') || (logging?.errors.length ?? 0) > 0
  if (shots) await bounded(shots.finish(failed), 20_000)
  if (browser) await bounded(browser.close().catch(() => {}), 10_000)
  running.bin.kill()

  if (!summary(name, results, { serverLog: running.logPath, logging })) process.exitCode = 1
  // A suite that timed out still has a body awaiting something forever; exit
  // rather than wait for an event loop that those promises do not hold open.
  if (timedOut) process.exit(1)
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
    /* What a tool probe of an unmeasured model answers. The transport measures
       an unmeasured model before its first request, so the mock answers it the
       way the scenario's model behaves (text-only by default). */
    probeAnswer = false,
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
  await page.route('**/api/test_connection', route =>
    route.fulfill(json({ result: JSON.stringify({ status: 'ok', tools: probeAnswer }) })))
  await page.route('**/api/set_probe', route => {
    const { model: probed, tools } = route.request().postDataJSON()
    state.probes[probed] = tools
    return route.fulfill(json({ result: 'null' }))
  })
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
  }).join('\n') + '\n'
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
