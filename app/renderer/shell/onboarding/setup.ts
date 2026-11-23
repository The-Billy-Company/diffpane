import type { OnboardingStep } from '../../../backend/persistence/preferences/onboarding.ts'
import type { Appearance } from '../../../backend/persistence/preferences/ui-preferences.ts'
import { bindingLabel, effectiveBinding } from '../../../shared/preferences/shortcuts.ts'
import { runTask } from '../recovery/errors.ts'
import { requireElement } from '../workspace/dom.js'
import { appIcon, comparisonArt, introArt } from './setup-art.ts'
import './setup.css'

const steps = ['intro', 'welcome', 'appearance', 'ready'] as const
const stepLabels = ['Welcome', 'Appearance', 'Ready']
export type { OnboardingStep }
type SetupAppearance = Pick<Appearance, 'theme' | 'layout'>
type SetupShortcut = 'searchFiles' | 'searchProject' | 'reviewChanges' | 'reviewNotes'
type PreviewWidth = 'wide' | 'narrow'

interface SetupOptions {
  appearance: SetupAppearance
  startStep: OnboardingStep
  onStep: (step: OnboardingStep, appearance: Partial<SetupAppearance>) => void
  onFinish: (result: { tour: boolean; appearance: Partial<SetupAppearance> }) => Promise<void>
  onClosed?: () => void
  shortcutLabel?: (action: SetupShortcut) => string
  inWorkspace?: boolean
  isGitRepository?: boolean
}

const themeChoices = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const
const layoutChoices = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'split', label: 'Side by side' },
  { value: 'inline', label: 'Inline' },
] as const

const shortcutExamples: ReadonlyArray<{ action: SetupShortcut; label: string }> = [
  { action: 'searchFiles', label: 'Find a file' },
  { action: 'searchProject', label: 'Search in project' },
  { action: 'reviewChanges', label: 'Review changes' },
  { action: 'reviewNotes', label: 'Open review notes' },
]
const introHold = 1400

function introMarkup() {
  return `<div class="onboarding-intro">
    ${introArt()}
    <div class="onboarding-intro-mark">
      <img src="${appIcon}" alt="" width="96" height="96">
      <h1 id="onboarding-setup-title" tabindex="-1">Diffpane</h1>
      <p>A quiet, live view of your files</p>
    </div>
    <button class="onboarding-intro-skip" type="button" data-action="next" aria-label="Skip intro animation">Skip</button>
  </div>`
}

function progressMarkup(index: number) {
  return `<ol class="onboarding-progress" aria-label="Setup progress">
    ${stepLabels.map((label, item) => `<li${item + 1 === index ? ' aria-current="step"' : ''}${item + 1 < index ? ' class="is-complete"' : ''}>${label}</li>`).join('')}
  </ol>`
}

function choicesMarkup(key: keyof SetupAppearance, label: string, draft: SetupAppearance) {
  const choices = key === 'theme' ? themeChoices : layoutChoices
  return `<fieldset class="onboarding-choices"${key === 'layout' ? ' aria-describedby="onboarding-layout-help"' : ''}>
    <legend>${label}</legend>
    <div>${choices
      .map(
        choice =>
          `<label><input type="radio" name="${key}" value="${choice.value}"${
            choice.value === draft[key] ? ' checked' : ''
          }><span class="onboarding-choice"><i aria-hidden="true" data-choice="${choice.value}"></i>${choice.label}</span></label>`,
      )
      .join('')}</div>
  </fieldset>`
}

function shortcuts(isGitRepository: boolean) {
  return shortcutExamples.filter(
    ({ action }) => isGitRepository || action === 'searchFiles' || action === 'searchProject',
  )
}

function shortcutMarkup(isGitRepository: boolean) {
  return `<section class="onboarding-shortcut-section" aria-labelledby="onboarding-shortcut-title">
    <h2 id="onboarding-shortcut-title">A few handy shortcuts</h2>
    <dl class="onboarding-shortcuts">${shortcuts(isGitRepository)
      .map(({ action, label }) => `<div><dt>${label}</dt><dd><kbd data-shortcut="${action}"></kbd></dd></div>`)
      .join('')}</dl>
  </section>`
}

