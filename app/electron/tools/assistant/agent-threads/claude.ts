import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentThreadEvent, AgentThreadFile, AgentThreadStatus } from '../../../../shared/agent-threads.ts'
import {
  activityText,
  latestActivity,
  readJsonLines,
  recentJsonRecords,
  sampleJsonRecords,
  toolCall,
} from './source.ts'
import type { AgentThreadRecord, AgentThreadSource } from './source.ts'

const run = promisify(execFile)
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const recentLimit = 40
const editTools = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const fileTools = new Set([...editTools, 'Read', 'LSP'])

interface ClaudeSessionRecord {
  id: string
  cwd: string
  title: string
  updatedAt: number
  status: AgentThreadStatus
  activity?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: unknown) {
  return isObject(value) ? value : undefined
}

function string(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function sessionRecord(input: unknown): ClaudeSessionRecord | undefined {
  const row = object(input)
  if (!row) return undefined
  const id = string(row.sessionId)
  const cwd = absoluteDirectory(row.cwd)
  if (!uuid.test(id) || !cwd) return undefined
  const updatedAt = row.updatedAt ?? row.statusUpdatedAt ?? row.startedAt
  let status: AgentThreadStatus = 'unknown'
  if (row.state === 'blocked') status = 'idle'
  else if (row.status === 'busy' || (!row.status && row.state === 'working')) status = 'running'
  else if (row.status === 'idle' || row.state === 'done' || row.state === 'failed' || row.state === 'stopped')
    status = 'idle'
  return {
    id,
    cwd,
    title: string(row.name) || string(row.title) || `${path.basename(cwd) || cwd} (${id.slice(0, 8)})`,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    status,
    activity: row.state === 'blocked' ? 'Waiting for input' : undefined,
  }
}

function configDirectory() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'))
}

function absoluteDirectory(value: unknown) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') ? value : undefined
}

async function runningClaudeSessions(): Promise<unknown[] | undefined> {
  const env = { ...process.env }
  // Finder launches do not inherit a terminal's PATH.
  env.PATH = [env.PATH, path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    .filter(Boolean)
    .join(path.delimiter)
  try {
    const { stdout } = await run('claude', ['agents', '--json'], { env, timeout: 2_000, maxBuffer: 1024 * 1024 })
    const rows: unknown = JSON.parse(stdout)
    return Array.isArray(rows) ? rows : undefined
  } catch {
    return undefined
  }
}

async function registrySessions(directory: string): Promise<unknown[]> {
  const sessions = path.join(directory, 'sessions')
  const entries = await readdir(sessions).catch(() => [])
  const rows = await Promise.all(
    entries
      .filter(name => /^[1-9]\d*\.json$/.test(name))
      .map(async name => {
        try {
          const pid = Number(path.basename(name, '.json'))
          const row = object(JSON.parse(await readFile(path.join(sessions, name), 'utf8')))
          if (row?.pid !== pid || (row.pidDomain && row.pidDomain !== process.platform)) return undefined
          process.kill(pid, 0)
          return row
        } catch {
          return undefined
        }
      }),
  )
  return rows.filter(Boolean)
}

async function transcript(directory: string, session: Pick<ClaudeSessionRecord, 'id' | 'cwd'>) {
  const projects = path.join(directory, 'projects')
  const cwd = await realpath(session.cwd).catch(() => session.cwd)
  const slug = cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-')
  const filename = `${session.id}.jsonl`
  const expected = path.join(projects, slug.slice(0, 200), filename)
  const expectedStat = await stat(expected).catch(() => undefined)
  if (expectedStat?.isFile()) return { locator: expected, modifiedAt: expectedStat.mtimeMs }

  // Resumed sessions and /cd can keep an earlier project directory. Long directory slugs also have a hash suffix.
  const directories = await readdir(projects, { withFileTypes: true }).catch(() => [])
  const matches = await Promise.all(
    directories
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const locator = path.join(projects, entry.name, filename)
        const info = await stat(locator).catch(() => undefined)
        return info?.isFile() ? { locator, modifiedAt: info.mtimeMs } : undefined
      }),
  )
  return (
    matches.reduce(
      (latest, match) => (match && (!latest || match.modifiedAt > latest.modifiedAt) ? match : latest),
      undefined,
    ) ?? { locator: expected, modifiedAt: 0 }
  )
}

function fileReference(inputPath: unknown, cwd: string, line?: unknown): AgentThreadFile | undefined {
  if (typeof inputPath !== 'string' || !inputPath || inputPath.includes('\0')) return undefined
  const filename = path.resolve(cwd, inputPath)
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0
    ? { path: filename, line }
    : { path: filename }
}

function toolDescription(name: string, input: Record<string, unknown> | undefined, file?: AgentThreadFile) {
  const label = string(input?.description) || string(input?.summary) || string(input?.title)
  if (label) return label
  if (file) return `${name} ${path.basename(file.path)}`
  if (name === 'WebSearch' || name === 'ToolSearch') return string(input?.query)
  if (name === 'Grep' || name === 'Glob') return string(input?.pattern)
  return ''
}

