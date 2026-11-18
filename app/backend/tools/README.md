---
doc_radar:
  sentinels:
    - file: app/backend/tools/analysis/howmany.mjs
      contains: ['class HowManyRuntime']
    - file: app/backend/tools/assistant/claude-session.mjs
      contains: ['class ClaudeSession']
    - file: app/backend/tools/languages/language.mjs
      contains: ['class LanguageRuntime']
---

# Workspace tools

- [Analysis](analysis/README.md) runs HowMany and validates its reports.
- [Assistant](assistant/README.md) connects Claude to user-approved workspace context and edits.
- [Languages](languages/README.md) discovers and manages language servers for open documents.
