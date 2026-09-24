/**
 * Trash UI e2e (web/Docker) — server-side trash contract:
 *   1. Trash tab is DISABLED while `.trash/` is empty (web has no native trash).
 *   2. With `.trash/` content → tab enabled and selectable.
 *   3. Restore from the panel → file back in the tree, tab disabled again.
 *   4. Delete from the panel → in-app confirmation gates it, cancel is a no-op,
 *      confirm permanently deletes the item.
 *   5. A permission failure offers the System Settings pane, not a dead toast.
 *
 * Note: the Linux-only delete→`.trash/` move is covered by the cfg(target_os
 * = "linux") Rust unit test. On macOS dev the delete path goes to the system
 * Trash, so this e2e seeds `.trash/` directly — the UI contract (list/restore/
 * empty state) is platform-independent.
 *
 * Logs: test/artifacts/trash.{server,browser}.log
 * Run: npm run build && node test/trash.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'

import { runSuite, PORTS } from './lib.mjs'

await runSuite('trash', {
  port: PORTS.trash,
  /* The suite injects TRASH_PERMISSION itself (section 5 asserts the dialog it
     raises), so that console error is declared, not ignored. */
  allow: [/TRASH_PERMISSION/],
}, async ({ page, ok, base, vaultPath }) => {
  // Seed persisted vault so resumeVault auto-opens it on boot
  await page.addInitScript((path) => {
    localStorage.setItem('docubook:vault', JSON.stringify({ state: { vaultPath: path }, version: 0 }))
  }, vaultPath)
  const initialTrash = page.waitForResponse(r => r.url().endsWith('/api/list_trash') && r.ok())
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="desktop-sidebar"]', { timeout: 10000 })
  await initialTrash
  ok('vault open: empty vault shown', true)

  // Responsive sidebar journey: desktop inline/collapsible, mobile Mantine Drawer.
  const sidebarToggle = page.getByTestId('sidebar-toggle')
  ok('sidebar desktop: inline by default', await page.getByTestId('desktop-sidebar').isVisible())
  await sidebarToggle.click()
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'detached' })
  ok('sidebar desktop: collapses inline', await sidebarToggle.getAttribute('aria-expanded') === 'false')

  await page.setViewportSize({ width: 639, height: 800 })
  ok('sidebar mobile: starts closed', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await sidebarToggle.click()
  const mobileSidebar = page.getByTestId('mobile-sidebar')
  await mobileSidebar.waitFor({ state: 'visible' })
  const drawerClose = page.getByTestId('mobile-sidebar-drawer').getByRole('button', { name: 'Close sidebar drawer' })
  await drawerClose.waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Close sidebar drawer')
  await page.waitForFunction(() => Math.abs(document.querySelector('.mobile-sidebar-drawer-content')?.getBoundingClientRect().x ?? -1) < 0.5)
  const drawerBox = await page.locator('.mobile-sidebar-drawer-content').boundingBox()
  const closeBox = await drawerClose.boundingBox()
  ok('sidebar mobile: close control sits outside Drawer', !!drawerBox && !!closeBox && closeBox.x >= drawerBox.x + drawerBox.width)
  ok('sidebar mobile: Drawer traps initial focus', await drawerClose.evaluate(el => document.activeElement === el))
  ok('sidebar mobile: locks body scroll', await page.locator('body').getAttribute('data-scroll-locked') !== null)

  const vaultSwitcher = mobileSidebar.getByRole('button', { name: 'Switch vault' })
  const createButton = mobileSidebar.getByRole('button', { name: 'Create file or folder' })
  const settingsButton = mobileSidebar.getByRole('button', { name: 'Open settings' })
  const [vaultBox, createBox, settingsBox] = await Promise.all([vaultSwitcher.boundingBox(), createButton.boundingBox(), settingsButton.boundingBox()])
  ok('sidebar mobile: controls ordered vault, create, settings', !!vaultBox && !!createBox && !!settingsBox && vaultBox.x < createBox.x && createBox.x < settingsBox.x)
  await vaultSwitcher.click()
  const vaultMenuBox = await mobileSidebar.locator('[data-vault-menu]').boundingBox()
  ok('sidebar mobile: vault menu opens upward inside Drawer', !!drawerBox && !!vaultBox && !!vaultMenuBox && vaultMenuBox.y + vaultMenuBox.height <= vaultBox.y && vaultMenuBox.x >= drawerBox.x && vaultMenuBox.x + vaultMenuBox.width <= drawerBox.x + drawerBox.width, JSON.stringify({ drawerBox, vaultBox, vaultMenuBox }))
  await vaultSwitcher.click()

  await page.keyboard.press('Escape')
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'sidebar-toggle')
  ok('sidebar mobile: Escape closes and restores focus', await sidebarToggle.evaluate(el => document.activeElement === el))

  await sidebarToggle.click()
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'visible' })
  await page.locator('.mobile-sidebar-drawer-overlay').click({ position: { x: 500, y: 400 } })
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  ok('sidebar mobile: backdrop closes Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')

  await sidebarToggle.click()
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'visible' })
  await page.getByTestId('sidebar-settings').click()
  await page.getByTestId('settings-modal').waitFor({ state: 'visible' })
  await page.getByTestId('mobile-sidebar').waitFor({ state: 'detached' })
  ok('sidebar mobile: competing modal excludes Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await page.getByTestId('settings-modal').click({ position: { x: 5, y: 5 } })
  await page.getByTestId('settings-modal').waitFor({ state: 'detached' })

  await page.setViewportSize({ width: 640, height: 800 })
  ok('sidebar boundary: desktop collapse preference restored', await page.getByTestId('desktop-sidebar').count() === 0)
  await sidebarToggle.click()
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 639, height: 800 })
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'detached' })
  ok('sidebar boundary: resize to mobile never force-opens Drawer', await sidebarToggle.getAttribute('aria-expanded') === 'false')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible' })

  // 1. Empty trash → Trash tab disabled (web: no native trash, count 0)
  const trashTab = page.getByTestId('trash-toggle')
  ok('trash tab: disabled when empty', await trashTab.isDisabled(), '')
  ok('trash tab: not selected while the vault panel is active', await trashTab.getAttribute('aria-selected') === 'false')

  // 2. Seed the server-side trash → reload → tab enabled
  mkdirSync(`${vaultPath}/.trash`, { recursive: true })
  writeFileSync(`${vaultPath}/.trash/1700000000000-notes.md`, '# Notes\n\ncontent')
  const refreshedTrash = page.waitForResponse(r => r.url().endsWith('/api/list_trash') && r.ok())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await refreshedTrash
  await page.waitForSelector('text=Empty vault', { timeout: 10000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="trash-toggle"]')?.disabled)
  ok('trash tab: enabled when trash has files', await trashTab.isEnabled(), '')

  // 3. Open the panel → tab selected, then exercise delete and restore.
  await trashTab.click()
  ok('trash tab: selected after opening the panel', await trashTab.getAttribute('aria-selected') === 'true')
  const trashPanel = page.locator('section[aria-label="Trash"]')
  await trashPanel.getByText('Trash (1)').waitFor({ timeout: 5000 })

  // 4. Delete → in-app confirmation gates it; cancel is a no-op, confirm deletes.
  writeFileSync(`${vaultPath}/.trash/1700000004000-doomed.md`, '# Doomed\n')
  const reseededTrash = page.waitForResponse(r => r.url().endsWith('/api/list_trash') && r.ok())
  await trashTab.click()
  await reseededTrash
  const deleteCheckbox = trashPanel.getByRole('checkbox', { name: 'Select doomed.md' })
  await deleteCheckbox.check()
  await trashPanel.getByRole('button', { name: 'Delete' }).click()
  const dialog = trashPanel.getByRole('alertdialog', { name: 'Delete permanently' })
  await dialog.waitFor({ timeout: 5000 })
  ok('delete: confirmation names the item', (await dialog.textContent())?.includes('doomed.md') === true)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached' })
  ok('delete: cancel leaves the item in the panel', await deleteCheckbox.count() === 1)

  const deleteResponse = page.waitForResponse(r => r.url().endsWith('/api/delete_trash_item') && r.ok())
  await trashPanel.getByRole('button', { name: 'Delete' }).click()
  await dialog.waitFor({ timeout: 5000 })
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await deleteResponse
  // The row leaves when the parent's `loadTrash` state update lands — after the
  // network response, not with it. Sampling `count()` straight away races that
  // render and fails on slower CI chromium, so wait for the row to detach.
  await deleteCheckbox.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  ok('delete: confirmed item is gone from the panel', await deleteCheckbox.count() === 0)

  // 5. A permission failure must offer the System Settings pane, not a dead toast.
  //    The web server has no macOS privacy gate, so stub the command to fail the
  //    way the desktop backend does and assert the dialog (not a toast) appears.
  await page.route('**/api/restore_file', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'TRASH_PERMISSION:accessibility' }),
  }))
  writeFileSync(`${vaultPath}/.trash/1700000005000-locked.md`, '# Locked\n')
  await trashTab.click()
  await trashPanel.getByText('locked.md', { exact: true }).waitFor({ timeout: 5000 })
  await trashPanel.getByRole('checkbox', { name: 'Select locked.md' }).check()
  await trashPanel.getByRole('button', { name: 'Put back' }).click()
  const permissionDialog = page.getByRole('alertdialog', { name: 'Permission required' })
  await permissionDialog.waitFor({ timeout: 5000 })
  ok('permission: dialog replaces the toast', await permissionDialog.textContent().then(t => t?.includes('Accessibility') === true))
  await permissionDialog.getByRole('button', { name: 'Open System Settings' }).waitFor()
  await permissionDialog.getByRole('button', { name: 'Not now' }).click()
  await permissionDialog.waitFor({ state: 'detached' })
  await page.unroute('**/api/restore_file')

  // 6. Restore → file back in the tree, tab disabled again
  const restoreCheckbox = trashPanel.getByRole('checkbox', { name: 'Select notes.md' })
  await restoreCheckbox.check()
  const restoreResponse = page.waitForResponse(r => r.url().endsWith('/api/restore_file') && r.ok())
  await trashPanel.getByRole('button', { name: 'Put back' }).click()
  await restoreResponse
  await page.waitForFunction(() => document.querySelector('[data-testid="trash-toggle"]')?.disabled)
  ok('trash tab: disabled again after restore', await trashTab.isDisabled(), '')
  ok('restore: row removed from the panel', await restoreCheckbox.count() === 0)
  await page.getByTestId('sidebar-panel-vault').click()
  await page.getByText('notes', { exact: true }).waitFor({ timeout: 5000 })
  ok('restore: notes.md back in the tree', await page.getByText('notes', { exact: true }).count() >= 1)
})
