// Copyright (c) 2026 The Billy Company
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { searchRepositoryContent } from '../../workspace/repository/content-search.mjs'
import { claudeVisiblePath, MAX_CLAUDE_FILE_BYTES } from './claude-workspace.mjs'

export const MAX_GIST_QUERY_LENGTH = 256
const GIST_TIMEOUT_MS = 6000
const MAX_GIST_OUTPUT_BYTES = 128 * 1024
const MAX_CANDIDATES = 80
const MAX_MATCHES = 40
const MAX_MATCH_CHARS = 12_000
const PRIVATE_GLOB =
  '{.git,.gist,.env,.env.*,.git-credentials,.netrc,.npmrc,.pypirc,.ssh,id_{rsa,dsa,ecdsa,ed25519},id_{rsa,dsa,ecdsa,ed25519}.*,{credentials,secrets}.json,*.{pem,key,p12,pfx,keystore}}'.replace(
    /[a-z]/gu,
    letter => `[${letter}${letter.toUpperCase()}]`,
  )
const run = promisify(execFile)

/** @typedef {{root: string, scope: string}} SearchWorkspace */
/** @typedef {{path: string, line: number, column: number, text: string}} ClaudeSearchMatch */
/** @typedef {{matches: ClaudeSearchMatch[], truncated: boolean}} ClaudeSearchResult */
/** @typedef {(signal: AbortSignal) => Promise<{paths: readonly string[], truncated: boolean}>} SearchPaths */
/** @typedef {(query: string, matchCase: boolean, signal: AbortSignal) => Promise<ClaudeSearchResult>} FallbackSearch */

