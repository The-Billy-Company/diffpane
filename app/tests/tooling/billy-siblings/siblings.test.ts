import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { readBillySiblings } from '../../../backend/tools/billy-siblings/siblings.ts'

const source = 'svc/one/source.go'
const sibling = 'svc/two/sibling.go'
const sourceText = 'package one\n\nfunc start() {\n  Prepare()\n}\n'
const siblingText = 'package two\n\nfunc next() {\n  Prepare()\n}\n'
let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'diffpane-siblings-')))
  await Promise.all(
    [
      [source, sourceText],
      [sibling, siblingText],
    ].map(async ([file, text]) => {
      if (!file || !text) throw new Error('Missing fixture.')
      await mkdir(join(root, file, '..'), { recursive: true })
      await writeFile(join(root, file), text)
    }),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context() {
  return {
    root,
    signal: new AbortController().signal,
    run: vi.fn<() => Promise<string>>(),
    runRelate: vi.fn<() => Promise<{ stdout: string; stderr: string }>>(),
  }
}

function output(unit?: string) {
  return {
    stdout: unit ? JSON.stringify({ unit, grade: 'strong', distance: 0.1, channel: 'any' }) : '',
    stderr: JSON.stringify({
      verb: 'similar',
      unit: 'function',
      probe: `./${source}#L3`,
      source: 'live',
      channel: 'any',
    }),
  }
}

describe('Sibling functions', () => {
  test('uses scoped live Relate results and opens both resolved excerpts', async () => {
    const native = context()
    native.runRelate.mockResolvedValue(output(`${sibling}#L3`))
    const result = await readBillySiblings(native, source, 4)
    expect(result).toEqual({
      kind: 'ready',
      scope: 'svc',
      source: { path: source, line: 3, text: 'func start() {\n  Prepare()\n}\n' },
      candidates: [{ path: sibling, line: 3, grade: 'strong', text: 'func next() {\n  Prepare()\n}\n' }],
    })
    expect(native.runRelate).toHaveBeenCalledExactlyOnceWith(
      [
        'similar',
        `./${source}#L4`,
        '--as',
        'any',
        '--unit',
        'function',
        '--min-grade',
        'moderate',
        '--top',
        '6',
        '--json',
        '--no-index',
        './svc',
      ],
      { accept: [0, 1], timeoutMs: 12_000 },
    )
  })

  test('distinguishes a valid empty comparison from an unresolved function', async () => {
    const native = context()
    native.runRelate.mockResolvedValueOnce(output()).mockRejectedValueOnce(
      new Error('relate could not read the requested evidence.', {
        cause: {
          code: 2,
          stderr: `relate similar: no function contains ./${source}:2 — pass the file alone to compare whole files\n`,
        },
      }),
    )
    await expect(readBillySiblings(native, source, 4)).resolves.toMatchObject({ kind: 'ready', candidates: [] })
    await expect(readBillySiblings(native, source, 2)).resolves.toEqual({ kind: 'no-function' })
  })

  test('rejects a native hit outside the scoped search and mixed source revisions', async () => {
    const native = context()
    native.runRelate.mockResolvedValueOnce(output('outside/file.go#L3')).mockImplementationOnce(async () => {
      await writeFile(join(root, source), sourceText.replace('start', 'newStart'))
      return output()
    })
    await expect(readBillySiblings(native, source, 4)).rejects.toThrow('outside the comparison scope')
    await expect(readBillySiblings(native, source, 4)).rejects.toThrow('changed during comparison')
  })
})
