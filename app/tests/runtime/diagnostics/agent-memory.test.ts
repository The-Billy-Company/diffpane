import { describe, expect, it } from 'vite-plus/test'
import { parseProcessMemory, parseWindowsPressure } from '../../../electron/runtime/diagnostics/agent-memory.ts'

describe('agent memory sampling', () => {
  const now = 1_800_000_000_000
  const windows = { version: 1, pressure: 'warning', sampledAt: now - 2_000, usedBytes: 8_192, totalBytes: 16_384 }

  it('reads fresh Windows pressure and physical memory', () => {
    expect(parseWindowsPressure(JSON.stringify(windows), now)).toEqual({
      source: 'windows',
      pressure: 'warning',
      sampledAt: now - 2_000,
      usedBytes: 8_192,
      totalBytes: 16_384,
    })
  })

  it('rejects stale, future, or unrecognized samples', () => {
    for (const change of [
      { sampledAt: now - 6_000 },
      { sampledAt: now + 2_000 },
      { pressure: 'high' },
      { version: 2 },
    ]) {
      expect(parseWindowsPressure(JSON.stringify({ ...windows, ...change }), now)).toBeUndefined()
    }
  })

  it('keeps pressure when a sample has no valid RAM totals', () => {
    expect(parseWindowsPressure(JSON.stringify({ ...windows, totalBytes: 4_096 }), now)).toEqual({
      source: 'windows',
      pressure: 'warning',
      sampledAt: now - 2_000,
    })
  })

  it('preserves executable paths and converts resident KiB to bytes for exact PIDs', () => {
    const processes = parseProcessMemory('  421 2500 Fri Nov  6 21:28:43 2026    /Some App/codex\n malformed row\n')
    expect([...processes]).toEqual([
      [421, { residentBytes: 2_560_000, startedAt: Date.UTC(2026, 10, 6, 21, 28, 43), executable: '/Some App/codex' }],
    ])
  })
})