/** @param {NodeJS.ProcessEnv} env */
function gistBinary(env) {
  const executable = process.platform === 'win32' ? 'gist.exe' : 'gist'
  const directories = new Set([
    ...(env.PATH ?? '').split(path.delimiter),
    path.join(homedir(), '.local/bin'),
    path.join(homedir(), '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    const candidate = path.join(directory, executable)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through the application and login shell's usual tool paths.
    }
  }
  return null
}

/** @param {string} filename */
function visibleSearchPath(filename) {
  return claudeVisiblePath(filename) && !filename.toLowerCase().split('/').includes('.gist')
}

/**
 * @param {string} scope
 * @param {string} query
 * @param {boolean} matchCase
 * @param {AbortSignal} signal
 * @param {NodeJS.ProcessEnv} env
 */
async function gistOutput(scope, query, matchCase, signal, env) {
  const binary = gistBinary(env)
  if (!binary) return null
  const gistEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIST_')))
  const timeout = AbortSignal.timeout(GIST_TIMEOUT_MS)
  try {
    const { stdout } = await run(
      binary,
      [
        '--no-config',
        '--no-index',
        '--fixed-strings',
        '--files-with-matches',
        '--null',
        '--hidden',
        '--no-follow',
        '--path-separator=/',
        '--uncap',
        `--max-filesize=${MAX_CLAUDE_FILE_BYTES}`,
        `--glob=!${PRIVATE_GLOB}`,
        `--glob=!**/${PRIVATE_GLOB}/**`,
        matchCase ? '--case-sensitive' : '--ignore-case',
        `--regexp=${query}`,
        '--',
        '.',
      ],
      {
        cwd: scope,
        env: { ...gistEnv, GIST_HINTS: '0' },
        encoding: 'utf8',
        maxBuffer: MAX_GIST_OUTPUT_BYTES,
        signal: AbortSignal.any([signal, timeout]),
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    )
    return !stdout || stdout.includes('\0') ? { stdout, truncated: false } : null
  } catch (error) {
    signal.throwIfAborted()
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
    if (code === 1 && !stderr.trim()) return { stdout: '', truncated: false }
    if (timeout.aborted || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      if (stdout.includes('\0')) return { stdout, truncated: true }
    }
    return null
  }
}

/** @param {SearchWorkspace} workspace @param {string} query @param {AbortSignal} signal */
async function searchScope(workspace, query, signal) {
  if (!query.trim() || query.length > MAX_GIST_QUERY_LENGTH || !query.isWellFormed() || /[\r\n\0]/u.test(query))
    throw new Error(`Use a nonblank, single-line phrase of up to ${MAX_GIST_QUERY_LENGTH} characters.`)
  signal.throwIfAborted()
  const scope = path.relative(workspace.root, workspace.scope).split(path.sep).join('/')
  if (scope && !visibleSearchPath(`${scope}/file`)) return null
  const resolved = await realpath(workspace.scope).catch(() => null)
  signal.throwIfAborted()
  if (resolved !== workspace.scope)
    throw new Error('The project folder is unavailable. Reopen the workspace to search.')
  return scope
}

/**
 * Gist locates candidate files. The assistant's reader verifies each match.
 * @param {SearchWorkspace} workspace
 * @param {string} query
 * @param {boolean} matchCase
 * @param {AbortSignal} signal
 * @param {(filename: string) => Promise<string>} read
 * @param {NodeJS.ProcessEnv} [env]
 * @param {FallbackSearch} [fallback]
 * @returns {Promise<ClaudeSearchResult>}
 */
export async function searchClaudeGist(workspace, query, matchCase, signal, read, env = process.env, fallback) {
  const scope = await searchScope(workspace, query, signal)
  if (scope === null) return { matches: [], truncated: false }
  const output = await gistOutput(workspace.scope, query, matchCase, signal, env)
  if (!output) {
    signal.throwIfAborted()
    if (!fallback) throw new Error('Search could not start in this workspace.')
    const result = await fallback(query, matchCase, signal)
    signal.throwIfAborted()
    return result
  }
  const { stdout, truncated } = output
  const files = stdout.split('\0')
  const partialPath = Boolean(files.pop())
  /** @type {Set<string>} */
  const paths = new Set()
  for (const file of files) {
    const relative = file.replace(/^\.\//u, '')
    const filename = scope ? `${scope}/${relative}` : relative
    if (visibleSearchPath(relative)) paths.add(filename)
  }
  return scanFiles(scope, query, matchCase, signal, read, async () => ({
    paths: [...paths].toSorted((left, right) => left.localeCompare(right)).slice(0, MAX_CANDIDATES),
    truncated: truncated || partialPath || paths.size > MAX_CANDIDATES,
  }))
}

/**
 * Search Git's project inventory with the same output bounds as Gist.
 * @param {SearchWorkspace} workspace
 * @param {string} query
 * @param {boolean} matchCase
 * @param {AbortSignal} signal
 * @param {(filename: string) => Promise<string>} read
 * @param {SearchPaths} paths
 */
export async function searchClaudeFiles(workspace, query, matchCase, signal, read, paths) {
  const scope = await searchScope(workspace, query, signal)
  if (scope === null) return { matches: [], truncated: false }
  return scanFiles(scope, query, matchCase, signal, read, paths)
}

/**
 * @param {string} scope
 * @param {string} query
 * @param {boolean} matchCase
 * @param {AbortSignal} signal
 * @param {(filename: string) => Promise<string>} read
 * @param {SearchPaths} candidates
 * @returns {Promise<ClaudeSearchResult>}
 */
async function scanFiles(scope, query, matchCase, signal, read, candidates) {
  const results = await searchRepositoryContent(
    {
      async contentSearchPaths(_changed, pathSignal) {
        const { paths, truncated } = await candidates(pathSignal)
        return {
          paths: paths.filter(filename => visibleSearchPath(filename) && (!scope || filename.startsWith(`${scope}/`))),
          truncated,
        }
      },
      async contentSearchFile(filename, readSignal) {
        readSignal.throwIfAborted()
        const source = await read(filename).catch(() => null)
        return source === null ? null : { bytes: Buffer.byteLength(source), text: source }
      },
    },
    { query, scope: 'workspace', matchCase },
    signal,
  )
  signal.throwIfAborted()
  if (!results) return { matches: [], truncated: true }

  const matches = []
  let characters = 0
  for (const hit of results.matches) {
    const match = { path: hit.path, line: hit.line, column: hit.column, text: `${hit.before}${hit.match}${hit.after}` }
    characters += JSON.stringify(match).length + 1
    if (matches.length === MAX_MATCHES || characters > MAX_MATCH_CHARS) return { matches, truncated: true }
    matches.push(match)
  }
  return { matches, truncated: results.truncated }
}
