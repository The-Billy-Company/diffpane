---
doc_radar:
  sentinels:
    - file: app/backend/persistence/preferences/recent-targets.ts
      contains: ['const LIMIT = 8', 'class RecentTargets']
    - file: app/backend/persistence/preferences/shortcut-preferences.ts
      contains: ['class ShortcutPreferences']
    - file: app/backend/persistence/preferences/ui-preferences.ts
      contains: ['parseUiPreferencePatch', 'defaultUiPreferences']
---

# Application preferences

- [`recent-targets.ts`](recent-targets.ts) records successful file and folder targets for the welcome screen.
- [`shortcut-preferences.ts`](shortcut-preferences.ts) manages validated keyboard bindings in local state.
- [`ui-preferences.ts`](ui-preferences.ts) defines defaults, bounds, and patch validation for appearance, pane layout, and Ideas docking.

The [main process](../../runtime/window/README.md) connects these settings to the [local database](../database/README.md). Run `pnpm test app/tests/runtime/persistence` from the repository root.
