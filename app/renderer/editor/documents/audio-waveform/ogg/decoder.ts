import { MAX_AUDIO_WAVEFORM_BYTES } from '../../../../../shared/documents/media-types.ts'
import type { DecodedPreview, OggFormat } from './wave.ts'
import { createWaveWriter, MAX_PCM_BYTES } from './wave.ts'

interface OggPage {
  start: number
  packet: number
  end: number
  flags: number
  serial: number
  sequence: number
  granule: bigint
}

function* pages(bytes: Uint8Array<ArrayBuffer>): Generator<OggPage> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let start = 0; start < bytes.length;) {
    if (start + 27 > bytes.length || view.getUint32(start) !== 0x4f676753 || bytes[start + 4] !== 0) {
      throw new Error('The Ogg page header is invalid.')
    }
    const packet = start + 27 + (bytes[start + 26] ?? 0)
    let end = packet
    for (let offset = start + 27; offset < packet; offset++) end += bytes[offset] ?? 0
    if (end > bytes.length) throw new Error('The Ogg page is incomplete.')
    yield {
      start,
      packet,
      end,
      flags: bytes[start + 5] ?? 0,
      serial: view.getUint32(start + 14, true),
      sequence: view.getUint32(start + 18, true),
      granule: view.getBigInt64(start + 6, true),
    }
    start = end
  }
}

function streamFormat(bytes: Uint8Array<ArrayBuffer>): OggFormat {
  let header: OggPage | undefined
  let last: OggPage | undefined
  for (const page of pages(bytes)) {
    if (page.sequence !== (last ? last.sequence + 1 : 0)) throw new Error('The Ogg page sequence is invalid.')
    if (!header) header = page
    else if (page.flags & 2 || page.serial !== header.serial || (last?.flags ?? 0) & 4) {
      throw new Error('The audio preview requires a single Ogg stream.')
    }
    last = page
  }
  if (!header || !(header.flags & 2) || !last || !(last.flags & 4) || last.granule < 1) {
    throw new Error('The Ogg audio is incomplete.')
  }

  const id = bytes.subarray(header.packet, header.end)
  const view = new DataView(id.buffer, id.byteOffset, id.byteLength)
  let codec: OggFormat['codec']
  let channels: number
  let sampleRate: number
  let frames = Number(last.granule)
  if (id.length >= 19 && view.getUint32(0) === 0x4f707573 && view.getUint32(4) === 0x48656164) {
    codec = 'opus'
    channels = view.getUint8(9)
    sampleRate = 48_000
    frames -= view.getUint16(10, true)
    if (channels > 2 && view.getUint8(18) !== 1) throw new Error('This Opus channel layout is unsupported.')
  } else if (
    id.length >= 30 &&
    view.getUint32(0) === 0x01766f72 &&
    id[4] === 0x62 &&
    id[5] === 0x69 &&
    id[6] === 0x73
  ) {
    codec = 'vorbis'
    channels = view.getUint8(11)
    sampleRate = view.getUint32(12, true)
  } else {
    throw new Error('The Ogg audio codec is unsupported.')
  }
  if (
    channels < 1 ||
    channels > 8 ||
    sampleRate < 1 ||
    sampleRate > 384_000 ||
    frames < 1 ||
    frames * channels * 2 > MAX_PCM_BYTES
  ) {
    throw new Error('The Ogg audio exceeds its preview budget.')
  }
  return { codec, channels, sampleRate, frames }
}

async function openDecoder(codec: OggFormat['codec']) {
  if (codec === 'opus') {
    const { decoder } = await import('@audio/decode-opus')
    return decoder()
  }
  const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis')
  const decoder = new OggVorbisDecoder()
  await decoder.ready
  return decoder
}

export async function decodeOggPreview(encoded: string): Promise<DecodedPreview> {
  if (encoded.length > Math.ceil(MAX_AUDIO_WAVEFORM_BYTES / 3) * 4) {
    throw new Error('The Ogg audio exceeds its preview budget.')
  }
  const bytes = Uint8Array.from(atob(encoded), byte => byte.charCodeAt(0))
  if (bytes.length > MAX_AUDIO_WAVEFORM_BYTES) throw new Error('The Ogg audio exceeds its preview budget.')
  const format = streamFormat(bytes)
  const writer = createWaveWriter(format)
  const decoder = await openDecoder(format.codec)
  try {
    // At most one page per call bounds temporary, expanded float samples before they reach the writer.
    for (const { start, end } of pages(bytes)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The decoder consumes one ordered Ogg stream.
      const decoded = await decoder.decode(bytes.subarray(start, end))
      writer.write(decoded.channelData, decoded.sampleRate)
    }
    const tail = await decoder.flush()
    writer.write(tail.channelData, tail.sampleRate)
    return writer.finish()
  } finally {
    decoder.free()
  }
}
