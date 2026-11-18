import assert from 'node:assert/strict'
import { expect, test, vi } from 'vite-plus/test'
import { ClaudeSession } from '../../../backend/tools/assistant/claude-session.mjs'
import type {
  ClaudeActivity,
  ClaudeWorkspace,
  ProposalWorkspace,
} from '../../../backend/tools/assistant/claude-session.mjs'
import { createDiagnostics } from '../../../shared/diagnostics/diagnostics.ts'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'

const key = () => Promise.resolve('test-key')

function textBlock(index: number, ...parts: string[]) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ...parts.map(text => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index },
  ]
}

function toolBlock(index: number, id: string, name: string, ...parts: string[]) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    ...parts.map(partial_json => ({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json },
    })),
    { type: 'content_block_stop', index },
  ]
}

function stream(stop_reason: 'tool_use' | 'end_turn' | 'max_tokens', blocks: readonly { type: string }[]) {
  return eventStream([
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason } },
    { type: 'message_stop' },
  ])
}

function eventStream(events: readonly ({ type: string } & Record<string, unknown>)[]) {
  const encoded = new TextEncoder().encode(
    events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across event names, JSON, and UTF-8 bytes as a network stream can.
        for (let offset = 0; offset < encoded.length; offset += 13)
          controller.enqueue(encoded.subarray(offset, offset + 13))
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const emptyWorkspace = {
  list: async () => ({ paths: [], truncated: false }),
  read: async () => '',
  search: async () => ({ matches: [], truncated: false }),
  checkCreate: async () => {},
  listIdeas: async () => [],
  readIdea: async () => undefined,
} satisfies ClaudeWorkspace

function requestBody(request: RequestInit | undefined) {
  if (typeof request?.body !== 'string') throw new Error('Expected a Claude request')
  return request.body
}

function toolResult(request: RequestInit | undefined, id: string) {
  const payload: unknown = JSON.parse(requestBody(request))
  assert.ok(payload && typeof payload === 'object' && 'messages' in payload && Array.isArray(payload.messages))
  const messages: unknown[] = payload.messages
  const message = messages.at(-1)
  assert.ok(message && typeof message === 'object' && 'content' in message && Array.isArray(message.content))
  const blocks: unknown[] = message.content
  const block = blocks.find(
    entry => entry && typeof entry === 'object' && 'tool_use_id' in entry && entry.tool_use_id === id,
  )
  assert.ok(
    block && typeof block === 'object' && 'content' in block && typeof block.content === 'string',
    `Missing tool result ${id}`,
  )
  return { content: block.content, isError: 'is_error' in block && block.is_error === true }
}

test('reset releases the active turn without letting the old completion unlock its replacement', async t => {
  const oldKey = Promise.withResolvers<string>()
  const newKey = Promise.withResolvers<string>()
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(stream('end_turn', textBlock(0, 'New reply')))
  t.onTestFinished(() => fetch.mockRestore())
  const session = new ClaudeSession()

  const first = session.send({ prompt: 'First' }, () => oldKey.promise, emptyWorkspace).catch((error: unknown) => error)
  session.reset()
  const second = session.send({ prompt: 'Second' }, () => newKey.promise, emptyWorkspace)
  oldKey.resolve('old-key')
  expect(await first).toMatchObject({ message: 'Request canceled.' })
  await expect(session.send({ prompt: 'Third' }, key, emptyWorkspace)).rejects.toThrow('The Creature is still working')
  newKey.resolve('new-key')

  expect(await second).toMatchObject({ text: 'New reply' })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]?.body).not.toContain('First')
})

test('a stream cannot run tool calls from content arriving after the message delta', async t => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      eventStream([
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ...toolBlock(0, 'file', 'read_file', '{"path":"file.txt"}'),
        { type: 'message_stop' },
      ]),
    )
  t.onTestFinished(() => fetch.mockRestore())
  const read = vi.fn<ClaudeWorkspace['read']>(emptyWorkspace.read)

  await expect(new ClaudeSession().send({ prompt: 'Read the file' }, key, { ...emptyWorkspace, read })).rejects.toThrow(
    'Claude returned an incomplete or invalid response',
  )
  expect(read).not.toHaveBeenCalled()
})

