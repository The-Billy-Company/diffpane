import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, test, vi } from 'vite-plus/test'
import { LocalState } from '../../../backend/persistence/database/local-state.ts'
import { localStateKeys } from '../../../backend/persistence/database/secure-storage.mjs'
import { unwrapSecret, wrapSecret } from '../../../desktop/services/keychain.ts'

const native = vi.hoisted(() => ({ request: vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>() }))
vi.mock('../../../desktop/host/transport.ts', () => ({ hostRequest: native.request }))

const legacyPassword = 'fake-keychain-item-for-the-migration-test'

function makeLegacyEnvelope(plaintext: string) {
  const key = pbkdf2Sync(legacyPassword, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from('                '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plaintext, 'utf8'), cipher.final()])
}

beforeEach(() => {
  const items = new Map<string, unknown>()
  native.request.mockReset().mockImplementation(async (method, service, account, candidate) => {
    if (service === 'Diffpane Safe Storage' && account === 'Diffpane Key' && method === 'keychain.read')
      return Buffer.from(legacyPassword).toString('base64')
    const lookup = `${String(service)}:${String(account)}`
    if (method === 'keychain.create' && !items.has(lookup)) items.set(lookup, candidate)
    return items.get(lookup) ?? null
  })
})

test('new envelopes use separate authenticated keys and reject tampered records', async () => {
  const plaintext = 'test note text'
  const encrypted = await wrapSecret('Local state', plaintext)
  assert.equal(encrypted.includes(plaintext), false)
  assert.equal(await unwrapSecret('Local state', encrypted), plaintext)
  await wrapSecret('Claude credentials', 'test-api-credential')
  await assert.rejects(unwrapSecret('Claude credentials', encrypted))
  encrypted.writeUInt8(encrypted.readUInt8(15) ^ 1, 15)
  await assert.rejects(unwrapSecret('Local state', encrypted))
})

test('the Tauri adapter reopens a database with an Electron Safe Storage key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'diffpane-keychain-upgrade-'))
  const filename = path.join(directory, 'local.sqlite')
  const previous = new LocalState(filename, {
    wrap: key => Promise.resolve(makeLegacyEnvelope(key)),
    unwrap: blob => unwrapSecret('Local state', blob),
  })
  const next = new LocalState(filename, localStateKeys)
  try {
    await previous.write(records => records.put('ideas', '/workspace', 'first', { title: 'A saved idea' }))
    previous.close()
    assert.deepEqual(await next.read(records => records.get('ideas', '/workspace', 'first')), { title: 'A saved idea' })
    assert.equal(
      await unwrapSecret('Claude credentials', makeLegacyEnvelope('test-api-credential')),
      'test-api-credential',
    )
    assert.equal(
      native.request.mock.calls.some(([method]) => method === 'keychain.create'),
      false,
    )
  } finally {
    previous.close()
    next.close()
    await rm(directory, { recursive: true, force: true })
  }
})
