import { requireElement } from '../workspace/dom.js'
import './tour.css'

export interface OnboardingTourStop {
  title: string
  body: string
  anchor?: string
  placement?: 'beside' | 'below' | 'above' | 'inside'
  pad?: number
  nextLabel?: string
}

export const homeTourStops: readonly OnboardingTourStop[] = [
  {
    anchor: '#open-folder',
    title: 'Open a Git folder',
    body: 'Open a folder to see its files and live changes. Open File takes you straight to a file in its working tree.',
  },
  {
    anchor: '.home-workspaces-create',
    title: 'Keep folders together',
    body: 'Create a workspace to save a group of folders you want to reopen and switch between.',
    placement: 'above',
  },
  {
    title: 'Open a folder to continue',
    body: 'The tour picks up in your first working tree.',
  },
]

export const workspaceTourStops: readonly OnboardingTourStop[] = [
  {
    anchor: '#navigator .navigator-heading',
    title: 'Find a file',
    body: 'Browse your working tree here. Use Search files in the explorer to jump to a file by name.',
    placement: 'beside',
  },
  {
    anchor: '#review-toggle',
    title: 'See what changed',
    body: 'Changes collects the files that differ from Git HEAD. Open one to review its diff and track your progress.',
  },
  {
    anchor: '.workbench',
    title: 'Read the live file',
    body: 'The editor follows changes on disk. Use Diff in the file header to compare the working file with Git HEAD.',
    placement: 'inside',
    pad: 0,
  },
  {
    anchor: '#review-notes-toggle',
    title: 'Keep a review note',
    body: 'Notes keeps your review comments in one place. Attach them to a file or selection to jump back to the code.',
  },
  {
    title: 'You’re all set',
    body: 'Open Changes to review the working tree one file at a time.',
  },
]

interface TourOptions {
  stops: readonly OnboardingTourStop[]
  onFinish: (reason: 'done' | 'skip') => void
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const margin = 12
const gap = 14
const exitDuration = 160

function findAnchor(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(
    element => element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0,
  )
}

function getSpotlight(anchor: HTMLElement, pad: number, viewportWidth: number, viewportHeight: number): Box | null {
  const { left, top, right, bottom } = anchor.getBoundingClientRect()
  if (right <= 0 || left >= viewportWidth || bottom <= 0 || top >= viewportHeight || right <= left || bottom <= top)
    return null
  const x = Math.max(0, left - pad)
  const y = Math.max(0, top - pad)
  return {
    x,
    y,
    width: Math.min(viewportWidth, right + pad) - x,
    height: Math.min(viewportHeight, bottom + pad) - y,
  }
}

function placeCard(
  stop: OnboardingTourStop,
  spot: Box | null,
  viewportWidth: number,
  viewportHeight: number,
  width: number,
  height: number,
) {
  const maxX = Math.max(margin, viewportWidth - width - margin)
  const maxY = Math.max(margin, viewportHeight - height - margin)
  const clamp = (x: number, y: number) => ({
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(margin, y)),
  })
  if (!spot) return clamp((viewportWidth - width) / 2, viewportHeight * 0.62 - height / 2)

  const centerX = spot.x + spot.width / 2
  const centered = centerX - width / 2
  if (stop.placement === 'inside') return clamp(centered, spot.y + spot.height * 0.7 - height / 2)
  if (stop.placement === 'beside') {
    const left = spot.x - gap - width
    const right = spot.x + spot.width + gap
    const sides = centerX > viewportWidth / 2 ? [left, right] : [right, left]
    const x = sides.find(side => side >= margin && side <= maxX)
    if (x !== undefined) return clamp(x, spot.y + spot.height / 2 - 36)
  }

  const above = spot.y - height - gap
  const below = spot.y + spot.height + gap
  const preferred = stop.placement === 'above' ? [above, below] : [below, above]
  const y = preferred.find(side => side >= margin && side <= maxY) ?? (spot.y < viewportHeight / 2 ? below : above)
  return clamp(spot.width < width / 2 ? spot.x - 10 : centered, y)
}

