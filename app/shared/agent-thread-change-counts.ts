// Copyright (c) 2026 The Billy Company
import { diffArrays, parsePatch } from 'diff'
import type { StructuredPatchHunk } from 'diff'
import type { AgentThreadChange } from './agent-threads.ts'

const MAX_PATCH_CHARS = 256 * 1024
const MAX_LINES = 16 * 1024

type Counts = Pick<AgentThreadChange, 'additions' | 'deletions'>
interface Line {
  text?: string
}

function applyHunk(lines: Line[], hunk: StructuredPatchHunk): boolean {
  const start = hunk.oldStart - 1
  let index = start
  const replacement: Line[] = []
  for (const [rowIndex, row] of hunk.lines.entries()) {
    if (row.startsWith('\\')) continue
    const newline = hunk.lines[rowIndex + 1]?.startsWith('\\') ? '' : '\n'
    const text = row.slice(1) + newline
    if (row.startsWith('+')) {
      replacement.push({ text })
      continue
    }
    const line = lines[index++]
    if (!line || (line.text !== undefined && line.text !== text)) return false
    line.text = text
    if (!row.startsWith('-')) replacement.push(line)
  }
  lines.splice(start, hunk.oldLines, ...replacement)
  return true
}

function composedCounts(changes: readonly AgentThreadChange[]): Counts | undefined {
  let characters = 0
  let originalLength = 0
  let totalDelta = 0
  let maxDelta = 0
  const patches: StructuredPatchHunk[][] = []
  try {
    for (const change of changes) {
      if (change.operation !== 'update' || !change.diff) return undefined
      characters += change.diff.length
      if (characters > MAX_PATCH_CHARS) return undefined
      const parsed = parsePatch(change.diff)
      const hunks = parsed[0]?.hunks
      if (parsed.length !== 1 || !hunks?.length) return undefined
      let previousEnd = 0
      let patchDelta = 0
      for (const hunk of hunks) {
        const start = hunk.oldStart - 1
        if (start < previousEnd || hunk.newStart - hunk.oldStart !== patchDelta) return undefined
        const end = start + hunk.oldLines
        originalLength = Math.max(originalLength, end - totalDelta)
        previousEnd = end
        patchDelta += hunk.newLines - hunk.oldLines
      }
      totalDelta += patchDelta
      maxDelta = Math.max(maxDelta, totalDelta)
      if (originalLength + maxDelta > MAX_LINES) return undefined
      patches.push(hunks)
    }
  } catch {
    return undefined
  }

  // Each unknown original line has its own identity. A later hunk can supply its text.
  const original = Array.from({ length: originalLength }, (): Line => ({}))
  const final = original.slice()
  for (const hunks of patches) {
    // All hunks in one patch refer to the same original line numbers.
    for (const hunk of hunks.toReversed()) {
      if (!applyHunk(final, hunk)) return undefined
    }
  }
  const diff = diffArrays(original, final, {
    comparator: (before, after) => before === after || (before.text !== undefined && before.text === after.text),
    timeout: 12,
  })
  if (!diff) return undefined
  return {
    additions: diff.reduce((sum, change) => sum + (change.added ? change.count : 0), 0),
    deletions: diff.reduce((sum, change) => sum + (change.removed ? change.count : 0), 0),
  }
}

export function agentThreadChangeCounts(changes: readonly AgentThreadChange[]): Counts {
  const composed = changes.length > 1 && composedCounts(changes)
  if (composed) return composed
  let additions: number | undefined = 0
  let deletions: number | undefined = 0
  for (const change of changes) {
    additions = additions !== undefined && change.additions !== undefined ? additions + change.additions : undefined
    deletions = deletions !== undefined && change.deletions !== undefined ? deletions + change.deletions : undefined
  }
  return { additions, deletions }
}
