import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'vite-plus/test'
import type { TestContext } from 'vite-plus/test'
import { LocalState } from '../../../electron/persistence/database/local-state.ts'
import { SavedWorkspaces } from '../../../electron/persistence/preferences/saved-workspaces.ts'
import { WorkspaceWindows } from '../../../electron/runtime/window/workspace-windows.ts'
import type { WorkspaceNavigation } from '../../../electron/runtime/window/workspace-windows.ts'

const git = promisify(execFile)
const keyring = {
  wrap: (key: string) => Promise.resolve(Buffer.from(key)),
  unwrap: (key: Buffer) => Promise.resolve(key.toString()),
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-workspaces-')))
  const filename = path.join(directory, 'state.sqlite')
  const first = path.join(directory, 'first')
  const second = path.join(directory, 'second')
  const state = new LocalState(filename, keyring)
  const storage = new SavedWorkspaces(state)
  t.onTestFinished(async () => {
    state.close()
    await rm(directory, { recursive: true, force: true })
  })
  await Promise.all([git('git', ['init', '-q', first]), git('git', ['init', '-q', second])])
  const manager = new WorkspaceWindows(storage, {
    changed: () => {},
    track: pending => pending,
    log: error => assert.fail(String(error)),
  })
  return { first, second, filename, storage, manager }
}

class WindowFixture {
  directory: string | null = null
  workspace?: WorkspaceNavigation['workspace']
  repositoryRoot?: string
  repositoryScope?: string
  rememberedFile?: string
  canFlush = true
  resumes = 0

  flush() {
    return Promise.resolve(this.canFlush)
  }
  canNavigate() {
    return true
  }
  resume() {
    this.resumes += 1
  }
  navigate(target: WorkspaceNavigation) {
    this.directory = target.directory
    this.workspace = target.workspace
    this.repositoryRoot = this.repositoryScope = target.directory ?? undefined
    this.rememberedFile = target.rememberedFile
  }
}

test('persisted workspaces remember each folder’s last file and survive reopening local storage', async t => {
  const { first, second, filename, manager } = await fixture(t)
  const window = new WindowFixture()
  const files = await manager.approvePickedFolders(window, [first, first, second])
  const workspace = await manager.save(
    window,
    { name: 'Projects', folders: files, activeFolder: first },
    { open: true },
  )
  await Promise.all([
    writeFile(path.join(first, 'one.txt'), 'one'),
    writeFile(path.join(first, 'two.txt'), 'two'),
    writeFile(path.join(second, 'other.txt'), 'other'),
  ])
  assert.equal(window.directory, first)
  manager.rememberFile(window, 'one.txt')
  manager.rememberFile(window, 'two.txt')
  await manager.switchFolder(window, second)
  manager.rememberFile(window, 'other.txt')
  await manager.close(window)
  assert.equal(window.directory, null)

  const reopened = new LocalState(filename, keyring)
  t.onTestFinished(() => reopened.close())
  const storage = new SavedWorkspaces(reopened)
  assert.deepEqual(await storage.file(workspace.id, first), 'two.txt')
  assert.deepEqual(await storage.file(workspace.id, second), 'other.txt')
  assert.equal((await storage.get(workspace.id))?.activeFolder, second)
  await manager.open(window, workspace.id)
  assert.equal(window.rememberedFile, path.join(second, 'other.txt'))
  await rm(path.join(first, 'two.txt'))
  await manager.switchFolder(window, first)
  assert.equal(window.rememberedFile, undefined)
})

test('a failed save flush leaves saved folders and the current window untouched', async t => {
  const { first, second, manager, storage } = await fixture(t)
  const window = new WindowFixture()
  const folders = await manager.approvePickedFolders(window, [first, second])
  const workspace = await manager.save(window, { name: 'Projects', folders, activeFolder: first }, { open: true })
  window.canFlush = false
  const draft = { id: workspace.id, name: workspace.name, folders: [second], activeFolder: second }
  await assert.rejects(manager.save(window, draft, { open: true }), { code: 'SAVE_FLUSH_FAILED' })
  await assert.rejects(manager.remove(window, workspace.id), { code: 'SAVE_FLUSH_FAILED' })
  assert.equal(window.directory, first)
  assert.equal(window.resumes, 2)
  assert.deepEqual(await storage.get(workspace.id), workspace)
})

test('opening falls back to a live folder or retains management when every folder is missing', async t => {
  const { first, second, manager, storage } = await fixture(t)
  const home = new WindowFixture()
  const folders = await manager.approvePickedFolders(home, [first, second])
  const workspace = await manager.save(home, { name: 'Projects', folders, activeFolder: first }, {})
  const renamed = `${first}-moved`
  await rename(first, renamed)
  const window = new WindowFixture()
  await manager.open(window, workspace.id)
  assert.equal(window.directory, second)
  assert.deepEqual((await manager.current(window))?.unavailableFolders, [first])
  await assert.rejects(
    manager.save(home, { ...workspace, name: 'Stale rename' }, { expectedUpdatedAt: workspace.updatedAt }),
    {
      code: 'WORKSPACE_CHANGED',
    },
  )
  await rename(second, `${second}-moved`)
  await manager.open(window, workspace.id)
  assert.equal(window.directory, null)
  assert.deepEqual((await manager.current(window))?.unavailableFolders.toSorted(), [first, second])
  await rename(renamed, first)
  assert.deepEqual((await manager.current(window))?.unavailableFolders, [second])
  assert.equal(await manager.switchFolder(window, first), true)
  assert.equal(window.directory, first)
  assert.equal(await manager.remove(window, workspace.id), true)
  assert.equal(window.directory, null)
  assert.deepEqual(await storage.list(), [])
})
