// Copyright (c) 2026 The Billy Company
import { access } from 'node:fs/promises'
import path from 'node:path'
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml'
import type { Node } from 'yaml'
import type { BillyClaim, BillyClaimsResult } from '../../../shared/billy/claims.ts'
import { isBillyPath, readBillyText } from '../billy/native.ts'
import type { BillyDocRadarContext } from '../billy/native.ts'

const maxCandidates = 128
const maxClaims = 16
const maxDocumentBytes = 192 * 1024
const assertionKinds = [
  { key: 'sentinels', kind: 'sentinel', subject: 'file' },
  { key: 'occurrences', kind: 'occurrence', subject: 'file' },
  { key: 'paths_exist', kind: 'path', subject: 'path' },
] as const

const sentinelFields = ['contains', 'absent', 'matches', 'absent_matches'] as const

interface Predicate {
  field: (typeof sentinelFields)[number] | 'pattern'
  value: string
}

interface ClaimDeclaration extends BillyClaim {
  subject: string
  predicates: Predicate[]
  resultKey: string
}

interface VerifyFinding {
  kind: string
  adr: string
  detail: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readDeclarationText(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined
}

function readStrings(node: unknown): string[] {
  const items = isSeq(node) ? node.items : [node]
  return items.flatMap(item => {
    const value = readDeclarationText(item)
    return value === undefined ? [] : [value]
  })
}

function frontmatter(text: string) {
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) return /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text)?.[1]
  if (text.startsWith('<!--\n') || text.startsWith('<!--\r\n')) return /^<!--\r?\n([\s\S]*?)\r?\n-->/u.exec(text)?.[1]
  return undefined
}

async function exists(root: string, target: string) {
  return (
    isBillyPath(target) &&
    access(path.join(root, target)).then(
      () => true,
      () => false,
    )
  )
}

function resultKey(document: string) {
  if (!document.endsWith('/README.md') && document !== 'README.md') return `doc:${path.posix.parse(document).name}`
  const parent = path.posix.dirname(document)
  return `doc:${parent === '.' ? 'root' : parent.replaceAll('/', '-')}-readme`
}

async function matchedSubject(
  root: string,
  document: string,
  input: string,
  selected: string,
  kind: BillyClaim['kind'],
) {
  if (kind === 'path') return input === selected ? input : null
  const sibling = path.posix.join(path.posix.dirname(document), input)
  if (input === selected) return sibling === input || !(await exists(root, sibling)) ? input : null
  if (sibling !== selected) return null
  if (await exists(root, sibling)) return sibling
  // A deleted sibling may have fallen out of the selected tree. Keep the link
  // as long as the declaration did not resolve to a surviving root-level file.
  return (await exists(root, input)) ? null : input
}

function assertionEntries(value: unknown) {
  if (isMap(value)) return value.items.map(pair => ({ entry: pair.value, key: pair.key }))
  if (isSeq(value)) return value.items.map(entry => ({ entry, key: null }))
  return [{ entry: value, key: null }]
}

