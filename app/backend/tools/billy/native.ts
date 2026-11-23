// Copyright (c) 2026 The Billy Company
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

type BillyTool = 'igor' | 'relate' | 'gist'
interface RunOptions {
  accept?: readonly number[]
  timeoutMs?: number
}

export interface BillyContext {
  readonly root: string
  readonly signal: AbortSignal
  run(tool: BillyTool, args: readonly string[], options?: RunOptions): Promise<string>
}

export interface BillyDocRadarContext extends BillyContext {
  verifyDocRadar(documents: readonly string[]): Promise<string>
}

export interface BillyRelateContext extends BillyContext {
  runRelate(args: readonly string[], options?: RunOptions): Promise<{ stdout: string; stderr: string }>
}

const execute = promisify(execFile)
const MAX_OUTPUT = 4 * 1024 * 1024

export function isBillyPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.isWellFormed() &&
    !/[\\\0\r\n]/u.test(value) &&
    !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value)
  )
}

export async function readBillyText(
  root: string,
  pathname: string,
  maxBytes: number,
  signal?: AbortSignal,
  prefix = false,
): Promise<string> {
  signal?.throwIfAborted()
  if (!isBillyPath(pathname)) throw new Error('This path is outside the Billy workspace.')
  const candidate = path.resolve(root, pathname)
  if ((await realpath(candidate)) !== candidate) throw new Error('This path uses a symbolic link.')
  const file = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || (!prefix && metadata.size > maxBytes))
      throw new Error('This file exceeds the workspace reader limit or is unavailable.')
    const buffer = Buffer.alloc(Math.min(metadata.size + 1, maxBytes + Number(!prefix)))
    let offset = 0
    while (offset < buffer.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Short reads advance one owned descriptor offset.
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const [current, resolved] = await Promise.all([lstat(candidate), realpath(candidate)])
    signal?.throwIfAborted()
    if (
      resolved !== candidate ||
      !current.isFile() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      current.size !== metadata.size ||
      current.mtimeMs !== metadata.mtimeMs ||
      current.ctimeMs !== metadata.ctimeMs
    )
      throw new Error('The workspace file changed while reading.')
    if (!prefix && (offset > maxBytes || offset !== metadata.size))
      throw new Error('The workspace file could not be read completely.')
    return buffer.toString('utf8', 0, offset)
  } finally {
    await file.close()
  }
}

export async function isBillyWorkspace(root: string) {
  const markers = await Promise.allSettled([
    readBillyText(root, 'tools/igor/agent-guide.md', 4096, undefined, true),
    readBillyText(root, 'contracts/domain/agent/playbooks.toml', 4096, undefined, true),
    readBillyText(root, 'contracts/operate/codegen/generators.toml', 4096, undefined, true),
  ])
  return markers.every(result => result.status === 'fulfilled')
}

export async function resolveBillyTool(root: string, tool: BillyTool, toolPath = process.env.PATH): Promise<string> {
  const directories = new Set([
    ...(toolPath ?? '').split(path.delimiter),
    path.join(homedir(), '.local/bin'),
    path.join(homedir(), '.cargo/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])
  const name = process.platform === 'win32' ? `${tool}.exe` : tool
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue
    const relative = path.relative(root, directory)
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
      continue
    const candidate = path.join(directory, name)
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Probe the user's tool paths in precedence order.
      const [, metadata] = await Promise.all([access(candidate, constants.X_OK), stat(candidate)])
      if (metadata.isFile()) return candidate
    } catch {
      // Try the next installed tool location.
    }
  }
  throw new Error(`${tool} is unavailable. Install it using Billy’s developer setup.`)
}

export function createBillyContext(root: string, signal: AbortSignal): BillyDocRadarContext & BillyRelateContext {
  const binaries = new Map<BillyTool, Promise<string>>()
  async function run(
    tool: string,
    target: string,
    args: readonly string[],
    { accept = [0], timeoutMs = 10_000 }: RunOptions,
    env: NodeJS.ProcessEnv,
  ) {
    signal.throwIfAborted()
    const deadline = AbortSignal.timeout(timeoutMs)
    try {
      const result = await execute(target, [...args], {
        cwd: root,
        env: { ...env, GIST_HINTS: '0', IGOR_ERROR_FORMAT: 'json', GIST_NO_CONFIG: '1' },
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT,
        killSignal: 'SIGKILL',
        signal: AbortSignal.any([signal, deadline]),
        windowsHide: true,
      })
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'number' &&
        accept.includes(error.code) &&
        'stdout' in error &&
        typeof error.stdout === 'string' &&
        'stderr' in error &&
        typeof error.stderr === 'string'
      )
        return { stdout: error.stdout, stderr: error.stderr }
      const reason = deadline.aborted ? 'took too long' : 'could not read the requested evidence'
      throw new Error(`${tool} ${reason}.`, { cause: error })
    }
  }
  async function toolOutput(tool: BillyTool, args: readonly string[], options: RunOptions) {
    signal.throwIfAborted()
    let binary = binaries.get(tool)
    if (!binary) {
      binary = resolveBillyTool(root, tool)
      binaries.set(tool, binary)
    }
    return run(tool, await binary, args, options, process.env)
  }
  return {
    root,
    signal,
    async run(tool, args, options = {}) {
      return (await toolOutput(tool, args, options)).stdout
    },
    runRelate(args, options = {}) {
      return toolOutput('relate', args, options)
    },
    async verifyDocRadar(documents) {
      if (
        !documents.length ||
        documents.length > 24 ||
        !documents.every(document => isBillyPath(document) && /\.(?:md|mdc)$/u.test(document))
      )
        throw new Error('Choose a bounded set of workspace documents.')
      const binary = path.join(root, '.venv/bin/python')
      const result = await run(
        'Doc Radar',
        binary,
        ['-m', 'observe.trust.doc_radar', 'verify', '--strict', '--no-write', '--json', '--', ...documents],
        { accept: [0, 1], timeoutMs: 12_000 },
        { ...process.env, PYTHONPATH: path.join(root, 'scripts'), PYTHONDONTWRITEBYTECODE: '1' },
      )
      return result.stdout
    },
  }
}
