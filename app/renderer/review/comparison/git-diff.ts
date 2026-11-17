import type { IDisposable } from 'monaco-editor/editor/editor.api.js'
import { editor, Uri } from 'monaco-editor/editor/editor.api.js'
import type { Appearance } from '../../../electron/persistence/preferences/ui-preferences.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import type { GitComparison, GitFile, GitFileContents } from '../../../shared/review/git.ts'
import { diffAppearance } from '../../panels/appearance/appearance.ts'
import { createReviewFocus } from './review-focus.js'

import './git-diff.css'

interface GitDiffRequest {
  host: HTMLElement
  comparison: GitComparison
  file: GitFile
  baseLabel: string
  targetLabel: string
  focus?: boolean
}

interface GitDiffOptions {
  load: (comparison: GitComparison, file: GitFile) => Promise<GitFileContents>
  resolveLanguage: (model: editor.ITextModel, text: string) => string
  appearance: () => Appearance
}

let nextModel = 0

function physicalLines(model: editor.ITextModel) {
  const count = model.getLineCount()
  return model.getLineLength(count) ? count : count - 1
}

function normalizeGitHunks(hunks: readonly editor.ILineChange[], model: editor.IDiffEditorModel) {
  const before = physicalLines(model.original)
  const after = physicalLines(model.modified)
  if (before && after)
    return hunks.map(hunk => {
      if (hunk.originalEndLineNumber <= before && hunk.modifiedEndLineNumber <= after) return hunk
      return {
        originalStartLineNumber: Math.min(hunk.originalStartLineNumber, before),
        originalEndLineNumber: Math.min(hunk.originalEndLineNumber, before),
        modifiedStartLineNumber: Math.min(hunk.modifiedStartLineNumber, after),
        modifiedEndLineNumber: Math.min(hunk.modifiedEndLineNumber, after),
        charChanges: undefined,
      }
    })
  if (!before && !after) return hunks
  // Monaco renders an empty buffer as one line, and adds a blank cursor line
  // after a final newline. Neither is a line added or removed by Git.
  return [
    {
      originalStartLineNumber: before ? 1 : 0,
      originalEndLineNumber: before,
      modifiedStartLineNumber: after ? 1 : 0,
      modifiedEndLineNumber: after,
      charChanges: undefined,
    },
  ]
}

