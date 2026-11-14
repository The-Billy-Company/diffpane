import type { BillyLaneChecks, BillyLaneLog, BillyLanePage } from '../../../electron/tools/billy-lanes/lanes.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import './lanes.css'

interface ChangePath {
  readonly path: string
  readonly originalPath?: string | null
}

interface Options {
  listLanes: () => Promise<BillyLanePage>
  readLaneChecks: (slug: string) => Promise<BillyLaneChecks>
  readLaneLog?: (slug: string, check: string, capture: string) => Promise<BillyLaneLog>
  onChange: () => void
  onOpen?: (path: string, line?: number) => unknown
}

type Checks = BillyLaneChecks | { readonly kind: 'loading' | 'unavailable' }

const ALL = ''
const UNRECORDED = 'unrecorded'
const laneKey = (slug: string) => `lane:${slug}`
const emptyPage: BillyLanePage = { rows: [], truncated: false }

export function indexLanePaths(page: BillyLanePage) {
  const byPath = new Map<string, string[]>()
  for (const lane of page.rows) {
    for (const path of new Set(lane.recorded)) {
      const slugs = byPath.get(path)
      if (slugs) slugs.push(lane.slug)
      else byPath.set(path, [lane.slug])
    }
  }
  return ({ path, originalPath }: ChangePath): readonly string[] => {
    const current = byPath.get(path) ?? []
    const original = originalPath && byPath.get(originalPath)
    return original ? [...new Set([...current, ...original])] : current
  }
}

