---
doc_radar:
  sentinels:
    - file: app/electron/tools/billy-replay/reader.ts
      contains: [createBillyReplayReader, 'contracts/domain/agent/playbooks.toml', 'O_NOFOLLOW']
    - file: app/electron/tools/billy-replay/transcript.ts
      contains: [projectReplayCase, prompt_composition]
---

# Local Billy Replay reader

The per-window reader accepts a native picker selection for a saved `run.json`. It exposes only the manifest's named scenario files and retains their locations in the main process. The transcript projection keeps a bounded preview and a complete content hash for each recorded field.

The current project playbook registry supplies declared routes. Retained scenarios independently supply turn and model evidence. The reader makes no network calls and does not persist selections or transcript contents.
