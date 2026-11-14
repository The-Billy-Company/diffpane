import type WaveSurferPlayer from 'wavesurfer.js'
import './audio-waveform.css'

const MAX_WAVEFORM_SECONDS = 300
const WAVEFORM_SAMPLE_RATE = 8_000
const MAX_WAVEFORM_PEAKS = 4_096

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

export function showAudioPreview(host: ParentNode, url: string, label: string, onError: () => void, encoded?: string) {
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
  panel.append(track, audio)

  const listeners = new AbortController()
  const { signal } = listeners
  let waveform: WaveSurferPlayer | undefined
  let themeObserver: MutationObserver | undefined

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
    panel.remove()
  }

  function ink() {
    const color = getComputedStyle(track).color
    return { waveColor: color, progressColor: color, cursorColor: color }
  }

  async function drawWaveform(data: string) {
    const duration = audio.duration
    if (!(duration > 0 && duration <= MAX_WAVEFORM_SECONDS)) return
    try {
      const { default: WaveSurfer } = await import('wavesurfer.js')
      if (signal.aborted) return

      // Decode the bounded document bytes locally. The media element keeps its original playback source.
      const decoder = new OfflineAudioContext(1, 1, WAVEFORM_SAMPLE_RATE)
      const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0))
      const decoded = await decoder.decodeAudioData(bytes.buffer)
      if (signal.aborted) return
      const peaks = Array.from({ length: Math.min(decoded.numberOfChannels, 2) }, (_, channel) =>
        compactPeaks(decoded.getChannelData(channel)),
      )

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
      clearWaveform()
    }
  }

  if (encoded) {
    audio.addEventListener('loadedmetadata', () => void drawWaveform(encoded), { once: true, signal })
  }
  audio.addEventListener(
    'error',
    () => {
      dispose()
      onError()
    },
    { signal },
  )
  host.appendChild(panel)
  audio.src = url
  return dispose
}
