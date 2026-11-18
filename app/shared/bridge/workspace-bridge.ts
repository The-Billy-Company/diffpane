import type { OnboardingAppearance, OnboardingState } from '../../backend/persistence/preferences/onboarding.ts'
import type { UiPreferencesBridge } from '../../backend/persistence/preferences/ui-preferences.ts'
import type { WorkspaceComparison, WorkspaceSnapshot } from '../../backend/runtime/session/workspace-types.ts'
import type { HowManyEvent } from '../../backend/tools/analysis/howmany.mjs'
import type { ClaudeActivity, ClaudePrompt } from '../../backend/tools/assistant/claude-session.mjs'
import type { ContentSearchRequest } from '../../backend/workspace/repository/content-search.mjs'
import type { BillyContractRequest } from '../billy/contracts.ts'
import type { BillySetupAction } from '../billy/setup.ts'
import type { DiagnosticEvent } from '../diagnostics/diagnostics.ts'
import type { Idea, IdeaChange } from '../ideas/ideas.ts'
import type { FileMenuAction } from '../preferences/file-menu.ts'
import type { WorkspaceDraft, WorkspaceSaveOptions } from '../preferences/saved-workspaces.ts'
import type { ShortcutAction, ShortcutBinding, ShortcutOverrides } from '../preferences/shortcuts.ts'
import type { ErrorDetails } from '../recovery/app-errors.ts'
import type { GitComparison, GitFile } from '../review/git.ts'
import type { ReviewNote, ReviewNoteChange } from '../review/review-notes.ts'
import type { DesktopTransport } from './transport.ts'
import { validatedTransport } from './transport.ts'
import { isHowManyState, isHowManyFile, isHowManyEvent } from './validators/analysis.ts'
import type { ClaudeStatus } from './validators/assistant.ts'
import {
  isClaudeStatus,
  isAgentThread,
  isAgentThreadList,
  isAgentMemorySnapshot,
  isAgentThreadEvent,
  isAgentThreadUpdate,
  isAgentFileView,
  isClaudeReply,
  isClaudeApplied,
  isClaudeActivity,
} from './validators/assistant.ts'
import {
  isBillyLanePage,
  isBillyLaneLog,
  isBillyLaneChecks,
  isBillyContractDiff,
  isBillyClaimsResult,
  isBillySiblingResult,
} from './validators/billy/lanes.ts'
import {
  isBillyPlaybook,
  isBillyReplayRun,
  isBillyReplayCase,
  isBillySetupStatus,
  isBillySetupStartResult,
} from './validators/billy/replay.ts'
import {
  isUiPreferences,
  isUiPreferenceUpdate,
  isOnboardingState,
  isOnboardingExperience,
  isShortcutOverrides,
  isIdea,
  isIdeaChange,
  isReviewNote,
  isRecentTarget,
  isSavedWorkspace,
  isWorkspaceContext,
} from './validators/persistence.ts'
import {
  isRecord,
  isErrorDetails,
  arrayOf,
  nullable,
  isUnknown,
  isVoid,
  isBoolean,
  isString,
  isCount,
  isPositive,
  isNull,
} from './validators/values.ts'
import {
  isContentSearchResult,
  isInventoryFile,
  isInventoryUpdate,
  isGitOverview,
  isGitChanges,
  isGitFileContents,
  isSnapshot,
  isWorkspaceDocument,
  isMedia,
} from './validators/workspace.ts'

