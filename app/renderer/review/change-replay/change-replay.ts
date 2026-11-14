import type { ThemedToken } from '@shikijs/core'
import { syncTokenKeys, toKeyedTokens } from '@shikijs/magic-move/core'
import { MagicMoveRenderer } from '@shikijs/magic-move/renderer'
import type { editor } from 'monaco-editor'
import { editor as monacoEditor } from 'monaco-editor/editor/editor.api.js'
import { EDITOR_THEMES } from '../../editor/highlighting/editor-themes.ts'
import { createSketch } from '../../illustrations/sketch.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'

import '@shikijs/magic-move/style.css'
import './change-replay.css'

const MAX_LINES = 16
const MAX_COLUMNS = 180
const darkRules = new Map(EDITOR_THEMES.diffpane.rules.map(rule => [rule.token, rule]))
const lightRules = new Map(EDITOR_THEMES['diffpane-light'].rules.map(rule => [rule.token, rule]))

function excerpt(model: editor.ITextModel, first: number, last: number) {
  if (last === 0) return { code: '', clipped: false, lines: 0 }
  let clipped = last - first + 1 > MAX_LINES
  const endLine = Math.min(last, first + MAX_LINES - 1)
  const lines = []
  for (let line = first; line <= endLine; line++) {
    const end = model.getLineMaxColumn(line)
    clipped ||= end > MAX_COLUMNS + 1
    lines.push(
      model
        .getValueInRange({
          startLineNumber: line,
          endLineNumber: line,
          startColumn: 1,
          endColumn: Math.min(end, MAX_COLUMNS + 1),
        })
        .toWellFormed(),
    )
  }
  return { code: lines.join('\n'), clipped, lines: lines.length }
}

// Use the editor's loaded tokenizers instead of loading another set of grammars for the replay.
function tokensFor(code: string, language: string) {
  let lineOffset = 0
  const lines = code.split('\n')
  const tokens = monacoEditor.tokenize(code, language).map((row, index) => {
    const line = lines[index] ?? ''
    const result = row.map(({ offset, type }, column): ThemedToken => {
      let scope = type
      while (scope.includes('.') && !darkRules.has(scope)) scope = scope.slice(0, scope.lastIndexOf('.'))
      const dark = darkRules.get(scope)
      const light = lightRules.get(scope)
      return {
        content: line.slice(offset, row[column + 1]?.offset),
        offset: lineOffset + offset,
        color:
          light?.foreground && dark?.foreground
            ? `light-dark(#${light.foreground}, #${dark.foreground})`
            : 'var(--editor-text)',
        htmlStyle: {
          'font-style': dark?.fontStyle === 'italic' ? 'italic' : 'inherit',
          'font-weight': dark?.fontStyle === 'bold' ? 'bold' : 'inherit',
        },
      }
    })
    lineOffset += line.length + 1
    return result
  })
  return toKeyedTokens(code, tokens)
}

