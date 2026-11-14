import { diffLines } from 'diff'
import type { editor } from 'monaco-editor/editor/editor.api.js'
import './live-edit-highlight.css'

const HIGHLIGHT_MS = 1600
const MAX_DIFF_CHARS = 256 * 1024
const MAX_DIFF_EDITS = 160

interface HighlightRange {
  startLine: number
  endLine: number
  deleted: boolean
}

export function liveEditRanges(
  before: string,
  after: string,
  { start, end }: { start: number; end: number },
  firstLine: number,
) {
  // Compare only the edited span, extended to whole lines on both sides.
  const from = start === 0 ? 0 : before.lastIndexOf('\n', start - 1) + 1
  const newline = before.indexOf('\n', end)
  const oldEnd = newline === -1 ? before.length : newline + 1
  const newEnd = oldEnd + after.length - before.length
  if (oldEnd - from + newEnd - from > MAX_DIFF_CHARS) return []
  const changes = diffLines(
    before.slice(from, oldEnd).replace(/\r\n?/g, '\n'),
    after.slice(from, newEnd).replace(/\r\n?/g, '\n'),
    { maxEditLength: MAX_DIFF_EDITS, timeout: 8 },
  )
  if (!changes) return []

  const ranges: HighlightRange[] = []
  let line = firstLine
  for (const [index, change] of changes.entries()) {
    if (change.removed) {
      // A replacement is highlighted on its new lines. A pure removal marks the gap.
      if (!changes[index + 1]?.added) ranges.push({ startLine: line, endLine: line, deleted: true })
      continue
    }
    if (change.added) ranges.push({ startLine: line, endLine: line + change.count - 1, deleted: false })
    line += change.count
  }
  return ranges
}

export function createLiveEditHighlight(codeEditor: editor.ICodeEditor) {
  const decorations = codeEditor.createDecorationsCollection()
  let timer = 0
  let repeat = false

  function clear() {
    window.clearTimeout(timer)
    decorations.clear()
  }

  return {
    clear,
    show(ranges: HighlightRange[], lineCount: number) {
      if (!ranges.length) {
        clear()
        return
      }
      window.clearTimeout(timer)
      // Changing the rendered class restarts the animation on consecutive edits to the same line.
      repeat = !repeat
      decorations.set(
        ranges.map(({ startLine, endLine, deleted }) => {
          const suffix = `${deleted ? ' live-edit-deletion' : ''}${repeat ? ' live-edit-repeat' : ''}`
          return {
            range: {
              startLineNumber: Math.min(startLine, lineCount),
              endLineNumber: Math.min(endLine, lineCount),
              startColumn: 1,
              endColumn: 1,
            },
            options: {
              className: `live-edit-line${suffix}`,
              marginClassName: `live-edit-gutter${suffix}`,
              isWholeLine: true,
              zIndex: 10,
            },
          }
        }),
      )
      timer = window.setTimeout(clear, HIGHLIGHT_MS)
    },
    dispose: clear,
  }
}
