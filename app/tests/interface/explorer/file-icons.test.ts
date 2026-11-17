import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { projectIcon } from '../../../renderer/shell/layout/icons.ts'

function iconPath(name: string, kind = 'file', expanded = false) {
  return projectIcon({ name, kind }, expanded)?.split('?')[0] ?? ''
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
  assert.match(iconPath('oxlint.config.mts'), /\/oxc\.svg$/)
  assert.match(iconPath('.eslintrc.yaml'), /\/eslint\.svg$/)
  assert.match(iconPath('compose.override.yaml'), /\/docker\.svg$/)
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