test('streams ordered activity and fetches attached workspace content only when the model asks for it', async t => {
  const source = ['Unselected line', 'Selected line α', 'Selected line β', 'Another unselected line'].join('\n')
  const idea = {
    id: 'next-step',
    title: 'Next step',
    body: 'Idea introduction\nOne Markdown task\nOther idea detail',
    links: [{ path: 'src/main.ts', line: 2, excerpt: 'Captured code' }],
    createdAt: 1,
    updatedAt: 2,
  }
  const read = vi.fn<ClaudeWorkspace['read']>(async () => source)
  const readIdea = vi.fn<ClaudeWorkspace['readIdea']>(async () => idea)
  const list = vi.fn<ClaudeWorkspace['list']>(async () => [])
  const workspace = { ...emptyWorkspace, list, read, listIdeas: list, readIdea }
  const requests: string[] = []
  const inspectionsPerRequest: number[][] = []
  const responses = [
    stream('tool_use', [
      ...textBlock(0, 'I’ll check ', 'both references.'),
      ...toolBlock(1, 'file', 'read_file'),
      ...toolBlock(2, 'idea', 'read_idea', '{"start_line":', '2,"end_line":2}'),
    ]),
    stream('end_turn', textBlock(0, 'The two ', 'agree.')),
    stream('end_turn', textBlock(0, 'Yes.')),
  ]
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, request) => {
    const response = responses[requests.length]
    const body = request?.body
    if (typeof body !== 'string' || !response) throw new Error('Unexpected request')
    requests.push(body)
    inspectionsPerRequest.push([read.mock.calls.length, readIdea.mock.calls.length])
    return Promise.resolve(response)
  })
  t.onTestFinished(() => {
    fetch.mockRestore()
  })

  const diagnostics: DiagnosticEvent[] = []
  const session = new ClaudeSession(createDiagnostics('main', event => diagnostics.push(event)))
  const activity: ClaudeActivity[] = []
  const result = await session.send(
    {
      requestId: 'first',
      prompt: 'Does this selection agree with my idea?',
      fileContext: { path: 'src/main.ts', side: 'head', startLine: 2, endLine: 3 },
      ideaId: idea.id,
    },
    key,
    workspace,
    event => activity.push(event),
  )

  expect(result).toMatchObject({ step: 1, text: 'The two agree.' })
  expect(read).toHaveBeenCalledExactlyOnceWith('src/main.ts', 'head')
  expect(readIdea).toHaveBeenCalledExactlyOnceWith(idea.id)
  expect(list).not.toHaveBeenCalled()
  expect(
    activity.map(event => {
      if (event.type === 'text') return [event.step, event.text]
      if (event.type === 'mode') return [event.step, event.mode]
      return [event.step, event.id, event.status]
    }),
  ).toEqual([
    [0, 'I’ll check '],
    [0, 'both references.'],
    [0, 'file', 'running'],
    [0, 'file', 'done'],
    [0, 'idea', 'running'],
    [0, 'idea', 'done'],
    [1, 'The two '],
    [1, 'agree.'],
  ])
  expect(activity[3]).toMatchObject({ requestId: 'first', path: 'src/main.ts', side: 'head', startLine: 2, endLine: 3 })
  expect(diagnostics.map(event => event.operation)).toEqual([
    'assistant.first-response',
    'assistant.model.request',
    'assistant.tool.read-file',
    'assistant.tool.read-idea',
    'assistant.model.request',
  ])
  expect(JSON.stringify(diagnostics)).not.toMatch(/src\/main\.ts|Selected line|Does this selection|test-key/u)

  const [initial = '', continuation = ''] = requests
  expect(initial).toContain("You are The Creature. You live in the user's code and help them figure things out.")
  expect(initial).toContain('Speak like a friendly caveman')
  expect(initial).toContain('I am the creature.')
  expect(initial).toContain('src/main.ts')
  expect(initial).toContain(idea.id)
  expect(initial).not.toContain('Selected line α')
  expect(initial).not.toContain('One Markdown task')
  expect(continuation).toContain('Selected line α')
  expect(continuation).toContain('Selected line β')
  expect(continuation).toContain('One Markdown task')
  expect(continuation).not.toContain('Unselected line')
  expect(continuation).not.toContain('Other idea detail')
  expect(continuation).not.toContain('Captured code')

  await session.send({ prompt: 'Can we continue?' }, key, workspace)
  const next = requests[2] ?? ''
  expect(inspectionsPerRequest).toEqual([
    [0, 0],
    [1, 1],
    [1, 1],
  ])
  expect(next).toContain('The two agree.')
  expect(next).toContain('Can we continue?')
  expect(next).not.toContain('Selected line α')
  expect(next).not.toContain('One Markdown task')
  expect(next).not.toContain('tool_result')
})

