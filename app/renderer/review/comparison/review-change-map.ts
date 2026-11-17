import { area, curveBumpY } from 'd3-shape'
import type { editor } from 'monaco-editor'
import { requireElement } from '../../shell/workspace/dom.js'

type Side = 'original' | 'modified'

// Merge changes that land on the same part of the track so even dense diffs stay cheap to render.
const TRACK_STEPS = 384
const RIBBON_HEIGHT = 22
const MAX_BACKGROUND_RIBBONS = 64
const MIN_MARK_WIDTH = 4
const MARK_HIT_SLOP = 3
const PREVIEW_LINES = 3
const PREVIEW_COLUMNS = 160
let mapId = 0

interface RibbonEdge {
  start: number
  end: number
  y: number
}

const ribbonShape = area<RibbonEdge>()
  .x0(edge => edge.start)
  .x1(edge => edge.end)
  .y(edge => edge.y)
  .curve(curveBumpY)

function changedLines(hunk: editor.ILineChange, side: Side) {
  return side === 'original'
    ? { first: hunk.originalStartLineNumber, last: hunk.originalEndLineNumber }
    : { first: hunk.modifiedStartLineNumber, last: hunk.modifiedEndLineNumber }
}

function changeKind(hunk: editor.ILineChange) {
  if (!hunk.originalEndLineNumber) return 'insertion'
  if (!hunk.modifiedEndLineNumber) return 'deletion'
  return 'replacement'
}

const kindLabels = { insertion: 'Added', deletion: 'Removed', replacement: 'Modified' }

function lineLabel({ first, last }: { first: number; last: number }) {
  if (!last) return first ? `After line ${first.toLocaleString()}` : 'Start of file'
  if (first === last) return `Line ${first.toLocaleString()}`
  return `Lines ${first.toLocaleString()}–${last.toLocaleString()}`
}

function locateMark(mark: HTMLElement, start: number, end: number) {
  mark.style.setProperty('--mark-start', `${(100 * start) / TRACK_STEPS}%`)
  mark.style.setProperty('--mark-width', `${(100 * (end - start)) / TRACK_STEPS}%`)
}

