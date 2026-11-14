import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { codexSource } from '../../../electron/tools/assistant/agent-threads/codex.ts'

function event(type: string, data: object = {}) {
  return `${JSON.stringify({ type: 'event_msg', payload: { type, ...data } })}\n`
}

test('tails persisted Codex edits without exposing raw model context or repeating events', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-codex-thread-'))
  const locator = path.join(cwd, 'thread.jsonl')
  try {
    await writeFile(
      locator,
      `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<internal context>' }] } })}\n${event('task_started')}`,
    )
    const reader = codexSource.open({ provider: 'codex', id: 'thread', cwd, locator, title: 'Thread', updatedAt: 0 })
    await expect(reader.read()).resolves.toEqual([{ kind: 'status', text: 'Turn started' }])

    await appendFile(
      locator,
      event('item_completed', {
        item: { type: 'FileChange', status: 'completed', changes: { 'first.ts': { type: 'add' } } },
      }),
    )
    await expect(reader.read()).resolves.toEqual([
      { kind: 'edit', text: 'Edited a file', files: [{ path: path.join(cwd, 'first.ts') }] },
    ])

    await appendFile(
      locator,
      event('item_completed', {
        item: {
          type: 'FileChange',
          status: 'completed',
          changes: { 'second.ts': { type: 'update', unified_diff: '@@ -6,2 +7,3 @@' } },
        },
      }),
    )
    await expect(reader.read()).resolves.toEqual([
      { kind: 'edit', text: 'Edited a file', files: [{ path: path.join(cwd, 'second.ts'), line: 7 }] },
    ])
    await expect(reader.read()).resolves.toEqual([])
  } finally {
    await rm(cwd, { force: true, recursive: true })
  }
})
