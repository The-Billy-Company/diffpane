import type { editor } from 'monaco-editor'
import { requireElement } from '../../shell/workspace/dom.js'

type Side = 'original' | 'modified'

// Merge changes that land on the same part of the track so even dense diffs stay cheap to render.
const TRACK_STEPS = 384
const PREVIEW_LINES = 3
const PREVIEW_COLUMNS = 160

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
  element.hidden = true
  element.innerHTML = `
    <div class="review-map-control" role="slider" tabindex="0" aria-label="Change map" aria-valuemin="1">
      <div class="review-map-row is-original" aria-hidden="true">
        <span class="review-map-sign">−</span>
        <div class="review-map-lane"><div class="review-map-marks"></div><span class="review-map-active" hidden></span><span class="review-map-preview-mark" hidden></span></div>
      </div>
      <div class="review-map-row is-working" aria-hidden="true">
        <span class="review-map-sign">+</span>
        <div class="review-map-lane"><div class="review-map-marks"></div><span class="review-map-active" hidden></span><span class="review-map-preview-mark" hidden></span></div>
      </div>
    </div>
    <div class="review-map-preview-track" aria-hidden="true">
      <div class="review-map-preview" hidden>
        <div class="review-map-preview-title"></div>
        <div class="review-map-preview-panes">
          <div class="review-map-preview-pane is-original">
            <div class="review-map-preview-label"><span>− Before</span><span class="review-map-preview-range"></span></div>
            <div class="review-map-preview-code"></div>
          </div>
          <div class="review-map-preview-pane is-working">
            <div class="review-map-preview-label"><span>+ After</span><span class="review-map-preview-range"></span></div>
            <div class="review-map-preview-code"></div>
          </div>
        </div>
      </div>
    </div>`

  const control = requireElement(element, '.review-map-control', HTMLDivElement)
  const preview = requireElement(element, '.review-map-preview', HTMLDivElement)
  const title = requireElement(preview, '.review-map-preview-title', HTMLDivElement)
  const lanes = (['original', 'modified'] as const).map(side => {
    const match = side === 'original' ? '.is-original' : '.is-working'
    const track = requireElement(control, `${match} .review-map-lane`, HTMLDivElement)
    const pane = requireElement(preview, match, HTMLDivElement)
    return {
      side,
      track,
      marks: requireElement(track, '.review-map-marks', HTMLDivElement),
      active: requireElement(track, '.review-map-active', HTMLSpanElement),
      previewMark: requireElement(track, '.review-map-preview-mark', HTMLSpanElement),
      pane,
      range: requireElement(pane, '.review-map-preview-range', HTMLSpanElement),
      code: requireElement(pane, '.review-map-preview-code', HTMLDivElement),
      targets: [] as number[],
      lineCount: 1,
      version: 0,
    }
  })
  let hunks: readonly editor.ILineChange[] = []
  let model: editor.IDiffEditorModel | null = null
  let selected = 0
  let previewed = -1

  function markBounds(hunk: editor.ILineChange, { side, lineCount }: (typeof lanes)[number]) {
    const { first, last } = changedLines(hunk, side)
    if (!last) return null
    return {
      start: Math.floor(((first - 1) * TRACK_STEPS) / lineCount),
      end: Math.ceil((last * TRACK_STEPS) / lineCount),
    }
  }

  function update(changes: readonly editor.ILineChange[], comparison: editor.IDiffEditorModel | null) {
    hidePreview()
    hunks = changes
    model = comparison
    element.hidden = !hunks.length
    control.setAttribute('aria-valuemax', String(hunks.length))

    for (const lane of lanes) {
      const text = model?.[lane.side]
      lane.lineCount = text?.getLineCount() ?? 1
      lane.version = text?.getVersionId() ?? 0
      lane.targets = []
      const marks: HTMLSpanElement[] = []
      let start = 0
      let end = 0
      let mark: HTMLSpanElement | undefined
      for (const [index, hunk] of hunks.entries()) {
        const bounds = markBounds(hunk, lane)
        if (!bounds) continue
        lane.targets.push(index)
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
    control.setAttribute('aria-valuenow', String(index + 1))
    control.setAttribute('aria-valuetext', `Change ${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`)
  }

  function nearestChange(lane: (typeof lanes)[number], x: number) {
    const { left, width } = lane.track.getBoundingClientRect()
    if (!width) return -1
    const position = (Math.min(width, Math.max(0, x - left)) / width) * lane.lineCount
    // The next and previous hunk are the only possible matches in this sorted lane.
    let start = 0
    let end = lane.targets.length
    while (start < end) {
      const middle = Math.floor((start + end) / 2)
      const hunk = hunks[lane.targets[middle] ?? -1]
      if (!hunk || changedLines(hunk, lane.side).last < position) start = middle + 1
      else end = middle
    }
    const next = lane.targets[start] ?? -1
    const previous = lane.targets[start - 1] ?? -1
    const nextHunk = hunks[next]
    const previousHunk = hunks[previous]
    if (!nextHunk) return previous
    if (!previousHunk) return next
    const nextGap = Math.max(0, changedLines(nextHunk, lane.side).first - 1 - position)
    const previousGap = position - changedLines(previousHunk, lane.side).last
    return nextGap < previousGap ? next : previous
  }

  function changeAt({ clientX, clientY }: MouseEvent) {
    const first = lanes[0]
    const second = lanes[1]
    if (!first || !second) return null
    const [lane, other] = clientY <= first.track.getBoundingClientRect().bottom ? [first, second] : [second, first]
    const target = lane.targets.length ? lane : other
    return { index: nearestChange(target, clientX), lane: target }
  }

  function showPreview(index: number, preferredLane?: (typeof lanes)[number]) {
    const hunk = hunks[index]
    if (!hunk || !model) return
    const comparison = model
    if (lanes.some(({ side, version }) => comparison[side].getVersionId() !== version)) {
      hidePreview()
      return
    }
    const anchorLane = preferredLane ?? lanes.findLast(lane => changedLines(hunk, lane.side).last > 0)
    const anchor = anchorLane && markBounds(hunk, anchorLane)
    if (anchor) {
      preview.style.setProperty('--preview-anchor', `${(50 * (anchor.start + anchor.end)) / TRACK_STEPS}%`)
    }
    if (index === previewed) return
    previewed = index
    title.textContent = `Change ${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`
    for (const lane of lanes) {
      const bounds = markBounds(hunk, lane)
      lane.previewMark.hidden = lane.pane.hidden = !bounds
      if (!bounds) continue
      locateMark(lane.previewMark, bounds.start, bounds.end)
      const { first, last } = changedLines(hunk, lane.side)
      lane.range.textContent = first === last ? `Line ${first}` : `Lines ${first}–${last}`
      const lines = []
      const text = comparison[lane.side]
      for (let line = first; line <= Math.min(last, first + PREVIEW_LINES - 1); line++) {
        const row = document.createElement('code')
        const maxColumn = text.getLineMaxColumn(line)
        const content = text.getValueInRange({
          startLineNumber: line,
          endLineNumber: line,
          startColumn: 1,
          endColumn: Math.min(maxColumn, PREVIEW_COLUMNS + 1),
        })
        row.textContent = maxColumn > PREVIEW_COLUMNS + 1 ? `${content}…` : content
        lines.push(row)
      }
      const remaining = last - first + 1 - lines.length
      lane.code.replaceChildren(...lines)
      if (remaining > 0) {
        const more = document.createElement('div')
        more.className = 'review-map-preview-more'
        more.textContent = `… ${remaining} more ${remaining === 1 ? 'line' : 'lines'}`
        lane.code.append(more)
      }
    }
    preview.hidden = false
    document.addEventListener('keydown', dismissPreview, true)
  }

  function hidePreview() {
    if (preview.hidden) return
    previewed = -1
    preview.hidden = true
    for (const lane of lanes) lane.previewMark.hidden = true
    document.removeEventListener('keydown', dismissPreview, true)
  }

  function dismissPreview(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    hidePreview()
    if (document.activeElement === control) event.preventDefault()
  }

  control.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return
    const target = changeAt(event)
    if (target) showPreview(target.index, target.lane)
  })
  element.addEventListener('pointerleave', hidePreview)
  control.addEventListener('focus', () => {
    if (control.matches(':focus-visible')) showPreview(selected)
  })
  control.addEventListener('blur', hidePreview)
  control.addEventListener('click', event => {
    hidePreview()
    const target = changeAt(event)
    if (target && target.index >= 0) onSelect(target.index)
  })

  control.addEventListener('keydown', event => {
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
    const target = Math.max(0, Math.min(hunks.length - 1, index))
    onSelect(target)
    showPreview(target)
  })

  return { element, update, select }
}
