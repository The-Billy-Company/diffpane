import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { readClaudeFile } from '../../../backend/tools/assistant/claude-workspace.mjs'
import { searchClaudeFiles, searchClaudeGist } from '../../../backend/tools/assistant/gist-search.mjs'

const { run } = vi.hoisted(() => ({
  run: vi.fn<(binary: string, args: string[], options: { cwd: string }) => Promise<{ stdout: string }>>(),
}))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}))

test.skipIf(process.platform === 'win32')(
  'uses Gist literal search in scope and verifies matches against readable files',
  async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-gist-search-')))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const scope = path.join(root, 'project')
    const gitDir = path.join(root, '.git')
    const workspace = { root, scope, gitDir, commonDir: gitDir }
    const binary = path.join(root, 'gist')
    const source = 'space\nname.txt'
    const query = '--[Needle] '
    await mkdir(scope)
    await Promise.all([
      writeFile(path.join(scope, source), 'a\r\n🙂--[needle] found\n'),
      writeFile(path.join(scope, '.env'), query),
      writeFile(path.join(scope, 'stale.txt'), '--Needle '),
      writeFile(path.join(root, 'outside.txt'), query),
      writeFile(binary, '', { mode: 0o700 }),
    ])
    await symlink(path.join(root, 'outside.txt'), path.join(scope, 'linked.txt'))
    const read = (filename: string) => readClaudeFile(workspace, filename)
    const env = { PATH: root }
    const signal = new AbortController().signal
    run.mockReset().mockImplementation(async (_binary, args) => {
      if (args.includes('--regexp=no match')) throw Object.assign(new Error('No match'), { code: 1 })
      return {
        stdout: [`./${source}`, source, './.env', '../outside.txt', './linked.txt', './stale.txt', ''].join('\0'),
      }
    })

    const result = await searchClaudeGist(workspace, query, false, signal, read, env)

    expect(result.matches).toEqual([{ path: `project/${source}`, line: 2, column: 3, text: '🙂--[needle] found' }])
    expect(run).toHaveBeenCalledExactlyOnceWith(
      binary,
      expect.arrayContaining([
        '--no-config',
        '--fixed-strings',
        '--null',
        '--no-follow',
        '--ignore-case',
        `--regexp=${query}`,
      ]),
      expect.objectContaining({ cwd: scope }),
    )
    expect(run.mock.calls[0]?.[1].slice(-2)).toEqual(['--', '.'])
    expect((await searchClaudeGist(workspace, query, true, signal, read, env)).matches).toEqual([])
    expect(await searchClaudeGist(workspace, 'no match', true, signal, read, env)).toEqual({
      matches: [],
      truncated: false,
    })
  },
)

test.skipIf(process.platform === 'win32')('falls back to project file search when Gist cannot run', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-gist-fallback-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const scope = path.join(root, 'project')
  const gitDir = path.join(root, '.git')
  const workspace = { root, scope, gitDir, commonDir: gitDir }
  const query = '[Needle]'
  await mkdir(scope)
  await Promise.all([
    writeFile(path.join(root, 'gist'), '', { mode: 0o700 }),
    writeFile(path.join(root, 'outside.txt'), query),
    writeFile(path.join(scope, '.env'), query),
    writeFile(path.join(scope, 'source.txt'), '🙂[needle]\n'),
  ])
  await symlink(path.join(root, 'outside.txt'), path.join(scope, 'linked.txt'))
  run.mockReset().mockRejectedValue(Object.assign(new Error('Cannot start Gist'), { code: 'EACCES' }))
  const read = vi.fn<(filename: string) => Promise<string>>(filename => readClaudeFile(workspace, filename))
  const fallback = vi.fn<NonNullable<Parameters<typeof searchClaudeGist>[6]>>((phrase, matchCase, signal) =>
    searchClaudeFiles(workspace, phrase, matchCase, signal, read, async () => ({
      paths: ['outside.txt', 'project/.env', 'project/.gist/state', 'project/linked.txt', 'project/source.txt'],
      truncated: true,
    })),
  )
  const signal = new AbortController().signal

  expect(await searchClaudeGist(workspace, query, false, signal, read, { PATH: root }, fallback)).toEqual({
    matches: [{ path: 'project/source.txt', line: 1, column: 3, text: '🙂[needle]' }],
    truncated: true,
  })
  expect(fallback).toHaveBeenCalledExactlyOnceWith(query, false, signal)
  expect(read.mock.calls).toEqual([['project/linked.txt'], ['project/source.txt']])
})
