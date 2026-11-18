---
doc_radar:
  sentinels:
    - file: app/backend/runtime/window/main.mjs
      contains: ['routeRenderer', 'before-quit', 'finishFlush']
    - file: app/desktop/host/desktop.ts
      contains: ['window.close-requested', 'routeRenderer']
---

# Window sessions

[`main.mjs`](main.mjs) owns the workspace session, worker lifecycle, renderer requests, and pending-save coordination. [`workspace-windows.ts`](workspace-windows.ts) manages saved workspace targets and navigation between windows. The Tauri host owns native window creation, menus, dialogs, and quit requests.

Use `pnpm run dev .` from the repository root to open this working tree in Diffpane. Run `pnpm test app/tests/runtime/session` for the repository worker and workspace navigation contracts.
