import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from 'vite-plus/test'
import { readClaudeFile } from '../../../backend/tools/assistant/claude-workspace.mjs'
import { searchRepositoryContent } from '../../../backend/workspace/repository/content-search.mjs'
import { Repository } from '../../../backend/workspace/repository/repository.mjs'
import { MAX_PIXEL_DIFF_IMAGE_BYTES } from '../../../shared/documents/media-types.ts'

const execute = promisify(execFile)
/** @param {string} filename */
const plain = filename => ({
  path: filename,
  originalPath: null,
  index: ' ',
  worktree: ' ',
  conflicted: false,
  submodule: false,
})

/**
 * @template {import('../../../backend/runtime/session/workspace-types.ts').WorkspaceFile} File
 * @param {{ files: readonly File[] }} snapshot
 * @param {string} filename
 * @returns {File}
 */
function find(snapshot, filename) {
  return requireFile(
    snapshot.files.find(entry => entry.path === filename),
    filename,
  )
}

/**
 * @template {import('../../../backend/runtime/session/workspace-types.ts').WorkspaceFile} File
 * @param {File | undefined} file
 * @param {string} filename
 * @returns {File}
 */
function requireFile(file, filename) {
  assert.ok(file, `Missing expected file ${JSON.stringify(filename)}`)
  return file
}

/** @param {string | null} note @param {RegExp} pattern */
function matchNote(note, pattern) {
  assert.ok(typeof note === 'string', 'Expected a repository note')
  assert.match(note, pattern)
}

/** @param {import('vite-plus/test').TestContext} t */
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-repository-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key]
  /** @param {string[]} args @param {NodeJS.ProcessEnv} [variables] */
  const git = async (args, variables) =>
    (
      await execute('git', ['-C', root, ...args], {
        env: { ...env, ...variables },
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout
  /** @param {string} filename @param {string | Buffer} contents */
  const write = async (filename, contents) => {
    const absolute = path.join(root, filename)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, contents)
  }
  const commit = async () => {
    await git(['add', '--all'])
    await git(['-c', `core.hooksPath=${path.join(root, '.git', 'no-hooks')}`, 'commit', '-m', 'baseline'])
  }
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Diffpane tests'])
  await git(['config', 'user.email', 'diffpane@example.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  return { root, git, write, commit, open: () => Repository.open(root) }
}

test('ordinary folders expose confined editable files without Git comparisons', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-folder-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'nested'))
  await writeFile(path.join(root, 'nested/file.txt'), 'folder contents\n')
  await writeFile(path.join(root, '.hidden'), 'hidden file\n')
  await symlink(root, path.join(root, 'nested/link'))

  const repository = await Repository.open(root)
  assert.equal(repository.isGitRepository, false)
  assert.equal(repository.root, root)
  assert.equal(repository.scope, root)
  const files = await repository.files()
  assert.deepEqual(
    files.map(file => file.path),
    ['.hidden', 'nested', 'nested/file.txt', 'nested/link'],
  )
  assert.equal(find({ files }, 'nested').directory, true)
  assert.notEqual(find({ files }, 'nested/link').directory, true)
  const file = find({ files }, 'nested/file.txt')
  const comparisons = await Promise.all(['head', 'unstaged', 'staged'].map(mode => repository.contents(file, mode)))
  for (const contents of comparisons) {
    assert.deepEqual(contents, {
      before: 'folder contents\n',
      after: 'folder contents\n',
      note: null,
    })
  }
  assert.equal(await repository.editable(file.path), true)
  await repository.save(file.path, 'saved contents\n', 'folder contents\n')
  assert.equal(await readFile(path.join(root, file.path), 'utf8'), 'saved contents\n')
  assert.deepEqual((await repository.snapshot()).files, [])
  await assert.rejects(repository.save('../outside.txt', 'outside', ''), /invalid repository-relative/u)

  const scoped = await Repository.open(path.join(root, file.path))
  assert.equal(scoped.root, path.join(root, 'nested'))
  assert.deepEqual(
    (await scoped.files()).map(entry => entry.path),
    ['file.txt', 'link'],
  )
  assert.equal(await scoped.editable('../.hidden'), false)
  await assert.rejects(repository.gitOverview(Date.now() - 1000, Date.now()), /Git repository/u)
  await assert.rejects(repository.gitChanges({ kind: 'working', mode: 'head' }), /Git repository/u)
})

test('ordinary folders retain readable files and search results beside inaccessible descendants', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-folder-access-')))
  const locked = path.join(root, 'locked')
  t.onTestFinished(async () => {
    await chmod(root, 0o700)
    await chmod(locked, 0o700)
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(locked)
  await writeFile(path.join(locked, 'hidden.txt'), 'needle behind permissions\n')
  await writeFile(path.join(root, 'readable.txt'), 'readable needle\n')
  await chmod(locked, 0)
  let readable = true
  try {
    await readdir(locked)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['EACCES', 'EPERM'].includes(String(error.code)))
      throw error
    readable = false
  }
  if (readable) t.skip('The host user can read directories despite their permission bits.')

  const repository = await Repository.open(root)
  const files = await repository.files()
  assert.deepEqual(
    files.map(file => file.path),
    ['locked', 'readable.txt'],
  )
  assert.equal(find({ files }, 'locked').directory, true)
  const result = await searchRepositoryContent(
    repository,
    { query: 'needle', scope: 'workspace', matchCase: false },
    new AbortController().signal,
  )
  assert.deepEqual(
    result?.matches.map(match => match.path),
    ['readable.txt'],
  )
  assert.equal(result?.truncated, false)

  await chmod(root, 0)
  try {
    await assert.rejects(repository.files(), { code: 'EACCES' })
  } finally {
    await chmod(root, 0o700)
  }
})

