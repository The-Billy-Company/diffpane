import type { GitChanges, GitCommit, GitComparison, GitFile, GitOverview } from '../../../shared/review/git.ts'
import { projectIcon } from '../../shell/layout/icons.ts'
import { runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { layoutCommitGraph, renderCommitGraphRow } from './commit-graph.ts'
import './git-workspace.css'
import './git-inspector.css'
import './git-activity.css'

interface Options {
  loadOverview: (dayStartMs: number, dayEndMs: number, historyLimit: number) => Promise<GitOverview>
  loadChanges: (comparison: GitComparison) => Promise<GitChanges>
  openFile: (options: {
    host: HTMLElement
    comparison: GitComparison
    file: GitFile
    baseLabel: string
    targetLabel: string
    focus: boolean
  }) => { dispose: () => void; refresh: () => void }
  openReview: () => void
}

type View = 'today' | 'history'
type Selection = { kind: 'working' | 'day' } | { kind: 'commit'; id: string }
type WorkingMode = Extract<GitComparison, { kind: 'working' }>['mode']
interface ComparisonDetails {
  comparison: GitComparison
  baseLabel: string
  targetLabel: string
  title: string
  commit?: GitCommit
}

const WORKING_MODES = {
  head: ['HEAD', 'Working tree'],
  staged: ['HEAD', 'Index (staged)'],
  unstaged: ['Index', 'Working tree (unstaged)'],
} satisfies Record<WorkingMode, [string, string]>
const comparisonModes = ['head', 'staged', 'unstaged'] as const satisfies readonly WorkingMode[]
const PAGE_SIZE = 100
const MAX_HISTORY = 1000
const DISPLAY_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const DISPLAY_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DISPLAY_HOUR = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' })
const STATUS: Readonly<Record<string, string>> = {
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Modified',
  R: 'Renamed',
  S: 'Submodule',
  T: 'Type changed',
  U: 'Unresolved conflict',
  '?': 'Untracked',
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function button(className: string, text?: string) {
  const control = element('button', className, text)
  control.type = 'button'
  return control
}

function setDiffFocus(control: HTMLButtonElement, expanded: boolean) {
  control.setAttribute('aria-pressed', String(expanded))
  control.title = expanded ? 'Restore Git layout' : 'Focus diff'
}

function dayBounds() {
  const today = new Date()
  const [year, month, day] = [today.getFullYear(), today.getMonth(), today.getDate()]
  return { start: +new Date(year, month, day), end: +new Date(year, month, day + 1) }
}

const shortId = (id: string) => id.slice(0, 8)
const printNumber = (value: number) => value.toLocaleString()
const linesLabel = (additions: number, deletions: number) =>
  `${printNumber(additions)} lines added, ${printNumber(deletions)} lines removed`

function counts(additions: number, deletions: number) {
  const added = element('span', additions ? 'git-lines-added' : 'git-lines-zero', `+${printNumber(additions)}`)
  const removed = element('span', deletions ? 'git-lines-removed' : 'git-lines-zero', `−${printNumber(deletions)}`)
  return [added, removed]
}

const lineCount = (file: GitFile) => (file.additions ?? 0) + (file.deletions ?? 0)

function fileRow(file: GitFile, maximum: number) {
  const status = STATUS[file.status] ?? file.status
  const separator = file.path.lastIndexOf('/')
  const name = file.path.slice(separator + 1)
  const directory = separator === -1 ? '' : file.path.slice(0, separator)
  const known = file.additions !== null && file.deletions !== null
  const row = button('git-file-row')
  row.dataset.gitFile = file.path
  row.setAttribute(
    'aria-label',
    `${file.path}, ${status}, ${known ? linesLabel(file.additions ?? 0, file.deletions ?? 0) : 'line counts unavailable'}`,
  )
  row.title = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
  const symbol = projectIcon({ name, kind: 'file' })
  const identifier = element('span', 'git-file-identity')
  if (symbol) {
    const icon = element('img', 'git-file-icon')
    icon.alt = ''
    icon.src = symbol
    identifier.append(icon)
  }
  const detail = element('span', 'git-file-description')
  const location = element('span', 'git-file-location')
  if (directory) location.append(element('span', 'git-file-directory', directory))
  if (file.status !== 'M' || !directory) {
    const badge = element('span', 'git-file-status', status)
    badge.dataset.status = file.status
    location.append(badge)
  }
  detail.append(element('strong', 'git-file-name', name), location)
  identifier.append(detail)
  row.append(identifier)
  if (!known) {
    row.append(element('span', 'git-file-no-count', 'No line count'))
    return row
  }

  const chart = element('span', 'git-line-bars')
  chart.setAttribute('aria-hidden', 'true')
  for (const [value, className] of [
    [file.deletions ?? 0, 'git-bar-removed'],
    [file.additions ?? 0, 'git-bar-added'],
  ] as const) {
    const mark = element('span', className)
    mark.style.inlineSize = `${(value / maximum) * 100}%`
    chart.append(mark)
  }
  const total = element('span', 'git-file-totals')
  total.setAttribute('aria-hidden', 'true')
  total.append(...counts(file.additions ?? 0, file.deletions ?? 0))
  row.append(chart, total)
  return row
}

function refPill(ref: { name: string; kind: string }) {
  const chip = element('span', 'git-ref', ref.name)
  chip.dataset.gitRef = ref.name
  chip.dataset.kind = ref.kind
  return chip
}

function commitRow(
  commit: GitCommit,
  head: string | null,
  todayStart: number,
  todayEnd: number,
  rail: SVGSVGElement | null,
) {
  const row = button('git-activity-row')
  row.dataset.gitCommit = commit.id
  row.title = [commit.subject, commit.id, ...commit.refs.map(({ name }) => name)].join('\n')
  const hash = element('span', 'git-hash', shortId(commit.id))
  const primary = element('span', 'git-activity-primary')
  const meta = element('span', 'git-activity-meta')
  meta.append(hash)
  if (commit.id === head) {
    row.dataset.gitHead = ''
    meta.append(refPill({ name: 'HEAD', kind: 'head' }))
  }
  for (const ref of commit.refs) meta.append(refPill(ref))
  if (commit.parents.length > 1 && !commit.refs.length) meta.append(element('span', '', 'Merge'))
  primary.append(element('strong', 'git-activity-subject', commit.subject || '(No commit message)'), meta)
  const formatted =
    commit.committedAt >= todayStart && commit.committedAt < todayEnd
      ? DISPLAY_TIME.format(commit.committedAt)
      : SHORT_DATE.format(commit.committedAt)
  const time = element('time', 'git-activity-time', formatted)
  time.dateTime = new Date(commit.committedAt).toISOString()
  time.title = `${DISPLAY_DATE.format(commit.committedAt)}, ${DISPLAY_TIME.format(commit.committedAt)}`
  if (rail) row.append(rail)
  row.append(primary, time)
  return row
}

function workingRow(rail: SVGSVGElement | null, headOutside: boolean) {
  const row = button('git-activity-row git-working-row')
  row.dataset.gitCommit = 'working'
  if (rail) row.append(rail)
  const primary = element('span', 'git-activity-primary')
  const subtitle = headOutside ? 'HEAD outside loaded history' : 'Uncommitted changes'
  const meta = element('span', 'git-activity-meta', subtitle)
  meta.title = subtitle
  primary.append(element('strong', 'git-activity-subject', 'Working tree'), meta)
  row.append(primary, element('span', 'git-working-status', 'Live'))
  return row
}

function commitTimeline(commits: readonly GitCommit[]) {
  const hours = new Map<number, { count: number; latest: GitCommit }>()
  let peak = 1
  for (const commit of commits) {
    const hour = new Date(commit.committedAt).getHours()
    const previous = hours.get(hour)
    const count = (previous?.count ?? 0) + 1
    const latest = previous && previous.latest.committedAt >= commit.committedAt ? previous.latest : commit
    hours.set(hour, { count, latest })
    peak = Math.max(peak, count)
  }

  const timeline = element('div', 'git-commit-timeline')
  const plot = element('div', 'git-timeline-plot')
  plot.setAttribute('role', 'group')
  plot.setAttribute('aria-label', 'Commits by local hour')
  const ticks = element('div', 'git-timeline-ticks')
  ticks.setAttribute('aria-hidden', 'true')
  for (let hour = 0; hour < 24; hour++) {
    const label = DISPLAY_HOUR.format(Date.UTC(2000, 0, 1, hour))
    if (hour % 6 === 0) ticks.append(element('span', '', label))
    const cell = element('div', 'git-timeline-hour')
    plot.append(cell)
    const entry = hours.get(hour)
    if (!entry) continue
    const bin = button('git-timeline-bin')
    bin.dataset.gitHour = String(hour)
    bin.dataset.gitHourTarget = entry.latest.id
    const count = `${printNumber(entry.count)} ${entry.count === 1 ? 'commit' : 'commits'}`
    bin.title = `${label} · ${count}`
    bin.setAttribute('aria-label', `${label}, ${count}. Go to the latest commit for this hour.`)
    const bar = element('span', 'git-timeline-bar')
    bar.style.setProperty('--git-hour-height', `${(entry.count / peak) * 100}%`)
    bin.append(bar)
    cell.append(bin)
  }
  timeline.append(plot, ticks)
  return timeline
}

function beforeAfter(before: string, after: string) {
  return `${before} → ${after}`
}

function renderMessage(host: HTMLElement, message: string, retry?: () => void) {
  host.hidden = !message
  host.replaceChildren()
  if (!message) return
  host.append(element('span', '', message))
  if (retry) {
    const action = button('git-secondary', 'Retry')
    action.addEventListener('click', retry, { once: true })
    host.append(action)
  }
}

export function createGitWorkspace(root: HTMLElement, { loadOverview, loadChanges, openFile, openReview }: Options) {
  root.hidden = true
  root.classList.add('git-workspace')
  root.setAttribute('aria-label', 'Git workspace')
  root.innerHTML = `
    <header class="git-heading">
      <div class="git-page-identity">
        <h1>Git</h1>
        <div class="git-repository" hidden>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
            <circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/>
            <path d="M4.5 5v6m7-6v.5a3 3 0 0 1-3 3h-4"/>
          </svg>
          <span class="git-repository-scope"></span>
        </div>
      </div>
      <nav class="git-tabs" aria-label="Git view">
        <button type="button" data-git-view="today" aria-pressed="true">Today</button>
        <button type="button" data-git-view="history" aria-pressed="false">History</button>
      </nav>
    </header>
    <div class="git-columns">
      <section class="git-activity" aria-label="Git activity">
        <header class="git-activity-heading"><h2></h2><span></span></header>
        <div class="git-activity-scroll">
          <div class="git-activity-list"></div>
          <div class="git-history-tail" hidden>
            <button type="button" class="git-secondary git-more">Load more commits</button>
            <p class="git-history-limit" hidden>Showing the latest 1,000 commits.</p>
          </div>
          <div class="git-overview-message" role="status" hidden></div>
        </div>
      </section>
      <section class="git-inspector" aria-label="Git change inspector">
        <header class="git-inspector-heading">
          <div class="git-inspector-top">
            <div class="git-inspector-identity"><h2>Working tree</h2><span class="git-inspector-hash git-hash"></span></div>
            <button type="button" class="git-review" aria-label="Review changes">
              Review changes <span aria-hidden="true">→</span>
            </button>
          </div>
          <div class="git-inspector-context">
            <div class="git-comparison">
              <label for="git-comparison-select">Comparison</label>
              <select id="git-comparison-select"></select>
              <span class="git-fixed-comparison" hidden><span></span><span>→</span><span></span></span>
            </div>
            <div class="git-inspector-refs" hidden></div>
          </div>
        </header>
        <div class="git-files-heading">
          <div class="git-files-title"><h3>Changed files</h3><span class="git-file-count" aria-hidden="true"></span></div>
          <div class="git-line-totals" role="status"></div>
        </div>
        <div class="git-file-list" aria-label="Changed files"></div>
        <div class="git-comparison-message" role="status"></div>
        <div class="git-workspace-preview" hidden></div>
      </section>
    </div>
  `
  const repository = requireElement(root, '.git-repository', HTMLDivElement)
  const scope = requireElement(root, '.git-repository-scope', HTMLSpanElement)
  const todayTab = requireElement(root, '[data-git-view="today"]', HTMLButtonElement)
  const historyTab = requireElement(root, '[data-git-view="history"]', HTMLButtonElement)
  const activityHeading = requireElement(root, '.git-activity-heading h2', HTMLHeadingElement)
  const activityScope = requireElement(root, '.git-activity-heading > span', HTMLSpanElement)
  const activity = requireElement(root, '.git-activity-list', HTMLDivElement)
  const activityScroll = requireElement(root, '.git-activity-scroll', HTMLDivElement)
  const historyTail = requireElement(root, '.git-history-tail', HTMLDivElement)
  const historyLimitText = requireElement(root, '.git-history-limit', HTMLParagraphElement)
  const more = requireElement(root, '.git-more', HTMLButtonElement)
  const overviewMessage = requireElement(root, '.git-overview-message', HTMLDivElement)
  const inspectorTitle = requireElement(root, '.git-inspector h2', HTMLHeadingElement)
  const inspectorId = requireElement(root, '.git-inspector-hash', HTMLSpanElement)
  const inspectorRefs = requireElement(root, '.git-inspector-refs', HTMLDivElement)
  const review = requireElement(root, '.git-review', HTMLButtonElement)
  const chooser = requireElement(root, '#git-comparison-select', HTMLSelectElement)
  const chooserLabel = requireElement(root, '.git-comparison label', HTMLLabelElement)
  const fixed = requireElement(root, '.git-fixed-comparison', HTMLSpanElement)
  const fixedBase = requireElement(fixed, 'span:first-child', HTMLSpanElement)
  const fixedTarget = requireElement(fixed, 'span:last-child', HTMLSpanElement)
  const fileCount = requireElement(root, '.git-file-count', HTMLSpanElement)
  const totals = requireElement(root, '.git-line-totals', HTMLDivElement)
  const files = requireElement(root, '.git-file-list', HTMLDivElement)
  const comparisonMessage = requireElement(root, '.git-comparison-message', HTMLDivElement)
  const preview = requireElement(root, '.git-workspace-preview', HTMLDivElement)
  const listeners = new AbortController()
  const listOptions = { signal: listeners.signal }

  let view: View = 'today'
  let selection: Selection = { kind: 'working' }
  let workingMode: WorkingMode = 'head'
  let parent: string | null = null
  let overview: GitOverview | null = null
  let historyLimit = PAGE_SIZE
  let { start: todayStart, end: todayEnd } = dayBounds()
  let activityKey = ''
  let comparisonKey = ''
  let fileKey = ''
  let overviewRequest = 0
  let comparisonRequest = 0
  let loadedFiles: GitFile[] = []
  let selectedFile: string | null = null
  let previewController: ReturnType<Options['openFile']> | undefined
  let previewKey = ''
  let refreshTimer = 0
  let midnightTimer = 0
  let refreshPending = false

  const visible = () => !root.hidden
  const displayedCommits = () => (view === 'today' ? overview?.today : overview?.commits) ?? []

  function renderSelections() {
    const key = selection.kind === 'commit' ? selection.id : selection.kind
    for (const row of activity.querySelectorAll<HTMLButtonElement>('[data-git-commit]')) {
      row.setAttribute('aria-pressed', String(row.dataset.gitCommit === key))
    }
    if (view === 'today') {
      const commit = overview?.today.find(item => item.id === key)
      const hour = commit ? String(new Date(commit.committedAt).getHours()) : undefined
      for (const bin of activity.querySelectorAll<HTMLButtonElement>('[data-git-hour]')) {
        bin.setAttribute('aria-current', String(bin.dataset.gitHour === hour))
      }
    }
  }

  function renderActivity() {
    todayTab.setAttribute('aria-pressed', String(view === 'today'))
    historyTab.setAttribute('aria-pressed', String(view === 'history'))
    scope.textContent = overview?.branch ?? ''
    if (overview?.head && !scope.textContent) scope.textContent = 'Detached HEAD'
    scope.title = scope.textContent
    repository.hidden = !scope.textContent
    const history = view === 'history'
    activityHeading.textContent = history ? 'Commit graph' : DISPLAY_DATE.format(todayStart)
    activityScope.textContent = history ? 'Repository history' : 'Local time'
    historyTail.hidden = !history || !overview?.historyHasMore
    historyLimitText.hidden = historyLimit < MAX_HISTORY
    more.hidden = historyLimit >= MAX_HISTORY
    const commits = displayedCommits()
    const key = JSON.stringify([view, todayStart, overview?.head, overview?.branch, commits])
    if (activityKey === key) {
      renderSelections()
      return
    }
    activityKey = key
    const focused = document.activeElement
    const focusedRow = focused instanceof HTMLButtonElement && activity.contains(focused) ? focused.dataset : undefined
    const graph = history ? layoutCommitGraph(commits, overview?.head ?? null) : null
    activity.classList.toggle('git-history-list', history)
    activity.style.setProperty('--git-graph-width', `${graph?.width ?? 0}px`)
    const content: HTMLElement[] = [
      workingRow(
        graph ? renderCommitGraphRow(graph.working, graph.width, 'working', 'working') : null,
        graph?.headOutside === true,
      ),
    ]
    if (history) {
      for (const commit of commits) {
        const kind = commit.parents.length > 1 ? 'merge' : 'commit'
        const rail = graph ? renderCommitGraphRow(graph.graph.get(commit.id), graph.width, commit.id, kind) : null
        content.push(commitRow(commit, overview?.head ?? null, todayStart, todayEnd, rail))
      }
    } else if (overview) {
      const summary = element('div', 'git-today-summary')
      const header = element('div', 'git-today-selection')
      const count = element('span', 'git-today-count')
      if (commits.length) {
        count.title = 'Commits reachable from HEAD today'
        count.append(
          element('strong', '', printNumber(commits.length)),
          element('span', '', commits.length === 1 ? 'commit' : 'commits'),
        )
      } else {
        count.textContent = 'No commits today'
      }
      header.append(count)
      if (commits.length > 0 && overview.head && overview.head !== overview.dayBase) {
        const compare = button('git-compare-day', 'Compare day')
        compare.dataset.gitCommit = 'day'
        header.append(compare)
      }
      summary.append(header)
      content.push(summary)
      if (commits.length) {
        summary.append(commitTimeline(commits))
        const list = element('div', 'git-today-commits')
        for (const commit of commits) list.append(commitRow(commit, overview.head, todayStart, todayEnd, null))
        content.push(list)
      }
    }
    activity.replaceChildren(...content)
    renderSelections()
    const focusSelector = focusedRow?.gitCommit
      ? `[data-git-commit="${CSS.escape(focusedRow.gitCommit)}"]`
      : focusedRow?.gitHour
        ? `[data-git-hour="${CSS.escape(focusedRow.gitHour)}"]`
        : null
    if (focusSelector) activity.querySelector<HTMLButtonElement>(focusSelector)?.focus({ preventScroll: true })
  }

  function details(): ComparisonDetails {
    if (selection.kind === 'day' && overview?.head) {
      const base = overview.dayBase
      return {
        comparison: { kind: 'revision', base, target: overview.head },
        title: 'Today’s committed diff',
        baseLabel: base ? `Before today (${shortId(base)})` : 'Empty tree',
        targetLabel: `HEAD (${shortId(overview.head)})`,
      }
    }
    if (selection.kind === 'commit') {
      const { id } = selection
      const commit = displayedCommits().find(item => item.id === id)
      if (commit) {
        const base = parent && commit.parents.includes(parent) ? parent : (commit.parents[0] ?? null)
        return {
          comparison: { kind: 'revision', base, target: commit.id },
          title: commit.subject || '(No commit message)',
          commit,
          baseLabel: base ? shortId(base) : 'Empty tree',
          targetLabel: shortId(commit.id),
        }
      }
    }
    const [baseLabel, targetLabel] = workingLabels(workingMode)
    return { comparison: { kind: 'working', mode: workingMode }, title: 'Working tree', baseLabel, targetLabel }
  }

  function workingLabels(mode: WorkingMode) {
    const [base, target] = WORKING_MODES[mode]
    return [base === 'HEAD' && overview && !overview.head ? 'Empty tree' : base, target] as const
  }

  function renderComparison({ comparison, title, baseLabel, targetLabel, commit }: ComparisonDetails) {
    const working = comparison.kind === 'working'
    const merge = commit && commit.parents.length > 1
    inspectorTitle.textContent = title
    inspectorId.textContent = commit ? shortId(commit.id) : ''
    inspectorId.title = commit?.id ?? ''
    inspectorId.hidden = !commit
    const refs = commit?.refs ?? []
    inspectorRefs.hidden = refs.length === 0
    inspectorRefs.replaceChildren(...refs.map(refPill))
    review.hidden = !working
    review.classList.toggle('is-primary', working && comparison.mode === 'head')
    const canChoose = working || Boolean(merge)
    chooser.hidden = !canChoose
    chooserLabel.hidden = !canChoose
    chooserLabel.textContent = merge ? 'Compare parent' : 'Comparison'
    fixed.hidden = canChoose
    fixedBase.textContent = baseLabel
    fixedTarget.textContent = targetLabel
    if (canChoose) {
      const options =
        comparison.kind === 'working'
          ? comparisonModes.map(mode => new Option(beforeAfter(...workingLabels(mode)), mode))
          : (commit?.parents.map(
              (id, index) => new Option(`${shortId(id)} → ${targetLabel} (parent ${index + 1})`, id),
            ) ?? [])
      if (
        chooser.options.length !== options.length ||
        options.some((option, index) => {
          const current = chooser.options[index]
          return current?.value !== option.value || current.text !== option.text
        })
      )
        chooser.replaceChildren(...options)
      chooser.value = comparison.kind === 'working' ? comparison.mode : (comparison.base ?? '')
    }
  }

  function clearPreview() {
    previewController?.dispose()
    previewController = undefined
    previewKey = ''
    preview.replaceChildren()
    preview.hidden = true
  }

  function renderFileSelection() {
    for (const row of files.querySelectorAll<HTMLButtonElement>('[data-git-file]')) {
      row.setAttribute('aria-pressed', String(row.dataset.gitFile === selectedFile))
    }
  }

  function showFile(current: ComparisonDetails, refreshPreview: boolean) {
    const file = loadedFiles.find(item => item.path === selectedFile)
    if (!file) {
      clearPreview()
      return
    }
    const { comparison, baseLabel, targetLabel } = current
    const key = JSON.stringify([comparison, file.path, file.originalPath, file.status, baseLabel, targetLabel])
    if (previewKey === key) {
      if (refreshPreview) previewController?.refresh()
      return
    }
    clearPreview()
    previewKey = key
    preview.hidden = false
    previewController = openFile({ host: preview, comparison, file, baseLabel, targetLabel, focus: false })
  }

  function renderFiles(result: GitChanges, current: ComparisonDetails, refreshPreview: boolean) {
    const { additions, deletions } = result
    loadedFiles = result.files.toSorted((a, b) => lineCount(b) - lineCount(a) || a.path.localeCompare(b.path))
    if (!loadedFiles.some(file => file.path === selectedFile)) selectedFile = loadedFiles[0]?.path ?? null
    const key = JSON.stringify([additions, deletions, loadedFiles])
    if (key !== fileKey) {
      fileKey = key
      const count = loadedFiles.length
      const label = `${printNumber(count)} ${count === 1 ? 'file' : 'files'}`
      const unknown = loadedFiles.filter(file => file.additions === null || file.deletions === null).length
      fileCount.textContent = printNumber(count)
      totals.replaceChildren(...counts(additions, deletions))
      totals.setAttribute(
        'aria-label',
        `${label}, ${linesLabel(additions, deletions)}${unknown ? `, ${unknown} with no line count` : ''}`,
      )
      const maximum = loadedFiles.reduce((max, file) => Math.max(max, file.additions ?? 0, file.deletions ?? 0), 1)
      files.style.setProperty('--git-count-width', `${Math.max(3, printNumber(maximum).length + 1)}ch`)
      const focused = document.activeElement
      const focusedPath =
        focused instanceof HTMLButtonElement && files.contains(focused) ? focused.dataset.gitFile : undefined
      files.replaceChildren(...loadedFiles.map(file => fileRow(file, maximum)))
      if (focusedPath) {
        files
          .querySelector<HTMLButtonElement>(`[data-git-file="${CSS.escape(focusedPath)}"]`)
          ?.focus({ preventScroll: true })
      }
    }
    renderFileSelection()
    renderMessage(comparisonMessage, loadedFiles.length ? '' : 'No changed files in this comparison.')
    showFile(current, refreshPreview)
  }

  function resetFiles() {
    comparisonRequest++
    comparisonKey = fileKey = ''
    loadedFiles = []
    selectedFile = null
    fileCount.textContent = ''
    totals.replaceChildren()
    totals.removeAttribute('aria-label')
    files.replaceChildren()
    clearPreview()
  }

  async function updateChanges(force = false) {
    const requested = details()
    renderComparison(requested)
    const key = JSON.stringify(requested.comparison)
    const fresh = key !== comparisonKey
    if (!fresh && !force) {
      if (selectedFile) showFile(requested, false)
      return
    }
    if (fresh) {
      resetFiles()
      renderMessage(comparisonMessage, 'Loading changes…')
    }
    comparisonKey = key
    const version = ++comparisonRequest
    try {
      const changes = await loadChanges(requested.comparison)
      if (visible() && version === comparisonRequest)
        renderFiles(changes, details(), force && requested.comparison.kind === 'working')
    } catch {
      if (visible() && version === comparisonRequest)
        renderMessage(comparisonMessage, 'Could not load changes.', () => requestChanges(true))
    }
  }

  function ensureSelection() {
    if (selection.kind === 'commit') {
      const { id } = selection
      if (displayedCommits().some(commit => commit.id === id)) return
    } else if (selection.kind === 'day' && view === 'today' && overview?.head && overview.today.length) {
      return
    }
    selection = { kind: 'working' }
    parent = null
  }

  async function updateOverview(refreshChanges = true) {
    const { start, end } = dayBounds()
    const version = ++overviewRequest
    more.disabled = true
    if (!overview) renderMessage(overviewMessage, 'Loading Git history…')
    try {
      const next = await loadOverview(start, end, historyLimit)
      if (!visible() || version !== overviewRequest) return
      overview = next
      todayStart = start
      todayEnd = end
      ensureSelection()
      renderActivity()
      renderMessage(overviewMessage, '')
      await updateChanges(refreshChanges && selection.kind === 'working')
    } catch {
      if (visible() && version === overviewRequest)
        renderMessage(overviewMessage, 'Could not load Git history.', () => requestOverview())
    } finally {
      if (version === overviewRequest) {
        more.disabled = false
        if (refreshPending) {
          refreshPending = false
          refresh()
        }
      }
    }
  }

  function requestOverview(refreshChanges = true) {
    runTask('Load Git history', () => updateOverview(refreshChanges))
  }

  function requestChanges(force = false) {
    runTask('Load Git changes', () => updateChanges(force))
  }

  function refresh() {
    if (!visible()) return
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      if (more.disabled) refreshPending = true
      else requestOverview()
    }, 120)
  }

  function scheduleMidnight() {
    window.clearTimeout(midnightTimer)
    midnightTimer = window.setTimeout(
      () => {
        requestOverview()
        scheduleMidnight()
      },
      Math.max(0, dayBounds().end - Date.now()) + 100,
    )
  }

  function focus() {
    const tab = view === 'history' ? historyTab : todayTab
    tab.focus({ preventScroll: true })
  }

  function show() {
    root.hidden = false
    renderActivity()
    focus()
    scheduleMidnight()
    requestOverview(false)
    requestChanges()
  }

  function hide() {
    root.hidden = true
    overviewRequest++
    refreshPending = false
    resetFiles()
    window.clearTimeout(refreshTimer)
    window.clearTimeout(midnightTimer)
  }

  function reset() {
    hide()
    view = 'today'
    selection = { kind: 'working' }
    workingMode = 'head'
    parent = null
    overview = null
    historyLimit = PAGE_SIZE
    activityKey = ''
    activityScroll.scrollTop = 0
    renderMessage(overviewMessage, '')
  }

  function destroy() {
    hide()
    listeners.abort()
    root.replaceChildren()
  }

  root.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      const control = preview.querySelector<HTMLButtonElement>('.git-diff-focus[aria-pressed="true"]')
      if (!control) return
      event.preventDefault()
      setDiffFocus(control, false)
      control.focus({ preventScroll: true })
    },
    listOptions,
  )
  root.addEventListener(
    'click',
    event => {
      if (!(event.target instanceof Element)) return
      const control = event.target.closest('button')
      if (!(control instanceof HTMLButtonElement)) return
      const { gitView, gitCommit: commit, gitFile, gitHourTarget } = control.dataset
      const gitCommit = commit ?? gitHourTarget
      if (control.classList.contains('git-diff-focus')) {
        setDiffFocus(control, control.getAttribute('aria-pressed') !== 'true')
      } else if (gitView === 'today' || gitView === 'history') {
        const expanded = preview.querySelector<HTMLButtonElement>('.git-diff-focus[aria-pressed="true"]')
        if (expanded) setDiffFocus(expanded, false)
        if (view === gitView) return
        view = gitView
        ensureSelection()
        activityScroll.scrollTop = 0
        renderActivity()
        requestChanges()
      } else if (gitCommit) {
        selection =
          gitCommit === 'working' || gitCommit === 'day' ? { kind: gitCommit } : { kind: 'commit', id: gitCommit }
        parent = null
        renderSelections()
        requestChanges()
        if (gitHourTarget) {
          const row = activity.querySelector<HTMLButtonElement>(`[data-git-commit="${CSS.escape(gitHourTarget)}"]`)
          row?.focus({ preventScroll: true })
          row?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      } else if (gitFile !== undefined) {
        selectedFile = gitFile
        renderFileSelection()
        showFile(details(), false)
      }
    },
    listOptions,
  )
  chooser.addEventListener(
    'change',
    () => {
      const mode = comparisonModes.find(candidate => candidate === chooser.value)
      if (selection.kind === 'working' && mode) {
        workingMode = mode
      } else if (selection.kind === 'commit') {
        parent = chooser.value
      }
      requestChanges()
    },
    listOptions,
  )
  review.addEventListener('click', openReview, listOptions)
  more.addEventListener(
    'click',
    () => {
      historyLimit = Math.min(MAX_HISTORY, historyLimit + PAGE_SIZE)
      requestOverview(false)
    },
    listOptions,
  )

  return { show, hide, refresh, reset, destroy, focus }
}
