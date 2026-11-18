import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstatSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { webkit } from 'playwright'
import { preview } from 'vite'

interface Request {
  id: number
  method: string
  args: unknown[]
}
type Result = { ok: true; value?: unknown } | { ok: false; error: string }
interface DesktopEvent {
  channel: string
  args: unknown[]
  undefinedArgs?: number[]
}

declare global {
  interface Window {
    fixtureDesktopInvoke(command: string, channel: string, args: unknown[], omitted: number[]): Promise<unknown>
    deliverDesktopEvent(event: DesktopEvent): void
  }
}

function identity(filename: string) {
  const { dev, ino } = lstatSync(filename, { bigint: true })
  return `${dev}:${ino}`
}

export async function openWorkspace(root: string, profile: string, target: string, pageError: (error: Error) => void) {
  const assets = await preview({
    configFile: path.join(root, 'vite.config.ts'),
    preview: { host: '127.0.0.1', port: 0 },
  })
  const browser = await webkit.launch().catch((error: unknown) => {
    assets.httpServer.close()
    throw error
  })
  const service = spawn(
    process.env.DIFFPANE_TEST_NODE ?? process.execPath,
    [path.join(root, 'app/desktop/host/entry.ts')],
    {
      cwd: root,
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  const exited = once(service, 'exit')
  const pending = new Map<number, (result: Result) => void>()
  const events = createInterface({ input: service.stdout })
  const keychain = new Map<string, unknown>()
  let nextId = 0
  let deliver: ((event: DesktopEvent) => void) | undefined
  const { promise: windowCreated, resolve: created } = Promise.withResolvers<string>()

  const write = (value: unknown) => service.stdin.write(`${JSON.stringify(value)}\n`)
  const notify = (event: string, ...args: unknown[]) => write({ kind: 'event', event, args })
  function request(method: string, ...args: unknown[]) {
    const id = ++nextId
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, result => {
        if (result.ok) resolve(result.value)
        else reject(new Error(result.error))
      })
      write({ kind: 'request', id, method, args })
    })
  }

  function nativeRequest({ id, method, args }: Request) {
    const [first, second, third] = args
    const key = `${String(first)}:${String(second)}`
    let value: unknown = null
    if (method === 'shell.trash' || method === 'shell.restoreTrash') {
      try {
        assert.ok(typeof first === 'string')
        const source = first
        const currentIdentity = identity(source)
        if (method === 'shell.trash') {
          if (second !== null && second !== undefined && currentIdentity !== second)
            throw new Error('This file or folder has changed since it was restored.')
          mkdirSync(profile, { recursive: true })
          const trash = mkdtempSync(path.join(profile, 'trash-'))
          const destination = path.join(trash, path.basename(source))
          renameSync(source, destination)
          value = { path: destination, identity: currentIdentity }
        } else {
          assert.ok(typeof second === 'string')
          const destination = second
          if (currentIdentity !== third) throw new Error('This item in Trash has changed.')
          if (lstatSync(destination, { throwIfNoEntry: false }))
            throw new Error('A file or folder with that name already exists.')
          renameSync(source, destination)
        }
      } catch (error) {
        write({ kind: 'response', id, ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
    } else if (method === 'keychain.read') value = keychain.get(key) ?? null
    else if (method === 'keychain.create') {
      if (!keychain.has(key)) keychain.set(key, third)
      value = keychain.get(key)
    } else if (method === 'window.create' && typeof first === 'string') {
      notify('window.navigation', first)
      notify('window.focused', first, true)
      created(first)
    }
    if (method === 'app.exit') {
      write({ kind: 'response', id, ok: true, value })
      service.stdin.end()
    } else write({ kind: 'response', id, ok: true, value })
  }

  events.on('line', line => {
    const frame: unknown = JSON.parse(line)
    if (!frame || typeof frame !== 'object' || !('kind' in frame)) return
    if (
      frame.kind === 'request' &&
      'id' in frame &&
      typeof frame.id === 'number' &&
      'method' in frame &&
      typeof frame.method === 'string' &&
      'args' in frame &&
      Array.isArray(frame.args)
    )
      nativeRequest({ id: frame.id, method: frame.method, args: frame.args })
    else if (frame.kind === 'response' && 'id' in frame && typeof frame.id === 'number') {
      pending.get(frame.id)?.(
        'ok' in frame && frame.ok === true
          ? { ok: true, value: 'value' in frame ? frame.value : undefined }
          : {
              ok: false,
              error: 'error' in frame && typeof frame.error === 'string' ? frame.error : 'Workspace service failure.',
            },
      )
      pending.delete(frame.id)
    } else if ('event' in frame && frame.event === 'renderer-event' && 'args' in frame && Array.isArray(frame.args)) {
      const input: unknown[] = frame.args
      const [, channel, args, omitted] = input
      if (typeof channel === 'string' && Array.isArray(args))
        deliver?.({
          channel,
          args,
          undefinedArgs: Array.isArray(omitted)
            ? omitted.filter((index): index is number => typeof index === 'number')
            : undefined,
        })
    }
  })
  events.once('close', () => {
    for (const resolve of pending.values()) resolve({ ok: false, error: 'Workspace service disconnected.' })
    pending.clear()
  })

  async function close() {
    await browser.close()
    assets.httpServer.close()
    if (service.exitCode === null && service.signalCode === null) {
      service.stdin.end()
      await exited
    }
  }

  try {
    notify('app.start', {
      version: '0.0.0',
      appPath: root,
      profilePath: profile,
      logsPath: path.join(profile, 'logs'),
      targets: [target],
      mediaOrigin: 'http://127.0.0.1:1',
      isPackaged: false,
    })
    const label = await Promise.race([
      windowCreated,
      exited.then(() => {
        throw new Error('The workspace service exited before opening a window.')
      }),
    ])
    const page = await browser.newPage({ viewport: { width: 1400, height: 960 } })
    page.on('pageerror', pageError)
    await page.exposeFunction(
      'fixtureDesktopInvoke',
      (method: string, channel: string, args: unknown[], undefinedArgs: number[]) =>
        request(method === 'desktop_invoke' ? 'invoke' : 'send', label, channel, args, undefinedArgs),
    )
    await page.addInitScript(() => {
      type Callback = (payload: { message: DesktopEvent; index: number }) => void
      const callbacks = new Map<number, Callback>()
      let nextCallback = 0
      let index = 0
      let channel = 0
      window.deliverDesktopEvent = message => callbacks.get(channel)?.({ message, index: index++ })
      Object.defineProperty(window, 'isTauri', { value: true })
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          invoke(
            command: string,
            args: { events?: { id: number }; channel: string; args: unknown[]; undefinedArgs: number[] },
          ) {
            if (command === 'desktop_connect' && args.events) {
              channel = args.events.id
              return Promise.resolve()
            }
            return window.fixtureDesktopInvoke(command, args.channel, args.args, args.undefinedArgs)
          },
          transformCallback(callback: Callback) {
            callbacks.set(++nextCallback, callback)
            return nextCallback
          },
          unregisterCallback(id: number) {
            callbacks.delete(id)
          },
        },
      })
    })
    deliver = event => {
      void page.evaluate(payload => window.deliverDesktopEvent(payload), event).catch(() => {})
    }
    const url = assets.resolvedUrls?.local[0]
    assert.ok(url)
    await page.goto(url)
    return { page, close }
  } catch (error) {
    await close()
    throw error
  }
}
