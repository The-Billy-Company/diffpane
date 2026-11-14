import type { BillyPlaybook, BillyReplayApi, BillyReplayCase, BillyReplayRun } from '../../../shared/billy/replay.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createBillyStatusArt } from '../billy/status-art.ts'
import { compareReplayCases } from './comparison.ts'
import { element, turnDetail } from './detail.ts'
import './billy-replay.css'

interface ReplayOptions {
  onSource: (path: string, line?: number) => unknown
  onClose?: () => void
}

type Side = 'baseline' | 'candidate'
const sides: Side[] = ['baseline', 'candidate']
const label = (side: Side) => (side === 'baseline' ? 'Baseline' : 'Candidate')

function message(error: unknown) {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
    : 'Replay evidence could not be opened.'
}

export function createBillyReplay(container: HTMLElement, api: BillyReplayApi, options: ReplayOptions) {
  container.classList.add('billy-replay')
  container.hidden = true
  container.innerHTML = `
    <div class="billy-replay-playbook" hidden></div>
    <div class="billy-replay-pair billy-replay-picker" role="group" aria-label="Retained Replay runs">
      <button type="button" data-run="baseline" aria-label="Choose baseline run.json"></button>
      <button type="button" data-run="candidate" aria-label="Choose candidate run.json"></button>
    </div>
    <label class="billy-replay-field" hidden>Scenario<select data-scenario></select></label>
    <p class="billy-replay-status" role="status" aria-atomic="true"></p>
    <div class="billy-replay-results" hidden>
      <div class="billy-replay-result-heading">
        <p class="billy-replay-observation"></p>
        <label class="billy-replay-field">Turn<select data-turn></select></label>
      </div>
      <div class="billy-replay-pair billy-replay-evidence"></div>
    </div>`
  const context = requireElement(container, '.billy-replay-playbook', HTMLDivElement)
  const scenarioPicker = requireElement(container, '[data-scenario]', HTMLSelectElement)
  const turnPicker = requireElement(container, '[data-turn]', HTMLSelectElement)
  const scenarioField = requireElement(container, '.billy-replay-field', HTMLLabelElement)
  const status = requireElement(container, '.billy-replay-status', HTMLParagraphElement)
  const results = requireElement(container, '.billy-replay-results', HTMLDivElement)
  const observations = requireElement(container, '.billy-replay-observation', HTMLParagraphElement)
  const evidence = requireElement(container, '.billy-replay-evidence', HTMLDivElement)
  const buttons = sides.map(side => requireElement(container, `[data-run="${side}"]`, HTMLButtonElement))
  const runs: Partial<Record<Side, BillyReplayRun>> = {}
  let path: string | null | undefined
  let playbook: BillyPlaybook | null = null
  let sourceRequest = 0
  let caseRequest = 0
  let picking = false
  let disposed = false
  let cases: [BillyReplayCase, BillyReplayCase] | null = null

  function drawRunPickerArt() {
    for (const button of buttons) {
      if (!button.querySelector('.billy-status-art')) button.prepend(createBillyStatusArt('run'))
    }
  }

  function runButtons() {
    buttons.forEach((button, index) => {
      const side = sides[index]
      if (!side) return
      const run = runs[side]
      button.disabled = picking
      const art = button.querySelector('.billy-status-art')
      button.replaceChildren(
        ...(art ? [art] : []),
        element('strong', '', label(side)),
        element(
          'span',
          'billy-replay-muted',
          run
            ? [run.build, run.commit ? run.commit.slice(0, 10) : 'Revision unavailable', run.mode]
                .filter(Boolean)
                .join(' · ')
            : 'Open run.json…',
        ),
      )
      if (run)
        button.title = `${[run.build, run.commit, run.mode].filter(Boolean).join(' · ')} • Choose a different run`
      else button.removeAttribute('title')
    })
  }

  async function jumpToRegistry(filename: string) {
    try {
      const opened = await options.onSource(filename)
      if (!disposed && opened === false) status.textContent = 'The playbook registry could not be opened.'
    } catch (error) {
      if (!disposed) status.textContent = message(error)
    }
  }

  function renderPlaybook() {
    context.replaceChildren()
    context.hidden = !playbook
    if (!playbook) return
    const declared = playbook
    const name = element('strong', '', declared.title)
    const details = element('details', 'billy-replay-detail')
    details.append(
      element('summary', '', declared.owningEval ? `Declared route · ${declared.owningEval}` : 'Declared route'),
    )
    if (declared.trigger) details.append(element('p', '', declared.trigger))
    for (const route of declared.routes) {
      details.append(element('p', 'billy-replay-route', `${route.kind} · ${route.values.join(', ')}`))
    }
    const registry = element('button', 'billy-replay-source', 'Open current playbook registry')
    registry.type = 'button'
    registry.addEventListener('click', () => void jumpToRegistry(declared.registry))
    details.append(registry)
    context.append(name, details)
  }

  function renderTurn() {
    if (!cases) return
    const index = Number(turnPicker.value) - 1
    const [baseline, candidate] = cases
    evidence.replaceChildren(
      turnDetail('Baseline', baseline.turns[index], playbook?.id ?? null),
      turnDetail('Candidate', candidate.turns[index], playbook?.id ?? null),
    )
  }

  function showCases(baseline: BillyReplayCase, candidate: BillyReplayCase) {
    cases = [baseline, candidate]
    const difference = compareReplayCases(baseline, candidate)
    results.hidden = false
    const outcome = difference
      ? `Turn ${difference.turn} · ${difference.observations.join(' · ')}`
      : 'No difference in the comparable observations.'
    observations.replaceChildren(
      element('strong', '', difference ? 'First observed divergence' : 'Comparison'),
      element('span', '', outcome),
    )
    if (baseline.user && candidate.user && baseline.user !== candidate.user) {
      observations.append(element('span', 'billy-replay-muted', 'The runs used different user fixtures.'))
    }
    const judgments = cases.map((value, index) => {
      const side = sides[index]
      if (!side) return ''
      const issues = value.error?.preview ? ' · saved with an error' : ''
      return `${label(side)} · ${value.verdict ?? 'Verdict unavailable'}${issues}`
    })
    observations.append(element('span', 'billy-replay-muted', judgments.join(' / ')))
    const longest = Math.max(baseline.turns.length, candidate.turns.length)
    turnPicker.replaceChildren(...Array.from({ length: longest }, (_, index) => new Option(String(index + 1))))
    turnPicker.value = String(difference?.turn ?? 1)
    turnPicker.disabled = longest === 0
    renderTurn()
  }

  async function selectCases() {
    const request = ++caseRequest
    const scenario = scenarioPicker.value
    const baseline = runs.baseline
    const candidate = runs.candidate
    cases = null
    evidence.replaceChildren()
    results.hidden = true
    if (!scenario || !baseline || !candidate) return
    status.textContent = 'Reading saved scenario…'
    try {
      const [a, b] = await Promise.all([api.readCase(baseline.id, scenario), api.readCase(candidate.id, scenario)])
      if (disposed || request !== caseRequest) return
      status.textContent = ''
      showCases(a, b)
    } catch (error) {
      if (!disposed && request === caseRequest) status.textContent = message(error)
    }
  }

  async function pick(side: Side) {
    if (picking) return
    picking = true
    runButtons()
    try {
      const run = await api.pickRun()
      if (disposed || !run) return
      runs[side] = run
      const previous = scenarioPicker.value
      const available = new Set(runs.candidate?.scenarios)
      const scenarios = runs.baseline?.scenarios.filter(scenario => available.has(scenario)) ?? []
      scenarioPicker.replaceChildren(...scenarios.map(scenario => new Option(scenario)))
      if (scenarios.includes(previous)) scenarioPicker.value = previous
      scenarioField.hidden = !scenarios.length
      status.textContent = scenarios.length
        ? ''
        : runs.baseline && runs.candidate
          ? 'These runs share no scenario IDs.'
          : 'Choose the other run to compare matching scenarios.'
      await selectCases()
    } catch (error) {
      if (!disposed) status.textContent = message(error)
    } finally {
      picking = false
      if (!disposed) runButtons()
    }
  }

  function setPath(next: string | null) {
    if (next === path) return
    path = next
    const request = ++sourceRequest
    playbook = null
    renderPlaybook()
    renderTurn()
    if (next?.endsWith('.j2')) loadPlaybook(next, request).catch((error: unknown) => showPlaybookError(error, request))
  }

  async function loadPlaybook(source: string, request: number) {
    const value = await api.playbook(source)
    if (disposed || request !== sourceRequest) return
    playbook = value
    renderPlaybook()
    renderTurn()
  }

  function showPlaybookError(error: unknown, request: number) {
    if (disposed || request !== sourceRequest) return
    context.hidden = false
    context.replaceChildren(element('p', 'billy-replay-muted', message(error)))
  }

  const abort = new AbortController()
  const listener = { signal: abort.signal }
  for (const [index, button] of buttons.entries()) {
    const side = sides[index]
    if (side) button.addEventListener('click', () => void pick(side), listener)
  }
  scenarioPicker.addEventListener('change', () => void selectCases(), listener)
  turnPicker.addEventListener('change', renderTurn, listener)
  if (options.onClose) {
    const onClose = options.onClose
    container.addEventListener(
      'keydown',
      event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.target instanceof HTMLSelectElement) return
        event.preventDefault()
        onClose()
      },
      listener,
    )
  }
  runButtons()
  return {
    open(next?: string | null) {
      if (disposed) return
      container.hidden = false
      drawRunPickerArt()
      if (next !== undefined) setPath(next)
    },
    setPath,
    close() {
      container.hidden = true
    },
    dispose() {
      disposed = true
      abort.abort()
      cases = null
      delete runs.baseline
      delete runs.candidate
      container.replaceChildren()
      container.hidden = true
    },
  }
}
