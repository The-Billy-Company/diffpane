// MONOLITHIC: The renderer composition root coordinates card selection, editor lifetime, save flushing and workspace updates. Extract the card controller once it owns these transitions through a verified interface.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/basic-languages/monaco.contribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
// oxlint-disable-next-line import/default -- Vite generates the worker constructor for ?worker imports.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { colorHex } from '../../../shared/appearance/palette.ts'
import { mediaType } from '../../../shared/documents/media-types.ts'
import { fileMenuLabels, isFileMenuAction } from '../../../shared/preferences/file-menu.ts'
import {
  ariaBinding,
  bindingLabel,
  createShortcutSequence,
  defaultBinding,
  effectiveBinding,
  isShortcutAction,
  matchesBinding,
  shortcutChordBindings,
} from '../../../shared/preferences/shortcuts.ts'
import { appError, attempt, attemptAsync } from '../../../shared/recovery/app-errors.ts'
import './style.css'
import '../recovery/loading.css'
import { captureReviewLines, locateReviewLines } from '../../../shared/review/review-notes.ts'
import { createChangePeek } from '../../editor/change-peek/change-peek.ts'
import { showDocumentPreview } from '../../editor/documents/document-preview.ts'
import { createDocumentProcessor } from '../../editor/documents/document-runtime.ts'
import { editorThemeName } from '../../editor/highlighting/editor-themes.ts'
import { configureSyntax } from '../../editor/highlighting/syntax.ts'
import { createLanguageFeatures } from '../../editor/languages/languages.js'
import { isMarkdown } from '../../editor/markdown/markdown-paths.ts'
import { recolorMarkdownPreviews, showMarkdownPreview } from '../../editor/markdown/markdown-preview.ts'
import { Autosave } from '../../editor/updates/autosave.ts'
import { createEditActivity } from '../../editor/updates/edit-activity/edit-activity.ts'
import { createLiveEditHighlight, describeLiveEdit } from '../../editor/updates/live-edit-highlight.ts'
import { LivePathBatch, subscribeLivePaths } from '../../editor/updates/live-updates.ts'
import { createFilePicker } from '../../explorer/file-picker/files.ts'
import { createContentSearch } from '../../explorer/project-search/content-search.ts'
import { createNavigator } from '../../explorer/tree/navigator.js'
import { createHowMany } from '../../panels/analysis/howmany.js'
import {
  bundledEditorFont,
  codeAppearance,
  createAppearanceSettings,
  diffAppearance,
} from '../../panels/appearance/appearance.ts'
import { createAgentThreadPanel } from '../../panels/assistant/agent-threads.ts'
import { agentThreadsGlyph, createAssistant } from '../../panels/assistant/assistant.js'
import { creatureGlyph } from '../../panels/assistant/creature-glyph.ts'
import { mountIdeaBuilder } from '../../panels/ideas/ideas.ts'
import { createSettings } from '../../panels/settings/settings.js'
import '../../editor/documents/document-preview.css'
import '../../explorer/tree/navigator.css'
import { createBillyLanes } from '../../review/billy-lanes/lanes.ts'
import { createBillyReviewContext } from '../../review/billy/context.ts'
import { changedSymbolRanges } from '../../review/comparison/function-ranges.ts'
import { createGitDiff } from '../../review/comparison/git-diff.ts'
import { createReviewFocus } from '../../review/comparison/review-focus.js'
import { createGitWorkspace } from '../../review/git/git-workspace.ts'
import { createReviewNotes } from '../../review/notes/review-notes.ts'
import { createChangeReview } from '../../review/queue/change-review.js'
import { rendererDiagnostics } from '../diagnostics/diagnostics.ts'
import { projectIcon } from '../layout/icons.ts'
import { createWorkspaceLayout } from '../layout/workspace-layout.ts'
import { createRollingNumber } from '../number-flow/number-flow.ts'
import { clearErrorNotice, guard, renderFailure, reportError, runTask, setErrorNoticeHost } from '../recovery/errors.ts'
import { drawRecentTargetArt, drawWelcomeArt, drawWorkbenchArt } from './art/workspace-art.ts'
import { requireElement } from './dom.js'
import { FileHistory } from './file-history.ts'
import { getWorkspacePreferences } from './preferences.ts'

/** @import { WorkspaceComparison, WorkspaceDocument, WorkspaceFile, WorkspaceSnapshot } from '../../../electron/runtime/session/workspace-types.ts' */
/** @import { IdeaLink } from '../../../shared/ideas/ideas.ts' */
/** @import { ReviewAnchor } from '../../../shared/review/review-notes.ts' */
/** @import { FileMenuAction } from '../../../shared/preferences/file-menu.ts' */
/** @import { ShortcutAction, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts' */
/** @import { ContentMatch } from '../../explorer/project-search/content-search.ts' */
/** @import { FunctionRange } from '../../review/comparison/function-ranges.ts' */
/** @import { ChangePosition, ReviewScope } from '../../review/comparison/review-focus.js' */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.IStandaloneCodeEditor} CodeEditor */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.ITextModel} TextModel */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.ICodeEditorViewState} ViewState */
/** @typedef {import('monaco-editor/editor/editor.api.js').editor.IEditorDecorationsCollection} EditorDecorations */
/** @typedef {import('monaco-editor/editor/editor.api.js').IDisposable} Disposable */
/** @typedef {'head' | 'working'} EditorSide */
/** @typedef {WorkspaceFile & {anchor?: string}} OpenFile */
/** @typedef {Omit<ReviewAnchor, 'side' | 'truncated'> & {side?: EditorSide, truncated?: boolean, direct?: boolean}} FileAnchor */
/** @typedef {{compare?: boolean, comparison?: WorkspaceComparison, review?: boolean, source?: boolean, match?: ContentMatch | null, anchor?: FileAnchor | null, ideaLink?: boolean, historyIndex?: number, focusEditor?: boolean, change?: ChangePosition}} OpenOptions */
/**
 * @typedef {object} Card
 * @property {OpenFile} file
 * @property {HTMLElement} element
 * @property {ReturnType<typeof createReviewFocus>} reviewFocus
 * @property {ReturnType<typeof createEditActivity>} editActivity
 * @property {HTMLElement} reviewNotice
 * @property {HTMLElement} host
 * @property {HTMLElement} note
 * @property {HTMLElement} errors
 * @property {HTMLButtonElement} nextChange
 * @property {HTMLElement} lines
 * @property {HTMLElement} language
 * @property {(() => void) | null} languageCleanup
 * @property {Parameters<typeof updateLanguageState>[0] | null} languageState
 * @property {CodeEditor | null} editor
 * @property {TextModel | null} model
 * @property {EditorDecorations | null} decorationCollection
 * @property {ReturnType<typeof createChangePeek> | null} [changePeek]
 * @property {number} [decorationEditVersion]
 * @property {ReturnType<typeof createLiveEditHighlight> | null} [liveEditHighlight]
 * @property {ViewState | null} viewState
 * @property {boolean} dirty
 * @property {boolean} active
 * @property {boolean} loading
 * @property {number} openedAt
 * @property {number} generation
 * @property {number[]} changes
 * @property {number} changeIndex
 * @property {boolean} comparing
 * @property {WorkspaceComparison} comparison
 * @property {number} textBytes
 * @property {WorkspaceDocument | null} [document]
 * @property {WorkspaceComparison} [renderedComparison]
 * @property {boolean} [reviewComparison]
 * @property {ReviewScope} [fileDiffScope]
 * @property {boolean} [documentFailed]
 * @property {boolean} [anchorFromIdea]
 * @property {FileAnchor | null} [pendingReviewAnchor]
 * @property {ContentMatch | null} [pendingMatch]
 * @property {{type: string, url: string} | null} [currentMedia]
 * @property {boolean} [previewRaw]
 * @property {ReturnType<typeof showDocumentPreview> | null} [mediaPreview]
 * @property {ReturnType<typeof showMarkdownPreview> | null} [markdownPreview]
 * @property {string | null} [markdownAnchor]
 * @property {string} [markdownText]
 * @property {number} [markdownScroll]
 * @property {number[]} [markdownDiagramHeights]
 * @property {boolean} [markdownSource]
 * @property {boolean} [applyingDocument]
 * @property {boolean} [restoreErrorFocus]
 * @property {boolean} [focusOnLoad]
 * @property {HTMLElement | null} [errorBoundary]
 * @property {AbortController} [documentWork]
 * @property {number} [changedFunctions]
 * @property {number} [modeVersion]
 * @property {number} [editVersion]
 * @property {string | null} [text]
 * @property {TextModel | null} [originalModel]
 * @property {string | null} [originalText]
 * @property {EditorDecorations | null} [originalDecorations]
 * @property {EditorDecorations | null} [originalFunctionDecorations]
 * @property {EditorDecorations | null} [functionDecorations]
 * @property {import('monaco-editor/editor/editor.api.js').editor.IStandaloneDiffEditor | null} [diffEditor]
 * @property {(() => void) | null} [syncEditorMenu]
 * @property {EditorSide} [ideaSide]
 * @property {EditorSide} [noteSide]
 * @property {Disposable[]} [contextActions]
 * @property {Disposable | null} [contentCleanup]
 * @property {Autosave | null} [autosave]
 * @property {string | null} [saveStatus]
 * @property {import('../../../shared/recovery/app-errors.ts').AppError | null} [saveError]
 */

globalThis.MonacoEnvironment = { getWorker: () => new EditorWorker() }

const syntax = configureSyntax(monaco)
const documentProcessor = createDocumentProcessor()

const icons = {
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M4 9h4" stroke="var(--removed-edge)" stroke-width="1.7"/><path d="M16 15h4m-2-2v4" stroke="var(--added-edge)" stroke-width="1.7"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="1.7" stroke="currentColor"/><circle cx="4" cy="13" r="1.7" stroke="currentColor"/><circle cx="12" cy="3" r="1.7" stroke="currentColor"/><path d="M4 5v6m8-6v1a4 4 0 0 1-4 4H4" stroke="currentColor" stroke-width="1.2"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.35"/><path d="m10 10 3.5 3.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  terminal:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="m4 6 2 2-2 2m4 0h3.5"/></svg>',
  review:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5h5.5M8 10h5.5"/><path class="review-idle-mark" d="m2 5 1.25 1.25L5.5 4M2 10l1.25 1.25L5.5 9"/><path class="review-pending-mark" d="M2 5h3.5M2 10h3.5M3.75 8.25v3.5"/></svg>',
  note: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6L9.5 13.5h-6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M9.5 13.5v-3a1 1 0 0 1 1-1h3M5 5.5h6M5 8h3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/><path d="M2 6.5h12"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 1.5-.3 1.7-1.1.6-1.6-.6-1.5 2.6 1.3 1.1v1.2L2 9.2l1.5 2.6 1.6-.6 1.1.6.3 1.7h3l.3-1.7 1.1-.6 1.6.6L14 9.2l-1.3-1.1V6.9L14 5.8l-1.5-2.6-1.6.6-1.1-.6-.3-1.7z"/><circle cx="8" cy="7.5" r="2"/></svg>',
  idea: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="2.5" width="11.5" height="13" rx="2"/><path d="M7 2.5v13M2 6h3m-3 6h3m4.5-5h3m-3 3h2"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.3l-3.5-3.5Z" stroke="currentColor" stroke-width="1.15"/><path d="M9 2v4h4" stroke="currentColor" stroke-width="1.15"/></svg>',
}

const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'))
const workspaceOpening = document.getElementById('workspace-opening')
app.innerHTML = `
  <header class="titlebar">
    <span class="brand-mark" aria-hidden="true">${icons.mark}</span>
    <div class="project"><span id="project-name">Diffpane</span></div>
    <button type="button" class="branch titlebar-button" id="git-workspace-toggle" aria-label="Git workspace" aria-controls="git-workspace" aria-pressed="false" title="Inspect Git history and changes" hidden>${icons.branch}<span id="branch-name"></span></button>
    <span id="project-path"></span>
    <div class="titlebar-actions">
      <button type="button" id="ideas-toggle" class="titlebar-button" aria-label="Ideas" aria-controls="ideas-panel" aria-expanded="false" hidden>${icons.idea}<span>Ideas</span></button>
      <button type="button" id="content-search-toggle" class="titlebar-button" aria-label="Search in project" aria-haspopup="dialog" aria-controls="content-search" hidden>${icons.search}<span>Search</span></button>
      <button type="button" id="review-toggle" class="titlebar-button" aria-label="Review changes" aria-controls="change-review" aria-pressed="false" data-pending="false" hidden>${icons.review}<span>Changes</span></button>
      <button type="button" id="review-notes-toggle" class="titlebar-button" aria-label="Review notes" aria-controls="review-notes-panel" aria-expanded="false" hidden>${icons.note}<span>Notes</span></button>
      <button type="button" id="agent-threads-toggle" class="titlebar-button" aria-label="Agent threads" title="Agent threads" aria-controls="agent-threads" hidden>${agentThreadsGlyph}<span>Agent threads</span></button>
      <button type="button" id="claude-toggle" class="titlebar-button" aria-label="The Creature" aria-controls="claude-panel" aria-expanded="false" hidden>${creatureGlyph}<span>The Creature</span></button>
      <button type="button" id="terminal-toggle" class="titlebar-button" aria-label="Terminal" title="Terminal" aria-controls="terminal-dock" aria-expanded="false" hidden>${icons.terminal}<span>Terminal</span></button>
      <button type="button" id="settings-toggle" class="titlebar-button" aria-label="Settings" aria-haspopup="dialog" aria-controls="app-settings" hidden>${icons.settings}</button>
    </div>
  </header>
  <div class="workspace-notices" id="workspace-notices"></div>
  <div class="workspace" id="workspace">
    <aside id="ideas-panel" hidden></aside>
    <div id="sidebar" hidden>
      <aside id="navigator" hidden></aside>
      <aside id="change-review" hidden></aside>
    </div>
    <section class="workbench" tabindex="-1" aria-label="Code workspace">
  <main class="start-screen" id="start-screen" aria-labelledby="start-title" aria-busy="true">
    <div class="start-content">
      <div class="start-intro">
        <div class="start-copy">
          <h1 id="start-title">Welcome to Diffpane</h1>
          <p id="start-description">Open a file or folder in a Git working tree to get started.</p>
          <div id="start-error" hidden></div>
          <div class="start-actions" id="start-actions" hidden>
            <button type="button" id="open-folder">${icons.folder}Open Folder…</button>
            <button type="button" id="open-file">${icons.file}Open File…</button>
          </div>
        </div>
        <span class="workspace-art start-mark" aria-hidden="true">
          <svg viewBox="0 0 152 78" stroke-linecap="round" stroke-linejoin="round"></svg>
        </span>
      </div>
      <section class="recent-targets" id="recent-targets" aria-labelledby="recent-title" hidden>
        <h2 id="recent-title">Recently opened</h2>
        <ul class="recent-list" id="recent-list"></ul>
        <p id="recent-status" role="status" hidden></p>
      </section>
    </div>
  </main>
  <main class="feed-scroll" id="feed-scroll" hidden>
    <div class="feed" id="feed"></div>
    <div class="empty-state" id="empty-state">
      <span class="workspace-art empty-symbol" aria-hidden="true">
        <svg viewBox="0 0 138 78" stroke-linecap="round" stroke-linejoin="round"></svg>
      </span>
      <h2>Open a file</h2>
      <p>Select a file in the explorer.</p>
    </div>
  </main>
  </section>
    <aside id="claude-panel" hidden></aside>
    <aside id="review-notes-panel" hidden></aside>
  </div>
  <section id="git-workspace" aria-label="Git workspace" hidden></section>
  <section id="terminal-dock" aria-label="Workspace terminal" hidden></section>
  <footer class="statusbar"><span id="status-text">Opening workspace…</span><span class="statusbar-end" hidden><span class="current-only">Current file contents</span><span class="status-dot"></span><span id="save-state" role="status">Autosave on</span></span></footer>
  <main id="agent-threads" hidden></main>
`

