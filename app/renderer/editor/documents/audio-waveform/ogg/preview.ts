// Copyright (c) 2026 The Billy Company
import type { DecodedPreview } from './wave.ts'

const decoderTimeoutMs = 15_000

export async function prepareOggPlayback(encoded: string, signal: AbortSignal): Promise<DecodedPreview | null> {
  if (signal.aborted) return null
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let cancel: (() => void) | undefined
  let timeout: number | undefined
  try {
    return await new Promise(resolve => {
      cancel = () => resolve(null)
      signal.addEventListener('abort', cancel, { once: true })
      timeout = window.setTimeout(cancel, decoderTimeoutMs)
      worker.addEventListener('error', cancel, { once: true })
      worker.addEventListener('messageerror', cancel, { once: true })
      worker.addEventListener('message', ({ data }: MessageEvent<DecodedPreview | null>) => resolve(data), {
        once: true,
      })
      worker.postMessage(encoded, [])
    })
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel)
    clearTimeout(timeout)
    worker.terminate()
  }
}
