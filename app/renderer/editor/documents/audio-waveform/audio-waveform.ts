// Copyright (c) 2026 The Billy Company
import type WaveSurferPlayer from 'wavesurfer.js'
import { MAX_WAVEFORM_PEAKS, MAX_WAVEFORM_SECONDS } from '../../../../shared/documents/media-types.ts'
import { decodeBase64 } from '../base64.ts'
import { prepareOggPlayback } from './ogg/preview.ts'
import './audio-waveform.css'

const WAVEFORM_SAMPLE_RATE = 8_000

function compactPeaks(samples: Float32Array) {
  if (samples.length <= MAX_WAVEFORM_PEAKS) return samples

  const peaks = new Float32Array(MAX_WAVEFORM_PEAKS)
  for (let index = 0, start = 0; index < peaks.length; index++) {
    const end = Math.floor(((index + 1) * samples.length) / peaks.length)
    let peak = 0
    for (let sample = start; sample < end; sample++) {
      peak = Math.max(peak, Math.abs(samples[sample] ?? 0))
    }
    peaks[index] = peak
    start = end
  }
  return peaks
}

interface AudioSource {
  url: string
  type: string
  encoded?: string
}

export function showAudioPreview(
  host: ParentNode,
  { url, type, encoded }: AudioSource,
  label: string,
  onError: () => void,
) {
  const panel = document.createElement('div')
  panel.className = 'audio-preview'
  const track = document.createElement('div')
  track.className = 'audio-waveform'
  track.hidden = true
  track.setAttribute('aria-hidden', 'true')
  track.title = 'Click or drag to seek'
  const audio = document.createElement('audio')
  audio.controls = true
  audio.preload = 'metadata'
  audio.setAttribute('aria-label', label)
  const status = document.createElement('p')
  status.hidden = true
  status.setAttribute('role', 'status')
  status.textContent = 'Preparing audio preview…'
  panel.append(track, audio, status)

  const listeners = new AbortController()
  const { signal } = listeners
  let waveform: WaveSurferPlayer | undefined
  let themeObserver: MutationObserver | undefined
  let fallbackAttempted = false
  let decoding = false
  let decodedUrl: string | undefined
  let decodedPeaks: Float32Array<ArrayBuffer>[] | undefined

  function clearWaveform() {
    themeObserver?.disconnect()
    themeObserver = undefined
    waveform?.destroy()
    waveform = undefined
    track.hidden = true
  }

  function dispose() {
    if (signal.aborted) return
    listeners.abort()
    clearWaveform()
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (decodedUrl) URL.revokeObjectURL(decodedUrl)
    panel.remove()
  }

  function ink() {
    const color = getComputedStyle(track).color
    return { waveColor: color, progressColor: color, cursorColor: color }
  }

  async function drawWaveform(data: string) {
    const source = audio.src
    const duration = audio.duration
    if (!(duration > 0 && duration <= MAX_WAVEFORM_SECONDS)) return
    try {
      const { default: WaveSurfer } = await import('wavesurfer.js')
      if (signal.aborted) return
      const peaks = decodedPeaks ?? (await decodeWaveform(data))
      if (signal.aborted || audio.src !== source || !peaks.length) return

      clearWaveform()
      track.hidden = false
      waveform = WaveSurfer.create({
        container: track,
        media: audio,
        peaks,
        duration,
        height: 80,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        barMinHeight: 2,
        dragToSeek: true,
        ...ink(),
      })
      waveform.once('error', clearWaveform)
      themeObserver = new MutationObserver(() => waveform?.setOptions(ink()))
      themeObserver.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    } catch {
      // Playback can still work when waveform decoding is unavailable.
      if (audio.src === source) clearWaveform()
    }
  }

  function failed() {
    dispose()
    onError()
  }

  async function recoverPlayback() {
    if (signal.aborted || decoding) return
    if (fallbackAttempted || type !== 'audio/ogg' || !encoded) {
      failed()
      return
    }
    fallbackAttempted = true
    decoding = true
    clearWaveform()
    status.hidden = false
    audio.hidden = true
    try {
      const result = await prepareOggPlayback(encoded, signal)
      if (signal.aborted) return
      if (!result) throw new Error('The Ogg audio preview could not be prepared.')
      decodedUrl = URL.createObjectURL(result.blob)
      decodedPeaks = result.peaks
      audio.src = decodedUrl
      status.hidden = true
      audio.hidden = false
    } finally {
      decoding = false
    }
  }

  function recoverOrFail() {
    recoverPlayback().catch(() => {
      if (!signal.aborted) failed()
    })
  }

  if (encoded) {
    audio.addEventListener('loadedmetadata', () => void drawWaveform(encoded), { signal })
  }
  audio.addEventListener('error', recoverOrFail, { signal })
  host.appendChild(panel)
  if (type === 'audio/ogg' && encoded && !audio.canPlayType(type)) recoverOrFail()
  else audio.src = url
  return dispose
}

async function decodeWaveform(data: string) {
  // Keep native playback on its original stream while calculating peaks from bounded document bytes.
  const encoder = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE)
  const bytes = decodeBase64(data)
  const decoded = await encoder.decodeAudioData(bytes.buffer)
  return Array.from({ length: Math.min(decoded.numberOfChannels, 2) }, (_, channel) =>
    compactPeaks(decoded.getChannelData(channel)),
  )
}
