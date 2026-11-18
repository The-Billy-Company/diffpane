---
doc_radar:
  sentinels:
    - file: src-tauri/src/host/workspace/bridge.rs
      contains: ['desktop_connect', 'desktop_invoke', 'desktop_send']
    - file: src-tauri/src/host/mod.rs
      contains: ['tauri_plugin_dialog', 'tauri_plugin_opener', 'tauri_plugin_clipboard_manager']
---

# Tauri desktop host

Tauri hosts the workspace UI in WebKit and owns app and window lifecycle. Dialog, opener, and clipboard plugins handle desktop integration. Native Keychain calls protect local state and credentials. The terminal uses a separate child WebView with its own command set. The media server streams authorized files from the loopback interface.

The host starts one Node.js workspace service. Private standard I/O carries requests, responses, and events. The host derives the workspace identity from the calling WebView and gives each view its own event channel. The workspace service owns Git, session workers, persistence, and language tools.

Use `pnpm run dev .` from the repository root. Run `cargo test --locked --manifest-path src-tauri/Cargo.toml` for the native tests. The [distribution guide](../app/tooling/distribution/README.md) describes signing and packaging.
