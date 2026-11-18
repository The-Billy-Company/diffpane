---
doc_radar:
  sentinels:
    - file: app/renderer/shell/desktop/tauri-transport.ts
      contains: ['new Channel(', 'desktop_connect', 'undefinedArgs']
    - file: app/renderer/shell/desktop/terminal-bridge.ts
      contains: ['terminal-ready', 'createTerminalBridge']
---

# Desktop integration

The renderer builds the workspace and terminal bridges on Tauri IPC. Each webview registers a dedicated channel before sending commands. Writes use an ordered queue, and positional arguments preserve the difference between explicit `null` and omitted values.

The workspace initializes a Popover API fallback on WebKit versions that need it. Native drag regions use Tauri's built-in title-bar behavior.
