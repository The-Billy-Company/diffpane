// Copyright (c) 2026 The Billy Company
import type { FileContent } from '../../../../backend/workspace/documents/file-content.ts'
import { isPixelDiffImage, MAX_PIXEL_DIFF_IMAGE_BYTES } from '../../../../shared/documents/media-types.ts'
import type { ImageDiffInput, ImageDiffResult, ImageDiffSource } from './image-diff-worker.ts'

function pixelSource(value: FileContent): ImageDiffSource | undefined {
  if (
    value.kind === 'image' &&
    value.data &&
    value.size <= MAX_PIXEL_DIFF_IMAGE_BYTES &&
    isPixelDiffImage(value.mime)
  ) {
    const { data, mime } = value
    return { data, mime }
  }
  return undefined
}

/** Adds an on-demand comparison to a pair of native image previews. */
export function createImageDiff(
  before: FileContent,
  after: FileContent,
  panes: HTMLElement,
  status: HTMLElement,
  onActivate: () => void,
) {
  const original = pixelSource(before)
  const working = pixelSource(after)
  if (!original || !working) return null

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'preview-toggle'
  button.textContent = 'Pixel diff'
  button.setAttribute('aria-pressed', 'false')
  const view = document.createElement('div')
  view.className = 'preview-image-diff media-preview'
  view.hidden = true
  const zoom = document.createElement('button')
  zoom.type = 'button'
  zoom.className = 'media-image-toggle'
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 0
  canvas.className = 'media-content'
  canvas.setAttribute('role', 'img')
  zoom.append(canvas)
  view.append(zoom)
  let worker: Worker | undefined

  function setZoom(actualSize: boolean) {
    view.classList.toggle('media-actual-size', actualSize)
    zoom.setAttribute('aria-label', actualSize ? 'Fit pixel diff to view' : 'View pixel diff at actual size')
    zoom.setAttribute('aria-pressed', String(actualSize))
  }
  zoom.addEventListener('click', () => setZoom(!view.classList.contains('media-actual-size')))

  function stopWorker() {
    worker?.terminate()
    worker = undefined
  }

  function reset(message = '') {
    stopWorker()
    canvas.width = canvas.height = 0
    setZoom(false)
    button.setAttribute('aria-pressed', 'false')
    view.hidden = true
    panes.hidden = false
    status.textContent = message
  }

  function showResult({ bitmap, changed }: Extract<ImageDiffResult, { bitmap: ImageBitmap }>) {
    const { width, height } = bitmap
    const context = canvas.getContext('bitmaprenderer')
    if (!context) {
      bitmap.close()
      reset('Pixel diff is unavailable.')
      return
    }
    canvas.width = width
    canvas.height = height
    context.transferFromImageBitmap(bitmap)
    const summary = `${changed.toLocaleString()} of ${(width * height).toLocaleString()} pixels changed`
    status.textContent = summary
    canvas.setAttribute('aria-label', `Pixel diff, ${width} × ${height}. ${summary}.`)
    panes.hidden = true
    view.hidden = false
  }

  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') {
      reset()
      return
    }
    onActivate()
    button.setAttribute('aria-pressed', 'true')
    status.textContent = 'Comparing pixels…'
    try {
      const input: ImageDiffInput = [original, working]
      const pending = new Worker(new URL('./image-diff-worker.ts', import.meta.url), { type: 'module' })
      worker = pending
      pending.addEventListener('message', ({ data }: MessageEvent<ImageDiffResult>) => {
        if (worker !== pending) {
          if ('bitmap' in data) data.bitmap.close()
          return
        }
        stopWorker()
        if ('message' in data) reset(data.message)
        else showResult(data)
      })
      const failed = (event: Event) => {
        event.preventDefault()
        if (worker === pending) reset('Pixel diff is unavailable.')
      }
      pending.addEventListener('error', failed)
      pending.addEventListener('messageerror', failed)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Workers use a dedicated port.
      pending.postMessage(input)
    } catch {
      reset('Pixel diff could not read these images.')
    }
  })

  return { button, view, reset }
}