test('reads explicit file ranges in a batch and records the returned working excerpts as edit evidence', async t => {
  const files = [
    { path: 'first.txt', start_line: 2, end_line: 2 },
    { path: '.env' },
    { path: 'missing.txt' },
    { path: 'first.txt', side: 'head', start_line: 1, end_line: 1 },
    { path: 'first.txt', start_line: 3, end_line: 3 },
  ]
  const read = vi.fn<ClaudeWorkspace['read']>(async (path, side) => {
    if (path === 'missing.txt') throw new Error('ENOENT: /private/workspace/missing.txt')
    if (side === 'head') return 'HEAD line\nOther HEAD line'
    return 'Unrequested line\nWorking line\nAnother working line'
  })
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(stream('tool_use', toolBlock(0, 'batch', 'read_files', JSON.stringify({ files }))))
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(
          0,
          'unread-edit',
          'edit_files',
          '{"files":[{"path":"first.txt","edits":[{"before":"Unrequested line","after":"No"}]}]}',
        ),
        ...toolBlock(
          1,
          'read-edit',
          'edit_files',
          '{"files":[{"path":"first.txt","edits":[{"before":"Working line","after":"Updated"}]}]}',
        ),
      ]),
    )
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature prepared the edit.')))
  t.onTestFinished(() => fetch.mockRestore())

  const session = new ClaudeSession()
  const result = await session.send(
    { prompt: 'Read these ranges and update the working line', proposeEdits: true },
    key,
    { ...emptyWorkspace, read },
  )

  expect(requestBody(fetch.mock.calls[0]?.[1])).toContain('"name":"read_files"')
  expect(read).toHaveBeenCalledTimes(3)
  expect(read).toHaveBeenCalledWith('first.txt', 'working')
  expect(read).toHaveBeenCalledWith('first.txt', 'head')
  expect(read).toHaveBeenCalledWith('missing.txt', 'working')
  const batch = toolResult(fetch.mock.calls[1]?.[1], 'batch')
  expect(batch.isError).toBe(false)
  expect(batch.content).not.toMatch(/Unrequested line|Other HEAD line|\/private\/workspace/u)
  expect(JSON.parse(batch.content)).toMatchObject({
    files: [
      { path: 'first.txt', side: 'working', startLine: 2, endLine: 2, text: 'Working line' },
      { error: 'Supply the path of a project text file.' },
      { path: 'missing.txt', error: 'This project text file could not be read.' },
      { path: 'first.txt', side: 'head', startLine: 1, endLine: 1, text: 'HEAD line' },
      { path: 'first.txt', side: 'working', startLine: 3, endLine: 3, text: 'Another working line' },
    ],
    truncated: false,
  })
  expect(toolResult(fetch.mock.calls[2]?.[1], 'unread-edit').isError).toBe(true)
  expect(result.proposal).toMatchObject({
    kind: 'files',
    files: [{ path: 'first.txt', edits: [{ startLine: 2, before: 'Working line\n' }] }],
  })
})

test('an invalid batch range lets a later batch read see the updated file', async t => {
  const read = vi
    .fn<ClaudeWorkspace['read']>()
    .mockResolvedValueOnce('Old line')
    .mockResolvedValueOnce('Old line\nNew line')
  const batch = '{"files":[{"path":"file.txt","start_line":2,"end_line":2}]}'
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(stream('tool_use', toolBlock(0, 'before-change', 'read_files', batch)))
    .mockResolvedValueOnce(stream('tool_use', toolBlock(0, 'after-change', 'read_files', batch)))
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature found the new line.')))
  t.onTestFinished(() => fetch.mockRestore())

  await new ClaudeSession().send({ prompt: 'Read line 2' }, key, { ...emptyWorkspace, read })

  expect(read).toHaveBeenCalledTimes(2)
  expect(JSON.parse(toolResult(fetch.mock.calls[1]?.[1], 'before-change').content)).toMatchObject({
    files: [{ path: 'file.txt', error: 'This text has 1 lines.' }],
  })
  expect(JSON.parse(toolResult(fetch.mock.calls[2]?.[1], 'after-change').content)).toMatchObject({
    files: [{ path: 'file.txt', startLine: 2, endLine: 2, text: 'New line' }],
  })
})

