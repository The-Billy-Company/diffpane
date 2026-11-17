// MONOLITHIC: Queue order, focus, baseline selection and reviewed revisions update together. Extract the review model once keyboard selection and checkpoint replacement have independent coverage.
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { celebrate } from '../../shell/celebration/celebration.ts'
import { projectIcon } from '../../shell/layout/icons.ts'
import { createRollingNumber } from '../../shell/number-flow/number-flow.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { drawReviewArt } from './review-art.ts'

import './change-review.css'

/**
 * @typedef {{
 *   path: string,
 *   worktree?: string,
 *   index?: string,
 *   originalPath?: string | null,
 *   conflicted?: boolean,
 *   reviewVersion?: number,
 * }} ReviewFile
 */
/** @typedef {{ id: number, capturedAt: number | string, error?: string }} ReviewCheckpoint */
/** @typedef {'head' | 'checkpoint'} ReviewBaseline */
/** @typedef {'modified' | 'added'} ReviewFilter */
/** @typedef {'loading' | 'saving' | 'save-failed' | 'closing' | 'ready' | 'failed'} ReviewState */
/**
 * @typedef {{
 *   onOpen: (file: ReviewFile) => unknown,
 *   onBack: () => void,
 *   onProgress: (progress: { pending: number, total: number }) => void,
 *   onCapture: () => Promise<void>,
 *   onBaseline: (baseline: ReviewBaseline) => void,
 *   includeFile?: (file: ReviewFile) => boolean,
 *   laneStatus?: (file: ReviewFile) => 'shared' | 'unrecorded' | null,
 * }} ChangeReviewOptions
 */
/**
 * @typedef {{
 *   element: HTMLDivElement,
 *   location: HTMLSpanElement,
 *   status: HTMLSpanElement,
 *   symbol: HTMLSpanElement,
 *   label: HTMLSpanElement,
 *   projection: number,
 *   description: string,
 * }} ReviewRow
 */

const ROW_HEIGHT = 44
const OVERSCAN = 4
const MAX_PROGRESS_SEGMENTS = 40
const CHECKPOINT_TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})
let instance = 0

