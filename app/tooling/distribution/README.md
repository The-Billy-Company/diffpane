---
doc_radar:
  sentinels:
    - file: app/tooling/distribution/install.ts
      contains: ['beforeAsar', 'DIFFPANE_CODESIGN_IDENTITY', 'macos-info.plist']
    - file: app/tooling/distribution/macos-info.plist
      contains: ['CFBundleDocumentTypes', 'Alternate', 'public.source-code', 'public.plain-text']
---

# macOS distribution

`install.ts` builds the workspace and terminal renderers. It bundles the Electron runtime, shared contracts, language servers, HowMany, and third-party notices. The terminal’s native PTY binding and executable helper are shipped outside the ASAR archive. The installer signs the macOS bundle and installs it and the shell launcher. `diffpane.sh` is the launcher template installed as `diffpane` and linked as `dp`.

Run `pnpm run install:app` from the repository root on macOS.

The installer merges `macos-info.plist` into the app bundle. Finder can offer Diffpane as an alternate editor under **Open With** for recognized source and plain-text files. The file needs to be in a Git working tree to open as a workspace.

The installer uses the available Developer ID Application identity so macOS can recognize Diffpane across rebuilds and retain Keychain access. If several identities are available, set `DIFFPANE_CODESIGN_IDENTITY` to the name or SHA-1 fingerprint of the one to use. With no Developer ID Application identity available, the installer uses ad hoc signing, which can require Keychain approval again after each rebuild. Set `DIFFPANE_CODESIGN_IDENTITY=-` to select ad hoc signing explicitly.

When switching from an ad hoc build to a signed build, macOS may ask for access to **Diffpane Safe Storage** again. Enter the login Keychain password in the macOS dialog and choose **Always Allow** to authorize the signed app.

## Release to Box

On Apple Silicon, set the same release version in `package.json` and the root [Boxfile](../../../Boxfile), then run `pnpm run package:app` with the Developer ID Application identity. This writes the timestamp-signed bundle to `release/box-build/Diffpane-darwin-arm64/Diffpane.app` with the Electron and Chromium license files in its resources.

Notarize and staple that bundle using the release signing credentials. Create the GitHub release ZIP with `ditto -c -k --sequesterRsrc --keepParent`, then generate its SHA-256 file with `shasum -a 256`. Upload `Diffpane-VERSION-macos-arm64.zip` and `Diffpane-VERSION-macos-arm64.zip.sha256` to the matching `vVERSION` GitHub release. Use archive filenames without directory prefixes in the checksum file.

The [Publish Diffpane to Box workflow](../../../.github/workflows/publish-box.yml) runs when the GitHub release is published and supports manual retries. It checks the ZIP checksum, version, architecture, Developer ID signature and stapled ticket before packing the native app. Configure `BOX_RUNTIME_TOKEN` with read access to the internal Box runtime repository, plus `BOX_REGISTRY_TOKEN` and `BOX_REGISTRY_READ_TOKEN` for the registry. The registry and workflow runtime need application support from Box 0.3.0.

`diffpane-app` is a separate release ID from the historical `diffpane` CLI wrapper. A release ZIP with notices alongside the bundle needs a new signed bundle with those notices embedded before it can be published as `diffpane-app`.
