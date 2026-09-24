/**
 * @mention retrieval e2e (web runtime).
 *
 * Reproduces the reported failure: typing `@change` in the composer must
 * surface the vault's CHANGELOG.md, and sending must ship that file's content
 * to the model as framed (untrusted) vault context — exactly once, and never
 * for a prompt that carries no mention. /api/ask_ai is mocked (we assert on the
 * request it receives); /api/resolve_mentions is NOT mocked, so the real server
 * resolver and its IPC route are exercised.
 *
 * Run: npm run build && node test/ai-mention.mjs
 */
import { runSuite, mockAiSettings, mockAskAi, openNote, PORTS } from './lib.mjs'

/* Both are produced by the mocks in `setup` and read by the body. */
let askAiBodies
let resolveHits

await runSuite('ai-mention', {
  port: PORTS.aiMention,
  viewport: { width: 1280, height: 900 },
  seed: [
    { path: 'notes.md', content: '# _Notes_\n\nhello world' },
    { path: 'CHANGELOG.md', content: '# Changelog\n\nCHANGELOG BODY\n' },
    { path: 'docs/guide.md', content: 'guide body' },
    { path: 'docs/CHANGELOG-old.md', content: 'old body' },
  ],
  setup: async ({ page, vaultPath }) => {
    askAiBodies = []
    resolveHits = 0

    // Not intercepted beyond counting: the real server resolver must answer.
    await page.route('**/api/resolve_mentions', route => { resolveHits++; return route.continue() })

    await mockAskAi(page, (request) => {
      askAiBodies.push(request)
      return [
        ['ai:token', { token: 'Rewritten paragraph.' }],
        ['ai:tools_done', {}],
        ['ai:done', { provider: 'mock', truncated: false }],
      ]
    })

    await mockAiSettings(page)
    await page.addInitScript((path) => {
      if (!localStorage.getItem('docubook:vault')) {
        localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
      }
    }, vaultPath)
  },
}, async ({ page, ok, base }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await openNote(page)

  const prompt = page.locator('textarea[aria-label="AI prompt"]')
  await prompt.click()

  // --- partial mention typing surfaces the vault file -----------------------
  await page.keyboard.type('summarise @change', { delay: 25 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })
  const optionText = await page.locator('[role="listbox"]').innerText()
  ok('typing @change suggests CHANGELOG.md from the vault', optionText.includes('CHANGELOG.md'), optionText.replace(/\n/g, ' | '))

  // --- folders stay selectable, so a folder mention can recurse -------------
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('summarise @doc', { delay: 25 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })
  const folderOption = await page.locator('[role="listbox"]').innerText()
  ok('folder row is offered', folderOption.includes('docs'), folderOption.replace(/\n/g, ' | '))

  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('summarise @change', { delay: 25 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })

  // --- a pointer pick completes (touch devices have no Tab) -----------------
  // Regression: the dropdown renders above `.editor-ai-floating`, so an
  // `overflow-x: hidden` on that box clipped it and every row became
  // unclickable — only Tab/Enter worked. Assert the row is the hit target.
  const option = page.locator('[role="listbox"] [role="option"]').first()
  await option.click()
  const picked = await prompt.inputValue()
  ok('clicking a suggestion completes the mention without Tab/Enter', picked === 'summarise @CHANGELOG.md ', JSON.stringify(picked))
  ok('the picker closes after a pointer pick', (await page.locator('[role="listbox"]').count()) === 0)

  // --- the picked tag is painted as a token, not as more prompt prose --------
  // Asserted against the composer's own text colour instead of a palette value,
  // so a theme swap cannot silently make the tag blend back into the prompt.
  const styleOf = (loc) => loc.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }))
  const tag = page.locator('button[aria-label="Remove @CHANGELOG.md"]').locator('xpath=..')
  const tagStyle = await styleOf(tag)
  const promptStyle = await styleOf(prompt)
  ok('the mention tag carries a tinted background', tagStyle.bg !== 'rgba(0, 0, 0, 0)' && tagStyle.bg !== 'transparent', tagStyle.bg)
  ok('the mention tag does not share the prompt text colour', tagStyle.fg !== promptStyle.fg, `${tagStyle.fg} vs ${promptStyle.fg}`)

  await page.keyboard.press('Meta+a')
  await page.keyboard.type('summarise @change', { delay: 25 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })

  // --- the armed row is visible, and ArrowDown moves the highlight ----------
  // Regression: rows carried only a hover tint, so ArrowDown changed the
  // selection with no visual change and Enter committed a blind pick.
  await page.mouse.move(0, 0) // keep a stray hover off the rows
  const rows = page.locator('[role="listbox"] [role="option"]')
  const bgOf = (i) => rows.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor)
  const armed = await bgOf(0)
  const idle = await bgOf(1)
  ok('the row Enter would commit is painted, not merely hoverable', armed !== idle && armed !== 'rgba(0, 0, 0, 0)', `${armed} vs ${idle}`)

  // --- assistive tech is told which row is armed ---------------------------
  // `aria-activedescendant` belongs on the composer: it is the element holding
  // DOM focus, so the same attribute on the listbox announces nothing.
  const controls = await prompt.getAttribute('aria-controls')
  const listboxId = await page.locator('[role="listbox"]').getAttribute('id')
  ok('the focused composer points at the open listbox', (await prompt.getAttribute('aria-expanded')) === 'true' && controls !== null && controls === listboxId, `controls=${controls} listbox=${listboxId}`)
  const namedBefore = await prompt.getAttribute('aria-activedescendant')
  ok('the composer names the armed row', namedBefore !== null && (await page.locator('#' + namedBefore).getAttribute('aria-selected')) === 'true', String(namedBefore))

  await page.keyboard.press('ArrowDown')
  ok('ArrowDown moves the highlight to the next row', (await bgOf(1)) === armed && (await bgOf(0)) === idle, 'highlight stayed put')
  const namedAfter = await prompt.getAttribute('aria-activedescendant')
  ok('the composer renames the row after ArrowDown', namedAfter !== null && namedAfter !== namedBefore && (await page.locator('#' + namedAfter).getAttribute('aria-selected')) === 'true', `${namedBefore} -> ${namedAfter}`)

  await page.keyboard.press('Enter')
  const moved = await prompt.inputValue()
  ok('Enter commits the highlighted row, not the first row', moved === 'summarise @docs/CHANGELOG-old.md ', JSON.stringify(moved))

  await page.keyboard.press('Meta+a')
  await page.keyboard.type('summarise @change', { delay: 25 })
  await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })
  await page.keyboard.press('Enter')
  const inserted = await prompt.inputValue()
  ok('Enter inserts the full vault path, not the partial query', inserted === 'summarise @CHANGELOG.md ', JSON.stringify(inserted))

  // --- sending ships the file content as framed context ---------------------
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {})
  for (let i = 0; i < 60 && askAiBodies.length === 0; i++) await page.waitForTimeout(100)

  const first = String(askAiBodies[0]?.messages ?? '')
  ok('the request goes out at all', askAiBodies.length > 0)
  ok('resolve_mentions was called on the real server', resolveHits === 1, `hits=${resolveHits}`)
  ok('mention content is injected as vault context', first.includes('<vault_context>') && first.includes('CHANGELOG BODY'))
  ok('vault content is framed as untrusted data', first.includes('untrusted reference data'))
  const vaultBlocks = first.split('<vault_context>').length - 1
  ok('vault context is injected exactly once (no double injection)', vaultBlocks === 1, `occurrences=${vaultBlocks}`)

  // --- a prompt with no mention adds no retrieval work ----------------------
  const revert = page.getByText('Revert', { exact: true })
  if (await revert.isVisible().catch(() => false)) await revert.click()
  await prompt.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('plain question with no mention', { delay: 15 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 60 && askAiBodies.length < 2; i++) await page.waitForTimeout(100)

  const second = String(askAiBodies[1]?.messages ?? '')
  ok('a second (mention-free) request was sent', askAiBodies.length === 2, `bodies=${askAiBodies.length}`)
  ok('no vault context for a mention-free prompt', !second.includes('<vault_context>'))
  ok('no extra resolve_mentions call for a mention-free prompt', resolveHits === 1, `hits=${resolveHits}`)
})
