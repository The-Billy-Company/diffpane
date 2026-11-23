---
doc_radar:
  sentinels:
    - file: app/backend/workspace/repository/repository.mjs
      contains: ['class Repository', '--porcelain=v2', 'MAX_CHECKPOINT_PATHS']
    - file: app/backend/workspace/repository/git-workspace.mjs
      contains: ['gitWorkspaceOverview', 'gitWorkspaceChanges']
    - file: app/backend/workspace/repository/content-search.mjs
      contains: ['searchRepositoryContent', 'MAX_MATCHES']
    - file: app/backend/workspace/repository/file-operations.ts
      contains: ['operationPath', 'renameEntry']
---

# Repository and file operations

- [`repository.mjs`](repository.mjs) reads Git state and confined file contents, captures checkpoints, and saves working files with disk conflict checks.
- [`git-workspace.mjs`](git-workspace.mjs) reads repository-wide commit history and file statistics for the Git workspace. Repositories supply file contents for the selected endpoints.
- [`content-search.mjs`](content-search.mjs) scans eligible working files and returns bounded, cancellable results.
- [`file-operations.ts`](file-operations.ts) validates file operation targets and coordinates renames.

Folders outside Git use a filesystem inventory and working-file contents without invoking Git. Their session snapshots set `isGitRepository` to false, and Git comparison and checkpoint requests are unavailable. Git workspaces retain their existing scoped inventory and comparison behavior.

Creature file proposals validate every working-file baseline and creation target before writing. The repository restores earlier writes after a failed group when their on-disk contents still match what the Creature wrote.

The [workspace session](../../runtime/session/README.md) uses these operations to update its inventory and document snapshots. Run `pnpm test app/tests/runtime/repository app/tests/interface/search/content-search.test.mjs` from the repository root.