const ui = {
  workspace: requireElement(app, '#workspace', HTMLElement),
  gitWorkspace: requireElement(app, '#git-workspace', HTMLElement),
  gitToggle: requireElement(app, '#git-workspace-toggle', HTMLButtonElement),
  workbench: requireElement(app, '.workbench', HTMLElement),
  ideasPanel: requireElement(app, '#ideas-panel', HTMLElement),
  ideasToggle: requireElement(app, '#ideas-toggle', HTMLButtonElement),
  sidebar: requireElement(app, '#sidebar', HTMLElement),
  navigator: requireElement(app, '#navigator', HTMLElement),
  contentSearchToggle: requireElement(app, '#content-search-toggle', HTMLButtonElement),
  changeReview: requireElement(app, '#change-review', HTMLElement),
  reviewToggle: requireElement(app, '#review-toggle', HTMLButtonElement),
  reviewNotesToggle: requireElement(app, '#review-notes-toggle', HTMLButtonElement),
  reviewNotesPanel: requireElement(app, '#review-notes-panel', HTMLElement),
  agentThreads: requireElement(app, '#agent-threads', HTMLElement),
  agentThreadsToggle: requireElement(app, '#agent-threads-toggle', HTMLButtonElement),
  claudePanel: requireElement(app, '#claude-panel', HTMLElement),
  claudeToggle: requireElement(app, '#claude-toggle', HTMLButtonElement),
  settingsToggle: requireElement(app, '#settings-toggle', HTMLButtonElement),
  terminalToggle: requireElement(app, '#terminal-toggle', HTMLButtonElement),
  terminalDock: requireElement(app, '#terminal-dock', HTMLElement),
  projectName: requireElement(app, '#project-name', HTMLElement),
  projectPath: requireElement(app, '#project-path', HTMLElement),
  branchName: requireElement(app, '#branch-name', HTMLElement),
  workspaceNotices: requireElement(app, '#workspace-notices', HTMLElement),
  feedScroll: requireElement(app, '#feed-scroll', HTMLElement),
  feed: requireElement(app, '#feed', HTMLElement),
  emptyState: requireElement(app, '#empty-state', HTMLElement),
  startScreen: requireElement(app, '#start-screen', HTMLElement),
  startTitle: requireElement(app, '#start-title', HTMLElement),
  startDescription: requireElement(app, '#start-description', HTMLElement),
  startError: requireElement(app, '#start-error', HTMLElement),
  startActions: requireElement(app, '#start-actions', HTMLElement),
  openFile: requireElement(app, '#open-file', HTMLButtonElement),
  openFolder: requireElement(app, '#open-folder', HTMLButtonElement),
  recentTargets: requireElement(app, '#recent-targets', HTMLElement),
  recentList: requireElement(app, '#recent-list', HTMLElement),
  recentStatus: requireElement(app, '#recent-status', HTMLElement),
  statusText: requireElement(app, '#status-text', HTMLElement),
}
setErrorNoticeHost(ui.workspaceNotices)
const bridge = window.diffpane
if (!bridge) {
  throw appError('The desktop connection is unavailable. Reopen the desktop app to continue.', {
    code: 'DESKTOP_BRIDGE_UNAVAILABLE',
  })
}
const api = bridge
const uiPreferences = getWorkspacePreferences()
const shortcutApi = api?.shortcuts
let fileMenuSyncQueued = false
let fileMenuSignature = ''
const platform = shortcutApi?.platform ?? (globalThis.navigator.platform.startsWith('Mac') ? 'darwin' : 'linux')
const isMac = platform === 'darwin'
/** @type {ShortcutOverrides} */
let shortcutOverrides = {}
let shortcutVersion = 0
/** @type {Disposable | undefined} */
let removedEditorFind
/** @type {Map<string, Card>} */
const cards = new Map()
/** @type {WorkspaceSnapshot | null} */
let snapshot = null
/** @type {OpenFile | null} */
let openedFile = null
let closed = false
let closingRequested = false
/** @type {import('../../../shared/recovery/app-errors.ts').AppError | null} */
let workspaceFailure = null
/** @type {number | null} */
let documentFrame = null
let firstDocumentRendered = false
let welcomeRendered = false
let navigationVersion = 0
/** @type {Set<{path: string}>} */
const mutations = new Set()
let reviewVisible = false
/** @type {ReviewScope} */
let reviewScope = 'focus'
/** @type {WorkspaceComparison} */
let reviewComparison = 'head'
/** @type {Map<string, ViewState>} */
const savedViews = new Map()
const fileHistory = new FileHistory()
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
let initialInventoryReady = false
let initialDocumentReady = false
let recentVersion = 0
let recentSignature = ''
let targetOpening = false
/** @type {Set<string>} */
const applyingAssistantPaths = new Set()
/** @type {Promise<void> | null} */
let applyingAssistantEdit = null
/** @type {'closed' | 'dock' | 'notebook'} */
let ideaMode = 'closed'
let ideaDocked = false
let zenMode = false
/** @type {HTMLElement | null} */
let focusBeforeIdeas = null

/** @type {'light' | 'dark' | undefined} */
let activeScheme
function syncTerminalLayout() {
  if (!api.terminal || ui.terminalDock.hidden) return
  const bounds = ui.terminalDock.getBoundingClientRect()
  api.terminal.layout(
    zenMode || !ui.agentThreads.hidden || document.querySelector('dialog[open]') ? 0 : bounds.height,
    window.innerHeight - bounds.bottom,
    activeScheme,
  )
}
const terminalBounds = new ResizeObserver(syncTerminalLayout)
let workspaceCommandsSuspended = false
function syncWorkspaceCommands() {
  syncTerminalLayout()
  const active = !ui.agentThreads.hidden || Boolean(document.querySelector('dialog[open]'))
  if (active === workspaceCommandsSuspended) return
  workspaceCommandsSuspended = active
  shortcutSequence.reset()
  shortcutApi?.setModal?.(active)
}
const workspaceDialogs = new MutationObserver(records => {
  if (records.some(record => record.target instanceof HTMLDialogElement)) syncWorkspaceCommands()
})
const unsubscribeTerminal = api.terminal?.onVisibility(visible => {
  ui.terminalDock.hidden = !visible
  ui.terminalToggle.setAttribute('aria-expanded', String(visible))
  if (visible) syncTerminalLayout()
})
terminalBounds.observe(ui.terminalDock)
ui.terminalToggle.addEventListener('click', event => {
  if (event.isTrusted && !closingRequested) runTask('Toggle terminal', async () => void (await api.terminal?.toggle()))
})
/** @type {Set<string>} */
const requestedEditorFonts = new Set()
const gitDiff = createGitDiff({
  load: api.git.contents,
  resolveLanguage: (model, source) => syntax.resolve(model, source),
  appearance: () => appearance.value,
})
const appearance = createAppearanceSettings(uiPreferences, (preferences, scheme) => {
  const themeChanged = activeScheme !== scheme
  if (themeChanged) {
    activeScheme = scheme
    syntax.setTheme(editorThemeName(scheme))
    recolorMarkdownPreviews(scheme)
    syncTerminalLayout()
  }
  const code = codeAppearance(preferences)
  gitDiff.updateAppearance(preferences)
  const bundledFont = bundledEditorFont(preferences.font)
  if (bundledFont && !requestedEditorFonts.has(bundledFont)) {
    requestedEditorFonts.add(bundledFont)
    // Monaco can measure fallback glyphs before the font finishes loading.
    runTask(
      'Load editor font',
      async () => {
        try {
          await document.fonts.load(`${code.fontSize}px "${bundledFont}"`)
        } catch (cause) {
          requestedEditorFonts.delete(bundledFont)
          throw cause
        }
        monaco.editor.remeasureFonts()
      },
      { silent: true },
    )
  }
  for (const card of cards.values()) {
    if (card.diffEditor) {
      card.diffEditor.updateOptions(diffAppearance(preferences, Boolean(card.reviewComparison)))
      updateComparisonAriaLabels(card)
    } else card.editor?.updateOptions(code)
  }
})

const overviewRulerColors = {
  added: { color: colorHex('light', 'addedEdge'), darkColor: colorHex('dark', 'addedEdge') },
  modified: { color: colorHex('light', 'modifiedEdge'), darkColor: colorHex('dark', 'modifiedEdge') },
  deleted: { color: colorHex('light', 'removedEdge'), darkColor: colorHex('dark', 'removedEdge') },
}

const settings =
  shortcutApi &&
  createSettings({
    appearance,
    billySetup: api.billy?.setup,
    onShowBillyTerminal: exitZenMode,
    platform,
    getBindings: () => shortcutOverrides,
    setBinding: (action, binding) => (binding === null ? shortcutApi.reset(action) : shortcutApi.set(action, binding)),
    resetBindings: () => shortcutApi.reset(),
    setCapturing: active => shortcutApi.setCapturing(active),
  })
const openSettings = () => {
  if (!closingRequested) runTask('Open settings', () => settings?.open())
}
ui.settingsToggle.hidden = !settings
ui.settingsToggle.addEventListener('click', openSettings)

/** @param {ShortcutAction} action */
function shortcutBinding(action) {
  return effectiveBinding(action, shortcutOverrides, isMac)
}

/** @param {ShortcutAction} action */
function shortcutLabel(action) {
  return bindingLabel(shortcutBinding(action), isMac)
}

/** @param {KeyboardEvent} event @param {ShortcutAction} action */
function matchesShortcut(event, action) {
  return matchesBinding(event, shortcutBinding(action), isMac)
}

/** @param {string} path @param {number | undefined} line @returns {FileAnchor | null} */
function workingFileAnchor(path, line) {
  return line === undefined ? null : { path, side: 'working', line, endLine: line, excerpt: '', direct: true }
}

const agentThreadPanel =
  api.agentThreads &&
  createAgentThreadPanel(ui.agentThreads, {
    api: api.agentThreads,
    openExternal: api.openExternal,
    onVisibilityChange: visible => {
      if (visible) app.dataset.agentThreads = isMac ? 'mac' : 'active'
      else delete app.dataset.agentThreads
      syncWorkspaceCommands()
    },
    openWorkspaceFile: async ({ path, line }) => {
      if (!(await openFile({ path }, { anchor: workingFileAnchor(path, line), focusEditor: true })))
        throw new Error('The linked file could not be opened.')
    },
  })
const openAgentThreads = agentThreadPanel
  ? () => {
      if (!closingRequested && !closed) agentThreadPanel.open()
    }
  : undefined
ui.agentThreadsToggle.hidden = !openAgentThreads
if (openAgentThreads) ui.agentThreadsToggle.addEventListener('click', openAgentThreads)

const assistant =
  api?.claude &&
  createAssistant(ui.claudePanel, ui.claudeToggle, api, {
    onOpen: () => {
      exitZenMode()
      returnFromIdeas({ dock: true })
      reviewNotes?.close()
    },
    getFileContext: assistantFileContext,
    openAgentThreads,
    openFile: async ({ path, anchor, startLine, endLine, side }) => {
      const location = startLine
        ? { path, side, line: startLine, endLine: endLine ?? startLine, excerpt: '', direct: true }
        : null
      if (!(await openFile({ path, anchor }, { anchor: location, ideaLink: Boolean(anchor) })))
        throw new Error('The linked file could not be opened.')
    },
    openIdea: async id => {
      if (!ideas || !setIdeasMode('dock') || !(await ideas.open(id))) throw new Error('This idea is unavailable.')
    },
    colorize: colorizeMarkdown,
    prepareSend: async ({ fileContext, ideaId }) => {
      if (closingRequested || closed) throw new Error('This window is closing.')
      const path = fileContext?.path
      await Promise.all([path ? cards.get(path)?.autosave?.flush() : undefined, ideaId ? ideas?.flush() : undefined])
    },
    applyEdit: async proposal => {
      if (closingRequested || closed) throw new Error('This window is closing.')
      const paths = proposal.kind === 'files' ? proposal.files.map(file => file.path) : []
      for (const path of paths) applyingAssistantPaths.add(path)
      const affectedCards = () => paths.flatMap(path => cards.get(path) ?? [])
      const apply = async () => {
        const open = affectedCards()
        for (const card of open) applyEditorReadOnly(card)
        const saves = await Promise.allSettled([
          ...open.map(card => card.autosave?.flush()),
          proposal.kind === 'idea' ? ideas?.flush() : undefined,
        ])
        const failed = saves.find(save => save.status === 'rejected')
        if (failed) throw appError(failed.reason, { operation: 'Save before applying changes' })
        await api.claude.apply(proposal.id)
      }
      applyingAssistantEdit = apply()
      try {
        syncSaveState()
        await applyingAssistantEdit
        const current = affectedCards()
        if (current.length) {
          for (const card of current) card.dirty = true
          syncReviewState()
          scheduleDocument()
        }
      } finally {
        applyingAssistantEdit = null
        applyingAssistantPaths.clear()
        for (const card of affectedCards()) applyEditorReadOnly(card)
        syncSaveState()
      }
    },
  })

function finishWorkspaceOpening() {
  if (workspaceOpening) workspaceOpening.hidden = true
  app.inert = false
  syncFileMenu()
}

function revealWorkspaceWhenReady() {
  if (closed || workspaceOpening?.hidden !== false || !initialInventoryReady || !initialDocumentReady) return
  finishWorkspaceOpening()
  rendererDiagnostics.measure('renderer.workspace-first-render', 0)
}

function showStartScreen(failed = false) {
  ui.startScreen.hidden = false
  ui.startScreen.setAttribute('aria-busy', 'false')
  ui.startTitle.textContent = 'Welcome to Diffpane'
  ui.startTitle.hidden = ui.startDescription.hidden = failed
  ui.startError.hidden = !failed
  const startMark = requireElement(ui.startScreen, '.start-mark', HTMLElement)
  startMark.hidden = failed
  if (!failed) {
    const art = requireElement(startMark, 'svg', SVGSVGElement)
    if (!art.hasChildNodes()) drawWelcomeArt(art)
    ui.startScreen.setAttribute('aria-labelledby', 'start-title')
  }
  ui.startDescription.textContent = 'Open a file or folder in a Git working tree to get started.'
  ui.startActions.hidden = !api
  ui.statusText.textContent = !api
    ? 'Desktop connection unavailable'
    : failed
      ? 'Choose another file or folder'
      : 'No project open'
  document.title = 'Diffpane'
  finishWorkspaceOpening()
  if (!failed && !welcomeRendered) {
    welcomeRendered = true
    rendererDiagnostics.measure('renderer.welcome-first-render', 0)
  }
  runTask('Load recent projects', loadRecentTargets)
}

async function loadRecentTargets() {
  if (!api) return
  const version = ++recentVersion
  try {
    const targets = await api.recentTargets()
    if (version !== recentVersion || closed || snapshot) return
    const signature = JSON.stringify(targets.map(target => [target.path, target.name, target.kind]))
    if (signature === recentSignature) return
    recentSignature = signature
    const focused = document.activeElement
    const focusedPath =
      focused instanceof HTMLElement && ui.recentList.contains(focused) ? focused.dataset.path : undefined
    const items = targets.map(target => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.disabled = targetOpening
      button.className = 'recent-target'
      button.dataset.kind = target.kind
      button.dataset.path = target.path
      button.title = target.path
      button.setAttribute('aria-label', `Open ${target.name}, ${target.path}`)
      const folder = target.kind === 'folder'
      button.innerHTML = `<span class="recent-glyph" aria-hidden="true"><svg viewBox="${folder ? '0 0 48 48' : '0 0 34 40'}" stroke-linecap="round" stroke-linejoin="round"></svg></span><span class="recent-label"><strong></strong><span class="recent-location"></span></span><span class="recent-arrow" aria-hidden="true">↗</span>`
      drawRecentTargetArt(requireElement(button, '.recent-glyph svg', SVGSVGElement), folder)
      requireElement(button, 'strong', HTMLElement).textContent = target.name
      requireElement(button, '.recent-location', HTMLElement).textContent = target.path
      const open = () => openRecentTarget(target.path)
      button.addEventListener('click', () =>
        runTask('Open recent project', open, { title: 'Couldn’t open this project', retry: open }),
      )
      item.append(button)
      return item
    })
    ui.recentList.replaceChildren(...items)
    ui.recentTargets.hidden = !items.length && ui.recentStatus.hidden
    if (focusedPath)
      [...ui.recentList.querySelectorAll('button')]
        .find(button => button.dataset.path === focusedPath)
        ?.focus({ preventScroll: true })
  } catch (cause) {
    if (version === recentVersion && !closed && !snapshot)
      reportError(cause, { operation: 'Load recent projects', silent: true })
  }
}

/** @param {boolean} opening */
function setTargetOpening(opening) {
  targetOpening = opening
  ui.openFile.disabled = ui.openFolder.disabled = opening
  for (const button of ui.recentList.querySelectorAll('button')) button.disabled = opening
}

/** @param {string} pathname */
async function openRecentTarget(pathname) {
  if (targetOpening || closingRequested || closed) return
  setTargetOpening(true)
  ui.recentStatus.hidden = true
  try {
    if (!(await api.openRecent(pathname))) {
      ui.recentStatus.textContent = 'This item is no longer available. Open a file or folder to locate it.'
      ui.recentStatus.hidden = false
      await loadRecentTargets()
    }
  } finally {
    setTargetOpening(false)
  }
}

/** @param {'file' | 'folder'} kind */
async function chooseTarget(kind) {
  if (targetOpening || closingRequested || closed) return
  setTargetOpening(true)
  try {
    await (kind === 'file' ? api.openFile() : api.openFolder())
  } finally {
    setTargetOpening(false)
  }
}
/** @param {'file' | 'folder'} kind */
function openTarget(kind) {
  const operation = kind === 'file' ? 'Open file' : 'Open folder'
  runTask(operation, () => chooseTarget(kind), {
    title: kind === 'file' ? 'Couldn’t open the file picker' : 'Couldn’t open the folder picker',
    retry: () => chooseTarget(kind),
  })
}
ui.openFile.addEventListener('click', () => openTarget('file'))
ui.openFolder.addEventListener('click', () => openTarget('folder'))
window.addEventListener('focus', () => {
  if (!snapshot && ui.startScreen.getAttribute('aria-busy') === 'false')
    runTask('Load recent projects', loadRecentTargets)
})

function syncSaveState() {
  api.setSaveState(
    applyingAssistantEdit !== null ||
      (ideas?.pending ?? false) ||
      [...cards.values()].some(card => card.autosave?.pending),
  )
  syncReviewState()
}

// Coalesce saves per card; a previous file's slow read must not block navigation.
function scheduleDocument() {
  if (documentFrame !== null || closed) return
  documentFrame = requestAnimationFrame(
    guard('Schedule file update', () => {
      documentFrame = null
      const card = openedFile ? cards.get(openedFile.path) : undefined
      if (card?.active && !card.loading && card.dirty && !card.autosave?.pending)
        runTask('Load file', () => loadDocument(card))
    }),
  )
}
/** @type {Map<string, string>} */
const filenameLanguages = new Map()
/** @type {Map<string, string>} */
const extensionLanguages = new Map()
for (const language of monaco.languages.getLanguages()) {
  const label = language.aliases?.[0] ?? language.id
  /** @type {[string[] | undefined, Map<string, string>][]} */
  const associations = [
    [language.filenames, filenameLanguages],
    [language.extensions, extensionLanguages],
  ]
  for (const [patterns, labels] of associations) {
    for (const pattern of patterns ?? []) {
      const key = pattern.toLocaleLowerCase()
      if (key && !labels.has(key)) labels.set(key, label)
    }
  }
}
const extensionLengths = [...new Set([...extensionLanguages.keys()].map(key => key.length))].toSorted((a, b) => b - a)
/** @param {string} pathname */
function languageForPath(pathname) {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1).toLocaleLowerCase()
  const exact = filenameLanguages.get(name)
  if (exact) return exact
  for (const length of extensionLengths) {
    if (length > name.length) continue
    const label = extensionLanguages.get(name.slice(-length))
    if (label) return label
  }
  return 'Plain text'
}

/** @param {string} pathname @param {string | undefined} file */
function pathAffects(pathname, file) {
  return file === pathname || file?.startsWith(`${pathname}/`)
}

/** @param {Card} card */
function editorReadOnly(card) {
  return (
    closingRequested ||
    !card.document?.editable ||
    applyingAssistantPaths.has(card.file.path) ||
    [...mutations].some(mutation => pathAffects(mutation.path, card.file.path))
  )
}

