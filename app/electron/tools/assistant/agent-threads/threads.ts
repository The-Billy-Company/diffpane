import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentFileView,
  AgentProvider,
  AgentThreadEvent,
  AgentThreadList,
  AgentThreadUpdate,
} from '../../../../shared/agent-threads.ts'
import { Repository } from '../../../workspace/repository/repository.mjs'
import { antigravitySource } from './antigravity.ts'
import { claudeSource } from './claude.ts'
import { codexSource } from './codex.ts'
import { cursorSource } from './cursor.ts'
import type { AgentThreadReader, AgentThreadRecord, AgentThreadSource } from './source.ts'

const sources: [AgentProvider, AgentThreadSource][] = [
  ['claude', claudeSource],
  ['cursor', cursorSource],
  ['codex', codexSource],
  ['antigravity', antigravitySource],
]
const POLL_MS = 350
const PREVIEW_BYTES = 256 * 1024
const MAX_LINKS = 4000
const PROJECT_CACHE_MS = 60_000
const ENRICHMENT_BATCH = 12

async function projectDirectory(cwd: string): Promise<string> {
  try {
    const repository = await Repository.open(cwd)
    if (repository.gitDir === repository.commonDir) return repository.root
    // Standard linked worktrees share the primary checkout's .git directory.
    const common = await realpath(repository.commonDir).catch(() => repository.commonDir)
    return path.basename(common) === '.git' ? path.dirname(common) : repository.root
  } catch {
    return realpath(cwd).catch(() => cwd)
  }
}

interface Stream {
  subscription: string
  reader: AgentThreadReader
  files: Set<string>
  timer?: ReturnType<typeof setTimeout>
  error?: string
}

export class AgentThreads {
  readonly #sources: [AgentProvider, AgentThreadSource][]
  #threads = new Map<string, [AgentThreadRecord, AgentThreadSource]>()
  #projects = new Map<string, { expiresAt: number; root: Promise<string> }>()
  #summaries = new Map<string, { locator: string; updatedAt: number; activity?: string }>()
  #listing?: Promise<AgentThreadList>
  #stream?: Stream

  constructor(threadSources = sources) {
    this.#sources = threadSources
  }

