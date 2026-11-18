---
doc_radar:
  sentinels:
    - file: app/backend/runtime/window/main.mjs
      contains: ['new Worker', 'before-quit']
    - file: app/backend/runtime/session/session.mjs
      contains: ['watcher.subscribe', 'port.close()']
---

# Desktop runtime

- [Diagnostics](diagnostics/README.md) owns the local log and desktop performance sampling.

- [Window](window/README.md) coordinates native windows, renderer IPC, and shutdown. The Rust host owns OS dialogs and menus.
- [Session](session/README.md) owns a workspace worker's lifetime, watches, inventory snapshots, and request dispatch.
- [Terminal](terminal/README.md) owns the terminal view, shell authorization, and PTY lifetime.