/** @param {Card} card */
function applyEditorReadOnly(card) {
  const readOnly = editorReadOnly(card)
  card.editor?.updateOptions({ readOnly, domReadOnly: readOnly })
}

function closeCurrentFile() {
  navigationVersion++
  for (const card of cards.values()) {
    deactivate(card)
    rememberView(card.file.path, card.viewState)
  }
  cards.clear()
  openedFile = null
  billyContext?.clear()
  assistant?.refreshContext()
  ideas?.refreshContext()
  ui.feed.replaceChildren()
  ui.emptyState.hidden = false
  navigator.select(null)
  syncReviewState()
  setSaveLabel('Autosave on')
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
  if (outline) outline.textContent = 'Open a file to see its outline'
}

async function closeEditors(focusCode = false) {
  const version = ++navigationVersion
  const card = openedFile ? cards.get(openedFile.path) : undefined
  await card?.autosave?.flush()
  if (version !== navigationVersion || closed || closingRequested) return
  fileHistory.closeOthers()
  if (focusCode) returnFromIdeas()
  if (focusCode || card?.element.contains(document.activeElement)) ui.workbench.focus({ preventScroll: true })
  closeCurrentFile()
}

/** @param {'rename' | 'trash'} action @param {string} pathname @param {string} [name] */
async function mutateFile(action, pathname, name) {
  if (closingRequested || closed) throw new Error('This window is closing.')
  const mutation = { path: pathname }
  mutations.add(mutation)
  try {
    const current = openedFile ? cards.get(openedFile.path) : undefined
    if (current && pathAffects(pathname, current.file.path)) {
      applyEditorReadOnly(current)
      await current.autosave?.flush()
    }
    let destination
    if (action === 'rename') {
      if (name === undefined) throw new Error('Enter a name for this file.')
      destination = await api.rename(pathname, name)
    } else await api.fileAction(action, pathname)
    if (closed) return
    if (destination === pathname) return
    fileHistory.move(pathname, destination)
    syncFileMenu()
    if (destination) navigator.renamed(pathname, destination)
    if (openedFile && pathAffects(pathname, openedFile.path)) {
      const previous = openedFile.path
      const affected = cards.get(previous)
      closeCurrentFile()
      if (destination && !closingRequested) {
        const path = `${destination}${previous.slice(pathname.length)}`
        rememberView(path, affected?.viewState)
        await openFile(
          { path },
          {
            compare: affected?.comparing,
            comparison: affected?.comparison,
            review: affected?.reviewComparison ?? false,
            source: affected?.markdownSource,
          },
        )
        return
      }
    }
  } finally {
    mutations.delete(mutation)
    const current = openedFile ? cards.get(openedFile.path) : undefined
    if (current) applyEditorReadOnly(current)
  }
}
const navigator = createNavigator(ui.navigator, api, openFile, {
  onOpenChange: (file, change) => openFile(file, { compare: true, change }),
  onInitialScan: ready => {
    if (ready) {
      initialInventoryReady = true
      revealWorkspaceWhenReady()
    } else finishWorkspaceOpening()
  },
  onReady: startBackgroundAnalysis,
  iconFor: projectIcon,
  onMutate: (action, path, name) => {
    if (action === 'rename' || action === 'trash') return mutateFile(action, path, name)
    throw new Error('Unknown file action.')
  },
  onAttach: api.ideas ? path => attachIdeaLink({ path }) : undefined,
  languageFor: languageForPath,
  onPick: () => openFilePicker(),
  matchesShortcut,
  onFolder: () => openTarget('folder'),
  onOutline: list => {
    const card = openedFile ? cards.get(openedFile.path) : undefined
    if (card?.markdownPreview) showMarkdownOutline(card, list)
    else if (card?.editor) runTask('Load file outline', () => showSymbols(card, list))
    else if (card?.documentFailed) list.textContent = 'Symbols unavailable'
    else if (!card) list.textContent = 'Open a file to see its outline'
  },
})
const reviewCount = createRollingNumber()
reviewCount.className = 'titlebar-review-count'
reviewCount.hidden = true
ui.reviewToggle.append(reviewCount)
const review = createChangeReview(ui.changeReview, {
  onOpen: file => openFile(file, { compare: true, comparison: reviewComparison }),
  onBack: toggleReview,
  onBaseline: updateReviewBaseline,
  includeFile: file => billyLanes?.includes(file) ?? true,
  laneStatus: file => billyLanes?.status(file) ?? null,
  onCapture: async () => {
    await (openedFile ? cards.get(openedFile.path) : undefined)?.autosave?.flush()
    if (closingRequested || closed) throw new Error('This window is closing.')
    const next = await api.captureCheckpoint()
    applySnapshot(next)
    if (!closed) updateReviewBaseline('checkpoint')
  },
  onProgress: ({ pending, total }) => {
    ui.reviewToggle.dataset.pending = String(pending > 0)
    reviewCount.hidden = pending === 0
    if (reviewCount.value !== pending) reviewCount.update(pending)
    const description =
      pending > 0
        ? `${pending.toLocaleString()} unreviewed ${pending === 1 ? 'file' : 'files'}`
        : total > 0
          ? 'All changes reviewed'
          : 'No changed files'
    ui.reviewToggle.setAttribute('aria-description', description)
  },
})
const billyContext = api.billy && createBillyReviewContext(api.billy, openBillySource)
const billyLanes =
  api.billy &&
  createBillyLanes(review.laneHost, {
    listLanes: api.billy.listLanes,
    readLaneChecks: api.billy.readLaneChecks,
    readLaneLog: api.billy.readLaneLog,
    onChange: () => review.refreshScope(),
    onOpen: openBillySource,
  })
let billyAvailable = false
let billyLanesRefreshed = -Infinity
ui.reviewToggle.addEventListener('click', toggleReview)

const gitWorkspace = createGitWorkspace(ui.gitWorkspace, {
  loadOverview: api.git.overview,
  loadChanges: api.git.changes,
  openFile: gitDiff.open,
  openReview: openGitReviewQueue,
})
ui.gitToggle.addEventListener('click', () => {
  if (!snapshot || closed || closingRequested) return
  if (closeGitWorkspace()) {
    ui.gitToggle.focus()
    return
  }
  exitZenMode()
  returnFromIdeas()
  ui.workspace.hidden = true
  app.dataset.gitWorkspace = 'open'
  ui.gitToggle.setAttribute('aria-pressed', 'true')
  gitWorkspace.show()
})
ui.gitWorkspace.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLSelectElement) return
  if (document.querySelector('dialog[open]')) return
  event.preventDefault()
  closeGitWorkspace()
  ui.gitToggle.focus()
})

function closeGitWorkspace() {
  if (ui.gitWorkspace.hidden) return false
  gitWorkspace.hide()
  ui.workspace.hidden = false
  delete app.dataset.gitWorkspace
  ui.gitToggle.setAttribute('aria-pressed', 'false')
  return true
}

function openGitReviewQueue() {
  closeGitWorkspace()
  reviewVisible = true
  setSidebarVisible(true)
  review.focus()
}

function refreshGitWorkspace() {
  if (!ui.gitWorkspace.hidden) gitWorkspace.refresh()
}

window.addEventListener('focus', refreshGitWorkspace)
const unsubscribeGitChanges = api.git.onChange(refreshGitWorkspace)

/** @param {string} path @param {number} [line] */
async function openBillySource(path, line) {
  if (!snapshot) return false
  const target = `${snapshot.root.replace(/\/$/u, '')}/${path}`
  if (!target.startsWith(`${snapshot.scope.replace(/\/$/u, '')}/`))
    throw new Error('This source is outside the open folder. Open the Billy repository root to review it here.')
  const file = reviewFiles().find(item => item.path === path)
  const anchor = line === undefined ? null : { path, line, endLine: line, excerpt: '', direct: true }
  if (!(await openFile(file ?? { path }, { compare: Boolean(file), comparison: reviewComparison, anchor })))
    throw new Error('This source could not be opened in the current comparison.')
  return true
}

function refreshBillyLanes() {
  const now = performance.now()
  if (!billyAvailable || !billyLanes || review.laneHost.closest('[hidden]') || now - billyLanesRefreshed < 15_000)
    return
  billyLanesRefreshed = now
  runTask('Load agent lanes', billyLanes.refresh)
}
window.addEventListener('focus', refreshBillyLanes)

/** @param {WorkspaceComparison} [comparison] */
function reviewFiles(comparison = reviewComparison) {
  return (comparison === 'head' ? snapshot?.files : snapshot?.checkpoint?.files) ?? []
}

/** @param {'head' | 'checkpoint'} [mode] @param {boolean} [registryChanged] */
function updateReviewBaseline(mode = reviewComparison === 'head' ? 'head' : 'checkpoint', registryChanged = false) {
  const checkpoint = snapshot?.checkpoint
  /** @type {WorkspaceComparison} */
  const next = mode === 'checkpoint' && checkpoint ? `checkpoint:${checkpoint.id}` : 'head'
  const changed = next !== reviewComparison
  reviewComparison = next
  review.setBaseline(next === 'head' ? 'head' : 'checkpoint', checkpoint)
  const files = reviewFiles()
  billyLanes?.setPaths(files)
  billyContext?.setChanges(
    files.map(file => file.path),
    next,
    registryChanged,
  )
  if (changed) {
    navigationVersion++
    const card = openedFile ? cards.get(openedFile.path) : undefined
    if (card?.reviewComparison) {
      const file = files.find(entry => entry.path === card.file.path)
      if (file) openComparison(card, next, file)
      else if (isCheckpointOnlyDeletion(card)) closeCurrentFile()
      else {
        card.modeVersion = (card.modeVersion ?? 0) + 1
        card.comparing = false
        card.reviewComparison = false
        setDocumentComparison(card, 'head')
        if (card.document && !card.autosave?.pending) renderCurrentDocument(card)
      }
    }
  }
  review.update(files)
  syncReviewState()
  if (changed) updateEmptyStateHint()
}

/** @param {Card} card */
function isCheckpointOnlyDeletion(card) {
  return card.document?.workingMissing && !reviewFiles('head').some(file => file.path === card.file.path)
}

function syncReviewState() {
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const version = card?.document?.reviewVersion ?? null
  /** @type {import('../../review/queue/change-review.js').ReviewState | null} */
  let state = null
  if (card?.comparing && card.comparison === reviewComparison) {
    if (closingRequested) state = 'closing'
    else if (applyingAssistantPaths.has(card.file.path)) state = 'saving'
    else if (card.autosave?.pending) state = card.saveError ? 'save-failed' : 'saving'
    else if (card.loading || card.dirty) state = 'loading'
    else if (card.documentFailed) state = 'failed'
    else state = 'ready'
  }
  review.setCurrent(card?.file.path ?? null, state, version)
  billyContext?.setChanged(Boolean(card && reviewFiles().some(file => file.path === card.file.path)))
  syncFileMenu()
}

const languageFeatures = createLanguageFeatures(monaco, api, { onState: updateLanguageState })
const howmany = createHowMany(monaco, api, ui.navigator, requireElement(app, '.statusbar-end', HTMLElement))
function startBackgroundAnalysis() {
  if (closed || !snapshot || navigator.stats().loading) return
  const card = openedFile ? cards.get(openedFile.path) : undefined
  if (card?.dirty || card?.loading) return
  howmany?.start()
}
const languageWidgets = document.createElement('div')
languageWidgets.className = 'monaco-editor language-widgets'
document.body.append(languageWidgets)
const openFilePicker = createFilePicker(
  api,
  file => {
    if (!file.directory) return openFile(file)
    if (returnFromIdeas()) showFileExplorer()
    navigator.revealDirectory(file.path)
    return undefined
  },
  () => snapshot?.scope ?? snapshot?.root ?? ui.projectPath.textContent,
  languageForPath,
  () => {
    const root = snapshot?.root?.replaceAll('\\', '/').replace(/\/$/u, '') ?? ''
    const scope = snapshot?.scope?.replaceAll('\\', '/').replace(/\/$/u, '') ?? root
    return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : ''
  },
)
const contentSearch = createContentSearch(api, match => openFile({ path: match.path }, { match }))
const reviewNotes =
  api?.reviewNotes &&
  createReviewNotes(ui.reviewNotesPanel, ui.reviewNotesToggle, api.reviewNotes, {
    matchesSaveShortcut: event => matchesShortcut(event, 'saveReviewNote'),
    capture: () => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      return card ? captureReviewAnchor(card, card.noteSide ?? 'working') : null
    },
    onJump: anchor => {
      const rename = snapshot?.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === anchor.path,
      )
      const path = rename?.path ?? anchor.path
      return openFile({ path }, { anchor })
    },
    onVisible: visible => {
      if (visible && !ui.claudePanel.hidden) assistant?.toggle(false, false)
    },
  })

const ideas =
  api?.ideas &&
  mountIdeaBuilder(ui.ideasPanel, {
    getWorkspace: () => snapshot?.root,
    getShortcut: shortcutBinding,
    isMac,
    load: api.ideas.list,
    save: api.ideas.upsert,
    remove: api.ideas.delete,
    onPendingChange: syncSaveState,
    onClose: () => {
      if (!returnFromIdeas({ restoreFocus: true })) {
        if (setIdeasMode('closed', { remember: true })) ui.ideasToggle.focus()
      }
    },
    onDock: () => {
      if (setIdeasMode('dock', { remember: true })) {
        focusBeforeIdeas = null
        ideas.focus()
      }
    },
    onExpand: showIdeasNotebook,
    hasCurrentLink: () => Boolean(openedFile),
    getCurrentLink: () => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      return card ? captureIdeaLink(card) : null
    },
    openLink: async link => {
      const workspace = snapshot
      if (!workspace) throw new Error('Open the repository to view this linked file.')
      const renamed = workspace.files.find(
        file => (file.index === 'R' || file.worktree === 'R') && file.originalPath === link.path,
      )
      const anchor = {
        ...link,
        line: link.line ?? null,
        endLine: link.endLine ?? link.line ?? null,
        excerpt: link.excerpt ?? '',
      }
      const path = renamed?.path ?? link.path
      const root = workspace.root.replaceAll('\\', '/').replace(/\/$/u, '')
      const scope = workspace.scope.replaceAll('\\', '/').replace(/\/$/u, '')
      if (root !== scope && !`${root}/${path}`.startsWith(`${scope}/`))
        throw new Error('Open the repository root to view this linked file.')
      if (!(await openFile({ path }, { anchor, ideaLink: true })))
        throw new Error('The linked file could not be opened.')
    },
    draftInChat: assistant ? idea => assistant.attachIdea(idea) : undefined,
    openMarkdownFile: async target => {
      if (!(await openFile(target, { ideaLink: true }))) throw new Error('The linked file could not be opened.')
    },
    openExternal: api.openExternal,
    media: api.media,
  })
const workspaceLayout = createWorkspaceLayout(ui.workspace, uiPreferences)
const unsubscribeIdeaVisibility = uiPreferences.onChange('ideasVisible', syncIdeasVisibility)
ui.ideasToggle.addEventListener('click', () => {
  closeGitWorkspace()
  if (!returnFromIdeas({ restoreFocus: true })) showIdeasNotebook()
})
ui.claudeToggle.addEventListener(
  'click',
  event => {
    closeGitWorkspace()
    if (!returnFromIdeas()) return
    event.stopImmediatePropagation()
    assistant?.toggle(true)
  },
  { capture: true },
)
ui.reviewNotesToggle.addEventListener(
  'click',
  () => {
    closeGitWorkspace()
    exitZenMode()
    if (returnFromIdeas()) reviewNotes?.close()
  },
  { capture: true },
)

/** @param {'closed' | 'dock' | 'notebook'} mode */
function setIdeasMode(mode, { remember = false } = {}) {
  if (!ideas || !snapshot || closingRequested || closed) return false
  const notebook = mode === 'notebook'
  ideaMode = mode
  if (!notebook) ideaDocked = mode === 'dock'
  ui.ideasPanel.hidden = mode === 'closed'
  ideas.setMode(notebook ? 'notebook' : 'dock')
  workspaceLayout.setIdeasNotebook(notebook, ideaDocked)
  languageWidgets.hidden = notebook
  ui.ideasToggle.setAttribute('aria-expanded', String(notebook))
  if (remember) uiPreferences.set('ideasVisible', ideaDocked)
  return true
}

/** @param {boolean} docked */
function syncIdeasVisibility(docked) {
  if (!ideas || !snapshot || closingRequested || closed || docked === ideaDocked) return
  if (ideaMode === 'notebook') {
    ideaDocked = docked
    workspaceLayout.setIdeasNotebook(true, docked)
  } else setIdeasMode(docked ? 'dock' : 'closed')
}

function showIdeasNotebook() {
  exitZenMode()
  if (ideaMode === 'notebook') return
  const previous = document.activeElement
  if (!setIdeasMode('notebook')) return
  focusBeforeIdeas = previous instanceof HTMLElement ? previous : null
  ideas?.focus()
}

function returnFromIdeas({ dock = ideaDocked, restoreFocus = false } = {}) {
  if (ideaMode !== 'notebook' || !setIdeasMode(dock ? 'dock' : 'closed')) return false
  if (restoreFocus) {
    const previous = focusBeforeIdeas
    if (previous?.isConnected && previous !== document.body && !previous.closest('[hidden], [inert]'))
      previous.focus({ preventScroll: true })
    if (document.activeElement === document.body || document.activeElement !== previous) ui.ideasToggle.focus()
  }
  focusBeforeIdeas = null
  return true
}

/** @param {IdeaLink} link */
function attachIdeaLink(link) {
  if (!ideas || !snapshot || closingRequested) return
  if (ideaMode === 'closed') setIdeasMode('dock')
  ideas.attach(link)
}

function openContentSearch() {
  if (!contentSearch || !snapshot || closingRequested) return
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const editor = card?.diffEditor?.getOriginalEditor().hasTextFocus()
    ? card.diffEditor.getOriginalEditor()
    : card?.editor
  const range = editor?.getSelection()
  const selection =
    range && range.startLineNumber === range.endLineNumber && !range.isEmpty()
      ? (editor?.getModel()?.getValueInRange(range) ?? '')
      : ''
  contentSearch.open(snapshot.scope || snapshot.root, selection)
}
ui.contentSearchToggle.addEventListener('click', openContentSearch)

