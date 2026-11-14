---
doc_radar:
  sentinels:
    - file: app/tests/tooling/billy-siblings/siblings.test.ts
      contains: ['readBillySiblings', 'mockResolvedValue']
---

# Sibling function tests

These tests exercise Relate's function locations, bounded scope, excerpts, and response handling. Run `pnpm test app/tests/tooling/billy-siblings` from the repository root.
