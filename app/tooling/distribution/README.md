---
doc_radar:
  sentinels:
    - file: app/tooling/distribution/install.ts
      contains: ['beforeAsar', 'DIFFPANE_CODESIGN_IDENTITY']
---

# macOS distribution

`install.ts` builds the workspace and terminal renderers. It bundles the Electron runtime, shared contracts, language servers, HowMany, and third-party notices. The terminal’s native PTY binding and executable helper are shipped outside the ASAR archive. The installer signs the macOS bundle and installs it and the shell launcher. `diffpane.sh` is the launcher template installed as `diffpane` and linked as `dp`.

Run `npm run install:app` from the repository root on macOS.

The installer uses the available Developer ID Application identity so macOS can recognize Diffpane across rebuilds and retain Keychain access. If several identities are available, set `DIFFPANE_CODESIGN_IDENTITY` to the name or SHA-1 fingerprint of the one to use. With no Developer ID Application identity available, the installer uses ad hoc signing, which can require Keychain approval again after each rebuild. Set `DIFFPANE_CODESIGN_IDENTITY=-` to select ad hoc signing explicitly.

When switching from an ad hoc build to a signed build, macOS may ask for access to **Diffpane Safe Storage** again. Enter the login Keychain password in the macOS dialog and choose **Always Allow** to authorize the signed app.