test.for([false, true])(
  'folders can be opened and read when Git is unavailable (repository present: %s)',
  async (repositoryPresent, t) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-no-git-')))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    if (repositoryPresent) await execute('git', ['init', '-q', root])
    await writeFile(path.join(root, 'file.txt'), 'without Git\n')
    const source = `
    import assert from 'node:assert/strict';
    import { Repository } from ${JSON.stringify(new URL('../../../backend/workspace/repository/repository.mjs', import.meta.url).href)};
    const repository = await Repository.open(${JSON.stringify(root)});
    assert.equal(repository.isGitRepository, false);
    const files = await repository.files();
    assert.equal(files.length, 1);
    assert.deepEqual(await repository.contents(files[0]), {
      before: 'without Git\\n', after: 'without Git\\n', note: null,
    });
  `
    await assert.doesNotReject(() =>
      execute(process.execPath, ['--input-type=module', '--eval', source], {
        env: { ...process.env, PATH: root },
        timeout: 10000,
      }),
    )
  },
)

test('Git Today and History preserve day boundaries, merge parents, ref tips and historical patches', async t => {
  const repo = await fixture(t)
  /** @param {string} name @param {string} date */
  const commitAt = async (name, date) => {
    await repo.git(['add', '--all'])
    await repo.git(['commit', '-m', name], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
    return (await repo.git(['rev-parse', 'HEAD'])).trim()
  }
  await repo.write('scope/old.txt', 'Keep this line.\n')
  const baseline = await commitAt('Before local midnight', '2026-11-15T23:59:59-08:00')
  await repo.git(['checkout', '-qb', 'review/line,map'])
  await repo.git(['mv', 'scope/old.txt', 'scope/new\tname.txt'])
  const feature = await commitAt('Rename at local midnight', '2026-11-16T00:00:00-08:00')

  await repo.git(['checkout', '-q', 'main'])
  await repo.write('outside.txt', 'Main branch\n')
  const main = await commitAt('Main branch file', '2026-11-16T08:58:00-08:00')
  await repo.git(['tag', '--no-sign', 'v1,preview', main])
  await repo.git(['update-ref', 'refs/remotes/upstream/main', main])
  await repo.git(['checkout', '-q', 'review/line,map'])
  await repo.git(['merge', '--no-ff', '--no-commit', 'main'])
  const merged = await commitAt('Merge main', '2026-11-16T09:00:00-08:00')
  await repo.git(['checkout', '-q', 'main'])
  await repo.write('outside.txt', 'Main branch again\n')
  const unrelated = await commitAt('Diverged from review', '2026-11-16T09:04:00-08:00')
  await repo.git(['checkout', '-q', 'review/line,map'])
  const repoView = await Repository.open(path.join(repo.root, 'scope'))
  const start = Date.parse('2026-11-16T00:00:00-08:00')
  const end = Date.parse('2026-11-17T00:00:00-08:00')
  const partial = await repoView.gitOverview(start, end, 2)
  assert.equal(partial.head, merged)
  assert.equal(partial.branch, 'review/line,map')
  assert.equal(partial.dayBase, baseline)
  assert.equal(partial.historyHasMore, true)
  assert.deepEqual(
    partial.today.map(commit => commit.id),
    [merged, main, feature],
  )
  assert.deepEqual(partial.today[0]?.parents, [feature, main])
  const history = await repoView.gitOverview(start, end, 25)
  assert.equal(history.historyHasMore, false)
  const ids = history.commits.map(commit => commit.id)
  for (const [index, commit] of history.commits.entries()) {
    assert.ok(commit.parents.every(parent => ids.indexOf(parent) > index))
  }
  assert.deepEqual(history.commits.find(commit => commit.id === unrelated)?.refs, [{ name: 'main', kind: 'branch' }])
  assert.deepEqual(history.commits.find(commit => commit.id === merged)?.refs, [
    { name: 'review/line,map', kind: 'branch' },
  ])
  assert.deepEqual(
    history.commits.find(commit => commit.id === main)?.refs.toSorted((a, b) => a.kind.localeCompare(b.kind)),
    [
      { name: 'upstream/main', kind: 'remote' },
      { name: 'v1,preview', kind: 'tag' },
    ],
  )
  const compareMain = { kind: 'revision', base: feature, target: merged }
  const changesFromFeature = await repoView.gitChanges(compareMain)
  const outside = changesFromFeature.files[0]
  assert.deepEqual(outside, { path: 'outside.txt', originalPath: null, status: 'A', additions: 1, deletions: 0 })
  assert.deepEqual(await repoView.gitContents(compareMain, outside), {
    before: '',
    after: 'Main branch\n',
    note: null,
    available: true,
  })
  const compareFeature = { kind: 'revision', base: main, target: merged }
  const changesFromMain = await repoView.gitChanges(compareFeature)
  const renamed = changesFromMain.files[0]
  assert.deepEqual(renamed, {
    path: 'scope/new\tname.txt',
    originalPath: 'scope/old.txt',
    status: 'R',
    additions: 0,
    deletions: 0,
  })
  assert.deepEqual(await repoView.gitContents(compareFeature, renamed), {
    before: 'Keep this line.\n',
    after: 'Keep this line.\n',
    note: null,
    available: true,
  })
  const day = await repoView.gitChanges({ kind: 'revision', base: history.dayBase, target: merged })
  assert.equal(day.additions, 1)
  assert.deepEqual(
    day.files.map(file => file.status),
    ['A', 'R'],
  )
  const root = await repoView.gitChanges({ kind: 'revision', base: null, target: baseline })
  assert.equal(root.additions, 1)
  assert.equal(root.files[0]?.path, 'scope/old.txt')
  await repo.write('scope/next-day.txt', 'Tomorrow\n')
  const nextDay = await commitAt('Next day', '2026-11-17T00:00:00-08:00')
  const earlierDay = await repoView.gitOverview(start, end)
  assert.equal(earlierDay.head, nextDay)
  assert.deepEqual(
    earlierDay.today.map(commit => commit.id),
    [merged, main, feature],
  )
})

test('Git workspace compares index, disk, and HEAD independently and includes repo-wide untracked files', async t => {
  const repo = await fixture(t)
  await repo.write('scope/staged.txt', 'seed\n')
  await repo.write('cancel.txt', 'before\n')
  await repo.write('recreated.txt', 'before\n')
  await repo.write('same.txt', 'same\n')
  await repo.commit()
  await repo.write('scope/staged.txt', 'seed\nstaged\n')
  await repo.write('cancel.txt', 'staged\n')
  await repo.git(['add', 'scope/staged.txt', 'cancel.txt'])
  await repo.git(['rm', '--cached', 'recreated.txt', 'same.txt'])
  await repo.write('scope/staged.txt', 'seed\nstaged\nloose\n')
  await repo.write('cancel.txt', 'before\n')
  await repo.write('recreated.txt', 'after\n')
  await repo.write('untracked.txt', 'one\ntwo')
  await repo.write('untracked.bin', Buffer.from([0, 10, 1, 2]))
  const repoView = await Repository.open(path.join(repo.root, 'scope'))
  const initialIndex = await repo.git(['diff', '--cached', '--raw', '-z'])

  const headMode = { kind: 'working', mode: 'head' }
  const stagedMode = { kind: 'working', mode: 'staged' }
  const unstagedMode = { kind: 'working', mode: 'unstaged' }
  const [head, staged, unstaged] = await Promise.all([
    repoView.gitChanges(headMode),
    repoView.gitChanges(stagedMode),
    repoView.gitChanges(unstagedMode),
  ])
  const rows = head.files.map(file => [file.path, file.status, file.additions, file.deletions])
  assert.deepEqual(rows, [
    ['recreated.txt', 'M', 1, 1],
    ['scope/staged.txt', 'M', 2, 0],
    ['untracked.bin', '?', null, null],
    ['untracked.txt', '?', 2, 0],
  ])
  assert.deepEqual([head.additions, head.deletions], [5, 1])
  assert.deepEqual([staged.additions, staged.deletions], [2, 3])
  assert.deepEqual([unstaged.additions, unstaged.deletions], [6, 1])
  const stagedPath = staged.files.find(file => file.path === 'scope/staged.txt')
  const unstagedPath = unstaged.files.find(file => file.path === 'scope/staged.txt')
  assert.deepEqual(await repoView.gitContents(stagedMode, stagedPath), {
    before: 'seed\n',
    after: 'seed\nstaged\n',
    note: null,
    available: true,
  })
  assert.deepEqual(await repoView.gitContents(unstagedMode, unstagedPath), {
    before: 'seed\nstaged\n',
    after: 'seed\nstaged\nloose\n',
    note: null,
    available: true,
  })
  const recreated = await repoView.gitContents(headMode, head.files[0])
  assert.equal(recreated.before, 'before\n')
  assert.equal(recreated.after, 'after\n')
  const binary = await repoView.gitContents(
    headMode,
    head.files.find(file => file.path === 'untracked.bin'),
  )
  assert.equal(binary.available, false)
  assert.ok(binary.note)
  assert.equal(await repo.git(['diff', '--cached', '--raw', '-z']), initialIndex)
  await assert.rejects(
    repoView.gitChanges({ kind: 'revision', base: null, target: '--all' }),
    /Unknown Git comparison/u,
  )
  await assert.rejects(
    repoView.gitContents(headMode, { path: '../outside', originalPath: null, status: '?' }),
    /invalid repository-relative path/u,
  )
  await assert.rejects(
    repoView.gitContents(headMode, { path: '.git/config', originalPath: null, status: '?' }),
    /Git metadata/u,
  )
})

test('Git workspace opens before the first commit and marks a detached checkout', async t => {
  const repo = await fixture(t)
  await repo.write('staged.txt', 'staged\n')
  await repo.git(['add', 'staged.txt'])
  await repo.write('working.txt', 'working\n')
  const view = await repo.open()
  const now = Date.now()
  const unborn = await view.gitOverview(now - 60_000, now + 60_000)
  assert.equal(unborn.head, null)
  assert.equal(unborn.branch, 'main')
  assert.deepEqual(unborn.commits, [])
  const working = await view.gitChanges({ kind: 'working', mode: 'head' })
  assert.deepEqual(
    working.files.map(file => [file.path, file.status]),
    [
      ['staged.txt', 'A'],
      ['working.txt', '?'],
    ],
  )
  await repo.commit()
  await repo.git(['checkout', '--detach', 'HEAD'])
  const detached = await view.gitOverview(now - 60_000, Date.now() + 60_000)
  assert.match(detached.branch, /^detached [a-f\d]{8}$/u)
  assert.equal(detached.today[0]?.id, detached.head)
})

test('file inventory includes ignored directory placeholders without loading their children, including tracked exceptions', async t => {
  const repo = await fixture(t)
  await repo.write('unchanged.rs', 'fn main() {}\n')
  await repo.write('ignored/tracked.rs', 'tracked despite ignore rules\n')
  await repo.commit()
  await repo.write('.gitignore', 'ignored/\nnode_modules/\n')
  await repo.write('new.rs', 'not committed yet\n')
  await repo.write('ignored/noise.rs', 'ignore this\n')
  await repo.write('node_modules/dependency/index.js', 'ignore this too\n')
  const repository = await repo.open()
  const files = await repository.files()
  assert.deepEqual(files, [
    plain('.gitignore'),
    { ...plain('ignored'), ignored: true, directory: true },
    plain('ignored/tracked.rs'),
    plain('new.rs'),
    { ...plain('node_modules'), ignored: true, directory: true },
    plain('unchanged.rs'),
  ])
  assert.deepEqual(await repository.contents(find({ files }, 'unchanged.rs')), {
    before: 'fn main() {}\n',
    after: 'fn main() {}\n',
    note: null,
  })
  assert.equal(
    (await repository.snapshot()).files.some(file => file.path === 'unchanged.rs'),
    false,
  )
})

test('ignored directory expansion is shallow, collapse releases descendants, and reopening reads current entries', async t => {
  const repo = await fixture(t)
  await repo.write('.gitignore', 'cache/\n*.log\n!keep.log\n')
  await repo.write('cache/direct.txt', 'ignored text\n')
  await repo.write('cache/deep/child.txt', 'nested text\n')
  await repo.write('debug.log', 'ignored log\n')
  await repo.write('logs/nested/debug.log', 'nested ignored log\n')
  await repo.write('keep.log', 'visible log\n')
  await mkdir(path.join(repo.root, 'empty'))
  const repository = await repo.open()
  const names = async () => (await repository.files()).map(file => file.path)
  assert.deepEqual(await names(), ['.gitignore', 'cache', 'debug.log', 'keep.log', 'logs/nested/debug.log'])
  assert.equal(requireFile(repository.inventoryMetadata.get('debug.log'), 'debug.log').ignored, true)
  assert.equal(await repository.setDirectoryExpanded('cache', true), true)
  assert.equal(await repository.setDirectoryExpanded('cache', true), false)
  assert.deepEqual(await names(), [
    '.gitignore',
    'cache',
    'cache/deep',
    'cache/direct.txt',
    'debug.log',
    'keep.log',
    'logs/nested/debug.log',
  ])
  assert.deepEqual(
    await repository.contents(requireFile(repository.inventoryMetadata.get('cache/direct.txt'), 'cache/direct.txt')),
    {
      before: '',
      after: 'ignored text\n',
      note: null,
    },
  )
  await repository.setDirectoryExpanded('cache/deep', true)
  assert.ok((await names()).includes('cache/deep/child.txt'))
  await repository.setDirectoryExpanded('cache', false)
  assert.deepEqual(await names(), ['.gitignore', 'cache', 'debug.log', 'keep.log', 'logs/nested/debug.log'])
  assert.equal(repository.expandedIgnored.size, 0)
  assert.ok(!repository.inventoryMetadata.has('cache/direct.txt'))
  await repo.write('cache/new.txt', 'new\n')
  await repository.setDirectoryExpanded('cache', true)
  assert.ok((await names()).includes('cache/new.txt'))
  assert.ok(!repository.inventoryMetadata.has('cache/deep/child.txt'))
  await assert.rejects(() => repository.setDirectoryExpanded('../outside', true))
  await assert.rejects(() => repository.setDirectoryExpanded('empty', true))
  await repo.write('.gitignore', '*.log\n!keep.log\n')
  await names()
  assert.equal(requireFile(repository.inventoryMetadata.get('cache/direct.txt'), 'cache/direct.txt').ignored, undefined)
  assert.equal(repository.expandedIgnored.size, 0)
})

test('ignored discovery respects nested scope and never descends into symlinks', async t => {
  const repo = await fixture(t)
  await repo.write('.gitignore', 'cache/\n')
  await repo.write('cache/nested/a.txt', 'a\n')
  await repo.write('cache/other/b.txt', 'b\n')
  await symlink(repo.root, path.join(repo.root, 'cache/nested/link'))
  const repository = await Repository.open(path.join(repo.root, 'cache/nested'))
  assert.deepEqual(
    (await repository.files()).map(file => file.path),
    ['cache/nested', 'cache/nested/a.txt', 'cache/nested/link'],
  )
  assert.equal(requireFile(repository.inventoryMetadata.get('cache/nested/link'), 'cache/nested/link').directory, false)
  await repository.setDirectoryExpanded('cache/nested', false)
  assert.deepEqual(
    (await repository.files()).map(file => file.path),
    ['cache/nested'],
  )
})

test('file inventory honors nested directory scope and excludes deleted tracked paths', async t => {
  const repo = await fixture(t)
  const names = ['inside/a.rs', 'inside/deep/b.rs', 'inside-other/c.rs', 'outside/d.rs']
  await Promise.all(names.map(name => repo.write(name, `${name}\n`)))
  await repo.commit()
  await repo.write('inside/new.rs', 'new\n')
  await repo.write('outside/new.rs', 'outside\n')
  await rm(path.join(repo.root, 'inside/a.rs'))
  const repository = await Repository.open(path.join(repo.root, 'inside'))
  assert.deepEqual(await repository.files(), ['inside/deep/b.rs', 'inside/new.rs'].map(plain))
  assert.equal((await repository.snapshot()).files.find(file => file.path === 'inside/a.rs')?.worktree, 'D')
  await repo.write('inside/a.rs', 'restored\n')
  assert.ok((await repository.files()).some(file => file.path === 'inside/a.rs'))
})

test('file inventory preserves unusual names and distinguishes untracked names resembling stage metadata', async t => {
  const repo = await fixture(t)
  const tracked = ['space name.rs', '雪☃.rs', 'a\nline.rs', 'tab\tname.rs', ':(glob)*.rs', '-dash.rs']
  await Promise.all(tracked.map(name => repo.write(name, 'unchanged\n')))
  await repo.commit()
  const untracked = [`100644 ${'a'.repeat(40)} 0\tlooks-tracked.rs`, '? prefixed.rs', 'new\n雪.rs']
  await Promise.all(untracked.map(name => repo.write(name, 'untracked\n')))
  const repository = await repo.open()
  const expected = [...tracked, ...untracked].toSorted().map(plain)
  assert.deepEqual(await repository.files(), expected)
})

test('file inventory identifies Git index links without descending into submodules', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'baseline\n')
  await repo.commit()
  const oid = (await repo.git(['rev-parse', 'HEAD'])).trim()
  await repo.git(['update-index', '--add', '--cacheinfo', `160000,${oid},modules/child`])
  await repo.write('modules/child/inside.rs', 'submodule contents\n')
  const repository = await repo.open()
  assert.deepEqual(await repository.files(), [plain('a.rs'), { ...plain('modules/child'), submodule: true }])
})

