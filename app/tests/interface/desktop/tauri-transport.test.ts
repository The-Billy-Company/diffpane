import { afterEach, expect, test, vi } from 'vite-plus/test'
import { createTauriTransport } from '../../../renderer/shell/desktop/tauri-transport.ts'
import { createTerminalBridge } from '../../../shared/bridge/terminal-bridge.ts'

const native = vi.hoisted(() => {
  class TestChannel {
    readonly deliver: (payload: unknown) => void

    constructor(deliver: (payload: unknown) => void) {
      this.deliver = deliver
    }
  }
  return {
    Channel: TestChannel,
    invoke: vi.fn<(command: string, request: { events?: TestChannel }) => Promise<unknown>>(),
  }
})
vi.mock('@tauri-apps/api/core', () => native)

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

test('the view listens before sending and keeps commands ordered with explicit null and missing arguments', async () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  const listening = Promise.withResolvers<unknown>()
  const write = Promise.withResolvers<unknown>()
  native.invoke.mockReturnValueOnce(listening.promise).mockReturnValueOnce(write.promise).mockResolvedValue(undefined)
  const transport = createTauriTransport()
  transport.send('save-state', true)
  transport.send('saves-flushed', true, 3)
  const documents = transport.invoke('agent-threads-file', 'project', 'README.md', undefined, 3, null)

  expect(native.invoke).toHaveBeenCalledTimes(1)
  expect(native.invoke.mock.calls[0]?.[0]).toBe('desktop_connect')
  expect(native.invoke.mock.calls[0]?.[1].events).toBeInstanceOf(native.Channel)
  listening.resolve(undefined)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(2))
  expect(native.invoke).toHaveBeenLastCalledWith('desktop_send', {
    channel: 'save-state',
    args: [true],
    undefinedArgs: [],
  })
  write.resolve(undefined)
  await documents
  expect(native.invoke).toHaveBeenNthCalledWith(3, 'desktop_send', {
    channel: 'saves-flushed',
    args: [true, 3],
    undefinedArgs: [],
  })
  expect(native.invoke).toHaveBeenNthCalledWith(4, 'desktop_invoke', {
    channel: 'agent-threads-file',
    args: ['project', 'README.md', null, 3, null],
    undefinedArgs: [2],
  })
})

test('terminal events preserve argument validation and remove individual subscriptions', () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  native.invoke.mockResolvedValueOnce(undefined)
  const terminal = createTerminalBridge(createTauriTransport())
  const data = vi.fn<(chunk: string, bytes: number) => void>()
  const exit = vi.fn<(code: number | null, reason?: string) => void>()
  const unsubscribe = terminal.onData(data)
  terminal.onExit(exit)
  const deliver = native.invoke.mock.calls[0]?.[1].events?.deliver
  if (!deliver) throw new Error('The native listener did not attach.')

  deliver({ channel: 'terminal-data', args: [' abc ', 5] })
  deliver({ channel: 'terminal-data', args: ['invalid', -1] })
  deliver({ channel: 'terminal-exit', args: [null, null], undefinedArgs: [1] })
  unsubscribe()
  deliver({ channel: 'terminal-data', args: ['b', 1] })
  expect(data).toHaveBeenCalledExactlyOnceWith(' abc ', 5)
  expect(exit).toHaveBeenCalledExactlyOnceWith(null, undefined)
})
