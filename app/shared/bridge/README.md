---
doc_radar:
  sentinels:
    - file: app/shared/bridge/transport.ts
      contains: ['DesktopTransport', 'INVALID_IPC_RESPONSE']
    - file: app/shared/bridge/workspace-bridge.ts
      contains: ['createWorkspaceBridge', 'DiffpaneApi']
---

# Desktop bridge

The workspace and terminal factories expose the renderer's typed request and event APIs. They validate native replies and events before delivering them to the interface. Workspace response validators live next to the transport and are grouped by feature.