export function startOnboardingTour({ stops, onFinish }: TourOptions): { close: () => void } {
  const available = stops.filter(stop => !stop.anchor || findAnchor(stop.anchor))
  let index = 0
  if (!available.length) return { close() {} }

  const dialog = document.createElement('dialog')
  dialog.className = 'onboarding-tour'
  dialog.setAttribute('aria-labelledby', 'onboarding-tour-title')
  dialog.setAttribute('aria-describedby', 'onboarding-tour-description')
  dialog.innerHTML = `
    <div class="onboarding-tour-spotlight" aria-hidden="true"></div>
    <section class="onboarding-tour-card">
      <div class="onboarding-tour-copy" aria-live="polite" aria-atomic="true">
        <p class="onboarding-tour-count"></p>
        <h2 id="onboarding-tour-title"></h2>
        <p id="onboarding-tour-description"></p>
      </div>
      <div class="onboarding-tour-actions">
        <button type="button" class="onboarding-tour-skip">Skip Tour</button>
        <button type="button" class="onboarding-tour-back">Back</button>
        <button type="button" class="onboarding-tour-next" autofocus>Next</button>
      </div>
    </section>
  `
  const spotlight = requireElement(dialog, '.onboarding-tour-spotlight', HTMLElement)
  const card = requireElement(dialog, '.onboarding-tour-card', HTMLElement)
  const count = requireElement(card, '.onboarding-tour-count', HTMLElement)
  const title = requireElement(card, '#onboarding-tour-title', HTMLElement)
  const description = requireElement(card, '#onboarding-tour-description', HTMLElement)
  const skip = requireElement(card, '.onboarding-tour-skip', HTMLButtonElement)
  const back = requireElement(card, '.onboarding-tour-back', HTMLButtonElement)
  const next = requireElement(card, '.onboarding-tour-next', HTMLButtonElement)
  const listeners = new AbortController()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const resize = new ResizeObserver(schedulePlacement)
  let frame: number | undefined
  let exitTimer: number | undefined
  let anchor: HTMLElement | undefined

  function place() {
    frame = undefined
    if (!dialog.open) return
    const stop = available[index]
    if (!stop) return
    const width = dialog.clientWidth
    const height = dialog.clientHeight
    const pad = stop.pad ?? 4
    const spot = anchor && getSpotlight(anchor, pad, width, height)
    const { x, y, width: spotWidth, height: spotHeight } = spot ?? { x: width / 2, y: height / 2, width: 0, height: 0 }
    spotlight.style.setProperty('--tour-spot-x', `${x}px`)
    spotlight.style.setProperty('--tour-spot-y', `${y}px`)
    spotlight.style.setProperty('--tour-spot-width', `${spotWidth}px`)
    spotlight.style.setProperty('--tour-spot-height', `${spotHeight}px`)
    spotlight.style.setProperty('--tour-spot-radius', `${spot ? 6 + pad : 0}px`)
    spotlight.dataset.anchored = String(Boolean(spot))
    const position = placeCard(stop, spot ?? null, width, height, card.offsetWidth, card.offsetHeight)
    card.style.setProperty('--tour-card-x', `${position.x}px`)
    card.style.setProperty('--tour-card-y', `${position.y}px`)
  }

  function schedulePlacement() {
    frame ??= requestAnimationFrame(place)
  }

  function showStop() {
    const stop = available[index]
    if (!stop) return
    const last = index === available.length - 1
    const focusMoved = back === document.activeElement
    count.textContent = `${index + 1} of ${available.length}`
    title.textContent = stop.title
    description.textContent = stop.body
    card.dataset.final = String(last)
    skip.hidden = last
    back.hidden = index === 0 || last
    next.textContent = stop.nextLabel ?? (last ? 'Done' : 'Next')
    if (back.hidden && focusMoved) next.focus()

    if (anchor) resize.unobserve(anchor)
    anchor = stop.anchor ? findAnchor(stop.anchor) : undefined
    if (anchor) {
      anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      resize.observe(anchor)
    }
    if (dialog.open) schedulePlacement()
  }

  function close() {
    listeners.abort()
    resize.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (exitTimer !== undefined) window.clearTimeout(exitTimer)
    if (dialog.open) dialog.close()
    dialog.remove()
  }

  function finish(reason: 'done' | 'skip') {
    if (exitTimer !== undefined) return
    const complete = () => {
      close()
      onFinish(reason)
    }
    if (reducedMotion.matches) {
      complete()
      return
    }
    dialog.dataset.leaving = 'true'
    exitTimer = window.setTimeout(complete, exitDuration)
  }

  const { signal } = listeners
  skip.addEventListener('click', () => finish('skip'), { signal })
  back.addEventListener(
    'click',
    () => {
      index--
      showStop()
    },
    { signal },
  )
  next.addEventListener(
    'click',
    () => {
      if (index === available.length - 1) {
        finish('done')
        return
      }
      index++
      showStop()
    },
    { signal },
  )
  dialog.addEventListener(
    'cancel',
    event => {
      event.preventDefault()
      finish('skip')
    },
    { signal },
  )
  dialog.addEventListener('close', close, { signal })
  window.addEventListener('resize', schedulePlacement, { signal })
  window.addEventListener('scroll', schedulePlacement, { capture: true, passive: true, signal })

  showStop()
  document.body.append(dialog)
  dialog.showModal()
  place()
  dialog.dataset.placed = 'true'
  resize.observe(card)
  return { close }
}
