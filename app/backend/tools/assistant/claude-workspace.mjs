// Copyright (c) 2026 The Billy Company
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { mediaType } from '../../../shared/documents/media-types.ts'
import { fileContent } from '../../workspace/documents/file-content.ts'
import { operationPath } from '../../workspace/repository/file-operations.ts'

export const MAX_CLAUDE_FILE_BYTES = 512 * 1024
export const MAX_CLAUDE_READ_FILES = 8
export const MAX_CLAUDE_EDIT_FILES = 16
const PRIVATE_NAME =
  /^(?:\.env(?:\.|$)|\.git$|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|\.ssh$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|(?:credentials|secrets)\.json$)|\.(?:pem|key|p12|pfx|keystore)$/iu
function unavailable() {
  return new Error('The Creature can access only regular project text files in scope.')
}

class ClaudeLineRangeError extends Error {}

/** @param {string} text @param {number} limit */
export function clip(text, limit) {
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '')
}

/** @param {string} text @param {unknown} [start] @param {unknown} [last] @param {number} [limit] */
export function lineRange(text, start = 1, last, limit = 6500) {
  return rangeFromLines(text.split(/\r\n?|\n/u), start, last, limit)
}

/** @param {string[]} lines @param {unknown} [start] @param {unknown} [last] @param {number} [limit] */
export function rangeFromLines(lines, start = 1, last, limit = 6500) {
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1)
    throw new ClaudeLineRangeError('Choose a valid line range.')
  const end = last === undefined ? start + 79 : last
  if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < start)
    throw new ClaudeLineRangeError('Choose a valid line range.')
  if (start > lines.length) throw new ClaudeLineRangeError(`This text has ${lines.length} lines.`)
  const selected = []
  let remaining = limit
  let clippedLine = false
  for (let index = start - 1; index < Math.min(end, start + 119, lines.length); index++) {
    const line = lines[index] ?? ''
    if (remaining <= 0) break
    if (line.length > remaining && selected.length) break
    if (line.length > remaining) clippedLine = true
    const excerpt = clip(line, remaining)
    selected.push(excerpt)
    remaining -= excerpt.length + 1
  }
  const endLine = start + selected.length - 1
  return {
    startLine: start,
    endLine,
    totalLines: lines.length,
    text: selected.join('\n'),
    truncated: clippedLine || endLine < Math.min(end, lines.length),
    nextLine: endLine < lines.length ? endLine + 1 : undefined,
    clippedLine: clippedLine || undefined,
  }
}

/** @param {unknown} filename @returns {filename is string} */
export function claudeVisiblePath(filename) {
  return (
    typeof filename === 'string' &&
    Boolean(filename) &&
    filename.length <= 4096 &&
    !filename.includes('\\') &&
    !filename.includes('\0') &&
    !mediaType(filename) &&
    !filename.split('/').some(part => !part || part === '.' || part === '..' || PRIVATE_NAME.test(part))
  )
}

/** @param {import('../../workspace/repository/file-operations.ts').Workspace} workspace @param {string} filename */
export async function claudeFilePath(workspace, filename) {
  if (!claudeVisiblePath(filename)) throw unavailable()
  const absolute = await operationPath(workspace, filename)
  if (absolute !== path.join(workspace.root, filename)) throw unavailable()
  return absolute
}

/** @param {import('node:fs/promises').FileHandle} handle @param {string} absolute */
export async function checkClaudeFile(handle, absolute) {
  const [metadata, current, parent] = await Promise.all([
    handle.stat(),
    lstat(absolute),
    realpath(path.dirname(absolute)),
  ])
  if (
    !metadata.isFile() ||
    !current.isFile() ||
    metadata.nlink !== 1 ||
    metadata.dev !== current.dev ||
    metadata.ino !== current.ino ||
    parent !== path.dirname(absolute) ||
    metadata.size > MAX_CLAUDE_FILE_BYTES
  )
    throw unavailable()
  return metadata
}

/** @param {import('node:fs/promises').FileHandle} handle @param {number} size */
export async function readClaudeBytes(handle, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CLAUDE_FILE_BYTES) throw unavailable()
  const buffer = Buffer.alloc(size + 1)
  let offset = 0
  while (offset < buffer.length) {
    // oxlint-disable-next-line no-await-in-loop -- Partial reads advance the offset for the next chunk.
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (!bytesRead) break
    offset += bytesRead
  }
  if (offset !== size) throw new Error('The file changed while the Creature was reading it.')
  return buffer.subarray(0, offset)
}

/** @param {import('../../workspace/repository/file-operations.ts').Workspace} workspace @param {unknown} filename */
export async function readClaudeFile(workspace, filename) {
  if (typeof filename !== 'string') throw unavailable()
  const absolute = await claudeFilePath(workspace, filename)
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0))
  try {
    const { size } = await checkClaudeFile(handle, absolute)
    const contents = fileContent(await readClaudeBytes(handle, size), filename)
    if (contents.kind !== 'text' || contents.limited) throw unavailable()
    return contents.value
  } finally {
    await handle.close()
  }
}

/** @typedef {{ path: string, side?: 'working' | 'head', start_line?: unknown, end_line?: unknown }} ClaudeReadRequest */

/**
 * @template T
 * @param {unknown} files
 * @param {(file: ClaudeReadRequest) => Promise<T>} read
 * @param {AbortSignal} signal
 * @returns {Promise<(T | { path?: string, error: string })[]>}
 */
export async function readClaudeFiles(files, read, signal) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_CLAUDE_READ_FILES)
    throw new Error(`Supply 1 to ${MAX_CLAUDE_READ_FILES} project files.`)
  signal.throwIfAborted()
  /** @type {unknown[]} */
  const requests = files
  return Promise.all(
    Array.from(requests, async file => {
      if (file === null || typeof file !== 'object' || Array.isArray(file) || !('path' in file))
        return { error: 'Supply the path of a project text file.' }
      const filename = file.path
      if (!claudeVisiblePath(filename)) return { error: 'Supply the path of a project text file.' }
      const side = 'side' in file ? file.side : undefined
      if (side !== undefined && side !== 'working' && side !== 'head')
        return { path: filename, error: 'Choose the working file or HEAD.' }
      try {
        const result = await read({
          path: filename,
          side,
          start_line: 'start_line' in file ? file.start_line : undefined,
          end_line: 'end_line' in file ? file.end_line : undefined,
        })
        signal.throwIfAborted()
        return result
      } catch (error) {
        signal.throwIfAborted()
        return {
          path: filename,
          error: error instanceof ClaudeLineRangeError ? error.message : 'This project text file could not be read.',
        }
      }
    }),
  )
}
