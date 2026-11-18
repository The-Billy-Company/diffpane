---
doc_radar:
  sentinels:
    - file: app/renderer/types/shims.d.ts
      contains: ['virtual:syntax-catalog']
---

# Renderer types

These declarations make the desktop bridge and generated or untyped renderer imports available to TypeScript.

- [`shims.d.ts`](shims.d.ts) — Declares the desktop bridge on Window, the Vite grammar catalog, and the Monaco JSON tokenizer.

Run `pnpm run check` to type-check callers against these declarations.
