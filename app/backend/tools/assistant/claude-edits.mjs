import { randomUUID } from 'node:crypto'
import { diffArrays } from 'diff'
import { claudeVisiblePath, MAX_CLAUDE_EDIT_FILES, MAX_CLAUDE_FILE_BYTES } from './claude-workspace.mjs'

export const MAX_REPLACEMENT_CHARS = 6000
export const MAX_CREATION_CHARS = 24_000
export const MAX_FILE_REPLACEMENTS = 16
const MAX_PREVIEW_CHARS = 48_000
const MAX_PREVIEW_EDITS = 64

/** @typedef {{before: string, after: string, startLine: number}} FileEditPreview */
/** @typedef {{path: string, action: 'edit' | 'create', edits: FileEditPreview[]}} ChangedFilePreview */
/** @typedef {{path: string, text: string, expected: string | null}} FileChange */
/** @typedef {{kind: 'files', preview: {id: string, kind: 'files', files: ChangedFilePreview[]}, changes: FileChange[]}} FilesProposal */
/** @typedef {{text: string, lines: string[], offsets: number[], excerpts: {start: number, end: number}[]}} ReadSource */
/** @typedef {{change: FileChange, preview: ChangedFilePreview}} StagedFile */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value @param {number} limit @returns {value is string} */
function validText(value, limit) {
  return typeof value === 'string' && value.length <= limit && value.isWellFormed() && !value.includes('\0')
}

/** @param {string} text */
function newlineStyle(text) {
  const breaks = /\r\n|[\r\n]/gu
  const first = breaks.exec(text)?.[0]
  if (!first || first === '\n') return '\n'
  for (let next = breaks.exec(text); next; next = breaks.exec(text)) {
    if (next[0] !== first) return '\n'
  }
  return first
}

/** @param {string} source @param {unknown} inputBefore @param {unknown} inputAfter @param {number} [limit] */
export function replacement(source, inputBefore, inputAfter, limit = MAX_REPLACEMENT_CHARS) {
  const { before, after, start } = locateReplacement(source, inputBefore, inputAfter, undefined, limit)
  return { before, after, start, text: source.slice(0, start) + after + source.slice(start + before.length) }
}

/**
 * @param {string} source
 * @param {unknown} inputBefore
 * @param {unknown} inputAfter
 * @param {unknown} startLine
 * @param {number} limit
 * @param {string} [ending]
 * @param {number[]} [offsets]
 */
function locateReplacement(source, inputBefore, inputAfter, startLine, limit, ending = newlineStyle(source), offsets) {
  if (!validText(inputBefore, limit) || !validText(inputAfter, limit) || (!inputBefore && source))
    throw new Error(
      `Use an exact source snippet and replacement of at most ${limit} characters each. Use an empty snippet only for an empty file.`,
    )
  const before = ending === '\n' ? inputBefore : inputBefore.replace(/\r\n?|\n/gu, ending)
  const after = ending === '\n' ? inputAfter : inputAfter.replace(/\r\n?|\n/gu, ending)
  if (before === after) throw new Error('The source snippet and its replacement must differ.')
  let from = 0
  let until = source.length
  if (startLine !== undefined) {
    if (!offsets || typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1)
      throw new Error('Choose a valid start_line for the source snippet.')
    const offset = offsets[startLine - 1]
    if (offset === undefined) throw new Error('The source snippet start_line is outside the file.')
    from = offset
    until = (offsets[startLine] ?? source.length + 1) - 1
  }
  const start = source.indexOf(before, from)
  const duplicate = before ? source.indexOf(before, start + 1) : -1
  if (start < 0 || start > until || (duplicate !== -1 && duplicate <= until))
    throw new Error('Use a source snippet that occurs exactly once. Supply start_line to narrow the match.')
  return { before, after, start }
}

/** @param {string} text */
export function readSource(text) {
  const lines = []
  const offsets = [0]
  const breaks = /\r\n?|\n/gu
  let start = 0
  for (let next = breaks.exec(text); next; next = breaks.exec(text)) {
    lines.push(text.slice(start, next.index))
    start = breaks.lastIndex
    offsets.push(start)
  }
  lines.push(text.slice(start))
  return { text, lines, offsets, excerpts: /** @type {ReadSource['excerpts']} */ ([]) }
}

/** @param {ReadSource} source @param {{startLine: number, endLine: number, text: string}} output */
export function recordExcerpt(source, { startLine, endLine, text }) {
  const start = source.offsets[startLine - 1] ?? 0
  const last = source.offsets[endLine - 1] ?? start
  const end = last + text.length - (text.lastIndexOf('\n') + 1)
  source.excerpts.push({ start, end })
}

/** @param {ReadSource} source @param {{start: number, before: string}} patch */
function coversReplacement(source, patch) {
  return source.excerpts.some(({ start, end }) => start <= patch.start && patch.start + patch.before.length <= end)
}