/** @param {string} pathname @param {ViewState | null | undefined} state */
function rememberView(pathname, state) {
  if (!state) return
  savedViews.delete(pathname)
  savedViews.set(pathname, state)
  if (savedViews.size > 64) {
    const oldest = savedViews.keys().next()
    if (!oldest.done) savedViews.delete(oldest.value)
  }
}

/** @param {OpenFile} file @param {OpenOptions} [options] */
async function openFile(
  file,
  {
    compare = false,
    comparison = 'head',
    review: focusReview = compare,
    source = false,
    match = null,
    anchor = null,
    ideaLink = false,
    historyIndex,
    focusEditor = false,
    change,
  } = {},
) {
  if (closingRequested || closed) return false
  const openedAt = performance.now()
  const version = ++navigationVersion
  const current = openedFile ? cards.get(openedFile.path) : undefined
  if (current?.autosave?.pending) {
    try {
      await current.autosave.flush()
    } catch {
      if (version === navigationVersion && !closed) navigator.select(current.file.path)
      return false
    }
  }
  if (version !== navigationVersion || closingRequested || closed) return false
  closeGitWorkspace()
  if (ideaMode === 'notebook') {
    try {
      await api.document(file.path, compare ? comparison : 'head')
    } catch (error) {
      if (version !== navigationVersion || closingRequested || closed) return false
      if (ideaLink) throw error
      if (ideaMode === 'notebook') ideas.notify(appError(error, { operation: 'Open file' }).message)
      return false
    }
    if (version !== navigationVersion || closingRequested || closed) return false
    if (returnFromIdeas({ dock: ideaLink || ideaDocked })) ui.workbench.focus({ preventScroll: true })
  }
  fileHistory.record(file.path, historyIndex)
  if (openedFile?.path === file.path && current) {
    if (focusEditor) (current.editor ?? ui.workbench).focus()
    navigator.select(file.path)
    current.pendingReviewAnchor = anchor
    current.anchorFromIdea = ideaLink
    current.reviewNotice.hidden = true
    if (compare && anchor?.direct) {
      openComparison(current, comparison, file)
      current.pendingReviewAnchor = anchor
      if (!current.loading && !current.dirty) revealReviewAnchor(current)
    } else if (anchor) {
      current.pendingMatch = null
      current.modeVersion = (current.modeVersion ?? 0) + 1
      const comparing = anchor.side === 'head'
      const markdownSource = comparing || anchor.line !== null
      const modeChanged =
        current.comparing !== comparing ||
        current.reviewComparison === true ||
        (isMarkdown(file.path) && Boolean(current.markdownSource) !== markdownSource)
      current.markdownSource = markdownSource
      current.comparing = comparing
      if (current.reviewComparison && comparing && current.diffEditor) {
        current.reviewFocus.detach()
        current.diffEditor.updateOptions({
          ...diffAppearance(appearance.value, false),
          hideUnchangedRegions: { enabled: false },
        })
      }
      current.reviewComparison = false
      const reloading = setDocumentComparison(current, 'head')
      if (current.documentFailed) {
        current.dirty = true
        scheduleDocument()
      } else if (modeChanged && current.document && (!reloading || !comparing)) {
        renderCurrentDocument(current)
      } else if (!reloading && !current.loading) revealReviewAnchor(current)
      syncReviewState()
    } else if (compare) {
      openComparison(current, comparison, file, change)
    } else if (match) {
      current.pendingMatch = match
      current.modeVersion = (current.modeVersion ?? 0) + 1
      const modeChanged = current.comparing || (isMarkdown(file.path) && !current.markdownSource)
      current.markdownSource = true
      current.comparing = false
      current.reviewComparison = false
      setDocumentComparison(current, 'head')
      if ((modeChanged || current.document?.preview) && current.document && !current.documentFailed)
        renderCurrentDocument(current)
      else if (!current.dirty && !current.loading) revealContentMatch(current)
      if (current.documentFailed) {
        current.dirty = true
        scheduleDocument()
      }
      syncReviewState()
    } else if (ideaLink && file.anchor && isMarkdown(file.path) && !current.markdownSource) {
      current.markdownAnchor = file.anchor
      if (current.markdownPreview && current.markdownText === current.document?.after) renderCurrentDocument(current)
    }
    return true
  }
  for (const card of cards.values()) {
    deactivate(card)
    rememberView(card.file.path, card.viewState)
    card.element.remove()
  }
  cards.clear()
  openedFile = file
  assistant?.refreshContext()
  const card = createCard(reviewFiles(comparison).find(value => value.path === file.path) ?? file, openedAt)
  if (focusEditor) {
    card.focusOnLoad = true
    ui.workbench.focus({ preventScroll: true })
  }
  card.markdownAnchor = file.anchor ?? null
  const anchorLine = anchor?.line
  card.markdownSource = source || compare || Boolean(match) || (anchorLine !== null && anchorLine !== undefined)
  card.pendingMatch = match
  card.pendingReviewAnchor = anchor
  card.anchorFromIdea = ideaLink
  if (anchor?.side === 'head') {
    card.comparing = true
    card.markdownSource = true
  }
  card.viewState = savedViews.get(file.path) ?? null
  cards.set(file.path, card)
  card.active = true
  ui.feed.replaceChildren(card.element)
  const contextSlot = requireElement(card.element, '.billy-context-slot', HTMLDivElement)
  const contextTrigger = requireElement(card.element, '.billy-review-trigger', HTMLButtonElement)
  billyContext?.bind(contextSlot, contextTrigger, {
    path: file.path,
    changed: reviewFiles().some(entry => entry.path === file.path),
    text: !mediaType(file.path) && file.submodule !== true,
    line: () => {
      const selection = card.editor?.getSelection()
      if (selection && !selection.isEmpty()) return selection.startLineNumber
      return card.reviewFocus.workingLine() ?? selection?.startLineNumber ?? null
    },
  })
  ideas?.refreshContext()
  ui.emptyState.hidden = true
  setSaveLabel('Autosave on')
  navigator.select(file.path)
  if (focusReview) openComparison(card, comparison, undefined, change)
  else {
    if (compare) {
      card.comparing = true
      setDocumentComparison(card, comparison)
    }
    syncReviewState()
  }
  const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
  if (outline) {
    if (mediaType(file.path)) outline.textContent = 'No outline for media files'
    else outline.replaceChildren(symbolsPlaceholder())
  }
  scheduleDocument()
  return true
}

/** @param {{path: string, language: string, status: string, message?: string, diagnostics?: number}} state */
function updateLanguageState(state) {
  const card = cards.get(state.path)
  if (!card) return
  card.languageState = state
  card.language.textContent =
    monaco.languages.getLanguages().find(language => language.id === card.model?.getLanguageId())?.aliases?.[0] ??
    state.language
  const ready = state.status === 'ready'
  const badge = requireElement(card.element, '.language-state', HTMLElement)
  const label = ready ? 'Language ready' : state.status === 'starting' ? 'Loading language…' : 'Syntax'
  const issues = state.diagnostics ? ` · ${state.diagnostics} ${state.diagnostics === 1 ? 'issue' : 'issues'}` : ''
  if (badge.textContent !== label + issues) badge.textContent = label + issues
  badge.dataset.status = state.status
  badge.title =
    (state.message?.length ? state.message : undefined) ??
    (ready ? 'Semantic features available for this language server' : 'Language services load when this file is used')
}

function symbolsPlaceholder() {
  const placeholder = documentNode('span', 'symbol-empty', 'Loading symbols…')
  placeholder.setAttribute('data-loading-status', '')
  return placeholder
}

/** @param {Card} card @param {Element | null} [list] */
async function showSymbols(card, list = card.element.querySelector('.symbol-list')) {
  const { editor, model } = card
  if (!editor || !model || !list) return
  const version = model.getVersionId()
  const placeholder = symbolsPlaceholder()
  const isCurrent = () => card.editor === editor && model.getVersionId() === version && list.firstChild === placeholder
  list.replaceChildren(placeholder)
  try {
    const symbols = await languageFeatures.symbols(card.file.path)
    if (!isCurrent()) return
    /** @type {HTMLButtonElement[]} */
    const nodes = []
    /** @param {Awaited<ReturnType<typeof languageFeatures.symbols>>} items */
    const append = (items, depth = 0) => {
      for (const symbol of items) {
        const button = documentNode('button', 'symbol-item', symbol.name)
        button.type = 'button'
        button.style.paddingLeft = `${12 + depth * 12}px`
        button.title = symbol.detail ? symbol.detail : symbol.name
        button.addEventListener('click', () => {
          if (card.editor !== editor) return
          editor.revealLineInCenter(symbol.selectionRange.startLineNumber)
          editor.setPosition({
            lineNumber: symbol.selectionRange.startLineNumber,
            column: symbol.selectionRange.startColumn,
          })
          requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open = false
          editor.focus()
        })
        nodes.push(button)
        append(symbol.children ?? [], depth + 1)
      }
    }
    append(symbols)
    list.replaceChildren(...(nodes.length ? nodes : [documentNode('span', 'symbol-empty', 'No symbols available')]))
  } catch (error) {
    if (!isCurrent()) return
    const failure = reportError(error, { operation: 'Load file outline', silent: true })
    list.replaceChildren(documentNode('span', 'symbol-empty', failure.message))
  } finally {
    placeholder.removeAttribute('data-loading-status')
  }
}

/** @param {Card} card @param {Element} list */
function showMarkdownOutline(card, list) {
  const headings = [
    ...card.host.querySelectorAll(
      '.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6',
    ),
  ]
  const buttons = headings.map(heading => {
    const button = documentNode('button', 'symbol-item', heading.textContent.replace(/#$/, ''))
    button.type = 'button'
    button.style.paddingLeft = `${12 + (Number(heading.tagName.slice(1)) - 1) * 12}px`
    button.addEventListener('click', () => heading.scrollIntoView({ block: 'start' }))
    return button
  })
  list.replaceChildren(
    ...(buttons.length ? buttons : [documentNode('span', 'symbol-empty', 'No headings in this document')]),
  )
}

/** @param {string} code @param {string} language */
async function colorizeMarkdown(code, language) {
  /** @type {Record<string, string>} */
  const aliases = {
    js: 'javascript',
    ts: 'typescript',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    py: 'python',
  }
  const id = aliases[language] ?? language
  await syntax.ensureLanguage(id)
  return monaco.editor.colorize(code, id, {})
}

function toggleNavigator() {
  if (!snapshot) return
  if (exitZenMode()) {
    showFileExplorer()
    return
  }
  if (returnFromIdeas()) showFileExplorer()
  else setSidebarVisible(Boolean(ui.sidebar.hidden))
}

function showFileExplorer() {
  closeGitWorkspace()
  exitZenMode()
  returnFromIdeas()
  reviewVisible = false
  setSidebarVisible(true)
  requireElement(ui.navigator, '.navigator-tree', HTMLElement).focus()
}

/** @param {string} pathname */
function revealFileInExplorer(pathname) {
  showFileExplorer()
  navigator.revealFile(pathname)
}

/** @param {-1 | 1} offset */
function navigateFileHistory(offset) {
  const target = fileHistory.navigate(offset, openedFile?.path)
  if (target) return openFile({ path: target.path }, { historyIndex: target.index, focusEditor: true })
  return undefined
}

function switchToPreviousFile() {
  const path = fileHistory.previous(openedFile?.path)
  if (path !== undefined) return openFile({ path }, { focusEditor: true })
  return undefined
}

function toggleReview() {
  if (!snapshot) return
  if (!ui.gitWorkspace.hidden) {
    openGitReviewQueue()
    return
  }
  const wasZen = exitZenMode()
  reviewVisible = returnFromIdeas() || wasZen || ui.sidebar.hidden === true || !reviewVisible
  setSidebarVisible(true)
  if (reviewVisible) review.focus()
  else requireElement(ui.navigator, '.navigator-tree', HTMLElement).focus()
}

/** @param {boolean} active */
function setZenMode(active) {
  zenMode = active
  workspaceLayout.setZenMode(active)
  syncTerminalLayout()
}

function exitZenMode() {
  if (!zenMode) return false
  setZenMode(false)
  return true
}

function toggleZenMode() {
  if (exitZenMode()) return
  closeGitWorkspace()
  returnFromIdeas()
  if (!ui.workbench.contains(document.activeElement)) {
    const editor = openedFile ? cards.get(openedFile.path)?.editor : undefined
    if (editor) editor.focus()
    else ui.workbench.focus({ preventScroll: true })
  }
  setZenMode(true)
}

/** @param {boolean} visible */
function setSidebarVisible(visible) {
  ui.sidebar.hidden = !visible
  const showFiles = visible && !reviewVisible
  if (showFiles !== !ui.navigator.hidden) navigator.toggle()
  const showReview = visible && reviewVisible
  review.setVisible(showReview)
  if (showReview) refreshBillyLanes()
  ui.reviewToggle.setAttribute('aria-pressed', String(showReview))
  ui.emptyState.toggleAttribute('data-review', showReview)
  requireElement(ui.emptyState, 'h2', HTMLElement).textContent = showReview ? 'Choose a file to review' : 'Open a file'
  drawWorkbenchArt(requireElement(ui.emptyState, '.empty-symbol svg', SVGSVGElement), showReview)
  updateEmptyStateHint()
}

function updateEmptyStateHint() {
  const showReview = ui.reviewToggle.getAttribute('aria-pressed') === 'true'
  requireElement(ui.emptyState, 'p', HTMLElement).textContent = showReview
    ? `Compare the working tree with ${reviewComparison === 'head' ? 'Git HEAD' : 'your checkpoint'}.`
    : `Select a file in the explorer, or press ${shortcutLabel('searchFiles')}.`
}

/** @param {OpenFile} file @param {number} openedAt */
function createCard(file, openedAt) {
  const element = document.createElement('section')
  element.className = 'file-card'
  element.dataset.path = file.path
  element.innerHTML = `
    <div class="file-header">
      <span class="file-icon">${icons.file}</span>
      <div class="file-path"><span class="file-directory"></span><strong class="file-name"></strong></div>
      <div class="file-actions">
        <button class="diff-toggle change-button" type="button" aria-pressed="false" title="Compare with Git HEAD" disabled>
          <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1.75" y="3" width="14.5" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M9 3v12m-5.5-6H7m4 0h3.5m-1.75-1.75v3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          <span>Diff</span><span class="file-diff-baseline" hidden></span>
        </button>
        <details class="symbol-outline" hidden><summary title="Document symbols">Symbols</summary><div class="symbol-list"></div></details>
        <button class="file-next-change change-button" type="button" title="Next change" aria-label="Next change in file" disabled>${icons.down}</button>
        <button class="billy-review-trigger change-button" type="button" aria-expanded="false" hidden>Billy</button>
        <button class="file-action-toggle change-button" type="button" aria-label="File actions" title="File actions">${icons.more}</button>
        <div class="file-action-popover" role="group" aria-label="File actions" popover></div>
      </div>
    </div>
    <div class="billy-context-slot"></div>
    <div class="file-note" hidden></div>
    <div class="file-errors"></div>
    <div class="comparison-labels" hidden>
      <div class="comparison-original"><span class="comparison-version is-original">HEAD</span></div>
      <div class="comparison-working"><span class="comparison-version is-working">Working file</span></div>
    </div>
    <div class="editor-host"><div class="editor-placeholder" aria-hidden="true"><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span><span class="placeholder-line"></span></div></div>
    <div class="file-footer">
      <span class="line-count">Loading file…</span>
      <span class="howmany-counts" hidden></span>
      <span class="howmany-warnings" role="status" hidden></span>
      <span class="language-meta"><span class="language-state">Syntax</span><span class="file-language"></span></span>
    </div>`
  const reviewFocus = createReviewFocus({
    onActionsChange: () => card.syncEditorMenu?.(),
    onScope: scope => {
      if (card.reviewComparison) reviewScope = scope
      else card.fileDiffScope = scope
      element.dataset.reviewScope = scope
    },
  })
  const actionToggle = requireElement(element, '.file-action-toggle', HTMLButtonElement)
  const actions = requireElement(element, '.file-action-popover', HTMLElement)
  const editActivity = createEditActivity()
  requireElement(element, '.file-actions', HTMLDivElement).prepend(editActivity.element)
  actionToggle.before(reviewFocus.bar)
  requireElement(element, '.comparison-labels', HTMLElement).before(reviewFocus.changeMap)
  actionToggle.popoverTargetElement = actions
  const reviewNotice = documentNode('div', 'file-note', '')
  reviewNotice.hidden = true
  reviewNotice.setAttribute('role', 'status')
  requireElement(element, '.file-note', HTMLElement).after(reviewNotice)
  /** @type {Card} */
  const card = {
    file,
    openedAt,
    element,
    reviewFocus,
    editActivity,
    reviewNotice,
    host: requireElement(element, '.editor-host', HTMLElement),
    note: requireElement(element, '.file-note', HTMLElement),
    errors: requireElement(element, '.file-errors', HTMLElement),
    nextChange: requireElement(element, '.file-next-change', HTMLButtonElement),
    lines: requireElement(element, '.line-count', HTMLElement),
    language: requireElement(element, '.file-language', HTMLElement),
    languageCleanup: null,
    languageState: null,
    editor: null,
    model: null,
    decorationCollection: null,
    viewState: null,
    dirty: true,
    active: false,
    loading: false,
    generation: 0,
    changes: [],
    changeIndex: -1,
    comparing: false,
    comparison: 'head',
    textBytes: 0,
  }
  const slash = file.path.lastIndexOf('/')
  requireElement(element, '.file-directory', HTMLElement).textContent = file.path.slice(0, slash + 1)
  requireElement(element, '.file-name', HTMLElement).textContent = file.path.slice(slash + 1)
  requireElement(element, '.file-path', HTMLElement).title = file.path
  actions.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') populateFileActions(card, actions, actionToggle)
  })
  card.nextChange.addEventListener('click', () => {
    if (!card.editor || card.changes.length === 0) return
    card.changeIndex = (card.changeIndex + 1) % card.changes.length
    const line = card.changes[card.changeIndex]
    if (line === undefined) return
    card.editor.revealLineInCenter(
      line,
      reducedMotion.matches ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth,
    )
  })
  requireElement(element, '.diff-toggle', HTMLButtonElement).addEventListener('click', () =>
    runTask('Switch file comparison', () => toggleDiff(card)),
  )
  if (isMarkdown(file.path)) {
    const modes = documentNode('div', 'markdown-toggle', '')
    modes.setAttribute('role', 'group')
    modes.setAttribute('aria-label', 'Markdown view')
    /** @type {[string, boolean][]} */
    const markdownModes = [
      ['Preview', false],
      ['Source', true],
    ]
    for (const [label, source] of markdownModes) {
      const button = documentNode('button', '', label)
      button.type = 'button'
      button.disabled = true
      button.setAttribute('aria-pressed', String(!source))
      button.addEventListener('click', () => {
        runTask('Switch Markdown view', () =>
          changeDocumentMode(card, () => {
            if (Boolean(card.markdownSource) === source) return false
            card.markdownSource = source
            card.pendingMatch = null
            card.pendingReviewAnchor = null
            if (!source) {
              card.comparing = false
              card.reviewComparison = false
              setDocumentComparison(card, 'head')
            }
            return true
          }),
        )
      })
      modes.append(button)
    }
    requireElement(element, '.diff-toggle', HTMLButtonElement).before(modes)
  }
  requireElement(element, '.symbol-outline', HTMLDetailsElement).addEventListener('toggle', event => {
    if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open)
      runTask('Load file outline', () => showSymbols(card))
  })
  const fileIcon = document.createElement('img')
  const icon = projectIcon({ kind: 'file', name: file.path.slice(slash + 1) })
  if (icon) fileIcon.src = icon
  fileIcon.alt = ''
  requireElement(element, '.file-icon', HTMLElement).replaceChildren(fileIcon)
  return card
}

