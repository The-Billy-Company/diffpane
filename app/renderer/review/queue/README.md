---
doc_radar:
  sentinels:
    - file: app/renderer/review/queue/change-review.js
      contains: ['createChangeReview']
---

# Review queue

The workspace supplies changed-file data and opens the file selected in the queue. The queue tracks reviewed revisions separately for each comparison baseline.
Marking the last pending file reviewed sends two small fans of paper and sparkles from the progress strip when reduced motion is off.

- [`change-review.js`](change-review.js) — Owns the changed-file list, progress, baseline selection, and review actions.
- [`change-review.css`](change-review.css) — Styles the list, progress indicator, and review controls.
- [`review-art.ts`](review-art.ts) — Draws the empty-state illustrations with Rough.js and a fixed seed so the sketch stays steady between updates.

Run `pnpm run dev .` and open Changes in a Git workspace with edits. Compare against HEAD and a checkpoint.
