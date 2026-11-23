---
doc_radar:
  sentinels:
    - file: app/tests/runtime/repository/repository.test.mjs
      contains: ['partial staging preserves all three comparisons']
---

# Repository tests

These suites use real Git repositories, ordinary folders, and filesystem operations to exercise worktree safety and comparison behavior.

- [Repository](repository.test.mjs). Exercise inventory, ignores, staging, worktrees, conflict modes and unusual paths, plus opening and editing folders without Git or its executable.
- [File operations](file-operations.test.ts). Check renames, symlink boundaries and simultaneous destination collisions.
- [Save](save.test.mjs). Check encoding and permissions, stale writes, path confinement and retry.

Run `pnpm test app/tests/runtime/repository` from the repository root.
