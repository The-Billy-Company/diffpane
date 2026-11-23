import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { AgentMemoryActivity } from '../../../../shared/agent-memory.ts'
import type {
  AgentProvider,
  AgentThread,
  AgentThreadEvent,
  AgentThreadFile,
  AgentThreadLink,
  AgentThreadList,
  AgentThreadUpdate,
} from '../../../../shared/agent-threads.ts'
import { Repository } from '../../../workspace/repository/repository.mjs'
import { antigravitySource } from './antigravity.ts'
import { claudeSource } from './claude.ts'
import { codexSource } from './codex.ts'
import { cursorSource } from './cursor.ts'
import { trackTranscriptFile } from './source.ts'
import type {
  AgentThreadProcess,
  AgentThreadReader,
  AgentThreadRecord,
  AgentThreadSource,
  AgentThreadSummary,
} from './source.ts'
import { localImageUrl, localMarkdownLinks } from './thread-media.ts'

const sources: [AgentProvider, AgentThreadSource][] = [
  ['claude', claudeSource],
  ['cursor', cursorSource],
  ['codex', codexSource],
  ['antigravity', antigravitySource],
]
const MAX_LINKS = 4000
const MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024
const PROJECT_CACHE_MS = 60_000
const ENRICHMENT_BATCH = 12
const MEMORY_ACTIVITY_REFRESH_MS = 6_000
const MEMORY_ACTIVITY_MAX_AGE_MS = 15_000

type MemoryThread = Omit<AgentMemoryActivity, 'process'> & { processes?: AgentThreadProcess[] }

interface ProcessMemory {
  residentBytes: number
  startedAt?: number
  executable?: string
}

function hasMatchingProcess(provider: AgentProvider, tracked: AgentThreadProcess, sample: ProcessMemory) {
  if (!sample.executable || sample.startedAt === undefined || sample.startedAt > tracked.observedAt) return false
  if (!Number.isSafeInteger(sample.residentBytes) || sample.residentBytes <= 0) return false
  const executable = path
    .basename(sample.executable)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (provider === 'codex') return executable === 'codex'
  if (provider !== 'claude' || executable !== 'claude' || tracked.sessionStartedAt === undefined) return false
  // The CLI records when the session becomes ready, a few seconds after the OS starts its process.
  const delay = tracked.sessionStartedAt - sample.startedAt
  return delay >= 0 && delay <= 30_000
}

async function projectDirectory(cwd: string): Promise<string> {
  try {
    const repository = await Repository.open(cwd)
    const { commonDir } = repository
    if (!commonDir || repository.gitDir === commonDir) return repository.root
    // Standard linked worktrees share the primary checkout's .git directory.
    const common = await realpath(commonDir).catch(() => commonDir)
    return path.basename(common) === '.git' ? path.dirname(common) : repository.root
  } catch {
    return realpath(cwd).catch(() => cwd)
  }
}

interface Selection {
  id: string
  threadId: string
  record: AgentThreadRecord
  source: AgentThreadSource
  reader: AgentThreadReader
  metadata?: AgentThread
  reading: boolean
  events: AgentThreadEvent[]
  files: Set<string>
}

interface ChildThread {
  parentId: string
  record: AgentThreadRecord
  metadata: AgentThread
}

interface ThreadSelection {
  root: Selection
  children: Map<string, ChildThread>
  childReaders: Map<string, Selection>
  childLookups: Map<string, Promise<AgentThread[]>>
}

export class AgentThreads {
  readonly #sources: [AgentProvider, AgentThreadSource][]
  #threads = new Map<string, [AgentThreadRecord, AgentThreadSource]>()
  #listedThreads = new Map<string, AgentThread>()
  #projects = new Map<string, { expiresAt: number; root: Promise<string> }>()
  #summaries = new Map<string, { locator: string; updatedAt: number; summary?: AgentThreadSummary }>()
  #listing?: Promise<AgentThreadList>
  #selection?: ThreadSelection
  #memoryThreads: MemoryThread[] = []
  #processThreadCounts = new Map<number, number>()
  #lastDiscovery = -Infinity

  constructor(threadSources = sources) {
    this.#sources = threadSources
  }

