import type { editor } from 'monaco-editor'
import { requireElement } from '../../shell/workspace/dom.js'

type Side = 'original' | 'modified'

// Merge changes that land on the same part of the track so even dense diffs stay cheap to render.
const TRACK_STEPS = 384

function changedLines(hunk: editor.ILineChange, side: Side) {
  return side === 'original'
    ? { first: hunk.originalStartLineNumber, last: hunk.originalEndLineNumber }
    : { first: hunk.modifiedStartLineNumber, last: hunk.modifiedEndLineNumber }
}

function locateMark(mark: HTMLElement, start: number, end: number) {
  mark.style.setProperty('--mark-start', `${(100 * start) / TRACK_STEPS}%`)
  mark.style.setProperty('--mark-width', `${(100 * (end - start)) / TRACK_STEPS}%`)
}

export function createReviewChangeMap(onSelect: (index: number) => void) {
  const element = document.createElement('div')
  element.className = 'review-change-map'
  element.tabIndex = 0
  element.hidden = true
  element.title = 'Jump to a change'
  element.setAttribute('role', 'slider')
  element.setAttribute('aria-label', 'Change map')
  element.setAttribute('aria-valuemin', '1')
  element.innerHTML = `
    <div class="review-map-row" aria-hidden="true">
      <span class="review-map-sign">−</span>
      <div class="review-map-lane is-original"><div class="review-map-marks"></div><span class="review-map-active" hidden></span></div>
    </div>
    <div class="review-map-row" aria-hidden="true">
      <span class="review-map-sign">+</span>
      <div class="review-map-lane is-working"><div class="review-map-marks"></div><span class="review-map-active" hidden></span></div>
    </div>`

  const lanes = (['original', 'modified'] as const).map(side => {
    const track = requireElement(element, side === 'original' ? '.is-original' : '.is-working', HTMLDivElement)
    return {
      side,
      track,
      marks: requireElement(track, '.review-map-marks', HTMLDivElement),
      active: requireElement(track, '.review-map-active', HTMLSpanElement),
      lineCount: 1,
    }
  })
  let hunks: readonly editor.ILineChange[] = []
  let selected = 0

  function markBounds(hunk: editor.ILineChange, { side, lineCount }: (typeof lanes)[number]) {
    const { first, last } = changedLines(hunk, side)
    if (!last) return null
    return {
      start: Math.floor(((first - 1) * TRACK_STEPS) / lineCount),
      end: Math.ceil((last * TRACK_STEPS) / lineCount),
    }
  }

  function update(changes: readonly editor.ILineChange[], originalLines: number, modifiedLines: number) {
    hunks = changes
    element.hidden = !hunks.length
    element.setAttribute('aria-valuemax', String(hunks.length))

    for (const lane of lanes) {
      lane.lineCount = lane.side === 'original' ? originalLines : modifiedLines
      const marks: HTMLSpanElement[] = []
      let start = 0
      let end = 0
      let mark: HTMLSpanElement | undefined
      for (const hunk of hunks) {
        const bounds = markBounds(hunk, lane)
        if (!bounds) continue
        if (!mark || bounds.start > end) {
          mark = document.createElement('span')
          mark.className = 'review-map-mark'
          marks.push(mark)
          start = bounds.start
        }
        end = bounds.end
        locateMark(mark, start, end)
      }
      lane.marks.replaceChildren(...marks)
    }
  }

  function select(index: number) {
    selected = index
    const hunk = hunks[index]
    for (const lane of lanes) {
      const bounds = hunk && markBounds(hunk, lane)
      lane.active.hidden = !bounds
      if (bounds) locateMark(lane.active, bounds.start, bounds.end)
    }
    if (!hunk) return
    element.setAttribute('aria-valuenow', String(index + 1))
    element.setAttribute('aria-valuetext', `Change ${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`)
  }

  function nearestChange(lane: (typeof lanes)[number], x: number) {
    const { left, width } = lane.track.getBoundingClientRect()
    const position = (Math.min(width, Math.max(0, x - left)) / width) * lane.lineCount
    let nearest = -1
    let distance = Infinity
    for (const [index, hunk] of hunks.entries()) {
      const { first, last } = changedLines(hunk, lane.side)
      if (!last) continue
      const gap = Math.max(first - 1 - position, position - last, 0)
      if (gap >= distance) continue
      nearest = index
      distance = gap
      if (gap === 0) break
    }
    return nearest
  }

  element.addEventListener('click', event => {
    const lane = lanes.find(({ track }) => event.clientY <= track.getBoundingClientRect().bottom) ?? lanes.at(-1)
    if (!lane) return
    const nearest = nearestChange(lane, event.clientX)
    if (nearest >= 0) onSelect(nearest)
    else {
      const other = lanes.find(value => value !== lane)
      if (other) {
        const fallback = nearestChange(other, event.clientX)
        if (fallback >= 0) onSelect(fallback)
      }
    }
  })

  element.addEventListener('keydown', event => {
    let index = selected
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        index++
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        index--
        break
      case 'Home':
        index = 0
        break
      case 'End':
        index = hunks.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    onSelect(Math.max(0, Math.min(hunks.length - 1, index)))
  })

  return { element, update, select }
}