export function createBillyLanes(
  host: HTMLElement,
  { listLanes, readLaneChecks, readLaneLog, onChange, onOpen }: Options,
) {
  host.classList.add('billy-lanes')
  host.innerHTML = `
    <div class="billy-lanes-controls">
      <label>Follow <select aria-label="Follow agent lane"><option value="">All changes</option></select></label>
      <button class="billy-lanes-refresh" type="button" aria-label="Refresh agent lanes" title="Refresh agent lanes">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 4v4H9M3 12V8h4m6-.8A5 5 0 0 0 4.5 4.4M3 8.8a5 5 0 0 0 8.5 2.8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <p class="billy-lanes-status" role="status" hidden></p>
    <details class="billy-lanes-checks" hidden>
      <summary></summary>
      <div class="billy-lanes-evidence"></div>
    </details>`
  const select = requireElement(host, 'select', HTMLSelectElement)
  const refreshButton = requireElement(host, 'button', HTMLButtonElement)
  const statusLine = requireElement(host, '.billy-lanes-status', HTMLParagraphElement)
  const details = requireElement(host, 'details', HTMLDetailsElement)
  const summary = requireElement(details, 'summary', HTMLElement)
  const evidence = requireElement(details, '.billy-lanes-evidence', HTMLDivElement)

  let page: BillyLanePage | undefined
  let lanesFor = indexLanePaths(emptyPage)
  let paths: readonly ChangePath[] = []
  let selection = ALL
  let checks: Checks = { kind: 'missing' }
  let request = 0
  let refreshing = false
  let failed = false
  let disposed = false

  function includes(path: ChangePath) {
    if (selection === ALL) return true
    const lanes = lanesFor(path)
    return selection === UNRECORDED ? lanes.length === 0 : lanes.some(slug => laneKey(slug) === selection)
  }

  function status(path: ChangePath): 'shared' | 'unrecorded' | null {
    if (!page?.rows.length) return null
    const lanes = lanesFor(path)
    if (lanes.length > 1) return 'shared'
    return lanes.length === 0 ? 'unrecorded' : null
  }

  function renderStatus() {
    const visible = paths.filter(includes)
    const shared = visible.filter(path => status(path) === 'shared').length
    const unrecorded = visible.filter(path => status(path) === 'unrecorded').length
    const counts = [shared ? `${shared} shared` : '', unrecorded ? `${unrecorded} unrecorded` : ''].filter(Boolean)
    const label = failed
      ? 'Couldn’t refresh agent lanes.'
      : page?.truncated
        ? 'Only recent lanes are shown.'
        : page?.rows.length === 0
          ? 'No agent lanes recorded.'
          : selection !== ALL && visible.length === 0
            ? 'No changes match this lane.'
            : counts.join(' · ')
    statusLine.hidden = !label
    if (statusLine.textContent !== label) statusLine.textContent = label
  }

  function renderChoices() {
    const choices = [new Option('All changes', ALL)]
    if (page?.rows.length) {
      for (const lane of page.rows)
        choices.push(new Option(lane.current ? `Current · ${lane.slug}` : lane.slug, laneKey(lane.slug)))
      choices.push(new Option('Unrecorded changes', UNRECORDED))
    }
    if (!choices.some(choice => choice.value === selection)) selection = ALL
    select.replaceChildren(...choices)
    select.value = selection
    select.disabled = choices.length === 1
    renderStatus()
  }

  function appendRetainedLogs(capture: string, failedChecks: readonly string[]) {
    if (!readLaneLog || !failedChecks.length || !selection.startsWith('lane:')) return
    const read = readLaneLog
    const slug = selection.slice('lane:'.length)
    const logDetails = document.createElement('details')
    logDetails.className = 'billy-lanes-logs'
    const title = document.createElement('summary')
    title.textContent = 'Retained logs'
    const check = document.createElement('select')
    check.setAttribute('aria-label', 'Failed check')
    check.append(...failedChecks.map(id => new Option(id, id)))
    const logStatus = document.createElement('p')
    logStatus.setAttribute('role', 'status')
    const output = document.createElement('pre')
    output.hidden = true
    output.tabIndex = 0
    output.setAttribute('aria-label', 'Retained log text')
    logDetails.append(title, check, logStatus, output)
    evidence.append(logDetails)
    let logRequest = 0
    let loaded = false
    async function showLog() {
      const version = ++logRequest
      loaded = true
      output.hidden = true
      logStatus.textContent = 'Reading retained log…'
      try {
        const result = await read(slug, check.value, capture)
        if (version !== logRequest || !logDetails.isConnected) return
        output.textContent = result.text
        output.hidden = !result.text
        if (result.complete) logStatus.textContent = result.text ? 'Complete saved log' : 'The saved log is empty.'
        else if (!result.readBytes) logStatus.textContent = 'Retained log is unavailable.'
        else
          logStatus.textContent =
            result.totalBytes === undefined
              ? `Partial log · ${result.readBytes.toLocaleString()} bytes`
              : `Log tail · ${result.readBytes.toLocaleString()} of ${result.totalBytes.toLocaleString()} bytes`
      } catch {
        if (version !== logRequest || !logDetails.isConnected) return
        loaded = false
        logStatus.textContent = 'Log unavailable. Refresh this lane and reopen the log.'
      }
    }
    logDetails.addEventListener('toggle', () => {
      if (logDetails.open && !loaded) runTask('Read retained check log', showLog)
    })
    check.addEventListener('change', () => runTask('Read retained check log', showLog))
  }

  function renderChecks() {
    details.hidden = selection === ALL || selection === UNRECORDED
    evidence.replaceChildren()
    if (details.hidden) return
    details.dataset.state = checks.kind === 'saved' ? (checks.conclusive ? 'saved' : 'incomplete') : checks.kind
    switch (checks.kind) {
      case 'loading':
        summary.textContent = 'Reading saved checks…'
        break
      case 'missing':
        summary.textContent = 'No saved checks'
        break
      case 'unavailable':
        summary.textContent = 'Saved checks unavailable'
        break
      case 'saved': {
        const { capture, capturedAt, conclusive, counts, failedChecks, findings, findingsComplete, findingsTotal } =
          checks
        summary.textContent = conclusive ? 'Saved checks' : 'Saved checks incomplete'
        if (counts.failed) summary.textContent += ` · ${counts.failed} failed`
        const info = document.createElement('p')
        const outcome = [
          `${counts.passed} passed`,
          `${counts.failed} failed`,
          counts.advisory ? `${counts.advisory} advisory failures` : '',
          counts.skipped ? `${counts.skipped} skipped` : '',
        ]
          .filter(Boolean)
          .join(' · ')
        const captured =
          capturedAt === undefined
            ? 'Capture time unavailable'
            : new Date(capturedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        info.textContent = `${captured} · ${outcome}`
        const freshness = document.createElement('p')
        freshness.textContent = 'Current edit coverage is unknown.'
        evidence.append(info, freshness)
        appendRetainedLogs(capture, failedChecks)
        if (findings.length) {
          const items = document.createElement('ul')
          for (const finding of findings) {
            const item = document.createElement('li')
            const { line, path } = finding
            if (path && onOpen) {
              const link = document.createElement('button')
              link.type = 'button'
              link.textContent = line ? `${path}:${line}` : path
              link.addEventListener('click', () => runTask('Open saved check finding', () => onOpen(path, line)))
              item.append(link)
            }
            const message = document.createElement('p')
            message.textContent = `${finding.check} · ${finding.message}`
            item.append(message)
            if (onOpen && finding.rules.length) {
              const rules = document.createElement('div')
              rules.className = 'billy-lanes-rules'
              for (const rule of finding.rules) {
                const button = document.createElement('button')
                button.type = 'button'
                button.textContent = rule.id
                button.title = 'Open rulebook entry'
                button.addEventListener('click', () =>
                  runTask('Open rulebook entry', () => onOpen(rule.path, rule.line)),
                )
                rules.append(button)
              }
              item.append(rules)
            }
            items.append(item)
          }
          evidence.append(items)
        }
        if ((counts.failed || counts.advisory) && !findingsComplete) {
          const coverage = document.createElement('p')
          coverage.textContent = findingsTotal
            ? `Showing ${findings.length} of ${findingsTotal} saved findings.`
            : 'Finding coverage is unavailable.'
          evidence.append(coverage)
        }
        break
      }
    }
    if (checks.kind !== 'saved') {
      const message = document.createElement('p')
      message.textContent =
        checks.kind === 'loading'
          ? 'Reading the lane’s retained Igor run.'
          : checks.kind === 'missing'
            ? 'Igor has no retained run for this lane.'
            : 'Refresh once Igor has finished writing this run.'
      evidence.append(message)
    }
  }

  async function refreshChecks() {
    const lane = page?.rows.find(row => laneKey(row.slug) === selection)
    const version = ++request
    checks = { kind: lane ? 'loading' : 'missing' }
    renderChecks()
    if (!lane) return
    let next: Checks
    try {
      next = await readLaneChecks(lane.slug)
    } catch {
      next = { kind: 'unavailable' }
    }
    if (disposed || version !== request) return
    checks = next
    renderChecks()
  }

  async function refresh() {
    if (refreshing || disposed) return
    refreshing = true
    refreshButton.disabled = true
    try {
      page = await listLanes()
      if (disposed) return
      lanesFor = indexLanePaths(page)
      failed = false
    } catch {
      if (disposed) return
      failed = true
    } finally {
      refreshing = false
      refreshButton.disabled = false
    }
    renderChoices()
    onChange()
    await refreshChecks()
  }

  select.addEventListener('change', () => {
    selection = select.value
    details.open = false
    renderStatus()
    onChange()
    runTask('Read saved agent checks', refreshChecks)
  })
  refreshButton.addEventListener('click', () => runTask('Refresh agent lanes', refresh))
  renderChoices()

  return {
    includes,
    status,
    refresh,
    setPaths(files: readonly ChangePath[]) {
      paths = files
      renderStatus()
    },
    dispose() {
      disposed = true
      host.replaceChildren()
    },
  }
}