/** @param {string} path */
function icon(path) {
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

const GLYPHS = {
  back: 'M13 8H3m4-4L3 8l4 4',
  previous: 'm10 4-4 4 4 4',
  next: 'm6 4 4 4-4 4',
  check: 'm3.5 8 3 3 6-6',
  undo: 'M6 4 3 7l3 3M3 7h6.5a3 3 0 0 1 0 6H8',
  compare: 'M2 3h12v10H2zM8 3v10M4 6h2m4 4h2',
  checkpoint: 'M3.5 13.5v-11m0 1h8l-2 3 2 3h-8',
}

/** @type {Readonly<Record<string, string>>} */
const STATUS_LABELS = {
  '!': 'Merge conflict',
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
  T: 'Type changed',
  U: 'Untracked',
}

/** @param {ReviewFile} file */
function changeStatus(file) {
  if (file.conflicted) return '!'
  if (file.worktree === 'D') return 'D'
  if (file.index === 'A' || file.index === 'R' || file.index === 'C') return file.index
  if (file.worktree === '?') return file.index === 'D' ? 'M' : 'U'
  return file.worktree && Object.hasOwn(STATUS_LABELS, file.worktree) ? file.worktree : (file.index ?? '').trim() || 'M'
}

/** @param {ReviewFile} file @returns {ReviewFilter} */
function fileFilter(file) {
  const status = changeStatus(file)
  return status === 'A' || status === 'U' ? 'added' : 'modified'
}

/** @param {HTMLElement} container @param {ChangeReviewOptions} options */
export function createChangeReview(
  container,
  { onOpen, onBack, onProgress, onCapture, onBaseline, includeFile = () => true, laneStatus = () => null },
) {
  const id = `change-review-${++instance}`
  container.classList.add('change-review')
  container.setAttribute('aria-labelledby', `${id}-title`)
  container.hidden = true
  container.style.setProperty('--change-review-row-height', `${ROW_HEIGHT}px`)
  container.innerHTML = `
    <div class="change-review-masthead">
      <header class="change-review-heading">
        <h2 id="${id}-title">Changes</h2>
        <button type="button" class="change-review-back" aria-label="Back to files" title="Back to files">${icon(GLYPHS.back)}<span>Files</span></button>
      </header>
      <div class="change-review-progress" hidden>
        <div class="change-review-progress-readout" aria-hidden="true">
          <span class="change-review-count"><span class="change-review-total"></span></span>
          <span class="change-review-progress-label">Files reviewed</span>
        </div>
        <div class="change-review-progress-strip" aria-hidden="true"></div>
        <span class="change-review-progress-announcement" role="status"></span>
        <progress aria-label="Review progress" max="1" value="0"></progress>
      </div>
    </div>
    <div class="change-review-context">
      <div class="change-review-baseline">
        <div class="change-review-baseline-actions">
          <label for="${id}-baseline">Compare</label>
          <span class="change-review-baseline-default">Git HEAD</span>
          <select id="${id}-baseline" class="change-review-baseline-select" aria-label="Compare against" aria-describedby="${id}-checkpoint-time" hidden>
            <option value="head">Git HEAD</option>
            <option value="checkpoint">Checkpoint</option>
          </select>
          <button type="button" class="change-review-capture">${icon(GLYPHS.checkpoint)}<span></span></button>
        </div>
        <time class="change-review-checkpoint-time" id="${id}-checkpoint-time" aria-live="polite" hidden></time>
        <p class="change-review-error change-review-checkpoint-error" role="status" hidden></p>
      </div>
      <div class="change-review-lane" hidden></div>
    </div>
    <div class="change-review-filters" role="group" aria-label="File change filter" hidden>
      <button type="button" data-filter="modified" aria-label="Modified" aria-describedby="${id}-modified" aria-pressed="true">Modified <span id="${id}-modified"></span></button>
      <button type="button" data-filter="added" aria-label="Added" aria-describedby="${id}-added" aria-pressed="false">Added <span id="${id}-added"></span></button>
    </div>
    <div class="change-review-body">
      <div class="change-review-list" role="listbox" aria-label="Changed files" tabindex="0">
        <div class="change-review-rows" role="presentation"></div>
      </div>
      <div class="change-review-empty" hidden>
        <div class="change-review-empty-content">
          <svg class="change-review-empty-art" viewBox="8 0 84 56" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>
          <h3 tabindex="-1"></h3>
          <p></p>
        </div>
      </div>
    </div>
    <footer class="change-review-footer" hidden>
      <p class="change-review-error" role="status" hidden></p>
      <div class="change-review-footer-top">
        <p class="change-review-position" aria-live="polite"></p>
        <div class="change-review-nav" role="group" aria-label="Navigate changed files">
          <button type="button" data-direction="previous" aria-label="Previous changed file" title="Previous changed file">${icon(GLYPHS.previous)}</button>
          <button type="button" data-direction="next" aria-label="Next changed file" title="Next changed file">${icon(GLYPHS.next)}</button>
        </div>
      </div>
      <button class="change-review-mark" type="button">
        <span class="change-review-mark-icon"></span>
        <span class="change-review-mark-label"></span>
      </button>
    </footer>`

  const laneHost = requireElement(container, '.change-review-lane', HTMLDivElement)
  const baselineDefault = requireElement(container, '.change-review-baseline-default', HTMLSpanElement)
  const baselineSelect = requireElement(container, '.change-review-baseline-select', HTMLSelectElement)
  const captureButton = requireElement(container, '.change-review-capture', HTMLButtonElement)
  const captureLabel = requireElement(captureButton, 'span', HTMLSpanElement)
  const capturedTime = requireElement(container, 'time', HTMLTimeElement)
  const checkpointError = requireElement(container, '.change-review-checkpoint-error', HTMLParagraphElement)
  const count = requireElement(container, '.change-review-count', HTMLSpanElement)
  const countTotal = requireElement(count, '.change-review-total', HTMLSpanElement)
  const reviewedCount = createRollingNumber()
  count.prepend(reviewedCount)
  const progress = requireElement(container, 'progress', HTMLProgressElement)
  const progressGroup = requireElement(container, '.change-review-progress', HTMLDivElement)
  const progressLabel = requireElement(progressGroup, '.change-review-progress-label', HTMLSpanElement)
  const progressAnnouncement = requireElement(progressGroup, '.change-review-progress-announcement', HTMLSpanElement)
  const progressStrip = requireElement(progressGroup, '.change-review-progress-strip', HTMLDivElement)
  const filterGroup = requireElement(container, '.change-review-filters', HTMLDivElement)
  const filters = [...filterGroup.querySelectorAll('button')].map(button => ({
    button,
    label: requireElement(button, 'span', HTMLSpanElement),
  }))
  const list = requireElement(container, '.change-review-list', HTMLDivElement)
  const rows = requireElement(container, '.change-review-rows', HTMLDivElement)
  const empty = requireElement(container, '.change-review-empty', HTMLDivElement)
  const emptyArt = requireElement(empty, '.change-review-empty-art', SVGSVGElement)
  const emptyTitle = requireElement(empty, 'h3', HTMLHeadingElement)
  const emptyDescription = requireElement(empty, 'p', HTMLParagraphElement)
  const footer = requireElement(container, '.change-review-footer', HTMLElement)
  const position = requireElement(container, '.change-review-position', HTMLParagraphElement)
  const error = requireElement(footer, '.change-review-error', HTMLParagraphElement)
  const previous = requireElement(container, '[data-direction="previous"]', HTMLButtonElement)
  const next = requireElement(container, '[data-direction="next"]', HTMLButtonElement)
  const mark = requireElement(container, '.change-review-mark', HTMLButtonElement)
  const markIcon = requireElement(mark, '.change-review-mark-icon', HTMLSpanElement)
  const markLabel = requireElement(mark, '.change-review-mark-label', HTMLSpanElement)
  /** @type {Map<string, number>} */
  const headReviewed = new Map()
  /** @type {Map<string, number>} */
  const checkpointReviewed = new Map()
  /** @type {Map<string, ReviewRow>} */
  const mounted = new Map()
  /** @type {Map<string, number>} */
  const progressIndexes = new Map()
  /** @type {HTMLSpanElement[]} */
  const progressSegments = []
  /** @type {HTMLSpanElement | undefined} */
  let currentSegment
  let reviewed = headReviewed
  /** @type {ReviewBaseline} */
  let baseline = 'head'
  /** @type {ReviewCheckpoint | null | undefined} */
  let checkpoint = null
  let capturing = false
  let captureError = ''
  let resetScrollOnUpdate = false
  /** @type {Map<string, ReviewFile>} */
  const changes = new Map()
  /** @type {ReviewFile[]} */
  const entries = []
  /** @type {number[]} */
  const entryIndexes = []
  /** @type {ReviewFilter | null} */
  let filter = null
  let unreviewedEntries = 0
  /** @type {string | null} */
  let currentPath = null
  /** @type {number | null} */
  let currentVersion = null
  /** @type {ReviewState | null} */
  let currentState = null
  /** @type {string | null} */
  let activePath = null
  /** @type {string | null} */
  let openingPath = null
  let projection = 0
  let request = 0
  /** @type {number | null} */
  let frame = null
  let disposed = false

  function renderBaseline() {
    baselineSelect.hidden = !checkpoint
    baselineDefault.hidden = Boolean(checkpoint)
    baselineSelect.disabled = capturing
    if (baselineSelect.value !== baseline) baselineSelect.value = baseline
    baselineSelect.toggleAttribute('data-active', baseline === 'checkpoint')
    captureButton.setAttribute('aria-disabled', String(capturing))
    const action = capturing ? 'Capturing…' : checkpoint ? 'Replace checkpoint' : 'Capture checkpoint'
    captureButton.setAttribute('aria-label', capturing ? 'Capturing checkpoint' : action)
    if (captureLabel.textContent !== action) captureLabel.textContent = action
    captureButton.toggleAttribute('data-loading-status', capturing)
    const timestamp = checkpoint ? new Date(checkpoint.capturedAt) : null
    const validTime = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : null
    const timeLabel = validTime ? CHECKPOINT_TIME.format(validTime) : ''
    capturedTime.hidden = !validTime
    if (validTime) capturedTime.dateTime = validTime.toISOString()
    else capturedTime.removeAttribute('datetime')
    if (capturedTime.textContent !== timeLabel) capturedTime.textContent = timeLabel
    captureButton.title =
      checkpoint && !capturing
        ? `Replace checkpoint and start a new review${timeLabel ? ` · Captured ${timeLabel}` : ''}`
        : action
    const message = captureError || (baseline === 'checkpoint' ? (checkpoint?.error ?? '') : '')
    checkpointError.hidden = !message
    if (checkpointError.textContent !== message) checkpointError.textContent = message
  }

  async function capture() {
    if (capturing || disposed) return
    capturing = true
    captureError = ''
    renderBaseline()
    try {
      const result = await attemptAsync(onCapture, { operation: 'Capture review checkpoint' })
      if (!result.ok && !disposed) {
        reportError(result.error, { silent: true })
        captureError = result.error.message
      }
    } finally {
      capturing = false
      if (!disposed) renderBaseline()
    }
  }

  function focusQueue() {
    const target = !list.hidden ? list : !filterGroup.hidden || checkpoint ? emptyTitle : captureButton
    target.focus({ preventScroll: true })
  }

  /** @param {string | null} path */
  function entryIndex(path) {
    const progressIndex = path === null ? undefined : progressIndexes.get(path)
    const index = progressIndex === undefined ? undefined : entryIndexes[progressIndex]
    return index !== -1 ? index : undefined
  }

  function renderRows() {
    if (container.hidden || disposed) return
    const { scrollTop, clientHeight } = list
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(entries.length, Math.ceil((scrollTop + clientHeight) / ROW_HEIGHT) + OVERSCAN)
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset)
    const activeIndex = entryIndex(activePath)
    // Keep the keyboard cursor accessible when scrolling takes it out of the window.
    if (activeIndex !== undefined) {
      if (activeIndex < start) indexes.unshift(activeIndex)
      else if (activeIndex >= end) indexes.push(activeIndex)
    }
    const retained = new Set()
    const loadingPath = openingPath ?? (currentState === 'loading' ? currentPath : null)
    const selectedPath = currentState === null ? null : currentPath
    const size = String(entries.length)
    let activeId = ''
    let cursor = rows.firstElementChild
    for (const index of indexes) {
      const file = entries[index]
      if (!file) continue
      retained.add(file.path)
      let row = mounted.get(file.path)
      if (!row) {
        const element = document.createElement('div')
        element.className = 'change-review-row'
        element.dataset.path = file.path
        element.setAttribute('role', 'option')
        element.innerHTML = `<img class="change-review-file-icon" alt=""><div class="change-review-label"><span class="change-review-name"></span><span class="change-review-location"></span></div><span class="change-review-reviewed" aria-hidden="true">${icon(GLYPHS.check)}</span><span class="change-review-status" aria-hidden="true"><span class="change-review-status-symbol"></span><span class="change-review-status-label"></span></span>`
        const name = file.path.slice(file.path.lastIndexOf('/') + 1)
        const image = requireElement(element, 'img', HTMLImageElement)
        const source = projectIcon({ kind: 'file', name })
        if (source) image.src = source
        requireElement(element, '.change-review-name', HTMLSpanElement).textContent = name
        row = {
          element,
          location: requireElement(element, '.change-review-location', HTMLSpanElement),
          status: requireElement(element, '.change-review-status', HTMLSpanElement),
          symbol: requireElement(element, '.change-review-status-symbol', HTMLSpanElement),
          label: requireElement(element, '.change-review-status-label', HTMLSpanElement),
          projection: -1,
          description: '',
        }
        mounted.set(file.path, row)
      }
      const { element } = row
      if (element !== cursor) rows.insertBefore(element, cursor)
      cursor = element.nextElementSibling
      if (row.projection !== projection) {
        row.projection = projection
        const rowId = `${id}-row-${index}`
        if (element.id !== rowId) {
          element.id = rowId
          element.style.top = `${index * ROW_HEIGHT}px`
          element.setAttribute('aria-posinset', String(index + 1))
        }
        if (element.getAttribute('aria-setsize') !== size) element.setAttribute('aria-setsize', size)
        const status = changeStatus(file)
        const label = STATUS_LABELS[status] ?? 'Changed'
        const lane = laneStatus(file)
        const laneLabel = lane === 'shared' ? 'Shared path' : lane === 'unrecorded' ? 'Lane unknown' : ''
        const oldPath = file.originalPath
        const directory = file.path.slice(0, Math.max(0, file.path.lastIndexOf('/')))
        const location = [laneLabel, directory, oldPath ? `From ${oldPath}` : ''].filter(Boolean).join(' · ')
        const done = reviewed.has(file.path)
        element.dataset.reviewed = String(done)
        row.description = `${label}, ${file.path}${oldPath ? `, from ${oldPath}` : ''}${laneLabel ? `, ${laneLabel}` : ''}${done ? ', reviewed' : ''}`
        const title = `${label} · ${oldPath ? `${oldPath} → ` : ''}${file.path}${done ? ' · Reviewed' : ''}`
        if (element.title !== title) element.title = title
        if (row.location.textContent !== location) row.location.textContent = location
        if (element.dataset.status !== status) {
          element.dataset.status = status
          row.symbol.textContent = status
          row.label.textContent = label
        }
      }
      const active = String(file.path === activePath)
      const loading = String(file.path === loadingPath)
      const selected = String(file.path === selectedPath)
      const description = file.path === loadingPath ? `${row.description}, loading comparison` : row.description
      if (element.dataset.active !== active) element.dataset.active = active
      if (element.dataset.loading !== loading) {
        element.dataset.loading = loading
        row.status.toggleAttribute('data-loading-status', loading === 'true')
      }
      if (element.getAttribute('aria-selected') !== selected) element.setAttribute('aria-selected', selected)
      if (element.getAttribute('aria-label') !== description) element.setAttribute('aria-label', description)
      if (file.path === activePath) activeId = element.id
    }
    for (const [path, { element }] of mounted) {
      if (retained.has(path)) continue
      element.remove()
      mounted.delete(path)
    }
    if (activeId) {
      if (list.getAttribute('aria-activedescendant') !== activeId) list.setAttribute('aria-activedescendant', activeId)
    } else list.removeAttribute('aria-activedescendant')
  }

  function scheduleRows() {
    if (frame !== null || container.hidden || disposed) return
    frame = requestAnimationFrame(() => {
      frame = null
      renderRows()
    })
  }

  function revealActive() {
    const index = entryIndex(activePath)
    if (index === undefined || container.hidden) return
    const top = index * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
  }

  function canMark() {
    return (
      !(baseline === 'checkpoint' && checkpoint?.error) &&
      !openingPath &&
      currentState === 'ready' &&
      currentPath !== null &&
      entryIndex(currentPath) !== undefined &&
      Number.isSafeInteger(currentVersion) &&
      changes.get(currentPath)?.reviewVersion === currentVersion
    )
  }

  function comparisonPath() {
    return openingPath ?? (currentState === null ? null : currentPath)
  }

  function comparisonIndex() {
    return entryIndex(comparisonPath())
  }

  function renderControls() {
    const path = comparisonPath()
    const progressIndex = path === null ? undefined : progressIndexes.get(path)
    const segment =
      progressIndex === undefined
        ? undefined
        : progressSegments[Math.floor((progressIndex * progressSegments.length) / progressIndexes.size)]
    if (segment !== currentSegment) {
      currentSegment?.removeAttribute('data-current')
      segment?.setAttribute('data-current', '')
      currentSegment = segment
    }

    const index = comparisonIndex()
    const canNavigate = entries.length > 1 || (entries.length === 1 && index === undefined)
    previous.disabled = !canNavigate
    next.disabled = !canNavigate
    const state = openingPath ? 'loading' : index === undefined ? null : currentState
    const positionText =
      index === undefined ? '' : `File ${(index + 1).toLocaleString()} of ${entries.length.toLocaleString()}`
    if (position.textContent !== positionText) position.textContent = positionText
    position.hidden = !positionText

    const reviewable = canMark()
    const done = currentPath !== null && reviewed.has(currentPath)
    let action = 'Open comparison'
    /** @type {keyof typeof GLYPHS} */
    let symbol = 'compare'
    let disabled = !entries.length
    if (baseline === 'checkpoint' && checkpoint?.error) {
      action = 'Checkpoint unavailable'
      disabled = true
    } else if (reviewable) {
      action = done ? 'Undo review' : unreviewedEntries > 1 ? 'Mark reviewed & next' : 'Mark reviewed'
      symbol = done ? 'undo' : 'check'
    } else if (state === 'failed') {
      action = 'Retry comparison'
      symbol = 'undo'
    } else if (state) {
      action = {
        loading: 'Loading comparison…',
        saving: 'Saving changes…',
        'save-failed': 'Save required to continue',
        closing: 'Closing…',
        ready: 'Updating comparison…',
      }[state]
      disabled = true
    }
    mark.setAttribute('aria-disabled', String(disabled))
    if (markLabel.textContent !== action) markLabel.textContent = action
    markIcon.toggleAttribute('data-loading-status', state === 'loading' || state === 'saving')
    if (markIcon.dataset.icon !== symbol) {
      markIcon.dataset.icon = symbol
      markIcon.innerHTML = icon(GLYPHS[symbol])
    }
  }

  let lastTotal = -1
  let lastDone = -1

  /** @param {number[]} reviewedPositions */
  function renderProgressStrip(reviewedPositions) {
    const fileCount = progressIndexes.size
    const segmentCount = Math.min(fileCount, MAX_PROGRESS_SEGMENTS)
    if (progressSegments.length !== segmentCount) {
      progressSegments.length = Math.min(progressSegments.length, segmentCount)
      while (progressSegments.length < segmentCount) {
        const segment = document.createElement('span')
        segment.className = 'change-review-progress-segment'
        progressSegments.push(segment)
      }
      progressStrip.replaceChildren(...progressSegments)
    }

    // Above the segment limit, fill each group in proportion to its reviewed files.
    const reviewedPerSegment = new Uint32Array(segmentCount)
    for (const index of reviewedPositions) {
      const bucket = Math.floor((index * segmentCount) / fileCount)
      reviewedPerSegment[bucket] = (reviewedPerSegment[bucket] ?? 0) + 1
    }
    for (const [index, segment] of progressSegments.entries()) {
      const start = Math.ceil((index * fileCount) / segmentCount)
      const end = Math.ceil(((index + 1) * fileCount) / segmentCount)
      const share = `${(100 * (reviewedPerSegment[index] ?? 0)) / (end - start)}%`
      if (segment.style.getPropertyValue('--reviewed-share') !== share)
        segment.style.setProperty('--reviewed-share', share)
    }
  }

  /** @param {number} total @param {number[]} reviewedPositions @param {boolean} animate */
  function updateProgress(total, reviewedPositions, animate) {
    const done = reviewedPositions.length
    const complete = total > 0 && done === total
    const totalLabel = total.toLocaleString()
    const readout = `/ ${totalLabel}`
    if (countTotal.textContent !== readout) countTotal.textContent = readout
    reviewedCount.animated = animate && !progressGroup.hidden && total > 0
    if (reviewedCount.value !== done) reviewedCount.update(done)
    const summary = `${done.toLocaleString()} of ${totalLabel} reviewed`
    if (progressAnnouncement.textContent !== summary) progressAnnouncement.textContent = summary
    const label = complete ? 'Review complete' : 'Files reviewed'
    if (progressLabel.textContent !== label) progressLabel.textContent = label
    progress.max = total || 1
    progress.value = done
    progress.setAttribute('aria-valuetext', summary)
    container.dataset.complete = String(complete)
    renderProgressStrip(reviewedPositions)
    reportProgress()
  }

  function reportProgress() {
    const all = changes.size
    if (lastTotal !== all || lastDone !== reviewed.size) {
      lastTotal = all
      lastDone = reviewed.size
      onProgress({ pending: all - reviewed.size, total: all })
    }
  }

  /** @param {number} scopedTotal @param {ReviewFilter} selectedFilter */
  function renderEmpty(scopedTotal, selectedFilter) {
    const cleanState = baseline === 'head' ? 'head' : checkpoint?.error ? 'error' : 'checkpoint'
    const key = !changes.size ? cleanState : !scopedTotal ? 'scope' : selectedFilter
    if (empty.dataset.state === key) return
    empty.dataset.state = key
    drawReviewArt(emptyArt, key === 'modified' || key === 'added' ? 'scope' : key)
    const [title, description] = {
      head: ['Working tree is clean', 'New changes will appear here as they happen.'],
      checkpoint: ['No changes since checkpoint', 'New changes will appear here as they happen.'],
      error: ['Checkpoint comparison unavailable'],
      scope: ['No changes in this lane', 'Choose All changes to see the full comparison.'],
      modified: ['No modified files'],
      added: ['No added files'],
    }[key]
    emptyTitle.textContent = title ?? ''
    emptyDescription.textContent = description ?? ''
    emptyDescription.hidden = !description
  }

  function project({ resetScroll = false, animateProgress = true } = {}) {
    const { scrollTop } = list
    const anchor = entries[Math.floor(scrollTop / ROW_HEIGHT)]?.path
    const offset = scrollTop % ROW_HEIGHT
    entries.length = 0
    entryIndexes.length = 0
    progressIndexes.clear()
    projection++
    if (filter === null) {
      for (const file of changes.values()) {
        if (includeFile(file) && fileFilter(file) === 'modified') {
          filter = 'modified'
          break
        }
      }
    }
    const selectedFilter = filter ?? 'added'
    const counts = { modified: 0, added: 0 }
    const reviewedPositions = []
    unreviewedEntries = 0
    for (const file of changes.values()) {
      if (!includeFile(file)) continue
      const index = progressIndexes.size
      progressIndexes.set(file.path, index)
      const isReviewed = reviewed.has(file.path)
      if (isReviewed) reviewedPositions.push(index)
      const category = fileFilter(file)
      counts[category]++
      const matches = category === selectedFilter
      entryIndexes.push(matches ? entries.length : -1)
      if (matches) {
        entries.push(file)
        if (!isReviewed) unreviewedEntries++
      }
    }
    const scopedTotal = progressIndexes.size
    if (scopedTotal) filter = selectedFilter
    updateProgress(scopedTotal, reviewedPositions, animateProgress)
    const activeRemoved = activePath !== null && entryIndex(activePath) === undefined
    if (activePath === null || activeRemoved)
      activePath = entryIndex(currentPath) !== undefined ? currentPath : (entries[0]?.path ?? null)
    rows.style.height = `${entries.length * ROW_HEIGHT}px`
    if (resetScroll) list.scrollTop = 0
    else if (anchor !== undefined) {
      const index = entryIndex(anchor)
      if (index !== undefined) list.scrollTop = index * ROW_HEIGHT + offset
    }
    for (const { button, label } of filters) {
      const total = button.dataset.filter === 'added' ? counts.added : counts.modified
      button.setAttribute('aria-pressed', String(button.dataset.filter === selectedFilter))
      const value = total.toLocaleString()
      if (label.textContent !== value) label.textContent = value
    }
    const focused = document.activeElement
    const isEmpty = entries.length === 0
    if (isEmpty) renderEmpty(scopedTotal, selectedFilter)
    progressGroup.hidden = filterGroup.hidden = scopedTotal === 0
    empty.hidden = !isEmpty
    list.hidden = footer.hidden = isEmpty
    if (activeRemoved && focused === list) revealActive()
    renderControls()
    renderRows()
    const focusHidden =
      (filterGroup.hidden && filterGroup.contains(focused)) ||
      (isEmpty && (focused === list || footer.contains(focused))) ||
      (!isEmpty && empty.contains(focused))
    if (focusHidden) focusQueue()
  }

  /** @param {ReviewFile | undefined} file */
  async function choose(file) {
    if (!file || disposed) return
    const generation = ++request
    openingPath = file.path
    activePath = file.path
    error.hidden = true
    revealActive()
    renderControls()
    renderRows()
    try {
      const result = await attemptAsync(() => onOpen(file), { operation: 'Open review comparison' })
      if (generation !== request || disposed) return
      if (!result.ok) {
        reportError(result.error, { silent: true })
        error.textContent = result.error.message
        error.hidden = false
      } else if (result.value === false && entryIndex(currentPath) !== undefined) activePath = currentPath
    } finally {
      if (generation === request && !disposed) {
        openingPath = null
        revealActive()
        renderControls()
        renderRows()
      }
    }
  }

  /** @param {ReviewFile | undefined} file */
  function openComparison(file) {
    runTask('Open review comparison', () => choose(file))
  }

  /** @param {-1 | 1} direction */
  function adjacent(direction) {
    const current = comparisonIndex()
    if (current === undefined) return direction > 0 ? entries[0] : entries.at(-1)
    return entries[(current + direction + entries.length) % entries.length]
  }

  function markCurrent() {
    const index = entryIndex(currentPath)
    if (!canMark() || currentPath === null || currentVersion === null || index === undefined) return
    if (reviewed.has(currentPath)) {
      reviewed.delete(currentPath)
      project()
      return
    }
    reviewed.set(currentPath, currentVersion)
    project()
    if (container.dataset.complete === 'true')
      celebrate('review', progressStrip, container, () => !disposed && container.dataset.complete === 'true')
    if (!unreviewedEntries) return
    for (let offset = 1; offset < entries.length; offset++) {
      const following = entries[(index + offset) % entries.length]
      if (following && !reviewed.has(following.path)) {
        openComparison(following)
        break
      }
    }
  }

  /** @param {KeyboardEvent} event */
  function navigateList(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || entries.length === 0) return
    const index = entryIndex(activePath) ?? 0
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT))
    /** @type {Record<string, number>} */
    const movement = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      PageDown: index + page,
      PageUp: index - page,
      Home: 0,
      End: entries.length - 1,
    }
    const destination = Object.hasOwn(movement, event.key) ? movement[event.key] : undefined
    if (destination !== undefined) {
      event.preventDefault()
      activePath = entries[Math.min(entries.length - 1, Math.max(0, destination))]?.path ?? activePath
      revealActive()
      renderRows()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openComparison(entries[index])
    }
  }

  /** @param {ReviewFilter} nextFilter */
  function selectFilter(nextFilter) {
    if (nextFilter === filter) return
    filter = nextFilter
    activePath = currentPath
    error.hidden = true
    project({ resetScroll: true })
    revealActive()
    renderRows()
  }

  for (const { button } of filters)
    button.addEventListener('click', () => {
      const selected = button.dataset.filter
      if (selected === 'modified' || selected === 'added') selectFilter(selected)
    })
  captureButton.addEventListener('click', () => runTask('Capture review checkpoint', capture))
  baselineSelect.addEventListener('change', () => {
    const value = baselineSelect.value
    if (value === 'head' || value === 'checkpoint') onBaseline(value)
  })
  requireElement(container, '.change-review-back', HTMLButtonElement).addEventListener('click', onBack)
  list.addEventListener('scroll', scheduleRows, { passive: true })
  list.addEventListener('focus', () => {
    if (!list.matches(':focus-visible')) return
    revealActive()
    renderRows()
  })
  list.addEventListener('keydown', navigateList)
  list.addEventListener('click', event => {
    const row = event.target instanceof Element ? event.target.closest('.change-review-row') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.path) return
    focusQueue()
    openComparison(changes.get(row.dataset.path))
  })
  previous.addEventListener('click', () => openComparison(adjacent(-1)))
  next.addEventListener('click', () => openComparison(adjacent(1)))
  mark.addEventListener('click', () => {
    if (mark.getAttribute('aria-disabled') === 'true') return
    if (canMark()) markCurrent()
    else {
      const path = comparisonIndex() === undefined ? activePath : currentPath
      if (path !== null) openComparison(changes.get(path))
    }
  })
  const resize = new ResizeObserver(scheduleRows)
  resize.observe(list)
  renderBaseline()

  return {
    laneHost,
    refreshScope() {
      if (!container.hidden) project({ resetScroll: true, animateProgress: false })
    },
    /** @param {ReviewBaseline} mode @param {ReviewCheckpoint | null} [nextCheckpoint] */
    setBaseline(mode, nextCheckpoint) {
      const replaced = checkpoint?.id !== nextCheckpoint?.id
      const switched = mode !== baseline || (mode === 'checkpoint' && replaced)
      checkpoint = nextCheckpoint
      if (replaced) checkpointReviewed.clear()
      if (switched) {
        baseline = mode
        reviewed = mode === 'head' ? headReviewed : checkpointReviewed
        request++
        openingPath = null
        currentState = null
        currentVersion = null
        activePath = currentPath
        filter = null
        error.hidden = true
        resetScrollOnUpdate = true
      }
      renderBaseline()
    },
    /** @param {ReviewFile[]} files */
    update(files) {
      changes.clear()
      for (const file of files) changes.set(file.path, file)
      for (const [path, version] of reviewed) {
        if (changes.get(path)?.reviewVersion !== version) reviewed.delete(path)
      }
      if (!container.hidden) {
        project({ resetScroll: resetScrollOnUpdate, animateProgress: !resetScrollOnUpdate })
        resetScrollOnUpdate = false
      } else reportProgress()
    },
    /** @param {string | null} path @param {ReviewState | null} state @param {number | null} version */
    setCurrent(path, state, version) {
      if (path === currentPath && state === currentState && version === currentVersion) return
      const moved = path !== currentPath
      currentPath = path
      currentState = state
      currentVersion = version
      if (moved && (container.hidden || entryIndex(path) !== undefined)) {
        activePath = path
        revealActive()
      }
      if (!container.hidden) {
        renderControls()
        renderRows()
      }
    },
    /** @param {boolean} visible */
    setVisible(visible) {
      if (visible === !container.hidden) return
      container.hidden = !visible
      if (visible) {
        project({ resetScroll: resetScrollOnUpdate, animateProgress: false })
        resetScrollOnUpdate = false
        revealActive()
        renderRows()
      } else {
        reviewedCount.animated = false
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        progressIndexes.clear()
        entries.length = 0
        entryIndexes.length = 0
        mounted.clear()
        rows.replaceChildren()
        list.removeAttribute('aria-activedescendant')
      }
    },
    focus: focusQueue,
    dispose() {
      disposed = true
      resize.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      container.replaceChildren()
      mounted.clear()
    },
  }
}
