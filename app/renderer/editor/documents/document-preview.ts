import { MAX_AUDIO_WAVEFORM_BYTES } from '../../../shared/documents/media-types.ts'
import { attempt } from '../../../shared/recovery/app-errors.ts'
import type { ContentMatch } from '../../explorer/project-search/content-search.ts'
import { reportError } from '../../shell/recovery/errors.ts'
import { showAudioPreview } from './audio-waveform/audio-waveform.ts'
import { createImageDiff } from './image-diff/image-diff.ts'
import { createImageWipe } from './image-diff/image-wipe.ts'
import { appendImagePalette } from './image-palette/image-palette.ts'
import { showMedia } from './media.ts'

import type { FileContent } from '../../../electron/workspace/documents/file-content.ts'

interface PreviewMedia {
  url: string
  type: string
}

interface ImagePane {
  image: HTMLImageElement
  heading: HTMLElement
  palette: HTMLElement
}

/** Native previews with an always available byte fallback. Owns all URLs and playback. */
export function showDocumentPreview(
  host: ParentNode,
  preview: { before: FileContent; after: FileContent },
  filename: string,
  compare = false,
  currentMedia: PreviewMedia | null = null,
  options: {
    baseline?: string
    raw?: boolean
    onRawChange?: (raw: boolean) => void
    match?: ContentMatch
  } = {},
) {
  const root = document.createElement('div')
  root.className = 'document-preview'
  root.dataset.compare = String(compare)
  const toolbar = document.createElement('div')
  toolbar.className = 'preview-toolbar'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'preview-toggle'
  toggle.textContent = 'Hex'
  toggle.setAttribute('aria-label', 'Inspect raw bytes')
  toggle.setAttribute('aria-pressed', 'false')
  const hint = document.createElement('span')
  hint.className = 'preview-hint'
  const status = document.createElement('span')
  status.className = 'preview-image-status'
  status.setAttribute('role', 'status')
  const tools = document.createElement('div')
  tools.className = 'preview-tools'
  const panes = document.createElement('div')
  panes.className = 'preview-panes'
  const workingImage = currentMedia ? currentMedia.type.startsWith('image/') : preview.after.kind === 'image'
  const wipe =
    compare && preview.before.kind === 'image' && workingImage ? createImageWipe(options.baseline ?? 'HEAD') : null
  const images: Partial<Record<'before' | 'after', ImagePane>> = {}
  const imageDiff = compare ? createImageDiff(preview.before, preview.after, panes, status, closeWipe) : null
  if (wipe) tools.append(wipe.button)
  if (imageDiff) tools.append(imageDiff.button)
  tools.append(toggle)
  toolbar.append(hint, status, tools)
  root.append(toolbar, panes)
  if (wipe) root.append(wipe.view)
  if (imageDiff) root.append(imageDiff.view)
  host.replaceChildren(root)
  let raw = options.raw ?? false
  let match = options.match
  const cleanups: (() => void)[] = []

  function closeWipe() {
    if (!wipe || wipe.view.hidden) return
    wipe.hide()
    for (const { heading, palette } of Object.values(images)) heading.append(palette)
    panes.hidden = false
  }

  wipe?.button.addEventListener('click', () => {
    if (!wipe.view.hidden) {
      closeWipe()
    } else if (images.before && images.after) {
      imageDiff?.reset()
      wipe.show(images.before.image, images.after.image)
      wipe.paletteTargets.before.append(images.before.palette)
      wipe.paletteTargets.after.append(images.after.palette)
      panes.hidden = true
    }
  })

  function clear() {
    closeWipe()
    if (wipe) wipe.button.hidden = true
    delete images.before
    delete images.after
    imageDiff?.reset()
    for (let cleanup = cleanups.pop(); cleanup; cleanup = cleanups.pop()) {
      const result = attempt(cleanup, { operation: 'Release document preview' })
      if (!result.ok) reportError(result.error, { silent: true })
    }
    panes.replaceChildren()
  }

  function render() {
    clear()
    toggle.setAttribute('aria-pressed', String(raw))
    hint.textContent = raw ? 'Hexadecimal · ASCII' : 'Preview'
    if (imageDiff) imageDiff.button.hidden = raw
    for (const side of compare ? (['before', 'after'] as const) : (['after'] as const)) {
      const value = preview[side]
      const pane = document.createElement('section')
      pane.className = 'preview-pane'
      pane.dataset.side = side
      const heading = document.createElement('div')
      heading.className = 'preview-heading'
      const details = compare ? document.createElement('span') : heading
      const size = `${value.size.toLocaleString()} bytes`
      details.textContent = compare ? size : `Current · working file · ${size}`
      if (compare) {
        const label = document.createElement('strong')
        const original = side === 'before'
        label.className = `comparison-version ${original ? 'is-original' : 'is-working'}`
        const name = document.createElement('span')
        name.className = 'preview-heading-label'
        name.textContent = original ? (options.baseline ?? 'HEAD') : 'Working file'
        label.append(name)
        details.className = 'preview-heading-details'
        details.title = size
        heading.append(label, details)
      }
      pane.append(heading)
      const note = document.createElement('p')
      note.className = 'preview-note'
      note.textContent = value.note ?? ''
      note.hidden = !note.textContent
      pane.append(note)
      const body = document.createElement('div')
      body.className = 'preview-body'
      pane.append(body)
      panes.append(pane)
      const truncated =
        value.hexBytes !== undefined && value.hexBytes < value.size
          ? `Showing the first ${value.hexBytes.toLocaleString()} of ${value.size.toLocaleString()} bytes.`
          : ''
      const bytes = (reason = '') => {
        const pre = document.createElement('pre')
        pre.className = 'preview-text'
        pre.tabIndex = 0
        pre.setAttribute('aria-label', `Contents of ${filename}`)
        const text = value.kind === 'text' ? value.value : ''
        pre.textContent = (raw || value.kind !== 'text' ? value.hex : text) ?? text
        body.replaceChildren(pre)
        if (!compare && !raw && value.kind === 'text' && match) {
          revealTextMatch(pre, match)
          match = undefined
        }
        if (reason || (truncated && (raw || value.kind === 'binary'))) {
          note.textContent = reason ? `${reason} ${truncated || 'Showing raw bytes.'}` : truncated
          note.hidden = false
        }
      }
      if (!value.size) {
        body.textContent = 'Empty or absent file.'
      } else if (raw || value.kind === 'text' || (value.kind === 'binary' && !(side === 'after' && currentMedia))) {
        bytes()
      } else {
        const failed = () => {
          if (wipe) {
            closeWipe()
            delete images[side]
            wipe.button.hidden = true
          }
          bytes('This format or codec cannot be displayed.')
        }
        let media = side === 'after' ? currentMedia : null
        if (!media && 'data' in value && value.data && value.mime) {
          const { data: encoded, mime: type } = value
          const result = attempt(
            () => {
              const data = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
              return URL.createObjectURL(new Blob([data], { type }))
            },
            { operation: 'Decode document preview' },
          )
          if (!result.ok) {
            reportError(result.error, { silent: true })
            bytes('This preview could not be decoded.')
            continue
          }
          const url = result.value
          cleanups.push(() => URL.revokeObjectURL(url))
          media = { url, type }
        }
        if (!media) {
          failed()
          continue
        }
        if (media.type.startsWith('image/') || media.type.startsWith('video/')) {
          cleanups.push(
            showMedia(body, media, filename, {
              onReady: (description, signal, image) => {
                details.textContent += ` · ${description}`
                if (compare) details.title = details.textContent
                if (image?.naturalWidth && image.naturalHeight) {
                  const palette = document.createElement('span')
                  palette.className = 'preview-image-palette-slot'
                  heading.append(palette)
                  if (wipe) {
                    images[side] = { image, palette, heading }
                    wipe.button.hidden = !(images.before && images.after)
                  }
                  appendImagePalette(palette, image, signal).catch(() => {
                    // Palette extraction is optional. A canvas or decoder failure leaves the preview usable.
                  })
                }
              },
              onError: failed,
            }),
          )
        } else if (media.type.startsWith('audio/')) {
          const waveformBytes =
            value.kind === 'audio' && value.size <= MAX_AUDIO_WAVEFORM_BYTES ? value.data : undefined
          const label = compare
            ? `${filename} · ${side === 'before' ? (options.baseline ?? 'HEAD') : 'Working file'}`
            : filename
          cleanups.push(showAudioPreview(body, media.url, label, failed, waveformBytes))
        } else if (media.type === 'application/pdf') {
          const frame = document.createElement('iframe')
          frame.className = 'preview-pdf'
          frame.title = `PDF preview of ${filename}`
          frame.src = media.url
          body.append(frame)
          cleanups.push(() => frame.remove())
        } else failed()
      }
    }
  }
  const toggleRaw = () => {
    raw = !raw
    options.onRawChange?.(raw)
    render()
  }
  toggle.addEventListener('click', toggleRaw)
  render()
  return () => {
    toggle.removeEventListener('click', toggleRaw)
    clear()
    root.remove()
  }
}

function revealTextMatch(pre: HTMLPreElement, hit: ContentMatch) {
  const text = pre.textContent
  const endings = /\r\n?|\n/gu
  let start = text.startsWith('\uFEFF') ? 1 : 0
  endings.lastIndex = start
  for (let line = 1; line < hit.line; line++) {
    if (!endings.exec(text)) return
    start = endings.lastIndex
  }
  start += hit.column - 1
  const end = start + hit.length
  if (text.slice(start, end) !== hit.match) return
  const mark = document.createElement('mark')
  mark.textContent = hit.match
  pre.replaceChildren(text.slice(0, start), mark, text.slice(end))
  pre.focus({ preventScroll: true })
  mark.scrollIntoView({ block: 'center', inline: 'nearest' })
}