function contentFor(
  step: Exclude<OnboardingStep, 'intro'>,
  draft: SetupAppearance,
  inWorkspace?: boolean,
  isGitRepository = false,
) {
  const continueButton =
    '<button class="onboarding-primary" type="button" data-action="next">Continue <span aria-hidden="true">→</span></button>'
  switch (step) {
    case 'welcome':
      return {
        title: 'See changes as they happen',
        subtitle: 'Diffpane gives you a live view of your files and folders.',
        body: `<ul class="onboarding-features">
          <li><span class="onboarding-feature-live" aria-hidden="true"></span><div><strong>Follow edits live</strong><p>See saves from you and your tools.</p></div></li>
          ${isGitRepository ? '<li><span class="onboarding-feature-diff" aria-hidden="true">±</span><div><strong>Review changes in context</strong><p>Compare with Git HEAD and track your review.</p></div></li>' : ''}
        </ul>`,
        preview: isGitRepository
          ? `<figure class="onboarding-art">
          <figcaption><span>Example workspace</span><span class="onboarding-live-status"><i aria-hidden="true"></i> Watching</span></figcaption>
          ${comparisonArt()}
        </figure>`
          : '',
        actions: `<button type="button" data-action="skip">Skip setup</button>${continueButton}`,
      }
    case 'appearance':
      return {
        title: 'Make it yours',
        subtitle: isGitRepository ? 'Pick a theme and a layout for reading diffs.' : 'Pick a theme for your workspace.',
        body: `<div class="onboarding-preferences">${choicesMarkup('theme', 'Theme', draft)}${isGitRepository ? `${choicesMarkup('layout', 'Diff layout', draft)}<p id="onboarding-layout-help">Automatic switches to inline diffs in narrow panes.</p>` : ''}</div>`,
        preview: isGitRepository
          ? `<figure class="onboarding-art">
          <figcaption><span>Live preview</span>
            <div class="onboarding-preview-width" role="group" aria-label="Preview pane width">
              <button type="button" data-preview-width="wide" aria-pressed="true">Wide</button>
              <button type="button" data-preview-width="narrow" aria-pressed="false">Narrow</button>
            </div>
          </figcaption>
          ${comparisonArt()}
          <p class="onboarding-preview-result" role="status"></p>
        </figure>`
          : '',
        actions: continueButton,
      }
    case 'ready':
      return {
        title: 'Ready to explore',
        subtitle: inWorkspace
          ? 'Return to your folder or take a quick tour of the workspace.'
          : 'Open a file or folder, or take a quick tour.',
        body: shortcutMarkup(isGitRepository),
        preview: '',
        actions: `<button class="onboarding-tour-action" type="button" data-action="tour">Take the tour</button>
          <button class="onboarding-primary" type="button" data-action="finish">${inWorkspace ? 'Go to workspace' : 'Get started'} <span aria-hidden="true">→</span></button>`,
      }
    default:
      throw new Error(`Unknown onboarding step: ${String(step)}`)
  }
}