test('bounds serialized batch excerpts and excludes omitted text from edit evidence', async t => {
  const files = Array.from({ length: 8 }, (_, index) => ({ path: `file${index}.txt` }))
  const prefix = 'Visible prefix '
  const suffix = 'Omitted suffix'
  const read = vi.fn<ClaudeWorkspace['read']>(async () => `${prefix}${'"'.repeat(6400)}${suffix}`)
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(stream('tool_use', toolBlock(0, 'batch', 'read_files', JSON.stringify({ files }))))
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(
          0,
          'omitted',
          'edit_files',
          '{"files":[{"path":"file0.txt","edits":[{"before":"Omitted suffix","after":"No"}]}]}',
        ),
        ...toolBlock(
          1,
          'visible',
          'edit_files',
          '{"files":[{"path":"file7.txt","edits":[{"before":"Visible prefix","after":"Yes"}]}]}',
        ),
      ]),
    )
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature prepared the edit.')))
  t.onTestFinished(() => fetch.mockRestore())

  const result = await new ClaudeSession().send(
    { prompt: 'Read all files in a batch and update a line', proposeEdits: true },
    key,
    { ...emptyWorkspace, read },
  )

  const batch = toolResult(fetch.mock.calls[1]?.[1], 'batch')
  expect(batch.isError).toBe(false)
  expect(batch.content.length).toBeLessThanOrEqual(28_000)
  expect(batch.content).not.toContain(suffix)
  expect(JSON.parse(batch.content)).toMatchObject({
    files: files.map(file => ({ path: file.path, startLine: 1, truncated: true })),
    truncated: true,
  })
  expect(toolResult(fetch.mock.calls[2]?.[1], 'omitted').isError).toBe(true)
  expect(result.proposal).toMatchObject({ kind: 'files', files: [{ path: 'file7.txt' }] })
})

test('sends an exact phrase to Gist and exposes its locations without granting edit evidence', async t => {
  const query = ' --[Needle] '
  const matches = [{ path: 'src/example.ts', line: 3, column: 2, text: 'x --[Needle] y' }]
  const search = vi.fn<ClaudeWorkspace['search']>(async () => ({ matches, truncated: true }))
  const read = vi.fn<ClaudeWorkspace['read']>(emptyWorkspace.read)
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(0, 'search', 'search_files', JSON.stringify({ query })),
        ...toolBlock(
          1,
          'edit',
          'edit_files',
          '{"files":[{"path":"src/example.ts","edits":[{"before":"x --[Needle] y","after":"Updated"}]}]}',
        ),
      ]),
    )
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature found a match.')))
  t.onTestFinished(() => fetch.mockRestore())

  const activity: ClaudeActivity[] = []
  const result = await new ClaudeSession().send(
    { prompt: 'Search for the phrase', proposeEdits: true, requestId: 'search-request' },
    key,
    { ...emptyWorkspace, search, read },
    event => activity.push(event),
  )

  expect(requestBody(fetch.mock.calls[0]?.[1])).toContain('"name":"search_files"')
  expect(search).toHaveBeenCalledExactlyOnceWith(query, true, expect.any(AbortSignal))
  expect(read).not.toHaveBeenCalled()
  expect(activity.filter(event => event.type === 'tool' && event.id === 'search')).toMatchObject([
    { status: 'running' },
    { status: 'done' },
  ])
  expect(JSON.parse(toolResult(fetch.mock.calls[1]?.[1], 'search').content)).toEqual({ matches, truncated: true })
  expect(toolResult(fetch.mock.calls[1]?.[1], 'edit').isError).toBe(true)
  expect(result.proposal).toBeUndefined()
})

