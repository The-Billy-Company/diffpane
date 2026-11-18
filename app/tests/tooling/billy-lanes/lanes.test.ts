import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { listLanes, readLaneChecks, readLaneLog } from '../../../backend/tools/billy-lanes/lanes.ts'
import { indexLanePaths } from '../../../renderer/review/billy-lanes/lanes.ts'

let root: string
let laneRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'diffpane-lanes-'))
  laneRoot = join(root, '.local/lint-lanes')
  await mkdir(join(laneRoot, 'first'), { recursive: true })
  await writeFile(join(laneRoot, 'first/manifest.json'), '')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function context() {
  return { root, signal: new AbortController().signal, run: vi.fn<() => Promise<string>>() }
}

describe('Billy lanes', () => {
  test('indexes shared and renamed paths across recorded lanes', async () => {
    const native = context()
    native.run.mockResolvedValue(
      JSON.stringify({
        rows: [
          { slug: 'first', recorded: ['old.go', 'old.go'], current: true, live: [] },
          { slug: 'second', recorded: ['new.go'], current: false },
        ],
        truncated: true,
      }),
    )
    const page = await listLanes(native)
    const lanesFor = indexLanePaths(page)
    expect(lanesFor({ path: 'new.go', originalPath: 'old.go' })).toEqual(['second', 'first'])
    expect(lanesFor({ path: 'old.go' })).toEqual(['first'])
    expect(lanesFor({ path: 'outside.go', originalPath: null })).toEqual([])
    expect(page.truncated).toBe(true)
    expect(native.run).toHaveBeenCalledWith('igor', [
      'list',
      'checks',
      '--workspace',
      root,
      '--view',
      'lanes',
      '--format',
      'json',
      '--limit',
      '128',
    ])
  })

  test('keeps failure and incomplete evidence visible together', async () => {
    const native = context()
    await mkdir(join(root, 'rulebook'))
    await writeFile(join(root, 'rulebook/guide.md'), '# Guide\n\n## RB-TEST-001\n')
    const manifest = JSON.stringify({
      selection_complete: false,
      captured_at_ns: 1_700_000_000_000_000_000,
      evidence_state: 'inconclusive',
      results: [
        { id: 'pass', status: 'pass' },
        { id: 'rulebook', status: 'fail' },
        { id: 'advisory', status: 'fail', advisory: true },
        { id: 'skip', status: 'skip', selected: false },
      ],
    })
    native.run
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(
        JSON.stringify({
          rows: [
            {
              linter: 'rulebook',
              file: 'source.ts',
              line: 24,
              message: 'Error',
              rulebook: [
                { rule_id: 'RB-TEST-001', guide: 'rulebook/guide.md#rb-test-001' },
                { rule_id: 'RB-TEST-002', guide: 'rulebook/../outside.md' },
              ],
            },
            { linter: 'rulebook', file: '../outside.ts', line: 4, message: 'Other error' },
          ],
          total: 4,
          complete: false,
        }),
      )
      .mockResolvedValueOnce(manifest)
    const result = await readLaneChecks(native, 'first')
    if (result.kind !== 'saved') throw new Error('Expected saved evidence.')
    expect(result.capture).toMatch(/^[a-f0-9]{64}$/u)
    expect(result).toEqual({
      kind: 'saved',
      capture: result.capture,
      capturedAt: 1_700_000_000_000,
      conclusive: false,
      counts: { passed: 1, failed: 1, advisory: 1, skipped: 0 },
      failedChecks: ['rulebook', 'advisory'],
      findings: [
        {
          check: 'rulebook',
          path: 'source.ts',
          line: 24,
          message: 'Error',
          rules: [{ id: 'RB-TEST-001', path: 'rulebook/guide.md', line: 3 }],
        },
        { check: 'rulebook', path: undefined, line: 4, message: 'Other error', rules: [] },
      ],
      findingsComplete: false,
      findingsTotal: 4,
    })
  })

  test('reads a bounded historical log only for the selected failed capture', async () => {
    const native = context()
    const manifest = JSON.stringify({
      results: [
        { id: 'broken', status: 'fail' },
        { id: 'pass', status: 'pass' },
      ],
    })
    native.run
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce('{"rows":[],"total":0,"complete":true}')
      .mockResolvedValueOnce(manifest)
    const result = await readLaneChecks(native, 'first')
    if (result.kind !== 'saved') throw new Error('Expected saved evidence.')
    native.run
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(
        JSON.stringify({
          id: 'broken',
          log: 'error',
          coverage: { read_bytes: 5, total_bytes: 20000, complete: false },
        }),
      )
      .mockResolvedValueOnce(manifest)
    await expect(readLaneLog(native, 'first', 'broken', result.capture)).resolves.toEqual({
      text: 'error',
      readBytes: 5,
      totalBytes: 20000,
      complete: false,
    })
    expect(native.run).toHaveBeenNthCalledWith(
      5,
      'igor',
      [
        'show',
        'checks',
        '--workspace',
        root,
        '--run',
        join(laneRoot, 'first'),
        '--format',
        'json',
        '--view',
        'log',
        '--max-bytes',
        '16384',
        '--tail',
        '80',
        '--',
        'broken',
      ],
      { accept: [0, 1] },
    )
    native.run.mockResolvedValueOnce(manifest)
    await expect(readLaneLog(native, 'first', 'pass', result.capture)).rejects.toThrow('Choose a failed check')
    native.run.mockResolvedValueOnce('{"results":[]}')
    await expect(readLaneLog(native, 'first', 'broken', result.capture)).rejects.toThrow('The saved run changed')
  })

  test('distinguishes missing evidence and refuses linked or escaped lanes', async () => {
    const native = context()
    await symlink(join(laneRoot, 'first'), join(laneRoot, 'linked'), 'dir')
    await expect(readLaneChecks(native, 'missing')).resolves.toEqual({ kind: 'missing' })
    await expect(readLaneChecks(native, 'linked')).rejects.toThrow('regular saved check manifest')
    await expect(readLaneChecks(native, '../first')).rejects.toThrow('Choose a recorded agent lane')
    expect(native.run).not.toHaveBeenCalled()
  })
})
