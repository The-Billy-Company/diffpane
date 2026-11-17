---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/tree/navigator.js
      contains: ['flattenNavigationTree']
---

# Explorer tree

The workspace turns Electron inventory and status updates into a virtualized tree. Opening, renaming, or trashing an entry goes through callbacks owned by the workspace.

The Explorer colors edits blue, moves purple, and moves with edits rose. A folder takes on a move color when all of its changed files share that status. Deleted filenames are struck through, and merge conflicts use the warning color. Hover over an entry to see its Git status or the number of changed files in the folder.

In a scrolling tree, the change map beside the rows shows where Git changes are. A dotted mark represents changes inside a collapsed folder. Hover to see the filename or folder at that position, then click or drag to scroll. You can also focus the map and use the arrow keys, Page Up, Page Down, Home, or End.

- [`navigator.js`](navigator.js) — Projects the inventory into visible rows and manages expansion, scrolling, and focus.
- [`navigation-reconcile.ts`](navigation-reconcile.ts) — Reconciles snapshots and incremental inventory changes.
- [`file-actions.ts`](file-actions.ts) — Provides the contextual menu and actions for files and directories.
- [`navigator.css`](navigator.css) — Styles tree rows, search, and Git status colors.
- [`navigator-art.ts`](art/navigator-art.ts) — Sketches empty inventory and filter results.

Run `pnpm test app/tests/interface/explorer/navigator.test.mjs app/tests/interface/explorer/navigation-reconcile.test.mjs`.