/** @param {Card} card @param {HTMLElement} popover @param {HTMLButtonElement} trigger */
function populateFileActions(card, popover, trigger) {
  popover.replaceChildren()

  /** @param {string} label */
  function group(label) {
    const section = documentNode('div', 'file-action-group', '')
    section.setAttribute('role', 'group')
    section.setAttribute('aria-label', label)
    const heading = documentNode('div', 'file-action-heading', label)
    heading.setAttribute('aria-hidden', 'true')
    section.append(heading)
    popover.append(section)
    /** @param {string} name @param {() => unknown} run @param {ShortcutAction} [shortcut] */
    return (name, run, shortcut) => {
      const button = documentNode('button', 'file-action-item', name)
      button.type = 'button'
      if (shortcut) {
        const keys = documentNode('span', 'file-action-shortcut', shortcutLabel(shortcut))
        keys.setAttribute('aria-hidden', 'true')
        button.append(keys)
        const aria = ariaBinding(shortcutBinding(shortcut), isMac)
        if (aria) button.setAttribute('aria-keyshortcuts', aria)
      }
      button.addEventListener('click', () => {
        popover.hidePopover()
        if (card.active && !closingRequested && !closed) runTask(name, run, { silent: shortcut === 'save' })
      })
      section.append(button)
    }
  }

  const comparisonAction = canToggleDiff(card) ? fileComparisonActionLabel(card) : null
  const outline = requireElement(card.element, '.symbol-outline', HTMLDetailsElement)
  const markdown = card.element.querySelector('.markdown-toggle:not([hidden]) button[aria-pressed="false"]:enabled')
  if (card.comparing && comparisonAction) {
    const add = group('Comparison')
    add(comparisonAction, () => toggleDiff(card))
    if (card.diffEditor) {
      const { scope, canNavigate, canReplay, hasChanges } = card.reviewFocus.actions
      if (canNavigate) {
        add('Previous change', () => card.reviewFocus.step(-1))
        add('Next change', () => card.reviewFocus.step(1))
      }
      if (hasChanges) {
        add(scope === 'focus' ? 'Show unchanged lines' : 'Hide unchanged lines', () => card.reviewFocus.toggleScope())
      }
      if (canReplay) {
        add('Replay change', () => card.reviewFocus.replay(() => trigger.focus({ preventScroll: true })))
      }
    }
  }

  if (card.editor) {
    const add = group('Editor')
    const readOnly = editorReadOnly(card)
    if (card.autosave && (!readOnly || card.autosave.pending)) {
      add('Save file', () => card.autosave?.flush(), 'save')
    }
    add('Find in file', () => findInCard(card)?.(), 'find')
    /** @param {string} id */
    const runAction = id => {
      const editor = focusedCardEditor(card)
      editor?.focus()
      return editor?.getAction(id)?.run()
    }
    if (!card.comparing && !readOnly) add('Replace in file', () => runAction('editor.action.startFindReplaceAction'))
    add('Go to line…', () => runAction('editor.action.gotoLine'))
    if (!outline.hidden) {
      add('Show document symbols', () => showDocumentSymbols(card))
    }
    if (!card.nextChange.hidden && !card.nextChange.disabled) add('Next change in file', () => card.nextChange.click())
  }

  if (markdown instanceof HTMLButtonElement || (!card.comparing && comparisonAction)) {
    const add = group('View')
    if (markdown instanceof HTMLButtonElement) {
      const label = markdown.textContent === 'Source' ? 'Show Markdown source' : 'Show Markdown preview'
      add(label, () => markdown.click())
    }
    if (!card.comparing && comparisonAction) add(comparisonAction, () => toggleDiff(card))
  }

  const file = group('File')
  file('Reveal in File Explorer', () => revealFileInExplorer(card.file.path), 'revealActiveFile')
  if (!card.document?.workingMissing) {
    file('Copy relative path', () => api.fileAction('copy-relative-path', card.file.path))
  }

  const canCompareSiblings = billyAvailable && billyContext && !mediaType(card.file.path) && !card.file.submodule
  if (reviewNotes || ideas || assistant || canCompareSiblings) {
    const add = group('Workspace')
    if (reviewNotes) {
      add('Add file review note', () => reviewNotes.openComposer(captureReviewAnchor(card, 'working', false)))
    }
    if (ideas) add('Link to an idea', () => attachIdeaLink(captureIdeaLink(card)))
    if (assistant) add('Ask The Creature about this file', () => assistant.toggle(true))
    if (canCompareSiblings) {
      add('Compare sibling functions', () => {
        if (billyAvailable) billyContext.open('siblings')
      })
    }
  }
}

/** @param {WorkspaceSnapshot | null} next */
function applySnapshot(next) {
  rendererDiagnostics.run('renderer.snapshot-apply', () => renderSnapshot(next))
}

