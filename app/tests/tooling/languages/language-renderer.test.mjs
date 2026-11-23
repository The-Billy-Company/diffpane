// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { createLanguageFeatures } from '../../../renderer/editor/languages/languages.js'

vi.mock('monaco-editor/editor/contrib/folding/browser/folding.js', () => ({}))
vi.mock('monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js', () => ({}))
vi.mock('monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js', () => ({}))
vi.mock('monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js', () => ({}))

/**
 * @import { TestContext } from 'vite-plus/test'
 * @import { LanguageBridge, LanguageEditor, LanguageModel, LanguageMonaco, LanguageOpenInput, LanguageStateNotice, SemanticTokensModel, SemanticTokensProvider } from '../../../renderer/editor/languages/languages.js'
 * @import { CancellationToken, editor } from 'monaco-editor'
 */

class FoldingRangeKind {
  static Comment = new FoldingRangeKind('comment')
  static Imports = new FoldingRangeKind('imports')
  static Region = new FoldingRangeKind('region')
  /** @param {string} value */
  constructor(value) {
    this.value = value
  }
  /** @param {string} value */
  static fromValue(value) {
    return new FoldingRangeKind(value)
  }
}

/**
 * @param {TestContext} t
 * @param {LanguageBridge['open']} open
 * @param {LanguageBridge['request']} request
 * @param {{ language?: string }} [options]
 */
