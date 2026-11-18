---
doc_radar:
  sentinels:
    - file: app/shared/recovery/app-errors.ts
      contains: ['attemptAsync']
---

# Error contracts

`app-errors.ts` classifies failures and provides result wrappers and serialization for the workspace service and renderer recovery paths.

Run `pnpm test app/tests/tooling/quality/app-errors.test.ts` from the repository root.
