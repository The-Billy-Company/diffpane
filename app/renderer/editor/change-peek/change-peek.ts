import type { editor } from 'monaco-editor/editor/editor.api.js'
import type { WorkspaceDocument } from '../../../backend/runtime/session/workspace-types.ts'
import type { LineDecoration } from '../../../backend/workspace/comparison/changes.ts'
import { toWellFormedUtf16 } from '../../../shared/documents/utf16.ts'
import './change-peek.css'

const MARKER_SELECTOR = '.diff-gutter-added, .diff-gutter-modified, .diff-gutter-deleted'
const TITLES = { added: 'Lines added', modified: 'Lines modified', deleted: 'Lines removed' }
const MAX_LINES = 3
const MAX_COLUMNS = 160

interface PeekChange {
  marker: LineDecoration
  before?: LineDecoration
}

function pairChanges(snapshot: WorkspaceDocument) {
  const modified = snapshot.beforeDecorations.filter(mark => mark.kind === 'modified')
  const deleted = snapshot.beforeDecorations.filter(mark => mark.kind === 'deleted')
  const changes: PeekChange[] = []
  let nextModified = 0
  let nextDeleted = 0

  // The two decoration lists emit each modified or deleted range in order.
  for (const marker of snapshot.decorations) {
    const before =
      marker.kind === 'modified'
        ? modified[nextModified++]
        : marker.kind === 'deleted'
          ? deleted[nextDeleted++]
          : undefined
    const previous = changes.at(-1)
    // At EOF the deletion marker can land on the last line of the replacement.
    if (
      marker.kind === 'deleted' &&
      previous?.marker.kind === 'modified' &&
      previous.marker.endLine === marker.startLine &&
      previous.before &&
      before?.startLine === previous.before.endLine + 1
    ) {
      previous.before = { ...previous.before, endLine: before.endLine }
    } else changes.push({ marker, before })
  }
  return changes
}

function excerpt(text: string, range: LineDecoration, removed: boolean) {
  const group = document.createElement('div')
  group.className = 'change-peek-excerpt'
  group.dataset.side = removed ? 'before' : 'after'
  let offset = 0
  for (let line = 1; line < range.startLine; line++) {
    offset = text.indexOf('\n', offset) + 1
    if (!offset) return group
  }

  const lastLine = Math.min(range.endLine, range.startLine + MAX_LINES - 1)
  for (let line = range.startLine; line <= lastLine; line++) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    const row = document.createElement('div')
    const marker = document.createElement('span')
    const code = document.createElement('code')
    row.className = 'change-peek-row'
    marker.textContent = `${removed ? '−' : '+'} ${line}`
    code.textContent =
      end - offset > MAX_COLUMNS
        ? `${toWellFormedUtf16(text.slice(offset, offset + MAX_COLUMNS))}…`
        : text.slice(offset, end).replace(/\r$/, '')
    row.append(marker, code)
    group.append(row)
    offset = end + 1
  }

  if (lastLine < range.endLine) {
    const more = document.createElement('div')
    more.className = 'change-peek-more'
    const count = range.endLine - lastLine
    more.textContent = `… ${count.toLocaleString()} more ${count === 1 ? 'line' : 'lines'}`
    group.append(more)
  }
  return group
}

export function createChangePeek(host: HTMLElement, code: editor.ICodeEditor) {
  const panel = document.createElement('div')
  panel.className = 'change-peek'
  panel.hidden = true
  panel.setAttribute('aria-hidden', 'true')
  const heading = document.createElement('div')
  heading.className = 'change-peek-heading'
  const title = document.createElement('span')
  const baseline = document.createElement('span')
  baseline.textContent = 'Git HEAD → Working file'
  heading.append(title, baseline)
  const body = document.createElement('div')
  body.className = 'change-peek-body'
  body.tabIndex = -1
  panel.append(heading, body)
  host.append(panel)

  const listeners = new AbortController()
  let source: WorkspaceDocument | null = null
  let changes: PeekChange[] | null = null
  let active: PeekChange | undefined
  let lastMarker: HTMLElement | null = null
  let showTimer = 0
  let hideTimer = 0

  function hide() {
    window.clearTimeout(hideTimer)
    window.clearTimeout(showTimer)
    hideTimer = 0
    active = undefined
    lastMarker = null
    panel.hidden = true
  }

  function show(snapshot: WorkspaceDocument, { marker, before }: PeekChange, y: number) {
    const { width, height, contentLeft } = code.getLayoutInfo()
    const left = contentLeft + 6
    if (width - left < 130 || height < 60) return

    title.textContent = TITLES[marker.kind]
    panel.dataset.kind = marker.kind
    body.replaceChildren()
    if (before) body.append(excerpt(snapshot.before, before, true))
    if (marker.kind !== 'deleted') body.append(excerpt(snapshot.after, marker, false))
    panel.style.left = `${left}px`
    panel.style.maxWidth = `${width - left - 8}px`
    panel.style.maxHeight = `${height - 12}px`
    panel.hidden = false
    const top = Math.max(6, Math.min(y - 15, height - panel.offsetHeight - 6))
    panel.style.top = `${top}px`
    panel.style.setProperty('--change-peek-anchor', `${Math.max(8, Math.min(y - top, panel.offsetHeight - 8))}px`)
  }

  host.addEventListener(
    'pointermove',
    event => {
      if (!(event.target instanceof HTMLElement) || !source || event.pointerType === 'touch') return
      if (!event.buttons && panel.contains(event.target)) {
        window.clearTimeout(hideTimer)
        hideTimer = 0
        return
      }
      const marker = event.buttons ? null : event.target.closest<HTMLElement>(MARKER_SELECTOR)
      if (!marker) {
        lastMarker = null
        if (panel.hidden) hide()
        else if (!hideTimer) hideTimer = window.setTimeout(hide, 150)
        return
      }

      window.clearTimeout(hideTimer)
      hideTimer = 0
      if (marker === lastMarker) return
      // A deletion triangle straddles the preceding row. Hit-test inside the marker's own row.
      const bounds = marker.getBoundingClientRect()
      const middle = bounds.top + bounds.height / 2
      const line = code.getTargetAtClientPoint(event.clientX, middle)?.position?.lineNumber
      if (line === undefined) return hide()
      changes ??= pairChanges(source)
      const change = changes.find(({ marker: range }) => range.startLine <= line && line <= range.endLine)
      if (!change) return hide()
      if (change !== active) {
        hide()
        active = change
        const snapshot = source
        const y = middle - host.getBoundingClientRect().top
        showTimer = window.setTimeout(() => show(snapshot, change, y), 180)
      }
      lastMarker = marker
    },
    listeners,
  )
  host.addEventListener('pointerleave', hide, listeners)
  host.addEventListener(
    'pointerdown',
    event => {
      if (event.target instanceof Node && !panel.contains(event.target)) hide()
    },
    listeners,
  )
  host.ownerDocument.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape') hide()
    },
    { signal: listeners.signal, capture: true },
  )
  const editorListeners = [
    code.onDidScrollChange(hide),
    code.onDidLayoutChange(hide),
    code.onDidChangeModelContent(() => {
      hide()
      source = null
      changes = null
    }),
  ]

  return {
    update(snapshot: WorkspaceDocument | null) {
      hide()
      source = snapshot?.decorations.length && !snapshot.diffNote ? snapshot : null
      changes = null
      return Boolean(source)
    },
    dispose() {
      hide()
      listeners.abort()
      for (const listener of editorListeners) listener.dispose()
      panel.remove()
    },
  }
}
