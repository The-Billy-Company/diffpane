import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import type { AgentMemoryActivity, AgentMemorySnapshot, MemoryPressure } from '../../../shared/agent-memory.ts'
import { agentProviderNames } from '../../../shared/agent-threads.ts'
import type { AgentProvider, AgentThread, AgentThreadEvent, AgentThreadFile } from '../../../shared/agent-threads.ts'
import { reportError } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { drawThreadTrail } from '../art/assistant.ts'
import { createAgentThreadTranscript, showAgentThreadConversationState } from './agent-thread-conversation.ts'
import { createAgentThreadMinimap } from './agent-thread-minimap.ts'
import antigravityLogo from './provider-logos/antigravity.png'
import claudeCodeLogo from './provider-logos/claude-code.png'
import codexLogo from './provider-logos/codex.png'
import cursorDarkLogo from './provider-logos/cursor-dark.png'
import cursorLightLogo from './provider-logos/cursor-light.png'
import './agent-threads.css'

const glyphs = {
  activity: '<path d="M1.5 8h3l1.7-4.5 3.1 9 1.9-4.5h3.3"/>',
  arrow: '<path d="M13 8H3m4-4L3 8l4 4"/>',
  next: '<path d="m6 4 4 4-4 4"/>',
  sidebar: '<rect x="2" y="3.25" width="12" height="9.5" rx="1.4"/><path d="M6.25 3.25v9.5"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
  folder:
    '<path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11z"/>',
  grid: '<rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/>',
  refresh:
    '<path d="M13 6a5.1 5.1 0 0 0-8.6-1.7L2.5 6m0 0h3.3M2.5 6V2.7M3 10a5.1 5.1 0 0 0 8.6 1.7l1.9-1.7m0 0h-3.3m3.3 0v3.3"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>',
  down: '<path d="M8 3.25v9.5m-3.75-3.75L8 12.75 11.75 9"/>',
}

const providerLogos: Record<AgentProvider, string> = {
  codex: codexLogo, // Codex app mark from the ChatGPT desktop bundle.
  claude: claudeCodeLogo, // Anthropic's Claude Code VS Code extension icon.
  antigravity: antigravityLogo, // Full-color mark from antigravity.google/press.
  cursor: cursorDarkLogo, // 2D cube variants from cursor.com/brand.
}

const providers = ['codex', 'claude', 'antigravity', 'cursor'] satisfies AgentProvider[]
const stateLabels = { running: 'Running', idle: 'Idle', recent: 'Recent', unknown: 'Unknown', stale: 'Stale' }
const pressureLabels: Record<MemoryPressure, string> = {
  normal: 'Normal',
  warning: 'Elevated',
  critical: 'Critical',
  unknown: 'Unavailable',
}
const NO_PROJECT = 'unassigned'
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const sampleTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })
const memoryNumberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
const MEMORY_INTERVAL_MS = 2_000
const MEMORY_HISTORY_LIMIT = 30
const RUNNING_THREAD_INTERVAL_MS = 350
const IDLE_THREAD_INTERVAL_MS = 1_200
const CHILDREN_REFRESH_INTERVAL_MS = 2_000

type ThreadState = keyof typeof stateLabels

interface ThreadPanelOptions {
  api: DiffpaneApi['agentThreads']
  openWorkspaceFile: (file: AgentThreadFile) => unknown
  openExternal?: (href: string) => unknown
  onVisibilityChange?: (visible: boolean) => void
}

interface ConversationView {
  thread: AgentThread
  reading: boolean
  needsSnapshot: boolean
  transcript?: ReturnType<typeof createAgentThreadTranscript>
  transcriptElement?: HTMLElement
  contents?: ChildNode[]
  scrollTop: number
}

function icon(name: keyof typeof glyphs) {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`
}

function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text?: string) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function basename(path: string) {
  return path.replace(/[\\/]+$/u, '').match(/[^\\/]+$/u)?.[0] ?? path
}

function threadCount(count: number) {
  return `${count} ${count === 1 ? 'thread' : 'threads'}`
}

function memorySize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${memoryNumberFormat.format(bytes / 1024 ** 3)} GiB`
  return `${memoryNumberFormat.format(bytes / 1024 ** 2)} MiB`
}

function projectOf(thread: AgentThread) {
  return thread.projectRoot ?? (thread.cwd || NO_PROJECT)
}

function projectName(path: string) {
  return path === NO_PROJECT ? 'No project' : basename(path)
}

function providerLogo(provider: AgentProvider) {
  const dark = `<img class="agent-thread-provider-logo" alt="" src="${providerLogos[provider]}">`
  return provider === 'cursor'
    ? `${dark}<img class="agent-thread-provider-logo agent-thread-provider-logo-light" alt="" src="${cursorLightLogo}">`
    : dark
}

function providerMark(provider: AgentProvider) {
  const mark = node('span', 'agent-thread-provider-mark')
  mark.dataset.provider = provider
  mark.innerHTML = providerLogo(provider)
  return mark
}

function renderState(element: HTMLElement, state: ThreadState) {
  element.dataset.state = state
  element.textContent = stateLabels[state]
}

function renderTime(element: HTMLTimeElement, stamp: number, now: number, absolute = false) {
  const date = new Date(stamp)
  element.hidden = stamp <= 0 || !Number.isFinite(date.getTime())
  if (element.hidden) return
  const elapsed = Math.max(0, now - stamp)
  element.dateTime = date.toISOString()
  element.title = timeFormat.format(stamp)
  element.textContent =
    absolute || elapsed >= 604_800_000
      ? absolute
        ? element.title
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : elapsed < 60_000
        ? 'Just now'
        : elapsed < 3_600_000
          ? `${Math.floor(elapsed / 60_000)}m ago`
          : elapsed < 86_400_000
            ? `${Math.floor(elapsed / 3_600_000)}h ago`
            : `${Math.floor(elapsed / 86_400_000)}d ago`
}

