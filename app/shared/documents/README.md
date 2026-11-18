---
doc_radar:
  sentinels:
    - file: app/shared/documents/text-lines.ts
      contains: ['export function']
---

# Document primitives

`media-types.ts` defines the supported preview media. `text-lines.ts` implements bounded line and preview operations used by the workspace reader and renderer editor. `utf16.ts` checks paths and repairs clipped preview text on WebKit versions that lack the string well-formedness methods.

Run `pnpm test app/tests/runtime/documents` from the repository root.
