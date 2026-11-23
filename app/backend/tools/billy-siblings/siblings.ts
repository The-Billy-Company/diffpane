// Copyright (c) 2026 The Billy Company
import { posix } from 'node:path'
import type { BillySiblingExcerpt, BillySiblingMatch, BillySiblingResult } from '../../../shared/billy/siblings.ts'
import { isBillyPath, readBillyText } from '../billy/native.ts'
import type { BillyRelateContext } from '../billy/native.ts'

const candidateLimit = 6
const fileLimit = 256 * 1024
const previewLines = 9
const previewWidth = 360

type Location = Pick<BillySiblingExcerpt, 'path' | 'line'>
type Match = Location & Pick<BillySiblingMatch, 'grade'>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function location(value: unknown): Location {
  if (typeof value !== 'string') throw new Error('Relate returned an invalid source location.')
  const anchor = /^(?<path>.+)#L(?<line>[1-9][0-9]*)$/u.exec(value)?.groups
  const path = anchor?.path?.replace(/^\.\//u, '')
  const line = Number(anchor?.line)
  if (!isBillyPath(path) || !Number.isSafeInteger(line))
    throw new Error('Relate returned an invalid function location.')
  return { path, line }
}

function results(stdout: string, stderr: string, sourcePath: string, sourceLine: number, scope: string) {
  const lines = stdout.trim() ? stdout.trim().split('\n') : []
  const summaryLine = stderr.split('\n').find(line => line.trimStart().startsWith('{'))
  const summary: unknown = summaryLine === undefined ? null : JSON.parse(summaryLine)
  if (
    !record(summary) ||
    summary.verb !== 'similar' ||
    summary.unit !== 'function' ||
    summary.channel !== 'any' ||
    summary.source !== 'live' ||
    lines.length > candidateLimit
  )
    throw new Error('Relate did not return a complete function comparison.')
  const source = location(summary.probe)
  if (source.path !== sourcePath || source.line > sourceLine)
    throw new Error('Relate could not resolve the selected function.')

  const seen = new Set([`${source.path}#L${source.line}`])
  const candidates: Match[] = []
  for (const line of lines) {
    const row: unknown = JSON.parse(line)
    if (
      !record(row) ||
      row.channel !== 'any' ||
      (row.grade !== 'identical' && row.grade !== 'strong' && row.grade !== 'moderate') ||
      typeof row.distance !== 'number' ||
      !Number.isFinite(row.distance) ||
      row.distance < 0 ||
      row.distance > 1
    )
      throw new Error('Relate returned an invalid similarity result.')
    const match = location(row.unit)
    if (match.path !== scope && !match.path.startsWith(`${scope}/`))
      throw new Error('Relate returned a function outside the comparison scope.')
    const key = `${match.path}#L${match.line}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ ...match, grade: row.grade })
  }
  return { source, candidates }
}

function excerpt({ path, line }: Location, text: string | null): BillySiblingExcerpt {
  if (!text || text.includes('\0')) return { path, line, text: null }
  const lines = text.split(/\r?\n/u)
  const sample = lines
    .slice(line - 1, line - 1 + previewLines)
    .map(row => (row.length > previewWidth ? `${row.slice(0, previewWidth)}…` : row))
    .join('\n')
  return { path, line, text: sample || null }
}

function isNoFunction(error: unknown, probe: string) {
  if (!(error instanceof Error) || !record(error.cause)) return false
  const { code, stderr } = error.cause
  return (
    code === 2 && typeof stderr === 'string' && stderr.startsWith(`relate similar: no function contains ${probe} —`)
  )
}

export async function readBillySiblings(
  context: BillyRelateContext,
  filename: string,
  line: number,
): Promise<BillySiblingResult> {
  if (!isBillyPath(filename) || !Number.isSafeInteger(line) || line <= 0 || line > 0xffffffff)
    throw new Error('Choose a line in a workspace source file.')
  const { root, signal } = context
  const sourceText = await readBillyText(root, filename, fileLimit, signal)
  if (sourceText.includes('\0')) throw new Error('Choose a text source file.')
  if (line > sourceText.split('\n').length) return { kind: 'no-function' }
  const parent = posix.dirname(filename)
  const adjacent = posix.dirname(parent)
  const scope = adjacent !== '.' ? adjacent : parent === '.' ? filename : parent
  const probe = `./${filename}#L${line}`
  let output: { stdout: string; stderr: string }
  try {
    output = await context.runRelate(
      [
        'similar',
        probe,
        '--as',
        'any',
        '--unit',
        'function',
        '--min-grade',
        'moderate',
        '--top',
        String(candidateLimit),
        '--json',
        '--no-index',
        `./${scope}`,
      ],
      { accept: [0, 1], timeoutMs: 12_000 },
    )
  } catch (error) {
    if (isNoFunction(error, `./${filename}:${line}`)) return { kind: 'no-function' }
    throw error
  }
  const comparison = results(output.stdout, output.stderr, filename, line, scope)
  if (sourceText !== (await readBillyText(root, filename, fileLimit, signal)))
    throw new Error('The source changed during comparison. Try again.')
  const candidates = await Promise.all(
    comparison.candidates.map(async ({ grade, ...match }) => {
      let text: string | null = null
      try {
        text = await readBillyText(root, match.path, fileLimit, signal)
      } catch {
        signal.throwIfAborted()
      }
      return { ...excerpt(match, text), grade }
    }),
  )
  return { kind: 'ready', scope, source: excerpt(comparison.source, sourceText), candidates }
}