test('stages and rereads a multi-file change before applying against its original versions', async t => {
  const original = 'unchanged\r\nrepeat\r\nmiddle\r\nrepeat\r\nlast\r\n'
  const read = vi.fn<ClaudeWorkspace['read']>(async () => original)
  const checkCreate = vi.fn<ClaudeWorkspace['checkCreate']>(async filename => {
    if (filename === 'occupied.txt') throw new Error('The destination already exists.')
  })
  const edit = (index: number, id: string, files: unknown[]) =>
    toolBlock(index, id, 'edit_files', JSON.stringify({ files }))
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(0, 'read-top', 'read_file', '{"path":"old.txt","start_line":2,"end_line":2}'),
        ...edit(1, 'unread-duplicate', [
          { path: 'old.txt', edits: [{ before: 'repeat', after: 'bad', start_line: 4 }] },
        ]),
        ...edit(2, 'invalid-create', [
          { path: 'old.txt', edits: [{ before: 'repeat', after: 'bad', start_line: 2 }] },
          { path: 'occupied.txt', content: 'bad' },
        ]),
      ]),
    )
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(0, 'read-bottom', 'read_file', '{"path":"old.txt","start_line":4,"end_line":5}'),
        ...edit(1, 'stage', [
          {
            path: 'old.txt',
            edits: [
              { before: 'repeat', after: 'top', start_line: 2 },
              { before: 'repeat\nlast', after: 'bottom\nlast', start_line: 4 },
            ],
          },
          { path: 'new.txt', content: 'new\n' },
        ]),
      ]),
    )
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(0, 'read-staged', 'read_files', '{"files":[{"path":"old.txt"},{"path":"new.txt"}]}'),
        ...edit(1, 'refine', [{ path: 'old.txt', edits: [{ before: 'top', after: 'first' }] }]),
      ]),
    )
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature has two files ready to review.')))
  t.onTestFinished(() => fetch.mockRestore())

  const session = new ClaudeSession()
  const result = await session.send({ prompt: 'Update and create text files', proposeEdits: true }, key, {
    ...emptyWorkspace,
    checkCreate,
    read,
  })

  expect(toolResult(fetch.mock.calls[1]?.[1], 'unread-duplicate')).toMatchObject({ isError: true })
  expect(toolResult(fetch.mock.calls[1]?.[1], 'invalid-create')).toMatchObject({
    isError: true,
    content: 'The destination already exists.',
  })
  expect(toolResult(fetch.mock.calls[2]?.[1], 'stage')).toMatchObject({ isError: false })
  expect(JSON.parse(toolResult(fetch.mock.calls[3]?.[1], 'read-staged').content)).toMatchObject({
    files: [{ text: 'unchanged\ntop\nmiddle\nbottom\nlast\n' }, { text: 'new\n' }],
  })
  expect(read).toHaveBeenCalledExactlyOnceWith('old.txt', 'working')
  expect(checkCreate.mock.calls).toEqual([['occupied.txt'], ['new.txt']])
  expect(result.proposal).toMatchObject({
    kind: 'files',
    files: [
      {
        path: 'old.txt',
        action: 'edit',
        edits: [
          { before: 'repeat\r\n', after: 'first\r\n', startLine: 2 },
          { before: 'repeat\r\n', after: 'bottom\r\n', startLine: 4 },
        ],
      },
      { path: 'new.txt', action: 'create', edits: [{ before: '', after: 'new\n', startLine: 1 }] },
    ],
  })
  const saveFiles = vi
    .fn<ProposalWorkspace['saveFiles']>()
    .mockRejectedValueOnce(new Error('Source changed'))
    .mockResolvedValueOnce(undefined)
  const saveIdea = vi.fn<ProposalWorkspace['saveIdea']>()
  await expect(session.apply(result.proposal?.id, { saveFiles, saveIdea })).rejects.toThrow('Source changed')
  await expect(session.apply(result.proposal?.id, { saveFiles, saveIdea })).resolves.toEqual({
    paths: ['old.txt', 'new.txt'],
  })
  expect(saveFiles).toHaveBeenLastCalledWith([
    { path: 'old.txt', expected: original, text: 'unchanged\r\nfirst\r\nmiddle\r\nbottom\r\nlast\r\n' },
    { path: 'new.txt', expected: null, text: 'new\n' },
  ])
})