test('partial staging preserves all three comparisons', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'first\nold\n')
  await repo.commit()
  await repo.write('a.rs', 'first\nstaged\n')
  await repo.git(['add', 'a.rs'])
  await repo.write('a.rs', 'first\nworking\n')
  const repository = await repo.open()
  const file = find(await repository.snapshot(), 'a.rs')
  assert.equal(file.index, 'M')
  assert.equal(file.worktree, 'M')
  /** @type {ReadonlyArray<readonly [string, string, string]>} */
  const comparisons = [
    ['head', 'first\nold\n', 'first\nworking\n'],
    ['staged', 'first\nold\n', 'first\nstaged\n'],
    ['unstaged', 'first\nstaged\n', 'first\nworking\n'],
  ]
  await Promise.all(
    comparisons.map(async ([comparison, before, after]) => {
      assert.deepEqual(await repository.contents(file, comparison), { before, after, note: null })
    }),
  )
})

test('unborn HEAD supports both untracked and staged additions', async t => {
  const repo = await fixture(t)
  await repo.write('new.rs', 'hello')
  const repository = await repo.open()
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.branch, 'main (unborn)')
  const file = find(snapshot, 'new.rs')
  assert.deepEqual(await repository.contents(file), { before: '', after: 'hello', note: null })
  assert.deepEqual(await repository.contents(file, 'staged'), {
    before: '',
    after: '',
    note: null,
  })
  await repo.git(['add', 'new.rs'])
  assert.deepEqual(await repository.contents(find(await repository.snapshot(), 'new.rs'), 'staged'), {
    before: '',
    after: 'hello',
    note: null,
  })
})

