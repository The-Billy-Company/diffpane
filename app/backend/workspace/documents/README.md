---
doc_radar:
  sentinels:
    - file: app/backend/workspace/documents/file-content.ts
      contains: ['MAX_MEDIA_BYTES', 'searchableText', 'encodeText']
    - file: app/backend/workspace/documents/document-cache.ts
      contains: ['class DocumentCache']
    - file: src-tauri/src/media/mod.rs
      contains: ['MediaServer', 'CONTENT_RANGE']
---

# Documents and media

- [`file-content.ts`](file-content.ts) recognizes file types, decodes text, and constructs bounded document previews. It also preserves source encoding for saves.
- [`document-cache.ts`](document-cache.ts) coalesces document reads and bounds retained preview payloads.
- The [Tauri media server](../../../../src-tauri/src/media/mod.rs) streams authorized workspace media from open file descriptors and supports byte ranges for seeking.

The [repository](../repository/README.md) uses the content reader. The [session](../../runtime/session/README.md) owns the cache. Run `pnpm test app/tests/runtime/documents` from the repository root.
