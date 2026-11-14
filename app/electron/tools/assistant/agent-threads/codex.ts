import { execFile } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { AgentThreadEvent, AgentThreadFile } from '../../../../shared/agent-threads.ts'
import { latestActivity, readJsonLines, recentJsonRecords } from './source.ts'
import type { AgentThreadRecord, AgentThreadSource } from './source.ts'

const run = promisify(execFile)
const recentLimit = 40
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

function message(kind: 'user' | 'assistant', content: unknown): AgentThreadEvent[] {
  const text = transcriptText(content).trim()
  if (!text) return []
  return [{ kind, text }]
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
  return [{ kind: 'edit', text: files.length === 1 ? 'Edited a file' : `Edited ${files.length} files`, files }]
}

function commandEvent(item: Record<string, unknown>, cwd: string, summary = false): AgentThreadEvent[] {
  const parts = item.parsed_cmd
  const files: AgentThreadFile[] = []
  if (Array.isArray(parts)) {
    for (const candidate of parts) {
      const part = object(candidate)
      const filename = string(part?.path)
      if (part?.type === 'read' && filename) files.push({ path: path.resolve(string(item.cwd) || cwd, filename) })
    }
  }
  if (summary) return [{ kind: 'tool', text: 'Shell command', files }]
  const command = Array.isArray(item.command) ? item.command.map(string).join(' ') : string(item.command)
  const text = command.replace(/^.*?\s-lc\s+(?=.)/, '').slice(0, 400)
  return [{ kind: 'tool', text: text || 'Ran a command', files }]
}

function parseItem(item: Record<string, unknown>, cwd: string, summary: boolean): AgentThreadEvent[] {
  switch (item.type) {
    case 'UserMessage':
      return message('user', item.content)
    case 'AgentMessage':
      return message('assistant', item.content)
    case 'FileChange':
      if (item.status === 'failed' || item.status === 'declined') return []
      return edit(item.changes, cwd)
    case 'CommandExecution':
      return commandEvent(item, cwd, summary)
    case 'McpToolCall':
      return [
        {
          kind: 'tool',
          text: [string(item.server), string(item.tool)].filter(Boolean).join(' / ') || 'Called an MCP tool',
        },
      ]
    default:
      return []
  }
}

function parseRollout(record: unknown, cwd: string, summary = false): AgentThreadEvent[] {
  const entry = object(record)
  const payload = object(entry?.payload)
  // Rollouts also store model context and raw tool payloads. Only the public transcript events are rendered.
  if (entry?.type !== 'event_msg' || !payload) return []
  switch (payload.type) {
    case 'item_completed': {
      const item = object(payload.item)
      return item ? parseItem(item, cwd, summary) : []
    }
    case 'item_started': {
      const item = object(payload.item)
      if (!summary || (item?.type !== 'CommandExecution' && item?.type !== 'McpToolCall')) return []
      return parseItem(item, cwd, summary)
    }
    case 'user_message':
      return message('user', payload.message)
    case 'agent_message':
      return message('assistant', payload.message)
    case 'patch_apply_end':
      return payload.success === true ? edit(payload.changes, cwd) : []
    case 'exec_command_end':
      return commandEvent(payload, cwd, summary)
    case 'task_started':
    case 'turn_started':
      return [{ kind: 'status', text: 'Turn started' }]
    case 'task_complete':
    case 'turn_completed':
      return [{ kind: 'status', text: 'Turn finished' }]
    case 'turn_aborted':
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
      timeout: 1_500,
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

function indexedThreads(filename: string | undefined, ids: Set<string>, sessions: string): AgentThreadRecord[] {
  if (!filename) return []
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
    const latest = database.prepare(`SELECT ${fields} FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?`)
    const byId = database.prepare(`SELECT ${fields} FROM threads WHERE archived = 0 AND id = ?`)
    const rows = [...latest.all(recentLimit), ...[...ids].flatMap(id => byId.all(id))]
    return rows.flatMap(row => {
      const id = string(row.id)
      const cwd = string(row.cwd)
      const locator = string(row.rollout_path)
      if (!id || !path.isAbsolute(cwd) || !locator.startsWith(`${sessions}${path.sep}`)) return []
      return [
        {
          id,
          provider: 'codex',
          title: string(row.title).replaceAll(/\s+/g, ' ').trim().slice(0, 160) || path.basename(cwd),
          cwd,
          locator,
          updatedAt: Number(row.updated_at) * 1_000,
        },
      ]
    })
  } catch {
    return []
  }
}

async function recentRollouts(sessions: string): Promise<string[]> {
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
  return entries.flat().slice(0, recentLimit)
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
    const indexed = indexedThreads(state, ids, sessions)
    const records = new Map(indexed.map(record => [record.locator, record]))
    const fallback = indexed.length ? [] : await recentRollouts(sessions)
    const missing = [...new Set([...opened.rollouts, ...fallback])].filter(locator => !records.has(locator))
    for (const record of await Promise.all(missing.map(readMetadata))) {
      if (record) records.set(record.locator, record)
    }
    const statuses = projectedTurnStatus(history, ids)
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
    return readJsonLines(thread.locator, record => parseRollout(record, thread.cwd))
  },
  async summarize(thread) {
    const records = await recentJsonRecords(thread.locator)
    return latestActivity(records.flatMap(record => parseRollout(record, thread.cwd, true)))
  },
}