test('filenames preserve spaces, Unicode, newlines and pathspec metacharacters', async t => {
  const repo = await fixture(t)
  const names = ['space name.rs', '雪☃.rs', 'a\nline.rs', ':(glob)*.rs', '-dash.rs']
  await Promise.all(names.map(name => repo.write(name, 'old\n')))
  await repo.commit()
  await Promise.all(names.map(name => repo.write(name, 'new\n')))
  const repository = await repo.open()
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.files.length, names.length)
  await Promise.all(
    names.map(async name => {
      assert.deepEqual(await repository.contents(find(snapshot, name)), {
        before: 'old\n',
        after: 'new\n',
        note: null,
      })
    }),
  )
})

test('staged rename uses original HEAD and the new index path', async t => {
  const repo = await fixture(t)
  await repo.write('before name.rs', 'before\n')
  await repo.commit()
  await repo.git(['mv', 'before name.rs', 'after name.rs'])
  const repository = await repo.open()
  assert.equal(find(await repository.snapshot(), 'after name.rs').renameEdited, false)
  await repo.write('after name.rs', 'after\n')
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.files.length, 1)
  const file = find(snapshot, 'after name.rs')
  assert.equal(file.originalPath, 'before name.rs')
  assert.equal(file.renameEdited, true)
  assert.deepEqual(await repository.contents(file), {
    before: 'before\n',
    after: 'after\n',
    note: null,
  })
  assert.deepEqual(await repository.contents(file, 'staged'), {
    before: 'before\n',
    after: 'before\n',
    note: null,
  })
  assert.deepEqual(await repository.contents(file, 'unstaged'), {
    before: 'before\n',
    after: 'after\n',
    note: null,
  })
})

