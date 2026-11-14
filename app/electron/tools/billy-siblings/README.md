---
doc_radar:
  sentinels:
    - file: app/electron/tools/billy-siblings/siblings.ts
      contains: ['readBillySiblings', "'--unit'", "'--no-index'"]
---

# Relate function comparisons

The reader asks Relate to locate the selected function and find close functions in adjacent packages. Workspace source excerpts are bounded, and results carry Relate's native grades and resolved line locations.