export function createWorkspaceBridge(transport: DesktopTransport) {
  const { invoke, listen, reportDiagnostic } = validatedTransport(transport)

  return {
    billy: {
      available: () => invoke('billy-available', isBoolean),
      setup: {
        status: () => invoke('billy-setup-status', isBillySetupStatus),
        run: (action: BillySetupAction) => invoke('billy-setup-run', isBillySetupStartResult, action),
      },
      listLanes: () => invoke('billy-lanes', isBillyLanePage),
      readLaneChecks: (slug: string) => invoke('billy-lane-checks', isBillyLaneChecks, slug),
      readLaneLog: (slug: string, check: string, capture: string) =>
        invoke('billy-lane-log', isBillyLaneLog, slug, check, capture),
      readContractDiff: (request: BillyContractRequest) => invoke('billy-contract', isBillyContractDiff, request),
      readClaims: (path: string) => invoke('billy-claims', isBillyClaimsResult, path),
      readSiblings: (path: string, line: number) => invoke('billy-siblings', isBillySiblingResult, path, line),
      replay: {
        playbook: (path: string) => invoke('billy-playbook', nullable(isBillyPlaybook), path),
        pickRun: () => invoke('billy-pick-replay', nullable(isBillyReplayRun)),
        readCase: (runId: string, scenario: string) => invoke('billy-replay-case', isBillyReplayCase, runId, scenario),
      },
    },
    preferences: {
      get: legacy => invoke('preferences-get', isUiPreferences, legacy),
      set: (key, value) => invoke('preferences-set', isUiPreferenceUpdate, key, value),
      onChange: callback => listen('preferences-updated', isUiPreferenceUpdate, callback),
    } satisfies UiPreferencesBridge,
    onboarding: {
      enter: (surface: 'home' | 'workspace', replay: boolean) =>
        invoke('onboarding-enter', nullable(isOnboardingState), surface, replay),
      save: (state: OnboardingState, appearance?: OnboardingAppearance) =>
        invoke('onboarding-save', isVoid, state, appearance),
      release: () => transport.send('onboarding-release'),
      onShow: (callback: (experience: 'setup' | 'tour') => void) =>
        listen('show-onboarding', isOnboardingExperience, callback),
    },
    shortcuts: {
      platform: transport.platform,
      get: () => invoke('shortcuts-get', isShortcutOverrides),
      set: (action: ShortcutAction, binding: ShortcutBinding) =>
        invoke('shortcuts-set', isShortcutOverrides, action, binding),
      reset: (action?: ShortcutAction) => invoke('shortcuts-reset', isShortcutOverrides, action),
      setCapturing: (active: boolean) => invoke('shortcuts-capture', isVoid, active),
      setModal: (active: boolean) => transport.send('shortcuts-modal', active),
      onChange: (callback: (overrides: ShortcutOverrides) => void) =>
        listen('shortcuts-updated', isShortcutOverrides, callback),
      onOpenSettings: (callback: () => void) => listen('open-settings', isVoid, callback),
    },
    fileMenu: {
      setActions: (actions: FileMenuAction[]) => transport.send('file-menu-actions', actions),
      onAction: (callback: (action: string) => void) => listen('file-menu-action', isString, callback),
    },
    reviewNotes: {
      list: () => invoke('review-notes-list', arrayOf(isReviewNote)),
      change: (change: ReviewNoteChange) => invoke('review-notes-change', arrayOf(isReviewNote), change),
      copy: () => invoke('review-notes-copy', isCount),
      onChange: (callback: (notes: ReviewNote[]) => void) =>
        listen('review-notes-updated', arrayOf(isReviewNote), callback),
    },
    claude: {
      status: () => invoke('claude-status', isClaudeStatus),
      saveKey: (key: string) => invoke('claude-save-key', isClaudeStatus, key),
      removeKey: () => invoke('claude-remove-key', isClaudeStatus),
      send: (input: ClaudePrompt) => invoke('claude-send', isClaudeReply, input),
      apply: (id: string) => invoke('claude-apply', isClaudeApplied, id),
      discard: (id: string) => invoke('claude-discard', isVoid, id),
      reset: () => invoke('claude-reset', isVoid),
      cancel: () => invoke('claude-cancel', isVoid),
      onActivity: (callback: (activity: ClaudeActivity) => void) =>
        listen('claude-activity', isClaudeActivity, callback),
      onReset: (callback: (status: ClaudeStatus) => void) => listen('claude-reset', isClaudeStatus, callback),
    },
    agentThreads: {
      list: () => invoke('agent-threads-list', isAgentThreadList),
      memory: () => invoke('agent-threads-memory', isAgentMemorySnapshot),
      children: (selection: string, parentId?: string) =>
        invoke('agent-threads-children', arrayOf(isAgentThread), selection, parentId),
      read: (id: string, selection: string, childId?: string) =>
        invoke('agent-threads-read', arrayOf(isAgentThreadEvent), id, selection, childId),
      update: (id: string, selection: string, childId?: string) =>
        invoke('agent-threads-update', isAgentThreadUpdate, id, selection, childId),
      clear: (selection: string) => invoke('agent-threads-clear', isVoid, selection),
      file: (selection: string, path: string, childId?: string, line?: number) =>
        invoke('agent-threads-file', isAgentFileView, selection, path, childId, line),
    },
    ideas: {
      list: () => invoke('ideas-list', arrayOf(isIdea)),
      upsert: (idea: Idea) => invoke('ideas-upsert', isIdea, idea),
      delete: (id: string) => invoke('ideas-delete', isVoid, id),
      onChange: (callback: (change: IdeaChange) => void) => listen('ideas-change', isIdeaChange, callback),
    },
    howmany: {
      export: () => invoke('howmany-export', isBoolean),
      analyze: (force?: boolean) => invoke('howmany-analyze', isHowManyState, force),
      file: (path: string, request: string) => invoke('howmany-file', nullable(isHowManyFile), path, request),
      close: (path: string) => invoke('howmany-close', isNull, path),
      onEvent: (callback: (value: HowManyEvent) => void) => listen('howmany-event', isHowManyEvent, callback),
    },
    language: {
      open: (input: unknown) => invoke('language-open', isRecord, input),
      request: (input: unknown) => invoke('language-request', isUnknown, input),
      cancel: (id: string | number) => invoke('language-cancel', isNull, id),
      close: (path: string) => invoke('language-close', isNull, path),
      status: () => invoke('language-status', arrayOf(isRecord)),
      onEvent: (callback: (value: unknown) => void) => listen('language-event', isRecord, callback),
    },
    snapshot: () => invoke('snapshot', nullable(isSnapshot)),
    restartWorkspace: () => invoke('restart-workspace', nullable(isSnapshot)),
    captureCheckpoint: () => invoke('capture-checkpoint', isSnapshot),
    files: () => invoke('files', arrayOf(isInventoryFile)),
    contentSearch: (request: ContentSearchRequest) =>
      invoke('content-search', nullable(isContentSearchResult), request),
    cancelContentSearch: () => invoke('content-search-cancel', isVoid),
    filesDelta: (revision: number | null) => invoke('files-delta', isInventoryUpdate, revision),
    directoryExpanded: (path: string, expanded: boolean) => invoke('directory-expanded', isNull, path, expanded),
    document: (path: string, comparison: WorkspaceComparison = 'head') =>
      invoke('document', isWorkspaceDocument, path, comparison),
    git: {
      overview: (dayStart: number, dayEnd: number, historyLimit?: number) =>
        invoke('git-overview', isGitOverview, dayStart, dayEnd, historyLimit),
      changes: (comparison: GitComparison) => invoke('git-changes', isGitChanges, comparison),
      contents: (comparison: GitComparison, file: GitFile) =>
        invoke('git-contents', isGitFileContents, comparison, file),
      onChange: (callback: () => void) => listen('git-change', isNull, callback),
    },
    save: (path: string, text: string, expected: string) => invoke('save', isNull, path, text, expected),
    rename: (path: string, name: string) => invoke('rename', isString, path, name),
    fileAction: (action: string, path: string) => invoke('file-action', isVoid, action, path),
    onFlushSaves: (callback: (id: number) => void) => listen('flush-saves', isPositive, callback),
    onResumeEditing: (callback: () => void) => listen('resume-editing', isVoid, callback),
    savesFlushed: (success: boolean, id: number) => transport.send('saves-flushed', success, id),
    setSaveState: (dirty: boolean) => transport.send('save-state', dirty),
    rendererReady: () => transport.send('renderer-ready'),
    terminal: {
      toggle: () => invoke('terminal-toggle', isBoolean),
      layout: (height: number, bottom: number, theme?: 'light' | 'dark') =>
        transport.send('terminal-layout', height, bottom, theme),
      onVisibility: (callback: (visible: boolean) => void) => listen('terminal-visibility', isBoolean, callback),
    },
    reportDiagnostic: (event: DiagnosticEvent) => reportDiagnostic(event),
    media: (path: string) => invoke('media', isMedia, path),
    refresh: () => invoke('refresh', isSnapshot),
    openFolder: () => invoke('open-folder', isBoolean),
    openFile: () => invoke('open-file', isBoolean),
    recentTargets: () => invoke('recent-targets', arrayOf(isRecentTarget)),
    openRecent: (path: string) => invoke('open-recent', isBoolean, path),
    workspaces: {
      list: () => invoke('workspaces-list', arrayOf(isSavedWorkspace)),
      current: () => invoke('workspaces-current', nullable(isWorkspaceContext)),
      pickFolders: () => invoke('workspaces-pick-folders', arrayOf(isString)),
      save: (input: WorkspaceDraft, options?: WorkspaceSaveOptions) =>
        invoke('workspaces-save', isSavedWorkspace, input, options),
      open: (id: string) => invoke('workspaces-open', isBoolean, id),
      switchFolder: (folder: string) => invoke('workspaces-switch-folder', isBoolean, folder),
      remove: (id: string) => invoke('workspaces-remove', isBoolean, id),
      close: () => invoke('workspaces-close', isBoolean),
      rememberFile: (filename: string | null) => transport.send('workspaces-remember-file', filename),
      onChange: (callback: () => void) => listen('workspaces-changed', isVoid, callback),
    },
    openExternal: (url: string) => invoke('open-external', isVoid, url),
    onChange: (callback: (value: WorkspaceSnapshot) => void) => listen('change', isSnapshot, callback),
    onPaths: (callback: (paths: string[]) => void) => listen('paths', arrayOf(isString), callback),
    onError: (callback: (value: ErrorDetails) => void) => listen('backend-error', isErrorDetails, callback),
  }
}

export type DiffpaneApi = ReturnType<typeof createWorkspaceBridge>