/** @param {ReadSource} source @param {unknown} edits */
function replaceFile(source, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_FILE_REPLACEMENTS)
    throw new Error(`Supply 1 to ${MAX_FILE_REPLACEMENTS} replacements per file.`)
  const ending = newlineStyle(source.text)
  /** @type {unknown[]} */
  const requests = edits
  const patches = requests.map(edit => {
    if (!isRecord(edit)) throw new Error('Each replacement needs before and after text.')
    const patch = locateReplacement(
      source.text,
      edit.before,
      edit.after,
      edit.start_line,
      MAX_REPLACEMENT_CHARS,
      ending,
      source.offsets,
    )
    if (!coversReplacement(source, patch))
      throw new Error('Read the exact lines you want to replace before staging the edit.')
    return patch
  })
  patches.sort((left, right) => left.start - right.start)
  let offset = 0
  const text = []
  for (const { before, after, start } of patches) {
    if (start < offset || (!before && patches.length > 1))
      throw new Error('Source snippets in one call must not overlap.')
    text.push(source.text.slice(offset, start), after)
    offset = start + before.length
  }
  return text.join('') + source.text.slice(offset)
}

/** @param {FileChange} change @returns {ChangedFilePreview} */
function previewFile({ path, text, expected }) {
  if (expected === null) return { path, action: 'create', edits: [{ before: '', after: text, startLine: 1 }] }
  const lines = /[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/gu
  const diff = diffArrays(expected.match(lines) ?? [], text.match(lines) ?? [], { timeout: 40, maxEditLength: 4000 })
  /** @type {FileEditPreview[]} */
  const edits = []
  /** @type {FileEditPreview | undefined} */
  let hunk
  let startLine = 1
  for (const segment of diff ?? []) {
    if (!segment.added && !segment.removed) hunk = undefined
    else {
      if (!hunk) {
        hunk = { before: '', after: '', startLine }
        edits.push(hunk)
      }
      if (segment.removed) hunk.before += segment.value.join('')
      if (segment.added) hunk.after += segment.value.join('')
    }
    if (!segment.added) startLine += segment.count
  }
  // Keep full evidence for changes the line diff could not represent or finish.
  if (!edits.length) edits.push({ before: expected, after: text, startLine: 1 })
  return { path, action: 'edit', edits }
}

export class ClaudeFileEdits {
  /** @type {Map<string, StagedFile>} */
  #files = new Map()

  get size() {
    return this.#files.size
  }

  /** @param {string} path */
  text(path) {
    return this.#files.get(path)?.change.text
  }

  /**
   * @param {unknown} input
   * @param {Map<string, ReadSource>} reads
   * @param {(path: string) => Promise<void>} checkCreate
   * @param {AbortSignal} signal
   */
  async stage(input, reads, checkCreate, signal) {
    if (!Array.isArray(input) || !input.length || input.length > MAX_CLAUDE_EDIT_FILES)
      throw new Error(`Supply 1 to ${MAX_CLAUDE_EDIT_FILES} files to stage.`)
    const next = new Map(this.#files)
    /** @type {Set<string>} */
    const paths = new Set()
    /** @type {unknown[]} */
    const requests = input
    const creations = []
    for (const request of requests) {
      if (!isRecord(request) || !claudeVisiblePath(request.path))
        throw new Error('Supply an in-scope project text path for each change.')
      const { path, content, edits } = request
      if (paths.has(path)) throw new Error('Group all replacements for a file into one entry.')
      paths.add(path)
      const staged = next.get(path)?.change
      const read = reads.get(`working:${path}`)
      /** @type {FileChange} */
      let change
      if (content !== undefined) {
        if (edits !== undefined || (staged && staged.expected !== null) || (!staged && read))
          throw new Error('Use exact replacements to edit an existing file.')
        if (!validText(content, MAX_CREATION_CHARS))
          throw new Error(`New files can contain up to ${MAX_CREATION_CHARS} characters of text.`)
        if (!staged) creations.push(path)
        change = { path, text: content, expected: null }
      } else {
        if (!read) throw new Error('Read the working file before staging an edit.')
        change = { path, text: replaceFile(read, edits), expected: staged ? staged.expected : read.text }
      }
      if (Buffer.byteLength(change.text) > MAX_CLAUDE_FILE_BYTES) throw new Error('The edited text file is too large.')
      if (change.expected === change.text) next.delete(path)
      else next.set(path, { change, preview: previewFile(change) })
    }
    if (next.size > MAX_CLAUDE_EDIT_FILES)
      throw new Error(`The review can include up to ${MAX_CLAUDE_EDIT_FILES} files.`)
    const hunks = [...next.values()].flatMap(file => file.preview.edits)
    if (
      hunks.length > MAX_PREVIEW_EDITS ||
      hunks.reduce((size, hunk) => size + hunk.before.length + hunk.after.length, 0) > MAX_PREVIEW_CHARS
    )
      throw new Error('These changes are too large for one review. Stage a smaller set of changes.')
    await Promise.all(creations.map(path => checkCreate(path)))
    signal.throwIfAborted()
    this.#files = next
    for (const path of paths) reads.delete(`working:${path}`)
    return this.#files.size
  }

  /** @returns {FilesProposal | undefined} */
  proposal() {
    if (!this.#files.size) return undefined
    const files = [...this.#files.values()]
    return {
      kind: 'files',
      preview: { id: randomUUID(), kind: 'files', files: files.map(file => file.preview) },
      changes: files.map(file => file.change),
    }
  }
}
