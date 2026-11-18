---
doc_radar:
  sentinels:
    - file: app/backend/persistence/database/local-state.ts
      contains: ['aes-256-gcm', 'PRAGMA journal_mode = WAL', 'class LocalState']
    - file: app/backend/persistence/database/secure-storage.mjs
      contains: ['wrapSecret', 'localStateKeys']
---

# Local database

- [`local-state.ts`](local-state.ts) opens the SQLite database and owns encrypted record transactions and legacy migrations.
- [`secure-storage.mjs`](secure-storage.mjs) wraps the database keys using macOS Keychain and can read legacy Safe Storage values.

[Preferences](../preferences/README.md) and [project records](../project/README.md) use the database. Run `pnpm test app/tests/runtime/persistence/local-state.test.ts` from the repository root.
