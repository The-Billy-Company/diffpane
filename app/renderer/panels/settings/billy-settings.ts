// Copyright (c) 2026 The Billy Company
import type { BillySetupAction, BillySetupStartResult, BillySetupStatus } from '../../../shared/billy/setup.ts'
import { billySetupActions } from '../../../shared/billy/setup.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { drawReadinessMark } from '../art/settings.ts'
import './billy-settings.css'

interface BillySetupApi {
  status(): Promise<BillySetupStatus>
  run(action: BillySetupAction): Promise<BillySetupStartResult>
}

const stateLabels = {
  ready: 'Passed',
  attention: 'Needs attention',
  unavailable: 'Unavailable',
}
const checkPrompt = 'Check onboarding, required tools, and local configuration.'

export function createBillySettings(api: BillySetupApi, showTerminal: () => void) {
  const page = document.createElement('section')
  page.className = 'settings-page billy-settings'
  page.id = 'settings-billy'
  page.hidden = true
  page.setAttribute('aria-labelledby', 'settings-billy-title')
  page.innerHTML = `
    <header class="appearance-header">
      <div>
        <h2 id="settings-billy-title">Billy Company Diff</h2>
        <p>Manage account access and local development setup.</p>
      </div>
    </header>
    <div class="billy-settings-content">
      <section class="billy-readiness" aria-labelledby="billy-readiness-title">
        <div class="billy-readiness-header">
          <div class="billy-readiness-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"></svg>
          </div>
          <div class="billy-readiness-text">
            <h3 id="billy-readiness-title">Workspace readiness</h3>
            <p role="status" aria-atomic="true" class="billy-readiness-summary"></p>
          </div>
          <button type="button" class="settings-button billy-readiness-button">Run status check</button>
        </div>
        <ul class="billy-checks" aria-label="Readiness results" hidden></ul>
      </section>
      <section class="billy-action-group" aria-labelledby="billy-accounts-title">
        <h3 id="billy-accounts-title">Accounts</h3>
        <ul class="billy-actions" data-group="accounts"></ul>
      </section>
      <section class="billy-action-group" aria-labelledby="billy-maintenance-title">
        <h3 id="billy-maintenance-title">Maintenance</h3>
        <ul class="billy-actions" data-group="maintenance"></ul>
      </section>
      <span id="billy-terminal-note" class="settings-visually-hidden">Opens in the terminal.</span>
    </div>`

  const content = requireElement(page, '.billy-settings-content', HTMLDivElement)
  drawReadinessMark(requireElement(page, '.billy-readiness-mark svg', SVGSVGElement))
  const checkButton = requireElement(page, '.billy-readiness-button', HTMLButtonElement)
  const summary = requireElement(page, '.billy-readiness-summary', HTMLParagraphElement)
  const results = requireElement(page, '.billy-checks', HTMLUListElement)
  const buttons = [checkButton]
  const feedback: HTMLParagraphElement[] = []
  let root: string | null = null
  let version = 0
  let pending: 'check' | 'action' | null = null

  function refreshControls() {
    for (const button of buttons) {
      button.disabled = root === null
      if (pending) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
    }
    checkButton.textContent = pending === 'check' ? 'Checking…' : 'Run status check'
  }

  function setSummary(message: string, tone?: 'ready' | 'attention') {
    summary.textContent = message
    if (tone) summary.dataset.tone = tone
    else delete summary.dataset.tone
  }

  function resetResults() {
    results.replaceChildren()
    results.hidden = true
  }

  function clearFeedback() {
    for (const message of feedback) {
      message.textContent = ''
      delete message.dataset.tone
    }
  }

  function setWorkspace(nextRoot: string | null) {
    if (root === nextRoot) return
    root = nextRoot
    version++
    pending = null
    content.scrollTop = 0
    resetResults()
    clearFeedback()
    setSummary(root ? checkPrompt : 'Open a Billy checkout to use these controls.')
    refreshControls()
  }

  function showChecks({ checks }: BillySetupStatus) {
    const ready = checks.filter(check => check.state === 'ready').length
    const allReady = checks.length > 0 && ready === checks.length
    setSummary(
      checks.length ? `${ready} of ${checks.length} checks passed.` : 'The status check returned no results.',
      allReady ? 'ready' : 'attention',
    )
    results.replaceChildren(
      ...checks.map(check => {
        const row = document.createElement('li')
        row.innerHTML = `
          <div><strong></strong><p></p></div>
          <span class="billy-check-state"></span>`
        requireElement(row, 'strong', HTMLElement).textContent = check.label
        requireElement(row, 'p', HTMLParagraphElement).textContent = check.detail
        const state = requireElement(row, '.billy-check-state', HTMLSpanElement)
        state.dataset.state = check.state
        state.textContent = stateLabels[check.state]
        return row
      }),
    )
    results.hidden = checks.length === 0
  }

  async function checkStatus() {
    if (!root || pending) return
    const current = version
    pending = 'check'
    setSummary('Checking local development setup…')
    resetResults()
    clearFeedback()
    refreshControls()
    try {
      const status = await api.status()
      if (current === version) showChecks(status)
    } catch {
      if (current === version) setSummary('The status check could not finish. Try again.', 'attention')
    } finally {
      if (current === version) {
        pending = null
        refreshControls()
      }
    }
  }

  async function runAction(action: BillySetupAction, message: HTMLParagraphElement) {
    if (!root || pending) return
    const current = version
    pending = 'action'
    clearFeedback()
    message.textContent = 'Opening terminal…'
    refreshControls()
    try {
      const result = await api.run(action)
      if (current !== version) return
      if (result.ok) {
        message.textContent = ''
        if (action === 'repair-env') {
          resetResults()
          setSummary(checkPrompt)
        }
        showTerminal()
      } else {
        message.dataset.tone = 'attention'
        message.textContent = result.message
      }
    } catch (cause) {
      if (current === version) {
        message.dataset.tone = 'attention'
        message.textContent = appError(cause, { message: 'The terminal could not start this command.' }).message
      }
    } finally {
      if (current === version) {
        pending = null
        refreshControls()
      }
    }
  }

  for (const action of billySetupActions) {
    const group = requireElement(page, `[data-group="${action.group}"]`, HTMLUListElement)
    const row = document.createElement('li')
    row.innerHTML = `
      <div>
        <strong></strong>
        <p class="billy-action-description"></p>
        <p class="billy-action-feedback" role="status" aria-atomic="true"></p>
      </div>
      <button type="button" class="settings-button billy-action-button">
        <span></span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m3.5 4.5 3.25 3.25L3.5 11m4.5 0h4.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>`
    requireElement(row, 'strong', HTMLElement).textContent = action.label
    const description = requireElement(row, '.billy-action-description', HTMLParagraphElement)
    description.id = `billy-action-${action.id}`
    description.textContent = action.description
    const message = requireElement(row, '.billy-action-feedback', HTMLParagraphElement)
    const button = requireElement(row, 'button', HTMLButtonElement)
    requireElement(button, 'span', HTMLSpanElement).textContent = action.buttonLabel
    if (action.buttonLabel === 'Sign in') button.setAttribute('aria-label', `Sign in to ${action.label}`)
    button.setAttribute('aria-describedby', `${description.id} billy-terminal-note`)
    button.addEventListener('click', event => {
      if (event.isTrusted) runTask(action.label, () => runAction(action.id, message))
    })
    buttons.push(button)
    feedback.push(message)
    group.append(row)
  }

  checkButton.addEventListener('click', event => {
    if (event.isTrusted) runTask('Check Billy workspace readiness', checkStatus)
  })
  setSummary('Open a Billy checkout to use these controls.')
  refreshControls()
  return { page, setWorkspace }
}
