import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vite-plus/test'
import { readBillyClaims } from '../../../electron/tools/billy-claims/claims.ts'
import type { BillyDocRadarContext } from '../../../electron/tools/billy/native.ts'

const source = 'modules/tool.ts'
const readme = 'modules/README.md'
const ordinary = 'docs/sample.md'

async function fixture(
  run: BillyDocRadarContext['run'],
  verifyDocRadar: BillyDocRadarContext['verifyDocRadar'] = async () => {
    throw new Error('Doc Radar unavailable')
  },
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'diffpane-claims-')))
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return {
    context: { root, signal: new AbortController().signal, run, verifyDocRadar },
    write,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

test('links an exact YAML declaration and attaches only its native drift', async () => {
  const f = await fixture(
    async () => `./${readme}\0./${ordinary}\0`,
    async docs => {
      assert.deepEqual(docs, [readme])
      return JSON.stringify({
        scoped: docs,
        finding_count: 2,
        assertion_doc_count: 1,
        findings: [
          {
            kind: 'doc_sentinel_missing',
            adr: 'doc:modules-readme',
            detail: '`modules/tool.ts` no longer contains `oldVerb`',
          },
          {
            kind: 'doc_sentinel_missing',
            adr: 'doc:modules-readme',
            detail: '`modules/other.ts` no longer contains `oldVerb`',
          },
        ],
      })
    },
  )
  try {
    await Promise.all([
      f.write(source, 'newVerb'),
      f.write(readme, '<!--\ndoc_radar:\n  sentinels:\n    tool.ts:\n      contains: [oldVerb]\n-->\n# Tools\n'),
      f.write(ordinary, '# Examples\n\nThis example uses modules/tool.ts\n'),
    ])
    const result = await readBillyClaims(f.context, source)
    assert.deepEqual(result, {
      verification: 'scoped',
      limited: false,
      claims: [
        {
          path: readme,
          line: 4,
          kind: 'sentinel',
          label: 'oldVerb',
          findings: ['`modules/tool.ts` no longer contains `oldVerb`'],
        },
      ],
    })
  } finally {
    await f.dispose()
  }
})

test('keeps a removed sibling declaration when native verification is unavailable', async () => {
  const f = await fixture(
    async () => `${readme}\0`,
    async () => {
      throw new Error('Missing Python runtime')
    },
  )
  try {
    await f.write(
      readme,
      '---\ndoc_radar:\n  occurrences:\n    - file: tool.ts\n      pattern: run\n      equals: 4\n---\n',
    )
    const result = await readBillyClaims(f.context, source)
    assert.deepEqual(result, {
      verification: 'unavailable',
      limited: false,
      claims: [{ path: readme, line: 4, kind: 'occurrence', label: 'run', findings: [] }],
    })
  } finally {
    await f.dispose()
  }
})

test('surfaces incomplete coverage for malformed declarations', async () => {
  const f = await fixture(async () => `${readme}\0`)
  try {
    await f.write(readme, '---\ndoc_radar:\n  sentinels: [unclosed\n---\n')
    const result = await readBillyClaims(f.context, source)
    assert.deepEqual(result, { verification: 'unavailable', limited: true, claims: [] })
  } finally {
    await f.dispose()
  }
})

test('does not attach ambiguous native findings to either document with a shared radar label', async () => {
  const first = 'docs/first/SKILL.md'
  const second = 'docs/second/SKILL.md'
  const f = await fixture(
    async () => `${first}\0${second}\0`,
    async docs =>
      JSON.stringify({
        scoped: docs,
        assertion_doc_count: 2,
        finding_count: 1,
        findings: [
          { kind: 'doc_sentinel_missing', adr: 'doc:SKILL', detail: '`modules/tool.ts` no longer contains `oldVerb`' },
        ],
      }),
  )
  try {
    const body = '---\ndoc_radar:\n  sentinels:\n    - file: modules/tool.ts\n      contains: [oldVerb]\n---\n'
    await Promise.all([f.write(first, body), f.write(second, body)])
    const result = await readBillyClaims(f.context, source)
    assert.equal(result.verification, 'scoped')
    assert.ok(result.limited)
    assert.deepEqual(
      result.claims.map(claim => [claim.path, claim.findings]),
      [
        [first, []],
        [second, []],
      ],
    )
  } finally {
    await f.dispose()
  }
})
