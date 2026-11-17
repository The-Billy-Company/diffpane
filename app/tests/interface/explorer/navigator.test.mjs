import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import {
  buildNavigationTree,
  expandFolderChain,
  expandInitialFolderChains,
  findChangedFile,
  flattenNavigationTree,
  navigationStatus,
} from '../../../renderer/explorer/tree/navigator.js'

/**
 * @param {string} path
 * @param {Partial<import('../../../renderer/explorer/tree/navigation-reconcile.ts').NavigationFile>} [values]
 */
function file(path, values = {}) {
  return { path, index: ' ', worktree: ' ', conflicted: false, submodule: false, ...values }
}

/** @param {ReturnType<typeof flattenNavigationTree>} rows */
function paths(rows) {
  return rows.map(({ node }) => node.path)
}

test('explorer builds naturally sorted folders and exposes only expanded descendants', () => {
  const tree = buildNavigationTree([
    file('src/file10.rs'),
    file('README.md'),
    file('src/file2.rs'),
    file('src/deep/nested.rs'),
    file('docs/index.md'),
  ])
  assert.equal(tree.files.size, 5)
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']))), ['', 'docs', 'src', 'README.md'])
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['', 'src']))), [
    '',
    'docs',
    'src',
    'src/deep',
    'src/file2.rs',
    'src/file10.rs',
    'README.md',
  ])
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set())), [''])
})

test('initial expansion reveals files through top-level wrapper folders', () => {
  const tree = buildNavigationTree([
    file('README.md'),
    file('docs/index.md'),
    file('src/main/java/App.java'),
    file('src/main/java/helpers/Helper.java'),
  ])
  const expanded = new Set([''])
  expandInitialFolderChains(tree.root, expanded)
  assert.deepEqual(paths(flattenNavigationTree(tree, expanded)), [
    '',
    'docs',
    'src',
    'src/main',
    'src/main/java',
    'src/main/java/helpers',
    'src/main/java/App.java',
    'README.md',
  ])
})

test('a scoped root opens its only branch and waits for the user to choose a subfolder', () => {
  const tree = buildNavigationTree(
    [file('project/src/app/lib/app.ts'), file('project/src/test/app.test.ts')],
    'project',
  )
  const expanded = new Set(['project'])
  expandInitialFolderChains(tree.root, expanded)
  assert.deepEqual(paths(flattenNavigationTree(tree, expanded)), [
    'project',
    'project/src',
    'project/src/app',
    'project/src/test',
  ])

  const app = tree.nodes.get('dir:project/src/app')
  assert.ok(app)
  assert.equal(expandFolderChain(app, expanded), true)
  assert.deepEqual(paths(flattenNavigationTree(tree, expanded)), [
    'project',
    'project/src',
    'project/src/app',
    'project/src/app/lib',
    'project/src/app/lib/app.ts',
    'project/src/test',
  ])
  assert.equal(expandFolderChain(app, expanded), false)
})

test('automatic expansion leaves ignored subfolders closed', () => {
  const cache = 'tools/cache'
  const tree = buildNavigationTree([file(cache, { directory: true, ignored: true })])
  const expanded = new Set([''])
  expandInitialFolderChains(tree.root, expanded)
  assert.deepEqual(paths(flattenNavigationTree(tree, expanded)), ['', 'tools', cache])
  assert.equal(expanded.has(cache), false)
})

test('first and last changes check direct files before descending into changed subfolders', () => {
  const tree = buildNavigationTree([
    file('src/file10.cc'),
    file('src/file2.cc'),
    file('src/file1.cc'),
    file('src/file20.cc'),
    file('src/public/later/header.h'),
    file('src/public/deep/header.h'),
    file('src/public/unused/header.h'),
    file('src/pip/clean.h'),
  ])
  for (const path of ['src/file10.cc', 'src/file2.cc', 'src/public/later/header.h', 'src/public/deep/header.h']) {
    let node = tree.files.get(path)
    while (node) {
      node.changedCount++
      node = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
    }
  }

  const src = tree.nodes.get('dir:src')
  const publicFolder = tree.nodes.get('dir:src/public')
  const pip = tree.nodes.get('dir:src/pip')
  assert.ok(src && publicFolder && pip)
  assert.equal(findChangedFile(src, 'first')?.path, 'src/file2.cc')
  assert.equal(findChangedFile(src, 'last')?.path, 'src/file10.cc')
  assert.equal(findChangedFile(publicFolder, 'first')?.path, 'src/public/deep/header.h')
  assert.equal(findChangedFile(publicFolder, 'last')?.path, 'src/public/later/header.h')
  assert.equal(findChangedFile(pip, 'first'), undefined)
  assert.equal(findChangedFile(pip, 'last'), undefined)
})

