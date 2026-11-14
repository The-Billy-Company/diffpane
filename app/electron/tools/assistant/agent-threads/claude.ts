import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AgentThreadEvent, AgentThreadFile } from '../../../../shared/agent-threads.ts'
import { readJsonLines } from './source.ts'
import type { AgentThreadSource } from './source.ts'

const run = promisify(execFile)
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const editTools = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const fileTools = new Set([...editTools, 'Read', 'LSP'])

interface ClaudeSessionRecord {
  id: string
  cwd: string
  title: string
  updatedAt: number
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
  return {
    id,
    cwd,
    title: string(row.name) || string(row.title) || `${path.basename(cwd) || cwd} (${id.slice(0, 8)})`,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
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

async function transcript(directory: string, session: ClaudeSessionRecord) {
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

function claudeEvents(initialCwd: string) {
  const toolCalls = new Map<string, { name: string; file?: AgentThreadFile }>()
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
        if (text && !/^<(?:local-command-|ide_|session-start-hook)/.test(text)) {
          events.push({ kind: row.isApiErrorMessage ? 'status' : row.type, text })
        }
      } else if (block.type === 'tool_use') {
        const name = string(block.name)
        const input = object(block.input)
        const id = string(block.id)
        if (!name || !id) continue
        const file = fileTools.has(name)
          ? fileReference(input?.file_path ?? input?.notebook_path, cwd, input?.offset ?? input?.line)
          : undefined
        toolCalls.set(id, { name, file })
        if (toolCalls.size > 256) {
          const oldest = toolCalls.keys().next().value
          if (oldest) toolCalls.delete(oldest)
        }
        const description = string(input?.description) || (name === 'Bash' ? string(input?.command) : '')
        events.push({ kind: 'tool', text: description ? `${name} · ${description}` : name, files: file && [file] })
      } else if (block.type === 'tool_result') {
        const id = string(block.tool_use_id)
        const tool = toolCalls.get(id)
        toolCalls.delete(id)
        if (block.is_error) {
          if (tool) events.push({ kind: 'status', text: `${tool.name} failed`, files: tool.file && [tool.file] })
          continue
        }
        const result = object(row.toolUseResult)
        const patch = result?.structuredPatch
        const firstChange = Array.isArray(patch) ? object(patch[0])?.newStart : undefined
        if (tool ? editTools.has(tool.name) : Array.isArray(patch)) {
          const file = fileReference(result?.filePath ?? tool?.file?.path, cwd, firstChange)
          if (file)
            events.push({
              kind: 'edit',
              text: result?.type === 'create' ? 'Created file' : 'Updated file',
              files: [file],
            })
        }
      }
    }
    return events
  }
}

export const claudeSource: AgentThreadSource = {
  async list() {
    const directory = configDirectory()
    // The CLI checks process ownership itself. The PID registry supports older CLI versions and GUI-only installations.
    const rows = (await runningClaudeSessions()) ?? (await registrySessions(directory))
    const sessions = new Map<string, ClaudeSessionRecord>()
    for (const row of rows) {
      const session = sessionRecord(row)
      const existing = session && sessions.get(session.id)
      if (session && (!existing || session.updatedAt > existing.updatedAt)) sessions.set(session.id, session)
    }
    return Promise.all(
      [...sessions.values()].map(async session => {
        const { locator, modifiedAt } = await transcript(directory, session)
        return {
          id: session.id,
          title: session.title,
          cwd: session.cwd,
          locator,
          provider: 'claude',
          active: true,
          updatedAt: Math.max(session.updatedAt, modifiedAt),
        }
      }),
    )
  },

  open(thread) {
    const directory = configDirectory()
    const parse = claudeEvents(thread.cwd)
    let locator = thread.locator
    let reader = readJsonLines(locator, parse)
    let nextLookup = 0
    return {
      async read() {
        // An idle session can be selected before Claude creates its transcript on the first prompt.
        if (Date.now() >= nextLookup) {
          nextLookup = Date.now() + 2_000
          if (!(await stat(locator).catch(() => undefined))?.isFile()) {
            const match = await transcript(directory, thread)
            if (match.locator !== locator) {
              locator = match.locator
              reader = readJsonLines(locator, parse)
            }
          }
        }
        return reader.read()
      },
    }
  },
}
