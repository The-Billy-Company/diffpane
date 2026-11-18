import type { ErrorDetails } from '../recovery/app-errors.ts'
import type { Validator } from './validators/values.ts'
import { isErrorDetails, isRecord, isTimestamp } from './validators/values.ts'

type Unsubscribe = () => void

export interface DesktopTransport {
  platform: NodeJS.Platform
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  listen(channel: string, callback: (...args: unknown[]) => void): Unsubscribe
}

export function validatedTransport(transport: DesktopTransport) {
  function bridgeFailure(
    operation: string,
    startedAt: number,
    code: 'IPC_UNAVAILABLE' | 'INVALID_IPC_RESPONSE',
  ): ErrorDetails {
    try {
      transport.send('preload-diagnostic', operation, Math.round((performance.now() - startedAt) * 100) / 100, code)
    } catch {
      // Diagnostics must not replace the failure the renderer needs to handle.
    }
    return {
      message:
        code === 'IPC_UNAVAILABLE'
          ? 'The window could not reach Diffpane. Try again.'
          : 'Diffpane sent an invalid reply. Try again.',
      code,
      operation,
      recoverable: true,
    }
  }

  async function invoke<T>(channel: string, validate: Validator<T>, ...args: unknown[]): Promise<T> {
    const startedAt = performance.now()
    let result: unknown
    try {
      result = await transport.invoke(channel, ...args)
    } catch {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The bridge preserves structured error details.
      return Promise.reject(bridgeFailure(channel, startedAt, 'IPC_UNAVAILABLE'))
    }
    if (isRecord(result)) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The bridge preserves structured error details.
      if (result.ok === false && isErrorDetails(result.error)) return Promise.reject(result.error)
      // JSON omits the value property when a successful command returns void.
      if (result.ok === true && validate(result.value)) return result.value
    }
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- The bridge preserves structured error details.
    return Promise.reject(bridgeFailure(channel, startedAt, 'INVALID_IPC_RESPONSE'))
  }

  function listen<T>(channel: string, validate: Validator<T>, callback: (value: T) => void): Unsubscribe {
    return transport.listen(channel, (value: unknown) => {
      if (validate(value)) callback(value)
    })
  }

  function reportDiagnostic(input: unknown): void {
    if (
      !isRecord(input) ||
      input.source !== 'renderer' ||
      typeof input.operation !== 'string' ||
      input.operation.length > 96
    )
      return
    const { source, operation, level, kind } = input
    if (level !== 'info' && level !== 'warn' && level !== 'error') return
    const base = { source, operation, level }
    if (kind === 'metric') {
      const { value, unit } = input
      if (isTimestamp(value) && (unit === 'ms' || unit === 'count' || unit === 'bytes' || unit === 'percent'))
        transport.send('renderer-diagnostic', { ...base, kind, value, unit })
      return
    }
    let failure
    if (input.failure !== undefined) {
      if (!isRecord(input.failure)) return
      const { code, recoverable } = input.failure
      if (typeof code !== 'string' || code.length > 64 || typeof recoverable !== 'boolean') return
      failure = { code, recoverable }
    }
    if (kind === 'event') transport.send('renderer-diagnostic', { ...base, kind, failure })
    if (kind === 'duration') {
      const { durationMs, outcome } = input
      if (isTimestamp(durationMs) && (outcome === 'success' || outcome === 'failure' || outcome === 'canceled'))
        transport.send('renderer-diagnostic', { ...base, kind, durationMs, outcome, failure })
    }
  }

  return { invoke, listen, reportDiagnostic }
}
