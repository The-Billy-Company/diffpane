---
doc_radar:
  sentinels:
    - file: app/renderer/editor/documents/document-preview.ts
      contains: ['URL.revokeObjectURL']
---

# Document previews

The workspace uses this view for native media, bounded text, and hexadecimal inspection. It consumes the Electron file-content contract and releases preview resources when the active file changes.
Image headings show up to five dominant colors for PNG, APNG, JPEG, GIF, WebP, AVIF, SVG, BMP, and ICO previews. Palettes sample the decoded preview, including large streamed images and the default frame of animations. Hover a swatch to see its hex value.
In an image comparison, choose Wipe and drag the divider or use the arrow keys to reveal each version in place. Each palette stays beside its version label. Pixel diff highlights and counts changed pixels in PNG, JPEG, BMP, and ICO pairs up to 4 MiB each with matching dimensions.
Audio clips up to 4 MiB and five minutes show a WaveSurfer.js waveform in each preview pane. Click or drag the waveform to seek, or use the native player controls.

- [`document-preview.ts`](document-preview.ts) — Builds the preview and comparison panes and owns Blob URLs.
- [`media.ts`](media.ts) — Mounts image and video previews and releases playback when detached.
- [`audio-waveform/`](audio-waveform/) — Mounts audio playback and renders an interactive waveform from bounded document bytes.
- [`image-diff/`](image-diff/) — Displays the interactive image wipe and computes pixel differences on demand.
- [`document-preview.css`](document-preview.css) — Styles preview panes, metadata, and the Hex toggle.
- [`document-runtime.ts`](document-runtime.ts) — Runs large Markdown parses and comparison function scans in a shared, on-demand worker. Changing files cancels obsolete work.

Run `pnpm run dev .` and open an image, a PDF, and a binary file to exercise rendering and the byte fallback.
