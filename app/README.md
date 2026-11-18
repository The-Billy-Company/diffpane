---
doc_radar:
  sentinels:
    - file: app/tsconfig.json
      contains: ['"checkJs": true']
---

# Application

The application tree contains the code that ships and the tooling and tests that build it. `index.html` is the renderer's HTML entry point. `tsconfig.json` sets the shared TypeScript and checked JavaScript rules.

- [Workspace service](backend/README.md) owns repository sessions and persistent state. The [Tauri host](../src-tauri/README.md) owns native windows and desktop integration.
- [Renderer](renderer/README.md) owns the workspace interface and editor.
- [Shared contracts](shared/README.md) owns the types and small operations used on both sides of IPC.
- [Tooling](tooling/README.md) owns development, builds, packaging, and dependency pins.
- [Tests](tests/README.md) indexes the automated checks by concern.

Run `pnpm run dev .` from the repository root to open this working tree, or `pnpm run verify` to run the full verification suite.