/** @param {WorkspaceSnapshot | null} next */
function renderSnapshot(next) {
  if (closed) return
  if (!next) {
    if (!snapshot) showStartScreen()
    return
  }
  if (snapshot && Number.isFinite(next.revision) && next.revision < snapshot.revision) return
  if (snapshot && next.revision === snapshot.revision && next.inventoryRevision < snapshot.inventoryRevision) return
  const first = !snapshot
  const rootChanged = next.root !== snapshot?.root
  const allDirty = !next.changedPaths || next.changedPaths.includes('*') || rootChanged
  const watchChanged = next.watchError !== snapshot?.watchError
  const searchChanged = next.revision !== snapshot?.revision || next.inventoryRevision !== snapshot?.inventoryRevision
  snapshot = next
  if (rootChanged) {
    closeGitWorkspace()
    gitWorkspace.reset()
  } else if (searchChanged || next.changedPaths.length) refreshGitWorkspace()
  ui.startError.replaceChildren()
  if (!workspaceFailure) clearErrorNotice('workspace')
  if (searchChanged) contentSearch?.refresh()
  assistant?.setContext(true, next.root)
  ui.startScreen.setAttribute('aria-busy', 'false')
  ui.startScreen.hidden = true
  ui.feedScroll.hidden = false
  if (rootChanged && api.billy) {
    settings?.setBillyWorkspace(null)
    runTask(
      'Identify Billy workspace',
      async () => {
        const available = await api.billy.available()
        if (closed || snapshot?.root !== next.root) return
        settings?.setBillyWorkspace(available ? next.root : null)
        billyAvailable = available
        review.laneHost.hidden = !available
        billyContext?.setAvailable(available)
        refreshBillyLanes()
      },
      { silent: true },
    )
  }
  if (first) {
    setSidebarVisible(true)
    ui.gitToggle.hidden = false
    requireElement(document, '.statusbar-end', HTMLElement).hidden = false
    ui.contentSearchToggle.hidden = !contentSearch
    ui.terminalToggle.hidden = !api.terminal
    ui.reviewToggle.hidden = false
    reviewNotes?.setContext(true)
    if (ideas) {
      ui.ideasToggle.hidden = false
      syncIdeasVisibility(uiPreferences.get('ideasVisible'))
      runTask('Load ideas', () => ideas.load())
    }
  }
  navigator.update(next)
  updateReviewBaseline(undefined, next.changedPaths.includes('contracts/operate/codegen/generators.toml'))
  ui.projectName.textContent =
    next.scope.split('/').findLast(segment => segment !== '') ??
    next.root.split('/').findLast(segment => segment !== '') ??
    'Working tree'
  ui.projectPath.textContent = next.scope
  ui.projectPath.title = next.scope
  ui.projectName.title = next.scope
  ui.branchName.textContent = next.branch || 'HEAD'
  ui.gitToggle.title = `Inspect Git history and changes · ${next.branch || 'Detached HEAD'}`
  ui.gitToggle.setAttribute('aria-description', next.branch || 'Detached HEAD')
  document.title = `${ui.projectName.textContent} · diffpane`
  if (next.watchError && watchChanged) {
    reportError(next.watchError, {
      key: 'watcher',
      code: 'WATCHER_FALLBACK',
      operation: 'Watch workspace files',
      diagnostic: 'renderer.workspace-watch-fallback',
      title: 'Live updates are using polling',
    })
  } else if (!next.watchError) clearErrorNotice('watcher')
  if (first) {
    const path = next.initialPath?.length ? next.initialPath : next.files[0]?.path
    if (path) {
      const open = async () => {
        const result = await attemptAsync(() =>
          openFile(
            { path, submodule: false },
            {
              anchor: workingFileAnchor(path, next.initialLine),
              focusEditor: next.initialLine !== undefined,
            },
          ),
        )
        if (!result.ok || !result.value) finishWorkspaceOpening()
        if (!result.ok) throw result.error
      }
      runTask('Open initial file', open, { retry: open })
    } else initialDocumentReady = true
  } else {
    const card = openedFile ? cards.get(openedFile.path) : undefined
    const file = card && reviewFiles(card.comparison).find(entry => entry.path === card.file.path)
    if (
      card &&
      (allDirty ||
        file?.reviewVersion !== card.file.reviewVersion ||
        next.changedPaths.some(path => card.file.path === path || card.file.path.startsWith(`${path}/`)))
    ) {
      card.file = file ?? { path: card.file.path }
      card.dirty = true
      scheduleDocument()
    }
  }
  syncReviewState()
  ui.statusText.textContent = `${next.files.length.toLocaleString()} changed ${next.files.length === 1 ? 'file' : 'files'} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
  revealWorkspaceWhenReady()
}

/** @param {Card} card */
async function loadDocument(card, retry = false) {
  if (!card.active || closed) return
  if (card.loading || card.autosave?.pending) {
    if (retry) throw new Error('Wait for the current file operation to finish, then try again.')
    return
  }
  card.loading = true
  card.dirty = false
  const startedAt = performance.now()
  const generation = card.generation
  const comparison = card.comparison
  const editVersion = card.editVersion ?? 0
  try {
    syncReviewState()
    card.element.classList.add('is-loading')
    const [document, media] = await Promise.all([
      api.document(card.file.path, comparison),
      mediaType(card.file.path) && card.file.worktree !== 'D' ? attemptAsync(() => api.media(card.file.path)) : null,
    ])
    if (!card.active || generation !== card.generation || !cards.has(card.file.path)) {
      rendererDiagnostics.measure('renderer.document-load-discarded', startedAt)
      return
    }
    if (card.autosave?.pending || editVersion !== (card.editVersion ?? 0)) {
      card.dirty = true
      rendererDiagnostics.measure('renderer.document-load-discarded', startedAt)
      return
    }
    // Paint completed reads during edit storms, then reconcile any newer invalidation.
    if (media && !media.ok) reportError(media.error, { operation: 'Load media stream', silent: true })
    card.currentMedia = media?.ok ? media.value : null
    const wipeState =
      card.comparing && card.renderedComparison === comparison ? card.mediaPreview?.wipeState() : undefined
    if (card.renderedComparison !== comparison) {
      card.renderedComparison = comparison
      card.noteSide = card.ideaSide = 'working'
    }
    card.decorationEditVersion = editVersion
    const rendered = renderDocument(card, document, wipeState)
    if (rendered) await rendered
    if (!card.active || generation !== card.generation) return
    clearDocumentFailure(card)
    if (card.focusOnLoad) {
      card.focusOnLoad = false
      if (globalThis.document.activeElement === ui.workbench) card.editor?.focus()
    }
    initialDocumentReady = true
    rendererDiagnostics.measure('renderer.document-load', startedAt)
    if (!firstDocumentRendered) {
      firstDocumentRendered = true
      rendererDiagnostics.measure('renderer.document-first-render', card.openedAt)
    }
  } catch (cause) {
    rendererDiagnostics.measure('renderer.document-load', startedAt, { ok: false, error: cause })
    if (card.active && generation === card.generation) {
      if (retry && card.errorBoundary?.isConnected) throw appError(cause, { operation: 'Load file' })
      finishWorkspaceOpening()
      showDocumentFailure(card, cause)
    }
  } finally {
    card.loading = false
    card.element.classList.remove('is-loading')
    if (card.active) syncReviewState()
    scheduleDocument()
    revealWorkspaceWhenReady()
    runTask('Start background analysis', startBackgroundAnalysis, { silent: true })
  }
}

/** @param {Card} card */
function clearDocumentFailure(card) {
  const shouldRestoreFocus =
    card.errorBoundary?.contains(document.activeElement) === true || card.restoreErrorFocus === true
  card.restoreErrorFocus = false
  card.documentFailed = false
  card.errorBoundary?.remove()
  card.errorBoundary = null
  card.host.classList.remove('has-error')
  if (shouldRestoreFocus) {
    if (card.editor) card.editor.focus()
    else requireElement(card.element, '.diff-toggle', HTMLButtonElement).focus()
  }
}

/** @param {Card} card @param {unknown} cause */
function showDocumentFailure(card, cause) {
  card.documentFailed = true
  const hasView = Boolean(card.editor ?? card.mediaPreview ?? card.markdownPreview)
  const error = reportError(cause, { operation: 'Load file', silent: true })
  if (!hasView) {
    if (!card.errorBoundary?.isConnected) card.host.replaceChildren()
    card.lines.textContent = 'File unavailable'
    card.host.classList.add('has-error')
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
    if (outline) outline.textContent = 'Symbols unavailable'
  }
  const host = hasView ? card.errors : card.host
  if (card.errorBoundary?.parentElement !== host) card.errorBoundary?.remove()
  card.errorBoundary = renderFailure(host, error, {
    scope: hasView ? 'notice' : 'panel',
    title: hasView ? 'Couldn’t update this file' : 'Couldn’t open this file',
    retry: () => loadDocument(card, true),
  })
  if (card.pendingReviewAnchor) {
    if (card.anchorFromIdea) ideas?.notify('The linked file could not be opened.')
    else reviewNotes?.notify('The saved note’s file could not be opened.')
  }
}

/** @param {Card} card @returns {monaco.editor.IStandaloneEditorConstructionOptions} */
function editorOptions(card) {
  const readOnly = editorReadOnly(card)
  return {
    ...codeAppearance(appearance.value),
    readOnly,
    domReadOnly: readOnly,
    lineNumbersMinChars: 4,
    glyphMargin: false,
    lineDecorationsWidth: 10,
    minimap: { enabled: false },
    overviewRulerLanes: 3,
    overviewRulerBorder: false,
    scrollBeyondLastLine: false,
    smoothScrolling: !reducedMotion.matches,
    scrollbar: {
      verticalScrollbarSize: 9,
      horizontalScrollbarSize: 9,
      alwaysConsumeMouseWheel: false,
      useShadows: false,
    },
    renderLineHighlight: 'none',
    renderWhitespace: 'selection',
    renderValidationDecorations: 'on',
    folding: true,
    stickyScroll: { enabled: false },
    guides: { indentation: true, bracketPairs: false },
    bracketPairColorization: { enabled: false },
    matchBrackets: 'never',
    links: false,
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    contextmenu: true,
    automaticLayout: true,
    padding: { top: 14, bottom: 14 },
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: languageWidgets,
    mouseWheelScrollSensitivity: 1,
    fastScrollSensitivity: 3,
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    accessibilitySupport: 'auto',
    ariaLabel: `Current contents of ${card.file.path}`,
  }
}

/**
 * @param {Card} card
 * @param {WorkspaceDocument} document
 * @param {import('../../editor/documents/image-diff/image-wipe.ts').ImageWipeState} [wipeState]
 * @returns {void | Promise<void>}
 */
function renderDocument(card, document, wipeState) {
  card.restoreErrorFocus = Boolean(card.errorBoundary?.contains(globalThis.document.activeElement))
  card.document = document
  const baseline = comparisonLabel(card)
  const preview = document.preview
  card.element.toggleAttribute(
    'data-changed',
    document.decorations.length > 0 ||
      document.beforeDecorations.length > 0 ||
      Boolean(card.file.index?.trim()) ||
      Boolean(card.file.worktree?.trim()),
  )
  const reading = !preview && isMarkdown(card.file.path) && !card.markdownSource
  const text = document.after
  const previousMarkdown = reading && text === card.markdownText ? card.markdownPreview : null
  card.note.textContent = preview
    ? ''
    : document.note?.length
      ? document.note
      : document.diffNote?.length
        ? document.diffNote
        : !text && (document.workingMissing || card.file.worktree === 'D' || card.file.index === 'D')
          ? 'This file was deleted. There are no current contents.'
          : ''
  card.note.hidden = !card.note.textContent
  card.documentWork?.abort()
  if (previousMarkdown) {
    if (card.markdownAnchor) {
      previousMarkdown.scrollToAnchor(card.markdownAnchor)
      card.markdownAnchor = null
    }
    revealReviewAnchor(card)
    return undefined
  }
  const { signal } = (card.documentWork = new AbortController())
  card.mediaPreview?.dispose()
  card.mediaPreview = null
  if (!reading) {
    card.markdownPreview?.dispose()
    card.markdownPreview = null
  }
  const modes = card.element.querySelector('.markdown-toggle')
  if (modes instanceof HTMLElement) {
    modes.hidden = Boolean(preview)
    for (const button of modes.querySelectorAll('button')) {
      button.disabled = false
      button.setAttribute('aria-pressed', String((button.textContent === 'Preview') === reading))
    }
  }
  for (const control of card.element.querySelectorAll('.symbol-outline, .language-state')) {
    if (control instanceof HTMLElement) control.hidden = Boolean(preview) || reading
  }
  card.nextChange.hidden = Boolean(preview) || reading || card.comparing
  const button = requireElement(card.element, '.diff-toggle', HTMLButtonElement)
  button.disabled = false
  button.hidden = false
  button.setAttribute('aria-pressed', String(card.comparing))
  const baselineText = baseline === 'HEAD' ? 'Git HEAD' : baseline
  button.title = card.comparing ? 'Show working file' : 'Compare with Git HEAD'
  button.setAttribute('aria-label', card.comparing ? `Diff against ${baselineText}, show working file` : 'Diff')
  const baselineBadge = requireElement(button, '.file-diff-baseline', HTMLElement)
  baselineBadge.hidden = !card.comparing
  baselineBadge.textContent = baselineText
  card.element.dataset.diff = String(card.comparing)
  card.element.dataset.view = preview ? 'document' : reading ? 'markdown' : 'source'
  const { bar, changeMap } = card.reviewFocus
  const inReview = Boolean(card.reviewComparison)
  card.element.toggleAttribute('data-review-comparison', inReview)
  if (inReview !== (bar.parentElement === card.element)) {
    const anchor = inReview ? changeMap : requireElement(card.element, '.file-action-toggle', HTMLButtonElement)
    anchor.before(bar)
  }
  const labels = requireElement(card.element, '.comparison-labels', HTMLElement)
  labels.hidden = !card.comparing || Boolean(preview)
  for (const label of labels.querySelectorAll('.is-original')) label.textContent = baseline
  card.reviewFocus.setBaseline(baseline)
  if (preview) {
    const match = card.dirty ? undefined : (card.pendingMatch ?? undefined)
    if (match) {
      card.pendingMatch = null
      card.previewRaw = false
    }
    setSaveLabel('Read only')
    releaseEditor(card)
    howmany?.clearFile(card)
    const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
    if (outline) outline.textContent = 'No outline for this file'
    card.lines.textContent = `${preview.after.size.toLocaleString()} bytes`
    card.language.textContent = preview.after.kind === 'binary' ? 'Binary' : preview.after.kind.toUpperCase()
    card.mediaPreview = showDocumentPreview(
      card.host,
      preview,
      card.file.path,
      card.comparing,
      card.currentMedia ?? null,
      {
        baseline,
        raw: card.previewRaw,
        match,
        wipeState,
        onRawChange: raw => {
          card.previewRaw = raw
        },
      },
    )
    card.textBytes = Object.values(preview).reduce((sum, side) => {
      const data = 'data' in side ? (side.data?.length ?? 0) : 0
      const value = side.kind === 'text' ? side.value.length : 0
      return sum + (data + (side.hex?.length ?? 0) + value) * 2
    }, 0)
    revealReviewAnchor(card)
    return undefined
  }
  if (reading) {
    releaseEditor(card)
    howmany?.clearFile(card)
    setSaveLabel('Read only')
    card.language.textContent = 'Markdown'
    card.textBytes = text.length * 2
    return documentProcessor.run({ kind: 'markdown', source: text }, signal).then(result => {
      if (result?.kind !== 'markdown' || signal.aborted) return undefined
      const { markdown } = result
      const { words } = markdown
      card.markdownPreview?.dispose()
      card.markdownPreview = null
      card.lines.textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`
      card.markdownPreview = showMarkdownPreview(card.host, markdown, {
        filename: card.file.path,
        scrollTop: card.markdownScroll,
        diagramHeights: (card.markdownDiagramHeights ??= []),
        anchor: card.markdownAnchor ?? undefined,
        onScroll: top => {
          card.markdownScroll = top
        },
        media: api.media,
        openExternal: api.openExternal,
        onOpenFile: openFile,
        colorize: colorizeMarkdown,
      })
      card.markdownAnchor = null
      card.markdownText = text
      const outline = ui.navigator.querySelector('.navigator-outline .symbol-list')
      if (outline) showMarkdownOutline(card, outline)
      revealReviewAnchor(card)
      return undefined
    })
  }
  if (!card.model) {
    if (!snapshot) throw new Error('The workspace closed before its file could be rendered.')
    const root = snapshot.root.replaceAll('\\', '/').replace(/\/$/, '')
    const uri = monaco.Uri.file(`${root}/${card.file.path}`)
    const model = monaco.editor.createModel(text, undefined, uri)
    try {
      monaco.editor.setModelLanguage(model, syntax.resolve(model, text))
      model.detectIndentation(true, 2)
    } catch (cause) {
      model.dispose()
      throw cause
    }
    card.model = model
    const autosave = new Autosave(
      text,
      (value, expected) => api.save(card.file.path, value, expected),
      (state, error) => {
        if (!card.active) return
        card.saveStatus = state
        card.saveError = state === 'error' ? appError(error) : null
        updateSaveLabel(card)
        if (state === 'error') {
          reportError(card.saveError, {
            key: 'save',
            operation: 'Save file',
            title: 'Couldn’t save your changes',
            retry: () => card.autosave?.flush(),
            retryLabel: 'Retry save',
            copy: async () => {
              if (card.active && card.model)
                await globalThis.navigator.clipboard.writeText(card.model.getValue(undefined, true))
            },
          })
        }
        if (state === 'saved') {
          clearErrorNotice('save')
          card.dirty = true
          scheduleDocument()
        }
        syncSaveState()
      },
    )
    card.autosave = autosave
    const readBuffer = () => {
      const value = model.getValue(undefined, true)
      card.text = value
      if (card.document) card.document = { ...card.document, after: value }
      return value
    }
    card.contentCleanup = model.onDidChangeContent(() => {
      const displayed = card.document
      if (card.applyingDocument || !displayed?.editable || card.model !== model) return
      card.editVersion = (card.editVersion ?? 0) + 1
      autosave.edit(readBuffer)
      syncSaveState()
    })
  } else if (card.editor && card.text !== text) {
    const viewState = card.editor.saveViewState()
    applyDiskText(card, text)
    if (viewState) card.editor.restoreViewState(viewState)
  }
  if (!card.editor || Boolean(card.diffEditor) !== card.comparing)
    setCardEditor(card, card.editor?.saveViewState() ?? card.viewState)
  const { editor, diffEditor, decorationCollection, model, autosave } = card
  if (!editor || !model || !decorationCollection || !autosave)
    throw new Error('The editor could not be prepared for this file.')
  if (diffEditor) updateComparisonAriaLabels(card)
  card.text = text
  autosave.accept(text)
  syncLanguageAttachment(card)
  applyEditorReadOnly(card)
  updateSaveLabel(card)
  card.textBytes = text.length * 2 + (card.originalModel ? document.before.length * 2 : 0)
  if (diffEditor && card.originalModel && card.originalText !== document.before) {
    const originalEditor = diffEditor.getOriginalEditor()
    const originalState = originalEditor.saveViewState()
    card.originalModel.setValue(document.before)
    card.originalText = document.before
    if (originalState) originalEditor.restoreViewState(originalState)
  }
  if (diffEditor && (!card.reviewComparison || (!card.dirty && card.file.reviewVersion === document.reviewVersion))) {
    const scope = card.reviewComparison ? reviewScope : (card.fileDiffScope ?? 'full')
    card.element.dataset.reviewScope = scope
    card.reviewFocus.attach(
      diffEditor,
      scope,
      comparisonAriaLabels(card),
      Boolean(card.reviewComparison && !card.pendingReviewAnchor),
    )
  } else delete card.element.dataset.reviewScope
  /** @type {monaco.editor.IModelDeltaDecoration[]} */
  const decorations = []
  /** @type {Set<number>} */
  const changeLines = new Set()
  const lineCount = model.getLineCount()
  const hasChangePeek = card.changePeek?.update(
    card.renderedComparison === 'head' && card.decorationEditVersion === (card.editVersion ?? 0) ? document : null,
  )
  for (const change of document.decorations) {
    const start = Math.max(1, Math.min(lineCount, change.startLine))
    const end = Math.max(start, Math.min(lineCount, change.endLine))
    changeLines.add(start)
    const deleted = change.kind === 'deleted'
    const kind = deleted ? 'deleted' : change.kind === 'modified' ? 'modified' : 'added'
    decorations.push({
      range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
      options: {
        isWholeLine: !deleted,
        linesDecorationsClassName: `diff-gutter-${kind}`,
        linesDecorationsTooltip: hasChangePeek
          ? null
          : `${kind === 'deleted' ? 'Lines deleted' : kind === 'modified' ? 'Lines modified' : 'Lines added'} compared with ${baseline}`,
        overviewRuler: {
          ...overviewRulerColors[kind],
          position: monaco.editor.OverviewRulerLane.Left,
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })
  }
  decorationCollection.set(decorations)
  card.changes = Array.from(changeLines).toSorted((a, b) => a - b)
  card.nextChange.disabled = card.changes.length === 0
  card.nextChange.hidden ||= card.nextChange.disabled
  card.syncEditorMenu?.()
  card.lines.textContent = `${document.lineCount.toLocaleString()} ${document.lineCount === 1 ? 'line' : 'lines'}`
  const language = model.getLanguageId()
  card.language.textContent =
    monaco.languages.getLanguages().find(value => value.id === language)?.aliases?.[0] ?? language
  if (diffEditor) diffEditor.layout()
  else editor.layout()
  editor.render(true)
  revealContentMatch(card)
  revealReviewAnchor(card)
  if (document.workingMissing) howmany?.clearFile(card)
  else howmany?.updateFile(card, document)
  if (diffEditor) runTask('Highlight changed functions', () => highlightFunctions(card, signal))
  else card.changedFunctions = 0
  if (requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open)
    runTask('Load file outline', () => showSymbols(card))
  const outline = ui.navigator.querySelector('.navigator-outline[open] .symbol-list')
  if (outline) runTask('Load file outline', () => showSymbols(card, outline))
  return undefined
}

/** @param {monaco.Selection} selection */
function selectionLines(selection) {
  const line = selection.startLineNumber
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > line ? selection.endLineNumber - 1 : selection.endLineNumber
  return { line, endLine }
}

/** @returns {import('../../../electron/tools/assistant/claude-session.mjs').FileReference | null} */
function assistantFileContext() {
  if (!openedFile) return null
  const path = openedFile.path
  const card = cards.get(path)
  if (!card) return { path, side: 'working' }
  /** @type {EditorSide} */
  const side = card.diffEditor && card.noteSide === 'head' && comparisonLabel(card) === 'HEAD' ? 'head' : 'working'
  const editor = side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const selection = editor?.getSelection()
  if (selection && !selection.isEmpty()) {
    const { line, endLine } = selectionLines(selection)
    return { path, side, startLine: line, endLine }
  }
  const visible = editor?.getVisibleRanges()[0]
  if (!visible) return { path, side }
  const startLine = visible.startLineNumber
  return { path, side, startLine, endLine: Math.min(visible.endLineNumber, startLine + 39) }
}

/** @param {Card} card @param {EditorSide} [side] */
function captureIdeaLink(card, side = card.ideaSide ?? 'working') {
  if (side === 'head' && comparisonLabel(card) === 'Checkpoint') side = 'working'
  const editor = side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = editor?.getModel()
  const path = card.file.path
  if (!editor || !model) return { path }
  const selection = editor.getSelection()
  let lines
  if (selection && !selection.isEmpty()) lines = selectionLines(selection)
  else {
    // In a focused diff, a viewport can contain several noncontiguous ranges.
    const [visible] = editor.getVisibleRanges()
    if (!visible) return { path, side }
    const line = visible.startLineNumber
    lines = { line, endLine: Math.min(visible.endLineNumber, line + 23) }
  }
  const { line, endLine } = lines
  return { path, side, ...lines, ...captureReviewLines(model, line, endLine) }
}

/** @param {Card} card @param {EditorSide} side */
function captureReviewAnchor(card, side, includeLines = true) {
  if (side === 'head' && comparisonLabel(card) === 'Checkpoint') side = 'working'
  const original = side === 'head'
  const editor = original ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = includeLines ? editor?.getModel() : null
  const selection = model ? editor?.getSelection() : null
  if (!snapshot) return null
  const root = snapshot.root.replace(/\/$/u, '')
  const scope = snapshot.scope ?? snapshot.root
  /** @param {string} path */
  const inScope = path => `${root}/${path}`.startsWith(`${scope.replace(/\/$/u, '')}/`)
  let pathname = card.file.path
  const originalPath = original ? card.file.originalPath : null
  if (!inScope(pathname)) {
    if (!originalPath || !inScope(originalPath)) return null
    pathname = originalPath
  }
  const anchor = {
    path: pathname,
    ...(originalPath && originalPath !== pathname ? { originalPath } : {}),
    side,
    line: null,
    endLine: null,
    excerpt: '',
    truncated: false,
  }
  if (!selection || !model) return anchor
  const { line, endLine } = selectionLines(selection)
  return { ...anchor, line, endLine, ...captureReviewLines(model, line, endLine) }
}

/** @param {Card} card */
function revealReviewAnchor(card) {
  const anchor = card.pendingReviewAnchor
  if (!anchor || !card.document || card.dirty) return
  card.pendingReviewAnchor = null
  if (anchor.line === null) return
  const editor = anchor.side === 'head' ? card.diffEditor?.getOriginalEditor() : card.editor
  const model = editor?.getModel()
  if (!editor || !model) {
    showReviewLocation(card, 'The saved lines are unavailable in the current file view.')
    return
  }
  if (anchor.direct) {
    card.noteSide = anchor.side ?? 'working'
    const start = Math.min(anchor.line, model.getLineCount())
    const end = Math.min(anchor.endLine ?? start, model.getLineCount())
    editor.setSelection(new monaco.Range(start, 1, end, model.getLineMaxColumn(end)))
    editor.revealLineInCenter(start, monaco.editor.ScrollType.Immediate)
    return
  }
  const location = locateReviewLines(model, {
    ...anchor,
    side: anchor.side ?? 'working',
    truncated: anchor.truncated ?? false,
  })
  if (!location) return
  if (location.state === 'stale') {
    editor.setPosition({ lineNumber: location.line, column: 1 })
    showReviewLocation(card, 'The captured lines changed. Showing the nearest saved line.')
  } else {
    const range = new monaco.Range(location.line, 1, location.endLine, model.getLineMaxColumn(location.endLine))
    editor.setSelection(range)
    if (location.state === 'moved') {
      const message = `The captured lines moved to line ${location.line.toLocaleString()}.`
      showReviewLocation(card, message)
    }
  }
  editor.revealLineInCenter(location.line, monaco.editor.ScrollType.Immediate)
}

/** @param {Card} card @param {string} message */
function showReviewLocation(card, message) {
  if (card.anchorFromIdea && !ui.ideasPanel.hidden) ideas?.notify(message)
  else if (card.anchorFromIdea || ui.reviewNotesPanel.hidden) {
    card.reviewNotice.hidden = false
    card.reviewNotice.textContent = message
  } else reviewNotes?.notify(message)
}

/** @param {Card} card */
function revealContentMatch(card) {
  const hit = card.pendingMatch
  if (!hit || !card.editor || !card.model || card.dirty) return
  card.pendingMatch = null
  const position = card.model.validatePosition({ lineNumber: hit.line, column: hit.column })
  const range = new monaco.Range(hit.line, hit.column, hit.line, hit.column + hit.length)
  // The file can change between finding a result and loading its editor.
  if (card.model.getValueInRange(range) === hit.match) card.editor.setSelection(range)
  else card.editor.setPosition(position)
  card.editor.revealPositionInCenter(position, monaco.editor.ScrollType.Immediate)
  if (!globalThis.document.querySelector('dialog[open]')) card.editor.focus()
}

/** @param {string} label @param {string} [state] */
function setSaveLabel(label, state = '') {
  const indicator = requireElement(app, '#save-state', HTMLElement)
  indicator.textContent = label
  indicator.dataset.state = state
}

/** @param {Card} card */
function updateSaveLabel(card) {
  /** @type {Record<string, string>} */
  const labels = {
    saving: 'Saving…',
    error: `Save failed · ${shortcutLabel('save')} to retry`,
    saved: 'Saved',
  }
  const state = card.saveStatus ?? ''
  const label = labels[state]
  if (label && (card.autosave?.pending || card.document?.editable)) setSaveLabel(label, state)
  else setSaveLabel(card.document?.editable ? 'Autosave on' : 'Read only')
}

/** @param {Card} card @param {string} text */
function applyDiskText(card, text) {
  const { model } = card
  if (!model) return
  const before = model.getValue()
  const modelHasBOM = model.getValueLength(undefined, true) > before.length
  const hasBOM = text.startsWith('\uFEFF')
  const after = hasBOM ? text.slice(1) : text
  const eol = /\r\n|\r|\n/.exec(after)?.[0]
  const reset = modelHasBOM !== hasBOM || (eol && eol !== model.getEOL())
  const highlight = globalThis.document.hidden ? null : card.liveEditHighlight
  // Keep offsets in the old model's line endings when it needs to rebuild its buffer.
  const updated = reset && highlight ? after.replace(/\r\n?|\n/g, model.getEOL()) : after
  const change = (!reset || highlight) && updated !== before ? minimalChange(before, updated) : null
  const start = change && model.getPositionAt(change.start)
  card.applyingDocument = true
  try {
    // Monaco stores the BOM separately and uses a single line ending for its buffer.
    // Rebuild the buffer when either changes so existing undo offsets cannot alter them.
    if (reset) model.setValue(text)
    else if (change && start) {
      const end = model.getPositionAt(change.end)
      model.applyEdits([{ range: monaco.Range.fromPositions(start, end), text: change.text }])
    }
  } finally {
    card.applyingDocument = false
  }
  if (highlight && change && start) {
    const { ranges, counts } = describeLiveEdit(before, updated, change, start.lineNumber)
    highlight.show(ranges, model.getLineCount())
    card.editActivity.record(counts)
  } else if (reset) card.liveEditHighlight?.clear()
}

/** @param {Card} card @param {() => boolean} change */
async function changeDocumentMode(card, change) {
  const intent = (card.modeVersion ?? 0) + 1
  card.modeVersion = intent
  if (closingRequested || !card.document) return
  try {
    if (card.autosave?.pending) await card.autosave.flush()
  } catch {
    return
  }
  if (!card.active || closingRequested || intent !== card.modeVersion || !change()) return
  if (!card.comparing || card.comparison === card.renderedComparison) renderCurrentDocument(card)
  syncReviewState()
}

/** @param {Card} card */
function renderCurrentDocument(card) {
  const document = card.document
  if (!document) return
  runTask('Render file', async () => {
    const result = await attemptAsync(() => renderDocument(card, document))
    if (!result.ok && card.active && card.document === document) showDocumentFailure(card, result.error)
  })
}

/** @param {Card} card */
function canToggleDiff(card) {
  return Boolean(card.document && !closingRequested)
}

/** @param {Card} card */
function fileComparisonActionLabel(card) {
  if (!card.comparing) return 'Compare with Git HEAD'
  return isCheckpointOnlyDeletion(card) ? 'Close comparison' : 'Show working file'
}

/** @param {Card} card */
function toggleDiff(card) {
  const comparing = !card.comparing
  if (!comparing && isCheckpointOnlyDeletion(card)) return closeCurrentFile()
  return changeDocumentMode(card, () => {
    card.pendingMatch = null
    card.pendingReviewAnchor = null
    card.comparing = comparing
    if (comparing) {
      card.markdownSource = true
      card.fileDiffScope ??= 'focus'
    } else {
      card.reviewComparison = false
      setDocumentComparison(card, 'head')
    }
    return true
  })
}

/** @param {Card} card @param {WorkspaceComparison} comparison */
function setDocumentComparison(card, comparison) {
  if (card.comparison === comparison) return false
  card.documentWork?.abort()
  card.comparison = comparison
  card.generation++
  card.dirty = true
  card.reviewFocus.detach()
  card.diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: false } })
  updateComparisonAriaLabels(card)
  const file = reviewFiles(comparison).find(entry => entry.path === card.file.path)
  card.file = file ?? { path: card.file.path }
  scheduleDocument()
  return true
}