export function createOnboardingSetup(options: SetupOptions) {
  const dialog = document.createElement('dialog')
  dialog.className = 'onboarding-setup'
  dialog.dataset.gitRepository = String(Boolean(options.isGitRepository))
  dialog.setAttribute('aria-labelledby', 'onboarding-setup-title')
  const system = matchMedia('(prefers-color-scheme: dark)')
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const draft = { ...options.appearance }
  const previousFocus = document.activeElement
  let step = options.startStep
  let previewWidth: PreviewWidth = 'wide'
  let introTimer: ReturnType<typeof setTimeout> | undefined
  let leavingIntro = false
  let finishing = false
  let closed = false

  function paintPreview() {
    const preview = dialog.querySelector<HTMLElement>('.onboarding-preview-window')
    if (!preview) return
    const scheme = draft.theme === 'system' ? (system.matches ? 'dark' : 'light') : draft.theme
    preview.dataset.scheme = scheme
    preview.dataset.layout = step === 'welcome' ? 'split' : draft.layout
    preview.dataset.width = step === 'welcome' ? 'wide' : previewWidth
    const result = dialog.querySelector('.onboarding-preview-result')
    if (!result) return
    const inline = draft.layout === 'inline' || (draft.layout === 'automatic' && previewWidth === 'narrow')
    const summary = `${scheme === 'dark' ? 'Dark' : 'Light'} theme · ${inline ? 'Inline diff' : 'Side-by-side diff'}`
    if (result.textContent !== summary) result.textContent = summary
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-preview-width]')) {
      button.setAttribute('aria-pressed', String(button.dataset.previewWidth === previewWidth))
    }
  }

  function render() {
    dialog.dataset.step = step
    if (step === 'intro') {
      dialog.innerHTML = introMarkup()
    } else {
      const content = contentFor(step, draft, options.inWorkspace, options.isGitRepository)
      dialog.innerHTML = `<div class="onboarding-card">
        <div class="onboarding-masthead">
          <span class="onboarding-brand"><img src="${appIcon}" alt="" width="26" height="26"> Diffpane</span>
          ${progressMarkup(steps.indexOf(step))}
        </div>
        <div class="onboarding-scroll">
          <div class="onboarding-stage">
            <div class="onboarding-copy">
              <header class="onboarding-step-heading">
                ${step === 'ready' ? '<span class="onboarding-ready-mark" aria-hidden="true"></span>' : ''}
                <h1 id="onboarding-setup-title" tabindex="-1">${content.title}</h1>
                <p>${content.subtitle}</p>
              </header>
              ${content.body}
            </div>
            ${content.preview}
          </div>
        </div>
        <footer class="onboarding-footer">
          <p class="onboarding-setup-error" role="alert" hidden></p>
          <div class="onboarding-actions">
            ${step === 'welcome' ? '' : '<button class="onboarding-back" type="button" data-action="back"><span aria-hidden="true">←</span> Back</button>'}
            <div class="onboarding-forward">${content.actions}</div>
          </div>
        </footer>
      </div>`
      paintPreview()
      if (step === 'ready') {
        const isMac = /Mac/i.test(navigator.platform)
        for (const { action } of shortcuts(Boolean(options.isGitRepository))) {
          const key = requireElement(dialog, `[data-shortcut="${action}"]`, HTMLElement)
          key.textContent = options.shortcutLabel?.(action) ?? bindingLabel(effectiveBinding(action, {}, isMac), isMac)
        }
      }
    }
    const dragRegion = document.createElement('div')
    dragRegion.className = 'onboarding-drag-region'
    dragRegion.setAttribute('data-tauri-drag-region', '')
    dragRegion.setAttribute('aria-hidden', 'true')
    dialog.append(dragRegion)
    if (dialog.open) requireElement(dialog, '#onboarding-setup-title', HTMLElement).focus({ preventScroll: true })
  }

  function goTo(next: OnboardingStep) {
    if (closed) return
    step = next
    render()
    options.onStep(step, { ...draft })
  }

  async function exitIntro() {
    if (leavingIntro || step !== 'intro') return
    leavingIntro = true
    clearTimeout(introTimer)
    dialog.dataset.introLeaving = ''
    const intro = requireElement(dialog, '.onboarding-intro', HTMLElement)
    await Promise.allSettled(intro.getAnimations().map(animation => animation.finished))
    delete dialog.dataset.introLeaving
    goTo('welcome')
  }

  function move(direction: -1 | 1) {
    if (step === 'intro') {
      runTask('Leave the onboarding intro', exitIntro)
      return
    }
    const next = steps[steps.indexOf(step) + direction]
    if (next && next !== 'intro') goTo(next)
  }

  function close() {
    if (closed) return
    closed = true
    clearTimeout(introTimer)
    system.removeEventListener('change', paintPreview)
    dialog.close()
    dialog.remove()
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    options.onClosed?.()
  }

  async function finish(tour: boolean, button: HTMLButtonElement, saveAppearance = true) {
    if (finishing) return
    finishing = true
    const error = requireElement(dialog, '.onboarding-setup-error', HTMLElement)
    const buttons = dialog.querySelectorAll('button')
    const appearance = saveAppearance ? { ...draft } : {}
    error.hidden = true
    dialog.setAttribute('aria-busy', 'true')
    for (const action of buttons) action.disabled = true
    try {
      await options.onFinish({ tour, appearance })
    } catch {
      if (closed) return
      error.textContent = 'Setup couldn’t be saved. Try again.'
      error.hidden = false
      dialog.removeAttribute('aria-busy')
      for (const action of buttons) action.disabled = false
      button.focus()
      finishing = false
      return
    }
    if (closed) return
    dialog.dataset.closing = ''
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished))
    close()
  }

  dialog.addEventListener('click', event => {
    if (!(event.target instanceof Element) || finishing) return
    const button = event.target.closest<HTMLButtonElement>('button')
    if (!button) return
    const width = button.dataset.previewWidth
    if (width === 'wide' || width === 'narrow') {
      previewWidth = width
      paintPreview()
      return
    }
    switch (button.dataset.action) {
      case 'next':
        move(1)
        break
      case 'back':
        move(-1)
        break
      case 'skip':
        runTask('Skip setup', () => finish(false, button, false))
        break
      case 'finish':
        runTask('Finish setup', () => finish(false, button))
        break
      case 'tour':
        runTask('Finish setup and start the tour', () => finish(true, button))
        break
      case undefined:
      default:
        break
    }
  })

  dialog.addEventListener('change', event => {
    const { target } = event
    if (!(target instanceof HTMLInputElement) || !target.checked) return
    const { name, value } = target
    const theme = themeChoices.find(choice => choice.value === value)
    const layout = layoutChoices.find(choice => choice.value === value)
    if (name === 'theme' && theme) draft.theme = theme.value
    if (name === 'layout' && layout) draft.layout = layout.value
    paintPreview()
    options.onStep(step, { ...draft })
  })

  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    if (!finishing) move(-1)
  })

  render()
  system.addEventListener('change', paintPreview)
  document.body.append(dialog)
  dialog.showModal()
  requireElement(dialog, '#onboarding-setup-title', HTMLElement).focus({ preventScroll: true })
  if (step === 'intro') {
    if (reducedMotion.matches) goTo('welcome')
    else introTimer = setTimeout(() => runTask('Leave the onboarding intro', exitIntro), introHold)
  }
  return { close }
}
