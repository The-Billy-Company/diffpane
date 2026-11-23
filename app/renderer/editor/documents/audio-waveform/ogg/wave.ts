// Copyright (c) 2026 The Billy Company
import { MAX_WAVEFORM_PEAKS, MAX_WAVEFORM_SECONDS } from '../../../../../shared/documents/media-types.ts'

const bytesPerSample = 2
const pcmFormat = 1
const extensibleFormat = 0xfffe
const pcmSubformat = Uint8Array.of(1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71)
const speakerMasks = [0, 0, 0, 0x7, 0x33, 0x37, 0x3f, 0x70f, 0x63f]
const vorbisOrders = new Map<number, number[]>([
  [3, [0, 2, 1]],
  [5, [0, 2, 1, 3, 4]],
  [6, [0, 2, 1, 5, 3, 4]],
  [7, [0, 2, 1, 6, 5, 3, 4]],
  [8, [0, 2, 1, 7, 5, 6, 3, 4]],
])
export const MAX_PCM_BYTES = 64 * 1024 * 1024

export interface DecodedPreview {
  blob: Blob
  peaks: Float32Array<ArrayBuffer>[]
}

export interface OggFormat {
  codec: 'opus' | 'vorbis'
  channels: number
  sampleRate: number
  frames: number
}

function waveHeader(channels: number, sampleRate: number, byteLength: number) {
  const extensible = channels > 2
  const formatLength = extensible ? 40 : 16
  const dataOffset = 20 + formatLength
  const bytes = new ArrayBuffer(dataOffset + 8)
  const header = new DataView(bytes)
  const blockSize = channels * bytesPerSample
  header.setUint32(0, 0x52494646) // RIFF
  header.setUint32(4, bytes.byteLength - 8 + byteLength, true)
  header.setUint32(8, 0x57415645) // WAVE
  header.setUint32(12, 0x666d7420) // fmt
  header.setUint32(16, formatLength, true)
  header.setUint16(20, extensible ? extensibleFormat : pcmFormat, true)
  header.setUint16(22, channels, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * blockSize, true)
  header.setUint16(32, blockSize, true)
  header.setUint16(34, 16, true)
  if (extensible) {
    header.setUint16(36, 22, true)
    header.setUint16(38, 16, true)
    header.setUint32(40, speakerMasks[channels] ?? 0, true)
    new Uint8Array(bytes, 44, 16).set(pcmSubformat)
  }
  header.setUint32(dataOffset, 0x64617461) // data
  header.setUint32(dataOffset + 4, byteLength, true)
  return bytes
}

export function createWaveWriter(format: OggFormat) {
  const { codec, channels, sampleRate, frames } = format
  const chunks: Blob[] = []
  const channelOrder =
    (codec === 'vorbis' ? vorbisOrders.get(channels) : undefined) ??
    Array.from({ length: channels }, (_, index) => index)
  const peakCount = frames <= MAX_WAVEFORM_SECONDS * sampleRate ? Math.min(frames, MAX_WAVEFORM_PEAKS) : 0
  const peaks = peakCount ? Array.from({ length: Math.min(channels, 2) }, () => new Float32Array(peakCount)) : []
  let writtenBytes = 0
  let writtenFrames = 0

  return {
    write(channelData: readonly Float32Array[], rate: number) {
      const count = channelData[0]?.length ?? 0
      if (!count) return
      if (rate !== sampleRate || channelData.length !== channels || channelData.some(data => data.length !== count)) {
        throw new Error('The Ogg audio format changed while decoding.')
      }
      const length = count * channels * bytesPerSample
      if (writtenBytes + length > MAX_PCM_BYTES) throw new Error('The decoded preview exceeds its audio budget.')
      const bytes = new ArrayBuffer(length)
      const pcm = new DataView(bytes)
      for (let frame = 0; frame < count; frame++) {
        const peakIndex = Math.min(peakCount - 1, Math.floor(((writtenFrames + frame) * peakCount) / frames))
        for (let channel = 0; channel < channels; channel++) {
          const source = channelOrder[channel] ?? channel
          const sample = channelData[source]?.[frame] ?? 0
          const amplitude = Math.max(-1, Math.min(1, sample))
          const signed = Math.round(amplitude * (amplitude < 0 ? 0x8000 : 0x7fff))
          pcm.setInt16((frame * channels + channel) * bytesPerSample, signed, true)
          const channelPeaks = peaks[channel]
          if (channelPeaks) channelPeaks[peakIndex] = Math.max(channelPeaks[peakIndex] ?? 0, Math.abs(amplitude))
        }
      }
      chunks.push(new Blob([bytes]))
      writtenBytes += length
      writtenFrames += count
    },
    finish(): DecodedPreview {
      if (!writtenBytes) throw new Error('The Ogg file contains no decodable audio.')
      const header = waveHeader(channels, sampleRate, writtenBytes)
      return {
        blob: new Blob([header, ...chunks], { type: 'audio/wav' }),
        peaks: writtenFrames === frames ? peaks : [],
      }
    },
  }
}
