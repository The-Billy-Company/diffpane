import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { AgentThreadEvent, AgentThreadFile } from '../../../../shared/agent-threads.ts'
import { activityText, latestActivity, readJsonLines, recentJsonRecords } from './source.ts'
import type { AgentThreadRecord, AgentThreadSource } from './source.ts'

const sessionId = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const editTools = new Set(['Write', 'StrReplace', 'Edit', 'MultiEdit', 'Delete'])
const fileTools = new Set(['Read', ...editTools])
const recentLimit = 40
const tailBytes = 64 * 1024
const activityWindow = 5 * 60 * 1000

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined
}

function string(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) return value
  try {
    const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function filePath(value: unknown): string {
  const filename = string(value)
  if (!filename || filename.includes('\0')) return ''
  if (!filename.startsWith('file:')) return filename
  try {
    return fileURLToPath(filename)
  } catch {
    return ''
  }
}

function fileUri(value: unknown): string {
  const uri = object(value)
  const candidate = uri?.scheme === 'file' ? filePath(uri.fsPath ?? uri.external ?? uri.path) : filePath(value)
  return path.isAbsolute(candidate) ? candidate : ''
}

function toolEvent(block: Record<string, unknown>, summary = false): AgentThreadEvent[] {
  const name = string(block.name)
  if (!name) return []
  const input = object(decode(block.input))
  if (!input) return []
  const filename = fileTools.has(name) ? filePath(input.path ?? input.file_path) : ''
  const offset = input.offset ?? input.line
  const files: AgentThreadFile[] = filename
    ? [
        {
          path: filename,
          line: typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : undefined,
        },
      ]
    : []
  if (editTools.has(name)) {
    return files.length ? [{ kind: 'edit', text: name === 'Delete' ? 'Deleted a file' : 'Edited a file', files }] : []
  }
  if (name === 'Read' && files.length) return [{ kind: 'tool', text: 'Read a file', files }]
  const detail = !summary && name === 'Shell' ? string(input.description) || string(input.command).slice(0, 300) : ''
  return [{ kind: 'tool', text: detail || name }]
}

function transcriptEvents(record: unknown, summary = false): AgentThreadEvent[] {
  const row = object(record)
  if (row?.type === 'turn_ended') {
    const text =
      row.status === 'success'
        ? 'Turn finished'
        : row.status === 'aborted'
          ? 'Turn interrupted'
          : 'Turn ended with an error'
    return [{ kind: 'status', text }]
  }
  const role = row?.role
  if (role !== 'user' && role !== 'assistant') return []
  const content = object(row?.message)?.content
  if (!Array.isArray(content)) return []
  const events: AgentThreadEvent[] = []
  for (const entry of content) {
    const block = object(entry)
    if (block?.type === 'text') {
      const text = string(block.text)
      if (text) events.push({ kind: role, text })
    } else if (role === 'assistant' && block?.type === 'tool_use') {
      events.push(...toolEvent(block, summary))
    }
  }
  return events
}

interface Transcript {
  id: string
  project: string
  locator: string
  updatedAt: number
}

async function transcriptEntries(projects: string): Promise<Transcript[]> {
  const children = await readdir(projects, { withFileTypes: true }).catch((error: unknown) => {
    if (object(error)?.code === 'ENOENT') return []
    throw error
  })
  const entries = await Promise.all(
    children
      .filter(entry => entry.isDirectory())
      .map(async ({ name: project }) => {
        const directory = path.join(projects, project, 'agent-transcripts')
        const files = await readdir(directory, { withFileTypes: true }).catch(() => [])
        return Promise.all(
          files.map(async entry => {
            const id = entry.isDirectory() ? entry.name : path.basename(entry.name, '.jsonl')
            if (!sessionId.test(id) || (!entry.isDirectory() && (!entry.isFile() || entry.name !== `${id}.jsonl`)))
              return undefined
            const locator = entry.isDirectory()
              ? path.join(directory, id, `${id}.jsonl`)
              : path.join(directory, entry.name)
            const info = await stat(locator).catch(() => undefined)
            return info?.isFile() ? { id, project, locator, updatedAt: info.mtimeMs } : undefined
          }),
        )
      }),
  )
  return entries.flat().filter((entry): entry is Transcript => entry !== undefined)
}

function cursorUserDirectory(home: string) {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Cursor', 'User')
}

async function workspaces(userDirectory: string): Promise<Map<string, string>> {
  const directory = path.join(userDirectory, 'workspaceStorage')
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async ({ name }) => {
        const data = decode(await readFile(path.join(directory, name, 'workspace.json'), 'utf8').catch(() => ''))
        return [name, fileUri(object(data)?.folder)] as const
      }),
  )
  return new Map(found.filter(([, cwd]) => cwd))
}