test('staged rename detects reordered text even when Git reports full similarity', async t => {
  const repo = await fixture(t)
  await repo.write('before.txt', 'one\ntwo\nthree\n')
  await repo.commit()
  await repo.git(['mv', 'before.txt', 'after.txt'])
  await repo.write('after.txt', 'three\none\ntwo\n')
  await repo.git(['add', 'after.txt'])
  assert.match(await repo.git(['status', '--porcelain=v2']), /R100/u)
  const repository = await repo.open()
  const file = find(await repository.snapshot(), 'after.txt')
  assert.equal(file.index, 'R')
  assert.equal(file.worktree, ' ')
  assert.equal(file.renameEdited, true)
})

test('filesystem moves refresh as destination contents change and leave the real Git index and objects intact', async t => {
  const repo = await fixture(t)
  const before = 'alpha\nbeta\ngamma\ndelta\nepsilon\n'
  await repo.write('before.txt', before)
  await repo.commit()
  const afterPath = 'new\nname.txt'
  await rename(path.join(repo.root, 'before.txt'), path.join(repo.root, afterPath))
  const gitStatus = () => repo.git(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '-uall'])
  const porcelain = await gitStatus()
  const indexPath = path.join(repo.root, '.git', 'index')
  const index = await readFile(indexPath)
  const objects = await repo.git(['count-objects', '-v'])
  const repository = await repo.open()
  const moved = await repository.snapshot()
  assert.equal(moved.files.length, 1)
  const file = find(moved, afterPath)
  assert.equal(file.originalPath, 'before.txt')
  assert.equal(file.index, ' ')
  assert.equal(file.worktree, 'R')
  assert.equal(file.renameEdited, false)
  assert.equal(await repository.snapshot(), moved)

  const after = 'epsilon\nalpha\nbeta\ngamma\ndelta\n'
  await repo.write(afterPath, after)
  assert.equal(await gitStatus(), porcelain)
  const edited = find(await repository.snapshot(), afterPath)
  assert.equal(edited.worktree, 'R')
  assert.equal(edited.renameEdited, true)
  assert.deepEqual(await repository.contents(edited), { before, after, note: null })
  assert.deepEqual(await repository.contents(edited, 'unstaged'), { before, after, note: null })
  assert.deepEqual(await repository.contents(edited, 'staged'), { before, after: before, note: null })
  assert.deepEqual(await readFile(indexPath), index)
  assert.equal(await repo.git(['count-objects', '-v']), objects)
})

test('a working move after a staged rename keeps all three comparison paths', async t => {
  const repo = await fixture(t)
  const before = 'alpha\nbeta\ngamma\ndelta\n'
  const staged = `${before}epsilon\n`
  await repo.write('head.txt', before)
  await repo.commit()
  await repo.git(['mv', 'head.txt', 'index.txt'])
  await repo.write('index.txt', staged)
  await repo.git(['add', 'index.txt'])
  await rename(path.join(repo.root, 'index.txt'), path.join(repo.root, 'working.txt'))
  const repository = await repo.open()
  const file = find(await repository.snapshot(), 'working.txt')
  assert.equal(file.originalPath, 'head.txt')
  assert.equal(file.index, 'R')
  assert.equal(file.worktree, 'R')
  assert.equal(file.renameEdited, true)
  assert.deepEqual(await repository.contents(file), { before, after: staged, note: null })
  assert.deepEqual(await repository.contents(file, 'staged'), { before, after: staged, note: null })
  assert.deepEqual(await repository.contents(file, 'unstaged'), { before: staged, after: staged, note: null })
})

