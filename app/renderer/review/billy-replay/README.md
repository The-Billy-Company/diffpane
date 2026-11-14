---
doc_radar:
  sentinels:
    - file: app/renderer/review/billy-replay/billy-replay.ts
      contains: [createBillyReplay, First observed divergence]
    - file: app/renderer/review/billy-replay/comparison.ts
      contains: [compareReplayCases, Loaded playbooks changed]
---

# What Billy Saw

Open two saved Billy Replay `run.json` files and choose a common scenario. Compare their retained tool calls, prompt composition and replies by turn. Divergence identifies the first observed difference across comparable fields, with missing model and tool evidence indicated on each side.

An open template with a unique entry in Billy's current registry also shows its declared route and owning eval. That checkout metadata stays separate from the contents retained by either run.
