import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, test, vi } from 'vite-plus/test'
import { openPickerOptions, pickNativePaths } from '../../../backend/runtime/window/open-picker.ts'
import { dialog } from '../../../desktop/services/shell.ts'

const { hostRequest } = vi.hoisted(() => ({
  hostRequest: vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>(),
}))
vi.mock('../../../desktop/host/desktop.ts', () => ({ hostRequest, reportHostError: () => {} }))
beforeEach(() => {
  hostRequest.mockReset()
})

const selected = path.join(tmpdir(), 'a file\nwith a line break.txt')
const signal = () => new AbortController().signal

function window() {
  let closed = false
  return {
    label: 'workspace-3',
    isDestroyed: () => closed,
    close() {
      closed = true
    },
  }
}

test('requests a parented multi-folder panel and preserves directory order', async () => {
  const owner = window()
  const folders = [path.join(tmpdir(), 'second'), path.join(tmpdir(), 'first')]
  hostRequest.mockResolvedValue({ canceled: false, filePaths: folders })
  assert.deepEqual(await pickNativePaths(owner, 'folders', signal()), folders)
  assert.deepEqual(hostRequest.mock.calls, [
    [
      'dialog.open',
      owner.label,
      {
        properties: ['openDirectory', 'multiSelections'],
        title: 'Choose workspace folders',
        buttonLabel: 'Add Folders',
      },
    ],
  ])
})

test('supports an unparented single-file panel and preserves a path containing a newline', async () => {
  hostRequest.mockResolvedValue({ canceled: false, filePaths: [selected] })
  assert.deepEqual(await pickNativePaths(null, 'file', signal()), [selected])
  assert.deepEqual(hostRequest.mock.calls, [['dialog.open', null, openPickerOptions('file')]])
  assert.deepEqual(openPickerOptions('file').properties, ['openFile'])
})

test('a dismissed directory panel returns no selection', async () => {
  const owner = window()
  hostRequest.mockResolvedValue({ canceled: true, filePaths: [] })
  assert.deepEqual(await pickNativePaths(owner, 'folder', signal()), [])
  assert.deepEqual(hostRequest.mock.calls, [['dialog.open', owner.label, openPickerOptions('folder')]])
  assert.deepEqual(openPickerOptions('folder').properties, ['openDirectory'])
})

test('surfaces native panel errors with the existing recoverable picker code', async () => {
  hostRequest.mockRejectedValue(new Error('The native dialog failed to open.'))
  await assert.rejects(pickNativePaths(window(), 'folder', signal()), {
    code: 'PICKER_UNAVAILABLE',
    operation: 'open-folder',
    recoverable: true,
  })
})

test.each([
  { canceled: false, filePaths: ['relative.txt'] },
  { canceled: false, filePaths: [`${selected}\0`] },
  { canceled: false, filePaths: [42] },
  { filePaths: [selected] },
])('rejects a malformed or nonabsolute native picker response', async malformed => {
  hostRequest.mockResolvedValueOnce(malformed)
  await assert.rejects(pickNativePaths(window(), 'file', signal()), {
    code: 'PICKER_UNAVAILABLE',
    operation: 'open-file',
  })
})

test('rejects a relative destination from the native save panel', async () => {
  hostRequest.mockResolvedValueOnce({ canceled: false, filePath: 'relative.txt' })
  await assert.rejects(dialog.showSaveDialog(window(), { title: 'Save', defaultPath: selected }), /Invalid save dialog/)
})

test('abort returns promptly and ignores a selection that arrives afterward', async () => {
  const controller = new AbortController()
  const response = Promise.withResolvers<unknown>()
  hostRequest.mockReturnValueOnce(response.promise)
  const pending = pickNativePaths(window(), 'folder', controller.signal)
  controller.abort()
  assert.deepEqual(await pending, [])
  response.resolve({ canceled: false, filePaths: [selected] })
  assert.equal(hostRequest.mock.calls.length, 1)
})

test('ignores a stale result when the original window has closed', async () => {
  const owner = window()
  const response = Promise.withResolvers<unknown>()
  hostRequest.mockReturnValueOnce(response.promise)
  const pending = pickNativePaths(owner, 'file', signal())
  owner.close()
  response.resolve({ canceled: false, filePaths: [selected] })
  assert.deepEqual(await pending, [])
})

test('does not present a panel if the owner is gone or the request was aborted', async () => {
  const owner = window()
  assert.deepEqual(await pickNativePaths(owner, 'folder', AbortSignal.abort()), [])
  owner.close()
  assert.deepEqual(await pickNativePaths(owner, 'file', signal()), [])
  assert.equal(hostRequest.mock.calls.length, 0)
})