export function showChangeReplay(
  model: editor.IDiffEditorModel,
  hunk: editor.ILineChange,
  baseline: string,
  position: string,
) {
  const before = excerpt(model.original, hunk.originalStartLineNumber, hunk.originalEndLineNumber)
  const after = excerpt(model.modified, hunk.modifiedStartLineNumber, hunk.modifiedEndLineNumber)
  const { from, to } = syncTokenKeys(
    tokensFor(before.code, model.original.getLanguageId()),
    tokensFor(after.code, model.modified.getLanguageId()),
    { splitTokens: true },
  )
  const dialog = document.createElement('dialog')
  dialog.className = 'change-replay'
  dialog.setAttribute('aria-label', 'Replay change')
  dialog.innerHTML = `
    <header class="change-replay-header">
      <div class="change-replay-heading">
        <h2>Replay change</h2>
        <div class="change-replay-detail">
          <bdi class="change-replay-file"></bdi>
          <span class="change-replay-position"></span>
        </div>
      </div>
      <button type="button" class="change-replay-close" aria-label="Close replay" title="Close replay">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </header>
    <div class="change-replay-controls">
      <div class="change-replay-versions" role="group" aria-label="Version">
        <button type="button" class="change-replay-baseline" aria-pressed="true"></button>
        <button type="button" class="change-replay-working" aria-pressed="false" autofocus>Working file</button>
      </div>
    </div>
    <div class="change-replay-stage" role="region" aria-label="Change excerpt" tabindex="0">
      <div class="change-replay-gutter" aria-hidden="true"></div>
      <div class="change-replay-content">
        <pre class="change-replay-code shiki-magic-move-container" aria-hidden="true"></pre>
        <pre class="change-replay-readable"></pre>
        <p class="change-replay-empty" hidden><svg class="change-replay-empty-art" viewBox="0 0 34 26" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round"></svg>No lines in this version.</p>
      </div>
    </div>
    <p class="change-replay-limit" hidden></p>`
  const close = requireElement(dialog, '.change-replay-close', HTMLButtonElement)
  const original = requireElement(dialog, '.change-replay-baseline', HTMLButtonElement)
  const working = requireElement(dialog, '.change-replay-working', HTMLButtonElement)
  const stage = requireElement(dialog, '.change-replay-stage', HTMLDivElement)
  const gutter = requireElement(dialog, '.change-replay-gutter', HTMLDivElement)
  const canvas = requireElement(dialog, '.change-replay-code', HTMLPreElement)
  const readable = requireElement(dialog, '.change-replay-readable', HTMLPreElement)
  const empty = requireElement(dialog, '.change-replay-empty', HTMLParagraphElement)
  const limit = requireElement(dialog, '.change-replay-limit', HTMLParagraphElement)
  const { path } = model.modified.uri
  const filename = path.slice(path.lastIndexOf('/') + 1)
  const file = requireElement(dialog, '.change-replay-file', HTMLElement)
  file.textContent = filename
  file.title = filename
  requireElement(dialog, '.change-replay-position', HTMLSpanElement).textContent = position
  original.textContent = baseline
  const lastVisibleLine = Math.max(
    hunk.originalStartLineNumber + before.lines - 1,
    hunk.modifiedStartLineNumber + after.lines - 1,
  )
  stage.style.setProperty('--replay-gutter-digits', String(Math.max(2, String(lastVisibleLine).length)))
  stage.style.setProperty('--replay-lines', String(Math.max(1, before.lines, after.lines)))
  limit.hidden = !(before.clipped || after.clipped)
  limit.textContent = `Showing up to ${MAX_LINES} lines and ${MAX_COLUMNS} columns per side.`
  if (!before.lines || !after.lines) {
    const art = requireElement(empty, 'svg', SVGSVGElement)
    const sketch = createSketch(art)
    art.append(
      sketch.path('M5 3h17l5 5v15H5Z M22 3v6h5', { stroke: 'currentColor', roughness: 0.65 }),
      sketch.path('M10 14h2m3 0h2m3 0h2', { stroke: 'currentColor', strokeWidth: 1.4, roughness: 0.65 }),
    )
  }

  const renderer = new MagicMoveRenderer(canvas, { duration: 400, containerStyle: false, animateContainer: false })
  let side: 'before' | 'after' | undefined
  let renderVersion = 0
  function show(next: 'before' | 'after') {
    if (side === next) return
    const isWorking = next === 'after'
    const content = isWorking ? after : before
    const tokens = isWorking ? to : from
    const firstLine = isWorking ? hunk.modifiedStartLineNumber : hunk.originalStartLineNumber
    const noLines = content.lines === 0
    empty.hidden = !noLines || side !== undefined
    side = next
    dialog.dataset.version = next
    const current = ++renderVersion
    original.setAttribute('aria-pressed', String(!isWorking))
    working.setAttribute('aria-pressed', String(isWorking))
    readable.textContent = content.code
    const range =
      content.lines === 1
        ? `, line ${firstLine}`
        : noLines
          ? ''
          : `, lines ${firstLine}–${firstLine + content.lines - 1}`
    stage.setAttribute('aria-label', `${isWorking ? 'Working file' : baseline} excerpt${range}`)
    gutter.replaceChildren(
      ...Array.from({ length: content.lines }, (_, index) => {
        const line = document.createElement('div')
        line.textContent = String(firstLine + index)
        return line
      }),
    )
    runTask(
      'Render change replay',
      async () => {
        await renderer.render(tokens)
        if (current === renderVersion && noLines) empty.hidden = false
      },
      { silent: true },
    )
  }

  dialog.addEventListener('close', () => dialog.remove(), { once: true })
  close.addEventListener('click', () => dialog.close())
  original.addEventListener('click', () => show('before'))
  working.addEventListener('click', () => show('after'))
  document.body.append(dialog)
  dialog.showModal()
  show('before')
  return dialog
}