export function createGitDiff({ load, resolveLanguage, appearance }: GitDiffOptions) {
  let activeEditor: editor.IStandaloneDiffEditor | null = null

  function open({ host, comparison, file, baseLabel, targetLabel, focus }: GitDiffRequest) {
    const panel = document.createElement('div')
    panel.className = 'git-diff'
    panel.setAttribute('aria-label', 'File comparison')
    const status = document.createElement('p')
    status.className = 'git-diff-status'
    status.setAttribute('role', 'status')
    status.textContent = 'Loading comparison…'
    panel.append(status)
    host.replaceChildren(panel)
    let disposed = false
    let request = 0
    let releaseEditor: (() => void) | undefined
    let updateText: ((before: string, after: string) => void) | undefined

    function showStatus(message: string) {
      releaseEditor?.()
      releaseEditor = undefined
      updateText = undefined
      panel.replaceChildren(status)
      status.hidden = false
      status.textContent = message
    }

    function render({ before, after, note, available }: GitFileContents) {
      if (available === false || (note && !before && !after)) {
        showStatus(note ?? 'A line comparison is unavailable for this file.')
        return
      }
      status.hidden = !note
      status.textContent = note ?? ''
      panel.toggleAttribute('data-empty-original', !before)
      panel.toggleAttribute('data-empty-modified', !after)
      if (updateText) {
        updateText(before, after)
        return
      }
      panel.dataset.reviewScope = 'focus'
      const bar = document.createElement('div')
      bar.className = 'git-diff-header'
      const title = document.createElement('strong')
      title.textContent = file.path.split('/').at(-1) ?? file.path
      title.title = file.path
      const scope = document.createElement('button')
      scope.className = 'change-button git-diff-scope'
      scope.type = 'button'
      scope.textContent = 'Full file'
      scope.disabled = true
      const navigation = createReviewFocus({
        lineCount: physicalLines,
        normalizeHunks: normalizeGitHunks,
        onScope(value) {
          panel.dataset.reviewScope = value
          scope.textContent = value === 'focus' ? 'Full file' : 'Changes only'
        },
        onActionsChange() {
          scope.disabled = !navigation.actions.hasChanges
        },
      })
      scope.addEventListener('click', navigation.toggleScope)
      bar.append(title, scope, navigation.bar)
      const editorHost = document.createElement('div')
      editorHost.className = 'git-diff-editor'
      panel.prepend(bar, navigation.changeMap)
      panel.append(editorHost)

      const modelId = String(++nextModel)
      const originalUri = Uri.from({
        scheme: 'diffpane-git',
        authority: modelId,
        path: `/${file.originalPath ?? file.path}`,
        query: 'base',
      })
      const modifiedUri = Uri.from({
        scheme: 'diffpane-git',
        authority: modelId,
        path: `/${file.path}`,
        query: 'target',
      })
      const original = editor.createModel(before, undefined, originalUri)
      const modified = editor.createModel(after, undefined, modifiedUri)
      let diff: editor.IStandaloneDiffEditor | null = null
      let restoring: IDisposable | undefined
      releaseEditor = () => {
        restoring?.dispose()
        navigation.detach()
        if (activeEditor === diff) activeEditor = null
        diff?.dispose()
        original.dispose()
        modified.dispose()
      }
      editor.setModelLanguage(original, resolveLanguage(original, before || after))
      editor.setModelLanguage(modified, resolveLanguage(modified, after || before))
      const labels = {
        originalAriaLabel: `${baseLabel} · ${file.originalPath ?? file.path}`,
        modifiedAriaLabel: `${targetLabel} · ${file.path}`,
      }
      diff = editor.createDiffEditor(editorHost, {
        ...diffAppearance(appearance(), true),
        ...labels,
        readOnly: true,
        originalEditable: false,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        renderMarginRevertIcon: false,
        renderGutterMenu: false,
        renderOverviewRuler: false,
        renderLineHighlight: 'none',
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: false },
        diffAlgorithm: 'advanced',
        ignoreTrimWhitespace: false,
        maxComputationTime: 1000,
        maxFileSize: 2,
        padding: { top: 8, bottom: 8 },
      })
      activeEditor = diff
      diff.setModel({ original, modified })
      const panes = [
        { model: original, decorations: diff.getOriginalEditor().createDecorationsCollection() },
        { model: modified, decorations: diff.getModifiedEditor().createDecorationsCollection() },
      ]
      function markCursorLines() {
        const oneSided = !original.getValueLength() || !modified.getValueLength()
        panel.toggleAttribute('data-original-cursor-line', original.getLineCount() > physicalLines(original))
        for (const { model, decorations } of panes) {
          const line = model.getLineCount()
          // An empty-side cursor line or a terminal blank cursor line is not a Git change.
          decorations.set(
            oneSided && line > physicalLines(model)
              ? [
                  {
                    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
                    options: { isWholeLine: true, className: 'git-cursor-line', marginClassName: 'git-cursor-line' },
                  },
                ]
              : [],
          )
        }
      }
      markCursorLines()
      navigation.setVersions(baseLabel, targetLabel)
      navigation.attach(diff, 'focus', labels)
      if (focus) diff.focus()
      const current = diff
      let originalText = before
      let modifiedText = after
      updateText = (nextBefore, nextAfter) => {
        if (nextBefore === originalText && nextAfter === modifiedText) return
        const view = current.saveViewState()
        restoring?.dispose()
        restoring = current.onDidUpdateDiff(() => {
          restoring?.dispose()
          restoring = undefined
          if (view) current.restoreViewState(view)
        })
        if (nextBefore !== originalText) {
          originalText = nextBefore
          original.setValue(nextBefore)
        }
        if (nextAfter !== modifiedText) {
          modifiedText = nextAfter
          modified.setValue(nextAfter)
        }
        markCursorLines()
      }
    }

    function refresh() {
      if (disposed) return
      const version = ++request
      void load(comparison, file)
        .then(content => {
          if (!disposed && version === request) render(content)
          return undefined
        })
        .catch((cause: unknown) => {
          if (!disposed && version === request)
            showStatus(appError(cause, { operation: 'Read Git comparison' }).message)
        })
    }

    refresh()
    return {
      refresh,
      dispose() {
        disposed = true
        releaseEditor?.()
        panel.remove()
      },
    }
  }

  return {
    open,
    updateAppearance(preferences: Appearance) {
      activeEditor?.updateOptions(diffAppearance(preferences, true))
    },
  }
}
