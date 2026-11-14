import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { liveEditRanges } from '../../../renderer/editor/updates/live-edit-highlight.ts'
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

test('live highlights leave unchanged lines between edits unmarked', () => {
  const before = 'first\r\nunchanged\r\nlast\r\n'
  const after = 'new first\r\nunchanged\r\nnew last\r\n'
  assert.deepEqual(liveEditRanges(before, after, { start: 0, end: before.indexOf('last') }, 1), [
    { startLine: 1, endLine: 1, deleted: false },
    { startLine: 3, endLine: 3, deleted: false },
  ])
})

test('live highlights distinguish line insertions from deletion gaps', () => {
  const before = 'a\nb\nc\n'
  assert.deepEqual(liveEditRanges(before, 'a\nadded\nb\nc\n', { start: 2, end: 2 }, 2), [
    { startLine: 2, endLine: 2, deleted: false },
  ])
  assert.deepEqual(liveEditRanges(before, 'a\nc\n', { start: 2, end: 4 }, 2), [
    { startLine: 2, endLine: 2, deleted: true },
  ])
})
