import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vite-plus/test'
import { codexSource } from '../../../electron/tools/assistant/agent-threads/codex.ts'

function event(type: string, data: object = {}) {
  return `${JSON.stringify({ type: 'event_msg', payload: { type, ...data } })}\n`
}

test('reads a Codex conversation from its first message without exposing raw model context', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-codex-thread-'))
  const locator = path.join(cwd, 'thread.jsonl')
  try {
    await writeFile(
      locator,
      `${event('task_started')}${event('user_message', { message: 'Read the example.' })}${JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ text: '<internal context>'.repeat(44_000) }] },
      })}\n`,
    )
    const reader = codexSource.open({ provider: 'codex', id: 'thread', cwd, locator, title: 'Thread', updatedAt: 0 })
    await appendFile(
      locator,
      event('exec_command_end', {
        command: ['/bin/zsh', '-lc', 'cat first.ts'],
        parsed_cmd: [{ type: 'read', path: 'first.ts' }],
        aggregated_output: '<private output>',
      }),
    )
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
    const snapshot = [
      { kind: 'status', text: 'Turn started' },
      { kind: 'user', text: 'Read the example.' },
      {
        kind: 'tool',
        text: 'cat first.ts',
        toolName: 'Shell',
        toolDescription: 'Read first.ts',
        files: [{ path: path.join(cwd, 'first.ts') }],
      },
      {
        kind: 'edit',
        text: '',
        toolName: 'apply_patch',
        toolDescription: 'Edit second.ts',
        files: [{ path: path.join(cwd, 'second.ts'), line: 7 }],
      },
    ]
    await expect(reader.read()).resolves.toEqual(snapshot)
    await expect(reader.read()).resolves.toEqual(snapshot)
  } finally {
    await rm(cwd, { force: true, recursive: true })
  }
})

test('displays each public Codex reasoning summary once in transcript order', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-codex-reasoning-'))
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }))
  const locator = path.join(cwd, 'thread.jsonl')
  const thread = { provider: 'codex' as const, id: 'thread', cwd, locator, title: 'Thread', updatedAt: 0 }
  const internalReasoning = '<internal reasoning>'
  const complete = (id: string, summary_text: string[]) =>
    event('item_completed', { item: { type: 'Reasoning', id, summary_text, raw_content: [internalReasoning] } })
  const response = (id: string, summary: string[]) =>
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id,
        summary: [
          ...summary.map(text => ({ type: 'summary_text', text })),
          { type: 'reasoning_text', text: internalReasoning },
        ],
        content: [{ type: 'reasoning_text', text: internalReasoning }],
        encrypted_content: '<encrypted reasoning>',
      },
    })}\n`
  await writeFile(
    locator,
    [
      event('user_message', { message: 'Inspect the workspace.' }),
      complete('current', ['**Inspecting the project**', 'I’ll start with the entry point.']),
      response('current', ['**Inspecting the project**', 'I’ll start with the entry point.']),
      event('agent_message', { message: 'I found the entry point.' }),
      response('legacy', ['**Reviewing the output**']),
      complete('private', []),
      response('private', []),
    ].join(''),
  )

  const reader = codexSource.open(thread)
  const transcript = [
    { kind: 'user', text: 'Inspect the workspace.' },
    { kind: 'thinking', text: '**Inspecting the project**\n\nI’ll start with the entry point.' },
    { kind: 'assistant', text: 'I found the entry point.' },
    { kind: 'thinking', text: '**Reviewing the output**' },
  ]
  await expect(reader.read()).resolves.toEqual(transcript)
  await expect(codexSource.summarize?.(thread)).resolves.toBe('I found the entry point.')

  await appendFile(locator, complete('refresh', ['**Checking the result**']))
  await expect(reader.read()).resolves.toEqual([...transcript, { kind: 'thinking', text: '**Checking the result**' }])
})
