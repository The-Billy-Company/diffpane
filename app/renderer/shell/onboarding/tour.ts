import { requireElement } from '../workspace/dom.js'
import './tour.css'

export interface OnboardingTourStop {
  title: string
  body: string
  anchor?: string | readonly string[]
  placement?: 'beside' | 'below' | 'above'
  nextLabel?: string
}

export const homeTourStops: readonly OnboardingTourStop[] = [
  {
    anchor: '#open-folder',
    title: 'Open a Git folder',
    body: 'Open Folder brings in a working tree. Open File jumps straight to one of its files.',
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
    anchor: ['#navigator button[data-action="open-file"]', '#navigator .navigator-heading'],
    title: 'Find a file',
    body: 'Use Search files to jump to a file by name, or browse the working tree in the explorer.',
    placement: 'beside',
  },
  {
    anchor: '#review-toggle',
    title: 'See what changed',
    body: 'Changes collects the files that differ from Git HEAD. Open one to review its diff and track your progress.',
  },
  {
    anchor: ['.file-header .diff-toggle:not(:disabled)', '.file-header', '#empty-state h2', '.workbench'],
    title: 'Compare a working file',
    body: 'Open a file to follow saves on disk. Use Diff in its header to compare the working file with Git HEAD.',
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
const gap = 18
const exitDuration = 160

function findAnchor(selectors: string | readonly string[]) {
  for (const selector of typeof selectors === 'string' ? [selectors] : selectors) {
    const anchor = [...document.querySelectorAll<HTMLElement>(selector)].find(
      element => element.checkVisibility({ visibilityProperty: true }) && element.getClientRects().length > 0,
    )
    if (anchor) return anchor
  }
  return undefined
}

function getSpotlight(anchor: HTMLElement, viewportWidth: number, viewportHeight: number): Box | null {
  const pad = 4
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
  const clampX = (x: number) => Math.min(maxX, Math.max(margin, x))
  const clampY = (y: number) => Math.min(maxY, Math.max(margin, y))
  if (!spot) return { x: clampX((viewportWidth - width) / 2), y: clampY((viewportHeight - height) / 2) }

  const centerX = spot.x + spot.width / 2
  const centerY = spot.y + spot.height / 2
  const left = { x: spot.x - gap - width, y: clampY(centerY - 26) }
  const right = { x: spot.x + spot.width + gap, y: left.y }
  const sides = centerX > viewportWidth / 2 ? [left, right] : [right, left]
  const above = { x: clampX(centerX - width / 2), y: spot.y - height - gap }
  const below = { x: above.x, y: spot.y + spot.height + gap }
  const preferred = stop.placement === 'above' ? [above, below] : [below, above]
  const positions = stop.placement === 'beside' ? [...sides, ...preferred] : [...preferred, ...sides]
  const position = positions.find(({ x, y }) => x >= margin && x <= maxX && y >= margin && y <= maxY)
  if (position) return position

  return { x: above.x, y: clampY(centerY <= viewportHeight / 2 ? below.y : above.y) }
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
    <div class="onboarding-tour-spotlight" aria-hidden="true"><div class="onboarding-tour-halo"></div></div>
    <section class="onboarding-tour-card">
      <div class="onboarding-tour-copy" aria-live="polite" aria-atomic="true">
        <header class="onboarding-tour-progress">
          <span>Guided tour</span>
          <span class="onboarding-tour-ticks" aria-hidden="true"></span>
          <span class="onboarding-tour-count"></span>
        </header>
        <h2 id="onboarding-tour-title"></h2>
        <p id="onboarding-tour-description"></p>
      </div>
      <footer class="onboarding-tour-actions">
        <button type="button" class="onboarding-tour-skip">Skip tour</button>
        <button type="button" class="onboarding-tour-back"><span aria-hidden="true">←</span> Back</button>
        <button type="button" class="onboarding-tour-next" autofocus><span>Next</span><span aria-hidden="true">→</span></button>
      </footer>
    </section>
  `
  const spotlight = requireElement(dialog, '.onboarding-tour-spotlight', HTMLElement)
  const halo = requireElement(spotlight, '.onboarding-tour-halo', HTMLElement)
  const card = requireElement(dialog, '.onboarding-tour-card', HTMLElement)
  const count = requireElement(card, '.onboarding-tour-count', HTMLElement)
  const ticks = requireElement(card, '.onboarding-tour-ticks', HTMLElement)
  const title = requireElement(card, '#onboarding-tour-title', HTMLElement)
  const description = requireElement(card, '#onboarding-tour-description', HTMLElement)
  const skip = requireElement(card, '.onboarding-tour-skip', HTMLButtonElement)
  const back = requireElement(card, '.onboarding-tour-back', HTMLButtonElement)
  const next = requireElement(card, '.onboarding-tour-next', HTMLButtonElement)
  const nextLabel = requireElement(next, 'span:first-child', HTMLElement)
  const nextIcon = requireElement(next, 'span:last-child', HTMLElement)
  const markers = Array.from({ length: available.length }, () => document.createElement('span'))
  ticks.append(...markers)
  const listeners = new AbortController()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const resize = new ResizeObserver(schedulePlacement)
  let frame: number | undefined
  let exitTimer: number | undefined
  let anchor: HTMLElement | undefined
  let placedIndex: number | undefined
  let emphasis: Animation | undefined

  function place() {
    frame = undefined
    if (!dialog.open) return
    const stop = available[index]
    if (!stop) return
    const width = dialog.clientWidth
    const height = dialog.clientHeight
    const spot = anchor && getSpotlight(anchor, width, height)
    const { x, y, width: spotWidth, height: spotHeight } = spot ?? { x: width / 2, y: height / 2, width: 0, height: 0 }
    spotlight.style.setProperty('--tour-spot-x', `${x}px`)
    spotlight.style.setProperty('--tour-spot-y', `${y}px`)
    spotlight.style.setProperty('--tour-spot-width', `${spotWidth}px`)
    spotlight.style.setProperty('--tour-spot-height', `${spotHeight}px`)
    spotlight.dataset.anchored = String(Boolean(spot))
    const position = placeCard(stop, spot ?? null, width, height, card.offsetWidth, card.offsetHeight)
    card.style.setProperty('--tour-card-x', `${position.x}px`)
    card.style.setProperty('--tour-card-y', `${position.y}px`)
    if (placedIndex !== index) {
      emphasis?.cancel()
      if (spot && !reducedMotion.matches)
        emphasis = halo.animate([{ opacity: 0 }, { opacity: 0.8, offset: 0.4 }, { opacity: 0 }], {
          duration: 520,
          delay: placedIndex === undefined ? 40 : 180,
          easing: 'ease-out',
        })
      placedIndex = index
    }
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
    markers.forEach((marker, position) => {
      marker.dataset.state = position === index ? 'current' : position < index ? 'seen' : 'upcoming'
    })
    title.textContent = stop.title
    description.textContent = stop.body
    card.dataset.final = String(last)
    skip.hidden = last
    back.hidden = index === 0 || last
    nextLabel.textContent = stop.nextLabel ?? (last ? 'Done' : 'Next')
    nextIcon.textContent = last ? '✓' : '→'
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
    emphasis?.cancel()
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
    for (const button of [skip, back, next]) button.disabled = true
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
