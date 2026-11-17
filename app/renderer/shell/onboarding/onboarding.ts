import type { OnboardingAppearance, OnboardingState } from '../../../electron/persistence/preferences/onboarding.ts'
import type { Appearance } from '../../../electron/persistence/preferences/ui-preferences.ts'
import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import type { ShortcutAction } from '../../../shared/preferences/shortcuts.ts'
import { clearErrorNotice, reportError, runTask } from '../recovery/errors.ts'
import { createOnboardingSetup } from './setup.ts'
import { homeTourStops, startOnboardingTour, workspaceTourStops } from './tour.ts'

type Surface = 'home' | 'workspace'
type Experience = 'setup' | 'tour'

interface Options {
  api: DiffpaneApi['onboarding']
  surface: () => Surface | undefined
  appearance: () => Appearance
  shortcutLabel: (action: ShortcutAction) => string
}

export function createOnboarding({ api, surface, appearance, shortcutLabel }: Options) {
  let active: { close: () => void } | undefined
  let starting = false
  let finishing = false
  let disposed = false
  let checkedSurface: Surface | undefined

  function canShow() {
    return !disposed && !document.querySelector('dialog[open]')
  }

  function presentTour(target: Surface, track: boolean) {
    active = startOnboardingTour({
      stops: target === 'home' ? homeTourStops : workspaceTourStops,
      onFinish(reason) {
        active = undefined
        if (disposed) return
        if (!track) {
          api.release()
          return
        }
        const state: OnboardingState = {
          stage: target === 'home' && reason === 'done' ? 'workspace-tour' : 'done',
        }
        finishing = true
        const save = async () => {
          try {
            await api.save(state)
            api.release()
            clearErrorNotice('tour-progress')
          } finally {
            finishing = false
          }
        }
        runTask('Save tour progress', save, { key: 'tour-progress', title: 'Couldn’t save tour progress', retry: save })
      },
    })
  }

  function presentSetup(state: OnboardingState, initialSurface: Surface) {
    const { stage, draft } = state
    const track = stage === 'intro' || stage === 'welcome' || stage === 'appearance' || stage === 'ready'
    const initial = appearance()
    const original = { theme: initial.theme, layout: initial.layout }
    const changed = (look: OnboardingAppearance): OnboardingAppearance => ({
      ...(look.theme !== undefined && look.theme !== original.theme && { theme: look.theme }),
      ...(look.layout !== undefined && look.layout !== original.layout && { layout: look.layout }),
    })
    let launchTour = false
    active = createOnboardingSetup({
      startStep: track ? stage : 'intro',
      appearance: { ...original, ...draft },
      inWorkspace: initialSurface === 'workspace',
      shortcutLabel,
      onStep(step, look) {
        if (track)
          void api
            .save({ stage: step, draft: changed(look) })
            .catch((cause: unknown) => reportError(cause, { operation: 'Save setup progress', silent: true }))
      },
      async onFinish(result) {
        const target = surface()
        const next = result.tour ? (target === 'workspace' ? 'workspace-tour' : 'home-tour') : 'done'
        await api.save({ stage: next }, changed(result.appearance))
        launchTour = result.tour
      },
      onClosed() {
        active = undefined
        const target = surface()
        if (!disposed && launchTour && target && canShow()) presentTour(target, true)
        else if (!disposed) api.release()
      },
    })
  }

  async function begin(replay?: Experience) {
    const target = surface()
    if (!target || active || starting || finishing || !canShow() || (!replay && checkedSurface === target)) return
    starting = true
    try {
      const state = await api.enter(target, Boolean(replay))
      if (!state) {
        if (!replay) checkedSurface = target
        return
      }
      if (!canShow() || surface() !== target) {
        api.release()
        return
      }
      checkedSurface = target
      const pendingTour = state.stage === 'home-tour' || state.stage === 'workspace-tour'
      if (replay === 'tour' || (!replay && pendingTour)) presentTour(target, pendingTour || state.stage === 'done')
      else presentSetup(state, target)
    } catch (cause) {
      api.release()
      throw cause
    } finally {
      starting = false
    }
  }

  const unsubscribe = api.onShow(experience => {
    runTask('Show onboarding', () => begin(experience), { title: 'Couldn’t show onboarding' })
  })

  return {
    get isActive() {
      return Boolean(active)
    },
    ready() {
      runTask('Resume onboarding', () => begin(), { silent: true })
    },
    dispose() {
      disposed = true
      unsubscribe()
      active?.close()
      api.release()
    },
  }
}
