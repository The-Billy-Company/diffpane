// Copyright (c) 2026 The Billy Company
import './image-wipe.css'

export interface ImageWipeState {
  divider: number
  loupe: { x: number; y: number } | null
}

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

function wipeSide(side: 'before' | 'after') {
  const layer = document.createElement('div')
  layer.className = `image-wipe-${side}`
  layer.setAttribute('aria-hidden', 'true')
  const sample = document.createElement('div')
  sample.className = 'image-wipe-loupe-sample'
  return { layer, sample, image: null as HTMLImageElement | null }
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
  const paletteTargets = {
    before: versionGroup(baseline, 'is-original'),
    after: versionGroup('Working file', 'is-working'),
  } as const
  const loupeToggle = document.createElement('button')
  loupeToggle.type = 'button'
  loupeToggle.className = 'preview-toggle image-wipe-loupe-toggle'
  loupeToggle.textContent = '2× Loupe'
  loupeToggle.title = 'Magnify both versions under the pointer'
  loupeToggle.setAttribute('aria-pressed', 'false')
  labels.append(paletteTargets.before, loupeToggle, paletteTargets.after)

  const viewport = document.createElement('div')
  viewport.className = 'media-preview image-wipe-viewport'
  const stage = document.createElement('div')
  stage.className = 'image-wipe-stage'
  const beforeSide = wipeSide('before')
  const afterSide = wipeSide('after')
  const sides = [beforeSide, afterSide]
  const divider = document.createElement('div')
  divider.className = 'image-wipe-divider'
  divider.setAttribute('aria-hidden', 'true')
  const handle = document.createElement('span')
  handle.className = 'image-wipe-handle'
  divider.append(handle)

  const loupe = document.createElement('div')
  loupe.className = 'image-wipe-loupe'
  loupe.setAttribute('aria-hidden', 'true')
  loupe.hidden = true
  loupe.append(beforeSide.sample, afterSide.sample)

  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'image-wipe-range'
  range.min = '0'
  range.max = '100'
  range.setAttribute('aria-label', 'Image comparison divider')
  let loupeX = 50
  let loupeY = 50

  function moveLoupe(x: number, y: number) {
    loupeX = Math.min(100, Math.max(0, x))
    loupeY = Math.min(100, Math.max(0, y))
    loupe.style.setProperty('--loupe-x', String(loupeX))
    loupe.style.setProperty('--loupe-y', String(loupeY))
  }

  function setLoupe(enabled: boolean) {
    loupe.hidden = !enabled
    loupeToggle.setAttribute('aria-pressed', String(enabled))
    for (const { image, sample } of sides) {
      sample.replaceChildren()
      if (!enabled || !image) continue
      const copy = document.createElement('img')
      copy.alt = ''
      copy.crossOrigin = image.crossOrigin
      copy.src = image.currentSrc || image.src
      sample.append(copy)
    }
    if (enabled) {
      range.setAttribute('aria-description', 'Use Shift with the Up and Down arrow keys to move the loupe vertically.')
    } else range.removeAttribute('aria-description')
  }

  function updateDivider() {
    stage.style.setProperty('--wipe-position', `${range.value}%`)
    range.setAttribute('aria-valuetext', `${range.value}% ${baseline}, ${100 - range.valueAsNumber}% working file`)
    if (!loupe.hidden) moveLoupe(range.valueAsNumber, loupeY)
  }

  function followPointer(event: PointerEvent) {
    if (loupe.hidden) return
    const { left, top, width, height } = stage.getBoundingClientRect()
    if (width && height) moveLoupe(((event.clientX - left) / width) * 100, ((event.clientY - top) / height) * 100)
  }

  loupeToggle.addEventListener('click', () => {
    const enabled = loupe.hasAttribute('hidden')
    if (enabled) moveLoupe(range.valueAsNumber, 50)
    setLoupe(enabled)
  })
  range.addEventListener('input', updateDivider)
  range.addEventListener('pointerdown', followPointer)
  range.addEventListener('pointermove', followPointer)
  range.addEventListener('keydown', event => {
    if (loupe.hidden || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    const delta = event.key === 'ArrowUp' ? -3 : event.key === 'ArrowDown' ? 3 : 0
    if (!delta) return
    event.preventDefault()
    moveLoupe(range.valueAsNumber, loupeY + delta)
  })

  stage.append(beforeSide.layer, afterSide.layer, divider, loupe, range)
  viewport.append(stage)
  view.append(labels, viewport)

  let restoreImages: (() => void) | undefined
  return {
    button,
    view,
    paletteTargets,
    state(): ImageWipeState | undefined {
      if (view.hidden) return undefined
      return { divider: range.valueAsNumber, loupe: loupe.hidden ? null : { x: loupeX, y: loupeY } }
    },
    show(before: HTMLImageElement, after: HTMLImageElement, state?: ImageWipeState) {
      const beforeParent = before.parentElement
      const afterParent = after.parentElement
      const width = Math.max(before.naturalWidth, after.naturalWidth)
      const height = Math.max(before.naturalHeight, after.naturalHeight)
      stage.style.setProperty('--wipe-aspect', String(width / height))
      stage.style.setProperty('--wipe-max-width', `${Math.max(width, 320)}px`)
      for (const [side, image] of [
        [beforeSide, before],
        [afterSide, after],
      ] as const) {
        const { layer, sample } = side
        side.image = image
        const widthPercent = (image.naturalWidth / width) * 100
        const heightPercent = (image.naturalHeight / height) * 100
        layer.style.setProperty('--wipe-image-width', `${widthPercent}%`)
        layer.style.setProperty('--wipe-image-height', `${heightPercent}%`)
        sample.style.setProperty('--sample-width', String(widthPercent))
        sample.style.setProperty('--sample-height', String(heightPercent))
        layer.append(image)
      }
      restoreImages = () => {
        beforeParent?.append(before)
        afterParent?.append(after)
      }
      range.value = String(state?.divider ?? 50)
      updateDivider()
      button.setAttribute('aria-pressed', 'true')
      view.hidden = false
      if (state?.loupe) {
        moveLoupe(state.loupe.x, state.loupe.y)
        setLoupe(true)
      }
    },
    hide() {
      view.hidden = true
      button.setAttribute('aria-pressed', 'false')
      setLoupe(false)
      for (const side of sides) side.image = null
      restoreImages?.()
      restoreImages = undefined
    },
  }
}
