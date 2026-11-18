---
doc_radar:
  sentinels:
    - file: app/renderer/panels/appearance/appearance.ts
      contains: ['createAppearanceSettings']
---

# Appearance and workspace preferences

The settings panel mounts these appearance controls. The preference controller shares current values with the shell layout, editor, and theme, and persists edits through the desktop bridge.

- [`appearance.ts`](appearance.ts) — Renders appearance controls and derives code and diff options.
- [`ui-preferences.ts`](ui-preferences.ts) — Merges preference updates and coordinates persistence and theme changes.
- [`appearance.css`](appearance.css) — Styles appearance controls and preference groups.

Monaspace Argon, Krypton, Neon, Radon, and Xenon use the variable WOFF2 files from the Monaspace v1.301 release. DiffPane enables contextual alternates for texture healing in these fonts. [Monaspace v1.301](https://github.com/githubnext/monaspace/releases/tag/v1.301), [SIL Open Font License](../../../../legal/NOTICE)

Run `pnpm test app/tests/runtime/persistence/ui-preferences.test.ts` for the preference contract. Open Settings with `pnpm run dev .` to check the controls.
