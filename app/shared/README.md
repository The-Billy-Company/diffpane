---
doc_radar:
  sentinels:
    - file: app/shared/bridge/transport.ts
      contains: ['../recovery/app-errors.ts', 'DesktopTransport']
---

# Shared contracts

The desktop backend and renderer share these contracts and pure operations. The renderer uses their runtime validators at the IPC boundary, and Node tests exercise the same implementations as the app.

- [Appearance](appearance/README.md) defines the OKLCH palette and typography tokens.
- [Desktop bridge](bridge/README.md) defines the renderer's typed connection to the desktop host.
- [Diagnostics](diagnostics/README.md) defines safe events and operation timing.
- [Documents](documents/README.md) defines media types and bounded text operations.
- [Ideas](ideas/README.md) defines notebook records and edits.
- [Preferences](preferences/README.md) defines keyboard shortcut bindings.
- [Recovery](recovery/README.md) defines structured errors and result handling.
- [Review](review/README.md) defines note anchors, records, and handoff text.