  list(): Promise<AgentThreadList> {
    this.#listing ??= this.#discover().finally(() => {
      this.#listing = undefined
    })
    return this.#listing
  }

  async #discover(): Promise<AgentThreadList> {
    const results = await Promise.allSettled(this.#sources.map(([, source]) => source.list()))
    const threads: AgentThreadList['threads'] = []
    const unavailable: AgentProvider[] = []
    const discovered = new Map<string, [AgentThreadRecord, AgentThreadSource]>()
    for (const [index, [provider, source]] of this.#sources.entries()) {
      const result = results[index]
      if (result?.status !== 'fulfilled') {
        unavailable.push(provider)
        continue
      }
      for (const thread of result.value) {
        const id = `${provider}:${thread.id}`
        const previous = discovered.get(id)?.[0]
        if (!previous || thread.updatedAt > previous.updatedAt) discovered.set(id, [thread, source])
      }
    }
    const projects = new Set<string>()
    const entries = [...discovered]
    for (let offset = 0; offset < entries.length; offset += ENRICHMENT_BATCH) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bound concurrent filesystem reads and Git probes.
      const batch = await Promise.all(
        entries.slice(offset, offset + ENRICHMENT_BATCH).map(async ([id, [thread, source]]) => {
          const directory = thread.projectRoot ?? thread.cwd
          if (path.isAbsolute(directory) && !directory.includes('\0')) projects.add(directory)
          const [projectRoot, activity] = await Promise.all([
            this.#project(directory),
            this.#activity(id, thread, source),
          ])
          return {
            id,
            provider: thread.provider,
            cwd: thread.cwd,
            projectRoot,
            title: thread.title,
            updatedAt: thread.updatedAt,
            active: thread.active,
            status: thread.status,
            activity,
          }
        }),
      )
      threads.push(...batch)
    }
    for (const [id, entry] of this.#threads) {
      if (!discovered.has(id) && unavailable.includes(entry[0].provider)) discovered.set(id, entry)
    }
    this.#threads = discovered
    for (const id of this.#summaries.keys()) {
      if (!discovered.has(id)) this.#summaries.delete(id)
    }
    for (const directory of this.#projects.keys()) {
      if (!projects.has(directory)) this.#projects.delete(directory)
    }
    threads.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.updatedAt - a.updatedAt)
    return { threads, unavailable }
  }

  async #project(directory: string): Promise<string | undefined> {
    if (!path.isAbsolute(directory) || directory.includes('\0')) return undefined
    const now = Date.now()
    const cached = this.#projects.get(directory)
    if (cached && cached.expiresAt > now) return cached.root
    const root = projectDirectory(directory)
    this.#projects.set(directory, { expiresAt: now + PROJECT_CACHE_MS, root })
    return root
  }

  async #activity(id: string, thread: AgentThreadRecord, source: AgentThreadSource): Promise<string | undefined> {
    if (thread.activity || !source.summarize) return thread.activity
    const cached = this.#summaries.get(id)
    if (cached?.locator === thread.locator && cached.updatedAt === thread.updatedAt) return cached.activity
    const activity = await source.summarize(thread).catch(() => undefined)
    this.#summaries.set(id, { locator: thread.locator, updatedAt: thread.updatedAt, activity })
    return activity
  }

  follow(id: string, subscription: string, publish: (update: AgentThreadUpdate) => void) {
    const selected = this.#threads.get(id)
    if (!selected) throw new Error('This agent thread is unavailable. Refresh the thread list and try again.')
    this.stop()
    const [thread, source] = selected
    const stream: Stream = { subscription, reader: source.open(thread), files: new Set() }
    this.#stream = stream

    const poll = async () => {
      let events: AgentThreadEvent[] = []
      let error: string | undefined
      try {
        events = await stream.reader.read()
      } catch {
        error = 'Waiting to reconnect to the agent transcript…'
      }
      if (this.#stream !== stream) return
      events = events.slice(-500)
      for (const event of events) {
        event.text = event.text.slice(0, 48 * 1024)
        if (event.files) {
          event.files = event.files.slice(0, 100).flatMap(file => {
            if (
              !file.path ||
              file.path.includes('\0') ||
              file.path.length > 4096 ||
              (!path.isAbsolute(file.path) && !thread.cwd)
            )
              return []
            const absolute = path.resolve(thread.cwd, file.path)
            stream.files.delete(absolute)
            stream.files.add(absolute)
            if (stream.files.size > MAX_LINKS) {
              const oldest = stream.files.values().next().value
              if (oldest !== undefined) stream.files.delete(oldest)
            }
            const line =
              file.line !== undefined && Number.isSafeInteger(file.line) && file.line > 0 ? file.line : undefined
            return [{ path: absolute, line }]
          })
        }
      }
      if (events.length || error !== stream.error) publish({ subscription, events, error })
      stream.error = error
      stream.timer = setTimeout(() => void poll(), POLL_MS)
    }
    stream.timer = setTimeout(() => void poll(), 0)
  }

  stop(subscription?: string) {
    if (!this.#stream || (subscription !== undefined && this.#stream.subscription !== subscription)) return
    clearTimeout(this.#stream.timer)
    this.#stream.reader.close?.()
    this.#stream = undefined
  }

  async file(
    subscription: string,
    filename: string,
    workspace?: { root: string; scope: string },
  ): Promise<AgentFileView> {
    if (this.#stream?.subscription !== subscription || !this.#stream.files.has(filename)) {
      throw new Error('This file link is no longer available in the selected thread.')
    }
    const absolute = await realpath(filename)
    if (absolute.split(path.sep).includes('.git')) throw new Error('This link points to Git metadata.')
    if (workspace) {
      const withinScope = path.relative(workspace.scope, absolute)
      const relative = path.relative(workspace.root, absolute).split(path.sep).join('/')
      if (
        withinScope &&
        withinScope !== '..' &&
        !withinScope.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(withinScope)
      ) {
        return { kind: 'workspace', path: relative }
      }
    }
    const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile()) throw new Error('This link does not point to a regular file.')
      const buffer = Buffer.allocUnsafe(Math.min(info.size, PREVIEW_BYTES + 1))
      const { bytesRead } = await file.read(buffer)
      const text = buffer.subarray(0, Math.min(bytesRead, PREVIEW_BYTES)).toString('utf8')
      if (text.includes('\0')) throw new Error('Open its Git workspace in Diffpane to view this binary file.')
      return { kind: 'preview', text, limited: bytesRead > PREVIEW_BYTES }
    } finally {
      await file.close()
    }
  }
}
