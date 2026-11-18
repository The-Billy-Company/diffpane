import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isBillyPath, readBillyText } from '../billy/native.ts'
import type { BillyContext } from '../billy/native.ts'

export interface BillyLane {
  readonly slug: string
  readonly recorded: readonly string[]
  readonly current: boolean
}

export interface BillyLanePage {
  readonly rows: readonly BillyLane[]
  readonly truncated: boolean
}

export interface BillyLaneFinding {
  readonly check: string
  readonly path?: string
  readonly line?: number
  readonly message: string
  readonly rules: readonly BillyLaneRule[]
}

export interface BillyLaneRule {
  readonly id: string
  readonly path: string
  readonly line?: number
}

export interface BillyLaneLog {
  readonly text: string
  readonly complete: boolean
  readonly readBytes: number
  readonly totalBytes?: number
}

export type BillyLaneChecks =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'saved'
      readonly capture: string
      readonly capturedAt?: number
      readonly conclusive: boolean
      readonly counts: Readonly<{ passed: number; failed: number; advisory: number; skipped: number }>
      readonly failedChecks: readonly string[]
      readonly findings: readonly BillyLaneFinding[]
      readonly findingsComplete: boolean
      readonly findingsTotal: number
    }

const LANES_LIMIT = 128
const FINDINGS_LIMIT = 12
const LANE_ROOT = '.local/lint-lanes'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspacePath(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = isAbsolute(value) ? relative(root, value) : value
  const normalized = sep === '/' ? path : path.replaceAll(sep, '/')
  return isBillyPath(normalized) ? normalized : undefined
}

function laneSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..' &&
    value !== '_host'
  )
}

function parseLane(value: unknown, root: string): BillyLane {
  if (
    !object(value) ||
    !laneSlug(value['slug']) ||
    !Array.isArray(value['recorded']) ||
    typeof value['current'] !== 'boolean'
  )
    throw new Error('Igor returned an invalid agent lane.')
  const recorded: string[] = []
  for (const input of value['recorded']) {
    const path = workspacePath(input, root)
    if (!path) throw new Error('Igor returned an invalid recorded path.')
    recorded.push(path)
  }
  return { slug: value['slug'], current: value['current'], recorded }
}

export async function listLanes(context: BillyContext): Promise<BillyLanePage> {
  const output = await context.run('igor', [
    'list',
    'checks',
    '--workspace',
    context.root,
    '--view',
    'lanes',
    '--format',
    'json',
    '--limit',
    String(LANES_LIMIT),
  ])
  const data: unknown = JSON.parse(output)
  if (!object(data) || !Array.isArray(data['rows']) || typeof data['truncated'] !== 'boolean')
    throw new Error('Igor returned an invalid lane listing.')
  const rows = data['rows'].map(row => parseLane(row, context.root))
  if (new Set(rows.map(row => row.slug)).size !== rows.length) throw new Error('Igor returned duplicate agent lanes.')
  return { rows, truncated: data['truncated'] }
}

function checkResults(rows: readonly unknown[]) {
  const counts = { passed: 0, failed: 0, advisory: 0, skipped: 0 }
  const failedChecks: string[] = []
  for (const row of rows) {
    if (!object(row) || typeof row['id'] !== 'string' || typeof row['status'] !== 'string')
      throw new Error('Igor returned an invalid saved check.')
    if (row['selected'] === false) continue
    if (row['status'] === 'pass') counts.passed++
    else if (row['status'] === 'fail') {
      failedChecks.push(row['id'])
      if (row['advisory'] === true) counts.advisory++
      else counts.failed++
    } else counts.skipped++
  }
  return { counts, failedChecks }
}

async function parseFindings(output: string, { root, signal }: BillyContext) {
  const data: unknown = JSON.parse(output)
  if (
    !object(data) ||
    !Array.isArray(data['rows']) ||
    typeof data['complete'] !== 'boolean' ||
    typeof data['total'] !== 'number' ||
    !Number.isSafeInteger(data['total']) ||
    data['total'] < data['rows'].length
  )
    throw new Error('Igor returned invalid saved findings.')
  const guides = new Map<string, Promise<string>>()
  const findings = await Promise.all(
    data['rows'].map(async (row: unknown): Promise<BillyLaneFinding> => {
      if (!object(row) || typeof row['linter'] !== 'string' || typeof row['message'] !== 'string')
        throw new Error('Igor returned an invalid saved finding.')
      const path = workspacePath(row['file'], root)
      const line =
        typeof row['line'] === 'number' && Number.isSafeInteger(row['line']) && row['line'] > 0
          ? row['line']
          : undefined
      const rules = Array.isArray(row['rulebook']) ? row['rulebook'].slice(0, 4) : []
      const references = await Promise.all(
        rules.map(async (rule: unknown): Promise<BillyLaneRule | null> => {
          if (!object(rule) || typeof rule['rule_id'] !== 'string' || typeof rule['guide'] !== 'string') return null
          const id = rule['rule_id']
          const [guide, anchor] = rule['guide'].split('#')
          if (!isBillyPath(guide) || !guide.startsWith('rulebook/') || !guide.endsWith('.md')) return null
          let source = guides.get(guide)
          if (!source && guides.size < FINDINGS_LIMIT) {
            source = readBillyText(root, guide, 128 * 1024, signal).catch(() => '')
            guides.set(guide, source)
          }
          const lines = (await source)?.split(/\r?\n/u)
          const heading = anchor?.toLowerCase()
          const rowIndex =
            lines?.findIndex(text => {
              const title = /^ {0,3}#{1,6}\s+(.+?)\s*#*$/u.exec(text)?.[1]
              return title?.toLowerCase() === heading && heading === id.toLowerCase()
            }) ?? -1
          return { id, path: guide, line: rowIndex >= 0 ? rowIndex + 1 : undefined }
        }),
      )
      return {
        check: row['linter'],
        path,
        line,
        message: row['message'],
        rules: references.filter(ref => ref !== null),
      }
    }),
  )
  signal.throwIfAborted()
  return { findings, findingsComplete: data['complete'], findingsTotal: data['total'] }
}

