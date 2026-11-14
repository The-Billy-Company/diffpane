import './image-wipe.css'

function versionGroup(text: string, className: string) {
  const group = document.createElement('span')
  group.className = 'image-wipe-version'
  const version = document.createElement('span')
  version.className = `comparison-version ${className}`
  const label = document.createElement('span')
  label.className = 'preview-heading-label'
  label.textContent = text
  version.append(label)
  group.append(version)
  return group
}

/** Borrows the loaded preview images while the wipe is open. */
export function createImageWipe(baseline: string) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'preview-toggle'
  button.textContent = 'Wipe'
  button.title = 'Drag a divider to compare the images'
  button.setAttribute('aria-pressed', 'false')
  button.hidden = true

  const view = document.createElement('div')
  view.className = 'image-wipe'
  view.hidden = true
  const labels = document.createElement('div')
  labels.className = 'preview-heading image-wipe-labels'
  labels.append(versionGroup(baseline, 'is-original'), versionGroup('Working file', 'is-working'))

  const viewport = document.createElement('div')
  viewport.className = 'media-preview image-wipe-viewport'
  const stage = document.createElement('div')
  stage.className = 'image-wipe-stage'
  const beforeLayer = document.createElement('div')
  beforeLayer.className = 'image-wipe-before'
  beforeLayer.setAttribute('aria-hidden', 'true')
  const afterLayer = document.createElement('div')
  afterLayer.className = 'image-wipe-after'
  afterLayer.setAttribute('aria-hidden', 'true')
  const divider = document.createElement('div')
  divider.className = 'image-wipe-divider'
  divider.setAttribute('aria-hidden', 'true')
  const handle = document.createElement('span')
  handle.className = 'image-wipe-handle'
  divider.append(handle)

  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'image-wipe-range'
  range.min = '0'
  range.max = '100'
  range.setAttribute('aria-label', 'Image comparison divider')
  function updateDivider() {
    stage.style.setProperty('--wipe-position', `${range.value}%`)
    range.setAttribute('aria-valuetext', `${range.value}% ${baseline}, ${100 - range.valueAsNumber}% working file`)
  }
  range.addEventListener('input', updateDivider)

  stage.append(beforeLayer, afterLayer, divider, range)
  viewport.append(stage)
  view.append(labels, viewport)

  let restoreImages: (() => void) | undefined
  return {
    button,
    view,
    show(before: HTMLImageElement, after: HTMLImageElement) {
      const beforeParent = before.parentElement
      const afterParent = after.parentElement
      const width = Math.max(before.naturalWidth, after.naturalWidth)
      const height = Math.max(before.naturalHeight, after.naturalHeight)
      stage.style.setProperty('--wipe-aspect', String(width / height))
      stage.style.setProperty('--wipe-max-width', `${Math.max(width, 320)}px`)
      for (const [image, layer] of [
        [before, beforeLayer],
        [after, afterLayer],
      ] as const) {
        layer.style.setProperty('--wipe-image-width', `${(image.naturalWidth / width) * 100}%`)
        layer.style.setProperty('--wipe-image-height', `${(image.naturalHeight / height) * 100}%`)
        layer.append(image)
      }
      restoreImages = () => {
        beforeParent?.append(before)
        afterParent?.append(after)
      }
      range.value = '50'
      updateDivider()
      button.setAttribute('aria-pressed', 'true')
      view.hidden = false
    },
    hide() {
      view.hidden = true
      button.setAttribute('aria-pressed', 'false')
      restoreImages?.()
      restoreImages = undefined
    },
  }
}
