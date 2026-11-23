// Copyright (c) 2026 The Billy Company
import type { Shape } from 'canvas-confetti'
import { colorHex } from '../../../shared/appearance/palette.ts'
import { runTask } from '../recovery/errors.ts'
import './celebration.css'

const profiles = {
  review: { radius: 118, rise: 70, fall: 34, count: 12, velocity: 15, size: 0.8, ticks: 45, third: 'violet' },
  notes: { radius: 95, rise: 18, fall: 49, count: 13, velocity: 13, size: 0.72, ticks: 39, third: 'violet' },
  checklist: { radius: 65, rise: 49, fall: 23, count: 9, velocity: 10, size: 0.64, ticks: 32, third: 'warningEdge' },
} as const

type Celebration = keyof typeof profiles

interface Point {
  x: number
  y: number
}

let ribbon: Shape | undefined
let sparkle: Shape | undefined
let request = 0
let stopActive: (() => void) | undefined

function center(element: HTMLElement): Point {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { x: left + width / 2, y: top + height / 2 }
}

/** Draws a short burst around an action while its result is visible. */
export function celebrate(
  kind: Celebration,
  anchor: HTMLElement | Point,
  within: HTMLElement,
  isCurrent?: () => boolean,
) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  if (motion.matches) return

  const version = ++request
  stopActive?.()
  const visible = () =>
    version === request &&
    !motion.matches &&
    within.isConnected &&
    !within.closest('[hidden], [inert]') &&
    (!(anchor instanceof HTMLElement) || anchor.isConnected) &&
    isCurrent?.() !== false

  runTask(
    'Play completion animation',
    async () => {
      const { default: confetti } = await import('canvas-confetti')
      if (!visible()) return

      const profile = profiles[kind]
      const { x, y } = anchor instanceof HTMLElement ? center(anchor) : anchor
      const bounds = within.getBoundingClientRect()
      const left = Math.max(0, bounds.left, x - profile.radius)
      const top = Math.max(0, bounds.top, y - profile.rise)
      const right = Math.min(window.innerWidth, bounds.right, x + profile.radius)
      const bottom = Math.min(window.innerHeight, bounds.bottom, y + profile.fall)
      if (x <= left || x >= right || y <= top || y >= bottom) return

      const width = right - left
      const height = bottom - top
      const scale = Math.min(2, window.devicePixelRatio || 1)
      const canvas = document.createElement('canvas')
      canvas.className = 'celebration-canvas'
      canvas.dataset.celebration = kind
      canvas.setAttribute('aria-hidden', 'true')
      canvas.width = Math.ceil(width * scale)
      canvas.height = Math.ceil(height * scale)
      canvas.style.left = `${left}px`
      canvas.style.top = `${top}px`
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      ribbon ??= confetti.shapeFromPath('M0 2 4 0 10 8 6 10Z')
      sparkle ??= confetti.shapeFromPath('M6 0 7.5 4.5 12 6 7.5 7.5 6 12 4.5 7.5 0 6 4.5 4.5Z')
      const scheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
      const colors = [colorHex(scheme, 'addedEdge'), colorHex(scheme, 'accent'), colorHex(scheme, profile.third)]
      const origin = { x: (x - left) / width, y: (y - top) / height }
      // Aim into the pane, and send the notes burst down from the toolbar into the cleared list.
      const nearRightEdge = right - x < 42
      const angle = kind === 'notes' ? (nearRightEdge ? 202 : -22) : x - left < 42 ? 58 : nearRightEdge ? 122 : 90
      const burst = confetti.create(canvas, { disableForReducedMotion: true })
      const common = { origin, colors, decay: 0.86, gravity: 0.62 * scale }
      const paper = {
        ...common,
        shapes: [ribbon, ribbon, 'circle'] satisfies Shape[],
        particleCount: profile.count,
        startVelocity: profile.velocity * scale,
        scalar: profile.size * scale,
        ticks: profile.ticks,
      }

      const stop = () => {
        burst.reset()
        canvas.remove()
      }
      const listeners = new AbortController()
      let frame = 0
      function checkVisible() {
        if (visible()) frame = requestAnimationFrame(checkVisible)
        else stop()
      }

      try {
        stopActive = stop
        document.body.append(canvas)
        window.addEventListener('resize', stop, { signal: listeners.signal })
        within.addEventListener('scroll', stop, { capture: true, signal: listeners.signal })
        frame = requestAnimationFrame(checkVisible)
        const flights = [burst({ ...paper, angle: kind === 'review' ? angle - 42 : angle, spread: 48 })]
        if (kind === 'review') flights.push(burst({ ...paper, angle: angle + 42, spread: 48 }))
        flights.push(
          burst({
            ...common,
            angle,
            spread: kind === 'review' ? 110 : 68,
            shapes: [sparkle],
            particleCount: kind === 'review' ? 5 : 3,
            scalar: 0.64 * scale,
            startVelocity: profile.velocity * scale,
            ticks: profile.ticks - 8,
          }),
        )
        await Promise.all(flights.filter(flight => flight !== null))
      } finally {
        listeners.abort()
        cancelAnimationFrame(frame)
        stop()
        if (stopActive === stop) stopActive = undefined
      }
    },
    { silent: true },
  )
}