  list(): Promise<AgentThreadList> {
    this.#listing ??= this.#discover()
      .catch((error: unknown) => {
        this.#memoryThreads = []
        this.#processThreadCounts.clear()
        throw error
      })
      .finally(() => {
        this.#listing = undefined
        this.#lastDiscovery = Date.now()
      })
    return this.#listing
  }

  memoryActivities(processes: ReadonlyMap<number, ProcessMemory>): Promise<AgentMemoryActivity[]> {
    const age = Date.now() - this.#lastDiscovery
    if (age >= MEMORY_ACTIVITY_REFRESH_MS) void this.list().catch(() => undefined)
    if (age >= MEMORY_ACTIVITY_MAX_AGE_MS) return Promise.resolve([])
    return Promise.resolve(
      this.#memoryThreads.map(({ processes: candidates, ...thread }) => {
        const tracked = candidates?.length === 1 ? candidates[0] : undefined
        if (!tracked) return thread
        const sample = processes.get(tracked.pid)
        if (!sample || !hasMatchingProcess(thread.provider, tracked, sample)) return thread
        return {
          ...thread,
          process: {
            pid: tracked.pid,
            residentBytes: sample.residentBytes,
            shared: tracked.shared === true || (this.#processThreadCounts.get(tracked.pid) ?? 0) > 1,
          },
        }
      }),
    )
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
    const memoryThreads: MemoryThread[] = []
    const processThreadCounts = new Map<number, number>()
    const entries = [...discovered]
    for (let offset = 0; offset < entries.length; offset += ENRICHMENT_BATCH) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Bound concurrent filesystem reads and Git probes.
      const batch = await Promise.all(
        entries.slice(offset, offset + ENRICHMENT_BATCH).map(async ([id, [thread, source]]) => {
          const directory = thread.projectRoot ?? thread.cwd
          if (path.isAbsolute(directory) && !directory.includes('\0')) projects.add(directory)
          const [projectRoot, summary] = await Promise.all([
            this.#project(directory),
            this.#summary(id, thread, source),
          ])
          for (const { pid } of thread.processes ?? []) {
            processThreadCounts.set(pid, (processThreadCounts.get(pid) ?? 0) + 1)
          }
          if (thread.status === 'running') {
            memoryThreads.push({
              id,
              title: thread.title,
              provider: thread.provider,
              updatedAt: thread.updatedAt,
              action: summary?.action,
              processes: thread.processes,
            })
          }
          return {
            id,
            provider: thread.provider,
            cwd: thread.cwd,
            projectRoot,
            title: thread.title,
            updatedAt: thread.updatedAt,
            active: thread.active,
            status: thread.status,
            activity: summary?.activity,
          }
        }),
      )
      threads.push(...batch)
    }
    this.#memoryThreads = memoryThreads.toSorted((a, b) => b.updatedAt - a.updatedAt)
    this.#processThreadCounts = processThreadCounts
    for (const [id, entry] of this.#threads) {
      if (!discovered.has(id) && unavailable.includes(entry[0].provider)) discovered.set(id, entry)
    }
    this.#threads = discovered
    this.#listedThreads = new Map(threads.map(thread => [thread.id, thread]))
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

  async #summary(
    id: string,
    thread: AgentThreadRecord,
    source: AgentThreadSource,
  ): Promise<AgentThreadSummary | undefined> {
    if (thread.activity || !source.summarize) return { activity: thread.activity, action: thread.action }
    const cached = this.#summaries.get(id)
    if (cached?.locator === thread.locator && cached.updatedAt === thread.updatedAt) return cached.summary
    const summary = await source.summarize(thread).catch(() => undefined)
    this.#summaries.set(id, { locator: thread.locator, updatedAt: thread.updatedAt, summary })
    return summary
  }

  #scope(id: string, selectionId: string) {
    const scope = this.#selection
    return scope?.root.id === selectionId && scope.root.threadId === id ? scope : undefined
  }

  #transcript(selectionId: string, childId?: string) {
    const scope = this.#selection
    if (scope?.root.id !== selectionId) return undefined
    return childId === undefined ? scope.root : scope.childReaders.get(childId)
  }

  async children(selectionId: string, parentId?: string): Promise<AgentThread[]> {
    const scope = this.#selection
    if (scope?.root.id !== selectionId) return []
    const id = parentId ?? scope.root.threadId
    const parent = id === scope.root.threadId ? scope.root.record : scope.children.get(id)?.record
    const source = scope.root.source
    if (!parent || !source.children) return []
    const inFlight = scope.childLookups.get(id)
    if (inFlight) return inFlight
    const lookup = source
      .children(parent)
      .then(records => {
        if (this.#selection !== scope) return []
        const children: AgentThread[] = []
        const seen = new Set<string>()
        for (const record of records) {
          if (record.provider !== parent.provider) continue
          const childId = `${record.provider}:${record.id}`
          const previous = scope.children.get(childId)
          if (
            childId === id ||
            childId === scope.root.threadId ||
            (previous && previous.parentId !== id) ||
            seen.has(childId)
          )
            continue
          seen.add(childId)
          const metadata: AgentThread = {
            id: childId,
            provider: record.provider,
            title: record.title,
            cwd: record.cwd,
            projectRoot: record.projectRoot,
            agentName: record.agentName,
            updatedAt: record.updatedAt,
            status: record.status,
            active: record.active,
            activity: record.activity,
          }
          scope.children.set(childId, { parentId: id, record, metadata })
          children.push(metadata)
        }
        return children
      })
      .finally(() => scope.childLookups.delete(id))
    scope.childLookups.set(id, lookup)
    return lookup
  }

  async read(id: string, selectionId: string, childId?: string): Promise<AgentThreadEvent[]> {
    const scope = this.#scope(id, selectionId)
    const previous = childId === undefined ? scope?.root : scope?.childReaders.get(childId)
    const child = childId === undefined ? undefined : scope?.children.get(childId)
    if (childId !== undefined && !child) throw new Error('This subagent is unavailable in the selected thread.')
    const selected =
      child && scope
        ? ([child.record, scope.root.source] as const)
        : (this.#threads.get(id) ?? (previous && ([previous.record, previous.source] as const)))
    if (!selected) throw new Error('This agent thread is unavailable. Refresh the thread list and try again.')
    const [record, source] = selected
    const selection: Selection = {
      id: selectionId,
      threadId: childId ?? id,
      record,
      source,
      reader: trackTranscriptFile(record.locator, source.open(record)),
      reading: true,
      events: previous?.events ?? [],
      files: previous?.files ?? new Set(),
    }
    if (scope) {
      if (childId === undefined) scope.root = selection
      else scope.childReaders.set(childId, selection)
      if (previous && !previous.reading) previous.reader.close?.()
    } else {
      this.clear()
      this.#selection = { root: selection, children: new Map(), childReaders: new Map(), childLookups: new Map() }
    }
    try {
      selection.events = (await this.#readEvents(selection, false)) ?? []
      return selection.events
    } finally {
      this.#finishRead(selection)
    }
  }

  async update(id: string, selectionId: string, childId?: string): Promise<AgentThreadUpdate> {
    const scope = this.#scope(id, selectionId)
    if (!scope) return {}
    const selection = childId === undefined ? scope.root : scope.childReaders.get(childId)
    if (!selection || selection.reading) return {}

    const child = childId === undefined ? undefined : scope.children.get(childId)
    const selected = child ? ([child.record, scope.root.source] as const) : this.#threads.get(id)
    let reuseReader = true
    if (selected) {
      const [record, source] = selected
      if (record.locator !== selection.record.locator || record.cwd !== selection.record.cwd) {
        const replacement = trackTranscriptFile(record.locator, source.open(record))
        selection.reader.close?.()
        selection.reader = replacement
        selection.record = record
        selection.source = source
        reuseReader = false
      }
    }
    selection.reading = true
    try {
      const events = await this.#readEvents(selection, reuseReader)
      if (this.#transcript(selectionId, childId) !== selection) return {}
      const result: AgentThreadUpdate = {}
      if (events) {
        const previous = selection.events
        let from = 0
        while (from < previous.length && from < events.length && isDeepStrictEqual(previous[from], events[from])) {
          from++
        }
        if (from < previous.length || from < events.length) result.change = { from, events: events.slice(from) }
        selection.events = events
      }
      const thread = childId === undefined ? this.#listedThreads.get(id) : scope.children.get(childId)?.metadata
      if (thread && !isDeepStrictEqual(selection.metadata, thread)) {
        result.thread = thread
        selection.metadata = thread
      }
      return result
    } finally {
      this.#finishRead(selection)
    }
  }

  async #readEvents(selection: Selection, incremental: boolean): Promise<AgentThreadEvent[] | undefined> {
    const { record, reader } = selection
    const events = incremental && reader.readUpdate ? await reader.readUpdate() : await reader.read()
    if (!this.#hasTranscript(selection) || !events) return undefined

    const files = new Set<string>()
    const normalized: AgentThreadEvent[] = []
    const inlineImages = new Map<string, string | undefined>()
    let imageBudget = MAX_INLINE_IMAGE_BYTES

    function normalizeFile(file: AgentThreadFile): AgentThreadFile | undefined {
      if (
        !file.path ||
        file.path.includes('\0') ||
        file.path.length > 4096 ||
        (!path.isAbsolute(file.path) && !record.cwd)
      ) {
        return undefined
      }
      const absolute = path.resolve(record.cwd, file.path)
      if (!files.has(absolute) && files.size >= MAX_LINKS) return undefined
      files.add(absolute)
      const line = file.line !== undefined && Number.isSafeInteger(file.line) && file.line > 0 ? file.line : undefined
      return { path: absolute, line }
    }

    for (const event of events) {
      const text = event.text.slice(0, 48 * 1024)
      const eventFiles = event.files
        ?.slice(0, 100)
        .map(normalizeFile)
        .filter(file => file !== undefined)
      const changes = event.changes?.slice(0, 100).flatMap(change => {
        const file = normalizeFile(change)
        if (!file) return []
        const destinationPath = change.destinationPath && normalizeFile({ path: change.destinationPath })?.path
        return [{ ...change, ...file, destinationPath }]
      })
      const links: AgentThreadLink[] = []
      if (event.kind === 'assistant' || event.kind === 'user') {
        for (const { link, inline } of localMarkdownLinks(text)) {
          const file = normalizeFile(link)
          if (!file) continue
          let dataUrl: string | undefined
          if (inline && link.image && imageBudget > 0) {
            if (!inlineImages.has(file.path)) {
              // oxlint-disable-next-line eslint/no-await-in-loop -- Images share one per-transcript byte budget.
              inlineImages.set(file.path, await localImageUrl(file.path, imageBudget))
            }
            const preview = inlineImages.get(file.path)
            if (preview && preview.length <= imageBudget) {
              dataUrl = preview
              imageBudget -= preview.length
            }
          }
          links.push({ ...link, ...file, ...(dataUrl ? { dataUrl } : {}) })
        }
      }
      normalized.push({ ...event, text, files: eventFiles, changes, ...(links.length ? { links } : {}) })
    }
    if (!this.#hasTranscript(selection)) return undefined
    selection.files = files
    return normalized
  }

  #finishRead(selection: Selection) {
    selection.reading = false
    if (!this.#hasTranscript(selection)) selection.reader.close?.()
  }

  #hasTranscript(selection: Selection) {
    const scope = this.#selection
    return scope?.root === selection || scope?.childReaders.get(selection.threadId) === selection
  }

  clear(selectionId?: string) {
    const scope = this.#selection
    if (!scope || (selectionId !== undefined && scope.root.id !== selectionId)) return
    this.#selection = undefined
    for (const selection of [scope.root, ...scope.childReaders.values()]) {
      if (!selection.reading) selection.reader.close?.()
    }
  }

  async resolveFile(
    selectionId: string,
    filename: string,
    workspace?: { root: string; scope: string },
    childId?: string,
  ): Promise<{ kind: 'workspace' | 'target'; path: string }> {
    const transcript = this.#transcript(selectionId, childId)
    if (!transcript?.files.has(filename)) {
      throw new Error('This file link is no longer available in the selected thread.')
    }
    const absolute = await realpath(filename).catch(() => undefined)
    if (!absolute) throw new Error('The linked file is no longer available.')
    if ([filename, absolute].some(file => file.split(path.sep).some(part => part.toLowerCase() === '.git'))) {
      throw new Error('This link points to Git metadata.')
    }
    const info = await stat(absolute).catch(() => undefined)
    if (!info?.isFile()) throw new Error('This link does not point to a regular file.')
    if (this.#transcript(selectionId, childId) !== transcript || !transcript.files.has(filename)) {
      throw new Error('This file link is no longer available in the selected thread.')
    }
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
    return { kind: 'target', path: absolute }
  }
}
