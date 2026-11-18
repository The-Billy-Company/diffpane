import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vite-plus/test'
import { summarizeActivity } from '../../../backend/tools/assistant/agent-threads/source.ts'
import type { AgentThreadRecord, AgentThreadSource } from '../../../backend/tools/assistant/agent-threads/source.ts'
import { AgentThreads } from '../../../backend/tools/assistant/agent-threads/threads.ts'
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
  const summarize = vi.fn<NonNullable<AgentThreadSource['summarize']>>().mockResolvedValue({ activity: 'Read app.ts' })
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

  summarize.mockResolvedValue({ activity: 'Edited app.ts' })
  listCodex.mockResolvedValueOnce([{ ...codex, updatedAt: 2 }])
  expect((await tracker.list()).threads[0]).toMatchObject({ id: 'codex:thread', activity: 'Edited app.ts' })

  listCodex.mockRejectedValueOnce(new Error('Storage is temporarily unavailable'))
  const partial = await tracker.list()
  expect(partial.unavailable).toEqual(['codex'])
  expect(partial.threads.map(thread => thread.id)).toEqual(['claude:thread'])
  await expect(tracker.read('codex:thread', 'previous')).resolves.toEqual([])
})

test('links runtime memory only with provider identity evidence and counts idle chat sharing', async () => {
  const started = Date.now() - 10_000
  const observedAt = Date.now()
  const codex: AgentThreadRecord = {
    id: 'working',
    provider: 'codex',
    title: 'App changes',
    cwd: '',
    locator: 'codex.jsonl',
    updatedAt: 4,
    status: 'running',
    action: 'Read app.ts',
    processes: [{ pid: 42, observedAt }],
  }
  const claude: AgentThreadRecord = {
    ...codex,
    id: 'verification',
    provider: 'claude',
    updatedAt: 3,
    action: 'Verify app.ts',
    processes: [{ pid: 50, observedAt, sessionStartedAt: started + 5_000 }],
  }
  const cursor: AgentThreadRecord = {
    ...codex,
    id: 'cursor',
    provider: 'cursor',
    updatedAt: 2,
    action: 'Edit index.ts',
    processes: undefined,
  }
  const listCodex = vi.fn<AgentThreadSource['list']>().mockResolvedValue([
    codex,
    { ...codex, id: 'idle', status: 'idle' },
    {
      ...codex,
      id: 'ambiguous',
      updatedAt: 1,
      processes: [
        { pid: 61, observedAt },
        { pid: 62, observedAt },
      ],
    },
  ])
  const tracker = new AgentThreads([
    ['codex', { list: listCodex, open }],
    ['claude', { list: async () => [claude], open }],
    ['cursor', { list: async () => [cursor], open }],
  ])
  await tracker.list()

  const samples = new Map([
    [42, { residentBytes: 2_000, startedAt: started, executable: '/some scope/codex' }],
    [50, { residentBytes: 1_500, startedAt: started, executable: 'claude' }],
    [61, { residentBytes: 1_000, startedAt: started, executable: 'codex' }],
  ])
  const first = await tracker.memoryActivities(samples)
  expect(first.map(item => item.id)).toEqual([
    'codex:working',
    'claude:verification',
    'cursor:cursor',
    'codex:ambiguous',
  ])
  expect(first[0]).toMatchObject({ action: 'Read app.ts', process: { pid: 42, residentBytes: 2_000, shared: true } })
  expect(first[1]).toMatchObject({ action: 'Verify app.ts', process: { pid: 50, residentBytes: 1_500, shared: false } })
  expect(first[2]).toMatchObject({ action: 'Edit index.ts' })
  expect(first[2]?.process).toBeUndefined()
  expect(first[3]?.process).toBeUndefined()

  samples.set(42, { residentBytes: 2_000, startedAt: started, executable: 'other-process' })
  samples.set(50, { residentBytes: 1_500, startedAt: started - 60_000, executable: 'claude' })
  const second = await tracker.memoryActivities(samples)
  expect(second.every(item => item.process === undefined)).toBe(true)
  expect(listCodex).toHaveBeenCalledTimes(1)

  listCodex.mockRejectedValueOnce(new Error('Unavailable'))
  await tracker.list()
  expect((await tracker.memoryActivities(samples)).map(item => item.id)).toEqual([
    'claude:verification',
    'cursor:cursor',
  ])
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
  await expect(tracker.resolveFile(selection, filename)).resolves.toEqual({ kind: 'target', path: filename })
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
  await expect(tracker.resolveFile(selection, filename, { root: cwd, scope: cwd })).resolves.toEqual({
    kind: 'workspace',
    path: 'app.ts',
  })
  tracker.clear(selection)
  await expect(tracker.update(id, selection)).resolves.toEqual({})
  await expect(tracker.resolveFile(selection, filename)).rejects.toThrow('no longer available')
  expect(close).toHaveBeenCalledTimes(2)
})

