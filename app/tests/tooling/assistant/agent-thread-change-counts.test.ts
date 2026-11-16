import { expect, test } from 'vite-plus/test'
import { agentThreadChangeCounts } from '../../../shared/agent-thread-change-counts.ts'
import type { AgentThreadChange } from '../../../shared/agent-threads.ts'

function change(diff: string, additions: number, deletions: number): AgentThreadChange {
  return { path: 'file.md', operation: 'update', diff, additions, deletions }
}

test('counts overlapping edits against the original lines recorded in the patches', () => {
  const first = change('@@ -1,2 +1,3 @@\n heading\n+first draft\n-before\n+updated\n', 2, 1)
  const second = change('@@ -2,2 +2,2 @@\n-first draft\n+final draft\n-updated\n+before\n', 2, 2)

  expect(agentThreadChangeCounts([first, second])).toEqual({ additions: 1, deletions: 0 })
})

test('retains recorded counts when some intermediate file changes are missing', () => {
  const first = change('@@ -1 +1 @@\n-before\n+updated\n', 1, 1)
  const second = change('@@ -1 +1 @@\n-unrecorded edit\n+later\n', 1, 1)

  expect(agentThreadChangeCounts([first, second])).toEqual({ additions: 2, deletions: 2 })
  expect(agentThreadChangeCounts([first, { ...second, deletions: undefined }])).toEqual({
    additions: 2,
    deletions: undefined,
  })
})
