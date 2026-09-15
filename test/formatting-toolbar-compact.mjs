/**
 * Compact (<640px, Docker web) formatting toolbar e2e — proves the marks that
 * cannot fit a phone row (alignment, indent) stay reachable in a panel.
 *
 * Why a real browser: the failure mode is geometric. The bubble menu is a nowrap
 * row measured by floating-ui, so asserting on the React tree or on `innerText`
 * would pass while the tail buttons sit unreachable past the viewport edge.
 * Every check below reads `getBoundingClientRect()`, and the viewport itself is
 * what selects the compact branch.
 *
 * Harness: serves `dist/` through `vite preview` (same as test/theme-check.mjs)
 * and answers the `/api/<cmd>` bridge with fixtures, so the suite drives the
 * real editor with no vault, no server state and no DB.
 *
 * Coverage: the grouped marks move behind the trigger, the row and panel stay on
 * screen (and the panel flips near the top edge), a mark taken from the panel
 * actually applies to the selection, the panel carries exactly the marks the
 * flat row loses, and wide web keeps the flat row (desktop/native parity).
 *
 * The panel holds alignment and indent only (5 controls); the inline marks
 * (bold, italic, underline, strikethrough, code, highlight, colour) stay on the
 * compact row, so they are never a second tap away.
 *
 * Run: npm run build && node test/formatting-toolbar-compact.mjs
 *      BROWSER=webkit node test/formatting-toolbar-compact.mjs
 *
 * Logs: test/artifacts/formatting-toolbar-compact.{server,browser}.log
 */
import { mkdirSync } from 'node:fs'

import { startServer, waitForServer, attachLogging, summary, launchBrowser } from './lib.mjs'

mkdirSync('test/artifacts', { recursive: true })

const PORT = 4179
const BASE = `http://localhost:${PORT}`
const PHONE = { width: 390, height: 720 }
const WIDE = { width: 1280, height: 800 }
const NOTE = 'alpha bravo charlie delta'

/** Fixture responses for the web IPC bridge (`POST /api/<cmd>`).
 *  Two response shapes: `read_file` is the raw file text (the editor
 *  regex-matches the frontmatter out of it), everything else a JSON string. */
const NOTE_TEXT = `# Notes\n\n${NOTE}\n`
const API = {
  setup_admin: { email: 'formatting@example.test' },
  setup_status: { setupRequired: false, setupToken: false },
  account_get: { email: 'formatting@example.test' },
  list_tree: [{ path: 'notes.md', name: 'notes.md', type: 'file' }],
  read_file: NOTE_TEXT,
  open_vault: { name: 'demo' },
  git_status: { status: '', isRepo: false, hasRemote: false, ahead: 0, upstream: '', repoState: 'clean' },
  list_trash: [],
  get_backlinks: [],
  wiki_backlinks: [],
}
/** Commands whose `result` is passed through verbatim instead of JSON-encoded. */
const RAW_RESULT = new Set(['read_file'])

const results = []
const ok = (name, cond, extra = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, extra])
  if (!cond) process.exitCode = 1
}

const server = startServer('formatting-toolbar-compact', {
  cmd: 'npx', args: ['vite', 'preview', '--port', String(PORT), '--strictPort'], shell: true,
  port: PORT, dataDir: '/tmp/docubook-e2e-formatting', wwwDir: 'dist',
})
let browser
let page

/** Serve fixtures for every bridge call the editor makes while booting. */
async function stubBackend(page) {
  await page.route('**/api/**', async (route) => {
    const cmd = route.request().url().split('/api/')[1]?.split('?')[0] || ''
    const result = Object.prototype.hasOwnProperty.call(API, cmd) ? API[cmd] : {}
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ result: RAW_RESULT.has(cmd) ? result : JSON.stringify(result) }),
    })
  })
}

/** Select a phrase in the open note, then wait for the bubble menu. */
async function selectPhrase(page, phrase) {
  await page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.querySelector('.bn-editor') || document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const at = (node.textContent || '').indexOf(needle)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`phrase not found: ${needle}`)
  }, phrase)
  await page.locator('.bn-formatting-toolbar').waitFor({ timeout: 8000 })
  await page.waitForTimeout(250)
}

/** Select a phrase inside the Nth rendered block, then wait for the bubble menu.
 *  Block 0 is the document's first line, where the trigger sits closest to the
 *  top edge of the window. */
async function selectInBlock(page, blockIndex, phrase) {
  await page.evaluate(({ index, needle }) => {
    const blocks = Array.from(document.querySelectorAll('.bn-editor .bn-block-content'))
    const target = blocks[index]
    if (!target) throw new Error(`no block ${index} of ${blocks.length}`)
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const at = (node.textContent || '').indexOf(needle)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`phrase not found: ${needle}`)
  }, { index: blockIndex, needle: phrase })
  await page.locator('.bn-formatting-toolbar').waitFor({ timeout: 8000 })
  await page.waitForTimeout(350)
}

