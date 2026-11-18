---
doc_radar:
  sentinels:
    - file: app/backend/tools/billy/native.ts
      contains: ['createBillyContext', 'readBillyText', 'isBillyWorkspace']
---

# Billy review tools

Billy review actions read a recognized Billy checkout through the window that opened it. The main process owns bounded tool calls and repository reads. Read-only operations use fixed arguments, and closing or reloading the window cancels its tool calls.
