// Copyright (c) 2026 The Billy Company
/** @import { GitCommit, GitComparison, GitFile, GitOverview, GitRef } from '../../../shared/review/git.ts' */
/** @typedef {(args: readonly string[]) => Promise<Buffer>} ReadGit */

export const GIT_HISTORY_LIMIT = 1_000
const logOptions = [
  'log',
  '--no-show-signature',
  '--encoding=UTF-8',
  '--decorate=full',
  '--clear-decorations',
  '--decorate-refs=refs/heads/*',
  '--decorate-refs=refs/remotes/*',
  '--decorate-refs=refs/tags/*',
  '-z',
  '--format=%H%x00%P%x00%ct%x00%s%x00%D',
]
const diffOptions = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=none',
  '--find-renames',
  '--raw',
  '--numstat',
  '-z',
]
const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** @param {unknown} value @returns {value is string} */
export function isGitOid(value) {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(value)
}

/** @param {unknown} value @returns {GitComparison} */
export function parseGitComparison(value) {
  if (value && typeof value === 'object' && 'kind' in value) {
    if (
      value.kind === 'working' &&
      'mode' in value &&
      (value.mode === 'head' || value.mode === 'staged' || value.mode === 'unstaged')
    )
      return { kind: 'working', mode: value.mode }
    if (
      value.kind === 'revision' &&
      'target' in value &&
      'base' in value &&
      isGitOid(value.target) &&
      (value.base === null || isGitOid(value.base))
    )
      return { kind: 'revision', base: value.base, target: value.target }
  }
  throw new Error('Unknown Git comparison.')
}

/** @param {string} decorations @returns {GitRef[]} */
function refsFromDecorations(decorations) {
  /** @type {GitRef[]} */
  const refs = []
  for (const decoration of decorations.split(', ')) {
    const ref = decoration.replace(/^(?:HEAD -> |tag: )/u, '')
    if (ref.startsWith('refs/heads/')) refs.push({ name: ref.slice(11), kind: 'branch' })
    else if (ref.startsWith('refs/remotes/')) refs.push({ name: ref.slice(13), kind: 'remote' })
    else if (ref.startsWith('refs/tags/')) refs.push({ name: ref.slice(10), kind: 'tag' })
  }
  return refs
}

/** @param {Buffer} bytes @returns {GitCommit[]} */
function parseCommits(bytes) {
  const fields = bytes.toString('utf8').slice(0, -1).split('\0')
  /** @type {GitCommit[]} */
  const commits = []
  if (bytes.length === 0) return commits
  for (let index = 0; index < fields.length; index += 5) {
    const [id, parentField, timestamp, subject, decorations] = fields.slice(index, index + 5)
    const parents = parentField ? parentField.split(' ') : []
    const committedAt = Number(timestamp) * 1000
    if (
      !isGitOid(id) ||
      !parents.every(isGitOid) ||
      !timestamp ||
      !Number.isSafeInteger(committedAt) ||
      subject === undefined ||
      decorations === undefined
    ) {
      throw new Error('Git returned an invalid commit record.')
    }
    commits.push({ id, parents, subject, committedAt, refs: refsFromDecorations(decorations) })
  }
  return commits
}

/**
 * @param {ReadGit} read
 * @param {string | null} head
 * @param {string} branch
 * @param {unknown} dayStartMs
 * @param {unknown} dayEndMs
 * @param {unknown} [historyLimit]
 * @returns {Promise<GitOverview>}
 */
export async function gitWorkspaceOverview(read, head, branch, dayStartMs, dayEndMs, historyLimit = 100) {
  if (
    typeof dayStartMs !== 'number' ||
    typeof dayEndMs !== 'number' ||
    !Number.isSafeInteger(dayStartMs) ||
    !Number.isSafeInteger(dayEndMs) ||
    dayStartMs >= dayEndMs
  ) {
    throw new Error('Invalid date range for Git activity.')
  }
  const limit =
    typeof historyLimit === 'number' && Number.isSafeInteger(historyLimit)
      ? Math.min(GIT_HISTORY_LIMIT, Math.max(1, historyLimit))
      : 100
  const firstSecond = Math.ceil(dayStartMs / 1000)
  const lastSecond = Math.ceil(dayEndMs / 1000) - 1
  const [history, duringDay, prior] = await Promise.all([
    read([
      ...logOptions,
      '--topo-order',
      `--max-count=${limit + 1}`,
      ...(head ? [head] : []),
      '--branches',
      '--remotes',
      '--tags',
      '--',
    ]),
    head
      ? read([...logOptions, `--since-as-filter=@${firstSecond}`, `--until=@${lastSecond}`, head, '--'])
      : Buffer.alloc(0),
    head
      ? read([
          'log',
          '--no-show-signature',
          '--first-parent',
          `--until=@${firstSecond - 1}`,
          '-1',
          '--format=%H',
          head,
          '--',
        ])
      : Buffer.alloc(0),
  ])
  const commits = parseCommits(history)
  const today = parseCommits(duringDay)
    .filter(commit => commit.committedAt >= dayStartMs && commit.committedAt < dayEndMs)
    .toSorted((a, b) => b.committedAt - a.committedAt)
  const dayBase = prior.toString('ascii').trim() || null
  return { head, branch, commits: commits.slice(0, limit), today, dayBase, historyHasMore: commits.length > limit }
}

/** @param {string | undefined} value @returns {string} */
function requiredPath(value) {
  if (!value) throw new Error('Git returned a change without a path.')
  return value
}

/** @param {Buffer} bytes @returns {GitFile[]} */
function parseChanges(bytes) {
  const fields = pathDecoder.decode(bytes).split('\0')
  /** @type {Map<string, GitFile>} */
  const files = new Map()
  let index = 0
  // Git emits all raw path/status records before the numstat section.
  while (fields[index]?.startsWith(':')) {
    const metadata = fields[index++]?.split(' ') ?? []
    const status = metadata[4]?.charAt(0)
    if (!status) throw new Error('Git returned an invalid change status.')
    const first = requiredPath(fields[index++])
    const renamed = status === 'R' || status === 'C'
    const path = renamed ? requiredPath(fields[index++]) : first
    const submodule = metadata[0] === ':160000' || metadata[1] === '160000'
    const existing = files.get(path)
    if (existing?.status === 'U') continue
    files.set(path, {
      path,
      originalPath: renamed ? first : null,
      status: submodule ? 'S' : status,
      additions: null,
      deletions: null,
    })
  }
  while (index < fields.length - 1) {
    const stat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(fields[index++] ?? '')
    if (!stat) throw new Error('Git returned invalid change counts.')
    // Renames have an extra NUL followed by the original and destination paths.
    let path = stat[3]
    if (!path) {
      index += 1
      path = requiredPath(fields[index++])
    }
    const file = files.get(path)
    if (file && file.status !== 'S' && file.status !== 'U' && stat[1] !== '-' && stat[2] !== '-') {
      file.additions = Number(stat[1])
      file.deletions = Number(stat[2])
    }
  }
  return [...files.values()]
}

/** @param {ReadGit} read @param {readonly string[]} endpoints */
export async function gitWorkspaceChanges(read, endpoints) {
  return parseChanges(await read([...diffOptions, ...endpoints, '--']))
}