function fixture(t, open, request, { language = 'typescript' } = {}) {
  const disposed = { dispose() {} }
  /** @type {LanguageStateNotice[]} */
  const events = []
  /** @type {editor.IMarkerData[][]} */
  const markers = []
  /** @type {string[]} */
  const canceled = []
  /** @type {((value: unknown) => void) | undefined} */
  let receive
  /** @type {SemanticTokensProvider | undefined} */
  let semanticProvider
  const filename = 'example.ts'
  /** @type {LanguageModel & SemanticTokensModel} */
  const model = {
    uri: { toString: () => `file:///${filename}` },
    getLanguageId: () => language,
    getVersionId: () => 1,
    getValue: () => 'const example = 1;',
    getLineCount: () => 1,
    getLineMaxColumn: () => 19,
    validateRange: range => range,
    onDidChangeContent: () => disposed,
    onDidChangeLanguage: () => disposed,
    onWillDispose: () => disposed,
    isDisposed: () => false,
  }
  /** @type {LanguageEditor} */
  const codeEditor = {
    getDomNode: () => null,
    updateOptions() {},
    onDidFocusEditorText: () => disposed,
  }
  /** @type {LanguageMonaco<LanguageModel>} */
  const monaco = {
    languages: {
      registerHoverProvider: () => disposed,
      registerDocumentSymbolProvider: () => disposed,
      registerFoldingRangeProvider: () => disposed,
      registerDocumentSemanticTokensProvider: (_selector, provider) => {
        semanticProvider = provider
        return disposed
      },
      registerDocumentRangeSemanticTokensProvider: () => disposed,
      registerInlayHintsProvider: () => disposed,
      FoldingRangeKind,
    },
    editor: {
      setModelMarkers(_model, _owner, values) {
        markers.push(values)
      },
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: {
      parse() {
        return assert.fail('Unexpected related diagnostic URI')
      },
    },
  }
  const features = createLanguageFeatures(
    monaco,
    {
      language: {
        open,
        request,
        close: async () => {},
        cancel: async id => {
          canceled.push(id)
        },
        onEvent: listener => {
          receive = listener
          return () => {
            receive = undefined
          }
        },
      },
    },
    {
      onState: state => {
        events.push(state)
      },
    },
  )
  features.attach(codeEditor, model, filename)
  t.onTestFinished(() => features.dispose())
  return {
    symbols: () => features.symbols(filename),
    /** @param {string | null} lastResultId */
    semanticTokens: (lastResultId = null) => {
      assert.ok(semanticProvider)
      /** @type {CancellationToken} */
      const token = { isCancellationRequested: false, onCancellationRequested: () => disposed }
      return semanticProvider.provideDocumentSemanticTokens(model, lastResultId, token)
    },
    /** @this {void} @param {Record<string, unknown>} event */
    receive(event) {
      assert.ok(receive)
      receive({ path: filename, language: 'typescript', ...event })
    },
    events,
    markers,
    canceled,
  }
}

test('concurrent features share an unavailable open attempt and a later request retries', async t => {
  let opens = 0
  const { symbols } = fixture(
    t,
    async () => ({ available: ++opens > 1 }),
    async () => [],
  )
  await Promise.all([symbols(), symbols(), symbols()])
  assert.equal(opens, 1)
  assert.deepEqual(await symbols(), [])
  assert.equal(opens, 2)
})

test('TOML models use syntax without opening a language server', async t => {
  const { symbols } = fixture(
    t,
    async () => {
      throw new Error('Unexpected language server')
    },
    async () => {
      throw new Error('Unexpected language request')
    },
    {
      language: 'toml',
    },
  )
  assert.deepEqual(await symbols(), [])
})

test('TSX documents use the TypeScript server with their own language ID', async t => {
  /** @type {LanguageOpenInput[]} */
  const opens = []
  const { symbols } = fixture(
    t,
    async input => {
      opens.push(input)
      return { available: true, capabilities: { documentSymbolProvider: true } }
    },
    async () => [],
    { language: 'tsx' },
  )
  assert.deepEqual(await symbols(), [])
  assert.equal(opens[0]?.language, 'typescript')
  assert.equal(opens[0]?.languageId, 'typescriptreact')
})

test('a server refresh during document open fetches the new capabilities', async t => {
  const started = Promise.withResolvers()
  /** @type {PromiseWithResolvers<unknown>} */
  const first = Promise.withResolvers()
  let opens = 0
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  const { symbols, receive } = fixture(
    t,
    async () => {
      if (++opens === 1) {
        started.resolve(undefined)
        return first.promise
      }
      return { available: true, capabilities: { documentSymbolProvider: true } }
    },
    async () => [{ name: 'enabled', range }],
  )

  const opening = symbols()
  await started.promise
  receive({ type: 'refresh' })
  const refreshed = symbols()
  first.resolve({ available: true, capabilities: {} })

  assert.deepEqual(await opening, [])
  assert.equal((await refreshed)[0]?.name, 'enabled')
  assert.equal(opens, 2)
})

test('a refresh cancels replaced semantic tokens without returning the language to starting', async t => {
  const started = Promise.withResolvers()
  const first = Promise.withResolvers()
  const legend = { tokenTypes: ['namespace'], tokenModifiers: [] }
  let requests = 0
  let removeCapability = false
  const { semanticTokens, receive, events } = fixture(
    t,
    async () => ({
      available: true,
      capabilities: removeCapability ? {} : { semanticTokensProvider: { full: { delta: true }, legend } },
    }),
    async () => {
      if (++requests === 1) {
        started.resolve(undefined)
        return first.promise
      }
      if (requests === 3) return null
      return { data: requests === 4 ? [] : [0, 0, 5, 0, 0] }
    },
  )

  const pending = semanticTokens()
  await started.promise
  const settledBeforeRefresh = events.length
  receive({ type: 'refresh' })
  first.resolve(null)
  await assert.rejects(Promise.resolve(pending), { name: 'Canceled' })
  assert.ok(events.slice(settledBeforeRefresh).every(event => event.status === 'ready'))
  const tokens = await semanticTokens()
  assert.deepEqual(tokens?.data, Uint32Array.of(0, 0, 5, 0, 0))
  assert.ok(tokens?.resultId)
  receive({ type: 'refresh' })
  await assert.rejects(Promise.resolve(semanticTokens(tokens.resultId)), { name: 'Canceled' })
  assert.deepEqual((await semanticTokens(tokens.resultId))?.data, new Uint32Array())
  removeCapability = true
  receive({ type: 'refresh' })
  assert.equal(await semanticTokens(tokens.resultId), null)
})

test('server failure drops cached and pending results and clears language diagnostics', async t => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  let requests = 0
  /** @type {(() => void) | undefined} */
  let finish
  const { symbols, receive, events, markers, canceled } = fixture(
    t,
    async () => ({ available: true, capabilities: { documentSymbolProvider: true } }),
    async ({ requestId }) => {
      requests++
      if (requests === 2)
        return new Promise(resolve => {
          finish = () => resolve([{ name: requestId, range }])
        })
      return [{ name: `symbol${requests}`, range }]
    },
  )
  assert.equal((await symbols())[0]?.name, 'symbol1')
  receive({ type: 'diagnostics', diagnostics: [{ message: 'issue', range }] })
  assert.equal(markers.at(-1)?.length, 1)
  receive({ type: 'status', status: 'available' })
  assert.deepEqual(markers.at(-1), [])
  assert.equal(events.at(-1)?.diagnostics, 0)
  const pending = symbols()
  await vi.waitFor(() => assert.equal(requests, 2))
  receive({ type: 'status', status: 'error' })
  if (!finish) throw new Error('Language request did not start')
  finish()
  assert.deepEqual(await pending, [])
  assert.equal(canceled.length, 1)
  receive({ type: 'diagnostics', language: 'python', diagnostics: [{ message: 'old', range }] })
  assert.deepEqual(markers.at(-1), [])
  assert.equal((await symbols())[0]?.name, 'symbol3')
})
