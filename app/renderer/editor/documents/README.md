---
doc_radar:
  sentinels:
    - file: app/renderer/editor/documents/document-preview.ts
      contains: ['URL.revokeObjectURL']
---

# Document previews

The workspace uses this view for native media, bounded text, and hexadecimal inspection. It consumes the Electron file-content contract and releases preview resources when the active file changes.
Image comparisons offer Pixel diff for pairs of PNG, JPEG, BMP, and ICO files up to 4 MiB each. The images must have matching dimensions. Pixelmatch highlights pixels that changed and reports their count.

- [`document-preview.ts`](document-preview.ts) — Builds the preview and comparison panes and owns Blob URLs.
- [`media.ts`](media.ts) — Mounts image and video previews and releases playback when detached.
- [`image-diff/`](image-diff/) — Computes and displays a pixel-level comparison on demand.
- [`document-preview.css`](document-preview.css) — Styles preview panes, metadata, and the Hex toggle.
- [`document-runtime.ts`](document-runtime.ts) — Runs large Markdown parses and comparison function scans in a shared, on-demand worker. Changing files cancels obsolete work.

Run `pnpm run dev .` and open an image, a PDF, and a binary file to exercise rendering and the byte fallback.