test('retains the last tool in the current turn without treating conversation text as a tool action', () => {
  const summary = summarizeActivity([
    { kind: 'user', text: 'Inspect the workspace.' },
    { kind: 'tool', text: '', toolName: 'Read', files: [{ path: 'src/app.ts' }] },
    { kind: 'assistant', text: 'I found the entry point.' },
  ])
  expect(summary).toEqual({ activity: 'I found the entry point.', action: 'Read app.ts' })
  const next = summarizeActivity([
    { kind: 'tool', text: '', toolName: 'Read', files: [{ path: 'src/app.ts' }] },
    { kind: 'status', text: 'Turn finished' },
    { kind: 'user', text: 'Check the tests.' },
  ])
  expect(next).toEqual({ activity: 'Check the tests.', action: undefined })
})

test('opens delegated work only within its parent selection and keeps file links scoped to each transcript', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-delegated-transcript-'))
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const childFilename = path.join(cwd, 'delegate.txt')
  await writeFile(childFilename, 'Delegate contents')
  const parent: AgentThreadRecord = {
    id: 'parent',
    provider: 'codex',
    title: 'Parent chat',
    cwd,
    locator: path.join(cwd, 'parent.jsonl'),
    updatedAt: 1,
  }
  const child: AgentThreadRecord = {
    ...parent,
    id: 'child',
    title: 'Check an example',
    agentName: 'Euler',
    locator: path.join(cwd, 'child.jsonl'),
  }
  const grandchild: AgentThreadRecord = {
    ...parent,
    id: 'grandchild',
    title: 'Check a case',
    agentName: 'Planck',
    locator: path.join(cwd, 'grandchild.jsonl'),
  }
  const close = vi.fn<() => void>()
  const tracker = new AgentThreads([
    [
      'codex',
      {
        list: async () => [parent],
        children: async thread => (thread.id === parent.id ? [child] : thread.id === child.id ? [grandchild] : []),
        open: thread => ({
          close,
          read: async () => [
            {
              kind: 'assistant',
              text: `Reply from ${thread.id}`,
              ...(thread.id === child.id ? { files: [{ path: childFilename }] } : {}),
            },
          ],
        }),
      },
    ],
  ])
  t.onTestFinished(() => tracker.clear())

  expect((await tracker.list()).threads.map(thread => thread.id)).toEqual(['codex:parent'])
  await expect(tracker.read('codex:child', 'outside')).rejects.toThrow('unavailable')
  await tracker.read('codex:parent', 'selected')
  await expect(tracker.children('foreign')).resolves.toEqual([])
  await expect(tracker.children('selected', 'codex:child')).resolves.toEqual([])
  await expect(tracker.read('codex:parent', 'selected', 'codex:child')).rejects.toThrow('unavailable')
  await expect(tracker.children('selected')).resolves.toMatchObject([{ id: 'codex:child', agentName: 'Euler' }])
  await expect(tracker.read('codex:parent', 'foreign', 'codex:child')).rejects.toThrow('unavailable')
  await expect(tracker.read('codex:parent', 'selected', 'codex:child')).resolves.toMatchObject([
    { text: 'Reply from child' },
  ])
  await expect(tracker.resolveFile('selected', childFilename)).rejects.toThrow('no longer available')
  await expect(tracker.resolveFile('selected', childFilename, undefined, 'codex:child')).resolves.toEqual({
    kind: 'target',
    path: await realpath(childFilename),
  })
  await expect(tracker.children('selected', 'codex:child')).resolves.toMatchObject([{ id: 'codex:grandchild' }])
  await expect(tracker.read('codex:parent', 'selected', 'codex:grandchild')).resolves.toMatchObject([
    { text: 'Reply from grandchild' },
  ])
  await tracker.read('codex:parent', 'selected')
  await expect(tracker.update('codex:parent', 'selected', 'codex:child')).resolves.toMatchObject({
    thread: { id: 'codex:child' },
  })
  tracker.clear('selected')
  expect(close).toHaveBeenCalledTimes(4)
  await expect(tracker.resolveFile('selected', childFilename, undefined, 'codex:child')).rejects.toThrow(
    'no longer available',
  )
})
