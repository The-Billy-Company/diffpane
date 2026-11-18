import type { TerminalBridge, TerminalStartResult } from '../terminal/protocol.ts'
import type { DesktopTransport } from './transport.ts'

export function createTerminalBridge(transport: DesktopTransport): TerminalBridge {
  return {
    isMac: transport.platform === 'darwin',
    async start(cols, rows) {
      const value: unknown = await transport.invoke('terminal-start', cols, rows)
      if (typeof value === 'object' && value !== null && 'ok' in value) {
        if (value.ok === true && 'isPowerShell' in value && typeof value.isPowerShell === 'boolean')
          return { ok: true, isPowerShell: value.isPowerShell }
        if (value.ok === false && 'message' in value && typeof value.message === 'string')
          return { ok: false, message: value.message }
      }
      return { ok: false, message: 'The terminal did not respond.' } satisfies TerminalStartResult
    },
    write: data => transport.send('terminal-input', data),
    resize: (cols, rows) => transport.send('terminal-resize', cols, rows),
    acknowledge: bytes => transport.send('terminal-ack', bytes),
    async stop() {
      await transport.invoke('terminal-stop')
    },
    hide: () => transport.send('terminal-hide'),
    onData(listener) {
      const receive = (data: unknown, bytes: unknown) => {
        if (typeof data === 'string' && typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0)
          listener(data, bytes)
      }
      return transport.listen('terminal-data', receive)
    },
    onExit(listener) {
      const receive = (code: unknown, reason: unknown) => {
        if (code === null || (typeof code === 'number' && Number.isSafeInteger(code)))
          listener(code, typeof reason === 'string' ? reason : undefined)
      }
      return transport.listen('terminal-exit', receive)
    },
    onCommandStarted(listener) {
      const receive = (label: unknown) => {
        if (typeof label === 'string' && label.length <= 120) listener(label)
      }
      return transport.listen('terminal-command-started', receive)
    },
    onTheme(listener) {
      const receive = (theme: unknown) => {
        if (theme === 'light' || theme === 'dark') listener(theme)
      }
      return transport.listen('terminal-theme', receive)
    },
    onNewLineShortcut(listener) {
      const receive = (binding: unknown) => {
        if (typeof binding === 'string') listener(binding)
      }
      return transport.listen('terminal-new-line-shortcut', receive)
    },
  }
}
