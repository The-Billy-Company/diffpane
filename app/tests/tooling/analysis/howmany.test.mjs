// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, mkdir, rm, realpath, symlink, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test, vi } from 'vite-plus/test'
import { HowManyRuntime, discoverHowMany, validateReport } from '../../../backend/tools/analysis/howmany.mjs'
import {
  inspectHowManySource,
  stampHowManyBinary,
  verifyHowManySource,
} from '../../../tooling/dependencies/setup-howmany.ts'

const execute = promisify(execFile)

/**
 * @import { TestContext } from 'vite-plus/test'
 * @import { HowManyEvent } from '../../../backend/tools/analysis/howmany.mjs'
 */

/** @param {() => boolean} predicate */
async function until(predicate) {
  await vi.waitFor(() => assert.equal(predicate(), true, 'Timed out waiting for HowMany'), {
    interval: 20,
    timeout: 10_000,
  })
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function diagnostics(value) {
  if (!Array.isArray(value)) throw new Error('Expected HowMany diagnostics')
  return value.map((/** @type {unknown} */ item) => {
    if (typeof item !== 'object' || item === null) throw new Error('Invalid HowMany diagnostic')
    return { ...item }
  })
}
function sourceReport() {
  const source = {
    file_count: 1,
    total_lines: 4,
    code_lines: 2,
    comment_lines: 1,
    doc_lines: 0,
    blank_lines: 1,
    total_size: 50,
  }
  const { file_count, ...counts } = source
  /** @type {import('../../../backend/tools/analysis/howmany.mjs').BreakdownRow[]} */
  const rows = [{ ...source, language: 'JavaScript', category: 'code' }]
  return {
    basic: { ...counts, total_files: file_count, stats_by_extension: {} },
    source,
    breakdown: { rows },
    metadata: { version: '3.1.0' },
  }
}

/** @param {TestContext} t @param {{ wait?: number, output?: string, version?: string }} [options] */
async function fixture(t, { wait = 0, output = 'valid', version = '3.1.0' } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-')))
  const command = path.join(root, 'howmany-fixture')
  const source = sourceReport()
  source.metadata.version = version
  const report = version === '3.0.0' ? { basic: source.basic, metadata: source.metadata } : source
  // Protocol boundary fixture: check argument passing, subprocess ownership and retry behavior.
  await writeFile(
    command,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(`howmany ${version}`)}); process.exit(0); }
