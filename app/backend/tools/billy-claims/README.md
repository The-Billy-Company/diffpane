---
doc_radar:
  sentinels:
    - file: app/backend/tools/billy-claims/claims.ts
      contains: ['readBillyClaims', 'verificationFindings']
---

# Reverse Doc Radar links

Gist nominates Markdown and rule documents for the active source path. The reader inspects leading YAML for path, sentinel and occurrence declarations and preserves their lines. A native scoped read supplies current drift for named documents when the Billy Python environment is available.

Discovery is bounded and covers directly named paths. Glob inventories and indirect semantic claims live in Doc Radar's full report.
