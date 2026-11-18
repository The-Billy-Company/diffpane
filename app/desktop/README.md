---
doc_radar:
  sentinels:
    - file: app/desktop/host/transport.ts
      contains: ['hostRequest', 'handleHost', 'readHost']
    - file: app/desktop/services/keychain.ts
      contains: ['openLegacySecret', 'aes-256-gcm']
---

# Workspace host adapter

The adapter connects the Node.js workspace service to the Tauri host over private standard I/O. It tracks windows and routes the workspace and terminal command sets to their owners. The services directory holds typed adapters for native dialogs, menus, desktop actions, and Keychain-backed encryption.

The Keychain service reads values written by the earlier Electron release. New records use authenticated AES-256-GCM envelopes and separate Keychain keys for the database and Claude credentials.
