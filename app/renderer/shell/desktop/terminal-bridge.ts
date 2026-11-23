// Copyright (c) 2026 The Billy Company
import { isTauri } from '@tauri-apps/api/core'
import { createTerminalBridge } from '../../../shared/bridge/terminal-bridge.ts'
import { createTauriTransport } from './tauri-transport.ts'

export function connectTerminal() {
  if (!isTauri() || window.diffpaneTerminal) return undefined
  const transport = createTauriTransport()
  return {
    bridge: createTerminalBridge(transport),
    ready: () => transport.invoke('terminal-ready'),
  }
}
