// Copyright (c) 2026 The Billy Company
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vite-plus/test'
import { claudeSource } from '../../../backend/tools/assistant/agent-threads/claude.ts'

const { run } = vi.hoisted(() => ({ run: vi.fn<() => Promise<{ stdout: string }>>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}))

test('attaches to an open Claude Code session before its transcript exists', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-claude-threads-')))
  const cwd = path.join(root, 'project with spaces')
  await mkdir(cwd)
  vi.stubEnv('CLAUDE_CONFIG_DIR', root)
  t.onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
  const id = 'cda5083e-c9eb-4b86-8917-d9cae2377aba'
  const startedAt = Date.now() - 10_000
  run.mockResolvedValue({
    stdout: JSON.stringify([{ sessionId: id, cwd, name: 'Proof', status: 'idle', pid: 421, startedAt }]),
  })

  const [session] = await claudeSource.list()
  expect(session).toMatchObject({
    id,
    cwd,
    title: 'Proof',
    provider: 'claude',
    active: true,
    processes: [{ pid: 421, sessionStartedAt: startedAt }],
  })
  if (!session) throw new Error('Missing Claude Code session')
  const reader = claudeSource.open(session)
  expect(await reader.read()).toEqual([])
  await mkdir(path.dirname(session.locator), { recursive: true })
  const writeRecords = (...records: object[]) =>
    appendFile(session.locator, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  await writeRecords(
    { type: 'user', message: { content: 'Edit the example.' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will update the example.' },
          { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'example.txt' } },
        ],
      },
    },
  )
  const file = path.join(cwd, 'example.txt')
  const first = [
    { kind: 'user', text: 'Edit the example.' },
    { kind: 'assistant', text: 'I will update the example.' },
    { kind: 'edit', text: '', toolName: 'Edit', toolDescription: 'Edit example.txt', files: [{ path: file }] },
  ]
  expect(await reader.read()).toEqual(first)

  await writeRecords({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_edit' }] },
    toolUseResult: { filePath: file, structuredPatch: [{ newStart: 3 }] },
  })
  await writeRecords(
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bash',
            name: 'Bash',
            input: {
              description: 'Verify the changed example',
              command: 'cat example.txt',
            },
          },
        ],
      },
    },
    { type: 'system', subtype: 'turn_duration' },
    { type: 'ai-title', aiTitle: 'Saved example changes', cwd },
  )
  expect(await reader.read()).toEqual([
    ...first.slice(0, 2),
    { ...first[2], files: [{ path: file, line: 3 }] },
    { kind: 'tool', text: 'cat example.txt', toolName: 'Bash', toolDescription: 'Verify the changed example' },
    { kind: 'status', text: 'Turn finished' },
  ])

  run.mockResolvedValue({ stdout: '[]' })
  await expect(claudeSource.list()).resolves.toMatchObject([
    { id, cwd, title: 'Saved example changes', provider: 'claude', status: 'recent' },
  ])
})

test('exposes the hunks recorded for successful Claude Code edits', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-claude-edits-'))
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const locator = path.join(cwd, 'session.jsonl')
  const editedFile = path.join(cwd, 'example.txt')
  const createdFile = path.join(cwd, 'new.txt')
  const records = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: editedFile } },
          { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: createdFile } },
          { type: 'tool_use', id: 'failed', name: 'Edit', input: { file_path: editedFile } },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'edit' }] },
      toolUseResult: {
        filePath: editedFile,
        structuredPatch: [
          { oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' before', '-old', '+new', '+another'] },
          {
            oldStart: 22,
            oldLines: 2,
            newStart: 23,
            newLines: 1,
            lines: ['-old tail', ' keep trailing space ', '\\ No newline at end of file'],
          },
        ],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'write' }] },
      toolUseResult: {
        filePath: createdFile,
        type: 'create',
        structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new file'] }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] },
      toolUseResult: {
        filePath: editedFile,
        structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-old', '+rejected'] }],
      },
    },
  ]
  await writeFile(locator, records.map(record => JSON.stringify(record)).join('\n'))
  const reader = claudeSource.open({
    id: 'session',
    provider: 'claude',
    title: 'Example edits',
    cwd,
    locator,
    updatedAt: 0,
  })
  const [edit, write, failed, status] = await reader.read()
  expect(edit?.changes).toEqual([
    {
      path: editedFile,
      line: 3,
      operation: 'update',
      additions: 2,
      deletions: 2,
      diff: '@@ -3,2 +3,3 @@\n before\n-old\n+new\n+another\n@@ -22,2 +23,1 @@\n-old tail\n keep trailing space \n\\ No newline at end of file\n',
    },
  ])
  expect(write?.changes).toEqual([
    { path: createdFile, line: 1, operation: 'add', additions: 1, deletions: 0, diff: '@@ -0,0 +1,1 @@\n+new file\n' },
  ])
  expect(failed?.changes).toBeUndefined()
  expect(status).toEqual({ kind: 'status', text: 'Edit failed' })
})
