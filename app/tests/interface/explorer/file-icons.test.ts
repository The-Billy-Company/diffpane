import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { projectIcon } from '../../../renderer/shell/layout/icons.ts'

function iconPath(path: string, kind = 'file', expanded = false) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return projectIcon({ name, kind, path }, expanded)?.split('?')[0] ?? ''
}

test('Box and Zoning files use their project artwork', () => {
  for (const name of ['Boxfile', 'tool.box', 'TOOL.BOX']) {
    assert.match(iconPath(name), /\/file-icons\/boxfile\.svg$/)
  }
  for (const name of ['Zonefile', 'charter.zone', 'PACKAGE.ZONE']) {
    assert.match(iconPath(name), /\/file-icons\/zoning\.svg$/)
  }
})

test('YAML and lint associations preserve more specific Material icons', () => {
  for (const name of ['config.yaml', 'config.YML', '.yamllint', '.yamllint.yaml']) {
    assert.match(iconPath(name), /\/file-icons\/yaml-logo\.svg$/)
  }
  assert.match(iconPath('.swiftlint.yml'), /\/swift\.svg$/)
  assert.match(iconPath('.eslintrc.yaml'), /\/eslint\.svg$/)
  assert.match(iconPath('compose.override.yaml'), /\/docker\.svg$/)
  assert.match(iconPath('compose.frontend.yml'), /\/docker\.svg$/)
})

test('named Oxlint configs use the Oxc icon', () => {
  for (const name of [
    'oxlint.config.mts',
    'oxlint.hooks.config.mts',
    'oxlint.reactcompiler.config.mts',
    'oxlint.types.config.mts',
    '.oxlint.react-hooks.strict.config.cts',
    '.oxlintrc.safety.json',
  ]) {
    assert.match(iconPath(name), /\/oxc\.svg$/, name)
  }
  assert.match(iconPath('oxlint.helpers.mts'), /\/typescript\.svg$/)
})

test('named Pyright configs use the Python config icon', () => {
  for (const name of ['pyrightconfig.json', 'pyright.strict.json', 'pyrightconfig.strict.json']) {
    assert.match(iconPath(name), /\/python-misc\.svg$/, name)
  }
  assert.match(iconPath('pyright-utils.json'), /\/json\.svg$/)
})

test('Tool configuration variants share their tool icon', () => {
  const configs = {
    atlas: ['atlas.hcl', 'atlas.sum'],
    cargo: ['Cargo.toml', 'Cargo.lock'],
    clippy: ['clippy.toml', '.clippy.toml'],
    gitleaks: ['.gitleaks.toml', '.gitleaksignore'],
    golangci: ['.golangci.yml', '.golangci.toml'],
    grype: ['.grype.yaml', 'grype.yml'],
    lychee: ['lychee.toml', '.lycheeignore'],
    mise: ['.mise.toml', 'mise.box.toml', 'mise.lock', 'mise.prod.lock'],
    'osv-scanner': ['osv-scanner.toml'],
    spectral: ['.spectral.yaml', '.spectral.json'],
    sqlfluff: ['.sqlfluff', '.sqlfluffignore'],
    syft: ['.syft.yaml', 'SYFT.YML'],
    taplo: ['.taplo.toml', 'taplo.toml'],
    trivy: ['trivy.yaml', '.trivyignore.yaml', '.trivyignore'],
    typos: ['.typos.toml', '_typos.toml'],
    vale: ['.vale.ini', '_vale.ini'],
    zizmor: ['.zizmor.yml', 'zizmor.yaml'],
  }
  for (const [icon, names] of Object.entries(configs)) {
    for (const name of names) {
      assert.ok(iconPath(name).endsWith(`/file-icons/${icon}.svg`), name)
    }
  }
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'pnpm-policy.yaml', '.pnpmfile.cjs', '.pnpmfile.mjs']) {
    assert.match(iconPath(name), /\/pnpm\.svg$/)
  }
  assert.match(iconPath('.worktreeinclude'), /\/git\.svg$/)
  assert.match(iconPath('settings.toml'), /\/toml\.svg$/)
  assert.match(iconPath('example.sql'), /\/database\.svg$/)
  assert.match(iconPath('other.lock'), /\/lock\.svg$/)
})

test('Cargo configuration is identified by its directory', () => {
  assert.match(iconPath('.cargo/config.toml'), /\/file-icons\/cargo\.svg$/)
  assert.match(iconPath('workspace/.cargo/config'), /\/file-icons\/cargo\.svg$/)
  assert.match(iconPath('workspace/.not.cargo/config.toml'), /\/toml\.svg$/)
  assert.match(iconPath('config.toml'), /\/toml\.svg$/)
})

test('legal documents get notice and license icons without replacing source icons', () => {
  for (const name of ['NOTICE', 'Notice.md', 'THIRD-PARTY-NOTICES.txt']) {
    assert.match(iconPath(name), /\/file-icons\/notice\.svg$/)
  }
  for (const name of ['LICENSE', 'LICENSE.Apache-2.0', 'Apache-2.0.txt', 'Licence-MIT.md', 'COPYING.LESSER']) {
    assert.match(iconPath(name), /\/license\.svg$/)
  }
  assert.match(iconPath('license.ts'), /\/typescript\.svg$/)
  assert.match(iconPath('notice.js'), /\/javascript\.svg$/)
  assert.match(iconPath('Boxfile', 'directory'), /\/folder\.svg$/)
  assert.match(iconPath('Zonefile', 'directory', true), /\/folder-open\.svg$/)
})