test('exact detection still matches directory moves over the similarity search limit', async t => {
  const repo = await fixture(t)
  const count = 513
  const source = path.join(repo.root, 'before')
  await mkdir(source)
  for (let index = 0; index < count; index++) writeFileSync(path.join(source, `${index}.txt`), `file ${index}\n`)
  await repo.commit()
  await rename(source, path.join(repo.root, 'after'))
  const repository = await repo.open()
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.files.length, count)
  for (const file of snapshot.files) {
    assert.equal(file.worktree, 'R')
    assert.equal(file.renameEdited, false)
    assert.equal(file.originalPath, `before/${path.basename(file.path)}`)
  }
}, 20_000)

test('staged deletion and recreation keep index and worktree distinct', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'baseline\n')
  await repo.commit()
  await repo.git(['rm', 'a.rs'])
  await repo.write('a.rs', 'recreated\n')
  const repository = await repo.open()
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.files.length, 1)
  const file = find(snapshot, 'a.rs')
  assert.deepEqual(await repository.contents(file), {
    before: 'baseline\n',
    after: 'recreated\n',
    note: null,
  })
  assert.deepEqual(await repository.contents(file, 'staged'), {
    before: 'baseline\n',
    after: '',
    note: null,
  })
  assert.deepEqual(await repository.contents(file, 'unstaged'), {
    before: '',
    after: 'recreated\n',
    note: null,
  })
  await rm(path.join(repo.root, 'a.rs'))
  assert.equal((await repository.contents(find(await repository.snapshot(), 'a.rs'))).after, '')
})

test('file and directory replacements show old files as deletions', async t => {
  const repo = await fixture(t)
  await repo.write('file', 'old file\n')
  await repo.write('directory/nested', 'old nested\n')
  await repo.commit()
  await rm(path.join(repo.root, 'file'))
  await repo.write('file/nested', 'new nested\n')
  await rm(path.join(repo.root, 'directory'), { recursive: true })
  await repo.write('directory', 'new file\n')
  const repository = await repo.open()
  const snapshot = await repository.snapshot()
  /** @type {ReadonlyArray<readonly [string, string]>} */
  const expected = [
    ['file', 'old file\n'],
    ['directory/nested', 'old nested\n'],
  ]
  await Promise.all(
    expected.map(async ([name, before]) => {
      assert.deepEqual(await repository.contents(find(snapshot, name)), {
        before,
        after: '',
        note: null,
      })
    }),
  )
})

test('nested directory scope excludes sibling edits and includes cross-scope renames', async t => {
  const repo = await fixture(t)
  await repo.write('inside/a.rs', 'a\n')
  await repo.write('outside/b.rs', 'b\n')
  await repo.commit()
  await repo.write('inside/a.rs', 'A\n')
  await repo.write('outside/b.rs', 'B\n')
  const repository = await Repository.open(path.join(repo.root, 'inside'))
  assert.deepEqual(
    (await repository.snapshot()).files.map(file => file.path),
    ['inside/a.rs'],
  )
  await repo.git(['mv', 'outside/b.rs', 'inside/b.rs'])
  const snapshot = await repository.snapshot()
  assert.equal(snapshot.files.length, 2)
  assert.equal(find(snapshot, 'inside/b.rs').originalPath, 'outside/b.rs')
})

test('linked worktrees resolve both real metadata directories', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'a\n')
  await repo.commit()
  const worktree = await mkdtemp(path.join(tmpdir(), 'diffpane-worktree-'))
  t.onTestFinished(() => rm(worktree, { recursive: true, force: true }))
  const linked = path.join(worktree, 'linked')
  await repo.git(['worktree', 'add', '-b', 'linked', linked])
  await writeFile(path.join(linked, 'a.rs'), 'changed\n')
  const repository = await Repository.open(linked)
  assert.notEqual(repository.gitDir, repository.commonDir)
  assert.equal(repository.commonDir, path.join(repo.root, '.git'))
  assert.equal((await repository.snapshot()).files.length, 1)
})

test('ignored events skip refresh while tracked descendants remain relevant', async t => {
  const repo = await fixture(t)
  await repo.write('ignored/tracked.rs', 'baseline\n')
  await repo.commit()
  await repo.write('.gitignore', 'ignored/\ncache/\n')
  await repo.write('ignored/noise', 'noise\n')
  await repo.write('cache/noise', 'noise\n')
  await repo.write('cache/a\n:(glob)*', 'noise\n')
  await repo.write('ignored/tracked.rs', 'changed\n')
  const repository = await repo.open()
  /** @type {ReadonlyArray<readonly [string, boolean]>} */
  const relevance = [
    ['ignored/noise', false],
    ['cache', false],
    ['cache/a\n:(glob)*', false],
    ['ignored/tracked.rs', true],
    ['ignored', true],
    ['.gitignore', true],
  ]
  await Promise.all(
    relevance.map(async ([name, expected]) => {
      assert.equal(await repository.hasRelevantPaths([path.join(repo.root, name)]), expected, name)
    }),
  )
  assert.equal(await repository.hasRelevantPaths([]), true)
})

test('binary, oversized, many-line and minified files retain bounded contents with explicit notes', async t => {
  const repo = await fixture(t)
  await repo.write('binary', Buffer.from([0, 1, 2]))
  await repo.write('large', Buffer.alloc(2 * 1024 * 1024 + 1, 'x'))
  await repo.write('lines', 'x\n'.repeat(50_001))
  await repo.write('minified', 'x'.repeat(16 * 1024 + 1))
  const repository = await repo.open()
  const { files } = await repository.snapshot()
  assert.equal(files.length, 4)
  await Promise.all(
    files.map(async file => {
      const contents = await repository.contents(file)
      assert.ok(contents.preview, file.path)
      assert.ok(contents.preview.after.note, file.path)
      assert.ok(contents.preview.after.hex, file.path)
      assert.ok(contents.preview.after.size > 0, file.path)
      assert.equal(contents.before, '')
      assert.equal(contents.after, '')
    }),
  )
  await repo.commit()
  await repo.write('large', 'small now\n')
  const result = await repository.contents(find(await repository.snapshot(), 'large'))
  assert.ok(result.preview)
  matchNote(result.preview.before.note, /MiB/)
  assert.equal(result.preview.after.kind, 'text')
  assert.equal(result.preview.after.value, 'small now\n')
})

