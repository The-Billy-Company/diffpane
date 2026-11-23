// Copyright (c) 2026 The Billy Company
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'
import { cursorSource } from '../../../backend/tools/assistant/agent-threads/cursor.ts'

function edit(name: string, file: string) {
  return {
    kind: 'edit',
    text: '',
    toolName: 'Edit',
    toolDescription: `Edit ${name}`,
    files: [{ path: file }],
  }
}

function snapshot(digit: string) {
  return `composer.content.${digit.repeat(64)}`
}

test('reads all Cursor conversation chunks and unwraps user prompts before transcript export', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-cursor-thread-'))
  const locator = path.join(cwd, 'state.vscdb')
  const id = 'af6ffc7e-850f-4cf0-b309-ab27f2a72ec1'
  const writer = new DatabaseSync(locator)
  const reader = cursorSource.open({ id, cwd, locator, provider: 'cursor', title: 'Proof', updatedAt: 0 })
  t.onTestFinished(async () => {
    reader.close?.()
    writer.close()
    await rm(cwd, { recursive: true, force: true })
  })
  writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const put = writer.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)')
  const headingKey = `composerConvHeaders:${id}:000000`
  const first = path.join(cwd, 'first.txt')
  const second = path.join(cwd, 'second.txt')
  const prompt = { bubbleId: 'prompt', type: 1 }
  const thought = { bubbleId: 'turn/0:thinking', type: 2, grouping: { hasThinking: true, isRenderable: true } }
  const firstEdit = { bubbleId: 'edit-1', type: 2, grouping: { toolCallCase: 'editToolCall', toolDisplayPath: first } }
  const secondEdit = {
    bubbleId: 'edit-2',
    type: 2,
    grouping: { toolCallCase: 'editToolCall', toolDisplayPath: second },
  }
  const completed = { toolFormerData: { name: 'edit_file_v2', status: 'completed' } }
  put.run(
    `bubbleId:${id}:prompt`,
    JSON.stringify({
      text: '<timestamp>2026-11-14</timestamp>\n<system_notification>Internal context</system_notification>\n<user_query>Make two edits.</user_query>',
      thinking: { text: '<user metadata>' },
    }),
  )
  put.run(headingKey, JSON.stringify([prompt, thought]))
  for (const chunk of ['000001', '000002', '000003']) {
    put.run(`composerConvHeaders:${id}:${chunk}`, '[]')
  }
  const lastChunk = `composerConvHeaders:${id}:000004`
  const firstPrompt = { kind: 'user', text: 'Make two edits.' }
  put.run(
    lastChunk,
    JSON.stringify([{ ...firstEdit, grouping: { ...firstEdit.grouping, toolFormerStatus: 'loading' } }]),
  )
  await expect(reader.read()).resolves.toEqual([firstPrompt])
  await expect(reader.readUpdate?.()).resolves.toBeUndefined()

  put.run(
    `bubbleId:${id}:${thought.bubbleId}`,
    JSON.stringify({
      thinking: { text: 'I’ll update both files.', signature: '<signature>' },
      allThinkingBlocks: [{ text: '<internal context>' }],
    }),
  )
  put.run(`bubbleId:${id}:edit-1`, JSON.stringify(completed))
  put.run(lastChunk, JSON.stringify([firstEdit]))
  const thinking = { kind: 'thinking', text: 'I’ll update both files.' }
  const firstResult = edit('first.txt', first)
  const secondResult = edit('second.txt', second)
  await expect(reader.readUpdate?.()).resolves.toEqual([firstPrompt, thinking, firstResult])
  await expect(reader.readUpdate?.()).resolves.toBeUndefined()

  // A streaming bubble can grow without changing any conversation headers.
  const revisedThinking = { kind: 'thinking', text: 'I’ll update both files. The first edit is ready.' }
  writer.exec('BEGIN')
  put.run(`bubbleId:${id}:${thought.bubbleId}`, JSON.stringify({ thinking: { text: revisedThinking.text } }))
  await expect(reader.readUpdate?.()).resolves.toBeUndefined()
  writer.exec('COMMIT')
  await expect(reader.readUpdate?.()).resolves.toEqual([firstPrompt, revisedThinking, firstResult])

  put.run(`bubbleId:${id}:edit-2`, JSON.stringify(completed))
  put.run(lastChunk, JSON.stringify([firstEdit, secondEdit]))
  await expect(reader.readUpdate?.()).resolves.toEqual([firstPrompt, revisedThinking, firstResult, secondResult])

  const final = { bubbleId: 'reply', type: 2, grouping: { turnDurationMs: 30_000 } }
  const shell = { bubbleId: 'run-shell', type: 2, grouping: { toolCallCase: 'shellToolCall' } }
  put.run(
    `bubbleId:${id}:run-shell`,
    JSON.stringify({
      toolFormerData: {
        name: 'run_terminal_command_v2',
        status: 'completed',
        params: {
          commandDescription: 'Verify the result',
          command: 'cat first.txt',
        },
        result: '<private output>',
      },
    }),
  )
  put.run(`bubbleId:${id}:reply`, JSON.stringify({ text: 'Done.' }))
  put.run(lastChunk, JSON.stringify([firstEdit, secondEdit, shell, final]))
  await expect(reader.read()).resolves.toEqual([
    firstPrompt,
    revisedThinking,
    firstResult,
    secondResult,
    { kind: 'tool', text: 'cat first.txt', toolName: 'Shell', toolDescription: 'Verify the result' },
    { kind: 'assistant', text: 'Done.' },
    { kind: 'status', text: 'Turn finished' },
  ])
})

