import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js'
import { createRollingNumber } from '../../shell/number-flow/number-flow.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createReviewChangeMap } from './review-change-map.ts'

import './review-focus.css'

/** @typedef {'focus' | 'full'} ReviewScope */

const positionFormat = new Intl.NumberFormat(undefined, { numberingSystem: 'latn' })

/** @param {'up' | 'down'} direction */
function chevron(direction) {
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${direction === 'up' ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

/**
 * @param {import('monaco-editor').editor.IEditorDecorationsCollection | null} marker
 * @param {number | undefined} line
 * @param {number | undefined} end
 */
function markLine(marker, line, end) {
  marker?.set(
    end && line !== undefined
      ? [
          {
            range: { startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 1 },
            options: { isWholeLine: true, className: 'review-hunk-active' },
          },
        ]
      : [],
  )
}

/** @param {{ onScope: (scope: ReviewScope) => void }} options */
export function createReviewFocus({ onScope }) {
  const bar = document.createElement('div')
  bar.className = 'review-hunk-bar'
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', 'Changes in this file')
  bar.hidden = true
  bar.innerHTML = `
    <button type="button" class="review-hunk-prev" aria-label="Previous change in file" title="Previous change in file">${chevron('up')}</button>
    <span class="review-hunk-position" aria-hidden="true"></span>
    <span class="review-hunk-announcement" role="status"></span>
    <button type="button" class="review-hunk-next" aria-label="Next change in file" title="Next change in file">${chevron('down')}</button>
    <button type="button" class="review-hunk-replay" aria-label="Replay change" aria-haspopup="dialog" title="Replay change" hidden>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.75a.5.5 0 0 1 .77-.42l6.5 4.25a.5.5 0 0 1 0 .84l-6.5 4.25a.5.5 0 0 1-.77-.42z" fill="currentColor"/></svg>
      <span aria-hidden="true">Replay</span>
    </button>`

  const position = requireElement(bar, '.review-hunk-position', HTMLSpanElement)
  const positionNumber = createRollingNumber()
  const positionEnd = document.createTextNode('')
  position.append(positionNumber, positionEnd)
  const announcement = requireElement(bar, '.review-hunk-announcement', HTMLSpanElement)
  const previous = requireElement(bar, '.review-hunk-prev', HTMLButtonElement)
  const next = requireElement(bar, '.review-hunk-next', HTMLButtonElement)
  const replayButton = requireElement(bar, '.review-hunk-replay', HTMLButtonElement)
  const scopeControl = document.createElement('button')
  scopeControl.type = 'button'
  scopeControl.hidden = true
  const changeMap = createReviewChangeMap(jump)
  /** @type {import('monaco-editor').editor.IDiffEditor | null} */
  let editor = null
  /** @type {{ originalAriaLabel?: string, modifiedAriaLabel?: string }} */
  let labels = {}
  /** @type {import('monaco-editor').IDisposable[]} */
  const listeners = []
  /** @type {import('monaco-editor').editor.IEditorDecorationsCollection | null} */
  let originalMarker = null
  /** @type {import('monaco-editor').editor.IEditorDecorationsCollection | null} */
  let workingMarker = null
  /** @type {ReviewScope} */
  let scope = 'focus'
  /** @type {readonly import('monaco-editor').editor.ILineChange[]} */
  let hunks = []
  let baseline = 'Git HEAD'
  let replayPending = false
  /** @type {HTMLDialogElement | undefined} */
  let replayDialog
  let index = 0
  let collapsed = false
  let revealOnFirstDiff = false
  /** @type {number | null} */
  let frame = null
  /** @type {number | null} */
  let viewportFrame = null

  /** @param {{ message?: string, direction?: -1 | 0 | 1 }} [options] */
  function paint({ message = '', direction = 0 } = {}) {
    const current = index + 1
    const total = positionFormat.format(hunks.length)
    const tail = message || `/${total}`
    const spoken = message || `Change ${positionFormat.format(current)} of ${total}`
    positionNumber.hidden = Boolean(message)
    if (positionEnd.data !== tail) positionEnd.data = tail
    if (message) positionNumber.animated = false
    else if (positionNumber.value !== current) {
      positionNumber.animated = direction !== 0
      positionNumber.trend = direction
      positionNumber.update(current)
    }
    if (announcement.textContent !== spoken) announcement.textContent = spoken
    previous.hidden = next.hidden = hunks.length === 0
    replayButton.hidden = !hunks[index] || Boolean(message)
    previous.disabled = next.disabled = hunks.length < 2
    changeMap.select(index)
    scopeControl.hidden = hunks.length === 0
    scopeControl.textContent = scope === 'focus' ? 'Show unchanged lines' : 'Hide unchanged lines'
    const hunk = hunks[index]
    markLine(originalMarker, hunk?.originalStartLineNumber, hunk?.originalEndLineNumber)
    markLine(workingMarker, hunk?.modifiedStartLineNumber, hunk?.modifiedEndLineNumber)
  }

  /** @param {boolean} enabled */
  function setCollapsed(enabled) {
    if (!editor || enabled === collapsed) return
    collapsed = enabled
    editor.updateOptions({
      ...labels,
      hideUnchangedRegions: {
        enabled,
        contextLineCount: 4,
        minimumLineCount: 5,
        revealLineCount: 16,
      },
    })
  }

  function reveal() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = null
      const hunk = hunks[index]
      if (!editor || !hunk) return
      const working = editor.getModifiedEditor()
      const model = working.getModel()
      if (!model) return
      // A deletion is reported at the preceding working line, which can be zero.
      const line = Math.max(1, Math.min(model.getLineCount(), hunk.modifiedStartLineNumber))
      working.revealLineInCenter(line, monacoEditor.ScrollType.Immediate)
    })
  }

  function scheduleViewport() {
    if (viewportFrame !== null || changeMap.element.hidden) return
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = null
      if (editor) changeMap.updateViewport(editor)
    })
  }

  function sync() {
    const model = editor?.getModel()
    const changes = editor?.getLineChanges()
    if (!model || !changes) {
      changeMap.update([], null)
      paint({ message: 'Finding changes…' })
      return
    }
    const anchor = hunks[index]?.modifiedStartLineNumber
    hunks = changes
    index = 0
    if (anchor !== undefined) {
      let nearest = Infinity
      for (const [i, hunk] of hunks.entries()) {
        const distance = Math.abs(hunk.modifiedStartLineNumber - anchor)
        if (distance >= nearest) continue
        index = i
        nearest = distance
      }
    }
    setCollapsed(scope === 'focus' && hunks.length > 0)
    changeMap.update(hunks, model)
    if (hunks.length) paint()
    else paint({ message: 'No text changes' })
    if (hunks.length && revealOnFirstDiff) {
      revealOnFirstDiff = false
      reveal()
    }
    scheduleViewport()
  }

  /** @param {-1 | 1} direction */
  function step(direction) {
    if (hunks.length < 2) return
    jump((index + direction + hunks.length) % hunks.length, direction)
  }

  /** @param {number} target @param {-1 | 0 | 1} direction */
  function jump(target, direction = 0) {
    if (!hunks[target]) return
    index = target
    paint({ direction })
    reveal()
  }

  /** @param {ReviewScope} value */
  function chooseScope(value) {
    if (!editor || scope === value) return
    scope = value
    onScope(value)
    setCollapsed(value === 'focus' && hunks.length > 0)
    paint()
    reveal()
  }

  previous.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  scopeControl.addEventListener('click', () => chooseScope(scope === 'focus' ? 'full' : 'focus'))
  replayButton.addEventListener('click', () => {
    const model = editor?.getModel()
    const hunk = hunks[index]
    if (replayPending || replayDialog?.open || !model || !hunk) return
    const originalVersion = model.original.getVersionId()
    const modifiedVersion = model.modified.getVersionId()
    replayPending = true
    runTask('Open change replay', async () => {
      try {
        const { showChangeReplay } = await import('../change-replay/change-replay.ts')
        if (
          !replayButton.isConnected ||
          document.querySelector('dialog[open]') ||
          editor?.getModel() !== model ||
          hunks[index] !== hunk ||
          model.original.getVersionId() !== originalVersion ||
          model.modified.getVersionId() !== modifiedVersion
        )
          return
        const dialog = showChangeReplay(model, hunk, baseline, announcement.textContent)
        replayDialog = dialog
        dialog.addEventListener(
          'close',
          () => {
            if (replayDialog !== dialog) return
            replayDialog = undefined
            if (replayButton.isConnected && !replayButton.closest('[hidden]')) {
              replayButton.focus({ preventScroll: true })
            }
          },
          { once: true },
        )
      } finally {
        replayPending = false
      }
    })
  })

  function detach() {
    replayDialog?.close()
    replayDialog = undefined
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    if (viewportFrame !== null) cancelAnimationFrame(viewportFrame)
    viewportFrame = null
    for (const listener of listeners.splice(0)) listener.dispose()
    originalMarker?.clear()
    workingMarker?.clear()
    originalMarker = workingMarker = null
    editor = null
    hunks = []
    index = 0
    collapsed = false
    revealOnFirstDiff = false
    bar.hidden = true
    positionNumber.animated = false
    replayButton.hidden = true
    scopeControl.hidden = true
    changeMap.update([], null)
  }

  return {
    bar,
    changeMap: changeMap.element,
    /** @param {'HEAD' | 'Checkpoint'} value */
    setBaseline(value) {
      baseline = value === 'HEAD' ? 'Git HEAD' : value
      changeMap.setBaseline(value)
    },
    scopeControl,
    workingLine() {
      const hunk = hunks[index]
      return hunk?.modifiedEndLineNumber ? Math.max(1, hunk.modifiedStartLineNumber) : null
    },
    /**
     * @param {import('monaco-editor').editor.IDiffEditor} diffEditor
     * @param {ReviewScope} initialScope
     * @param {typeof labels} ariaLabels
     * @param {boolean} [revealInitial]
     */
    attach(diffEditor, initialScope, ariaLabels, revealInitial = true) {
      if (editor === diffEditor) return
      detach()
      editor = diffEditor
      labels = ariaLabels
      scope = initialScope
      revealOnFirstDiff = revealInitial
      bar.hidden = false
      const original = editor.getOriginalEditor()
      const working = editor.getModifiedEditor()
      originalMarker = original.createDecorationsCollection()
      workingMarker = working.createDecorationsCollection()
      listeners.push(editor.onDidUpdateDiff(sync))
      for (const pane of [original, working]) {
        listeners.push(
          pane.onDidScrollChange(({ scrollTopChanged, scrollHeightChanged }) => {
            if (scrollTopChanged || scrollHeightChanged) scheduleViewport()
          }),
          pane.onDidLayoutChange(scheduleViewport),
          pane.onDidChangeHiddenAreas(scheduleViewport),
          pane.onDidChangeViewZones(scheduleViewport),
        )
      }
      sync()
    },
    detach,
  }
}
