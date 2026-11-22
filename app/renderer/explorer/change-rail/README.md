---
doc_radar:
  sentinels:
    - file: app/renderer/explorer/change-rail/change-rail.ts
      contains: ['Explorer change map']
---

# Explorer change map

The map replaces the tree scrollbar when changes are visible in a scrolling tree. It groups marks into fixed buckets so large change sets use the same number of SVG elements. The tree updates marks when its visible rows or Git status change, and updates the viewport indicator as it scrolls.

The native scrollbar stays hidden beside the map on older WebKit versions as well. Trees without a change map retain their native scrollbar.
