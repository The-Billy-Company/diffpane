---
doc_radar:
  sentinels:
    - file: app/renderer/review/comparison/function-ranges.ts
      contains: ['changedFunctionRanges']
---

# Focused comparison

The workspace uses these modules to highlight changed functions and focus a comparison on nearby lines. Function ranges can come from the language provider or a lexical fallback.

- [`function-ranges.ts`](function-ranges.ts) — Finds the functions that overlap changed lines.
- [`review-change-map.ts`](review-change-map.ts) — Labels the comparison versions and shows the line ranges for the selected or previewed change. D3 Shape connects matching ranges. Click a mark or ribbon, or use the arrow keys, to jump to that change.
- [`review-focus.js`](review-focus.js) — Owns comparison scope, navigation controls, and the full-file toggle.
- [`review-focus.css`](review-focus.css) — Styles comparison scope and navigation controls.

Run `pnpm test app/tests/interface/review/function-ranges.test.mjs` for function boundaries. Use `pnpm run dev .` to switch between focused and full-file views.
