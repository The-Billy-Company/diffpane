// Copyright (c) 2026 The Billy Company
import { requireElement } from '../../shell/workspace/dom.js'
import './change-rail.css'

const STEPS = 384
const STROKES = [
  { kind: 'folder', start: 5, width: 6 },
  { kind: 'modified', start: 3, width: 10 },
  { kind: 'moved', start: 3, width: 10 },
  { kind: 'moved-edited', start: 3, width: 10 },
  { kind: 'added', start: 9, width: 4 },
  { kind: 'removed', start: 3, width: 4 },
  { kind: 'conflict', start: 3, width: 10 },
] as const

export type ChangeKind = (typeof STROKES)[number]['kind']

interface ChangeMark {
  row: number
  kind: ChangeKind
}

export function createChangeRail(
  list: HTMLElement,
  rowHeight: number,
  labelForRow: (row: number) => string | undefined,
) {
  const rail = document.createElement('div')
  rail.className = 'navigator-change-rail'
  rail.hidden = true
  rail.tabIndex = 0
  rail.role = 'scrollbar'
  rail.setAttribute('aria-label', 'Explorer change map')
  rail.setAttribute('aria-orientation', 'vertical')
  rail.setAttribute('aria-controls', list.id)
  rail.setAttribute('aria-valuemin', '0')
  rail.setAttribute('aria-valuemax', '100')
  rail.setAttribute('aria-description', 'Use the arrow keys or Page Up and Page Down to scroll the file tree.')
  rail.innerHTML = `
    <div class="navigator-change-track" aria-hidden="true">
      <span class="navigator-change-viewport"></span>
      <svg viewBox="0 0 16 ${STEPS}" preserveAspectRatio="none">
        ${STROKES.map(({ kind }) => `<path data-kind="${kind}"/>`).join('')}
      </svg>
    </div>
    <div class="navigator-change-label" aria-hidden="true" hidden></div>`
  const track = requireElement(rail, '.navigator-change-track', HTMLDivElement)
  const label = requireElement(rail, '.navigator-change-label', HTMLDivElement)
  const paths = STROKES.map(({ kind, start, width }) => ({
    kind,
    start,
    width,
    path: requireElement(rail, `path[data-kind="${kind}"]`, SVGPathElement),
  }))
  const listeners = new AbortController()
  let rowCount = 0
  let hasMarks = false
  let drag: { id: number; offset: number } | null = null

  function sync() {
    const height = list.clientHeight
    const content = list.scrollHeight
    const maxScroll = content - height
    const hide = !hasMarks || height === 0 || maxScroll <= 0
    if (hide) {
      if (document.activeElement === rail) list.focus({ preventScroll: true })
      label.hidden = true
      rail.hidden = true
      return
    }
    rail.hidden = false
    const top = list.scrollTop
    const progress = top / maxScroll
    track.style.setProperty('--change-view-progress', String(progress))
    track.style.setProperty('--change-view-size', `${(100 * height) / content}%`)
    rail.setAttribute('aria-valuenow', String(Math.round(100 * progress)))
    rail.setAttribute(
      'aria-valuetext',
      `Rows ${Math.floor(top / rowHeight) + 1}–${Math.min(rowCount, Math.ceil((top + height) / rowHeight))} of ${rowCount}`,
    )
  }

  function pointerFraction(event: PointerEvent) {
    const { top, height } = track.getBoundingClientRect()
    return height > 0 ? Math.min(1, Math.max(0, (event.clientY - top) / height)) : 0
  }

  rail.addEventListener(
    'pointerdown',
    event => {
      if (event.button !== 0 || drag) return
      const position = pointerFraction(event) * list.scrollHeight
      const offset = position - list.scrollTop
      drag = { id: event.pointerId, offset: offset >= 0 && offset < list.clientHeight ? offset : list.clientHeight / 2 }
      rail.focus({ preventScroll: true })
      rail.setPointerCapture(event.pointerId)
      list.scrollTop = position - drag.offset
    },
    listeners,
  )
  rail.addEventListener(
    'pointermove',
    event => {
      const fraction = pointerFraction(event)
      if (drag?.id === event.pointerId) list.scrollTop = fraction * list.scrollHeight - drag.offset
      if (event.pointerType === 'touch') return
      const row = Math.min(rowCount - 1, Math.floor(fraction * rowCount))
      const text = labelForRow(row)
      if (!text) return
      label.style.setProperty('--change-label-position', `${fraction * 100}%`)
      if (label.textContent !== text) label.textContent = text
      label.hidden = false
    },
    listeners,
  )
  rail.addEventListener(
    'pointerleave',
    () => {
      label.hidden = true
    },
    listeners,
  )
  rail.addEventListener(
    'lostpointercapture',
    event => {
      if (drag?.id !== event.pointerId) return
      drag = null
      if (!rail.matches(':hover')) label.hidden = true
    },
    listeners,
  )
  rail.addEventListener(
    'wheel',
    event => {
      const unit = event.deltaMode === 1 ? rowHeight : event.deltaMode === 2 ? list.clientHeight : 1
      if (event.ctrlKey || !event.deltaY) return
      event.preventDefault()
      list.scrollTop += event.deltaY * unit
    },
    { signal: listeners.signal, passive: false },
  )
  rail.addEventListener(
    'keydown',
    event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      let top = list.scrollTop
      if (event.key === 'ArrowUp') top -= rowHeight
      else if (event.key === 'ArrowDown') top += rowHeight
      else if (event.key === 'PageUp') top -= list.clientHeight
      else if (event.key === 'PageDown') top += list.clientHeight
      else if (event.key === 'Home') top = 0
      else if (event.key === 'End') top = list.scrollHeight
      else return
      event.preventDefault()
      list.scrollTop = top
    },
    listeners,
  )

  return {
    rail,
    setMarks(count: number, marks: Iterable<ChangeMark>) {
      rowCount = count
      hasMarks = false
      label.hidden = true
      const buckets: Record<ChangeKind, Set<number>> = {
        folder: new Set(),
        modified: new Set(),
        moved: new Set(),
        'moved-edited': new Set(),
        added: new Set(),
        removed: new Set(),
        conflict: new Set(),
      }
      for (const { row, kind } of marks) {
        hasMarks = true
        buckets[kind].add(Math.floor(((row + 0.5) / count) * STEPS) + 0.5)
      }
      for (const { kind, start, width, path } of paths) {
        path.setAttribute('d', Array.from(buckets[kind], y => `M${start},${y}h${width}`).join(''))
      }
    },
    sync,
    dispose: () => listeners.abort(),
  }
}
