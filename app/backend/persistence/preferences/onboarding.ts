// Copyright (c) 2026 The Billy Company
import type { StateRecords } from '../database/local-state.ts'
import type { Appearance } from './ui-preferences.ts'

export type OnboardingStep = 'intro' | 'welcome' | 'appearance' | 'ready'
export type OnboardingStage = OnboardingStep | 'home-tour' | 'workspace-tour' | 'done'
export type OnboardingAppearance = Partial<Pick<Appearance, 'theme' | 'layout'>>
export interface OnboardingState {
  stage: OnboardingStage
  draft?: OnboardingAppearance
}

const collection = 'onboarding'
const key = 'first-run'

export function isSetupStep(value: unknown): value is OnboardingStep {
  return value === 'intro' || value === 'welcome' || value === 'appearance' || value === 'ready'
}

export function parseOnboardingState(value: unknown): OnboardingState {
  if (!value || typeof value !== 'object' || !('stage' in value)) throw new Error('Invalid onboarding state.')
  const { stage } = value
  if (stage === 'home-tour' || stage === 'workspace-tour' || stage === 'done') return { stage }
  if (!isSetupStep(stage)) throw new Error('Invalid onboarding stage.')
  return {
    stage,
    ...('draft' in value && { draft: parseOnboardingAppearance(value.draft) }),
  }
}

export function parseOnboardingAppearance(value: unknown): OnboardingAppearance {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object') throw new Error('Invalid onboarding appearance.')
  const theme = 'theme' in value ? value.theme : undefined
  const layout = 'layout' in value ? value.layout : undefined
  if (theme !== undefined && theme !== 'system' && theme !== 'light' && theme !== 'dark')
    throw new Error('Invalid onboarding theme.')
  if (layout !== undefined && layout !== 'automatic' && layout !== 'inline' && layout !== 'split')
    throw new Error('Invalid onboarding comparison layout.')
  return { ...(theme && { theme }), ...(layout && { layout }) }
}

export function readOnboarding(records: StateRecords, existingProfile: boolean): OnboardingState {
  const stored = records.get(collection, '', key)
  if (stored !== undefined) return parseOnboardingState(stored)
  const initial: OnboardingState = { stage: existingProfile ? 'done' : 'intro' }
  writeOnboarding(records, initial)
  return initial
}

export function writeOnboarding(records: StateRecords, state: OnboardingState) {
  records.put(collection, '', key, state)
}
