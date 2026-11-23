// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { openWorkspace } from './workspace-fixture.ts'

// From the repository root, build the renderer and run:
// node app/tests/interface/desktop/optional-git.integration.ts
const applicationRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'diffpane-optional-git-')))
const folder = path.join(directory, 'folder')
const file = path.join(folder, 'notes.txt')
const errors: string[] = []

async function until(description: string, read: () => Promise<boolean>, remaining = 160): Promise<void> {
  if (!remaining) throw new Error(`Timed out waiting for ${description}.`)
  if (await read()) return
  await delay(125)
  return until(description, read, remaining - 1)
}

async function checkWorkspace(page: Page) {
  const navigator = page.locator('#navigator')
  await navigator.waitFor({ state: 'visible' })
  await page.locator('#workspace-opening').waitFor({ state: 'hidden' })
  await Promise.all(
    ['#git-workspace-toggle', '#review-toggle', '#review-notes-toggle', '#git-workspace'].map(async selector => {
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} stays hidden without Git`)
    }),
  )
  assert.equal(await page.locator('#branch-name').textContent(), '')
  assert.equal(await page.locator('#status-text').textContent(), 'Folder open')

  await navigator.locator('[data-path="notes.txt"]').click()
  const editor = page.locator('.file-card .monaco-editor')
  await editor.waitFor({ state: 'visible' })
  await Promise.all(
    ['.diff-toggle', '.file-next-change'].map(async selector => {
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} stays hidden without Git`)
    }),
  )

  await editor.click({ button: 'right' })
  const menu = page.locator('.monaco-menu-container')
  await menu.waitFor({ state: 'visible' })
  assert.doesNotMatch((await menu.textContent()) ?? '', /Compare with Git|Add review note|Next change|Focus changes/u)
  await page.keyboard.press('Escape')

  await page.locator('.file-action-toggle').click()
  assert.equal(await page.getByRole('button', { name: 'Compare with Git HEAD', exact: true }).isVisible(), false)
  assert.equal(await page.getByRole('button', { name: 'Add file review note', exact: true }).isVisible(), false)
  await page.keyboard.press('Escape')

  await page.locator('#content-search-toggle').click()
  const search = page.locator('#content-search')
  await search.waitFor({ state: 'visible' })
  assert.equal(await search.getByRole('button', { name: 'Changed files', exact: true }).isVisible(), false)
  await search.getByRole('combobox', { name: 'Search file contents' }).fill('plain folder text')
  const result = search.locator('.content-search-hit').first()
  await result.waitFor({ state: 'visible' })
  await result.click()
  await search.waitFor({ state: 'hidden' })

  await editor.click()
  await page.keyboard.press('Meta+End')
  await page.keyboard.type('edited without Git\n')
  await until('autosave in a plain folder', async () => readFileSync(file, 'utf8').includes('edited without Git'))
  assert.equal(await page.locator('.diff-gutter-added, .diff-gutter-modified, .diff-gutter-deleted').count(), 0)
  await page.keyboard.press('Meta+Shift+G')
  assert.equal(await page.locator('#change-review').isVisible(), false, 'The review shortcut stays inactive')
}

try {
  mkdirSync(folder)
  writeFileSync(file, 'plain folder text\n')
  writeFileSync(path.join(folder, '.gitignore'), 'visible.txt\n')
  writeFileSync(path.join(folder, 'visible.txt'), 'This file stays available without Git.\n')
  const workspace = await openWorkspace(applicationRoot, path.join(directory, 'profile'), folder, error =>
    errors.push(error.message),
  )
  try {
    await checkWorkspace(workspace.page)
    assert.equal(await workspace.page.locator('#navigator [data-path="visible.txt"]').isVisible(), true)
  } finally {
    await workspace.close()
  }

  const standalone = await openWorkspace(applicationRoot, path.join(directory, 'file-profile'), file, error =>
    errors.push(error.message),
  )
  try {
    await standalone.page.locator('.file-card .monaco-editor').waitFor({ state: 'visible' })
    assert.equal(await standalone.page.locator('#git-workspace-toggle').isVisible(), false)
    assert.equal(await standalone.page.locator('.diff-toggle').isVisible(), false)
    assert.equal(await standalone.page.locator('.file-name').textContent(), 'notes.txt')
    assert.deepEqual(errors, [], 'Plain folders and standalone files do not raise renderer exceptions')
    console.info('Optional Git workspace integration passed.')
  } finally {
    await standalone.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
}
