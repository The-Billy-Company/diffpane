import { CancellationError } from 'monaco-editor/base/common/errors.js'
import { afterEach, expect, test, vi } from 'vite-plus/test'
import { installErrorHandlers } from '../../../renderer/shell/recovery/errors.ts'
import type { DiagnosticEvent } from '../../../shared/diagnostics/diagnostics.ts'

class TestErrorEvent extends Event {
  readonly error: Error

  constructor(error: Error) {
    super('error', { cancelable: true })
    this.error = error
  }
}

afterEach(() => vi.unstubAllGlobals())

test.each([
  {
    operation: 'renderer.uncaught-error',
    createEvent: (error: Error) => new TestErrorEvent(error),
  },
  {
    operation: 'renderer.unhandled-rejection',
    createEvent: (reason: Error) => Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason }),
  },
])('$operation ignores editor cancellations while reporting other errors', ({ operation, createEvent }) => {
  const reportDiagnostic = vi.fn<(event: DiagnosticEvent) => void>()
  const target = Object.assign(new EventTarget(), { diffpane: { reportDiagnostic } })
  vi.stubGlobal('window', target)
  vi.stubGlobal('ErrorEvent', TestErrorEvent)
  installErrorHandlers()

  const canceled = createEvent(new CancellationError())
  target.dispatchEvent(canceled)
  expect(reportDiagnostic).not.toHaveBeenCalled()
  expect(canceled.defaultPrevented).toBe(true)

  target.dispatchEvent(createEvent(new Error('Canceled')))
  expect(reportDiagnostic).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ operation, failure: { code: 'UNEXPECTED', recoverable: true } }),
  )
})
