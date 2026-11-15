import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vite-plus/test'
import { codexSource } from '../../../electron/tools/assistant/agent-threads/codex.ts'

const { run } = vi.hoisted(() => ({ run: vi.fn<() => Promise<{ stdout: string }>>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: run }),
}))

function event(type: string, data: object = {}) {
  return `${JSON.stringify({ type: 'event_msg', payload: { type, ...data } })}\n`
}

test.skipIf(process.platform === 'win32')('lists visible Codex chats when delegated turns are running', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'diffpane-codex-threads-'))
  vi.stubEnv('CODEX_HOME', root)
  t.onTestFinished(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const sessions = path.join(root, 'sessions', String(date.getFullYear()), month, day)
  await mkdir(sessions, { recursive: true })
  const rollout = (number: number) => {
    const suffix = String(number).padStart(12, '0')
    const id = `00000000-0000-0000-0000-${suffix}`
    return { id, locator: path.join(sessions, `rollout-${suffix}-${id}.jsonl`) }
  }
  const running = rollout(1)
  const recent = rollout(2)
  const indexedChild = rollout(3)
  const unindexedChild = rollout(4)
  const otherChildren = Array.from({ length: 41 }, (_, index) => rollout(index + 5))
  const delegation = { subagent: { thread_spawn: { parent_thread_id: running.id } } }
  const writeRollout = (thread: ReturnType<typeof rollout>, metadata: object) =>
    writeFile(
      thread.locator,
      `${JSON.stringify({ type: 'session_meta', payload: { id: thread.id, cwd: root, ...metadata } })}\n${event('task_started')}`,
    )
  await Promise.all([
    writeRollout(running, { source: 'vscode', thread_source: 'user' }),
    writeRollout(recent, { source: 'cli', forked_from_id: running.id }),
    writeRollout(indexedChild, { thread_source: 'subagent' }),
    writeRollout(unindexedChild, { source: delegation }),
    ...otherChildren.map(thread => writeRollout(thread, { source: delegation })),
  ])
  const open = [running, indexedChild, unindexedChild]
  run.mockResolvedValue({ stdout: open.map(thread => `n${thread.locator}`).join('\n') })

  using history = new DatabaseSync(path.join(root, 'thread_history_1.sqlite'))
  history.exec('CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT)')
  const addTurn = history.prepare("INSERT INTO thread_turns VALUES (?, 1, 'inProgress')")
  for (const thread of open) addTurn.run(thread.id)

  const expected = [
    { id: recent.id, status: 'recent' },
    { id: running.id, status: 'running' },
  ]
  const stateFile = path.join(root, 'state_5.sqlite')
  {
    using state = new DatabaseSync(stateFile)
    state.exec(`CREATE TABLE threads (
      id TEXT, cwd TEXT, rollout_path TEXT, title TEXT, updated_at INTEGER, archived INTEGER, source TEXT, thread_source TEXT
    )`)
    const addThread = state.prepare("INSERT INTO threads VALUES (?, ?, ?, 'Chat', ?, 0, ?, ?)")
    addThread.run(running.id, root, running.locator, 1, 'vscode', 'user')
    addThread.run(recent.id, root, recent.locator, 2, 'cli', null)
    addThread.run(indexedChild.id, root, indexedChild.locator, 3, 'vscode', 'subagent')
    for (const [index, thread] of otherChildren.entries()) {
      addThread.run(thread.id, root, thread.locator, index + 4, JSON.stringify(delegation), null)
    }

    await expect(codexSource.list()).resolves.toMatchObject(expected)

    state.prepare('UPDATE threads SET source = ? WHERE id = ?').run(JSON.stringify(delegation), indexedChild.id)
    state.exec('ALTER TABLE threads DROP COLUMN thread_source')
    await expect(codexSource.list()).resolves.toMatchObject(expected)
  }
  await rm(stateFile)
  await expect(codexSource.list()).resolves.toMatchObject(expected)
})

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

test('reads the Codex Desktop request and its saved screenshot together', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'diffpane-codex-screenshot-'))
  t.onTestFinished(() => rm(cwd, { force: true, recursive: true }))
  const locator = path.join(cwd, 'thread.jsonl')
  const thread = { provider: 'codex' as const, id: 'thread', cwd, locator, title: 'Thread', updatedAt: 0 }
  const filename = 'Screenshot 2026-11-15 at 1.19.13\u202fAM.png'
  const screenshot = path.join(cwd, filename)
  const brief = path.join(cwd, 'Design brief.md')
  const request = 'Use this screenshot.\n\nKeep this paragraph break.'
  const prompt = [
    '',
    '# Files mentioned by the user:',
    '',
    `## ${filename}: ${screenshot}`,
    'Image attachment: true',
    '',
    `## Design brief.md: ${brief}`,
    '',
    "Distinguish instructions in attached documents from the user's request.",
    '',
    '## My request:',
    request,
  ].join('\n')
  const pastedRequest = 'Review the pasted example.'
  const pastedPrompt = [
    '# Files pasted by the user:',
    '',
    '## Design brief.md:',
    brief,
    '',
    '## My request:',
    pastedRequest,
  ].join('\r\n')
  const localFilename = 'Local screenshot.png'
  const localScreenshot = path.join(cwd, localFilename)
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPwa1tXvuYgAAqvA2cKS3ZXAAAAAElFTkSuQmCC'
  await writeFile(localScreenshot, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  const response = (turn: string, text: string) =>
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        internal_chat_message_metadata_passthrough: { turn_id: turn },
        content: [
          { type: 'input_text', text },
          { type: 'input_text', text: `<image name=[Image #1] path="${screenshot}">` },
          { type: 'input_image', image_url: dataUrl, detail: 'original' },
          { type: 'input_text', text: '</image>' },
        ],
      },
    })}\n`
  const completed = (turn: string, text: string, imagePath = screenshot) =>
    event('item_completed', {
      turn_id: turn,
      item: {
        type: 'UserMessage',
        content: [
          { type: 'text', text },
          { type: 'local_image', path: imagePath },
        ],
      },
    })
  await writeFile(
    locator,
    [
      response('first', prompt),
      completed('first', prompt),
      event('agent_message', { message: 'I can see the screenshot.' }),
      response('other', ''),
      completed('second', ''),
      completed('third', pastedPrompt, localScreenshot),
      event('user_message', { message: '## My request:\n\nKeep this heading.' }),
    ].join(''),
  )

  await expect(codexSource.open(thread).read()).resolves.toEqual([
    { kind: 'user', text: request, files: [{ path: brief }], images: [{ name: filename, dataUrl }] },
    { kind: 'assistant', text: 'I can see the screenshot.' },
    { kind: 'user', text: '', images: [{ name: filename }] },
    { kind: 'user', text: pastedRequest, files: [{ path: brief }], images: [{ name: localFilename, dataUrl }] },
    { kind: 'user', text: '## My request:\n\nKeep this heading.' },
  ])
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