async function readDeclarations(root: string, selected: string, filename: string, text: string) {
  const body = frontmatter(text)
  if (body === undefined) return { claims: [], incomplete: false }
  const lineCounter = new LineCounter()
  const yaml = parseDocument<Node>(body, { lineCounter, strict: true, logLevel: 'silent' })
  const adr = filename.startsWith('docs/architecture/3-decisions/')
  const block = yaml.get(adr && /\/\d[^/]+\.md$/u.test(filename) ? 'adr_radar' : 'doc_radar', true)
  if (yaml.errors.length) return { claims: [], incomplete: body.includes('doc_radar') || body.includes('adr_radar') }
  if (!isMap(block)) return { claims: [], incomplete: block !== undefined }
  const probes = assertionKinds.flatMap(({ key, kind, subject }) =>
    assertionEntries(block.get(key, true)).flatMap(({ entry, key: mapKey }) => {
      const name = readDeclarationText(
        (isMap(entry) ? entry.get(subject, true) : undefined) ?? mapKey ?? (kind === 'path' ? entry : undefined),
      )
      if (!name) return []
      const position = isScalar(mapKey)
        ? mapKey.range?.[0]
        : isMap(entry) || isScalar(entry)
          ? entry.range?.[0]
          : undefined
      const description = isMap(entry) ? readDeclarationText(entry.get('description', true)) : undefined
      let predicates: Predicate[] = []
      if (isMap(entry) && kind === 'sentinel')
        predicates = sentinelFields.flatMap(field =>
          readStrings(entry.get(field, true)).map(value => ({ field, value })),
        )
      if (isMap(entry) && kind === 'occurrence')
        predicates = readStrings(entry.get('pattern', true)).map(value => ({ field: 'pattern', value }))
      if (kind !== 'path' && !predicates.length) return []
      return [{ kind, name, description, position, predicates }]
    }),
  )
  const candidates = probes.filter(
    ({ name }) => name === selected || path.posix.join(path.posix.dirname(filename), name) === selected,
  )
  const claims = await Promise.all(
    candidates.slice(0, maxClaims).map(async candidate => {
      const subject = await matchedSubject(root, filename, candidate.name, selected, candidate.kind)
      if (!subject) return null
      const label =
        candidate.description ??
        (candidate.predicates.length ? candidate.predicates.map(item => item.value).join(' · ') : 'Path assertion')
      return {
        path: filename,
        line: candidate.position === undefined ? 2 : lineCounter.linePos(candidate.position).line + 1,
        kind: candidate.kind,
        label: label.slice(0, 600),
        findings: [],
        subject,
        predicates: candidate.predicates,
        resultKey: resultKey(filename),
      } satisfies ClaimDeclaration
    }),
  )
  return {
    claims: claims.filter(claim => claim !== null),
    incomplete: candidates.length > maxClaims,
  }
}

function parseCandidates(stdout: string) {
  return [...new Set(stdout.split('\0').map(item => item.replace(/^\.\//u, '')))].filter(
    item => isBillyPath(item) && /\.(?:md|mdc)$/u.test(item) && !item.startsWith('research/'),
  )
}

function compareCandidates(left: string, right: string, target: string) {
  const parent = path.posix.dirname(target)
  return (
    Number(path.posix.dirname(right) === parent) - Number(path.posix.dirname(left) === parent) ||
    left.localeCompare(right)
  )
}

function verificationFindings(output: string, expected: readonly string[]): VerifyFinding[] {
  const data: unknown = JSON.parse(output)
  if (
    !record(data) ||
    !Array.isArray(data.scoped) ||
    data.scoped.length !== expected.length ||
    !data.scoped.every((document: unknown) => typeof document === 'string' && expected.includes(document)) ||
    !Array.isArray(data.findings) ||
    data.finding_count !== data.findings.length ||
    data.assertion_doc_count !== expected.length
  )
    throw new Error('Doc Radar did not verify the requested declarations.')
  return data.findings.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.kind !== 'string' ||
      typeof item.adr !== 'string' ||
      typeof item.detail !== 'string'
    )
      throw new Error('Doc Radar returned an invalid finding.')
    return { kind: item.kind, adr: item.adr, detail: item.detail }
  })
}

function findingApplies(claim: ClaimDeclaration, finding: VerifyFinding, selected: string) {
  if (claim.resultKey !== finding.adr) return false
  const { detail, kind } = finding
  if (claim.kind === 'path') {
    const subject = `\`${claim.subject}\``
    return (
      (kind === 'doc_path_missing' && detail.startsWith(`referenced path ${subject}`)) ||
      (kind === 'doc_gate_missing' && detail.startsWith(`gated path ${subject}`)) ||
      ((kind === 'doc_authority_conflict' || kind === 'doc_gate_unknown') && detail.startsWith(subject))
    )
  }
  const prefix = claim.kind === 'sentinel' ? 'doc_sentinel_' : 'doc_occurrence_'
  if (!kind.startsWith(prefix)) return false
  const mentionsSubject = (subject: string) => detail.includes(`\`${subject}\``)
  if (!mentionsSubject(claim.subject) && !mentionsSubject(selected)) return false
  if (detail.includes('does not exist')) return true
  if (claim.kind === 'occurrence') return claim.predicates.some(({ value }) => detail.includes(`\`${value}\``))
  return claim.predicates.some(({ field, value }) => {
    const marker = `\`${value}\``
    switch (field) {
      case 'contains':
        return detail.includes(` no longer contains ${marker}`)
      case 'absent':
        return detail.includes(` still contains retired marker ${marker}`)
      case 'matches':
        return (
          detail.includes(` no longer matches pattern ${marker}`) ||
          detail.startsWith(`invalid matches pattern ${marker}`)
        )
      case 'absent_matches':
        return (
          detail.includes(` still matches retired pattern ${marker}`) ||
          detail.startsWith(`invalid absent_matches pattern ${marker}`)
        )
      case 'pattern':
        break
    }
    return false
  })
}