async function retainedRun(root: string, slug: string): Promise<string | null> {
  if (!laneSlug(slug)) throw new Error('Choose a recorded agent lane.')
  const laneRoot = join(root, LANE_ROOT)
  const directory = join(laneRoot, slug)
  try {
    // Billy's workspace can put .local on its native pool. Reject a symlink at
    // the lane itself while allowing the configured parent to resolve there.
    const [actual, parent, manifest] = await Promise.all([
      realpath(directory),
      realpath(laneRoot),
      lstat(join(directory, 'manifest.json')),
    ])
    if (actual !== join(parent, slug) || dirname(actual) !== parent || !manifest.isFile())
      throw new Error('The lane does not have a regular saved check manifest.')
    return actual
  } catch (error) {
    if (object(error) && error['code'] === 'ENOENT') return null
    throw error
  }
}

async function readManifest(context: BillyContext, directory: string) {
  const output = await context.run('igor', [
    'list',
    'checks',
    '--workspace',
    context.root,
    '--run',
    directory,
    '--format',
    'json',
    '--view',
    'manifest',
  ])
  const data: unknown = JSON.parse(output)
  if (!object(data) || !Array.isArray(data['results'])) throw new Error('Igor returned an invalid check manifest.')
  return { data, capture: createHash('sha256').update(output).digest('hex'), ...checkResults(data['results']) }
}

export async function readLaneChecks(context: BillyContext, slug: string): Promise<BillyLaneChecks> {
  const directory = await retainedRun(context.root, slug)
  if (!directory) return { kind: 'missing' }
  const { data, capture, counts, failedChecks } = await readManifest(context, directory)
  const capturedAt =
    typeof data['captured_at_ns'] === 'number' && data['captured_at_ns'] >= 0 && data['captured_at_ns'] <= 8.64e21
      ? Math.floor(data['captured_at_ns'] / 1_000_000)
      : undefined
  const conclusive = data['selection_complete'] === true && data['evidence_state'] === 'conclusive'
  let evidence = { findings: [] as readonly BillyLaneFinding[], findingsComplete: false, findingsTotal: 0 }
  if (counts.failed || counts.advisory) {
    try {
      const findings = await context.run(
        'igor',
        [
          'list',
          'checks',
          '--workspace',
          context.root,
          '--run',
          directory,
          '--format',
          'json',
          '--view',
          'findings',
          '--limit',
          String(FINDINGS_LIMIT),
          '--max-bytes',
          '131072',
        ],
        { accept: [0, 1] },
      )
      // Each Igor operation takes its own snapshot. Keep results together only
      // while the native manifest identifies the same completed capture.
      if (capture === (await readManifest(context, directory)).capture)
        evidence = await parseFindings(findings, context)
    } catch (error) {
      if (context.signal.aborted) throw error
    }
  }
  return { kind: 'saved', capture, conclusive, capturedAt, counts, failedChecks, ...evidence }
}

export async function readLaneLog(
  context: BillyContext,
  slug: string,
  check: string,
  capture: string,
): Promise<BillyLaneLog> {
  if (!laneSlug(check) || !/^[a-f0-9]{64}$/u.test(capture)) throw new Error('Choose a saved check result.')
  const directory = await retainedRun(context.root, slug)
  if (!directory) throw new Error('This run no longer has saved evidence.')
  const before = await readManifest(context, directory)
  if (before.capture !== capture) throw new Error('The saved run changed. Refresh the agent lane.')
  if (!before.failedChecks.includes(check)) throw new Error('Choose a failed check from the saved run.')
  const output = await context.run(
    'igor',
    [
      'show',
      'checks',
      '--workspace',
      context.root,
      '--run',
      directory,
      '--format',
      'json',
      '--view',
      'log',
      '--max-bytes',
      '16384',
      '--tail',
      '80',
      '--',
      check,
    ],
    { accept: [0, 1] },
  )
  const data: unknown = JSON.parse(output)
  if (!object(data) || data['id'] !== check || typeof data['log'] !== 'string' || !object(data['coverage']))
    throw new Error('Igor returned an invalid saved log.')
  const { read_bytes: readBytes, total_bytes: totalBytes, complete } = data['coverage']
  if (
    typeof readBytes !== 'number' ||
    !Number.isSafeInteger(readBytes) ||
    readBytes < 0 ||
    typeof complete !== 'boolean'
  )
    throw new Error('Igor did not report saved log coverage.')
  if ((await readManifest(context, directory)).capture !== capture)
    throw new Error('The saved run changed. Refresh the agent lane.')
  return {
    text: data['log'],
    complete,
    readBytes,
    totalBytes:
      typeof totalBytes === 'number' && Number.isSafeInteger(totalBytes) && totalBytes >= readBytes
        ? totalBytes
        : undefined,
  }
}