test('keeps completed drafts when the model runs out of tokens in a later tool call', async t => {
  const checkCreate = vi.fn<ClaudeWorkspace['checkCreate']>(emptyWorkspace.checkCreate)
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream('tool_use', toolBlock(0, 'stage', 'edit_files', '{"files":[{"path":"done.txt","content":"Done"}]}')),
    )
    .mockResolvedValueOnce(
      stream('max_tokens', toolBlock(0, 'cut-off', 'edit_files', '{"files":[{"path":"partial.txt","content":"')),
    )
  t.onTestFinished(() => fetch.mockRestore())

  const result = await new ClaudeSession().send({ prompt: 'Create two text files', proposeEdits: true }, key, {
    ...emptyWorkspace,
    checkCreate,
  })

  expect(checkCreate).toHaveBeenCalledExactlyOnceWith('done.txt')
  expect(result.text).toContain('Creature ran out of room.')
  expect(result.proposal).toMatchObject({ kind: 'files', files: [{ path: 'done.txt' }] })
})

test('Ask mode requires a switch before it can run editing tools', async t => {
  const checkCreate = vi.fn<ClaudeWorkspace['checkCreate']>(emptyWorkspace.checkCreate)
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream('tool_use', toolBlock(0, 'create', 'edit_files', '{"files":[{"path":"new.txt","content":"New"}]}')),
    )
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature can look around in Ask mode.')))
  t.onTestFinished(() => fetch.mockRestore())

  const result = await new ClaudeSession().send({ prompt: 'Create a file' }, key, {
    ...emptyWorkspace,
    checkCreate,
  })

  const initial = requestBody(fetch.mock.calls[0]?.[1])
  expect(initial).toContain('Speak like a friendly caveman')
  expect(initial).toContain('"name":"switch_to_edit_mode"')
  expect(initial).not.toContain('edit_files')
  expect(toolResult(fetch.mock.calls[1]?.[1], 'create')).toMatchObject({ isError: true })
  expect(checkCreate).not.toHaveBeenCalled()
  expect(result.proposal).toBeUndefined()
})

test('switches to Edit mode during the same turn and carries forward earlier reads', async t => {
  const edit = '{"files":[{"path":"file.txt","edits":[{"before":"old","after":"new"}]}]}'
  const read = vi.fn<ClaudeWorkspace['read']>(async () => 'old\n')
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream('tool_use', [
        ...toolBlock(0, 'source', 'read_file', '{"path":"file.txt"}'),
        ...toolBlock(1, 'switch', 'switch_to_edit_mode'),
        ...toolBlock(2, 'early-edit', 'edit_files', edit),
      ]),
    )
    .mockResolvedValueOnce(stream('tool_use', toolBlock(0, 'edit', 'edit_files', edit)))
    .mockResolvedValueOnce(stream('end_turn', textBlock(0, 'Creature has a change ready for review.')))
  t.onTestFinished(() => fetch.mockRestore())

  const events: ClaudeActivity[] = []
  const reply = await new ClaudeSession().send(
    { prompt: 'Update file.txt', proposeEdits: false, requestId: 'edit-request' },
    key,
    { ...emptyWorkspace, read },
    activity => events.push(activity),
  )

  expect(requestBody(fetch.mock.calls[0]?.[1])).not.toContain('"name":"edit_files"')
  const continuation = requestBody(fetch.mock.calls[1]?.[1])
  expect(continuation).toContain('"name":"edit_files"')
  expect(continuation).toContain('Speak like a friendly caveman')
  expect(continuation).toContain('Update file.txt')
  expect(toolResult(fetch.mock.calls[1]?.[1], 'switch').isError).toBe(false)
  expect(toolResult(fetch.mock.calls[1]?.[1], 'early-edit').isError).toBe(true)
  expect(toolResult(fetch.mock.calls[2]?.[1], 'edit').isError).toBe(false)
  expect(events.filter(event => event.type === 'mode')).toEqual([
    { type: 'mode', mode: 'edit', requestId: 'edit-request', step: 0 },
  ])
  expect(read).toHaveBeenCalledExactlyOnceWith('file.txt', 'working')
  expect(reply.proposal).toMatchObject({ kind: 'files', files: [{ path: 'file.txt' }] })
})
