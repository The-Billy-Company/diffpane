import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'
import { cursorSource } from '../../../electron/tools/assistant/agent-threads/cursor.ts'

test('reads Cursor edits from the live conversation before transcript export', async t => {
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
  const firstEdit = { bubbleId: 'edit-1', type: 2, grouping: { toolCallCase: 'editToolCall', toolDisplayPath: first } }
  const secondEdit = {
    bubbleId: 'edit-2',
    type: 2,
    grouping: { toolCallCase: 'editToolCall', toolDisplayPath: second },
  }
  const completed = { toolFormerData: { name: 'edit_file_v2', status: 'completed' } }
  put.run(`bubbleId:${id}:prompt`, JSON.stringify({ text: 'Make two edits.' }))
  put.run(
    headingKey,
    JSON.stringify([prompt, { ...firstEdit, grouping: { ...firstEdit.grouping, toolFormerStatus: 'loading' } }]),
  )
  await expect(reader.read()).resolves.toEqual([{ kind: 'user', text: 'Make two edits.' }])

  put.run(`bubbleId:${id}:edit-1`, JSON.stringify(completed))
  put.run(headingKey, JSON.stringify([prompt, firstEdit]))
  await expect(reader.read()).resolves.toEqual([{ kind: 'edit', text: 'Edited a file', files: [{ path: first }] }])

  put.run(`bubbleId:${id}:edit-2`, JSON.stringify(completed))
  put.run(headingKey, JSON.stringify([prompt, firstEdit, secondEdit]))
  await expect(reader.read()).resolves.toEqual([{ kind: 'edit', text: 'Edited a file', files: [{ path: second }] }])

  const final = { bubbleId: 'reply', type: 2, grouping: { turnDurationMs: 30_000 } }
  put.run(`bubbleId:${id}:reply`, JSON.stringify({ text: 'Done.' }))
  put.run(headingKey, JSON.stringify([prompt, firstEdit, secondEdit, final]))
  await expect(reader.read()).resolves.toEqual([
    { kind: 'assistant', text: 'Done.' },
    { kind: 'status', text: 'Turn finished' },
  ])
  await expect(reader.read()).resolves.toEqual([])
})
