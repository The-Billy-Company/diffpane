import { invoke, isTauri } from '@tauri-apps/api/core'
import { createWorkspaceBridge } from '../../../shared/bridge/workspace-bridge.ts'
import { createTauriTransport } from './tauri-transport.ts'

export function connectWorkspace() {
  if (isTauri() && !window.diffpane) window.diffpane = createWorkspaceBridge(createTauriTransport())
}

export function syncNativeShortcutPrefix(pending: boolean) {
  if (isTauri()) void invoke('desktop_shortcut_prefix', { pending }).catch(() => undefined)
}