test('keeps Cursor turns running between tool calls while the saved run is unfinished', async () => {
  const userDirectory = await mkdtemp(path.join(tmpdir(), 'diffpane-cursor-list-'))
  const storage = path.join(userDirectory, 'globalStorage')
  const projects = path.join(userDirectory, 'projects')
  const id = 'af6ffc7e-850f-4cf0-b309-ab27f2a72ec1'
  const secondId = '46e67027-93e9-4879-a977-9ced7f6f14b6'
  const now = Date.now()

  try {
    await mkdir(storage)
    using writer = new DatabaseSync(path.join(storage, 'state.vscdb'))
    writer.exec(`
      CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, lastUpdatedAt INTEGER, isArchived INTEGER, value TEXT);
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    `)
    const header = writer.prepare('INSERT OR REPLACE INTO composerHeaders VALUES (?, ?, ?, 0, ?)')
    const put = writer.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)')
    const updateHeading = (createdAt: number, grouping = {}) => {
      const bubble = { bubbleId: 'tail', createdAt: new Date(createdAt).toISOString(), type: 2, grouping }
      put.run(`composerConvHeaders:${id}:000000`, JSON.stringify([bubble]))
    }
    const stateKey = `composerData:${id}`
    const assertStatus = async (status: 'running' | 'recent') => {
      const items = new Map((await cursorSource.list(userDirectory, projects)).map(item => [item.id, item]))
      expect(items.get(id)?.status).toBe(status)
      expect(items.get(secondId)).toMatchObject({ status: 'running', active: true })
    }
    header.run(id, '', now, JSON.stringify({ name: 'Cursor desktop turn' }))
    header.run(secondId, '', now, JSON.stringify({ name: 'Another running turn' }))
    put.run(`composerData:${secondId}`, JSON.stringify({ status: 'generating' }))
    put.run(stateKey, JSON.stringify({ status: 'aborted', unfinishedRunAt: now - 2_000 }))
    updateHeading(now - 3_000, { turnDurationMs: 500 })
    await assertStatus('recent')

    updateHeading(now - 1_500, { toolFormerStatus: 'loading' })
    await assertStatus('running')
    updateHeading(now - 1_000, { toolFormerStatus: 'completed' })
    await assertStatus('running')
    updateHeading(now - 500)
    await assertStatus('running')

    header.run(id, '', now, JSON.stringify({ hasBlockingPendingActions: true }))
    await assertStatus('recent')
    header.run(id, '', now, '{}')
    updateHeading(now, { turnDurationMs: 2_000 })
    await assertStatus('recent')

    put.run(stateKey, JSON.stringify({ status: 'aborted' }))
    updateHeading(now)
    await assertStatus('recent')

    const stale = now - 10 * 60 * 1000
    put.run(stateKey, JSON.stringify({ status: 'aborted', unfinishedRunAt: stale }))
    updateHeading(stale, { toolFormerStatus: 'loading' })
    await assertStatus('recent')
  } finally {
    await rm(userDirectory, { recursive: true, force: true })
  }
})