test('scoped explorer retains repository-relative file paths and filters siblings', () => {
  const tree = buildNavigationTree(
    [file('src/view/app.ts'), file('src/view/deep/model.ts'), file('src/outside.ts'), file('src/viewer/wrong.ts')],
    'src/view',
  )
  assert.equal(tree.root.path, 'src/view')
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['src/view']))), [
    'src/view',
    'src/view/deep',
    'src/view/app.ts',
  ])
  assert.equal(tree.files.size, 2)
  assert.equal(tree.files.get('src/view/app.ts')?.file?.path, 'src/view/app.ts')
})

test('search reaches collapsed descendants without mounting or expanding their folders', () => {
  const tree = buildNavigationTree([file('src/deep/Hello.swift'), file('src/deep/world.swift'), file('docs/hello.md')])
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'HELLO')), [
    'docs/hello.md',
    'src/deep/Hello.swift',
  ])
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'src/deep')), [
    'src/deep/Hello.swift',
    'src/deep/world.swift',
    'src/deep',
  ])
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['']), 'missing')), [])
})

test('file-to-directory replacement preserves both the deleted index path and new descendants', () => {
  const tree = buildNavigationTree([
    file('pkg', { worktree: 'D' }),
    file('pkg/main.ex', { worktree: '?' }),
    file('pkg/main.ex'),
  ])
  assert.equal(tree.files.size, 2)
  assert.equal(tree.nodes.get('dir:pkg')?.kind, 'directory')
  assert.equal(tree.nodes.get('file:pkg')?.file?.worktree, 'D')
  assert.deepEqual(paths(flattenNavigationTree(tree, new Set(['', 'pkg']))), ['', 'pkg', 'pkg/main.ex', 'pkg'])
})

test('large collapsed inventories do not enter the visible projection', () => {
  const inventory = Array.from({ length: 50_000 }, (_, index) => file(`src/package${index % 100}/file${index}.py`))
  const tree = buildNavigationTree(inventory)
  assert.equal(tree.files.size, 50_000)
  assert.equal(flattenNavigationTree(tree, new Set([''])).length, 2)
  assert.equal(flattenNavigationTree(tree, new Set(['', 'src'])).length, 102)
})

test('Git status prioritizes conflicts, then working changes, then index changes', () => {
  assert.equal(navigationStatus(file('a')), '')
  assert.equal(navigationStatus(file('a', { index: '.', worktree: '.' })), '')
  assert.equal(navigationStatus(file('a', { index: 'M' })), 'M')
  assert.equal(navigationStatus(file('a', { index: 'A', worktree: 'D' })), 'D')
  assert.equal(navigationStatus(file('a', { worktree: '?' })), 'U')
  assert.equal(navigationStatus(file('a', { index: 'A', worktree: 'M', conflicted: true })), '!')
})

test('explorer distinguishes moves from moves with edits across Git layers', () => {
  assert.equal(navigationStatus(file('a', { index: 'R' })), 'R')
  assert.equal(navigationStatus(file('a', { worktree: 'R' })), 'R')
  assert.equal(navigationStatus(file('a', { index: 'R', renameEdited: true })), 'RM')
  assert.equal(navigationStatus(file('a', { worktree: 'R', renameEdited: true })), 'RM')
  assert.equal(navigationStatus(file('a', { index: 'R', worktree: 'M' })), 'RM')
  assert.equal(navigationStatus(file('a', { index: 'M', worktree: 'R' })), 'RM')
  assert.equal(navigationStatus(file('a', { index: 'R', worktree: 'D' })), 'D')
  assert.equal(navigationStatus(file('a', { index: 'R', worktree: 'M', conflicted: true })), '!')
})
