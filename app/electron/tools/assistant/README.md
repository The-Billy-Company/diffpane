---
doc_radar:
  sentinels:
    - file: app/electron/tools/assistant/claude-api.mjs
      contains: ['verifyClaudeKey', 'requestClaude']
    - file: app/electron/tools/assistant/claude-credentials.mjs
      contains: ['safeStorage.encryptStringAsync']
    - file: app/electron/tools/assistant/claude-session.mjs
      contains: ['class ClaudeSession', 'PROPOSAL_READY']
    - file: app/electron/tools/assistant/claude-edits.mjs
      contains: ['class ClaudeFileEdits', 'recordExcerpt']
    - file: app/electron/tools/assistant/claude-prompt.mjs
      contains: ['creaturePrompt', 'You are The Creature.']
    - file: app/electron/tools/assistant/claude-workspace.mjs
      contains: ['claudeVisiblePath', 'MAX_CLAUDE_FILE_BYTES', 'readClaudeFiles']
    - file: app/electron/tools/assistant/gist-search.mjs
      contains: ['searchClaudeGist', 'searchClaudeFiles', '--fixed-strings']
---

# Claude assistant

- [`claude-api.mjs`](claude-api.mjs) verifies API keys and consumes Anthropic's streaming responses.
- [`claude-credentials.mjs`](claude-credentials.mjs) encrypts local credentials through Electron's secure storage.
- [`claude-session.mjs`](claude-session.mjs) manages conversation turns, tool requests, and proposals awaiting review.
- [`claude-edits.mjs`](claude-edits.mjs) stages exact text changes against inspected ranges and builds a grouped preview for review.
- [`claude-prompt.mjs`](claude-prompt.mjs) keeps the Creature’s voice and workspace guidance together with a short addition for Edit mode.
- [`claude-workspace.mjs`](claude-workspace.mjs) checks workspace path visibility and bounds single-file and batch reads.
- [`gist-search.mjs`](gist-search.mjs) searches working files through the assistant’s workspace reader and uses Gist to locate candidates when installed.
- [`agent-threads/threads.ts`](agent-threads/threads.ts) discovers local agent threads from Codex, Claude Code, Antigravity, and Cursor. It groups Git worktrees by their shared project and provides status and recent activity from each provider's saved state. The selected transcript updates as the provider saves events. Structured file references become links to current file contents.

The assistant uses the [repository](../../workspace/repository/README.md) and [project records](../../persistence/project/README.md) as its workspace boundaries. Run `pnpm test app/tests/tooling/assistant` from the repository root.