/** Which side the panel opened on, and its geometry relative to its trigger. */
function panelPlacement(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="formatting-toolbar-more-panel"]')
    if (!panel) return null
    const dropdown = panel.closest('.mantine-Popover-dropdown')
    const trigger = document.querySelector('button[aria-label="More formatting"]')
    const panelRect = panel.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    return {
      side: dropdown?.getAttribute('data-position'),
      panelTop: panelRect.top,
      panelBottom: panelRect.bottom,
      triggerTop: triggerRect.top,
      triggerBottom: triggerRect.bottom,
      viewportHeight: window.innerHeight,
      spaceAbove: triggerRect.top,
    }
  })
}

/** In-viewport geometry for the toolbar and its direct buttons. */
function toolbarGeometry(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector('.bn-formatting-toolbar')
    if (!toolbar) return null
    const rect = toolbar.getBoundingClientRect()
    return {
      viewport: window.innerWidth,
      rowLeft: rect.left,
      rowRight: rect.right,
      buttons: Array.from(toolbar.querySelectorAll('button')).map(button => {
        const box = button.getBoundingClientRect()
        return {
          label: button.getAttribute('aria-label') || button.textContent?.trim() || '',
          left: box.left,
          right: box.right,
          width: box.width,
        }
      }),
    }
  })
}

const moreTrigger = () => page.locator('button[aria-label="More formatting"]')
const morePanel = () => page.locator('[data-testid="formatting-toolbar-more-panel"]')

