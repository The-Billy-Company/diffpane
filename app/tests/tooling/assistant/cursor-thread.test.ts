import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'
import { cursorSource } from '../../../electron/tools/assistant/agent-threads/cursor.ts'

function edit(name: string, file: string) {
  return {
    kind: 'edit',
    text: '',
    toolName: 'Edit',
    toolDescription: `Edit ${name}`,
    files: [{ path: file }],
  }
}

test('reads all Cursor conversation chunks and unwraps user prompts before transcript export', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-cursor-thread-'))
  const locator = path.join(cwd, 'state.vscdb')
  const id = 'af6ffc7e-850f-4cf0-b309-ab27f2a72ec1'
  const writer = new DatabaseSync(locator)
  const reader = cursorSource.open({ id, cwd, locator, provider: 'cursor', title: 'Proof', updatedAt: 0 })
  t.onTestFinished(async () => {
    writer.close()
    await rm(cwd, { recursive: true, force: true })
  })
  writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const put = writer.prepare('INSERT OR REPLACE INTO cursorDiskKV VALUES (?, ?)')
  const headingKey = `composerConvHeaders:${id}:000000`
  const first = path.join(cwd, 'first.txt')
  const second = path.join(cwd, 'second.txt')
  const prompt = { bubbleId: 'prompt', type: 1 }
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
    }),
  )
  put.run(headingKey, JSON.stringify([prompt]))
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

  put.run(`bubbleId:${id}:edit-1`, JSON.stringify(completed))
  put.run(lastChunk, JSON.stringify([firstEdit]))
  const firstResult = edit('first.txt', first)
  const secondResult = edit('second.txt', second)
  await expect(reader.read()).resolves.toEqual([firstPrompt, firstResult])

  put.run(`bubbleId:${id}:edit-2`, JSON.stringify(completed))
  put.run(lastChunk, JSON.stringify([firstEdit, secondEdit]))
  await expect(reader.read()).resolves.toEqual([firstPrompt, firstResult, secondResult])

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
    firstResult,
    secondResult,
    { kind: 'tool', text: 'cat first.txt', toolName: 'Shell', toolDescription: 'Verify the result' },
    { kind: 'assistant', text: 'Done.' },
    { kind: 'status', text: 'Turn finished' },
  ])
})
