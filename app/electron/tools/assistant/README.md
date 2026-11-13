---
doc_radar:
  sentinels:
    - file: app/electron/tools/assistant/claude-api.mjs
      contains: ['verifyClaudeKey', 'requestClaude']
    - file: app/electron/tools/assistant/claude-credentials.mjs
      contains: ['safeStorage.encryptStringAsync']
    - file: app/electron/tools/assistant/claude-session.mjs
      contains: ['class ClaudeSession', 'PROPOSAL_READY']
    - file: app/electron/tools/assistant/claude-workspace.mjs
      contains: ['claudeVisiblePath', 'MAX_CLAUDE_FILE_BYTES', 'readClaudeFiles']
    - file: app/electron/tools/assistant/gist-search.mjs
      contains: ['searchClaudeGist', '--fixed-strings']
---

# Claude assistant

- [`claude-api.mjs`](claude-api.mjs) verifies API keys and consumes Anthropic's streaming responses.
- [`claude-credentials.mjs`](claude-credentials.mjs) encrypts local credentials through Electron's secure storage.
- [`claude-session.mjs`](claude-session.mjs) manages conversation turns, tool requests, and proposals awaiting review.
- [`claude-workspace.mjs`](claude-workspace.mjs) checks workspace path visibility and bounds single-file and batch reads.
- [`gist-search.mjs`](gist-search.mjs) finds literal phrases in working files with the locally installed Gist CLI and verifies matches through the assistant’s workspace reader.

The assistant uses the [repository](../../workspace/repository/README.md) and [project records](../../persistence/project/README.md) as its workspace boundaries. Run `pnpm test app/tests/tooling/assistant` from the repository root.