export function createReviewChangeMap(
  onSelect: (index: number) => void,
  countLines = (model: editor.ITextModel) => model.getLineCount(),
) {
  const element = document.createElement('div')
  const gradientId = `review-map-gradient-${++mapId}`
  element.className = 'review-change-map'
  element.style.setProperty('--map-min-mark-width', `${MIN_MARK_WIDTH}px`)
  element.hidden = true
  element.innerHTML = `
    <div class="review-map-control" role="slider" tabindex="0" aria-label="Change map" aria-valuemin="1" aria-description="Use the arrow keys to jump between changes.">
      <div class="review-map-heading" aria-hidden="true">
        <span class="review-map-title">Change map</span>
        <span class="review-map-hint">Select a mark to jump</span>
        <span class="review-map-viewport-key" hidden>In view</span>
        <span class="review-map-summary"></span>
      </div>
      <div class="review-map-row is-original" aria-hidden="true">
        <span class="review-map-row-label">Git HEAD</span>
        <div class="review-map-lane"><div class="review-map-viewport"></div><div class="review-map-marks"></div><span class="review-map-active" hidden></span><span class="review-map-preview-mark" hidden></span></div>
        <span class="review-map-row-range"></span>
      </div>
      <div class="review-map-ribbon-track" aria-hidden="true">
        <svg viewBox="0 0 ${TRACK_STEPS} ${RIBBON_HEIGHT}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="${RIBBON_HEIGHT}" gradientUnits="userSpaceOnUse">
              <stop class="review-map-ribbon-before" offset="0"/>
              <stop class="review-map-ribbon-after" offset="1"/>
            </linearGradient>
          </defs>
          <g class="review-map-ribbons"></g>
          <path class="review-map-ribbon-preview"/>
          <path class="review-map-ribbon-active"/>
        </svg>
      </div>
      <div class="review-map-row is-working" aria-hidden="true">
        <span class="review-map-row-label">Working file</span>
        <div class="review-map-lane"><div class="review-map-viewport"></div><div class="review-map-marks"></div><span class="review-map-active" hidden></span><span class="review-map-preview-mark" hidden></span></div>
        <span class="review-map-row-range"></span>
      </div>
    </div>
    <div class="review-map-preview-track" aria-hidden="true">
      <div class="review-map-preview" hidden>
        <div class="review-map-preview-title"></div>
        <div class="review-map-preview-panes">
          <div class="review-map-preview-pane is-original">
            <div class="review-map-preview-label"><span class="review-map-preview-version">Git HEAD</span><span class="review-map-preview-range"></span></div>
            <div class="review-map-preview-code"></div>
          </div>
          <div class="review-map-preview-pane is-working">
            <div class="review-map-preview-label"><span class="review-map-preview-version">Working file</span><span class="review-map-preview-range"></span></div>
            <div class="review-map-preview-code"></div>
          </div>
        </div>
      </div>
    </div>`

  const control = requireElement(element, '.review-map-control', HTMLDivElement)
  const viewportKey = requireElement(control, '.review-map-viewport-key', HTMLSpanElement)
  const summary = requireElement(control, '.review-map-summary', HTMLSpanElement)
  const ribbonTrack = requireElement(control, '.review-map-ribbon-track', HTMLDivElement)
  ribbonTrack.style.setProperty('--review-map-gradient', `url(#${gradientId})`)
  const backgroundRibbons = requireElement(ribbonTrack, '.review-map-ribbons', SVGGElement)
  const activeRibbon = requireElement(ribbonTrack, '.review-map-ribbon-active', SVGPathElement)
  const previewRibbon = requireElement(ribbonTrack, '.review-map-ribbon-preview', SVGPathElement)
  const preview = requireElement(element, '.review-map-preview', HTMLDivElement)
  const title = requireElement(preview, '.review-map-preview-title', HTMLDivElement)
  const lanes = (['original', 'modified'] as const).map(side => {
    const match = side === 'original' ? '.is-original' : '.is-working'
    const row = requireElement(control, match, HTMLDivElement)
    const track = requireElement(row, '.review-map-lane', HTMLDivElement)
    const pane = requireElement(preview, match, HTMLDivElement)
    return {
      side,
      track,
      viewport: requireElement(track, '.review-map-viewport', HTMLDivElement),
      viewportSegments: [] as HTMLSpanElement[],
      marks: requireElement(track, '.review-map-marks', HTMLDivElement),
      active: requireElement(track, '.review-map-active', HTMLSpanElement),
      previewMark: requireElement(track, '.review-map-preview-mark', HTMLSpanElement),
      label: requireElement(row, '.review-map-row-label', HTMLSpanElement),
      selectedRange: requireElement(row, '.review-map-row-range', HTMLSpanElement),
      pane,
      versionLabel: requireElement(pane, '.review-map-preview-version', HTMLSpanElement),
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

  function setVersions(original: string, modified: string) {
    for (const [index, lane] of lanes.entries()) {
      const label = index === 0 ? original : modified
      lane.label.textContent = lane.versionLabel.textContent = label
      lane.label.title = label
    }
    const hunk = hunks[selected]
    if (hunk) describeSelection(selected, hunk)
  }

  function markBounds(hunk: editor.ILineChange, { side, lineCount }: (typeof lanes)[number]) {
    const { first, last } = changedLines(hunk, side)
    if (!last) return null
    return {
      start: Math.floor(((first - 1) * TRACK_STEPS) / lineCount),
      end: Math.ceil((last * TRACK_STEPS) / lineCount),
    }
  }

  function paintRibbon(pathElement: SVGPathElement, hunk: editor.ILineChange | undefined) {
    if (!hunk) {
      pathElement.removeAttribute('d')
      return
    }
    const edges = lanes.map((lane, index) => {
      const bounds = markBounds(hunk, lane)
      // Monaco uses the preceding line as the anchor on an empty side (zero at the start).
      const anchor = (changedLines(hunk, lane.side).first * TRACK_STEPS) / lane.lineCount
      return { start: bounds?.start ?? anchor, end: bounds?.end ?? anchor, y: index * RIBBON_HEIGHT }
    })
    pathElement.dataset.kind = changeKind(hunk)
    pathElement.setAttribute('d', ribbonShape(edges) ?? '')
  }

  function update(changes: readonly editor.ILineChange[], comparison: editor.IDiffEditorModel | null) {
    hidePreview()
    control.removeAttribute('data-map-target')
    hunks = changes
    model = comparison
    element.hidden = !hunks.length
    control.setAttribute('aria-valuemax', String(hunks.length))

    for (const lane of lanes) {
      const text = model?.[lane.side]
      lane.lineCount = text ? Math.max(1, countLines(text)) : 1
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
          if (mark) locateMark(mark, start, end)
          mark = document.createElement('span')
          mark.className = 'review-map-mark'
          marks.push(mark)
          start = bounds.start
        }
        end = bounds.end
      }
      if (mark) locateMark(mark, start, end)
      lane.marks.replaceChildren(...marks)
    }

    // Keep dense maps legible by drawing only the selected and previewed ribbons above this limit.
    const visibleHunks = hunks.length <= MAX_BACKGROUND_RIBBONS ? hunks : []
    backgroundRibbons.replaceChildren(
      ...visibleHunks.map((hunk, index) => {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.classList.add('review-map-ribbon')
        path.dataset.hunk = String(index)
        paintRibbon(path, hunk)
        return path
      }),
    )
    paintRibbon(activeRibbon, undefined)
  }

  function updateViewport(diff: editor.IDiffEditor) {
    if (element.hidden) return
    const editors = { original: diff.getOriginalEditor(), modified: diff.getModifiedEditor() }
    for (const lane of lanes) {
      const pane = editors[lane.side]
      const { height, contentWidth } = pane.getLayoutInfo()
      const text = pane.getModel()
      // Inline diffs have no original code pane. Its editor is only as wide as the gutter.
      const ranges =
        height > 0 && contentWidth > 0 && text?.getValueLength()
          ? pane.getVisibleRanges().filter(range => range.startLineNumber <= lane.lineCount)
          : []
      const segments = lane.viewportSegments
      while (segments.length > ranges.length) segments.pop()?.remove()
      for (const [index, { startLineNumber, endLineNumber }] of ranges.entries()) {
        let segment = segments[index]
        if (!segment) {
          segment = document.createElement('span')
          segments.push(segment)
          lane.viewport.append(segment)
        }
        const end = Math.min(endLineNumber, lane.lineCount)
        segment.style.setProperty('--viewport-start', `${(100 * (startLineNumber - 1)) / lane.lineCount}%`)
        segment.style.setProperty('--viewport-size', `${(100 * (end - startLineNumber + 1)) / lane.lineCount}%`)
      }
    }
    viewportKey.hidden = !lanes.some(lane => lane.viewportSegments.length)
  }

  function select(index: number) {
    selected = index
    const hunk = hunks[index]
    activeRibbon.dataset.hunk = String(index)
    paintRibbon(activeRibbon, hunk)
    if (!hunk) return
    for (const lane of lanes) {
      const bounds = markBounds(hunk, lane)
      lane.active.hidden = !bounds
      if (bounds) locateMark(lane.active, bounds.start, bounds.end)
    }
    describeSelection(index, hunk)
    showReadout(previewed >= 0 ? previewed : index)
  }

  function describeSelection(index: number, hunk: editor.ILineChange) {
    const kind = kindLabels[changeKind(hunk)]
    const position = `${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`
    const ranges = lanes.map(
      lane => `${lane.label.textContent}, ${lineLabel(changedLines(hunk, lane.side)).toLowerCase()}`,
    )
    control.setAttribute('aria-valuenow', String(index + 1))
    control.setAttribute('aria-valuetext', `Change ${position}, ${kind.toLowerCase()}. ${ranges.join('. ')}.`)
  }

  function showReadout(index: number) {
    const hunk = hunks[index]
    if (!hunk) return
    const kind = changeKind(hunk)
    const position = `${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`
    summary.textContent = `${kindLabels[kind]} · ${position}`
    summary.dataset.kind = kind
    for (const lane of lanes) lane.selectedRange.textContent = lineLabel(changedLines(hunk, lane.side))
  }

  function nearestChange(lane: (typeof lanes)[number], position: number) {
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

  function changeAt({ clientX, target }: MouseEvent) {
    if (target instanceof SVGPathElement && target.dataset.hunk !== undefined) {
      return { index: Number(target.dataset.hunk) }
    }
    const lane = lanes.find(({ track }) => track === target)
    if (!lane) return null
    const { left, width } = lane.track.getBoundingClientRect()
    if (!width) return null
    const x = clientX - left
    const index = nearestChange(lane, (x / width) * lane.lineCount)
    const hunk = hunks[index]
    const bounds = hunk && markBounds(hunk, lane)
    if (!bounds) return null
    const start = Math.min((width * bounds.start) / TRACK_STEPS, width - MIN_MARK_WIDTH)
    const length = Math.max((width * (bounds.end - bounds.start)) / TRACK_STEPS, MIN_MARK_WIDTH)
    return x >= start - MARK_HIT_SLOP && x <= start + length + MARK_HIT_SLOP ? { index, lane } : null
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
      preview.style.setProperty('--preview-anchor', String((anchor.start + anchor.end) / (2 * TRACK_STEPS)))
    }
    if (index === previewed) return
    previewed = index
    showReadout(index)
    paintRibbon(previewRibbon, hunk)
    title.textContent = `${kindLabels[changeKind(hunk)]} · ${(index + 1).toLocaleString()} of ${hunks.length.toLocaleString()}`
    for (const lane of lanes) {
      const bounds = markBounds(hunk, lane)
      lane.previewMark.hidden = lane.pane.hidden = !bounds
      if (!bounds) continue
      locateMark(lane.previewMark, bounds.start, bounds.end)
      const range = changedLines(hunk, lane.side)
      const { first, last } = range
      lane.range.textContent = lineLabel(range)
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
    showReadout(selected)
    paintRibbon(previewRibbon, undefined)
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
    control.toggleAttribute('data-map-target', Boolean(target))
    if (target) showPreview(target.index, target.lane)
    else hidePreview()
  })
  control.addEventListener('pointerleave', () => {
    control.removeAttribute('data-map-target')
    hidePreview()
  })
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

  return { element, update, updateViewport, select, setVersions }
}
