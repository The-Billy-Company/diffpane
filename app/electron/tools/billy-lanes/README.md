---
doc_radar:
  sentinels:
    - file: app/electron/tools/billy-lanes/lanes.ts
      contains: ['listLanes', 'readLaneChecks', 'readLaneLog', 'selection_complete']
---

# Billy lane evidence

The adapter lists recorded edit lanes and reads Igor's saved checks and findings. It preserves incomplete runs and links rulebook headings where available. The log reader shows a bounded tail for a failed check in the selected capture.
