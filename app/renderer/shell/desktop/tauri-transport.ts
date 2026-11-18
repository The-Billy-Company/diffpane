import { Channel, invoke } from '@tauri-apps/api/core'
import type { DesktopTransport } from '../../../shared/bridge/transport.ts'
import { isRecord } from '../../../shared/bridge/validators/values.ts'

type Listener = (...args: unknown[]) => void

function wireRequest(channel: string, args: unknown[]) {
  const undefinedArgs: number[] = []
  const values = args.map((value, index) => {
    if (value !== undefined) return value
    undefinedArgs.push(index)
    return null
  })
  return { channel, args: values, undefinedArgs }
}

function eventArgs(payload: unknown) {
  if (!isRecord(payload) || typeof payload.channel !== 'string' || !Array.isArray(payload.args)) return null
  const args: unknown[] = payload.args
  if (!Array.isArray(payload.undefinedArgs)) return { channel: payload.channel, args }
  const undefinedArgs = new Set<unknown>(payload.undefinedArgs)
  return { channel: payload.channel, args: args.map((value, index) => (undefinedArgs.has(index) ? undefined : value)) }
}

function desktopPlatform(): NodeJS.Platform {
  const platform = globalThis.navigator.platform
  if (platform.startsWith('Mac')) return 'darwin'
  return platform.startsWith('Win') ? 'win32' : 'linux'
}

export function createTauriTransport(): DesktopTransport {
  const handlers = new Map<string, Set<Listener>>()
  const events = new Channel(payload => {
    const event = eventArgs(payload)
    if (!event) return
    const listeners = handlers.get(event.channel)
    if (!listeners) return
    for (const listener of listeners) listener(...event.args)
  })
  const listening = invoke('desktop_connect', { events }).then(
    () => true,
    () => false,
  )
  let pendingSends = Promise.resolve()

  async function request(command: 'desktop_invoke' | 'desktop_send', channel: string, args: unknown[]) {
    if (!(await listening)) throw new Error('Diffpane could not register for native events.')
    return invoke<unknown>(command, wireRequest(channel, args))
  }

  return {
    platform: desktopPlatform(),
    async invoke(channel, ...args) {
      await pendingSends
      return request('desktop_invoke', channel, args)
    },
    send(channel, ...args) {
      // Keep fire-and-forget writes ordered without blocking on long-running reads.
      pendingSends = pendingSends
        .then(() => request('desktop_send', channel, args))
        .then(
          () => undefined,
          () => undefined,
        )
    },
    listen(channel, callback) {
      const listeners = handlers.get(channel) ?? new Set<Listener>()
      listeners.add(callback)
      handlers.set(channel, listeners)
      return () => {
        listeners.delete(callback)
        if (listeners.size === 0 && handlers.get(channel) === listeners) handlers.delete(channel)
      }
    },
  }
}
