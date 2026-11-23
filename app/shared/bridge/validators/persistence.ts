// Copyright (c) 2026 The Billy Company
import type { OnboardingState } from '../../../backend/persistence/preferences/onboarding.ts'
import type { RecentTarget } from '../../../backend/persistence/preferences/recent-targets.ts'
import type {
  Appearance,
  UiPreferences,
  UiPreferenceUpdate,
  WorkspaceLayout,
} from '../../../backend/persistence/preferences/ui-preferences.ts'
import type { Idea, IdeaChange, IdeaLink } from '../../ideas/ideas.ts'
import type { SavedWorkspace, WorkspaceContext } from '../../preferences/saved-workspaces.ts'
import type { ShortcutOverrides } from '../../preferences/shortcuts.ts'
import type { ReviewAnchor, ReviewNote } from '../../review/review-notes.ts'
import {
  isRecord,
  arrayOf,
  optional,
  nullable,
  isBoolean,
  isString,
  isCount,
  isPositive,
  isTimestamp,
  isSide,
} from './values.ts'

const appearanceFonts = {
  system: true,
  'monaspace-neon': true,
  'monaspace-argon': true,
  'monaspace-krypton': true,
  'monaspace-radon': true,
  'monaspace-xenon': true,
  menlo: true,
  monaco: true,
  courier: true,
  wingdings: true,
} satisfies Record<Appearance['font'], true>

function isUiAppearance(value: unknown): value is Appearance {
  return (
    isRecord(value) &&
    (value.theme === 'dark' || value.theme === 'light' || value.theme === 'system') &&
    (value.layout === 'automatic' || value.layout === 'split' || value.layout === 'inline') &&
    isString(value.font) &&
    Object.hasOwn(appearanceFonts, value.font) &&
    isCount(value.fontSize) &&
    value.fontSize >= 10 &&
    value.fontSize <= 28 &&
    (value.wordWrap === 'automatic' || value.wordWrap === 'on' || value.wordWrap === 'off') &&
    isBoolean(value.lineNumbers)
  )
}

function isUiLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value)) return false
  const order: unknown = value.order
  return (
    isTimestamp(value.ideas) &&
    isTimestamp(value.files) &&
    isTimestamp(value.right) &&
    isTimestamp(value.rightHeight) &&
    Array.isArray(order) &&
    order.length === 4 &&
    ['ideas', 'files', 'code', 'right'].every(pane => order.includes(pane))
  )
}

export function isUiPreferences(value: unknown): value is Partial<UiPreferences> {
  return (
    isRecord(value) &&
    optional(isUiAppearance)(value.appearance) &&
    optional(isUiLayout)(value.layout) &&
    optional(isBoolean)(value.ideasVisible)
  )
}

export function isUiPreferenceUpdate(value: unknown): value is UiPreferenceUpdate {
  if (!isRecord(value) || !optional(isCount)(value.revision)) return false
  if (value.key === 'appearance') return isUiAppearance(value.value)
  if (value.key === 'layout') return isUiLayout(value.value)
  return value.key === 'ideasVisible' && isBoolean(value.value)
}

export function isOnboardingState(value: unknown): value is OnboardingState {
  if (!isRecord(value)) return false
  const { stage, draft } = value
  if (
    !isString(stage) ||
    !['intro', 'welcome', 'appearance', 'ready', 'home-tour', 'workspace-tour', 'done'].includes(stage)
  )
    return false
  return (
    draft === undefined ||
    (isRecord(draft) &&
      (draft.theme === undefined || draft.theme === 'system' || draft.theme === 'light' || draft.theme === 'dark') &&
      (draft.layout === undefined ||
        draft.layout === 'automatic' ||
        draft.layout === 'inline' ||
        draft.layout === 'split'))
  )
}

export const isOnboardingExperience = (value: unknown): value is 'setup' | 'tour' =>
  value === 'setup' || value === 'tour'

export function isShortcutOverrides(value: unknown): value is ShortcutOverrides {
  return isRecord(value) && Object.values(value).every(isString)
}

function isIdeaLink(value: unknown): value is IdeaLink {
  return (
    isRecord(value) &&
    isString(value.path) &&
    optional(isPositive)(value.line) &&
    optional(isPositive)(value.endLine) &&
    optional(isSide)(value.side) &&
    optional(isString)(value.excerpt) &&
    optional(isBoolean)(value.truncated)
  )
}

export function isIdea(value: unknown): value is Idea {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.body) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    arrayOf(isIdeaLink)(value.links)
  )
}

export function isIdeaChange(value: unknown): value is IdeaChange {
  return (
    isRecord(value) &&
    ((value.type === 'upsert' && isIdea(value.idea)) || (value.type === 'delete' && isString(value.id)))
  )
}

function isReviewAnchor(value: unknown): value is ReviewAnchor {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isSide(value.side) &&
    (value.originalPath === undefined || (value.side === 'head' && isString(value.originalPath))) &&
    ((value.line === null && value.endLine === null) ||
      (isPositive(value.line) && isPositive(value.endLine) && value.endLine >= value.line)) &&
    isString(value.excerpt) &&
    isBoolean(value.truncated)
  )
}

export function isReviewNote(value: unknown): value is ReviewNote {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.text) &&
    isBoolean(value.resolved) &&
    nullable(isReviewAnchor)(value.anchor)
  )
}

export function isRecentTarget(value: unknown): value is RecentTarget {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.name) &&
    isTimestamp(value.openedAt) &&
    (value.kind === 'folder' || value.kind === 'file')
  )
}

export function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    arrayOf(isString)(value.folders) &&
    isString(value.activeFolder) &&
    value.folders.includes(value.activeFolder) &&
    isTimestamp(value.updatedAt)
  )
}

export function isWorkspaceContext(value: unknown): value is WorkspaceContext {
  return (
    isRecord(value) &&
    isSavedWorkspace(value.workspace) &&
    nullable(isString)(value.folder) &&
    arrayOf(isString)(value.unavailableFolders)
  )
}
