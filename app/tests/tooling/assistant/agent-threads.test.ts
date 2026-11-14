import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vite-plus/test'
import type { AgentThreadRecord, AgentThreadSource } from '../../../electron/tools/assistant/agent-threads/source.ts'
import { AgentThreads } from '../../../electron/tools/assistant/agent-threads/threads.ts'

const run = promisify(execFile)
const open = () => ({ read: async () => [] })

test('keeps stable cross-provider thread identities and groups worktrees by project', async t => {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-agent-projects-')))
  t.onTestFinished(() => rm(temporary, { force: true, recursive: true }))
  const root = path.join(temporary, 'project')
  const worktree = path.join(temporary, 'worktree')
  const subdirectory = path.join(root, 'src')
  await run('git', ['init', root])
  await run(
    'git',
    [
      '-c',
      'user.name=Diffpane',
      '-c',
      'user.email=test@diffpane.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--allow-empty',
      '-m',
      'Initial commit',
    ],
    { cwd: root },
  )
  await run('git', ['worktree', 'add', '--detach', worktree], { cwd: root })
  await mkdir(subdirectory)

  const codex: AgentThreadRecord = {
    id: 'thread',
    provider: 'codex',
    title: 'App changes',
    cwd: subdirectory,
    locator: 'codex.jsonl',
    updatedAt: 1,
    status: 'running',
  }
  const claude: AgentThreadRecord = {
    ...codex,
    provider: 'claude',
    cwd: worktree,
    locator: 'claude.jsonl',
    status: 'idle',
  }
  const summarize = vi.fn<NonNullable<AgentThreadSource['summarize']>>().mockResolvedValue('Read app.ts')
  const listCodex = vi.fn<AgentThreadSource['list']>().mockResolvedValue([codex])
  const tracker = new AgentThreads([
    ['codex', { list: listCodex, open, summarize }],
    ['claude', { list: async () => [claude], open }],
  ])
  t.onTestFinished(() => tracker.stop())

  const first = await tracker.list()
  expect(first.unavailable).toEqual([])
  expect(first.threads).toMatchObject([
    { id: 'codex:thread', cwd: subdirectory, projectRoot: root, activity: 'Read app.ts', status: 'running' },
    { id: 'claude:thread', cwd: worktree, projectRoot: root, status: 'idle' },
  ])
  expect(await tracker.list()).toEqual(first)
  expect(summarize).toHaveBeenCalledTimes(1)

  summarize.mockResolvedValue('Edited app.ts')
  listCodex.mockResolvedValueOnce([{ ...codex, updatedAt: 2 }])
  expect((await tracker.list()).threads[0]).toMatchObject({ id: 'codex:thread', activity: 'Edited app.ts' })

  listCodex.mockRejectedValueOnce(new Error('Storage is temporarily unavailable'))
  const partial = await tracker.list()
  expect(partial.unavailable).toEqual(['codex'])
  expect(partial.threads.map(thread => thread.id)).toEqual(['claude:thread'])
  expect(() => tracker.follow('codex:thread', 'previous', () => {})).not.toThrow()
})
