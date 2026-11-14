---
doc_radar:
  sentinels:
    - file: app/renderer/illustrations/sketch.ts
      contains: ['rough.svg', 'seed: 42']
---

# Hand-drawn illustrations

Status illustrations use Rough.js with a fixed seed to keep their geometry steady. App palette tokens supply the SVG fills and strokes for light and dark appearance. Sketches are decorative and accompany the text or control that names the state.

- [`sketch.ts`](sketch.ts) provides the stroke settings shared across the workspace.
- [`notebook.ts`](notebook.ts) draws the open notebook and pencil for Ideas.
- [`editor-art.ts`](editor-art.ts) draws document and media fallback illustrations, Markdown callout marks, and the diagram failure mark.
