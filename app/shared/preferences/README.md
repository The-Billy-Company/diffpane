---
doc_radar:
  sentinels:
    - file: app/shared/preferences/shortcuts.ts
      contains: ['nativeAccelerator']
---

# Shortcut contracts

`shortcuts.ts` defines shortcut actions, defaults, parsing, and native accelerator formatting. The desktop host uses the effective bindings for menus, and the renderer uses the same bindings for workspace shortcuts.

Run `pnpm test app/tests/runtime/persistence/shortcut-preferences.test.ts` from the repository root.
