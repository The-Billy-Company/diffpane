import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'smol-toml'
import type { BillyPlaybook, BillyPlaybookRoute, BillyReplayRun } from '../../../shared/billy/replay.ts'
import { projectReplayCase, record, scenarioId, text, texts } from './transcript.ts'

const registry = 'contracts/domain/agent/playbooks.toml'
const promptRoot = 'services/ai/agent/prompts/'
const registryLimit = 2 * 1024 * 1024
const caseLimit = 32 * 1024 * 1024
const manifestLimit = 512 * 1024
const maxSelectedRuns = 32
const maxScenarios = 2048
const routeFields: [string, BillyPlaybookRoute['kind']][] = [
  ['method_for', 'Mission'],
  ['surface_for', 'Surface'],
  ['tool_for', 'Tool'],
  ['connector_for', 'Connector'],
  ['native_for', 'Native format'],
]

function hasCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

async function readLocalText(directory: string, filename: string, limit: number) {
  const absolute = path.join(directory, filename)
  const parent = path.dirname(absolute)
  if ((await realpath(parent)) !== parent) throw new Error('The evidence directory changed.')
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const initial = await handle.stat()
    if (!initial.isFile() || initial.nlink !== 1) throw new Error('Choose an ordinary local evidence file.')
    if (initial.size > limit) throw new Error('The evidence file is too large to open.')
    const bytes = Buffer.alloc(initial.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- Each partial read advances the descriptor offset.
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const [current, resolvedParent] = await Promise.all([lstat(absolute), realpath(parent)])
    if (
      offset !== initial.size ||
      resolvedParent !== parent ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      current.size !== initial.size ||
      current.mtimeMs !== initial.mtimeMs ||
      current.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error('The file changed while reading.')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

async function readReplayJson(directory: string, filename: string, limit: number) {
  const contents = await readLocalText(directory, filename, limit)
  try {
    const value: unknown = JSON.parse(contents)
    return value
  } catch {
    // Parser details can include raw transcript text.
    throw new Error('The evidence file does not contain valid JSON.')
  }
}

async function readPlaybook(root: string, source: unknown): Promise<BillyPlaybook | null> {
  if (
    typeof source !== 'string' ||
    !source.startsWith(promptRoot) ||
    !source.endsWith('.j2') ||
    source.includes('\\') ||
    source.includes('\0') ||
    source.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
  ) {
    return null
  }
  try {
    const raw = await readLocalText(await realpath(root), registry, registryLimit)
    let data: unknown
    try {
      data = parse(raw)
    } catch {
      throw new Error('The current playbook registry could not be parsed.')
    }
    const playbooks = record(data)?.playbook
    if (!Array.isArray(playbooks)) return null
    const matches = (playbooks as unknown[]).map(record).filter(row => row?.path === source.slice(promptRoot.length))
    if (matches.length !== 1) return null
    const row = matches[0]
    const id = text(row?.id)
    const title = text(row?.title)
    if (!row || !id || !title) return null
    return {
      id,
      title,
      source,
      registry,
      trigger: text(row.trigger) ?? '',
      owningEval: text(row.owning_eval),
      routes: routeFields.flatMap(([field, kind]) => {
        const values = texts(row[field])
        return values?.length ? [{ kind, values }] : []
      }),
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }
}

async function readRun(directory: string): Promise<BillyReplayRun> {
  const raw = record(await readReplayJson(directory, 'run.json', manifestLimit))
  const scenarios = texts(raw?.scenarios)
  const build = text(raw?.build)
  if (
    !scenarios?.length ||
    scenarios.length > maxScenarios ||
    !scenarios.every(scenarioId) ||
    new Set(scenarios).size !== scenarios.length ||
    !build ||
    typeof raw?.commit !== 'string'
  ) {
    throw new Error('Choose a Billy Replay run.json with its saved scenario files.')
  }
  return { id: randomUUID(), build, commit: raw.commit, mode: text(record(raw.provenance)?.transport), scenarios }
}

export function createBillyReplayReader(pickRunFile: () => Promise<string | null>) {
  const selected = new Map<string, { directory: string; scenarios: ReadonlySet<string> }>()
  return {
    playbook: readPlaybook,
    async pickRun() {
      const filename = await pickRunFile()
      if (filename === null) return null
      if (!path.isAbsolute(filename) || path.basename(filename) !== 'run.json') {
        throw new Error('Choose the run.json index inside a retained Billy Replay run.')
      }
      const directory = await realpath(path.dirname(filename))
      const run = await readRun(directory)
      if (selected.size >= maxSelectedRuns) {
        const oldest = selected.keys().next().value
        if (oldest !== undefined) selected.delete(oldest)
      }
      selected.set(run.id, { directory, scenarios: new Set(run.scenarios) })
      return run
    },
    async readCase(runId: unknown, scenario: unknown) {
      const run = typeof runId === 'string' ? selected.get(runId) : undefined
      if (!run || !scenarioId(scenario) || !run.scenarios.has(scenario)) {
        throw new Error('Choose a scenario from an opened Replay run.')
      }
      try {
        const raw = await readReplayJson(run.directory, `${scenario}.json`, caseLimit)
        return projectReplayCase(raw, scenario)
      } catch (error) {
        if (hasCode(error, 'ENOENT')) throw new Error('The selected scenario file is missing.', { cause: error })
        if (hasCode(error, 'ELOOP')) throw new Error('The selected scenario file is a symbolic link.', { cause: error })
        throw error
      }
    },
  }
}
