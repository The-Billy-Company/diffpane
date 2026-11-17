import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js'
import { createSketch } from '../../illustrations/sketch.ts'
import { createRollingNumber } from '../../shell/number-flow/number-flow.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createReviewChangeMap } from './review-change-map.ts'

import './review-focus.css'

/** @typedef {'focus' | 'full'} ReviewScope */
/** @typedef {'first' | 'last'} ChangePosition */
/** @typedef {import('monaco-editor').editor.IDiffEditorModel} DiffModel */
/** @typedef {readonly import('monaco-editor').editor.ILineChange[]} Hunks */

const positionFormat = new Intl.NumberFormat(undefined, { numberingSystem: 'latn' })

/** @param {'up' | 'down'} direction */
function chevron(direction) {
  return `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${direction === 'up' ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

/**
 * @param {import('monaco-editor').editor.ICodeEditor} pane
 * @param {'original' | 'working' | 'inline-removed'} side
 */
function createHunkBracket(pane, side) {
  const element = document.createElement('div')
  element.className = 'review-hunk-bracket'
  element.dataset.side = side
  element.setAttribute('aria-hidden', 'true')
  element.hidden = true
  const widget = { getId: () => `diffpane.hunk.${side}`, getDomNode: () => element, getPosition: () => null }
  pane.addOverlayWidget(widget)

  return {
    /** @param {number} [top] @param {number} [bottom] */
    draw(top = 0, bottom = 0) {
      const scroll = pane.getScrollTop()
      const { height, contentLeft } = pane.getLayoutInfo()
      // Clip offscreen ends past the pane so their caps never look like real hunk boundaries.
      const first = Math.max(-8, top - scroll) + 1
      const last = Math.min(height + 8, bottom - scroll) - 1
      element.hidden = bottom <= top || last <= 0 || first >= height || contentLeft <= 5
      if (element.hidden) return
      element.style.setProperty('--hunk-top', `${first}px`)
      element.style.height = `${last - first}px`
      element.style.width = `${Math.min(11, contentLeft - 5)}px`
    },
    dispose: () => pane.removeOverlayWidget(widget),
  }
}

/** @param {import('monaco-editor').editor.ICodeEditor} pane @param {number} nextLine */
function inlineRemovalBounds(pane, nextLine) {
  // Monaco inserts the original text as a view zone immediately before the next working line.
  if (nextLine <= (pane.getModel()?.getLineCount() ?? 0)) {
    return [pane.getTopForLineNumber(nextLine, true), pane.getTopForLineNumber(nextLine)]
  }
  const padding = pane.getOption(monacoEditor.EditorOption.padding)
  const { width, horizontalScrollbarHeight } = pane.getLayoutInfo()
  const scrollbar = pane.getScrollWidth() > width ? horizontalScrollbarHeight : 0
  const bottom = pane.getContentHeight() - padding.bottom - scrollbar
  return [pane.getBottomForLineNumber(nextLine - 1), bottom]
}

/** @param {{ onScope: (scope: ReviewScope) => void, onActionsChange?: () => void, lineCount?: (model: import('monaco-editor').editor.ITextModel) => number, normalizeHunks?: (hunks: Hunks, model: DiffModel) => Hunks }} options */
export function createReviewFocus({ onScope, onActionsChange, lineCount, normalizeHunks }) {
  const bar = document.createElement('div')
  bar.className = 'review-hunk-bar'
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', 'Changes in this file')
  bar.hidden = true
  bar.innerHTML = `
    <button type="button" class="review-hunk-prev" aria-label="Previous change in file" title="Previous change in file">${chevron('up')}</button>
    <svg class="review-hunk-aligned" viewBox="0 0 20 20" aria-hidden="true" stroke-linecap="round" hidden></svg>
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
  const aligned = requireElement(bar, '.review-hunk-aligned', SVGSVGElement)
  const announcement = requireElement(bar, '.review-hunk-announcement', HTMLSpanElement)
  const previous = requireElement(bar, '.review-hunk-prev', HTMLButtonElement)
  const next = requireElement(bar, '.review-hunk-next', HTMLButtonElement)
  const replayButton = requireElement(bar, '.review-hunk-replay', HTMLButtonElement)
  const changeMap = createReviewChangeMap(jump, lineCount)
  /** @type {import('monaco-editor').editor.IDiffEditor | null} */
  let editor = null
  /** @type {{ originalAriaLabel?: string, modifiedAriaLabel?: string }} */
  let labels = {}
  /** @type {import('monaco-editor').IDisposable[]} */
  const listeners = []
  /** @type {{ original: ReturnType<typeof createHunkBracket>, working: ReturnType<typeof createHunkBracket>, inline: ReturnType<typeof createHunkBracket> } | null} */
  let brackets = null
  /** @type {ReviewScope} */
  let scope = 'focus'
  /** @type {Hunks} */
  let hunks = []
  let baseline = 'Git HEAD'
  let modifiedLabel = 'Working file'
  let replayPending = false
  /** @type {HTMLDialogElement | undefined} */
  let replayDialog
  let index = 0
  let collapsed = false
  /** @type {ChangePosition | null} */
  let pendingChange = null
  /** @type {number | null} */
  let frame = null
  /** @type {number | null} */
  let viewportFrame = null

  /** @param {{ message?: string, unchanged?: boolean, direction?: -1 | 0 | 1 }} [options] */
  function paint({ message = '', unchanged = false, direction = 0 } = {}) {
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
    aligned.toggleAttribute('hidden', !unchanged)
    if (unchanged && !aligned.childElementCount) {
      const sketch = createSketch(aligned)
      const ink = { stroke: 'currentColor', roughness: 0.65 }
      aligned.append(sketch.circle(10, 10, 14, ink), sketch.path('M7 8h6m-6 4h6', ink))
    }
    previous.hidden = next.hidden = hunks.length === 0
    replayButton.hidden = !hunks[index] || Boolean(message)
    previous.disabled = next.disabled = hunks.length < 2
    changeMap.select(index)
    onActionsChange?.()
    scheduleViewport()
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
    if (viewportFrame !== null) return
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = null
      if (!editor || !brackets) return
      changeMap.updateViewport(editor)
      const original = editor.getOriginalEditor()
      const working = editor.getModifiedEditor()
      const hunk = hunks[index]
      const split = original.getLayoutInfo().contentWidth > 0
      if (hunk?.modifiedEndLineNumber) {
        brackets.working.draw(
          working.getTopForLineNumber(hunk.modifiedStartLineNumber),
          working.getBottomForLineNumber(hunk.modifiedEndLineNumber),
        )
      } else brackets.working.draw()
      if (hunk?.originalEndLineNumber && split) {
        brackets.original.draw(
          original.getTopForLineNumber(hunk.originalStartLineNumber),
          original.getBottomForLineNumber(hunk.originalEndLineNumber),
        )
      } else brackets.original.draw()
      if (hunk?.originalEndLineNumber && !split) {
        const nextLine = hunk.modifiedStartLineNumber + (hunk.modifiedEndLineNumber ? 0 : 1)
        const [top, bottom] = inlineRemovalBounds(working, nextLine)
        brackets.inline.draw(top, bottom)
      } else brackets.inline.draw()
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
    hunks = normalizeHunks?.(changes, model) ?? changes
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
    if (!hunks.length) paint({ message: 'No text changes', unchanged: true })
    else if (pendingChange) revealChange(pendingChange)
    else paint()
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

  /** @param {ChangePosition} change */
  function revealChange(change) {
    pendingChange = hunks.length ? null : change
    if (hunks.length) jump(change === 'first' ? 0 : hunks.length - 1)
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

  function toggleScope() {
    if (hunks.length) chooseScope(scope === 'focus' ? 'full' : 'focus')
  }

  /** @param {() => void} [restoreFocus] */
  function replay(restoreFocus = () => replayButton.focus({ preventScroll: true })) {
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
        const dialog = showChangeReplay(model, hunk, baseline, announcement.textContent, modifiedLabel)
        replayDialog = dialog
        dialog.addEventListener(
          'close',
          () => {
            if (replayDialog !== dialog) return
            replayDialog = undefined
            if (replayButton.isConnected && !replayButton.closest('[hidden]')) {
              restoreFocus()
            }
          },
          { once: true },
        )
      } finally {
        replayPending = false
      }
    })
  }

  previous.addEventListener('click', () => step(-1))
  next.addEventListener('click', () => step(1))
  replayButton.addEventListener('click', () => replay())

  function detach() {
    replayDialog?.close()
    replayDialog = undefined
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    if (viewportFrame !== null) cancelAnimationFrame(viewportFrame)
    viewportFrame = null
    for (const listener of listeners.splice(0)) listener.dispose()
    if (brackets) for (const bracket of Object.values(brackets)) bracket.dispose()
    brackets = null
    editor = null
    hunks = []
    index = 0
    collapsed = false
    pendingChange = null
    bar.hidden = true
    positionNumber.animated = false
    replayButton.hidden = true
    changeMap.update([], null)
    onActionsChange?.()
  }

  return {
    bar,
    changeMap: changeMap.element,
    get actions() {
      return {
        scope,
        hasChanges: hunks.length > 0,
        canNavigate: hunks.length > 1,
        canReplay: !replayButton.hidden,
      }
    },
    step,
    revealChange,
    toggleScope,
    replay,
    /** @param {'HEAD' | 'Checkpoint'} value */
    setBaseline(value) {
      baseline = value === 'HEAD' ? 'Git HEAD' : value
      modifiedLabel = 'Working file'
      changeMap.setVersions(baseline, modifiedLabel)
    },
    /** @param {string} original @param {string} modified */
    setVersions(original, modified) {
      baseline = original
      modifiedLabel = modified
      changeMap.setVersions(baseline, modifiedLabel)
    },
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
      const initialChange = pendingChange ?? (revealInitial ? 'first' : null)
      detach()
      editor = diffEditor
      labels = ariaLabels
      scope = initialScope
      pendingChange = initialChange
      bar.hidden = false
      const original = editor.getOriginalEditor()
      const working = editor.getModifiedEditor()
      brackets = {
        original: createHunkBracket(original, 'original'),
        working: createHunkBracket(working, 'working'),
        inline: createHunkBracket(working, 'inline-removed'),
      }
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
