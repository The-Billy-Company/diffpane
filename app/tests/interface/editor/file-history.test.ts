// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { FileHistory } from '../../../renderer/shell/workspace/file-history.ts'

test('file navigation retains forward history until a different file is opened', () => {
  const history = new FileHistory()
  for (const path of ['one', 'two', 'three']) history.record(path)

  assert.deepEqual(history.navigate(-1, 'three'), { path: 'two', index: 1 })
  history.record('two', 1)
  assert.equal(history.previous('two'), 'three')
  assert.deepEqual(history.navigate(1, 'two'), { path: 'three', index: 2 })
  history.record('two')
  assert.deepEqual(history.navigate(1, 'two'), { path: 'three', index: 2 })

  history.record('four')
  assert.equal(history.navigate(1, 'four'), undefined)
  assert.deepEqual(history.navigate(-1, undefined), { path: 'four', index: 2 })
})

test('closing other editors keeps navigation and renamed paths usable', () => {
  const history = new FileHistory()
  for (const path of ['sub/a', 'sub/b', 'current']) history.record(path)
  history.closeOthers('current')
  assert.equal(history.previous('current'), undefined)

  history.move('sub', 'moved')
  assert.deepEqual(history.navigate(-1, 'current'), { path: 'moved/b', index: 1 })
  history.move('moved/b')
  assert.deepEqual(history.navigate(-1, 'current'), { path: 'moved/a', index: 0 })
})
