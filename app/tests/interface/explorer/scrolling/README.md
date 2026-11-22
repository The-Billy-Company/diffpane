---
doc_radar:
  sentinels:
    - file: app/tests/interface/explorer/scrolling/navigator-scrolling.test.ts
      contains: ['inventory insertions preserve the first visible explorer row', 'webkit.launch']
---

# Explorer scrolling

These WebKit regressions mount the real navigator. They check that inventory insertions preserve the first visible filename and its partial-row pixel offset, rapid scrolling retains enough rows before the next render, and the change map replaces the native scrollbar through the WebKit fallback.

Run `pnpm test app/tests/interface/explorer/scrolling/navigator-scrolling.test.ts`. Install the browser with `pnpm exec playwright install webkit` if needed.