try {
  await waitForServer(BASE, 50)
  browser = await launchBrowser()
  page = await browser.newPage({ viewport: PHONE })
  attachLogging(page, 'formatting-toolbar-compact')
  await stubBackend(page)
  /* Seed the persisted vault so `resumeVault` on zustand rehydrate opens it,
     and skip the onboarding guide so the fixture note renders. */
  await page.addInitScript(() => {
    localStorage.setItem('docubook:vault', JSON.stringify({
      state: { vaultPath: '/demo', expanded: {}, recent: [{ path: '/demo', name: 'demo', parent: '/' }] },
      version: 0,
    }))
    localStorage.setItem('docubook-onboarding-done', 'true')
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  /* At phone width the sidebar is a drawer, and the tree strips the .md
     extension, hence the plain `notes` label. */
  await page.locator('[data-testid="sidebar-toggle"]').click()
  const noteEntry = page.getByText('notes', { exact: true }).first()
  await noteEntry.waitFor({ timeout: 15000 })
  await noteEntry.click()
  await page.waitForTimeout(3000)
  await page.waitForSelector(`text=${NOTE}`, { timeout: 15000 })
  await page.getByText('notes.md', { exact: true }).first().waitFor({ timeout: 15000 })
  await page.getByText('notes.md', { exact: true }).first().click()
  await page.waitForSelector(`text=${NOTE}`, { timeout: 15000 })

  // ── 1. Compact layout: no button is left outside the viewport ──
  await selectPhrase(page, 'bravo')
  const compact = await toolbarGeometry(page)
  ok('compact: bubble menu is visible', !!compact)
  ok('compact: overflow trigger is rendered', await moreTrigger().count() === 1)
  ok('compact: trigger sits inside the viewport', await moreTrigger().evaluate(button => {
    const box = button.getBoundingClientRect()
    return box.left >= -1 && box.right <= window.innerWidth + 1
  }))
  // The regression this feature fixes: the row used to run past the viewport
  // edge, leaving the trailing buttons unreachable on a 390px screen.
  ok('compact: row stays inside the viewport',
    compact.rowLeft >= -1 && compact.rowRight <= compact.viewport + 1,
    `left=${Math.round(compact.rowLeft)} right=${Math.round(compact.rowRight)} viewport=${compact.viewport}`)
  const offscreen = compact.buttons.filter(b => b.width === 0 || b.left < -1 || b.right > compact.viewport + 1)
  ok('compact: every visible row button is fully on screen', offscreen.length === 0,
    offscreen.map(b => `${b.label}@${Math.round(b.left)}..${Math.round(b.right)}`).join(', '))

  // ── 2. The panel opens fully on screen, on the side with room ──
  await moreTrigger().click()
  await morePanel().waitFor({ timeout: 3000 })
  const box = await morePanel().boundingBox()
  ok('compact: overflow panel has size', !!box && box.width > 0 && box.height > 0, JSON.stringify(box))
  /* `boundingBox()` gives {x, y, width, height}, not the DOM rect's edges. */
  ok('compact: overflow panel is fully in the viewport',
    box.x >= -1 && box.y >= -1 && box.x + box.width <= PHONE.width + 1 && box.y + box.height <= PHONE.height + 1,
    `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`)
  /* Panel must sit above the trigger so it never covers the selection. */
  const triggerBox = await moreTrigger().boundingBox()
  ok('compact: overflow panel sits above the trigger', box.y + box.height <= triggerBox.y + 1,
    `panelBottom=${Math.round(box.y + box.height)} triggerTop=${Math.round(triggerBox.y)}`)
  /* Which marks the panel took over is read from the panel's own buttons, so
     the checks below hold for all five grouped controls without pinning
     upstream tooltip wording. */
  const panelLabels = await morePanel().locator('button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label') || ''))
  ok('compact: overflow panel carries the grouped marks', panelLabels.length === 5,
    `buttons=${panelLabels.length}`)
  ok('compact: every grouped mark is labelled', panelLabels.every(Boolean), panelLabels.join(', '))
  ok('compact: grouped marks are distinct', new Set(panelLabels).size === panelLabels.length,
    panelLabels.join(', '))
  for (const label of panelLabels) {
    ok(`compact: row drops "${label}" into the panel`,
      !compact.buttons.some(button => button.label === label))
  }

  // ── 3. A grouped mark actually applies to the selection ──
  /* Alignment, not an inline mark: the panel holds only the marks the compact
     row drops, and those are block-level. BlockNote writes the non-default
     alignment to the block element as `data-text-alignment`. */
  await morePanel().locator('button[aria-label="Align text center"]').click()
  await page.waitForTimeout(250)
  const centered = await page.evaluate(() =>
    document.querySelectorAll('.bn-editor [data-text-alignment="center"]').length)
  ok('compact: Align text center from the panel applies to the selection', centered > 0, `centered=${centered}`)
  /* The row must keep the inline marks the panel does not take over. */
  ok('compact: underline and strikethrough stay on the compact row',
    ['Underline', 'Strike'].every(label => compact.buttons.some(button => button.label === label)),
    compact.buttons.map(b => b.label).join(', '))

  // ── 4. Escape closes the panel and gives focus back to the trigger ──
  /* The panel unmounts while one of its own buttons holds focus, so without
     the restore focus falls to <body> and the keyboard user is stranded. */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await selectPhrase(page, 'bravo')
  await moreTrigger().click()
  await morePanel().waitFor({ timeout: 3000 })
  await morePanel().locator('button').first().focus()
  ok('compact: a panel button can hold focus',
    await page.evaluate(() => !!document.activeElement?.closest('[data-testid="formatting-toolbar-more-panel"]')))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  ok('compact: Escape closes the panel', await morePanel().count() === 0)
  ok('compact: Escape returns focus to the trigger',
    await moreTrigger().evaluate(button => button === document.activeElement),
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || ''))

  // ── 5. Near the top edge the panel flips instead of leaving the window ──
  /* `position="top"` is a preference: with the trigger close to the top edge
     the flip middleware must move the panel below it. */
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await selectInBlock(page, 0, 'Notes')
  await moreTrigger().click()
  await morePanel().waitFor({ timeout: 3000 })
  await page.waitForTimeout(500)
  const tight = await panelPlacement(page)
  ok('compact: panel flips to the open side when the top edge is close',
    tight.side === 'bottom' || tight.spaceAbove >= tight.panelBottom - tight.panelTop,
    `side=${tight.side} spaceAbove=${Math.round(tight.spaceAbove)} panelH=${Math.round(tight.panelBottom - tight.panelTop)}`)
  ok('compact: panel stays inside the viewport near the top edge',
    tight.panelTop >= -1 && tight.panelBottom <= tight.viewportHeight + 1,
    `top=${Math.round(tight.panelTop)} bottom=${Math.round(tight.panelBottom)} vh=${tight.viewportHeight}`)
  /* Whatever side it lands on, it must not cover the text being formatted. */
  ok('compact: panel does not overlap the trigger',
    tight.panelBottom <= tight.triggerTop + 1 || tight.panelTop >= tight.triggerBottom - 1,
    `panelBottom=${Math.round(tight.panelBottom)} trigger=[${Math.round(tight.triggerTop)}..${Math.round(tight.triggerBottom)}]`)

  // ── 6. Wide web keeps the flat row (desktop Docker unchanged) ──
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.setViewportSize(WIDE)
  await page.waitForTimeout(400)
  await selectPhrase(page, 'charlie')
  const wide = await toolbarGeometry(page)
  ok('wide: bubble menu is visible', !!wide)
  ok('wide: no overflow trigger', await moreTrigger().count() === 0)
  /* Labels are read from the row rather than hardcoded, so this does not pin
     upstream wording. */
  const wideLabels = wide.buttons.map(b => b.label)
  ok('wide: underline and strikethrough stay inline on the row',
    ['Underline', 'Strike'].every(label => wideLabels.includes(label)),
    wideLabels.join(', '))
  /* Same seven controls, both directions: the flat row shows the ones the
     compact panel holds, and the panel holds exactly what the flat row loses. */
  const droppedFromRow = wideLabels.filter(label => !compact.buttons.some(b => b.label === label))
  ok('wide: the grouped marks are back on the flat row',
    panelLabels.every(label => wideLabels.includes(label)),
    `missing=${panelLabels.filter(label => !wideLabels.includes(label)).join(', ')}`)
  ok('compact: panel holds exactly the marks the flat row loses',
    [...panelLabels].sort().join('|') === [...droppedFromRow].sort().join('|'),
    `panel=[${panelLabels.join(', ')}] dropped=[${droppedFromRow.join(', ')}]`)
} catch (e) {
  results.push(['FAIL', 'setup/run', String(e).split('\n')[0]])
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  server.bin.kill()
}

if (!summary('formatting-toolbar-compact', results, { serverLog: server.logPath })) process.exitCode = 1