if (args.includes('lsp')) process.exit(99);
if (!args.includes('--no-cache') || !args.includes('--no-interactive')) process.exit(98);
setTimeout(() => {
  if (${JSON.stringify(output)} === 'invalid') { console.log('{}'); return; }
  console.log(${JSON.stringify(JSON.stringify(report))});
}, ${wait});
`,
    { mode: 0o755 },
  )
  /** @type {HowManyEvent[]} */
  const events = []
  const runtime = new HowManyRuntime(root, root, event => events.push(event), {
    command,
    debounceMs: 30,
    timeoutMs: 5000,
  })
  t.onTestFinished(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(path.join(root, 'name with spaces;echo.js'), '// comment\nconst a = 1;\n\na;\n')
  return { root, command, runtime, events }
}

test(
  'workspace analysis coalesces calls and catches saves arriving during an analysis',
  { timeout: 15_000 },
  async t => {
    const { runtime, events } = await fixture(t, { wait: 150 })
    assert.equal(events.length, 0, 'constructing the runtime starts no processes')
    const first = runtime.analyze()
    assert.equal(runtime.analyze(), first)
    runtime.changed(['a.js'])
    runtime.changed(['b.js'])
    assert.equal((await first).status, 'ready')
    await until(() => events.filter(event => event.type === 'analysis' && event.status === 'ready').length === 2)
    assert.equal(events.filter(event => event.type === 'process' && event.status === 'started').length, 2)
    const previous = events.length
    await runtime.analyze()
    assert.equal(events.length, previous, 'unchanged reports reuse the result')
  },
)

test('expensive workspace scans leave an idle interval while explicit refresh stays immediate', async t => {
  const { runtime, events } = await fixture(t, { wait: 150 })
  await runtime.analyze()
  const report = runtime.state.report
  const started = () => events.filter(event => event.type === 'process' && event.status === 'started').length

  runtime.changed(['a.js'])
  runtime.changed(['b.js'])
  await delay(150)
  assert.equal(started(), 1, 'saves must not immediately restart an expensive full scan')
  assert.equal(runtime.state.report, report, 'the previous report remains available')

  const manual = runtime.analyze(true)
  assert.equal(started(), 2, 'an explicit refresh bypasses the automatic cooldown')
  await manual
  runtime.changed(['c.js'])
  await until(() => events.filter(event => event.type === 'analysis' && event.status === 'ready').length === 3)
  assert.equal(started(), 3, 'pending saves eventually receive one fresh report')
})

test('timed-out workspace scans also back off before retrying automatically', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 })
  runtime.options.timeoutMs = 100
  assert.match((await runtime.analyze()).message, /timed out/)
  runtime.changed(['a.js'])
  await delay(150)
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    1,
    'an analysis that times out must not become a tight retry loop',
  )
})

test('older CLI counts files with literal argument paths and never launches its missing LSP', async t => {
  const { runtime } = await fixture(t, { version: '3.0.0' })
  const result = await runtime.file('name with spaces;echo.js', async () => '', 'literal-path')
  assert.equal(result?.live, false)
  assert.equal(result?.title, '4 lines · 2 code · 1 comment · 1 blank')
  assert.equal(runtime.languages.servers.size, 0)
})

test('file counts fall back to the CLI when an advertised live server cannot start', async t => {
  const { runtime } = await fixture(t)
  const result = await runtime.file('name with spaces;echo.js', async () => '', 'failed-server')

  assert.equal(result?.live, false)
  assert.equal(result?.title, '4 lines · 2 code · 1 comment · 1 blank')
  assert.equal(runtime.languages.documents.size, 0)
})

test('workspace reports require source totals instead of relabeling older all-content totals', async t => {
  const { runtime } = await fixture(t, { version: '3.0.0' })
  const state = await runtime.analyze()
  assert.equal(state.status, 'error')
  assert.equal(state.report, null)
  assert.match(state.message, /source totals are unavailable/)
})

test('report validation keeps data outside source totals and rejects inconsistent counts', () => {
  const report = sourceReport()
  const data = {
    language: 'JSON',
    category: /** @type {const} */ ('data'),
    file_count: 1,
    total_lines: 100,
    code_lines: 100,
    comment_lines: 0,
    doc_lines: 0,
    blank_lines: 0,
    total_size: 1000,
  }
  report.breakdown.rows.push(data)
  report.basic.total_files += data.file_count
  report.basic.total_lines += data.total_lines
  report.basic.code_lines += data.code_lines
  report.basic.total_size += data.total_size
  assert.equal(validateReport(report), report)
  assert.equal(report.source.code_lines, 2)
  assert.equal(report.basic.code_lines, 102)

  const [sourceRow, dataRow] = report.breakdown.rows
  assert.ok(sourceRow && dataRow)
  const invalidReports = [
    { ...report, source: { ...report.source, code_lines: -1 } },
    { ...report, source: { ...report.source, file_count: 1.5 } },
    { ...report, source: { ...report.source, total_size: Infinity } },
    { ...report, source: { ...report.source, file_count: 2 } },
    { ...report, basic: { ...report.basic, total_lines: report.basic.total_lines + 1 } },
    { ...report, breakdown: { rows: [{ ...sourceRow, language: null }, dataRow] } },
    { ...report, breakdown: { rows: [{ ...sourceRow, category: 'unknown' }, dataRow] } },
    { ...report, breakdown: { rows: [sourceRow, { ...dataRow, file_count: 2 }] } },
    { ...report, breakdown: { rows: null } },
  ]
  for (const invalid of invalidReports) {
    assert.throws(() => validateReport(invalid), /invalid report/)
  }
})

for (const filename of ['../secret.js', '/etc/hosts', 'outside.js', 'nul\0.js']) {
  test(`file requests reject the invalid path ${JSON.stringify(filename)} before launching HowMany`, async t => {
    const { root, runtime, events } = await fixture(t)
    await symlink('/etc/hosts', path.join(root, 'outside.js'))
    await assert.rejects(
      runtime.file(filename, async () => '', 'invalid-path'),
      /Invalid|outside/,
    )
    assert.equal(events.length, 0)
  })
}

test('a slow file read cannot supersede a later count or reopen a closed document', async t => {
  const { runtime, root, events } = await fixture(t, { version: '3.0.0' })
  const first = 'name with spaces;echo.js'
  const second = 'second.js'
  await writeFile(path.join(root, second), 'const b = 2;\n')

  await [first, second].reduce(async (previous, latest) => {
    await previous
    /** @type {PromiseWithResolvers<string>} */
    const read = Promise.withResolvers()
    const slow = runtime.file(first, () => read.promise, 'older')
    assert.equal((await runtime.file(latest, async () => '', 'latest'))?.path, latest)
    const before = events.length
    read.resolve('old contents')
    assert.equal(await slow, null)
    assert.equal(runtime.activeFile, latest)
    assert.equal(events.length, before, 'obsolete reads must not start HowMany')
  }, Promise.resolve())

  /** @type {PromiseWithResolvers<string>} */
  const read = Promise.withResolvers()
  const closing = runtime.file(first, () => read.promise, 'closing')
  runtime.closeFile(first)
  read.resolve('closed contents')
  assert.equal(await closing, null)
  assert.equal(runtime.activeFile, null)
})

test('invalid reports and missing tools produce recoverable analysis errors', async t => {
  const { runtime, root } = await fixture(t, { output: 'invalid' })
  assert.match((await runtime.analyze()).message, /invalid report/)
  runtime.options.command = path.join(root, 'missing')
  const state = await runtime.analyze(true)
  assert.equal(state.status, 'error')
  assert.equal(state.report, null)
  assert.equal(runtime.processes.size, 0)
})

test('timeouts and disposal terminate owned analysis processes', async t => {
  const { runtime, events } = await fixture(t, { wait: 30_000 })
  runtime.options.timeoutMs = 100
  assert.match((await runtime.analyze()).message, /timed out/)
  runtime.options.timeoutMs = 30_000
  const pending = runtime.analyze(true)
  await until(() => runtime.processes.size > 0)
  await runtime.dispose()
  await pending
  assert.equal(runtime.processes.size, 0)
  assert.equal(
    events.filter(event => event.type === 'process' && event.status === 'started').length,
    events.filter(event => event.type === 'process' && event.status === 'stopped').length,
  )
})

test('shutdown waits for a language runtime being replaced by a config reload', async t => {
  const { runtime } = await fixture(t)
  /** @type {PromiseWithResolvers<void>} */
  const retired = Promise.withResolvers()
  const previous = runtime.languages
  vi.spyOn(previous, 'dispose').mockReturnValueOnce(retired.promise)
  const configuration = runtime.configure(new AbortController().signal)
  await vi.waitFor(() => assert.notEqual(runtime.languages, previous))

  const shutdown = runtime.dispose()
  const repeated = runtime.dispose()
  const firstFinished = vi.fn()
  const secondFinished = vi.fn()
  const observed = [shutdown.then(firstFinished), repeated.then(secondFinished)]
  await delay(0)
  const finishedEarly = [firstFinished.mock.calls.length, secondFinished.mock.calls.length]
  retired.resolve()
  await Promise.all([configuration, ...observed])

  assert.deepEqual(finishedEarly, [0, 0])
})

test('bundling rejects a changed source archive before compilation', () => {
  assert.throws(() => verifyHowManySource(Buffer.from('changed source')), /checksum mismatch/)
})

test('packaged provenance hashes the signed executable and preserves source identity', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-signature-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = { path: '/source/howmany', revision: 'revision', sha256: 'source-hash' }
  await writeFile(
    path.join(root, 'build.json'),
    JSON.stringify({ identity: 'local-source', version: '3.1.0', sha256: 'before-signing', source }),
  )
  const signed = Buffer.from('executable bytes after signing')
  await writeFile(path.join(root, 'howmany'), signed)
  await stampHowManyBinary(root)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8')), {
    identity: 'local-source',
    version: '3.1.0',
    sha256: createHash('sha256').update(signed).digest('hex'),
    source,
  })
})

test('local source provenance follows working-tree inputs and ignores build output', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-source-')))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await execute('git', ['init', '--quiet', root])
  await execute('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'Fixture',
  ])
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, '.gitignore'), '/target/\n')
  await writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "howmany"\nversion = "3.1.0"\n')
  await writeFile(path.join(root, 'src/main.rs'), 'fn main() {}\n')
  const original = await inspectHowManySource(root)
  assert.equal(original.version, '3.1.0')
  await mkdir(path.join(root, 'target'))
  await writeFile(path.join(root, 'target/cache'), 'build output')
  assert.equal((await inspectHowManySource(root)).sha256, original.sha256)
  await writeFile(path.join(root, 'src/main.rs'), 'fn main() { println!("changed"); }\n')
  const changed = await inspectHowManySource(root)
  assert.equal(changed.revision, original.revision)
  assert.notEqual(changed.sha256, original.sha256, 'uncommitted edits invalidate the bundled scanner')
  await writeFile(path.join(root, 'src/new.rs'), 'pub fn added() {}\n')
  assert.notEqual((await inspectHowManySource(root)).sha256, changed.sha256, 'untracked source is included')
})

const bundled = new URL('../../../../resources/howmany/howmany', import.meta.url)
test.skipIf(!existsSync(bundled))(
  'bundled workspace scanner counts Lean and C++ modules, retaining copied tests and excluding generated output',
  async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'diffpane-howmany-scope-')))
    const runtime = new HowManyRuntime(root, root, () => {}, { command: bundled.pathname })
    t.onTestFinished(async () => {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await execute('git', ['init', '--quiet', root])
    const files = {
      '.gitignore': 'ignored.cpp\n',
      'lakefile.toml': 'name = "fixture"\n',
      'main.lean': '/- Proof source. -/\ntheorem identity (p : Prop) (h : p) : p := h\n',
      'module.cppm': 'export module fixture;\nexport int value() { return 1; }\n',
      'native/CMakeLists.txt': 'project(fixture)\n',
      'native/CMakeCache.txt': '# Configured CMake build tree\n',
      'native/main.cpp': 'int main() { return 0; }\n',
      'tests/copied/upstream.js': '// Copyright upstream test authors\nassert(1 + 1 === 2);\n',
      'ignored.cpp': 'int ignored = 1;\n',
      'generated.c': '// Lean compiler output\n#include <lean/lean.h>\nint generated = 1;\n',
      'extracted.lean': '-- THIS FILE WAS AUTOMATICALLY GENERATED BY AENEAS\ndef generated := 1\n',
      'table.rs':
        '//! Entity names, generated by `examples/entity_table.rs` from\n//! `data/entities.csv`. Do not edit: run the generator.\npub const GENERATED: u8 = 1;\n',
      'native/cmake-build-debug/compiler.cpp': 'int compiler = 1;\n',
      'native/_deps/dependency-src/dependency.cpp': 'int dependency = 1;\n',
      'gn/BUILD.gn': 'group("fixture") {}\n',
      'gn/out/Debug/build.ninja': '# GN build output\n',
      'gn/out/Debug/args.gn': 'is_debug = true\n',
      'gn/out/Debug/gen/generated.cpp': 'int gn_output = 1;\n',
      '.lake/build/ir/Main.c': '#include <lean/lean.h>\nint lake_output = 1;\n',
      'lake-packages/dependency/Dependency.lean': 'def dependency := 1\n',
    }
    await Promise.all(
      Object.entries(files).map(async ([filename, contents]) => {
        const target = path.join(root, filename)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, contents)
      }),
    )
    const state = await runtime.analyze()
    assert.equal(state.status, 'ready', state.message)
    assert.ok(state.report?.source && state.report.breakdown)
    assert.equal(state.report.source.file_count, 4)
    assert.equal(state.report.source.code_lines, 5)
    const languages = state.report.breakdown.rows.filter(row => row.category === 'code')
    assert.equal(languages.find(row => row.language === 'Lean')?.file_count, 1)
    assert.equal(languages.find(row => row.language === 'C++')?.file_count, 2)
    assert.equal(languages.find(row => row.language === 'JavaScript')?.file_count, 1)
    const hidden = validateReport(
      JSON.parse(
        await runtime.run([
          root,
          '--output',
          'json',
          '--no-interactive',
          '--no-cache',
          '--no-detect',
          '--threads',
          '2',
          '--hidden',
        ]),
      ),
    )
    assert.deepEqual(hidden.source, state.report.source, 'hidden Lake output stays outside authored source totals')
  },
)

test.skipIf(!existsSync(bundled))(
  'bundled HowMany produces real counts, thresholds, config reloads and shuts down its LSP',
  async t => {
    const { root } = await fixture(t)
    /** @type {HowManyEvent[]} */
    const events = []
    const runtime = new HowManyRuntime(root, root, event => events.push(event), {
      command: bundled.pathname,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, '.config'),
        APPDATA: path.join(root, 'AppData'),
      },
    })
    t.onTestFinished(() => runtime.dispose())
    const config = path.join(
      root,
      process.platform === 'darwin'
        ? 'Library/Application Support/howmany/config.toml'
        : process.platform === 'win32'
          ? 'AppData/howmany/config.toml'
          : '.config/howmany/config.toml',
    )
    await mkdir(path.dirname(config), { recursive: true })
    await writeFile(config, '[lsp]\nmax_file_lines = 2\nmin_doc_ratio = 0\n')
    const filename = 'sample.py'
    const text = '# explanation\nx = 1\n\nprint(x)\n'
    await writeFile(path.join(root, filename), text)
    const counts = await runtime.file(filename, async () => text, 'initial')
    assert.equal(counts?.live, true)
    assert.match(counts?.title ?? '', /4 Python.*2 code.*1 comment.*1 blank/)
    await until(() =>
      events.some(
        event => event.type === 'file' && diagnostics(event.diagnostics).some(item => item.code === 'long-file'),
      ),
    )
    const report = await runtime.analyze()
    assert.equal(report.status, 'ready')
    assert.ok(report.report && report.report.basic.total_lines >= 4)
    const longer = `${text}print(x + 1)\n`
    await writeFile(path.join(root, filename), longer)
    const beforeLonger = events.length
    assert.match((await runtime.file(filename, async () => longer, 'longer'))?.title ?? '', /5 Python/)
    await until(() =>
      events
        .slice(beforeLonger)
        .some(
          event =>
            event.type === 'file' &&
            diagnostics(event.diagnostics).some(
              item => item.code === 'long-file' && typeof item.message === 'string' && /5 lines/.test(item.message),
            ),
        ),
    )
    assert.equal(
      events.slice(beforeLonger).some(event => event.type === 'file' && diagnostics(event.diagnostics).length === 0),
      false,
      'refreshing the active file keeps its existing warnings until replacements arrive',
    )
    const changed = '# explanation\nx = 1\n'
    await writeFile(path.join(root, filename), changed)
    const beforeShorter = events.length
    assert.match(
      (await runtime.file(filename, async () => changed, 'shorter'))?.title ?? '',
      /2 Python.*1 code.*1 comment/,
    )
    await until(() =>
      events.slice(beforeShorter).some(event => event.type === 'file' && diagnostics(event.diagnostics).length === 0),
    )
    await writeFile(config, '[lsp]\ncode_lens = false\nmax_file_lines = 0\nmin_doc_ratio = 0\n')
    assert.equal(
      (await runtime.file(filename, () => readFile(path.join(root, filename), 'utf8'), 'configured'))?.title,
      '',
    )
    await runtime.dispose()
    assert.equal(runtime.languages.servers.size, 0)
    assert.equal(runtime.processes.size, 0)
    assert.ok(discoverHowMany({ PATH: '' })?.includes('resources/howmany/howmany'))
  },
)
