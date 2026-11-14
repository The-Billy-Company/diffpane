---
doc_radar:
  sentinels:
    - file: app/renderer/shell/recovery/error-boundary.ts
      contains: ['showErrorBoundary']
---

# Recovery

The shell and feature controllers share these loading and failure views. Recovery actions belong to the feature that owns the failed operation.
The opener draws at its display size with a CSS first-paint fallback. Project-open failures show the recovery action beside the summary and disclose the raw diagnostic under Technical details.

- [`error-boundary.ts`](error-boundary.ts) — Mounts failure messages and retry actions.
- [`errors.ts`](errors.ts) — Handles startup failures, global notices, and guarded callbacks.
- [`error-boundary.css`](error-boundary.css) — Styles failure views and notices.
- [`workspace-opening.css`](workspace-opening.css) — Animates the workspace opener from the first page paint.
- [`window-mascot.css`](window-mascot.css) — Draws the CSS character at first paint.
- [`window-art.ts`](art/window-art.ts) — Sketches the shared window character and the opener's animated diff pages.
- [`loading.css`](loading.css) — Styles inline loading indicators and editor placeholders.

Run `pnpm run dev .` and inspect the startup loading view or open a file that has been removed from disk to exercise recovery.
