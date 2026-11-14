import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, test, vi } from 'vite-plus/test'
import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import type { ClaudeActivity } from '../../../electron/tools/assistant/claude-session.mjs'

test('the desktop bridge carries grouped edits and creations from proposal to apply', async () => {
  const source = await readFile(new URL('../../../electron/runtime/window/preload.cjs', import.meta.url), 'utf8')
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  const exposeInMainWorld = vi.fn<(name: string, api: DiffpaneApi) => void>()
  runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, send } }),
    performance,
    process: { platform: process.platform },
  })
  const claude = exposeInMainWorld.mock.calls[0]?.[1].claude
  if (!claude) throw new Error('Preload did not expose The Creature')

  const request = { prompt: 'Move the heading into a second file', proposeEdits: true }
  const edit = { path: 'README.md', action: 'edit', edits: [{ before: '# Old', after: '# New', startLine: 1 }] }
  const create = { path: 'Heading.md', action: 'create', edits: [{ before: '', after: '# Old', startLine: 1 }] }
  const proposal = { id: 'proposal-1', kind: 'files', files: [edit, create] }
  const reply = { text: 'Creature has changes ready.', step: 2, proposal }
  invoke.mockResolvedValueOnce({ ok: true, value: reply })
  await expect(claude.send(request)).resolves.toEqual(reply)
  expect(invoke).toHaveBeenLastCalledWith('claude-send', request)

  const applied = { paths: ['README.md', 'Heading.md'] }
  invoke.mockResolvedValueOnce({ ok: true, value: applied })
  await expect(claude.apply(proposal.id)).resolves.toEqual(applied)
  expect(invoke).toHaveBeenLastCalledWith('claude-apply', proposal.id)

  const malformed = { ...proposal, files: [{ ...edit, edits: [{ before: '# Old', after: '# New', startLine: 0 }] }] }
  invoke.mockResolvedValueOnce({ ok: true, value: { ...reply, proposal: malformed } })
  await expect(claude.send(request)).rejects.toMatchObject({ code: 'INVALID_IPC_RESPONSE' })

  const idea = {
    id: 'proposal-2',
    kind: 'idea',
    action: 'create',
    ideaId: 'idea-1',
    title: 'Heading',
    before: '',
    after: '# Old',
  }
  invoke.mockResolvedValueOnce({ ok: true, value: { ...reply, proposal: idea } })
  await expect(claude.send(request)).resolves.toMatchObject({ proposal: idea })
})

test('the desktop bridge delivers the streamed Edit mode switch', async () => {
  const source = await readFile(new URL('../../../electron/runtime/window/preload.cjs', import.meta.url), 'utf8')
  const on = vi.fn<(channel: string, listener: (event: unknown, value: unknown) => void) => void>()
  const removeListener = vi.fn<typeof on>()
  const exposeInMainWorld = vi.fn<(name: string, api: DiffpaneApi) => void>()
  runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { on, removeListener } }),
    process: { platform: process.platform },
  })
  const claude = exposeInMainWorld.mock.calls[0]?.[1].claude
  if (!claude) throw new Error('Preload did not expose The Creature')

  const receive = vi.fn<(activity: ClaudeActivity) => void>()
  const unsubscribe = claude.onActivity(receive)
  const [channel, listener] = on.mock.calls[0] ?? []
  expect(channel).toBe('claude-activity')
  if (!listener) throw new Error('Preload did not register for Creature activity')
  const activity = { type: 'mode', mode: 'edit', requestId: 'request-1', step: 1 }
  listener({}, activity)
  listener({}, { ...activity, mode: 'ask' })
  expect(receive).toHaveBeenCalledExactlyOnceWith(activity)
  unsubscribe()
  expect(removeListener).toHaveBeenCalledExactlyOnceWith(channel, listener)
})
