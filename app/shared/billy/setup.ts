export const billySetupActions = [
  {
    id: 'igor-auth',
    group: 'accounts',
    label: 'Igor authentication',
    description: 'Refresh Google Cloud CLI, application credentials, and Firebase together.',
    buttonLabel: 'Authenticate',
  },
  {
    id: 'google',
    group: 'accounts',
    label: 'Google Cloud CLI',
    description: 'Sign in for gcloud commands.',
    buttonLabel: 'Sign in',
  },
  {
    id: 'google-adc',
    group: 'accounts',
    label: 'Google application credentials',
    description: 'Sign in for local apps and SDKs that use Application Default Credentials.',
    buttonLabel: 'Sign in',
  },
  {
    id: 'firebase',
    group: 'accounts',
    label: 'Firebase CLI',
    description: 'Refresh the Firebase CLI session.',
    buttonLabel: 'Sign in',
  },
  {
    id: 'github',
    group: 'accounts',
    label: 'GitHub CLI',
    description: 'Sign in for GitHub CLI commands.',
    buttonLabel: 'Sign in',
  },
  {
    id: 'doctor',
    group: 'maintenance',
    label: 'Onboarding doctor',
    description: 'Show Igor’s full report on tools and local stack prerequisites.',
    buttonLabel: 'Run doctor',
  },
  {
    id: 'repair-env',
    group: 'maintenance',
    label: 'Local environment files',
    description: 'Create missing .env files from Billy’s examples and keep existing files.',
    buttonLabel: 'Repair files',
  },
] as const

export type BillySetupAction = (typeof billySetupActions)[number]['id']

export interface BillySetupCheck {
  label: string
  state: 'ready' | 'attention' | 'unavailable'
  detail: string
}

export interface BillySetupStatus {
  checks: BillySetupCheck[]
}

export type BillySetupStartResult = { ok: true } | { ok: false; message: string }
