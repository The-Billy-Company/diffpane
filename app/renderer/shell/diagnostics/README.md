---
doc_radar:
  sentinels:
    - file: app/renderer/shell/diagnostics/diagnostics.ts
      contains: ['reportDiagnostic', 'PerformanceObserver']
---

# Renderer diagnostics

The renderer uses the [shared diagnostic event format](../../../shared/diagnostics/diagnostics.ts) and sends records to the workspace service through the desktop bridge. Records describe operation timing and failure codes. The responsiveness observer reports counts and the longest duration of browser long tasks during each reporting interval.