test('unresolved conflicts expose working markers and explain index modes', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'base\n')
  await repo.commit()
  await repo.git(['switch', '-c', 'other'])
  await repo.write('a.rs', 'other\n')
  await repo.commit()
  await repo.git(['switch', 'main'])
  await repo.write('a.rs', 'main\n')
  await repo.commit()
  await assert.rejects(repo.git(['merge', 'other']))
  const repository = await repo.open()
  const file = find(await repository.snapshot(), 'a.rs')
  assert.equal(file.conflicted, true)
  assert.deepEqual(await repository.files(), [plain('a.rs')])
  const contents = await repository.contents(file)
  assert.match(contents.after, /<<<<<<< /)
  matchNote(contents.note, /conflict/)
  matchNote((await repository.contents(file, 'staged')).note, /unresolved/)
})

test('binary previews preserve HEAD, index and working bytes independently', async t => {
  const repo = await fixture(t)
  await repo.write('data.bin', Buffer.from([0, 1, 65]))
  await repo.commit()
  await repo.write('data.bin', Buffer.from([0, 2, 66]))
  await repo.git(['add', 'data.bin'])
  await repo.write('data.bin', Buffer.from([0, 3, 67]))
  const repository = await repo.open()
  const file = find(await repository.snapshot(), 'data.bin')
  /** @type {ReadonlyArray<readonly [string, string, string]>} */
  const comparisons = [
    ['head', '00 01 41', '00 03 43'],
    ['staged', '00 01 41', '00 02 42'],
    ['unstaged', '00 02 42', '00 03 43'],
  ]
  await Promise.all(
    comparisons.map(async ([comparison, before, after]) => {
      const { preview } = await repository.contents(file, comparison)
      assert.ok(preview?.before.hex?.includes(before), comparison)
      assert.ok(preview?.after.hex?.includes(after), comparison)
    }),
  )
})

test('image comparisons retain working raster bytes through the pixel diff limit', async t => {
  const repo = await fixture(t)
  const filename = 'image.png'
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])
  await repo.write(filename, pngSignature)
  await repo.commit()
  const repository = await repo.open()
  const checkpoint = await repository.captureCheckpoint()

  const image = Buffer.alloc(MAX_PIXEL_DIFF_IMAGE_BYTES, 42)
  pngSignature.copy(image)
  await repo.write(filename, image)
  const file = find(await repository.snapshot(), filename)
  const comparison = await repository.contents(file)
  const checkpointComparison = await repository.checkpointContents(checkpoint, file)
  for (const { preview } of [comparison, checkpointComparison]) {
    assert.equal(preview?.before.kind, 'image')
    assert.equal(preview.before.data, pngSignature.toString('base64'))
    assert.equal(preview.after.kind, 'image')
    assert.ok(preview.after.data)
    assert.ok(Buffer.from(preview.after.data, 'base64').equals(image))
  }

  await repo.write(filename, Buffer.concat([image, Buffer.from([0])]))
  const large = (await repository.contents(file)).preview?.after
  assert.equal(large?.kind, 'image')
  assert.equal(large.size, MAX_PIXEL_DIFF_IMAGE_BYTES + 1)
  assert.equal(large.hexBytes, 64 * 1024)
  assert.equal(large.data, undefined)
})

test(
  'symlink preview reads the link without reading its external target',
  { skip: process.platform === 'win32' },
  async t => {
    const repo = await fixture(t)
    const external = await mkdtemp(path.join(tmpdir(), 'diffpane-external-'))
    t.onTestFinished(() => rm(external, { recursive: true, force: true }))
    const target = path.join(external, 'target')
    await writeFile(target, 'external secret')
    await symlink(target, path.join(repo.root, 'link'))
    const repository = await repo.open()
    assert.equal((await repository.contents(find(await repository.snapshot(), 'link'))).after, target)
  },
)

test(
  'symlinked parent directories cannot expose external contents',
  { skip: process.platform === 'win32' },
  async t => {
    const repo = await fixture(t)
    await repo.write('folder/a.rs', 'baseline\n')
    await repo.commit()
    const external = await mkdtemp(path.join(tmpdir(), 'diffpane-external-'))
    t.onTestFinished(() => rm(external, { recursive: true, force: true }))
    await writeFile(path.join(external, 'a.rs'), 'external secret')
    await rm(path.join(repo.root, 'folder'), { recursive: true })
    await symlink(external, path.join(repo.root, 'folder'))
    const repository = await repo.open()
    const contents = await repository.contents(plain('folder/a.rs'))
    matchNote(contents.note, /outside this repository/)
    assert.equal(contents.after, '')
  },
)

test('CRLF and terminal newlines are preserved for Monaco text models', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'hello\r\nlast\r\n')
  await repo.commit()
  await repo.write('a.rs', 'hello\nlast')
  const repository = await repo.open()
  assert.deepEqual(await repository.contents(plain('a.rs')), {
    before: 'hello\r\nlast\r\n',
    after: 'hello\nlast',
    note: null,
  })
  await repo.write('a.rs', 'hello\nlast\n')
  matchNote((await repository.contents(plain('a.rs'))).note, /line endings/)
})

test('Claude can read either side of a file in scope and cannot read private or oversized HEAD blobs', async t => {
  const repo = await fixture(t)
  await repo.write('src/[file].ts', 'committed text\n')
  await repo.write('src/large.txt', 'x'.repeat(513 * 1024))
  await repo.write('src/.env', 'private\n')
  await repo.write('outside.ts', 'out of scope\n')
  await repo.commit()
  await repo.write('src/[file].ts', 'working text\n')

  const repository = await Repository.open(path.join(repo.root, 'src'))
  assert.equal(await repository.readClaudeHead(plain('src/[file].ts')), 'committed text\n')
  assert.equal(await readClaudeFile(repository, 'src/[file].ts'), 'working text\n')
  await Promise.all(
    ['src/.env', 'src/large.txt', 'src/missing.txt', 'outside.ts'].map(name =>
      assert.rejects(repository.readClaudeHead(plain(name)), /No regular HEAD text file/u),
    ),
  )
})