test('reads completed Cursor edits from saved snapshots and falls back to recorded additions', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-cursor-edits-'))
  const locator = path.join(cwd, 'state.vscdb')
  const id = 'af6ffc7e-850f-4cf0-b309-ab27f2a72ec1'
  const writer = new DatabaseSync(locator)
  const reader = cursorSource.open({ id, cwd, locator, provider: 'cursor', title: 'Proof', updatedAt: 0 })
  t.onTestFinished(async () => {
    reader.close?.()
    writer.close()
    await rm(cwd, { recursive: true, force: true })
  })
  writer.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const put = writer.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
  put.run(snapshot('a'), 'keep\nold\n')
  put.run(snapshot('b'), 'keep\nnew\n')
  const records = [
    {
      path: 'updated.txt',
      status: 'completed',
      result: { beforeContentId: snapshot('a'), afterContentId: snapshot('b') },
      counts: { editLinesAdded: 1, editLinesRemoved: 1 },
    },
    {
      path: 'created.txt',
      status: 'completed',
      result: { afterContentId: snapshot('c') },
      additionalData: {
        precomputedDiff: {
          hasChanges: true,
          lines: [{ type: 'added', content: 'new file', modifiedLineNumber: 1 }],
        },
      },
    },
    {
      path: 'failed.txt',
      status: 'error',
      result: { afterContentId: snapshot('b') },
      counts: { editLinesAdded: 4, editLinesRemoved: 1 },
    },
    {
      path: 'counts-only.txt',
      status: 'completed',
      result: { beforeContentId: snapshot('d'), afterContentId: snapshot('e') },
      counts: { editLinesAdded: 6, editLinesRemoved: 0 },
    },
  ]
  const headings = records.map(({ path: filename, status, result, counts, additionalData }, index) => {
    const bubbleId = `edit-${index}`
    put.run(
      `bubbleId:${id}:${bubbleId}`,
      JSON.stringify({
        toolFormerData: { name: 'edit_file_v2', status, result: JSON.stringify(result), additionalData },
      }),
    )
    return { bubbleId, type: 2, grouping: { toolCallCase: 'editToolCall', toolDisplayPath: filename, ...counts } }
  })
  put.run(`composerConvHeaders:${id}:000000`, JSON.stringify(headings))

  const [updated, created, failed, withoutSnapshot] = await reader.read()
  expect(updated?.changes).toEqual([
    {
      path: 'updated.txt',
      operation: 'update',
      line: 2,
      additions: 1,
      deletions: 1,
      diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n',
    },
  ])
  expect(created?.changes).toEqual([
    {
      path: 'created.txt',
      operation: 'add',
      line: 1,
      additions: 1,
      deletions: 0,
      diff: '@@ -0,0 +1,1 @@\n+new file\n',
    },
  ])
  expect(failed).toMatchObject({ kind: 'edit', toolDescription: 'Edit failed.txt (error)' })
  expect(failed?.changes).toBeUndefined()
  expect(withoutSnapshot?.changes).toEqual([
    { path: 'counts-only.txt', operation: 'update', additions: 6, deletions: 0 },
  ])
})

test('shows requested changes from Cursor JSONL logs that omit tool results', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-cursor-jsonl-'))
  t.onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const locator = path.join(cwd, 'thread.jsonl')
  const prompt = { role: 'user', message: { content: [{ type: 'text', text: 'Update the sample.' }] } }
  const request = {
    role: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'StrReplace',
          input: { path: 'sample.txt', old_string: 'line one', new_string: 'line two' },
        },
      ],
    },
  }
  await writeFile(locator, `${JSON.stringify(prompt)}\n${JSON.stringify(request)}\n`)
  const reader = cursorSource.open({
    id: 'af6ffc7e-850f-4cf0-b309-ab27f2a72ec1',
    cwd,
    locator,
    provider: 'cursor',
    title: 'Proof',
    updatedAt: 0,
  })
  const [, event] = await reader.read()
  expect(event).toMatchObject({
    kind: 'edit',
    toolName: 'StrReplace',
    files: [{ path: 'sample.txt' }],
    text: 'Requested change\n-line one\n+line two',
  })
  expect(event?.changes).toBeUndefined()
})
