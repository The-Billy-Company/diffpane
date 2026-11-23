// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { describeLiveEdit } from '../../../renderer/editor/updates/live-edit-highlight.ts'
import { LivePathBatch } from '../../../renderer/editor/updates/live-updates.ts'

test('overlapping native events retain all invalidations with a fixed path bound', () => {
  const batch = new LivePathBatch()
  batch.add(['a', 'b'])
  batch.add(['b', 'c'])
  assert.deepEqual(batch.take(), ['a', 'b', 'c'])
  assert.deepEqual(batch.take(), [])
  batch.add(Array.from({ length: 100000 }, (_, index) => `path${index}`))
  batch.add(['later'])
  assert.deepEqual(batch.take(), ['*'])
  batch.add(['fresh'])
  assert.deepEqual(batch.take(), ['fresh'])
})

test('separate bursts across a throttled frame stay bounded and wildcard invalidation dominates', () => {
  const batch = new LivePathBatch()
  for (let burst = 0; burst < 1000; burst++) batch.add([`save${burst}`])
  assert.deepEqual(batch.take(), ['*'])
  batch.add(['first', '*', 'last'])
  batch.add(['later'])
  assert.deepEqual(batch.take(), ['*'])
  batch.add(['next-frame'])
  assert.deepEqual(batch.take(), ['next-frame'])
})

test('duplicate paths at the batch limit do not cause a full invalidation', () => {
  const batch = new LivePathBatch()
  const paths = Array.from({ length: 256 }, (_, index) => `path${index}`)
  batch.add(paths)
  batch.add(paths)
  assert.deepEqual(batch.take(), paths)
  batch.add([...paths, 'overflow'])
  assert.deepEqual(batch.take(), ['*'])
})

test('live edits count replacements in both directions and leave unchanged lines unmarked', () => {
  const before = 'first\r\nunchanged\r\nlast\r\n'
  const after = 'new first\r\nunchanged\r\nnew last\r\n'
  assert.deepEqual(describeLiveEdit(before, after, { start: 0, end: before.indexOf('last') }, 1), {
    ranges: [
      { startLine: 1, endLine: 1, deleted: false },
      { startLine: 3, endLine: 3, deleted: false },
    ],
    counts: { added: 2, removed: 2 },
  })
})

test('live edits measure line insertions and count removed lines at a deletion gap', () => {
  const before = 'a\nb\nc\nd\n'
  assert.deepEqual(describeLiveEdit(before, 'a\nadded\nb\nc\nd\n', { start: 2, end: 2 }, 2), {
    ranges: [{ startLine: 2, endLine: 2, deleted: false }],
    counts: { added: 1, removed: 0 },
  })
  assert.deepEqual(describeLiveEdit(before, 'a\nd\n', { start: 2, end: 6 }, 2), {
    ranges: [{ startLine: 2, endLine: 2, deleted: true }],
    counts: { added: 0, removed: 2 },
  })
})

test('live edits report unavailable counts when the edited span exceeds the diff budget', () => {
  const before = 'a'.repeat(256 * 1024)
  assert.deepEqual(describeLiveEdit(before, 'b', { start: 0, end: before.length }, 1), {
    ranges: [],
    counts: null,
  })
})