/** @param {Card} card @param {WorkspaceComparison} comparison @param {WorkspaceFile} [file] @param {ChangePosition} [change] */
function openComparison(card, comparison, file, change) {
  card.modeVersion = (card.modeVersion ?? 0) + 1
  card.pendingMatch = null
  const reloading = setDocumentComparison(card, comparison)
  if (file) card.file = file
  const modeChanged = !card.reviewComparison || !card.comparing || reloading
  if (modeChanged) {
    card.reviewFocus.detach()
    card.diffEditor?.updateOptions({ hideUnchangedRegions: { enabled: false } })
    card.reviewComparison = true
    card.diffEditor?.updateOptions({
      ...diffAppearance(appearance.value, true),
      ...comparisonAriaLabels(card),
    })
    card.comparing = true
    card.markdownSource = true
  }
  if (change) card.reviewFocus.revealChange(change)
  if (modeChanged && card.document && !card.documentFailed && !reloading) renderCurrentDocument(card)
  if (card.documentFailed) {
    card.dirty = true
    scheduleDocument()
  }
  syncReviewState()
}

/** @param {Card} card */
function comparisonLabel(card) {
  return card.renderedComparison?.startsWith('checkpoint:') ? 'Checkpoint' : 'HEAD'
}

/** @param {Card} card */
function comparisonAriaLabels(card) {
  return {
    originalAriaLabel: `${comparisonLabel(card)} contents of ${card.file.originalPath ?? card.file.path}`,
    modifiedAriaLabel: `Working contents of ${card.file.path}`,
  }
}

/** @param {Card} card */
function updateComparisonAriaLabels(card) {
  const { diffEditor } = card
  if (!diffEditor) return
  const { originalAriaLabel, modifiedAriaLabel } = comparisonAriaLabels(card)
  diffEditor.getOriginalEditor().updateOptions({ ariaLabel: originalAriaLabel })
  diffEditor.getModifiedEditor().updateOptions({ ariaLabel: modifiedAriaLabel })
}

/** @param {Card} card */
function showDocumentSymbols(card) {
  const outline = requireElement(card.element, '.symbol-outline', HTMLDetailsElement)
  outline.open = true
  outline.querySelector('summary')?.focus()
}

/** @param {Card} card @param {CodeEditor} editor @param {EditorSide} side */
function bindEditorMenu(card, editor, side) {
  const comparing = Boolean(card.diffEditor)
  /** @param {string} name @returns {monaco.editor.IContextKey<boolean>} */
  function flag(name) {
    return editor.createContextKey(name, false)
  }
  const canAnchor = flag('diffpaneCanAnchor')
  let order = 0
  /** @param {string} group @param {string} id @param {string} label @param {() => unknown} run @param {string} [precondition] */
  function add(group, id, label, run, precondition) {
    card.contextActions?.push(
      editor.addAction({
        id: `diffpane-${id}`,
        label,
        contextMenuGroupId: group,
        contextMenuOrder: ++order,
        precondition,
        run: () => {
          if (!closingRequested && card.active) runTask(label, run)
        },
      }),
    )
  }
  /** @param {string} id */
  function runMonacoAction(id) {
    editor.focus()
    return editor.getAction(id)?.run()
  }

  if (reviewNotes)
    add(
      'z_workspace',
      'add-review-note',
      'Add review note',
      () => {
        reviewNotes.openComposer(captureReviewAnchor(card, side))
      },
      'diffpaneCanAnchor',
    )
  if (ideas)
    add(
      'z_workspace',
      'attach-idea',
      'Link code to an idea',
      () => {
        attachIdeaLink(captureIdeaLink(card, side))
      },
      'diffpaneCanAnchor',
    )
  if (assistant)
    add(
      'z_workspace',
      'ask-creature',
      'Ask The Creature about this code',
      () => {
        card.noteSide = side
        assistant.toggle(true)
      },
      'diffpaneCanAnchor',
    )

  if (comparing) {
    const hasChanges = flag('diffpaneHasHunks')
    const canNavigate = flag('diffpaneCanNavigateHunks')
    const canReplay = flag('diffpaneCanReplayHunk')
    const focusedChanges = flag('diffpaneFocusedChanges')
    const closesComparison = flag('diffpaneClosesComparison')
    const { reviewFocus } = card
    add('navigation', 'previous-change', 'Previous change', () => reviewFocus.step(-1), 'diffpaneCanNavigateHunks')
    add('navigation', 'next-change', 'Next change', () => reviewFocus.step(1), 'diffpaneCanNavigateHunks')
    add(
      'navigation',
      'replay-change',
      'Replay selected change',
      () => reviewFocus.replay(() => editor.focus()),
      'diffpaneCanReplayHunk',
    )
    add(
      '1_view',
      'show-unchanged',
      'Show unchanged lines',
      reviewFocus.toggleScope,
      'diffpaneHasHunks && diffpaneFocusedChanges',
    )
    add(
      '1_view',
      'hide-unchanged',
      'Hide unchanged lines',
      reviewFocus.toggleScope,
      'diffpaneHasHunks && !diffpaneFocusedChanges',
    )
    add('1_view', 'show-working', 'Show working file', () => toggleDiff(card), '!diffpaneClosesComparison')
    add('1_view', 'close-comparison', 'Close comparison', () => toggleDiff(card), 'diffpaneClosesComparison')
    add('1_view', 'find', 'Find in this pane', () => runMonacoAction('actions.find'))
    return () => {
      const actions = reviewFocus.actions
      hasChanges.set(actions.hasChanges)
      canNavigate.set(actions.canNavigate)
      canReplay.set(actions.canReplay)
      focusedChanges.set(actions.scope === 'focus')
      closesComparison.set(Boolean(isCheckpointOnlyDeletion(card)))
      canAnchor.set(side === 'head' ? comparisonLabel(card) === 'HEAD' : !card.document?.workingMissing)
    }
  }

  const hasSourceChanges = flag('diffpaneHasSourceChanges')
  add('navigation', 'find', 'Find in file', () => runMonacoAction('actions.find'))
  add(
    'navigation',
    'replace',
    'Replace in file',
    () => runMonacoAction('editor.action.startFindReplaceAction'),
    '!editorReadonly',
  )
  add('navigation', 'goto-line', 'Go to line…', () => runMonacoAction('editor.action.gotoLine'))
  add('navigation', 'show-symbols', 'Show document symbols', () => showDocumentSymbols(card))
  add('1_view', 'compare-head', 'Compare with Git HEAD', () => toggleDiff(card))
  add('1_view', 'next-change', 'Next change in file', () => card.nextChange.click(), 'diffpaneHasSourceChanges')
  return () => {
    canAnchor.set(!card.document?.workingMissing)
    hasSourceChanges.set(card.changes.length > 0)
  }
}

/** @param {Card} card @param {ViewState | null | undefined} state */
function setCardEditor(card, state) {
  const { model, document } = card
  if (!model || !document) throw new Error('File text must load before opening an editor.')
  for (const action of card.contextActions ?? []) action.dispose()
  card.contextActions = []
  card.changePeek = null
  card.syncEditorMenu = null
  card.languageCleanup?.()
  card.languageCleanup = null
  if (card.diffEditor) {
    card.reviewFocus.detach()
    // Dispose the view model before releasing either text model so pending diffs cancel.
    card.diffEditor.dispose()
    card.diffEditor = null
  } else if (card.editor) {
    card.editor.setModel(null)
    card.editor.dispose()
  }
  card.editor = null
  card.originalModel?.dispose()
  card.originalModel = null
  card.originalDecorations = null
  card.originalFunctionDecorations = null
  card.functionDecorations = null
  card.host.replaceChildren()
  if (card.comparing) {
    card.originalText = document.before
    card.originalModel = monaco.editor.createModel(
      card.originalText,
      model.getLanguageId(),
      model.uri.with({ query: 'diffpane-original' }),
    )
    card.diffEditor = monaco.editor.createDiffEditor(card.host, {
      ...editorOptions(card),
      ...diffAppearance(appearance.value, Boolean(card.reviewComparison)),
      ...comparisonAriaLabels(card),
      originalEditable: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      renderOverviewRuler: false,
      hideUnchangedRegions: { enabled: false },
      experimental: { showMoves: true },
      maxComputationTime: 150,
      maxFileSize: 2,
      enableSplitViewResizing: true,
    })
    card.diffEditor.setModel({ original: card.originalModel, modified: model })
    card.editor = card.diffEditor.getModifiedEditor()
    const originalEditor = card.diffEditor.getOriginalEditor()
    updateComparisonAriaLabels(card)
    const labels = requireElement(card.element, '.comparison-labels', HTMLElement)
    /** @param {{width: number}} layout */
    const syncLabelWidth = ({ width }) => labels.style.setProperty('--original-width', `${width}px`)
    syncLabelWidth(originalEditor.getLayoutInfo())
    originalEditor.onDidLayoutChange(syncLabelWidth)
    card.originalDecorations = originalEditor.createDecorationsCollection()
    card.originalFunctionDecorations = originalEditor.createDecorationsCollection()
    card.functionDecorations = card.editor.createDecorationsCollection()
  } else {
    card.editor = monaco.editor.create(card.host, { ...editorOptions(card), model })
    card.changePeek = createChangePeek(card.host, card.editor)
    card.contextActions.push(card.changePeek)
  }
  card.noteSide = 'working'
  card.ideaSide = 'working'
  const original = card.diffEditor?.getOriginalEditor()
  const syncWorkingMenu = bindEditorMenu(card, card.editor, 'working')
  const syncOriginalMenu = original && bindEditorMenu(card, original, 'head')
  card.syncEditorMenu = () => {
    syncWorkingMenu()
    syncOriginalMenu?.()
  }
  if (reviewNotes || ideas || assistant) {
    const contextActions = card.contextActions
    let contextFrame = 0
    const refreshAssistantContext = () => {
      if (ui.claudePanel.hidden || contextFrame) return
      contextFrame = requestAnimationFrame(() => {
        contextFrame = 0
        assistant?.refreshContext()
      })
    }
    contextActions.push({ dispose: () => cancelAnimationFrame(contextFrame) })
    /** @param {CodeEditor} editor @param {EditorSide} side */
    const bindContext = (editor, side) => {
      contextActions.push(
        editor.onDidFocusEditorText(() => {
          card.noteSide = side
          card.ideaSide = side
          refreshAssistantContext()
        }),
        editor.onDidChangeCursorSelection(refreshAssistantContext),
        editor.onDidScrollChange(refreshAssistantContext),
      )
      if (ideas) {
        const surface = editor.getDomNode()
        const selectSide = () => {
          card.ideaSide = side
        }
        surface?.addEventListener('wheel', selectSide, { passive: true })
        contextActions.push(
          { dispose: () => surface?.removeEventListener('wheel', selectSide) },
          editor.onMouseDown(selectSide),
        )
      }
    }
    bindContext(card.editor, 'working')
    if (original) bindContext(original, 'head')
    refreshAssistantContext()
  }
  card.decorationCollection = card.editor.createDecorationsCollection()
  card.liveEditHighlight = createLiveEditHighlight(card.editor)
  card.contextActions.push(card.liveEditHighlight)
  if (state) card.editor.restoreViewState(state)
}

/** @param {Card} card */
function syncLanguageAttachment(card) {
  const { document, editor, model } = card
  if (!document || !editor || !model) return
  if (document.workingMissing) {
    card.languageCleanup?.()
    card.languageCleanup = null
  } else card.languageCleanup ??= languageFeatures.attach(editor, model, card.file.path, { active: true })
}

/** @param {FunctionRange[]} functions @param {'before' | 'after'} kind */
function functionDecorations(functions, kind) {
  return functions.map(fn => ({
    range: new monaco.Range(fn.startLine, 1, fn.endLine, 1),
    options: {
      isWholeLine: true,
      className: `diff-function-${kind}`,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }))
}

/** @param {Card} card @param {AbortSignal} signal */
async function highlightFunctions(card, signal) {
  const { document, functionDecorations: modifiedDecorations, originalDecorations, originalFunctionDecorations } = card
  if (!document || !modifiedDecorations || !originalDecorations || !originalFunctionDecorations) return
  const { decorations, beforeDecorations } = document
  const markers = beforeDecorations.map(change => ({
    range: new monaco.Range(change.startLine, 1, change.endLine ?? change.startLine, 1),
    options: {
      linesDecorationsClassName: `diff-gutter-${change.kind}`,
      overviewRuler: { ...overviewRulerColors[change.kind], position: monaco.editor.OverviewRulerLane.Left },
    },
  }))
  originalDecorations.set(markers)
  if (!beforeDecorations.length) originalFunctionDecorations.clear()
  if (!decorations.length) {
    modifiedDecorations.clear()
    card.changedFunctions = 0
  }
  if (!decorations.length && !beforeDecorations.length) return
  const symbols = decorations.length ? attemptAsync(() => languageFeatures.symbols(card.file.path)) : null
  const ranges = await documentProcessor.run(
    {
      kind: 'functions',
      before: beforeDecorations.length ? document.before : '',
      after: decorations.length ? document.after : '',
      original: beforeDecorations,
      modified: decorations,
    },
    signal,
  )
  if (ranges?.kind !== 'functions' || signal.aborted) return
  originalFunctionDecorations.set(functionDecorations(ranges.before, 'before'))
  modifiedDecorations.set(functionDecorations(ranges.after, 'after'))
  card.changedFunctions = ranges.after.length
  const outline = await symbols
  if (outline?.ok && outline.value.length && !signal.aborted) {
    const modified = changedSymbolRanges(decorations, outline.value)
    if (modified) {
      modifiedDecorations.set(functionDecorations(modified, 'after'))
      card.changedFunctions = modified.length
    }
  }
}

// A single replacement keeps Monaco's existing model, token state, and selection markers.
/** @param {string} before @param {string} after */
export function minimalChange(before, after) {
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++
  if (start > 0 && isLowSurrogate(before.charCodeAt(start))) start--
  let end = before.length
  let afterEnd = after.length
  while (end > start && afterEnd > start && before.charCodeAt(end - 1) === after.charCodeAt(afterEnd - 1)) {
    end--
    afterEnd--
  }
  if (end < before.length && isLowSurrogate(before.charCodeAt(end))) {
    end++
    afterEnd++
  }
  return { start, end, text: after.slice(start, afterEnd) }
}

/** @param {number} code */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} className @param {string} text */
function documentNode(tag, className, text) {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

/** @param {Card} card */
function deactivate(card) {
  howmany?.clearFile(card)
  const actions = card.element.querySelector('.file-action-popover:popover-open')
  if (actions instanceof HTMLElement) actions.hidePopover()
  card.active = false
  card.documentWork?.abort()
  card.generation++
  card.dirty = true
  card.mediaPreview?.dispose()
  card.mediaPreview = null
  card.markdownPreview?.dispose()
  card.markdownPreview = null
  releaseEditor(card)
  card.document = null
  card.currentMedia = null
  card.textBytes = 0
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''))
}

/** @param {Card} card */
function releaseEditor(card) {
  if (!card.model && !card.editor && !card.diffEditor) return
  for (const action of card.contextActions ?? []) action.dispose()
  card.contextActions = []
  card.changePeek = null
  card.syncEditorMenu = null
  card.noteSide = 'working'
  card.ideaSide = 'working'
  card.contentCleanup?.dispose()
  card.contentCleanup = null
  card.autosave = null
  if (card.editor) card.viewState = card.editor.saveViewState()
  card.languageCleanup?.()
  card.languageCleanup = null
  requireElement(card.element, '.symbol-outline', HTMLDetailsElement).open = false
  card.reviewFocus.detach()
  delete card.element.dataset.reviewScope
  if (card.diffEditor) card.diffEditor.dispose()
  else card.editor?.dispose()
  card.originalModel?.dispose()
  card.originalModel = null
  card.originalText = null
  card.originalDecorations = null
  card.originalFunctionDecorations = null
  card.functionDecorations = null
  card.changedFunctions = 0
  card.diffEditor = null
  card.model?.dispose()
  card.editor = null
  card.model = null
  card.decorationCollection = null
  card.liveEditHighlight = null
  card.textBytes = 0
  card.text = null
  card.saveStatus = null
  card.host.replaceChildren(documentNode('div', 'editor-resting', ''))
}

