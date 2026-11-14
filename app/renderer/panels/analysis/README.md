---
doc_radar:
  sentinels:
    - file: app/renderer/panels/analysis/howmany.js
      contains: ['createHowMany']
---

# HowMany analysis

The workspace starts analysis through the Electron bridge. This panel turns workspace and file results into summary rows, reports, and editor diagnostics. The full report maps each language’s share of source code lines with D3 Hierarchy.

- [`howmany.js`](howmany.js) — Renders project and per-file reports and manages diagnostic markers.
- [`howmany.css`](howmany.css) — Styles analysis summaries and the report view.
- [`language-treemap.ts`](language-treemap.ts) — Lays out language tiles by code-line count.

Run `pnpm run setup:howmany`, then `pnpm run dev .` to inspect the workspace summary and file report.
