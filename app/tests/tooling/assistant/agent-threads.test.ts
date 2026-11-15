import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vite-plus/test'
import type { AgentThreadRecord, AgentThreadSource } from '../../../electron/tools/assistant/agent-threads/source.ts'
import { AgentThreads } from '../../../electron/tools/assistant/agent-threads/threads.ts'
import type { AgentThreadEvent } from '../../../shared/agent-threads.ts'

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
  t.onTestFinished(() => tracker.clear())

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
  await expect(tracker.read('codex:thread', 'previous')).resolves.toEqual([])
})

test('keeps file links authorized while refreshing a selected transcript', async t => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-live-thread-')))
  const locator = path.join(cwd, 'thread.jsonl')
  const filename = path.join(cwd, 'app.ts')
  await Promise.all([writeFile(locator, 'initial'), writeFile(filename, 'preview')])
  const record: AgentThreadRecord = {
    id: 'thread',
    provider: 'codex',
    title: 'Updating a file',
    cwd,
    locator,
    updatedAt: 1,
  }
  const file: AgentThreadEvent = { kind: 'edit', text: '', files: [{ path: 'app.ts' }] }
  const reply: AgentThreadEvent = { kind: 'assistant', text: 'Writing' }
  const completed: AgentThreadEvent = { ...reply, text: 'Writing is complete.' }
  const read = vi.fn<() => Promise<AgentThreadEvent[]>>().mockResolvedValue([file, reply])
  const finished = Promise.withResolvers<AgentThreadEvent[]>()
  const started = Promise.withResolvers<void>()
  const close = vi.fn<() => void>()
  const list = vi.fn<AgentThreadSource['list']>().mockResolvedValueOnce([record]).mockResolvedValue([])
  const tracker = new AgentThreads([['codex', { list, open: () => ({ read, close }) }]])
  t.onTestFinished(async () => {
    finished.resolve([])
    tracker.clear()
    await rm(cwd, { recursive: true, force: true })
  })
  await tracker.list()

  const id = 'codex:thread'
  const selection = 'opened'
  await tracker.read(id, selection)
  await expect(tracker.update(id, selection)).resolves.toMatchObject({ thread: { id, title: record.title } })
  await expect(tracker.update(id, selection)).resolves.toEqual({})
  expect(read).toHaveBeenCalledTimes(1)

  await writeFile(locator, 'updated transcript')
  read.mockImplementationOnce(() => {
    started.resolve()
    return finished.promise
  })
  const update = tracker.update(id, selection)
  await started.promise
  await expect(tracker.file(selection, filename)).resolves.toMatchObject({ text: 'preview' })
  await expect(tracker.update(id, selection)).resolves.toEqual({})
  finished.resolve([file, completed])
  await expect(update).resolves.toMatchObject({ change: { from: 1, events: [completed] } })

  await tracker.list()
  await expect(tracker.read(id, 'other')).rejects.toThrow('unavailable')
  read.mockResolvedValue([file, completed])
  await expect(tracker.read(id, selection)).resolves.toMatchObject([
    { ...file, files: [{ path: filename }] },
    completed,
  ])
  await expect(tracker.file(selection, filename)).resolves.toMatchObject({ text: 'preview' })
  tracker.clear(selection)
  await expect(tracker.update(id, selection)).resolves.toEqual({})
  await expect(tracker.file(selection, filename)).rejects.toThrow('no longer available')
  expect(close).toHaveBeenCalledTimes(2)
})
