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
const MISSING_GIST = 'Gist is unavailable. Install the Gist CLI to search project text.'
const PRIVATE_GLOB =
  '{.git,.gist,.env,.env.*,.git-credentials,.netrc,.npmrc,.pypirc,.ssh,id_{rsa,dsa,ecdsa,ed25519},id_{rsa,dsa,ecdsa,ed25519}.*,{credentials,secrets}.json,*.{pem,key,p12,pfx,keystore}}'.replace(
    /[a-z]/gu,
    letter => `[${letter}${letter.toUpperCase()}]`,
  )
const run = promisify(execFile)

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
  if (!binary) throw new Error(MISSING_GIST)
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
    return { stdout, truncated: false }
  } catch (error) {
    signal.throwIfAborted()
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 1) return { stdout: '', truncated: false }
    if (code === 'ENOENT' || code === 'EACCES') throw new Error(MISSING_GIST, { cause: error })
    if (timeout.aborted || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
      return { stdout, truncated: true }
    }
    throw new Error('Gist could not search this workspace.', { cause: error })
  }
}

/**
 * Gist locates candidate files. The assistant's regular reader verifies each match before any source is returned.
 * @param {{root: string, scope: string}} workspace
 * @param {string} query
 * @param {boolean} matchCase
 * @param {AbortSignal} signal
 * @param {(filename: string) => Promise<string>} read
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function searchClaudeGist(workspace, query, matchCase, signal, read, env = process.env) {
  if (!query.trim() || query.length > MAX_GIST_QUERY_LENGTH || !query.isWellFormed() || /[\r\n\0]/u.test(query))
    throw new Error(`Use a nonblank, single-line phrase of up to ${MAX_GIST_QUERY_LENGTH} characters.`)
  signal.throwIfAborted()
  const scope = path.relative(workspace.root, workspace.scope).split(path.sep).join('/')
  if (scope && !visibleSearchPath(`${scope}/file`)) return { matches: [], truncated: false }
  const resolved = await realpath(workspace.scope).catch(() => null)
  signal.throwIfAborted()
  if (resolved !== workspace.scope)
    throw new Error('The project folder is unavailable. Reopen the workspace to search.')
  const { stdout, truncated } = await gistOutput(workspace.scope, query, matchCase, signal, env)
  const files = stdout.split('\0')
  const partialPath = Boolean(files.pop())
  /** @type {Set<string>} */
  const paths = new Set()
  for (const file of files) {
    const relative = file.replace(/^\.\//u, '')
    const filename = scope ? `${scope}/${relative}` : relative
    if (claudeVisiblePath(relative) && visibleSearchPath(filename)) paths.add(filename)
  }
  const results = await searchRepositoryContent(
    {
      contentSearchPaths: async () => ({
        paths: [...paths].toSorted((left, right) => left.localeCompare(right)).slice(0, MAX_CANDIDATES),
        truncated: truncated || partialPath || paths.size > MAX_CANDIDATES,
      }),
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
