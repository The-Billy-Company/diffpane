import { Console } from 'node:console'
import { createInterface } from 'node:readline'

type Handler = (...args: unknown[]) => unknown
interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}
type Frame =
  | { kind: 'event'; event: string; args: unknown[] }
  | { kind: 'request'; id: number; method: string; args: unknown[] }
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }

const handlers = new Map<string, Handler>()
const listeners = new Map<string, Set<Handler>>()
const pending = new Map<number, Pending>()
let nextId = 0
let disconnected = false

function write(frame: Frame) {
  if (disconnected) throw new Error('The Diffpane host disconnected.')
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

export function hostRequest(method: string, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try {
      write({ kind: 'request', id, method, args })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

export function notifyHost(event: string, ...args: unknown[]) {
  write({ kind: 'event', event, args })
}

export function handleHost(method: string, handler: Handler) {
  if (handlers.has(method)) throw new Error(`Duplicate desktop handler: ${method}`)
  handlers.set(method, handler)
}

export function hostEvent(event: string, handler: Handler) {
  const retained = listeners.get(event) ?? new Set()
  listeners.set(event, retained)
  retained.add(handler)
  return () => retained.delete(handler)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Diffpane could not complete the desktop request.'
}

async function dispatch(frame: unknown) {
  if (!frame || typeof frame !== 'object' || !('kind' in frame)) return
  if (frame.kind === 'event') {
    if (!('event' in frame) || typeof frame.event !== 'string' || !('args' in frame) || !Array.isArray(frame.args))
      return
    const args: unknown[] = frame.args
    for (const handler of listeners.get(frame.event) ?? []) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Apply a single event in registration order.
        await handler(...args)
      } catch (error) {
        console.error('Diffpane desktop event:', errorMessage(error))
      }
    }
    return
  }
  if (!('id' in frame) || typeof frame.id !== 'number' || !Number.isSafeInteger(frame.id)) return
  const { id } = frame
  if (frame.kind === 'request') {
    if (!('method' in frame) || typeof frame.method !== 'string' || !('args' in frame) || !Array.isArray(frame.args))
      return
    const handler = handlers.get(frame.method)
    try {
      if (!handler) throw new Error(`Unknown desktop request: ${frame.method}`)
      const args: unknown[] = frame.args
      const value = await handler(...args)
      write({ kind: 'response', id, ok: true, value: value ?? null })
    } catch (error) {
      write({ kind: 'response', id, ok: false, error: errorMessage(error) })
    }
  } else if (frame.kind === 'response') {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if ('ok' in frame && frame.ok === true) request.resolve('value' in frame ? frame.value : undefined)
    else
      request.reject(
        new Error('error' in frame && typeof frame.error === 'string' ? frame.error : 'Desktop I/O failed.'),
      )
  }
}

export function readHost() {
  // stdout is exclusively the framed protocol. Native stderr remains available for diagnostics.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  process.stdout.on('error', () => input.close())
  input.on('line', line => {
    try {
      const frame: unknown = JSON.parse(line)
      void dispatch(frame).catch((error: unknown) => console.error('Diffpane transport:', errorMessage(error)))
    } catch (error) {
      console.error('Diffpane transport received an invalid message:', errorMessage(error))
    }
  })
  input.once('close', () => {
    disconnected = true
    for (const request of pending.values()) request.reject(new Error('The Diffpane host disconnected.'))
    pending.clear()
    const fallback = setTimeout(() => process.exit(1), 8_000)
    const exit = () => {
      clearTimeout(fallback)
      process.exit(0)
    }
    void dispatch({ kind: 'event', event: 'app.disconnected', args: [] }).then(exit, exit)
  })
}
