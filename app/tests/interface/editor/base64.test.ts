import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vite-plus/test'

const encoded = 'AH+A/w=='
const decoded = [0, 127, 128, 255]

type Decoder = (source: string) => Uint8Array<ArrayBuffer>

async function loadDecoder(fromBase64?: Decoder) {
  class ByteArray extends Uint8Array {
    static fromBase64 = fromBase64
  }
  vi.stubGlobal('Uint8Array', ByteArray)
  vi.resetModules()
  return (await import('../../../renderer/editor/documents/base64.ts')).decodeBase64
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('uses a native decoder that rejects incomplete input', async () => {
  const nativeDecode = vi.fn<Decoder>(source => {
    if (source !== encoded) throw new SyntaxError('Invalid base64')
    return Uint8Array.from(decoded)
  })
  const decodeBase64 = await loadDecoder(nativeDecode)
  assert.deepEqual([...decodeBase64(encoded)], decoded)
  assert.throws(() => decodeBase64('A=='))
  assert.equal(nativeDecode.mock.calls[1]?.[0], encoded)
})

test('decodes binary input and rejects invalid base64 when the native API is absent', async () => {
  const decodeBase64 = await loadDecoder()
  assert.deepEqual([...decodeBase64(encoded)], decoded)
  assert.throws(() => decodeBase64('A=='))
})

test('uses the fallback when the native API accepts malformed base64', async () => {
  const legacyDecode = vi.fn<Decoder>(() => new Uint8Array(0))
  const decodeBase64 = await loadDecoder(legacyDecode)
  assert.deepEqual([...decodeBase64(encoded)], decoded)
  assert.throws(() => decodeBase64('A=='))
  assert.equal(legacyDecode.mock.calls.length, 1)
})
