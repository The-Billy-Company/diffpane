---
doc_radar:
  sentinels:
    - file: app/tooling/commands/dev.ts
      contains: ['createServer', 'tauri']
    - file: app/tooling/commands/start.ts
      contains: ['custom-protocol']
---

# Desktop commands

`dev.ts` starts Vite and the Tauri development host. `start.ts` runs the host against an existing production renderer build. `prepare-terminal.ts` makes the macOS PTY helper executable after dependency installation. `Makefile` delegates setup, build, tests, and installation to pnpm.

Run `pnpm run dev .` to open the current repository or `make verify` to check the source. Run these commands from the repository root.
