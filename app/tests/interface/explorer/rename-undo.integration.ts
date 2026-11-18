import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { openWorkspace } from '../desktop/workspace-fixture.ts'

// Build the renderer, then run node app/tests/interface/explorer/rename-undo.integration.ts.
const applicationRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const directory = mkdtempSync(path.join(tmpdir(), 'diffpane-rename-undo-'))
const repository = path.join(directory, 'project')
const profile = path.join(directory, 'profile')
const original = 'src/before.txt'
const renamed = 'src/after.txt'
const moved = 'lib/after.txt'
const contents = 'original-content\n'
const undo = 'ControlOrMeta+z'
const redo = process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z'
const rendererErrors: string[] = []

function row(page: Page, filename: string) {
  return page.locator(`.navigator-row[data-path="${filename}"]`)
}

async function submitRename(page: Page, name: string) {
  const dialog = page.locator('.rename-dialog')
  await dialog.getByRole('textbox', { name: 'New name' }).fill(name)
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function assertMoved(page: Page, from: string, to: string) {
  await page.locator(`.navigator-row[data-path="${to}"][aria-selected="true"]`).waitFor()
  assert.equal(readFileSync(path.join(repository, to), 'utf8'), contents)
  assert.equal(existsSync(path.join(repository, from)), false)
}

try {
  mkdirSync(path.dirname(path.join(repository, original)), { recursive: true })
  writeFileSync(path.join(repository, original), contents)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repository, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    })
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Diffpane Test', '-c', 'user.email=diffpane@example.invalid', 'commit', '-qm', 'Initial file')

  const workspace = await openWorkspace(applicationRoot, profile, repository, error =>
    rendererErrors.push(error.message),
  )
  try {
    const { page } = workspace
    page.setDefaultTimeout(10_000)
    const tree = page.getByRole('tree', { name: 'Project files' })
    const line = page.locator('#feed .monaco-editor .view-line').first()
    await row(page, original).click()
    await page.keyboard.press('F2')
    await submitRename(page, 'after.txt')
    await page.keyboard.press(undo)
    await assertMoved(page, renamed, original)
    await page.keyboard.press(redo)
    await assertMoved(page, original, renamed)

    await line.click()
    await page.keyboard.press('x')
    await line.filter({ hasText: /x/u }).waitFor()
    await page.keyboard.press(undo)
    await line.filter({ hasText: /^original-content$/u }).waitFor()
    assert.equal(existsSync(path.join(repository, original)), false)

    await row(page, 'src').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
    await submitRename(page, 'lib')
    await assertMoved(page, renamed, moved)

    mkdirSync(path.join(repository, 'src'))
    await tree.focus()
    await page.keyboard.press(undo)
    await page.getByText('A file or folder with that name already exists.', { exact: true }).waitFor()
    assert.equal(readFileSync(path.join(repository, moved), 'utf8'), contents)
    rmdirSync(path.join(repository, 'src'))
    await page.keyboard.press(undo)
    await assertMoved(page, moved, renamed)
    await page.keyboard.press(undo)
    await assertMoved(page, renamed, original)
    await page.keyboard.press(redo)
    await assertMoved(page, original, renamed)
    await page.keyboard.press(redo)
    await assertMoved(page, renamed, moved)

    const renamedFolder = path.join(repository, 'lib')
    const backupFolder = path.join(directory, 'original-lib')
    const replacementFile = path.join(repository, moved)
    renameSync(renamedFolder, backupFolder)
    mkdirSync(renamedFolder)
    writeFileSync(replacementFile, 'replacement contents\n')
    await tree.focus()
    await page.keyboard.press(undo)
    await page.getByText('This file or folder has changed since it was renamed.', { exact: true }).waitFor()
    assert.equal(readFileSync(replacementFile, 'utf8'), 'replacement contents\n')
    assert.equal(readFileSync(path.join(backupFolder, 'after.txt'), 'utf8'), contents)
    assert.equal(existsSync(path.join(repository, 'src')), false)

    rmSync(replacementFile)
    rmdirSync(renamedFolder)
    renameSync(backupFolder, renamedFolder)
    await page.keyboard.press(undo)
    await assertMoved(page, moved, renamed)
    assert.deepEqual(rendererErrors, [])
    console.info('Rename undo integration passed.')
  } finally {
    await workspace.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
}