function claudeEvents(initialCwd: string, summary = false) {
  const toolCalls = new Map<string, AgentThreadEvent>()
  return (record: unknown): AgentThreadEvent[] => {
    const row = object(record)
    if (!row || row.isMeta || row.isSidechain) return []
    if (row.type === 'system' && row.subtype === 'turn_duration') return [{ kind: 'status', text: 'Turn finished' }]
    if (row.type !== 'assistant' && row.type !== 'user') return []
    const content = object(row.message)?.content
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }]
    const cwd = absoluteDirectory(row.cwd) ?? initialCwd
    const events: AgentThreadEvent[] = []

    for (const item of blocks) {
      const block = object(item)
      if (!block) continue
      if (block.type === 'text') {
        const text = string(block.text)
        if (
          text &&
          !/^<(?:local-command-|command-name>|ide_|session-start-hook|system-reminder>|task-notification>)/.test(text)
        ) {
          events.push({ kind: row.isApiErrorMessage ? 'status' : row.type, text })
        }
      } else if (row.type === 'assistant' && block.type === 'tool_use') {
        const name = string(block.name)
        const input = object(block.input)
        const id = string(block.id)
        if (!name || !id) continue
        const file = fileTools.has(name)
          ? fileReference(input?.file_path ?? input?.notebook_path, cwd, input?.offset ?? input?.line)
          : undefined
        const command = name === 'Bash' && !summary ? string(input?.command) : ''
        const event = toolCall(name, {
          kind: editTools.has(name) ? 'edit' : 'tool',
          description: toolDescription(name, input, file) || command.split('\n', 1)[0],
          text: command,
          files: file && [file],
        })
        toolCalls.set(id, event)
        if (toolCalls.size > 256) {
          const oldest = toolCalls.keys().next().value
          if (oldest) toolCalls.delete(oldest)
        }
        events.push(event)
      } else if (block.type === 'tool_result') {
        const id = string(block.tool_use_id)
        const tool = toolCalls.get(id)
        toolCalls.delete(id)
        if (block.is_error) {
          if (tool) events.push({ kind: 'status', text: `${tool.toolName} failed` })
          continue
        }
        const result = object(row.toolUseResult)
        const patch = result?.structuredPatch
        const firstChange = Array.isArray(patch) ? object(patch[0])?.newStart : undefined
        if (tool?.kind === 'edit') {
          const file = fileReference(result?.filePath ?? tool.files?.[0]?.path, cwd, firstChange)
          if (file) tool.files = [file]
        }
      }
    }
    return events
  }
}

async function savedThreads(directory: string, liveIds: Set<string>): Promise<AgentThreadRecord[]> {
  const projects = path.join(directory, 'projects')
  const entries = await readdir(projects, { withFileTypes: true }).catch(() => [])
  const transcripts = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async project => {
        const folder = path.join(projects, project.name)
        const names = await readdir(folder, { withFileTypes: true }).catch(() => [])
        return Promise.all(
          names.map(async entry => {
            const id = path.basename(entry.name, '.jsonl')
            if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !uuid.test(id) || liveIds.has(id)) return undefined
            const locator = path.join(folder, entry.name)
            const info = await stat(locator).catch(() => undefined)
            return info?.isFile() ? { id, locator, updatedAt: info.mtimeMs } : undefined
          }),
        )
      }),
  )
  const recent = transcripts
    .flat()
    .filter(entry => entry !== undefined)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, recentLimit)
  const records = await Promise.all(
    recent.map(async ({ id, locator, updatedAt }) => {
      const [start, end] = await Promise.all([sampleJsonRecords(locator, 'start'), recentJsonRecords(locator)])
      const rows = [...start, ...end].map(object)
      const cwd = rows.map(row => absoluteDirectory(row?.cwd)).findLast(Boolean)
      if (!cwd) return undefined
      const prompt = start.flatMap(claudeEvents(cwd)).find(event => event.kind === 'user')?.text
      const customTitle = rows.findLast(row => row?.type === 'custom-title')?.customTitle
      const aiTitle = rows.findLast(row => row?.type === 'ai-title')?.aiTitle
      const inferredTitle = [string(customTitle), string(aiTitle), prompt].find(Boolean)
      const title = activityText(inferredTitle ?? '') ?? path.basename(cwd)
      return { id, locator, updatedAt, provider: 'claude', cwd, title, status: 'recent' } satisfies AgentThreadRecord
    }),
  )
  return records.filter(record => record !== undefined)
}

export const claudeSource: AgentThreadSource = {
  async list() {
    const directory = configDirectory()
    // The CLI checks process ownership itself. The PID registry supports older CLI versions and GUI-only installations.
    const running = await runningClaudeSessions()
    if (!running && !(await stat(directory)).isDirectory()) throw new Error('Claude Code storage is unavailable.')
    const rows = running ?? (await registrySessions(directory))
    const sessions = new Map<string, ClaudeSessionRecord>()
    for (const row of rows) {
      const session = sessionRecord(row)
      const existing = session && sessions.get(session.id)
      if (session && (!existing || session.updatedAt > existing.updatedAt)) sessions.set(session.id, session)
    }
    const live = await Promise.all(
      [...sessions.values()].map(async session => {
        const { locator, modifiedAt } = await transcript(directory, session)
        return {
          id: session.id,
          title: session.title,
          cwd: session.cwd,
          locator,
          provider: 'claude',
          active: true,
          status: session.status,
          activity: session.activity,
          updatedAt: Math.max(session.updatedAt, modifiedAt),
        } satisfies AgentThreadRecord
      }),
    )
    return [...live, ...(await savedThreads(directory, new Set(sessions.keys())))]
  },

  open(thread) {
    const directory = configDirectory()
    return {
      async read() {
        // An idle session can be selected before Claude creates its transcript on the first prompt.
        const locator = (await stat(thread.locator).catch(() => undefined))?.isFile()
          ? thread.locator
          : (await transcript(directory, thread)).locator
        return readJsonLines(locator, () => claudeEvents(thread.cwd)).read()
      },
    }
  },
  async summarize(thread) {
    const parse = claudeEvents(thread.cwd, true)
    return latestActivity((await recentJsonRecords(thread.locator)).flatMap(parse))
  },
}
