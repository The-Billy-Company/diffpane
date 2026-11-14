/// <reference lib="webworker" />

import pixelmatch from 'pixelmatch'

declare const self: DedicatedWorkerGlobalScope

export interface ImageDiffSource {
  data: string
  mime: string
}
export type ImageDiffInput = [before: ImageDiffSource, after: ImageDiffSource]
export type ImageDiffResult = { bitmap: ImageBitmap; changed: number } | { message: string }

// Bound the canvas and pixel buffers while supporting 4K screenshots.
const MAX_PIXELS = 8_388_608
const MAX_DIMENSION = 8192

function decode({ data, mime }: ImageDiffSource) {
  const bytes = Uint8Array.from(atob(data), byte => byte.charCodeAt(0))
  return createImageBitmap(new Blob([bytes], { type: mime }))
}

async function compareImages([originalSource, workingSource]: ImageDiffInput): Promise<ImageDiffResult> {
  const before = await decode(originalSource)
  try {
    const { width, height } = before
    if (width * height > MAX_PIXELS || Math.max(width, height) > MAX_DIMENSION)
      return { message: 'Image resolution exceeds the pixel diff limit.' }

    const after = await decode(workingSource)
    try {
      if (after.width !== width || after.height !== height)
        return { message: 'Pixel diff requires matching image dimensions.' }

      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return { message: 'Pixel diff is unavailable.' }
      context.drawImage(before, 0, 0)
      const original = context.getImageData(0, 0, width, height)
      context.clearRect(0, 0, width, height)
      context.drawImage(after, 0, 0)
      const working = context.getImageData(0, 0, width, height)
      const output = context.createImageData(width, height)
      const changed = pixelmatch(original.data, working.data, output.data, width, height, {
        threshold: 0,
        includeAA: true,
        alpha: 0.26,
        diffColor: [219, 39, 119],
      })
      context.putImageData(output, 0, 0)
      return { bitmap: canvas.transferToImageBitmap(), changed }
    } finally {
      after.close()
    }
  } finally {
    before.close()
  }
}

async function respond(input: ImageDiffInput) {
  const result = await compareImages(input).catch((): ImageDiffResult => ({
    message: 'Pixel diff could not read these images.',
  }))
  self.postMessage(result, { transfer: 'bitmap' in result ? [result.bitmap] : [] })
}

self.addEventListener('message', ({ data }: MessageEvent<ImageDiffInput>) => {
  respond(data).catch(() => self.postMessage({ message: 'Pixel diff is unavailable.' }, []))
})