export function createAgentThreadPanel(
  host: HTMLElement,
  { api, openWorkspaceFile, openExternal, onVisibilityChange }: ThreadPanelOptions,
) {
  host.classList.add('agent-threads')
  host.hidden = true
  host.setAttribute('aria-labelledby', 'agent-threads-title')
  host.innerHTML = `
    <header class="agent-thread-topbar">
      <button class="agent-thread-control agent-thread-sidebar-toggle" type="button" data-projects-toggle aria-controls="agent-thread-projects">
        ${icon('sidebar')}
      </button>
      <h1 class="agent-thread-app-title" id="agent-threads-title" data-app-title>${icon('activity')}<span>Agent threads</span></h1>
      <button class="agent-thread-control" type="button" data-back aria-label="Back to threads" hidden>${icon('arrow')}<span>Threads</span></button>
      <div class="agent-thread-topbar-end">
        <span class="agent-thread-sync" role="status" data-sync></span>
        <span class="agent-thread-memory-state agent-thread-memory-detail" role="status" data-memory-detail hidden>Memory pressure · Checking…</span>
        <button class="agent-thread-control" type="button" data-refresh aria-label="Refresh threads" title="Refresh threads">${icon('refresh')}<span>Refresh</span></button>
        <span class="agent-thread-topbar-rule" aria-hidden="true"></span>
        <button class="agent-thread-control" type="button" data-close aria-label="Back to workspace" title="Back to workspace">${icon('close')}<span>Workspace</span></button>
      </div>
    </header>
    <div class="agent-thread-browser" data-browser data-projects-open="true">
      <nav id="agent-thread-projects" class="agent-thread-projects" aria-label="Projects">
        <div class="agent-thread-projects-content">
          <h2>Projects</h2>
          <div data-projects></div>
        </div>
      </nav>
      <section class="agent-thread-roster" aria-labelledby="agent-thread-roster-title" tabindex="-1" data-roster>
        <header class="agent-thread-roster-header">
          <div class="agent-thread-roster-overview">
            <div class="agent-thread-roster-heading">
              <h2 id="agent-thread-roster-title" data-roster-title>All threads</h2>
              <p data-result-count role="status" hidden></p>
            </div>
            <div class="agent-thread-query-tools">
              <label class="agent-thread-search">${icon('search')}<input type="search" aria-label="Search threads" placeholder="Search threads" /></label>
              <button class="agent-thread-control agent-thread-running" type="button" aria-pressed="false" data-running><span></span>Running</button>
            </div>
          </div>
          <div class="agent-thread-providers" role="group" aria-label="Filter by agent">
            <button class="agent-thread-source" type="button" aria-pressed="true" data-any-agent>All agents</button>
            ${providers
              .map(
                provider => `
              <button class="agent-thread-source" type="button" aria-pressed="false" data-source="${provider}" data-provider="${provider}">
                ${providerLogo(provider)}<span>${agentProviderNames[provider]}</span><span class="agent-thread-source-count" data-source-count></span>
              </button>`,
              )
              .join('')}
          </div>
        </header>
        <div class="agent-thread-list" data-list>
          <div class="agent-thread-roster-grid">
            <aside class="agent-thread-memory" aria-label="Live activity">
              <section class="agent-thread-memory-agents" aria-labelledby="agent-thread-memory-agents-title" data-memory-agents>
                <div class="agent-thread-memory-heading">
                  <h3 id="agent-thread-memory-agents-title">Active agent threads</h3>
                  <span class="agent-thread-memory-caption" data-memory-caption hidden></span>
                </div>
                <p class="agent-thread-memory-empty" data-memory-empty>Checking activity…</p>
                <ul class="agent-thread-memory-actions" aria-label="Active agent threads" data-memory-actions hidden></ul>
                <p class="agent-thread-memory-empty agent-thread-memory-error" role="status" data-memory-activity-status hidden></p>
              </section>
              <section class="agent-thread-memory-system" aria-labelledby="agent-thread-memory-title" data-memory-system>
                <div class="agent-thread-memory-heading">
                  <h3 id="agent-thread-memory-title">Memory pressure</h3>
                  <span class="agent-thread-memory-state" role="status" data-memory-pressure>Checking…</span>
                </div>
                <div class="agent-thread-memory-usage" data-memory-usage hidden></div>
                <div class="agent-thread-memory-history" aria-hidden="true" data-memory-history></div>
                <div class="agent-thread-memory-source" data-memory-source hidden>
                  <span data-memory-provider></span><time data-memory-time></time>
                </div>
              </section>
            </aside>
            <div class="agent-thread-list-content" data-list-content></div>
          </div>
        </div>
      </section>
    </div>
    <section class="agent-thread-detail" aria-label="Conversation" data-detail hidden>
      <header class="agent-thread-detail-header">
        <div class="agent-thread-detail-heading">
          <div class="agent-thread-detail-meta">
            <span class="agent-thread-detail-provider" data-detail-provider></span>
            <span class="agent-thread-detail-project" data-detail-project></span>
            <span class="agent-thread-state" data-detail-state></span>
          </div>
          <h2 tabindex="-1" data-detail-title></h2>
          <div class="agent-thread-detail-context">
            <time data-detail-time></time>
            <span class="agent-thread-cwd" data-detail-cwd></span>
          </div>
        </div>
      </header>
      <div class="agent-thread-delegate-tabs" data-delegate-tabs hidden>
        <div class="agent-thread-tablist" role="tablist" aria-label="Conversation and subagents" data-delegate-tablist></div>
        <p class="agent-thread-tab-status" data-delegate-status role="status" hidden></p>
      </div>
      <p class="agent-thread-file-status" data-file-status role="status" hidden></p>
      <div class="agent-thread-reading" id="agent-thread-active-panel">
        <button class="agent-thread-control agent-thread-jump" type="button" data-latest hidden>${icon('down')} Jump to latest</button>
        <div class="agent-thread-transcript" data-conversation></div>
      </div>
    </section>`

  const browser = requireElement(host, '[data-browser]', HTMLDivElement)
  const sidebar = requireElement(host, '#agent-thread-projects', HTMLElement)
  const projectNav = requireElement(sidebar, '[data-projects]', HTMLDivElement)
  const sidebarToggle = requireElement(host, '[data-projects-toggle]', HTMLButtonElement)
  const back = requireElement(host, '[data-back]', HTMLButtonElement)
  const appTitle = requireElement(host, '[data-app-title]', HTMLElement)
  const sync = requireElement(host, '[data-sync]', HTMLElement)
  const roster = requireElement(host, '[data-roster]', HTMLElement)
  const rosterTitle = requireElement(roster, '[data-roster-title]', HTMLHeadingElement)
  const resultCount = requireElement(roster, '[data-result-count]', HTMLParagraphElement)
  const refresh = requireElement(host, '[data-refresh]', HTMLButtonElement)
  const query = requireElement(host, 'input[type=search]', HTMLInputElement)
  const running = requireElement(host, '[data-running]', HTMLButtonElement)
  const list = requireElement(host, '[data-list]', HTMLDivElement)
  const listContent = requireElement(list, '[data-list-content]', HTMLDivElement)
  const memoryPressure = requireElement(host, '[data-memory-pressure]', HTMLElement)
  const memorySystem = requireElement(host, '[data-memory-system]', HTMLElement)
  const memoryAgents = requireElement(host, '[data-memory-agents]', HTMLElement)
  const memoryDetail = requireElement(host, '[data-memory-detail]', HTMLElement)
  const memoryUsage = requireElement(host, '[data-memory-usage]', HTMLDivElement)
  const memorySource = requireElement(host, '[data-memory-source]', HTMLDivElement)
  const memoryProvider = requireElement(memorySource, '[data-memory-provider]', HTMLElement)
  const memoryTime = requireElement(memorySource, '[data-memory-time]', HTMLTimeElement)
  const memoryHistory = requireElement(host, '[data-memory-history]', HTMLDivElement)
  const memoryCaption = requireElement(host, '[data-memory-caption]', HTMLElement)
  const memoryActions = requireElement(host, '[data-memory-actions]', HTMLUListElement)
  const memoryEmpty = requireElement(host, '[data-memory-empty]', HTMLParagraphElement)
  const memoryActivityStatus = requireElement(host, '[data-memory-activity-status]', HTMLParagraphElement)
  const allAgents = requireElement(host, '[data-any-agent]', HTMLButtonElement)
  const sources = new Map(
    providers.map(provider => {
      const button = requireElement(host, `[data-source="${provider}"]`, HTMLButtonElement)
      return [provider, { button, count: requireElement(button, '[data-source-count]', HTMLElement) }]
    }),
  )

  const detail = requireElement(host, '[data-detail]', HTMLElement)
  const detailTitle = requireElement(detail, '[data-detail-title]', HTMLHeadingElement)
  const detailProvider = requireElement(detail, '[data-detail-provider]', HTMLElement)
  const detailProject = requireElement(detail, '[data-detail-project]', HTMLElement)
  const detailState = requireElement(detail, '[data-detail-state]', HTMLElement)
  const detailCwd = requireElement(detail, '[data-detail-cwd]', HTMLElement)
  const detailTime = requireElement(detail, '[data-detail-time]', HTMLTimeElement)
  const conversation = requireElement(detail, '[data-conversation]', HTMLDivElement)
  const minimap = createAgentThreadMinimap(conversation)
  const readingPanel = requireElement(detail, '.agent-thread-reading', HTMLDivElement)
  readingPanel.append(minimap.element)
  const delegateTabs = requireElement(detail, '[data-delegate-tabs]', HTMLDivElement)
  const delegateTablist = requireElement(delegateTabs, '[data-delegate-tablist]', HTMLDivElement)
  const delegateStatus = requireElement(delegateTabs, '[data-delegate-status]', HTMLParagraphElement)
  const latest = requireElement(detail, '[data-latest]', HTMLButtonElement)
  const fileStatus = requireElement(detail, '[data-file-status]', HTMLParagraphElement)
  const compactProjects = window.matchMedia('(max-width: 700px)')

  let threads = new Map<string, AgentThread>()
  const rowButtons = new Map<string, HTMLButtonElement>()
  let unavailable = new Set<AgentProvider>()
  let loaded = false
  let listError = false
  let listing = false
  let disposed = false
  let lastChecked = 0
  let projectFilter = ''
  let providerFilter: AgentProvider | undefined
  let runningOnly = false
  let projectsOpen = true
  let projectsToggled = false
  let returnFocus: HTMLElement | null = null
  let previousListTop = 0
  let selected: AgentThread | undefined
  let selection = ''
  let threadTimer: number | undefined
  const views = new Map<string, ConversationView>()
  const children = new Map<string, AgentThread>()
  const childLookups = new Map<string, { checkedAt: number; pending?: Promise<void> }>()
  const tabButtons = new Map<string, HTMLButtonElement>()
  let activeView: ConversationView | undefined
  let observedTranscript: HTMLElement | undefined
  let following = false
  let fileRequest = 0
  let memoryTimer: number | undefined
  let memoryRun = 0
  let samplingMemory = false
  let renderedMemoryActions = ''
  let pendingMemoryThread = ''
  let returnMemoryThread = ''
  const memorySamples: Pick<AgentMemorySnapshot, 'sampledAt' | 'pressure'>[] = []

  function memoryThreadButton(id: string) {
    return [...memoryActions.querySelectorAll('button')].find(button => button.dataset.threadId === id)
  }

  function openMemoryThread(id: string) {
    memoryActivityStatus.hidden = true
    const thread = threads.get(id)
    if (thread) openThread(thread, id)
    else {
      pendingMemoryThread = id
      requestRefresh()
    }
  }

  function memoryActionRow(activity: AgentMemoryActivity, displayedPids: Set<number>) {
    const row = node('li', 'agent-thread-memory-action')
    const button = node('button', 'agent-thread-memory-open')
    button.type = 'button'
    button.dataset.threadId = activity.id
    const mark = providerMark(activity.provider)
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', agentProviderNames[activity.provider])
    const title = node('strong', 'agent-thread-memory-thread', activity.title)
    title.title = `${agentProviderNames[activity.provider]} · ${activity.title}`
    const action = node('span', 'agent-thread-memory-action-text', activity.action ?? 'No action recorded')
    action.title = action.textContent
    const process = activity.process
    const measurement = node('span', 'agent-thread-memory-resident')
    if (process) {
      measurement.textContent = displayedPids.has(process.pid)
        ? `Shared PID ${process.pid}`
        : `${memorySize(process.residentBytes)} resident${process.shared ? ` · shared PID ${process.pid}` : ''}`
      measurement.title = `Resident memory of PID ${process.pid}${process.shared ? ' shared across threads' : ''}`
      displayedPids.add(process.pid)
    }
    button.append(mark, title, action, measurement)
    button.addEventListener('click', () => openMemoryThread(activity.id))
    row.append(button)
    return row
  }

  function renderMemory(sample: AgentMemorySnapshot | undefined, failed = false) {
    const pressure = sample?.pressure ?? 'unknown'
    const pressureLabel = sample || failed ? pressureLabels[pressure] : 'Checking…'
    memorySystem.dataset.pressure = pressure
    memoryPressure.dataset.pressure = pressure
    if (memoryPressure.textContent !== pressureLabel) memoryPressure.textContent = pressureLabel
    memoryDetail.dataset.pressure = pressure
    const detailLabel = `Memory pressure · ${pressureLabel}`
    if (memoryDetail.textContent !== detailLabel) memoryDetail.textContent = detailLabel
    const { usedBytes, totalBytes } = sample ?? {}
    memoryUsage.hidden = usedBytes === undefined || totalBytes === undefined
    if (usedBytes !== undefined && totalBytes !== undefined)
      memoryUsage.textContent = `${memorySize(usedBytes)} / ${memorySize(totalBytes)} used`
    memorySource.hidden = !sample
    if (sample) {
      memoryProvider.textContent = sample.source === 'windows' ? 'Windows app' : 'System'
      memoryTime.dateTime = new Date(sample.sampledAt).toISOString()
      memoryTime.textContent = sampleTimeFormat.format(sample.sampledAt)
      memoryTime.title = `Latest sample at ${timeFormat.format(sample.sampledAt)}`
      if (memorySamples.at(-1)?.sampledAt !== sample.sampledAt) {
        memorySamples.push({ sampledAt: sample.sampledAt, pressure })
        while (memorySamples.length > MEMORY_HISTORY_LIMIT) memorySamples.shift()
        memoryHistory.replaceChildren(
          ...memorySamples.map(previous => {
            const marker = node('span', 'agent-thread-memory-tick')
            marker.dataset.pressure = previous.pressure
            marker.title = `${pressureLabels[previous.pressure]} · ${sampleTimeFormat.format(previous.sampledAt)}`
            return marker
          }),
        )
      }
    }
    memoryHistory.hidden = !sample

    const activities = sample?.activities ?? []
    memoryAgents.dataset.active = String(Boolean(activities.length))
    memoryCaption.textContent = activities.length ? String(activities.length) : ''
    memoryCaption.hidden = !activities.length
    memoryActions.hidden = !activities.length
    memoryEmpty.hidden = Boolean(activities.length)
    memoryEmpty.textContent = failed
      ? 'Activity unavailable'
      : sample
        ? 'No active agent threads detected'
        : 'Checking activity…'
    const actions = JSON.stringify(activities)
    if (actions === renderedMemoryActions) return
    renderedMemoryActions = actions
    const activeId =
      document.activeElement instanceof HTMLButtonElement && memoryActions.contains(document.activeElement)
        ? document.activeElement.dataset.threadId
        : undefined
    const displayedPids = new Set<number>()
    memoryActions.replaceChildren(...activities.map(activity => memoryActionRow(activity, displayedPids)))
    if (activeId) (memoryThreadButton(activeId) ?? query).focus({ preventScroll: true })
  }

  function canSampleMemory() {
    return !disposed && !host.hidden && !document.hidden
  }

  async function pollMemory() {
    if (samplingMemory || !canSampleMemory()) return
    samplingMemory = true
    const run = memoryRun
    const started = performance.now()
    try {
      const sample = await api.memory()
      if (run === memoryRun && canSampleMemory()) renderMemory(sample)
    } catch {
      if (run === memoryRun && canSampleMemory()) renderMemory(undefined, true)
    } finally {
      samplingMemory = false
      if (canSampleMemory()) {
        const delay = run === memoryRun ? Math.max(0, MEMORY_INTERVAL_MS - (performance.now() - started)) : 0
        memoryTimer = window.setTimeout(() => void pollMemory(), delay)
      }
    }
  }

  function updateMemorySampling() {
    window.clearTimeout(memoryTimer)
    memoryRun++
    if (canSampleMemory()) {
      renderMemory(undefined)
      void pollMemory().catch((error: unknown) => reportError(error, { silent: true }))
    }
  }

  function stateOf(thread: AgentThread): ThreadState {
    return listError || unavailable.has(thread.provider) ? 'stale' : (thread.status ?? 'unknown')
  }

  function updateTopbar() {
    sidebarToggle.hidden = Boolean(selected)
    appTitle.classList.toggle('agent-thread-app-title-compact', Boolean(selected))
    back.hidden = !selected
    sync.hidden = Boolean(selected)
    memoryDetail.hidden = !selected
    const label = selected ? 'Refresh conversation' : 'Refresh threads'
    refresh.setAttribute('aria-label', label)
    refresh.title = label
    refresh.disabled = selected ? Boolean(activeView?.reading && !activeView.transcript) : listing
  }

  function setProjectsOpen(open: boolean) {
    projectsOpen = open
    browser.dataset.projectsOpen = String(open)
    sidebar.inert = !open
    sidebarToggle.setAttribute('aria-expanded', String(open))
    const label = open ? 'Hide projects' : 'Show projects'
    sidebarToggle.setAttribute('aria-label', label)
    sidebarToggle.title = label
  }

  function updateProjectLayout() {
    if (projectsToggled) return
    if (compactProjects.matches && sidebar.contains(document.activeElement)) sidebarToggle.focus()
    setProjectsOpen(!compactProjects.matches)
  }

  function selectProject(path: string) {
    projectFilter = path
    applyFilters()
  }

  function projectButton(path: string, title: string, count: number) {
    const button = node('button', 'agent-thread-project')
    button.type = 'button'
    button.title = path && path !== NO_PROJECT ? path : title
    button.setAttribute('aria-current', String(projectFilter === path))
    button.innerHTML = icon(path ? 'folder' : 'grid')
    button.append(
      node('span', 'agent-thread-project-name', title),
      node('span', 'agent-thread-project-count', String(count)),
    )
    button.addEventListener('click', () => selectProject(path))
    return button
  }

  function createThreadRow(thread: AgentThread, now: number) {
    const button = node('button', 'agent-thread-row')
    button.type = 'button'
    const threadState = stateOf(thread)
    button.dataset.state = threadState
    const content = node('span', 'agent-thread-row-content')
    const title = node('strong', 'agent-thread-row-title', thread.title)
    title.title = thread.title
    const excerpt = thread.activity?.replace(/\s+/gu, ' ').trim()
    const worktree = thread.cwd && thread.cwd !== projectOf(thread) ? basename(thread.cwd) : ''
    const secondary = node('span', 'agent-thread-row-secondary')
    const context = node(
      'span',
      'agent-thread-row-context',
      [agentProviderNames[thread.provider], worktree].filter(Boolean).join(' · '),
    )
    secondary.append(context)
    if (excerpt) {
      const activity = node('span', 'agent-thread-row-activity', excerpt)
      activity.title = excerpt
      secondary.append(activity)
    }
    content.append(title, secondary)
    const meta = node('span', 'agent-thread-row-meta')
    const state = node('span', 'agent-thread-state')
    renderState(state, threadState)
    const time = node('time', 'agent-thread-time')
    renderTime(time, thread.updatedAt, now)
    meta.append(state, time)
    const arrow = node('span', 'agent-thread-row-arrow')
    arrow.innerHTML = icon('next')
    button.append(providerMark(thread.provider), content, meta, arrow)
    button.addEventListener('click', () => openThread(thread))
    rowButtons.set(thread.id, button)
    return button
  }

  function renderRoster() {
    const searchText = query.value.trim().toLowerCase()
    const terms = searchText.split(/\s+/u)
    const now = lastChecked || Date.now()
    const projects = new Map<string, { total: number; matches: AgentThread[] }>()
    const byProvider = new Map<AgentProvider, number>()
    let hasRunning = false
    for (const thread of threads.values()) {
      const path = projectOf(thread)
      const group = projects.get(path) ?? { total: 0, matches: [] }
      projects.set(path, group)
      group.total++
      if (projectFilter && projectFilter !== path) continue
      const isRunning = stateOf(thread) === 'running'
      if (runningOnly && !isRunning) continue
      const searchable = [thread.title, thread.activity, thread.cwd, path, agentProviderNames[thread.provider]]
        .join(' ')
        .toLowerCase()
      if (!terms.every(term => searchable.includes(term))) continue
      byProvider.set(thread.provider, (byProvider.get(thread.provider) ?? 0) + 1)
      if (providerFilter && providerFilter !== thread.provider) continue
      hasRunning ||= isRunning
      group.matches.push(thread)
    }

    running.dataset.live = String(hasRunning)
    allAgents.setAttribute('aria-pressed', String(!providerFilter))
    for (const [provider, source] of sources) {
      source.button.setAttribute('aria-pressed', String(providerFilter === provider))
      source.count.textContent = loaded ? String(byProvider.get(provider) ?? 0) : ''
      const missing = unavailable.has(provider)
      source.button.dataset.unavailable = String(missing)
      source.button.title = missing ? `${agentProviderNames[provider]} sessions could not be refreshed` : ''
    }

    const scope = projectFilter ? projectName(projectFilter) : 'All threads'
    if (rosterTitle.textContent !== scope) rosterTitle.textContent = scope
    rosterTitle.title = projectFilter && projectFilter !== NO_PROJECT ? projectFilter : ''

    const activeProject =
      document.activeElement instanceof HTMLButtonElement && projectNav.contains(document.activeElement)
        ? [...projectNav.children].indexOf(document.activeElement)
        : -1
    projectNav.replaceChildren(
      projectButton('', 'All projects', threads.size),
      ...[...projects].map(([path, count]) => projectButton(path, projectName(path), count.total)),
    )
    const previousProject = projectNav.children.item(activeProject)
    if (previousProject instanceof HTMLElement) previousProject.focus({ preventScroll: true })

    rowButtons.clear()
    const content = document.createDocumentFragment()
    for (const [path, group] of projects) {
      if (!group.matches.length && path !== projectFilter) continue
      const section = node('section', 'agent-thread-group')
      if (!projectFilter) {
        const heading = node('header', 'agent-thread-group-heading')
        heading.innerHTML = icon('folder')
        heading.append(node('h3', '', projectName(path)), node('span', '', threadCount(group.matches.length)))
        heading.title = path === NO_PROJECT ? '' : path
        section.append(heading)
      }
      if (group.matches.length) {
        const rows = node('div', 'agent-thread-group-rows')
        rows.append(...group.matches.map(thread => createThreadRow(thread, now)))
        section.append(rows)
      }
      content.append(section)
    }
    const filtered = runningOnly || providerFilter !== undefined || searchText.length > 0
    const countLabel = `${threadCount(rowButtons.size)}${filtered ? ' found' : ''}`
    resultCount.hidden = !loaded
    if (resultCount.textContent !== countLabel) resultCount.textContent = countLabel
    if (!rowButtons.size) {
      const empty = node('div', 'agent-thread-empty')
      const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      art.setAttribute('class', 'agent-thread-empty-art')
      art.setAttribute('viewBox', '9 4 69 50')
      art.setAttribute('aria-hidden', 'true')
      art.setAttribute('stroke-linecap', 'round')
      art.setAttribute('stroke-linejoin', 'round')
      if (!listing) {
        drawThreadTrail(art)
        empty.append(art)
      }
      const title =
        !loaded && listing
          ? 'Finding local threads…'
          : listError
            ? 'Couldn’t load local threads'
            : threads.size
              ? 'No matching threads'
              : 'No local threads found'
      empty.append(node('p', 'agent-thread-empty-title', title))
      if (loaded || listError) {
        empty.append(
          node(
            'p',
            '',
            listError
              ? 'Use Refresh to try again.'
              : threads.size
                ? 'Try a different search or filter.'
                : 'Saved sessions will appear here when you refresh.',
          ),
        )
      }
      const emptyContainer = content.firstElementChild ?? content
      emptyContainer.append(empty)
    }
    const focusedId =
      document.activeElement instanceof HTMLButtonElement && list.contains(document.activeElement)
        ? document.activeElement.dataset.threadId
        : undefined
    for (const [id, button] of rowButtons) button.dataset.threadId = id
    listContent.replaceChildren(content)
    if (focusedId) (rowButtons.get(focusedId) ?? query).focus({ preventScroll: true })
  }

  function applyFilters() {
    renderRoster()
    list.scrollTop = 0
  }

  function renderDelegateTabs() {
    const root = selected
    const shown = Boolean(root && children.size)
    delegateTabs.hidden = !shown && delegateStatus.hidden
    delegateTablist.hidden = !shown
    if (!root || !shown) {
      delegateTablist.replaceChildren()
      readingPanel.removeAttribute('role')
      readingPanel.removeAttribute('aria-labelledby')
      return
    }
    const buttons = [root, ...children.values()].map(thread => {
      let tab = tabButtons.get(thread.id)
      if (!tab) {
        tab = node('button', 'agent-thread-tab')
        tab.type = 'button'
        tab.id = `agent-thread-tab-${tabButtons.size}`
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-controls', readingPanel.id)
        tab.addEventListener('click', () => {
          const next = thread.id === selected?.id ? selected : children.get(thread.id)
          if (next) switchConversation(next, true)
        })
        tabButtons.set(thread.id, tab)
      }
      const label = thread.id === root.id ? 'Main thread' : (thread.agentName ?? thread.title)
      if (tab.textContent !== label) tab.textContent = label
      tab.title = thread.title
      const active = thread.id === activeView?.thread.id
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      return tab
    })
    if (
      buttons.length !== delegateTablist.children.length ||
      buttons.some((tab, i) => tab !== delegateTablist.children[i])
    ) {
      delegateTablist.replaceChildren(...buttons)
    }
    const active = buttons.find(tab => tab.tabIndex === 0)
    if (active) {
      readingPanel.setAttribute('role', 'tabpanel')
      readingPanel.setAttribute('aria-labelledby', active.id)
    }
  }

  function lookupChildren(view: ConversationView, force = false): Promise<void> | undefined {
    const root = selected
    if (!root) return undefined
    const id = view.thread.id
    const previous = childLookups.get(id)
    if (previous?.pending) return previous.pending
    if (!force && previous && Date.now() - previous.checkedAt < CHILDREN_REFRESH_INTERVAL_MS) return undefined
    const current = selection
    const lookup: { checkedAt: number; pending?: Promise<void> } = { checkedAt: Date.now() }
    const parentId = id === root.id ? undefined : id
    async function discover() {
      const found = await api.children(current, parentId)
      if (selection !== current) return
      let changed = false
      for (const child of found) {
        const prior = children.get(child.id)
        children.set(child.id, child)
        if (!prior || prior.title !== child.title || prior.agentName !== child.agentName) changed = true
      }
      if (changed) renderDelegateTabs()
    }
    lookup.pending = discover()
      .catch((error: unknown) => {
        reportError(error, { silent: true })
      })
      .finally(() => {
        lookup.pending = undefined
      })
    childLookups.set(id, lookup)
    return lookup.pending
  }

  async function openDelegate(id: string, origin: ConversationView) {
    const root = selected
    if (activeView !== origin) return
    if (root?.id === id) {
      switchConversation(root, true)
      return
    }
    if (!children.has(id)) await lookupChildren(origin, true)
    if (activeView !== origin) return
    const next = children.get(id)
    if (next) switchConversation(next, true)
    else {
      delegateStatus.textContent = 'This subagent transcript is unavailable.'
      delegateStatus.hidden = false
      renderDelegateTabs()
    }
  }

  function switchConversation(thread: AgentThread, focusTab = false) {
    if (activeView?.thread.id !== thread.id) {
      const previous = activeView
      if (previous?.transcript) {
        previous.contents = [...conversation.childNodes]
        previous.scrollTop = conversation.scrollTop
      }
      window.clearTimeout(threadTimer)
      clearFileNavigation()
      delegateStatus.hidden = true
      const view = views.get(thread.id) ?? { thread, reading: false, needsSnapshot: true, scrollTop: 0 }
      view.thread = thread
      views.set(thread.id, view)
      activeView = view
      if (view.contents) {
        conversation.replaceChildren(...view.contents)
        conversation.setAttribute('aria-busy', 'false')
        conversation.scrollTop = view.scrollTop
        syncConversationScroll()
      } else {
        showAgentThreadConversationState(conversation, thread.provider)
        conversation.scrollTop = 0
        following = false
        latest.hidden = true
      }
      setTranscriptElement(view.transcriptElement)
      renderDelegateTabs()
      updateTopbar()
      requestRefresh()
    }
    if (focusTab) tabButtons.get(thread.id)?.focus()
  }

  function clearSelection() {
    const previous = selection
    selection = ''
    activeView = undefined
    window.clearTimeout(threadTimer)
    following = false
    views.clear()
    children.clear()
    childLookups.clear()
    tabButtons.clear()
    delegateStatus.hidden = true
    renderDelegateTabs()
    setTranscriptElement()
    if (previous) void api.clear(previous).catch((error: unknown) => reportError(error, { silent: true }))
    clearFileNavigation()
  }

  function clearFileNavigation() {
    fileRequest++
    fileStatus.hidden = true
    fileStatus.textContent = ''
  }

  async function openLinkedFile(file: AgentThreadFile) {
    const current = selection
    const request = ++fileRequest
    fileStatus.hidden = true
    try {
      const childId = activeView?.thread.id === selected?.id ? undefined : activeView?.thread.id
      const result = await api.file(current, file.path, childId, file.line)
      if (selection !== current || request !== fileRequest) return
      close()
      if (result.kind === 'workspace') {
        try {
          await openWorkspaceFile({ ...file, path: result.path })
        } catch (error) {
          reportError(error, { operation: 'Open linked file' })
        }
      }
    } catch (error) {
      if (selection === current && request === fileRequest) {
        fileStatus.textContent = reportError(error, { operation: 'Open linked file', silent: true }).message
        fileStatus.hidden = false
      }
    }
  }

  function isAtLatest() {
    return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 72
  }

  function syncConversationScroll() {
    following = isAtLatest()
    latest.hidden = following
  }

  function setTranscriptElement(next?: HTMLElement) {
    minimap.setTranscript(next)
    if (observedTranscript === next) return
    if (observedTranscript) transcriptSize.unobserve(observedTranscript)
    observedTranscript = next
    if (next) transcriptSize.observe(next)
  }

  function applyTranscript(from: number, events: readonly AgentThreadEvent[], view: ConversationView) {
    const { thread } = view
    const follow = view.transcript ? isAtLatest() : thread.status === 'running'
    view.transcript ??= createAgentThreadTranscript(conversation, {
      provider: thread.provider,
      providerMark: providerMark(thread.provider),
      projectRoot: thread.projectRoot ?? thread.cwd,
      assistantName: thread.agentName,
      userName: thread.id === selected?.id ? undefined : 'Parent agent',
      openExternal,
      onOpenFile: file => void openLinkedFile(file),
      onOpenDelegate: id => {
        void openDelegate(id, view).catch((error: unknown) => reportError(error, { silent: true }))
      },
    })
    view.transcriptElement = view.transcript.update(from, events)
    setTranscriptElement(view.transcriptElement)
    if (follow) conversation.scrollTop = conversation.scrollHeight
    syncConversationScroll()
  }

  function updateSelectedThread(thread: AgentThread) {
    selected = thread
    threads.set(thread.id, thread)
    detailTitle.textContent = thread.title
    detailProject.textContent = projectName(projectOf(thread))
    detailProject.hidden = projectOf(thread) === NO_PROJECT
    detailCwd.textContent = thread.cwd
    detailCwd.title = thread.cwd
    detailCwd.hidden = !thread.cwd
    const state = stateOf(thread)
    detail.dataset.state = state
    renderState(detailState, state)
    renderTime(detailTime, thread.updatedAt, Date.now(), true)
  }

  function canUpdateConversation() {
    return Boolean(selected) && !disposed && !host.hidden && !document.hidden
  }

  async function readThread() {
    const root = selected
    const view = activeView
    if (!root || !view || view.reading) return
    const thread = view.thread
    const childId = root.id === thread.id ? undefined : thread.id
    window.clearTimeout(threadTimer)
    const current = selection
    view.reading = true
    const initial = !view.transcript
    if (initial) updateTopbar()
    let retryDelay: number | undefined
    try {
      if (view.needsSnapshot) {
        const events = await api.read(root.id, current, childId)
        if (selection !== current || activeView !== view) return
        applyTranscript(0, events, view)
        view.needsSnapshot = false
      } else {
        const { change, thread: updated } = await api.update(root.id, current, childId)
        if (selection !== current) return
        if (updated?.id === thread.id) {
          view.thread = updated
          if (!childId) updateSelectedThread(updated)
        }
        if (change) {
          if (activeView !== view || !view.transcript || change.from > view.transcript.eventCount) {
            view.needsSnapshot = true
          } else {
            applyTranscript(change.from, change.events, view)
          }
        }
      }
      await lookupChildren(view)
    } catch (error) {
      if (selection !== current || activeView !== view) return
      const loading = conversation.getAttribute('aria-busy') === 'true'
      if (!view.needsSnapshot || loading) reportError(error, { silent: true })
      view.needsSnapshot = true
      retryDelay = IDLE_THREAD_INTERVAL_MS
      if (!view.transcript && loading) {
        showAgentThreadConversationState(
          conversation,
          thread.provider,
          'Couldn’t read this conversation.',
          requestRefresh,
        )
      }
    } finally {
      view.reading = false
      if (selection === current && activeView === view) {
        if (initial) updateTopbar()
        if (canUpdateConversation()) {
          const interval = view.thread.status === 'running' ? RUNNING_THREAD_INTERVAL_MS : IDLE_THREAD_INTERVAL_MS
          threadTimer = window.setTimeout(
            updateConversationVisibility,
            retryDelay ?? (view.needsSnapshot ? 0 : interval),
          )
        }
      }
    }
  }

  function updateConversationVisibility() {
    window.clearTimeout(threadTimer)
    if (canUpdateConversation()) requestRefresh()
  }

  function requestRefresh() {
    const operation = selected ? readThread() : refreshList()
    void operation.catch((error: unknown) => reportError(error))
  }

  function openThread(thread: AgentThread, fromMemory = '') {
    previousListTop = list.scrollTop
    clearSelection()
    selection = crypto.randomUUID()
    pendingMemoryThread = ''
    returnMemoryThread = fromMemory
    browser.hidden = true
    detail.hidden = false
    detail.dataset.provider = thread.provider
    detailProvider.replaceChildren(
      providerMark(thread.provider),
      document.createTextNode(agentProviderNames[thread.provider]),
    )
    updateSelectedThread(thread)
    switchConversation(thread)
    detailTitle.focus({ preventScroll: true })
  }

  function backToThreads() {
    if (!selected) return
    const id = selected.id
    clearSelection()
    selected = undefined
    conversation.replaceChildren()
    detail.hidden = true
    browser.hidden = false
    renderRoster()
    list.scrollTop = previousListTop
    updateTopbar()
    const opener = returnMemoryThread ? memoryThreadButton(returnMemoryThread) : undefined
    returnMemoryThread = ''
    ;(opener ?? rowButtons.get(id) ?? roster).focus({ preventScroll: true })
  }

  async function refreshList() {
    if (host.hidden || listing) return
    listing = true
    sync.textContent = 'Reading local sessions…'
    sync.dataset.state = ''
    updateTopbar()
    if (!loaded) renderRoster()
    try {
      const result = await api.list()
      if (disposed) return
      unavailable = new Set(result.unavailable)
      const incoming = new Map(result.threads.map(thread => [thread.id, thread]))
      for (const [id, thread] of threads) {
        if (!incoming.has(id) && unavailable.has(thread.provider)) incoming.set(id, thread)
      }
      threads = incoming
      if (projectFilter && ![...threads.values()].some(thread => projectOf(thread) === projectFilter))
        projectFilter = ''
      loaded = true
      listError = false
      lastChecked = Date.now()
      sync.textContent = unavailable.size
        ? `${unavailable.size} ${unavailable.size === 1 ? 'source' : 'sources'} unavailable`
        : 'Local snapshot'
      sync.title = `Checked ${timeFormat.format(lastChecked)}`
      sync.dataset.state = unavailable.size ? 'warning' : ''
    } catch (error) {
      if (disposed) return
      listError = true
      sync.textContent = 'Refresh failed'
      sync.title = reportError(error, { silent: true }).message
      sync.dataset.state = 'warning'
    } finally {
      listing = false
      if (!disposed) {
        updateTopbar()
        renderRoster()
        if (pendingMemoryThread && !host.hidden && !selected) {
          const id = pendingMemoryThread
          pendingMemoryThread = ''
          const thread = threads.get(id)
          if (thread) openThread(thread, id)
          else {
            memoryActivityStatus.hidden = false
            memoryActivityStatus.textContent = 'Couldn’t open that thread.'
          }
        }
      }
    }
  }

  function close() {
    if (host.hidden) return
    const previous = returnFocus
    returnFocus = null
    host.hidden = true
    updateMemorySampling()
    pendingMemoryThread = ''
    returnMemoryThread = ''
    memoryActivityStatus.hidden = true
    if (selected) {
      clearSelection()
      selected = undefined
      conversation.replaceChildren()
      detail.hidden = true
      browser.hidden = false
    }
    updateTopbar()
    onVisibilityChange?.(false)
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }

  requireElement(host, '[data-close]', HTMLButtonElement).addEventListener('click', close)
  sidebarToggle.addEventListener('click', () => {
    projectsToggled = true
    setProjectsOpen(!projectsOpen)
    if (projectsOpen) projectNav.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true })
  })
  back.addEventListener('click', backToThreads)
  delegateTablist.addEventListener('keydown', event => {
    const tabs = [...delegateTablist.querySelectorAll('button')]
    const current = tabs.findIndex(tab => tab === event.target)
    if (current < 0) return
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (current + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (current - 1 + tabs.length) % tabs.length
              : -1
    if (next < 0) return
    event.preventDefault()
    tabs[next]?.click()
  })
  refresh.addEventListener('click', () => {
    if (activeView) {
      activeView.needsSnapshot = true
      const lookup = childLookups.get(activeView.thread.id)
      if (lookup) lookup.checkedAt = 0
    }
    requestRefresh()
  })
  query.addEventListener('input', applyFilters)
  allAgents.addEventListener('click', () => {
    providerFilter = undefined
    applyFilters()
  })
  for (const [provider, { button }] of sources) {
    button.addEventListener('click', () => {
      providerFilter = providerFilter === provider ? undefined : provider
      applyFilters()
    })
  }
  running.addEventListener('click', () => {
    runningOnly = !runningOnly
    running.setAttribute('aria-pressed', String(runningOnly))
    applyFilters()
    if (runningOnly) requestRefresh()
  })
  host.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (event.target === query && query.value) {
      event.preventDefault()
      query.value = ''
      applyFilters()
      return
    }
    event.preventDefault()
    if (selected && activeView?.thread.id !== selected.id) switchConversation(selected, true)
    else if (selected) backToThreads()
    else close()
  })
  conversation.addEventListener('scroll', syncConversationScroll, { passive: true })
  conversation.addEventListener(
    'click',
    event => {
      if (event.target instanceof Element && event.target.closest('summary, button[aria-expanded]')) following = false
    },
    { capture: true },
  )
  conversation.addEventListener('toggle', () => requestAnimationFrame(syncConversationScroll), { capture: true })
  latest.addEventListener('click', () => {
    conversation.scrollTop = conversation.scrollHeight
    syncConversationScroll()
    conversation.focus({ preventScroll: true })
  })
  const transcriptSize = new ResizeObserver(() => {
    if (!observedTranscript || !canUpdateConversation()) return
    if (following) conversation.scrollTop = conversation.scrollHeight
    syncConversationScroll()
  })
  transcriptSize.observe(conversation)

  updateProjectLayout()
  compactProjects.addEventListener('change', updateProjectLayout)
  document.addEventListener('visibilitychange', updateMemorySampling)
  document.addEventListener('visibilitychange', updateConversationVisibility)

  return {
    open() {
      if (!host.hidden || disposed) return
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      host.hidden = false
      updateTopbar()
      onVisibilityChange?.(true)
      roster.focus({ preventScroll: true })
      requestRefresh()
      updateMemorySampling()
    },
    close,
    dispose() {
      close()
      disposed = true
      compactProjects.removeEventListener('change', updateProjectLayout)
      document.removeEventListener('visibilitychange', updateMemorySampling)
      document.removeEventListener('visibilitychange', updateConversationVisibility)
      transcriptSize.disconnect()
      minimap.dispose()
    },
  }
}