export async function readBillyClaims(context: BillyDocRadarContext, pathname: string): Promise<BillyClaimsResult> {
  if (!isBillyPath(pathname)) throw new Error('Choose a source file inside Billy.')
  const { root, signal } = context
  const args = [
    '--no-index',
    '--no-follow',
    '--hidden',
    '--fixed-strings',
    '--files-with-matches',
    '--null',
    '--threads=2',
    '--glob=*.md',
    '--glob=*.mdc',
    '--glob=!**/.git/**',
    '--glob=!research/**',
    '--max-filesize=192K',
    '-e',
    pathname,
    '-e',
    path.posix.basename(pathname),
    '--',
    '.',
  ]
  const raw = await context.run('gist', args, { accept: [0, 1], timeoutMs: 5000 })
  const candidates = parseCandidates(raw).toSorted((left, right) => compareCandidates(left, right, pathname))
  let limited = candidates.length > maxCandidates
  // One batch per wave keeps file descriptors and parser memory small when a
  // common basename names many prose files.
  const declarations: ClaimDeclaration[] = []
  for (
    let index = 0;
    index < Math.min(candidates.length, maxCandidates) && declarations.length < maxClaims;
    index += 8
  ) {
    signal.throwIfAborted()
    // oxlint-disable-next-line eslint/no-await-in-loop -- Bound each wave independently.
    const wave = await Promise.allSettled(
      candidates
        .slice(index, Math.min(index + 8, maxCandidates))
        .map(async filename =>
          readDeclarations(root, pathname, filename, await readBillyText(root, filename, maxDocumentBytes, signal)),
        ),
    )
    for (const outcome of wave) {
      if (outcome.status === 'fulfilled') {
        declarations.push(...outcome.value.claims)
        limited ||= outcome.value.incomplete
      } else limited = true
    }
    limited ||= declarations.length >= maxClaims && index + 8 < candidates.length
  }
  signal.throwIfAborted()
  limited ||= declarations.length > maxClaims
  const selected = declarations.slice(0, maxClaims)
  const documents = [...new Set(selected.map(item => item.path))]
  let findings: VerifyFinding[] = []
  let verification: BillyClaimsResult['verification'] = 'unavailable'
  if (documents.length) {
    try {
      findings = verificationFindings(await context.verifyDocRadar(documents), documents)
      verification = 'scoped'
    } catch {
      signal.throwIfAborted()
    }
  }
  const declaringPaths = new Map<string, Set<string>>()
  for (const claim of selected) {
    const paths = declaringPaths.get(claim.resultKey)
    if (paths) paths.add(claim.path)
    else declaringPaths.set(claim.resultKey, new Set([claim.path]))
  }
  findings = findings.filter(finding => {
    if ((declaringPaths.get(finding.adr)?.size ?? 0) <= 1) return true
    limited = true
    return false
  })
  return {
    claims: selected.map(claim => ({
      path: claim.path,
      line: claim.line,
      kind: claim.kind,
      label: claim.label,
      findings: findings
        .filter(finding => findingApplies(claim, finding, pathname))
        .map(finding => finding.detail.slice(0, 1000)),
    })),
    limited,
    verification,
  }
}