interface Header {
  title: string
  cwd?: string
  archived: boolean
  updatedAt: number
  local: boolean
  active?: boolean
  running: boolean
  activity?: string
}

function headers(databasePath: string, ids: string[], roots: Map<string, string>): Map<string, Header> {
  const result = new Map<string, Header>()
  try {
    using database = new DatabaseSync(databasePath, { readOnly: true })
    const columns = 'composerId, workspaceId, lastUpdatedAt, isArchived, value'
    const unarchived = database.prepare(`SELECT ${columns} FROM composerHeaders WHERE isArchived = 0`)
    const select = database.prepare(`SELECT ${columns} FROM composerHeaders WHERE composerId = ?`)
    const matches = [...unarchived.all(), ...ids.map(id => select.get(id))]
    const conversation = database.prepare(`
      SELECT json_extract(value, '$.status') AS status,
             json_extract(value, '$.isContinuationInProgress') AS continuing,
             json_array_length(value, '$.generatingBubbleIds') AS generating
      FROM cursorDiskKV WHERE key = ? AND json_valid(value)`)
    const headerChunk = database.prepare(
      "SELECT json_extract(value, '$[#-1]') AS value FROM cursorDiskKV WHERE key > ? AND key < ? AND json_valid(value) ORDER BY key DESC LIMIT 1",
    )
    const legacyHeader = database.prepare(
      "SELECT json_extract(value, '$.fullConversationHeadersOnly[#-1]') AS value FROM cursorDiskKV WHERE key = ? AND json_valid(value)",
    )
    const bubbleText = database.prepare(
      "SELECT substr(json_extract(value, '$.text'), 1, 512) AS text FROM cursorDiskKV WHERE key = ? AND json_valid(value)",
    )
    for (const row of matches) {
      if (!row) continue
      const id = string(row.composerId)
      if (!sessionId.test(id) || result.has(id)) continue
      const data = object(decode(row.value))
      const workspace = object(data?.workspaceIdentifier)
      const cwd = fileUri(workspace?.uri) || roots.get(string(row.workspaceId))
      const stateKey = `composerData:${id}`
      const prefix = `composerConvHeaders:${id}`
      const latest = headerChunk.get(`${prefix}:`, `${prefix};`)?.value ?? legacyHeader.get(stateKey)?.value
      const last = object(decode(latest))
      const local = !data?.isDraft && Boolean(last)
      const state = local ? conversation.get(stateKey) : undefined
      const activityAt = Date.parse(string(last?.createdAt))
      const updatedAt = Math.max(typeof row.lastUpdatedAt === 'number' ? row.lastUpdatedAt : 0, activityAt || 0)
      const grouping = object(last?.grouping)
      const generating =
        state?.status === 'generating' ||
        state?.continuing === 1 ||
        (typeof state?.generating === 'number' && state.generating > 0)
      // Cursor's live Agent Window worker can persist an aborted composer status during a running turn.
      const freshTurn =
        Date.now() - activityAt < activityWindow &&
        (last?.type === 1 || typeof grouping?.turnDurationMs !== 'number') &&
        (state?.status === 'aborted' || grouping?.toolFormerStatus === 'loading')
      const toolCase = string(grouping?.toolCallCase)
      const fileAction = fileToolCases.get(toolCase)
      const filename = filePath(grouping?.toolDisplayPath)
      const bubbleId = string(last?.bubbleId)
      const activity = toolCase
        ? activityText(
            fileAction && filename
              ? `${fileAction} ${path.basename(filename)}`
              : toolCase === 'shellToolCall'
                ? 'Shell command'
                : 'Tool call',
          )
        : bubbleId
          ? activityText(string(bubbleText.get(`bubbleId:${id}:${bubbleId}`)?.text))
          : undefined
      result.set(id, {
        title: string(data?.name),
        cwd,
        archived: row.isArchived === 1,
        updatedAt,
        local,
        active: generating || freshTurn || undefined,
        running: generating || (freshTurn && grouping?.toolFormerStatus === 'loading'),
        activity,
      })
    }
  } catch {
    // Older Cursor builds and custom data directories can still expose JSONL without the header database.
  }
  return result
}