test('Creature file changes validate the whole batch before writing and preserve the original encoding', async t => {
  const repo = await fixture(t)
  const first = 'src/first.txt'
  const second = 'src/second.txt'
  const created = 'src/created.txt'
  await repo.write(first, Buffer.from('\uFEFFfirst\r\n', 'utf16le'))
  await repo.write(second, 'second\n')
  await repo.commit()
  const repository = await repo.open()
  const changes = [
    { path: first, expected: 'first\r\n', text: 'updated first\r\n' },
    { path: created, expected: null, text: 'new text\n' },
    { path: second, expected: 'second\n', text: 'updated second\n' },
  ]

  await repository.checkClaudeCreate(created)
  await repo.write(second, 'external edit\n')
  await assert.rejects(repository.saveClaudeFiles(changes), { code: 'SAVE_CONFLICT' })
  assert.equal((await readFile(path.join(repo.root, first))).toString('utf16le'), '\uFEFFfirst\r\n')
  assert.equal(await readFile(path.join(repo.root, second), 'utf8'), 'external edit\n')
  await assert.rejects(readFile(path.join(repo.root, created)), { code: 'ENOENT' })

  await repo.write(second, 'second\n')
  await repository.saveClaudeFiles(changes)
  assert.equal((await readFile(path.join(repo.root, first))).toString('utf16le'), '\uFEFFupdated first\r\n')
  assert.equal(await readFile(path.join(repo.root, second), 'utf8'), 'updated second\n')
  assert.equal(await readFile(path.join(repo.root, created), 'utf8'), 'new text\n')
  await assert.rejects(repository.checkClaudeCreate(created), /already exists/u)
})

test('Creature file creation stays in scope and rejects private, ignored, and missing parent paths', async t => {
  const repo = await fixture(t)
  await repo.write('.gitignore', 'src/ignored.txt\n')
  await repo.write('src/existing.txt', 'existing text\n')
  await repo.commit()
  const repository = await Repository.open(path.join(repo.root, 'src'))
  await Promise.all([
    assert.rejects(repository.checkClaudeCreate('outside.txt'), /in this workspace/u),
    assert.rejects(repository.checkClaudeCreate('src/.env'), /project text file/u),
    assert.rejects(repository.checkClaudeCreate('src/missing/new.txt'), /existing project directory/u),
    assert.rejects(repository.checkClaudeCreate('src/ignored.txt'), /nonignored/u),
    assert.rejects(repository.checkClaudeCreate('src/existing.txt'), /already exists/u),
    assert.rejects(
      repository.saveClaudeFiles([{ path: 'src/ignored.txt', expected: null, text: 'hello\n' }]),
      /nonignored/u,
    ),
  ])
})

test(
  'Creature restores earlier edits and creations when a later write fails',
  { skip: !process.getuid?.() },
  async t => {
    const repo = await fixture(t)
    await repo.write('first.txt', 'baseline\n')
    const blocked = path.join(repo.root, 'blocked')
    await mkdir(blocked)
    const repository = await repo.open()
    await chmod(blocked, 0o555)
    try {
      await assert.rejects(
        repository.saveClaudeFiles([
          { path: 'first.txt', expected: 'baseline\n', text: 'updated\n' },
          { path: 'created.txt', expected: null, text: 'new text\n' },
          { path: 'blocked/second.txt', expected: null, text: 'cannot create\n' },
        ]),
        { code: 'EACCES' },
      )
    } finally {
      await chmod(blocked, 0o755)
    }
    assert.equal(await readFile(path.join(repo.root, 'first.txt'), 'utf8'), 'baseline\n')
    await assert.rejects(readFile(path.join(repo.root, 'created.txt')), { code: 'ENOENT' })
  },
)

test(
  'Creature file creation rejects symlinked parents and nested worktrees',
  { skip: process.platform === 'win32' },
  async t => {
    const repo = await fixture(t)
    await repo.write('src/nested/.git', 'gitdir: elsewhere\n')
    await symlink('nested', path.join(repo.root, 'src/linked'))
    const repository = await repo.open()
    await Promise.all([
      assert.rejects(repository.checkClaudeCreate('src/linked/new.txt'), /existing project directory/u),
      assert.rejects(repository.checkClaudeCreate('src/nested/new.txt'), /nested repository/u),
    ])
  },
)

test('contents use the current HEAD after a commit without retaining old blobs', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'before\n')
  await repo.commit()
  await repo.write('a.rs', 'after\n')
  const repository = await repo.open()
  const selected = find(await repository.snapshot(), 'a.rs')
  await repo.commit()
  assert.deepEqual(await repository.contents(selected), {
    before: 'after\n',
    after: 'after\n',
    note: null,
  })
  assert.equal((await repository.snapshot()).files.length, 0)
})

test('detached HEAD identifies its commit', async t => {
  const repo = await fixture(t)
  await repo.write('a.rs', 'baseline\n')
  await repo.commit()
  const oid = (await repo.git(['rev-parse', 'HEAD'])).trim()
  await repo.git(['switch', '--detach', 'HEAD'])
  assert.equal((await (await repo.open()).snapshot()).branch, `detached ${oid.slice(0, 8)}`)
})

test('invalid paths and comparison modes fail explicitly', async t => {
  const repository = await (await fixture(t)).open()
  const invalidPaths = ['', '../outside', '/absolute', 'nested/../../outside', 'nul\0path']
  await Promise.all(
    invalidPaths.map(filename =>
      assert.rejects(repository.contents(plain(filename)), /invalid repository-relative path/),
    ),
  )
  await assert.rejects(repository.contents(plain('a.rs'), 'unknown'), /Unknown comparison/)
})

test('malformed Unicode has a byte view and UTF-8 BOM bytes survive decoding', async t => {
  const repo = await fixture(t)
  await repo.write('invalid', Buffer.from([0xff, 0xfe, 0x00]))
  await repo.write('bom', '\uFEFFhello\n')
  const repository = await repo.open()
  assert.equal((await repository.contents(plain('invalid'))).preview?.after.kind, 'binary')
  assert.equal((await repository.contents(plain('bom'))).after, '\uFEFFhello\n')
})
