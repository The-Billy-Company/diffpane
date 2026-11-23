// Copyright (c) 2026 The Billy Company
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { hostRequest } from '../host/transport.ts'

const derive = promisify(pbkdf2)
const service = 'com.diffpane.app.secure-storage'
const currentFormat = Buffer.from('dp01')
const legacyFormat = Buffer.from('v10')
const utf8 = new TextDecoder('utf-8', { fatal: true })

type Purpose = 'Local state' | 'Claude credentials'

async function keychainRead(keychainService: string, account: string) {
  const data = await hostRequest('keychain.read', keychainService, account)
  if (data === null) return null
  if (typeof data !== 'string') throw new Error('The macOS Keychain returned an invalid item.')
  return Buffer.from(data, 'base64')
}

async function key(purpose: Purpose, create: boolean) {
  const stored = await keychainRead(service, purpose)
  if (stored) {
    if (stored.length !== 32) throw new Error('The Diffpane Keychain item is invalid.')
    return stored
  }
  if (!create) throw new Error('The Diffpane Keychain item is missing.')
  const candidate = randomBytes(32)
  try {
    const result = await hostRequest('keychain.create', service, purpose, candidate.toString('base64'))
    if (typeof result !== 'string') throw new Error('Could not create a Diffpane Keychain item.')
    const data = Buffer.from(result, 'base64')
    if (data.length !== 32) throw new Error('The Diffpane Keychain item is invalid.')
    return data
  } finally {
    candidate.fill(0)
  }
}

export async function keychainAvailable(purpose: Purpose) {
  if (process.platform !== 'darwin') return false
  try {
    const data = await keychainRead(service, purpose)
    data?.fill(0)
    return true
  } catch {
    return false
  }
}

export async function wrapSecret(purpose: Purpose, secret: string) {
  const material = await key(purpose, true)
  try {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', material, nonce)
    cipher.setAAD(Buffer.from(`${service}:${purpose}`))
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return Buffer.concat([currentFormat, nonce, cipher.getAuthTag(), ciphertext])
  } finally {
    material.fill(0)
  }
}

export async function unwrapSecret(purpose: Purpose, envelope: Buffer) {
  if (envelope.subarray(0, legacyFormat.length).equals(legacyFormat)) {
    const password = await keychainRead('Diffpane Safe Storage', 'Diffpane Key')
    if (!password?.length) throw new Error('The Diffpane Safe Storage item is missing from Keychain.')
    try {
      return await openLegacySecret(envelope, password)
    } finally {
      password.fill(0)
    }
  }
  const nonceOffset = currentFormat.length
  const tagOffset = nonceOffset + 12
  const contentOffset = tagOffset + 16
  if (envelope.length <= contentOffset || !envelope.subarray(0, nonceOffset).equals(currentFormat))
    throw new Error('This Diffpane encrypted value has an unknown format.')
  const material = await key(purpose, false)
  try {
    const decipher = createDecipheriv('aes-256-gcm', material, envelope.subarray(nonceOffset, tagOffset))
    decipher.setAAD(Buffer.from(`${service}:${purpose}`))
    decipher.setAuthTag(envelope.subarray(tagOffset, contentOffset))
    return utf8.decode(Buffer.concat([decipher.update(envelope.subarray(contentOffset)), decipher.final()]))
  } finally {
    material.fill(0)
  }
}

/** Read the macOS v10 envelope used by older Diffpane profiles. */
export async function openLegacySecret(envelope: Buffer, password: Buffer) {
  const ciphertext = envelope.subarray(legacyFormat.length)
  if (!envelope.subarray(0, legacyFormat.length).equals(legacyFormat) || !ciphertext.length || ciphertext.length % 16)
    throw new Error('This Diffpane encrypted value is invalid.')
  const material = await derive(password, 'saltysalt', 1003, 16, 'sha1')
  try {
    const decipher = createDecipheriv('aes-128-cbc', material, Buffer.alloc(16, 0x20))
    return utf8.decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } finally {
    material.fill(0)
  }
}
