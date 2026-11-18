import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vite-plus/test'
import { decodeOggPreview } from '../../../renderer/editor/documents/audio-waveform/ogg/decoder.ts'
import { isWorkspaceMediaUrl, mediaType } from '../../../shared/documents/media-types.ts'

test('workspace media types are explicit and case insensitive', () => {
  assert.equal(mediaType('photo.PNG'), 'image/png')
  assert.equal(mediaType('animation.apng'), 'image/apng')
  assert.equal(mediaType('photo.jfif'), 'image/jpeg')
  assert.equal(mediaType('animation.gif'), 'image/gif')
  assert.equal(mediaType('notes.md'), null)
  assert.equal(mediaType('png'), null)
  assert.equal(mediaType('file.constructor'), null)
})

test('workspace media accepts the backend revision and rejects unrelated URL parameters', () => {
  const mediaUrl =
    'http://127.0.0.1:49152/media/workspace-7/53ae5355-431c-46b8-8306-8ced6501ff09/assets%2Fspace%20%23%20%E9%9B%AA.png'
  assert.equal(isWorkspaceMediaUrl(mediaUrl), true)
  assert.equal(isWorkspaceMediaUrl(`${mediaUrl}?v=23`), true)
  for (const suffix of ['?q=23', '?v=', '?v=0', '?v=-1', '?v=23.1', '?v=23&v=24', '?v=%32', '#image']) {
    assert.equal(isWorkspaceMediaUrl(`${mediaUrl}${suffix}`), false, suffix)
  }
  assert.equal(isWorkspaceMediaUrl(mediaUrl.replace('127.0.0.1', 'localhost')), false)
  assert.equal(isWorkspaceMediaUrl(mediaUrl.replace('/media/', '/other/')), false)
})

test.each([
  { filename: 'opus.ogg', channels: 1, sampleRate: 48_000 },
  { filename: 'vorbis.ogg', channels: 2, sampleRate: 44_100 },
])('decodes $filename to a seekable WAVE preview with peaks', async ({ filename, channels, sampleRate }) => {
  const source = await readFile(new URL(`./fixtures/${filename}`, import.meta.url))
  const { blob, peaks } = await decodeOggPreview(source.toString('base64'))
  const pcm = Buffer.from(await blob.arrayBuffer())

  assert.equal(blob.type, 'audio/wav')
  assert.equal(pcm.toString('ascii', 0, 4), 'RIFF')
  assert.equal(pcm.readUInt32LE(4), pcm.length - 8)
  assert.equal(pcm.readUInt16LE(22), channels)
  assert.equal(pcm.readUInt32LE(24), sampleRate)
  assert.equal(pcm.readUInt32LE(40), pcm.length - 44)
  assert.ok(pcm.subarray(44).some(sample => sample !== 0))
  assert.equal(peaks.length, channels)
  assert.ok(peaks.every(channel => channel.some(peak => peak > 0)))
})

test('rejects malformed streams and compressed files that would exceed the PCM budget', async () => {
  const source = await readFile(new URL('./fixtures/opus.ogg', import.meta.url))
  const lastPage = source.lastIndexOf('OggS')
  assert.ok(lastPage > 0)
  const truncated = source.subarray(0, source.length - 1)
  await assert.rejects(decodeOggPreview(truncated.toString('base64')), /incomplete/)
  source.writeBigUInt64LE(100_000_000n, lastPage + 6)
  await assert.rejects(decodeOggPreview(source.toString('base64')), /preview budget/)
})
