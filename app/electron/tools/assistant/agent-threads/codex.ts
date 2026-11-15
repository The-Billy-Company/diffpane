import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { isAgentThreadImageDataUrl } from '../../../../shared/agent-threads.ts'
import type { AgentThreadEvent, AgentThreadFile, AgentThreadImage } from '../../../../shared/agent-threads.ts'
import { mediaType } from '../../../../shared/documents/media-types.ts'
import { parseCodexPrompt } from './codex-prompt.ts'
import { latestActivity, readJsonLines, recentJsonRecords, toolCall } from './source.ts'
import type { AgentThreadRecord, AgentThreadSource } from './source.ts'

const run = promisify(execFile)
const recentLimit = 40
const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024
// The selected transcript, including its encoded previews, is sent over Electron IPC in one response.
const MAX_TRANSCRIPT_IMAGE_BYTES = 64 * 1024 * 1024
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const rolloutPattern = new RegExp(`^rollout-.*-(${uuid})\\.jsonl$`, 'i')
const lockPattern = new RegExp(`^(${uuid})\\.lock$`, 'i')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function decode(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

function transcriptText(value: unknown): string {
  if (!Array.isArray(value)) return string(value)
  return value
    .map(part => string(object(part)?.text))
    .filter(Boolean)
    .join('\n')
}

function assistantMessage(content: unknown): AgentThreadEvent[] {
  const text = transcriptText(content).trim()
  if (!text) return []
  return [{ kind: 'assistant', text }]
}

interface ImageInput {
  path?: string
  dataUrl?: string
}

interface EmbeddedImages {
  text: string
  turnId: string
  urls: (string | undefined)[]
}

interface TranscriptImages {
  pending?: EmbeddedImages
  local: Map<AgentThreadImage, string>
  remaining: number
}

function imageInputs(content: unknown): ImageInput[] {
  if (!Array.isArray(content)) return []
  return content.flatMap<ImageInput>(part => {
    const input = object(part)
    if (input?.type === 'local_image') return [{ path: string(input.path) }]
    if (input?.type === 'image') return [{ dataUrl: string(input.url) }]
    return []
  })
}

function legacyImageInputs(payload: Record<string, unknown>): ImageInput[] {
  const remote = Array.isArray(payload.images) ? payload.images.map(url => ({ dataUrl: string(url) })) : []
  const local = Array.isArray(payload.local_images) ? payload.local_images.map(file => ({ path: string(file) })) : []
  return [...remote, ...local]
}

function embeddedImages(payload: Record<string, unknown>): EmbeddedImages | undefined {
  if (!Array.isArray(payload.content)) return undefined
  const parts = payload.content.map(object)
  const urls = parts.flatMap(part =>
    part?.type === 'input_image' ? [isAgentThreadImageDataUrl(part.image_url) ? part.image_url : undefined] : [],
  )
  if (!urls.length) return undefined
  const text = parts
    .flatMap((part, index) => {
      if (part?.type !== 'input_text') return []
      const value = string(part.text)
      if (value.startsWith('<image ') && parts[index + 1]?.type === 'input_image') return []
      if (value === '</image>' && parts[index - 1]?.type === 'input_image') return []
      return value ? [value] : []
    })
    .join('\n')
    .trim()
  const turnId = string(object(payload.internal_chat_message_metadata_passthrough)?.turn_id)
  return { text, turnId, urls }
}

function attachImageData(image: AgentThreadImage, url: unknown, images: TranscriptImages) {
  if (isAgentThreadImageDataUrl(url) && url.length <= images.remaining) {
    image.dataUrl = url
    images.remaining -= url.length
  }
}

function userMessage(
  content: unknown,
  inputs: ImageInput[],
  turnId: string,
  transcript?: TranscriptImages,
): AgentThreadEvent[] {
  const raw = transcriptText(content).trim()
  const { text, files, imageNames } = parseCodexPrompt(raw)
  const pending = transcript?.pending
  if (transcript) transcript.pending = undefined
  const embedded =
    pending?.text === raw && (!pending.turnId || !turnId || pending.turnId === turnId) ? pending.urls : []
  const images: AgentThreadImage[] = []
  if (transcript) {
    const count = Math.max(inputs.length, imageNames?.length ?? 0, embedded.length)
    for (let index = 0; index < count; index++) {
      const input = inputs[index]
      const filename = input?.path
      const name = filename?.match(/[^\\/]+$/u)?.[0] ?? imageNames?.[index] ?? `Image ${index + 1}`
      const image: AgentThreadImage = { name }
      attachImageData(image, embedded[index] ?? input?.dataUrl, transcript)
      if (!image.dataUrl && filename && path.isAbsolute(filename)) transcript.local.set(image, filename)
      images.push(image)
    }
  }
  if (!text && !files?.length && !images.length) return []
  return [{ kind: 'user', text, ...(files?.length ? { files } : {}), ...(images.length ? { images } : {}) }]
}

async function localImageUrl(filename: string, remaining: number): Promise<string | undefined> {
  const type = mediaType(filename)
  if (!type?.startsWith('image/') || type === 'image/svg+xml') return undefined
  const prefix = `data:${type};base64,`
  if (remaining <= prefix.length) return undefined
  try {
    await using file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const info = await file.stat()
    const encodedSize = Math.ceil(info.size / 3) * 4 + prefix.length
    if (!info.isFile() || !info.size || info.size > MAX_LOCAL_IMAGE_BYTES || encodedSize > remaining) return undefined
    const buffer = Buffer.allocUnsafe(info.size)
    const { bytesRead } = await file.read(buffer)
    return bytesRead === info.size ? prefix + buffer.toString('base64') : undefined
  } catch {
    // Desktop screenshot paths may have expired since the prompt was recorded.
    return undefined
  }
}

function reasoningSummary(item: Record<string, unknown>, seen: Set<string>): AgentThreadEvent[] {
  const id = string(item.id)
  if (id && seen.has(id)) return []
  const completed = item.type === 'Reasoning'
  const parts = completed ? item.summary_text : item.summary
  if (!Array.isArray(parts)) return []
  const text = parts
    .map(part => {
      if (completed) return string(part).trim()
      const segment = object(part)
      return segment?.type === 'summary_text' ? string(segment.text).trim() : ''
    })
    .filter(Boolean)
    .join('\n\n')
  if (!text) return []
  if (id) seen.add(id)
  return [{ kind: 'thinking', text }]
}

function fileChanges(changes: unknown, cwd: string): AgentThreadFile[] {
  return Object.entries(object(changes) ?? {}).flatMap(([filename, value]) => {
    if (!filename) return []
    const change = object(value)
    const destination = string(change?.move_path) || filename
    const diff = string(change?.unified_diff)
    const line = Number(/^@@ .*? \+(\d+)/m.exec(diff)?.[1])
    return [{ path: path.resolve(cwd, destination), ...(line > 0 ? { line } : {}) }]
  })
}

function edit(changes: unknown, cwd: string): AgentThreadEvent[] {
  const files = fileChanges(changes, cwd)
  if (!files.length) return []
  const filename = files[0]?.path
  const description = files.length === 1 && filename ? `Edit ${path.basename(filename)}` : `Edit ${files.length} files`
  return [toolCall('apply_patch', { kind: 'edit', description, files })]
}

function commandDescription(part: Record<string, unknown> | undefined): string {
  const filename = string(part?.path)
  const name = string(part?.name) || (filename && path.basename(filename))
  const query = string(part?.query)
  switch (part?.type) {
    case 'read':
      return name ? `Read ${name}` : 'Read a file'
    case 'search':
      return query ? `Search for ${query}` : 'Search files'
    case 'list_files':
      return name ? `List files in ${name}` : 'List files'
    default:
      return ''
  }
}

function commandEvent(item: Record<string, unknown>, cwd: string, summary = false): AgentThreadEvent[] {
  const parts = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(object) : []
  const files = parts.flatMap(part => {
    const filename = string(part?.path)
    return part?.type === 'read' && filename ? [{ path: path.resolve(string(item.cwd) || cwd, filename) }] : []
  })
  const command = Array.isArray(item.command) ? item.command.map(string).join(' ') : string(item.command)
  const text = summary ? '' : command.replace(/^.*?\s-(?:lc|c)\s+(?=.)/, '').trim()
  const description = string(item.description) || (parts.length === 1 ? commandDescription(parts[0]) : '')
  return [toolCall('Shell', { description: description || (summary ? '' : text.split('\n', 1)[0]), text, files })]
}

function parseItem(item: Record<string, unknown>, cwd: string, summary: boolean): AgentThreadEvent[] {
  switch (item.type) {
    case 'AgentMessage':
      return assistantMessage(item.content)
    case 'FileChange':
      if (item.status === 'failed' || item.status === 'declined') return []
      return edit(item.changes, cwd)
    case 'CommandExecution':
      return commandEvent(item, cwd, summary)
    case 'McpToolCall': {
      const name = string(item.tool) || string(item.server) || 'MCP tool'
      const description = string(object(item.arguments)?.description) || string(item.server)
      return [toolCall(name, { description })]
    }
    case 'Extension': {
      const name = string(item.kind)
      if (!name) return []
      return [toolCall(name, { description: string(object(item.action)?.query) })]
    }
    default:
      return []
  }
}

function parseRollout(
  record: unknown,
  cwd: string,
  {
    summary = false,
    seenReasoning,
    images,
  }: { summary?: boolean; seenReasoning?: Set<string>; images?: TranscriptImages },
): AgentThreadEvent[] {
  const entry = object(record)
  const payload = object(entry?.payload)
  if (!payload) return []
  if (entry?.type === 'response_item') {
    // Older rollouts may store user-visible reasoning summaries only in response items.
    if (payload.type === 'reasoning' && seenReasoning) return reasoningSummary(payload, seenReasoning)
    // The model input contains the stored image bytes. Its text can also contain private context.
    if (images && payload.type === 'message' && payload.role === 'user') images.pending = embeddedImages(payload)
    return []
  }
  if (entry?.type !== 'event_msg') return []
  switch (payload.type) {
    case 'item_completed': {
      const item = object(payload.item)
      if (item?.type === 'Reasoning' && seenReasoning) return reasoningSummary(item, seenReasoning)
      if (item?.type === 'UserMessage')
        return userMessage(item.content, images ? imageInputs(item.content) : [], string(payload.turn_id), images)
      return item ? parseItem(item, cwd, summary) : []
    }
    case 'item_started': {
      const item = object(payload.item)
      if (!summary || (item?.type !== 'CommandExecution' && item?.type !== 'McpToolCall')) return []
      return parseItem(item, cwd, summary)
    }
    case 'user_message':
      return userMessage(payload.message, images ? legacyImageInputs(payload) : [], string(payload.turn_id), images)
    case 'agent_message':
      return assistantMessage(payload.message)
    case 'patch_apply_end':
      return payload.success === true ? edit(payload.changes, cwd) : []
    case 'exec_command_end':
      return commandEvent(payload, cwd, summary)
    case 'task_started':
    case 'turn_started':
      if (images) images.pending = undefined
      return [{ kind: 'status', text: 'Turn started' }]
    case 'task_complete':
    case 'turn_completed':
      if (images) images.pending = undefined
      return [{ kind: 'status', text: 'Turn finished' }]
    case 'turn_aborted':
      if (images) images.pending = undefined
      return [{ kind: 'status', text: 'Turn interrupted' }]
    case 'error': {
      const text = string(payload.message)
      return text ? [{ kind: 'status', text }] : []
    }
    default:
      return []
  }
}

async function databasePath(root: string, prefix: string): Promise<string | undefined> {
  const entries = await readdir(root).catch(() => [])
  const candidates = entries.flatMap(name => {
    const version = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`).exec(name)?.[1]
    return version ? [{ name, version: Number(version) }] : []
  })
  const latest = candidates.toSorted((left, right) => right.version - left.version)[0]
  return latest ? path.join(root, latest.name) : undefined
}

interface OpenThreads {
  ids: Set<string>
  rollouts: Set<string>
}

async function openThreads(sessions: string, locks: string): Promise<OpenThreads> {
  const ids = new Set<string>()
  const rollouts = new Set<string>()
  if (process.platform === 'win32') return { ids, rollouts }
  try {
    // Codex keeps a writer lock while a thread is loaded, including when waiting for its next prompt.
    const executable = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof'
    const { stdout } = await run(executable, ['-n', '-P', '-a', '-c', 'codex', '-u', userInfo().username, '-Fn'], {
      // Checking every open Codex window can exceed a short timeout on a busy machine.
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    for (const entry of stdout.split('\n')) {
      if (!entry.startsWith('n/')) continue
      const filename = entry.slice(1)
      const name = path.basename(filename)
      if (path.dirname(filename) === locks) {
        const id = lockPattern.exec(name)?.[1]
        if (id) ids.add(id)
      }
      if (filename.startsWith(`${sessions}${path.sep}`) && rolloutPattern.test(name)) rollouts.add(filename)
    }
  } catch {
    // Older systems can still discover the recent local rollouts without inspecting open files.
  }
  return { ids, rollouts }
}

function projectedTurnStatus(filename: string | undefined, ids: Set<string>): Map<string, boolean> {
  const statuses = new Map<string, boolean>()
  if (!filename || !ids.size) return statuses
  try {
    using database = new DatabaseSync(filename, { readOnly: true, timeout: 0 })
    const latestTurn = database.prepare(`
      SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1
    `)
    for (const id of ids) {
      const status = latestTurn.get(id)?.status
      if (typeof status === 'string') statuses.set(id, status === 'inProgress')
    }
  } catch {
    // The history projection is only present on recent versions of Codex.
  }
  return statuses
}

function indexedThreads(filename: string | undefined, ids: Set<string>, sessions: string) {
  const records = new Map<string, AgentThreadRecord>()
  const subagentIds = new Set<string>()
  if (!filename) return { records, subagentIds }
  try {
    using database = new DatabaseSync(filename, { readOnly: true, timeout: 0 })
    const columns = new Set(
      database
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map(column => column.name),
    )
    const titles = ['name', 'title', 'agent_nickname'].filter(column => columns.has(column))
    const title = titles.map(column => `NULLIF(${column}, '')`).join(', ')
    const fields = `id, cwd, rollout_path, updated_at, COALESCE(${title}, '') AS title`
    // Codex app chats include delegated work in the parent chat. Its separate rollouts are implementation details.
    const threadSource = columns.has('thread_source') ? "thread_source IS 'subagent'" : '0'
    const sessionSource = columns.has('source')
      ? "json_type(CASE WHEN json_valid(source) THEN source END, '$.subagent') IS NOT NULL"
      : '0'
    const subagent = `(${threadSource} OR ${sessionSource})`
    const latest = database.prepare(`
      SELECT ${fields} FROM threads WHERE archived = 0 AND NOT ${subagent} ORDER BY updated_at DESC LIMIT ?
    `)
    const byId = database.prepare(
      `SELECT ${fields}, ${subagent} AS subagent FROM threads WHERE archived = 0 AND id = ?`,
    )
    const rows = [...latest.all(recentLimit), ...[...ids].flatMap(id => byId.all(id))]
    for (const row of rows) {
      const id = string(row.id)
      if (!id) continue
      if (row.subagent === 1) {
        subagentIds.add(id)
        continue
      }
      const cwd = string(row.cwd)
      const locator = string(row.rollout_path)
      if (!path.isAbsolute(cwd) || !locator.startsWith(`${sessions}${path.sep}`)) continue
      records.set(locator, {
        id,
        provider: 'codex',
        title: string(row.title).replaceAll(/\s+/g, ' ').trim().slice(0, 160) || path.basename(cwd),
        cwd,
        locator,
        updatedAt: Number(row.updated_at) * 1_000,
      })
    }
  } catch {
    // Older installations may only have rollouts.
  }
  return { records, subagentIds }
}

async function recentThreads(sessions: string): Promise<AgentThreadRecord[]> {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - index)
    const year = String(date.getFullYear())
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return path.join(sessions, year, month, day)
  })
  const entries = await Promise.all(
    days.map(async day => {
      const names = await readdir(day).catch(() => [])
      return names
        .filter(name => rolloutPattern.test(name))
        .toSorted((left, right) => right.localeCompare(left))
        .map(name => path.join(day, name))
    }),
  )
  const rollouts = entries.flat()
  const records: AgentThreadRecord[] = []
  for (let offset = 0; offset < rollouts.length && records.length < recentLimit; offset += recentLimit) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Stop scanning once there are enough visible chats.
    const batch = await Promise.all(rollouts.slice(offset, offset + recentLimit).map(readMetadata))
    records.push(...batch.filter(record => record !== undefined))
  }
  return records.slice(0, recentLimit)
}

async function readMetadata(locator: string): Promise<AgentThreadRecord | undefined> {
  try {
    await using file = await open(locator, 'r')
    const buffer = Buffer.allocUnsafe(128 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0]
    const entry = object(decode(line ?? ''))
    const payload = object(entry?.payload)
    const id = string(payload?.id)
    const cwd = string(payload?.cwd)
    if (entry?.type !== 'session_meta' || !id || !path.isAbsolute(cwd)) return undefined
    if (payload?.thread_source === 'subagent' || Object.hasOwn(object(payload?.source) ?? {}, 'subagent'))
      return undefined
    const fileInfo = await file.stat()
    return {
      id,
      provider: 'codex',
      title: string(payload?.agent_nickname) || path.basename(cwd),
      cwd,
      locator,
      updatedAt: fileInfo.mtimeMs,
    }
  } catch {
    return undefined
  }
}

async function legacyTurnStatus(locator: string): Promise<boolean | undefined> {
  try {
    await using file = await open(locator, 'r')
    const { size } = await file.stat()
    const length = Math.min(512 * 1024, size)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(buffer, 0, length, size - length)
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').toReversed()) {
      const entry = object(decode(line))
      if (entry?.type !== 'event_msg') continue
      const type = object(entry.payload)?.type
      if (type === 'task_started' || type === 'turn_started') return true
      if (type === 'task_complete' || type === 'turn_completed' || type === 'turn_aborted') return false
    }
  } catch {
    // The producer may have just archived its rollout.
  }
  return undefined
}

export const codexSource: AgentThreadSource = {
  async list() {
    const root = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'))
    if (!(await stat(root)).isDirectory()) throw new Error('Codex storage is unavailable.')
    const sessions = path.join(root, 'sessions')
    const [state, history, opened] = await Promise.all([
      databasePath(root, 'state'),
      databasePath(root, 'thread_history'),
      openThreads(sessions, path.join(root, 'thread-writer-locks')),
    ])
    const ids = new Set(opened.ids)
    for (const filename of opened.rollouts) {
      const id = rolloutPattern.exec(path.basename(filename))?.[1]
      if (id) ids.add(id)
    }
    const { records, subagentIds } = indexedThreads(state, ids, sessions)
    if (!records.size) {
      for (const record of await recentThreads(sessions)) records.set(record.locator, record)
    }
    const missing = [...opened.rollouts].filter(locator => {
      const id = rolloutPattern.exec(path.basename(locator))?.[1]
      return !records.has(locator) && (!id || !subagentIds.has(id))
    })
    for (const record of await Promise.all(missing.map(readMetadata))) {
      if (record) records.set(record.locator, record)
    }
    const visibleOpenIds = new Set([...records.values()].map(record => record.id).filter(id => ids.has(id)))
    const statuses = projectedTurnStatus(history, visibleOpenIds)
    const threads = await Promise.all(
      [...records.values()].map(async record => {
        const file = await stat(record.locator).catch(() => undefined)
        if (!file?.isFile()) return undefined
        const isOpen = ids.has(record.id)
        record.active = isOpen ? (statuses.get(record.id) ?? (await legacyTurnStatus(record.locator))) : undefined
        record.status =
          record.active === true ? 'running' : record.active === false ? 'idle' : isOpen ? 'unknown' : 'recent'
        record.updatedAt = Math.max(file.mtimeMs, record.updatedAt)
        return record
      }),
    )
    return threads.filter(thread => thread !== undefined)
  },
  open(thread) {
    return {
      async read() {
        const images: TranscriptImages = { local: new Map(), remaining: MAX_TRANSCRIPT_IMAGE_BYTES }
        const reader = readJsonLines(thread.locator, () => {
          const seenReasoning = new Set<string>()
          return record => parseRollout(record, thread.cwd, { seenReasoning, images })
        })
        const events = await reader.read()
        for (const [image, filename] of images.local) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Apply the byte budget before opening the next image.
          attachImageData(image, await localImageUrl(filename, images.remaining), images)
        }
        return events
      },
    }
  },
  async summarize(thread) {
    const records = await recentJsonRecords(thread.locator)
    return latestActivity(records.flatMap(record => parseRollout(record, thread.cwd, { summary: true })))
  },
}