const fileToolCases = new Map([
  ['readToolCall', 'Read'],
  ['writeToolCall', 'Write'],
  ['editToolCall', 'Edit'],
  ['deleteToolCall', 'Delete'],
])

function composerReader(databasePath: string, id: string) {
  let database: DatabaseSync | undefined
  const seen = new Set<string>()
  const finished = new Set<string>()
  const stableTools = new Set(['completed', 'error', 'failed', 'cancelled', 'rejected'])
  return {
    async read() {
      database ??= new DatabaseSync(databasePath, { readOnly: true })
      const select = database.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      const chunks = database.prepare(
        'SELECT value FROM cursorDiskKV WHERE key > ? AND key < ? ORDER BY key DESC LIMIT 3',
      )
      const prefix = `composerConvHeaders:${id}`
      const rows = chunks.all(`${prefix}:`, `${prefix};`).toReversed()
      const state = rows.length ? undefined : object(decode(select.get(`composerData:${id}`)?.value))
      const headings = rows.length ? rows.map(row => decode(row.value)) : [state?.fullConversationHeadersOnly]
      const events: AgentThreadEvent[] = []
      for (const section of headings) {
        if (!Array.isArray(section)) continue
        for (const value of section) {
          const heading = object(value)
          const group = object(heading?.grouping)
          const bubbleId = string(heading?.bubbleId)
          if (!bubbleId || group?.isSimulatedMsg) continue
          const toolStatus = string(group?.toolFormerStatus)
          const toolCase = string(group?.toolCallCase)
          const name = fileToolCases.get(toolCase)
          if (!seen.has(bubbleId) && (!name || name === 'Read' || !toolStatus || stableTools.has(toolStatus))) {
            const bubble = object(decode(select.get(`bubbleId:${id}:${bubbleId}`)?.value))
            const tool = object(bubble?.toolFormerData)
            const status = toolStatus || string(tool?.status)
            const text = string(bubble?.text)
            if (tool) {
              if (name && name !== 'Read' && !stableTools.has(status)) continue
              const params = object(decode(tool.params))
              const args = object(decode(tool.rawArgs))
              const filename =
                group?.toolDisplayPath ?? args?.path ?? params?.targetFile ?? params?.relativeWorkspacePath
              if (name && (name === 'Read' || status === 'completed')) {
                events.push(
                  ...toolEvent({ name, input: { path: filename, offset: args?.offset ?? params?.startLine } }),
                )
              } else if (toolCase === 'shellToolCall' || tool.name === 'run_terminal_command_v2') {
                events.push(
                  ...toolEvent({
                    name: 'Shell',
                    input: { description: params?.commandDescription, command: params?.command },
                  }),
                )
              } else {
                const toolName = string(tool.name)
                if (toolName) events.push({ kind: 'tool', text: toolName })
              }
              seen.add(bubbleId)
            } else if (text) {
              events.push({ kind: heading?.type === 1 ? 'user' : 'assistant', text })
              seen.add(bubbleId)
            }
          }
          if (typeof group?.turnDurationMs === 'number' && !finished.has(bubbleId)) {
            finished.add(bubbleId)
            events.push({ kind: 'status', text: 'Turn finished' })
          }
        }
      }
      return events
    },
    close() {
      database?.close()
      database = undefined
    },
  }
}