async function recoverWorkspace() {
  const initialFailure = workspaceFailure
  const next = initialFailure ? await api.restartWorkspace() : await api.refresh()
  if (workspaceFailure && workspaceFailure !== initialFailure) throw workspaceFailure
  workspaceFailure = null
  applySnapshot(next)
  if (initialFailure) {
    for (const card of cards.values()) {
      if (!card.active || !card.editor || !card.model) continue
      card.languageCleanup?.()
      card.languageCleanup = null
      syncLanguageAttachment(card)
    }
  }
  if (next?.files) clearErrorNotice('workspace')
}

/** @param {unknown} cause */
function showWorkspaceFailure(cause) {
  if (closed) return
  const error = appError(cause, { operation: 'Read workspace' })
  if (error.code === 'BACKEND_UNAVAILABLE') workspaceFailure = error
  else if (workspaceFailure) return
  const retryLabel = workspaceFailure ? 'Reconnect workspace' : 'Try again'
  const title = snapshot ? 'Workspace connection interrupted' : 'Couldn’t open this project'
  if (snapshot) {
    finishWorkspaceOpening()
    reportError(error, {
      key: 'workspace',
      title,
      retry: recoverWorkspace,
      retryLabel,
      diagnostic: 'renderer.workspace-error',
    })
    return
  }
  showStartScreen(true)
  reportError(error, { silent: true, diagnostic: 'renderer.workspace-error' })
  const boundary = renderFailure(ui.startError, error, {
    scope: 'panel',
    title,
    message: workspaceFailure
      ? 'Reconnect to this project, or choose another file or folder.'
      : 'Try opening this project again, or choose another file or folder.',
    detail: `${error.message}\n\nError code ${error.code}`,
    retry: recoverWorkspace,
    retryLabel,
  })
  const label = boundary.getAttribute('aria-labelledby')
  if (label) ui.startScreen.setAttribute('aria-labelledby', label)
}

function refresh() {
  if (!snapshot) return
  runTask('Refresh workspace', async () => {
    const result = await attemptAsync(recoverWorkspace)
    if (!result.ok) showWorkspaceFailure(result.error)
  })
}

/** @param {ShortcutOverrides} overrides */
function applyShortcutOverrides(overrides) {
  shortcutOverrides = overrides
  shortcutSequence.reset()
  workspaceChordBindings = shortcutChordBindings(overrides, isMac)
  /** @type {[HTMLElement | null, import('../../../shared/preferences/shortcuts.ts').ShortcutAction, string][]} */
  const controls = [
    [ui.settingsToggle, 'openSettings', 'Settings'],
    [ui.contentSearchToggle, 'searchProject', 'Search in project'],
    [ui.reviewToggle, 'reviewChanges', 'Review changes'],
    [ui.reviewNotesToggle, 'reviewNotes', 'Review notes'],
    [ui.claudeToggle, 'toggleClaude', 'The Creature'],
    [ui.ideasToggle, 'toggleIdeas', 'Ideas'],
    [ui.navigator.querySelector('button[data-action="open-file"]'), 'searchFiles', 'Search files'],
    [ui.navigator.querySelector('button[data-action="collapse"]'), 'collapseFolders', 'Collapse all folders'],
    [ui.reviewNotesPanel.querySelector('button[data-review-action="save"]'), 'saveReviewNote', 'Save note'],
  ]
  for (const [control, action, label] of controls) {
    if (!control) continue
    control.title = `${label} · ${shortcutLabel(action)}`
    const aria = ariaBinding(shortcutBinding(action), isMac)
    if (aria) control.setAttribute('aria-keyshortcuts', aria)
    else control.removeAttribute('aria-keyshortcuts')
  }
  updateEmptyStateHint()
  const card = openedFile ? cards.get(openedFile.path) : undefined
  if (card?.document) updateSaveLabel(card)
  if (shortcutBinding('find') === defaultBinding('find', isMac)) {
    removedEditorFind?.dispose()
    removedEditorFind = undefined
  } else {
    removedEditorFind ??= monaco.editor.addKeybindingRule({
      keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      command: '-actions.find',
    })
  }
  ideas?.refreshShortcuts()
  settings?.refresh()
}

function searchFiles() {
  if (snapshot) runTask('Search files', openFilePicker)
  else openTarget('file')
}

/** @param {KeyboardEvent} event */
function findAction(event) {
  if (event.target === ui.navigator.querySelector('.navigator-tree')) return navigator.focusSearch
  const card = openedFile ? cards.get(openedFile.path) : undefined
  if (card && focusedCardEditor(card)?.hasWidgetFocus()) return findInCard(card)
  return undefined
}

/** @param {Card} card */
function focusedCardEditor(card) {
  const original = card.diffEditor?.getOriginalEditor()
  if (original?.hasWidgetFocus() || (original && card.noteSide === 'head' && !card.editor?.hasWidgetFocus()))
    return original
  return card.editor
}

/** @param {Card} card */
function findInCard(card) {
  const editor = focusedCardEditor(card)
  const action = editor?.getAction('actions.find')
  if (!editor || !action) return undefined
  return () => {
    if (!editor.hasWidgetFocus()) editor.focus()
    return action.run()
  }
}

function closeOtherEditors() {
  fileHistory.closeOthers(openedFile?.path)
  syncFileMenu()
}

/** @type {Record<FileMenuAction, (card: Card | undefined) => (() => unknown) | null | undefined | false>} */
const fileMenuCommands = {
  searchFiles: () => snapshot && openFilePicker,
  saveFile: card => {
    const autosave = card?.autosave
    return card && autosave && (autosave.pending || !editorReadOnly(card)) && (() => autosave.flush())
  },
  findInFile: card => {
    const find = card && findInCard(card)
    return (
      find &&
      (() => {
        returnFromIdeas()
        return find()
      })
    )
  },
  showDiff: card => card && canToggleDiff(card) && !card.comparing && (() => toggleDiff(card)),
  showWorkingFile: card =>
    card && canToggleDiff(card) && card.comparing && !isCheckpointOnlyDeletion(card) && (() => toggleDiff(card)),
  closeComparison: card =>
    card && canToggleDiff(card) && card.comparing && isCheckpointOnlyDeletion(card) && (() => toggleDiff(card)),
  revealActiveFile: card => card && (() => revealFileInExplorer(card.file.path)),
  copyRelativePath: card =>
    card && !card.document?.workingMissing && (() => api.fileAction('copy-relative-path', card.file.path)),
  previousEditor: card => Boolean(fileHistory.previous(card?.file.path)) && switchToPreviousFile,
  closeOtherEditors: card => Boolean(card && fileHistory.previous(card.file.path)) && closeOtherEditors,
  closeAllEditors: card => Boolean(card ?? fileHistory.previous(undefined)) && closeEditors,
}

function syncFileMenu() {
  if (!api.fileMenu || fileMenuSyncQueued) return
  fileMenuSyncQueued = true
  queueMicrotask(() => {
    fileMenuSyncQueued = false
    if (closed) return
    const card = openedFile ? cards.get(openedFile.path) : undefined
    const actions =
      app.inert || closingRequested
        ? []
        : Object.keys(fileMenuCommands)
            .filter(isFileMenuAction)
            .filter(action => fileMenuCommands[action](card))
    const signature = actions.join(',')
    if (signature === fileMenuSignature) return
    fileMenuSignature = signature
    api.fileMenu.setActions(actions)
  })
}

const workspaceShortcuts = {
  searchFiles: () => searchFiles,
  quickOpen: () => searchFiles,
  searchProject: () => contentSearch && snapshot && openContentSearch,
  reviewNotes: () => reviewNotes && snapshot && (() => ui.reviewNotesToggle.click()),
  reviewChanges: () => snapshot && toggleReview,
  toggleClaude: () => assistant && (() => ui.claudeToggle.click()),
  openClaudeAgent: () => assistant?.openEditor,
  toggleAssistantSidebar: () => assistant && (() => ui.claudeToggle.click()),
  toggleIdeas: () => ideas && snapshot && (() => ui.ideasToggle.click()),
  toggleZenMode: () => snapshot && toggleZenMode,
  toggleExplorer: () => snapshot && toggleNavigator,
  collapseFolders: () => snapshot && navigator.collapseFolders,
  focusExplorer: () => snapshot && showFileExplorer,
  revealActiveFile: () => {
    const path = openedFile?.path
    return path === undefined ? undefined : () => revealFileInExplorer(path)
  },
  navigateBack: () => snapshot && (() => navigateFileHistory(-1)),
  navigateForward: () => snapshot && (() => navigateFileHistory(1)),
  previousEditor: () => snapshot && switchToPreviousFile,
  closeAllEditors: () => snapshot && closeEditors,
  closeOtherEditors: () => snapshot && closeOtherEditors,
  closeEditorGroup: () => snapshot && (() => closeEditors(true)),
  refresh: () => snapshot && refresh,
  save: (/** @type {KeyboardEvent} */ event) => {
    if (ideas && event.target instanceof Node && ui.ideasPanel.contains(event.target)) return () => ideas.flush()
    const autosave = (openedFile ? cards.get(openedFile.path) : undefined)?.autosave
    return autosave && (() => autosave.flush())
  },
  find: findAction,
}

const shortcutSequence = createShortcutSequence()
/** @type {string[]} */
let workspaceChordBindings = []
window.addEventListener('blur', () => shortcutSequence.reset())
document.addEventListener('pointerdown', () => shortcutSequence.reset(), { capture: true })
document.addEventListener(
  'keydown',
  event => {
    if (
      !api ||
      app.inert ||
      !ui.agentThreads.hidden ||
      closingRequested ||
      settings?.isOpen ||
      event.defaultPrevented
    ) {
      shortcutSequence.reset()
      return
    }
    const dialog = document.querySelector('dialog[open]')
    const pickerOpen = dialog?.id === 'file-picker'
    if (dialog && !pickerOpen && !contentSearch?.isOpen) {
      shortcutSequence.reset()
      return
    }
    if (dialog) shortcutSequence.reset()
    const { binding, consumed } = shortcutSequence.match(event, isMac, dialog ? [] : workspaceChordBindings)
    if (consumed) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!binding) return
    if (ideas?.handleShortcut(event, binding)) return
    for (const [action, resolve] of Object.entries(workspaceShortcuts)) {
      if (!isShortcutAction(action) || binding !== shortcutBinding(action)) continue
      if (pickerOpen && action !== 'searchFiles' && action !== 'quickOpen') return
      if (contentSearch?.isOpen && action !== 'searchProject') return
      const run = resolve(event)
      if (run) {
        event.preventDefault()
        event.stopPropagation()
        if (!event.repeat) runTask('Run keyboard shortcut', run, { silent: action === 'save' })
      }
      return
    }
  },
  { capture: true },
)
applyShortcutOverrides(shortcutOverrides)

const unsubscribeSettings = shortcutApi?.onOpenSettings(openSettings)
const unsubscribeFileMenu = api.fileMenu?.onAction(action => {
  if (
    !isFileMenuAction(action) ||
    closed ||
    closingRequested ||
    app.inert ||
    !ui.agentThreads.hidden ||
    settings?.isOpen ||
    document.querySelector('dialog[open]')
  )
    return
  const card = openedFile ? cards.get(openedFile.path) : undefined
  const run = fileMenuCommands[action](card)
  if (run) runTask(fileMenuLabels[action], run, { silent: action === 'saveFile' })
})
const unsubscribeShortcuts = shortcutApi?.onChange(overrides => {
  shortcutVersion++
  applyShortcutOverrides(overrides)
})
if (shortcutApi) {
  const initialVersion = shortcutVersion
  const loadShortcuts = async () => {
    if (closed || shortcutVersion !== initialVersion) return
    const overrides = await shortcutApi.get()
    if (!closed && shortcutVersion === initialVersion) applyShortcutOverrides(overrides)
  }
  runTask('Load keyboard shortcuts', loadShortcuts, {
    title: 'Couldn’t load your shortcuts',
    retry: loadShortcuts,
  })
}

Object.assign(window, {
  __diffpane: {
    stats: () => ({
      files: cards.size,
      documentLoading: Boolean((openedFile ? cards.get(openedFile.path) : undefined)?.loading),
      snapshotRevision: snapshot?.revision ?? 0,
      activeEditors: [...cards.values()].filter(card => card.editor).length,
      models: monaco.editor.getModels().length,
      loadedTextBytes: [...cards.values()].reduce((total, card) => total + card.textBytes, 0),
      diffMode: Boolean((openedFile ? cards.get(openedFile.path) : undefined)?.diffEditor),
      changedFunctions: (openedFile ? cards.get(openedFile.path) : undefined)?.changedFunctions ?? 0,
      openedPath: openedFile?.path ?? null,
      openedLanguage: (openedFile ? cards.get(openedFile.path) : undefined)?.model?.getLanguageId() ?? null,
      syntax: syntax.stats(),
      navigator: navigator?.stats(),
      languages: languageFeatures?.stats(),
    }),
  },
})

{
  const resumeEditing = () => {
    closingRequested = false
    syncIdeasVisibility(uiPreferences.get('ideasVisible'))
    ideas?.setReadOnly(false)
    for (const card of cards.values()) applyEditorReadOnly(card)
    syncReviewState()
  }
  const unsubscribeResume = api.onResumeEditing(resumeEditing)
  const flushSaves = () =>
    rendererDiagnostics.run('renderer.workspace-flush-saves', async () => {
      const results = await Promise.allSettled([
        ...[...cards.values()].map(card => card.autosave?.flush()),
        applyingAssistantEdit,
        ideas?.flush(),
        uiPreferences.settled(),
      ])
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw appError(failed.reason, { operation: 'Save before closing' })
      syncSaveState()
      clearErrorNotice('close')
    })
  const unsubscribeFlush = api.onFlushSaves(id =>
    runTask('Flush file saves', async () => {
      closingRequested = true
      try {
        ideas?.setReadOnly(true)
        for (const card of cards.values()) applyEditorReadOnly(card)
        syncReviewState()
        await flushSaves()
        api.savesFlushed(true, id)
      } catch (cause) {
        api.savesFlushed(false, id)
        reportError(cause, {
          key: 'close',
          operation: 'Save before closing',
          title: 'This window stayed open to keep your changes',
          retry: flushSaves,
          retryLabel: 'Retry save',
        })
      }
    }),
  )
  const unsubscribeIdeas = api.ideas?.onChange(change => ideas?.applyChange(change))
  workspaceDialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
  api.rendererReady()
  syncFileMenu()
  const unsubscribePaths = subscribeLivePaths(
    api,
    guard('Apply file updates', paths => {
      const card = openedFile ? cards.get(openedFile.path) : undefined
      if (
        card &&
        paths.some(path => path === '*' || card.file.path === path || card.file.path.startsWith(`${path}/`))
      ) {
        card.dirty = true
        syncReviewState()
        scheduleDocument()
      }
    }),
  )
  /** @type {WorkspaceSnapshot | null} */
  let pendingSnapshot = null
  const snapshotPaths = new LivePathBatch()
  /** @type {number | null} */
  let snapshotFrame = null
  const unsubscribe = api.onChange(next => {
    if (closed) return
    if (!next) return
    if (
      !pendingSnapshot ||
      next.revision > pendingSnapshot.revision ||
      (next.revision === pendingSnapshot.revision && next.inventoryRevision >= pendingSnapshot.inventoryRevision)
    ) {
      pendingSnapshot = next
    }
    // Even an older snapshot can carry a path change missing from the newest snapshot.
    snapshotPaths.add(next.changedPaths ?? ['*'])
    snapshotFrame ??= requestAnimationFrame(() => {
      const pending = pendingSnapshot
      pendingSnapshot = null
      snapshotFrame = null
      if (!pending) return
      const result = attempt(() => applySnapshot({ ...pending, changedPaths: snapshotPaths.take() }))
      if (!result.ok) showWorkspaceFailure(result.error)
    })
  })
  const unsubscribeErrors = api.onError(showWorkspaceFailure)
  runTask('Load workspace', async () => {
    const result = await attemptAsync(async () => applySnapshot(await api.snapshot()))
    if (!result.ok) showWorkspaceFailure(result.error)
  })
  window.addEventListener(
    'pagehide',
    () => {
      closed = true
      terminalBounds.disconnect()
      workspaceDialogs.disconnect()
      unsubscribeTerminal?.()
      howmany?.dispose()
      agentThreadPanel?.dispose()
      assistant?.dispose()
      reviewNotes?.dispose()
      workspaceLayout.dispose()
      unsubscribeIdeas?.()
      ideas?.dispose()
      contentSearch?.dispose()
      if (snapshotFrame !== null) cancelAnimationFrame(snapshotFrame)
      if (documentFrame !== null) cancelAnimationFrame(documentFrame)
      navigator.dispose()
      review.dispose()
      gitWorkspace.destroy()
      unsubscribeGitChanges()
      window.removeEventListener('focus', refreshBillyLanes)
      window.removeEventListener('focus', refreshGitWorkspace)
      billyContext?.dispose()
      billyLanes?.dispose()
      unsubscribePaths()
      appearance.dispose()
      unsubscribeIdeaVisibility()
      uiPreferences.dispose()
      unsubscribeSettings?.()
      unsubscribeFileMenu?.()
      unsubscribeShortcuts?.()
      removedEditorFind?.dispose()
      unsubscribeFlush()
      unsubscribeResume()
      languageFeatures.dispose()
      if (typeof unsubscribe === 'function') unsubscribe()
      if (typeof unsubscribeErrors === 'function') unsubscribeErrors()
      for (const card of cards.values()) deactivate(card)
      documentProcessor.dispose()
      languageWidgets.remove()
    },
    { once: true },
  )
}
