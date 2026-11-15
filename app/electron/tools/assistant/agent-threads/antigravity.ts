import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { AgentThreadEvent, AgentThreadStatus } from '../../../../shared/agent-threads.ts'
import { latestActivity, readJsonLines, recentJsonRecords, toolCall } from './source.ts'
import type { AgentThreadRecord, AgentThreadSource } from './source.ts'

const sessionId = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i
const products = ['antigravity', 'antigravity-cli', 'antigravity-ide']
const recentLimit = 40
const activeStatuses = ['CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 'CASCADE_RUN_STATUS_CANCELING']
const fileTools = new Map([
  ['read_file', 'Reading'],
  ['view_file', 'Reading'],
  ['edit_file', 'Editing'],
  ['write_file', 'Writing'],
  ['replace_file_content', 'Editing'],
  ['multi_replace_file_content', 'Editing'],
])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: unknown) {
  return isObject(value) ? value : undefined
}

function string(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function decode(value: string | undefined): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function localFolder(value: unknown) {
  const uri = string(value)
  if (!uri.startsWith('file:')) return ''
  try {
    const filename = fileURLToPath(uri)
    return path.isAbsolute(filename) && !filename.includes('\0') ? filename : ''
  } catch {
    return ''
  }
}

function workspaceFolder(value: unknown) {
  const raw = string(value)
  if (!raw) return ''
  const parsed = decode(raw)
  const uris = Array.isArray(parsed) ? parsed : raw.split(/[,\s\0]+/)
  return uris.map(localFolder).find(Boolean) ?? ''
}

async function projectFolder(gemini: string, id: string) {
  if (!sessionId.test(id)) return ''
  const json = await readFile(path.join(gemini, 'config', 'projects', `${id}.json`), 'utf8').catch(() => '')
  const resources = object(object(decode(json))?.projectResources)?.resources
  if (!Array.isArray(resources)) return ''
  const folders = resources.map(resource => localFolder(object(object(resource)?.gitFolder)?.folderUri)).filter(Boolean)
  return new Set(folders).size === 1 ? (folders[0] ?? '') : ''
}

function transcript(gemini: string, product: string, id: string) {
  return path.join(gemini, product, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
}

function toolEvent(tool: unknown, cwd: string): AgentThreadEvent[] {
  const call = object(tool)
  const name = string(call?.name)
  if (!name) return []
  const args = object(call?.args)
  const description = string(args?.toolSummary) || string(args?.Description ?? args?.description) || string(args?.title)
  const verb = fileTools.get(name)
  const filename = string(args?.Path ?? args?.AbsolutePath ?? args?.TargetFile)
  if (verb && filename && !filename.includes('\0')) {
    const rawLine = args?.StartLine
    const line = typeof rawLine === 'number' && Number.isSafeInteger(rawLine) && rawLine > 0 ? rawLine : undefined
    return [
      toolCall(name, {
        kind: verb === 'Reading' ? 'tool' : 'edit',
        description: description || `${verb} ${path.basename(filename)}`,
        files: path.isAbsolute(filename) || cwd ? [{ path: filename, line }] : undefined,
      }),
    ]
  }
  return [toolCall(name, { description })]
}

function events(value: unknown, cwd: string): AgentThreadEvent[] {
  const step = object(value)
  if (!step) return []
  const text = string(step.content)
  if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT' && text) return [{ kind: 'user', text }]
  // Tool results and system records can include raw provider context. Only surface user-facing messages and calls.
  if (step.type !== 'PLANNER_RESPONSE' || step.source !== 'MODEL') return []
  return [
    ...(text ? [{ kind: 'assistant' as const, text }] : []),
    ...(Array.isArray(step.tool_calls) ? step.tool_calls.flatMap(tool => toolEvent(tool, cwd)) : []),
  ]
}

async function summarizeTranscript(locator: string, cwd: string) {
  const records = await recentJsonRecords(locator)
  return latestActivity(records.flatMap(record => events(record, cwd)).filter(event => event.kind !== 'user'))
}

function threadStatus(row: Record<string, unknown>): AgentThreadStatus {
  if (row.killed === 1) return 'recent'
  const state = string(row.status)
  if (activeStatuses.includes(state) || row.not_fully_idle === 1) return 'running'
  return state === 'CASCADE_RUN_STATUS_IDLE' ? 'idle' : 'unknown'
}

function readIndex(filename: string) {
  using database = new DatabaseSync(filename, { readOnly: true, timeout: 0 })
  const fields =
    'conversation_id, title, workspace_uris, status, last_modified_time, killed, not_fully_idle, project_id'
  const all = database.prepare(`SELECT ${fields} FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT ?`)
  const live = database.prepare(
    `SELECT ${fields} FROM conversation_summaries WHERE killed = 0 AND (not_fully_idle = 1 OR status IN (?, ?, ?))`,
  )
  return new Map([...all.all(recentLimit), ...live.all(...activeStatuses)].map(row => [row.conversation_id, row]))
}

async function indexedThreads(gemini: string, product: string) {
  const filename = path.join(gemini, product, 'conversation_summaries.db')
  await stat(filename)
  const rows = readIndex(filename)
  const projects = new Map<string, Promise<string>>()
  return Promise.all(
    [...rows.values()]
      .filter(row => sessionId.test(string(row.conversation_id)))
      .map(async (row): Promise<AgentThreadRecord> => {
        const id = string(row.conversation_id)
        const project = string(row.project_id)
        let cwd = workspaceFolder(row.workspace_uris)
        if (!cwd) {
          let fallback = projects.get(project)
          if (!fallback) {
            fallback = projectFolder(gemini, project)
            projects.set(project, fallback)
          }
          cwd = await fallback
        }
        const locator = transcript(gemini, product, id)
        const status = threadStatus(row)
        return {
          id,
          provider: 'antigravity',
          cwd,
          locator,
          title: string(row.title).replaceAll(/\s+/g, ' ').slice(0, 160) || `Antigravity thread ${id.slice(0, 8)}`,
          updatedAt: Date.parse(string(row.last_modified_time).replace(' ', 'T')) || 0,
          active: status === 'running',
          status,
          activity: await summarizeTranscript(locator, cwd).catch(() => undefined),
        }
      }),
  )
}

async function transcriptThreads(gemini: string, product: string) {
  const brain = path.join(gemini, product, 'brain')
  const ids = (await readdir(brain, { withFileTypes: true })).filter(
    entry => entry.isDirectory() && sessionId.test(entry.name),
  )
  const records = await Promise.all(
    ids.map(async ({ name: id }): Promise<AgentThreadRecord | undefined> => {
      const locator = transcript(gemini, product, id)
      const info = await stat(locator).catch(() => undefined)
      if (!info?.isFile()) return undefined
      return {
        id,
        provider: 'antigravity',
        cwd: '',
        title: `Antigravity thread ${id.slice(0, 8)}`,
        updatedAt: info.mtimeMs,
        locator,
        status: 'unknown',
      }
    }),
  )
  return records
    .filter(item => item !== undefined)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, recentLimit)
}

export function createAntigravitySource(gemini: string): AgentThreadSource {
  return {
    async list() {
      const results = await Promise.allSettled(
        products.map(product =>
          indexedThreads(gemini, product).catch((error: unknown) => {
            if (object(error)?.code !== 'ENOENT') throw error
            return transcriptThreads(gemini, product)
          }),
        ),
      )
      if (results.every(result => result.status === 'rejected'))
        throw new Error('Antigravity thread data is unavailable.')
      const threads = new Map<string, AgentThreadRecord>()
      for (const result of results) {
        if (result.status === 'rejected') continue
        for (const thread of result.value) {
          const previous = threads.get(thread.id)
          const statusPriority = Number(thread.status !== 'unknown') - Number(previous?.status !== 'unknown')
          if (!previous || statusPriority > 0 || (statusPriority === 0 && thread.updatedAt > previous.updatedAt)) {
            threads.set(thread.id, thread)
          }
        }
      }
      return [...threads.values()]
    },

    summarize(thread) {
      return summarizeTranscript(thread.locator, thread.cwd)
    },

    open(thread) {
      return readJsonLines(thread.locator, () => {
        let lastStep = -1
        return value => {
          const step = object(value)?.step_index
          if (typeof step === 'number') {
            if (step <= lastStep) return []
            lastStep = step
          }
          return events(value, thread.cwd)
        }
      })
    },
  }
}

export const antigravitySource = createAntigravitySource(path.join(homedir(), '.gemini'))