async function transcriptSummary({ locator, updatedAt }: Transcript, title: string) {
  const file = await open(locator, 'r').catch(() => undefined)
  if (!file) return { title, active: undefined }
  try {
    const { size } = await file.stat()
    const length = Math.min(tailBytes, size)
    if (!length) return { title, active: undefined }
    const tail = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(tail, 0, length, size - length)
    const rows = tail.subarray(0, bytesRead).toString('utf8').split('\n')
    const last = rows.findLast(row => row.trim() && object(decode(row)))
    const finalRecord = object(decode(last))
    // A prior turn can be followed by a fresh prompt in the same transcript.
    const active =
      Date.now() - updatedAt < activityWindow && (finalRecord?.role === 'user' || finalRecord?.role === 'assistant')
    if (!title) {
      const first = Buffer.allocUnsafe(Math.min(8192, size))
      const read = await file.read(first, 0, first.length, 0)
      const prompt = first
        .subarray(0, read.bytesRead)
        .toString('utf8')
        .split('\n')
        .map(decode)
        .find(row => object(row)?.role === 'user')
      title = transcriptEvents(prompt).find(event => event.kind === 'user')?.text ?? ''
    }
    return { title: title.replace(/\s+/g, ' ').slice(0, 120), active: active || undefined }
  } finally {
    await file.close()
  }
}

export const cursorSource: AgentThreadSource = {
  async list() {
    const home = homedir()
    const userDirectory = cursorUserDirectory(home)
    const databasePath = path.join(userDirectory, 'globalStorage', 'state.vscdb')
    const projectsRoot = path.join(home, '.cursor', 'projects')
    const [transcripts, roots, storage] = await Promise.all([
      transcriptEntries(projectsRoot),
      workspaces(userDirectory),
      Promise.allSettled([stat(databasePath), stat(projectsRoot)]),
    ])
    if (storage.every(result => result.status === 'rejected')) throw new Error('Cursor storage is unavailable.')
    transcripts.sort((left, right) => right.updatedAt - left.updatedAt)
    const index = headers(
      databasePath,
      transcripts.map(thread => thread.id),
      roots,
    )
    const projects = new Map([...roots.values()].map(cwd => [cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, ''), cwd]))
    const recentCutoff = Date.now() - activityWindow
    const local = [...index.entries()].flatMap(([id, header]) =>
      header.local
        ? [
            {
              id,
              provider: 'cursor',
              title: header.title || `Cursor thread ${id.slice(0, 8)}`,
              cwd: header.cwd ?? '',
              updatedAt: header.updatedAt,
              active: header.active,
              status: header.running ? 'running' : 'recent',
              activity: header.activity,
              locator: databasePath,
            } satisfies AgentThreadRecord,
          ]
        : [],
    )
    const available = transcripts
      .filter(thread => !index.get(thread.id)?.archived && !index.get(thread.id)?.local)
      .filter((thread, position) => position < recentLimit || thread.updatedAt >= recentCutoff)
    const records = await Promise.all(
      available.map(async thread => {
        const header = index.get(thread.id)
        const summary = await transcriptSummary(thread, header?.title ?? '')
        return {
          id: thread.id,
          provider: 'cursor',
          title: summary.title || `Cursor thread ${thread.id.slice(0, 8)}`,
          cwd: header?.cwd ?? projects.get(thread.project) ?? '',
          updatedAt: thread.updatedAt,
          active: summary.active,
          status: 'recent',
          locator: thread.locator,
        } satisfies AgentThreadRecord
      }),
    )
    return [...local, ...records]
      .filter(thread => !index.get(thread.id)?.archived)
      .toSorted(
        (left, right) =>
          Number(Boolean(right.active)) - Number(Boolean(left.active)) || right.updatedAt - left.updatedAt,
      )
      .filter((thread, position) => position < recentLimit || thread.active)
  },
  open(thread) {
    if (thread.locator.endsWith('state.vscdb')) return composerReader(thread.locator, thread.id)
    return readJsonLines(thread.locator, transcriptEvents)
  },
  async summarize(thread) {
    if (!thread.locator.endsWith('.jsonl')) return undefined
    const records = await recentJsonRecords(thread.locator)
    return latestActivity(records.flatMap(record => transcriptEvents(record, true)))
  },
}
