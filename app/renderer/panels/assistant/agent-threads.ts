import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { agentProviderNames } from '../../../shared/agent-threads.ts'
import type { AgentProvider, AgentThread, AgentThreadEvent, AgentThreadFile } from '../../../shared/agent-threads.ts'
import { reportError } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import './agent-threads.css'

const glyphs = {
  activity: '<path d="M1.5 8h3l1.7-4.5 3.1 9 1.9-4.5h3.3"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
  folder:
    '<path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11z"/>',
  grid: '<rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/>',
  refresh:
    '<path d="M13 6a5.1 5.1 0 0 0-8.6-1.7L2.5 6m0 0h3.3M2.5 6V2.7M3 10a5.1 5.1 0 0 0 8.6 1.7l1.9-1.7m0 0h-3.3m3.3 0v3.3"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>',
  down: '<path d="M8 3.25v9.5m-3.75-3.75L8 12.75 11.75 9"/>',
  codex: '<path d="m4 4 3 4-3 4m5 0h3"/>',
  claude: '<path d="M8 2v12M2.8 5l10.4 6m0-6L2.8 11M5 2.8l6 10.4m0-10.4L5 13.2"/>',
  cursor: '<path d="m3.5 2.5 9 4.5-4 1-1.5 4.5zM8.5 8l4 4.5"/>',
  antigravity:
    '<path d="M8 2.25A6.5 6.5 0 0 0 13.75 8 6.5 6.5 0 0 0 8 13.75 6.5 6.5 0 0 0 2.25 8 6.5 6.5 0 0 0 8 2.25Z"/>',
}

const providers = ['codex', 'claude', 'antigravity', 'cursor'] satisfies AgentProvider[]
const eventLabels = { user: 'You', assistant: 'Assistant', tool: 'Tool', edit: 'File change', status: 'Status' }
const stateLabels = { running: 'Running', idle: 'Idle', recent: 'Recent', unknown: 'Unknown', stale: 'Stale' }
const MAX_EVENTS = 500
const REFRESH_MS = 3000
const NO_PROJECT = 'unassigned'
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

type ThreadState = keyof typeof stateLabels

interface ThreadPanelOptions {
  api: DiffpaneApi['agentThreads']
  openWorkspaceFile: (file: AgentThreadFile) => unknown
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

function projectOf(thread: AgentThread) {
  return thread.projectRoot ?? (thread.cwd || NO_PROJECT)
}

function workingFolder(cwd: string, project: string) {
  if (!cwd || cwd === project) return ''
  const name = basename(cwd)
  if (name !== basename(project)) return name
  // Linked checkouts can have the same name as the primary checkout.
  return cwd.match(/[^\\/]+[\\/][^\\/]+[\\/]*$/u)?.[0] ?? name
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text
}

function renderState(element: HTMLElement, state: ThreadState) {
  if (element.dataset.state !== state) element.dataset.state = state
  setText(element, stateLabels[state])
}

function renderTime(element: HTMLTimeElement, stamp: number, now: number) {
  const date = new Date(stamp)
  element.hidden = stamp <= 0 || !Number.isFinite(date.getTime())
  if (element.hidden) return
  const elapsed = Math.max(0, now - stamp)
  const label =
    elapsed < 60_000
      ? 'Now'
      : elapsed < 3_600_000
        ? `${Math.floor(elapsed / 60_000)}m`
        : elapsed < 86_400_000
          ? `${Math.floor(elapsed / 3_600_000)}h`
          : `${Math.floor(elapsed / 86_400_000)}d`
  const iso = date.toISOString()
  if (element.dateTime !== iso) {
    element.dateTime = iso
    element.title = timeFormat.format(stamp)
  }
  setText(element, label)
}

function createThreadRow(provider: AgentProvider) {
  const button = node('button', 'agent-thread-row')
  button.type = 'button'
  const mark = node('span', 'agent-thread-provider-mark')
  mark.dataset.provider = provider
  mark.innerHTML = icon(provider)
  const content = node('span', 'agent-thread-row-content')
  const title = node('strong', 'agent-thread-row-title')
  const activity = node('span', 'agent-thread-row-activity')
  const meta = node('span', 'agent-thread-row-meta')
  const state = node('span', 'agent-thread-state')
  const time = node('time', 'agent-thread-time')
  meta.append(state, time)
  content.append(title, activity)
  mark.title = agentProviderNames[provider]
  button.append(mark, content, meta)
  return { button, title, activity, state, time }
}

function createProject(path: string, name: string) {
  const group = node('section', 'agent-thread-group')
  const heading = node('header', 'agent-thread-group-heading')
  const title = node('h4', '', name)
  const summary = node('span', '')
  heading.innerHTML = icon('folder')
  heading.append(title, summary)
  heading.title = path === NO_PROJECT ? name : path
  group.append(heading)
  const button = node('button', 'agent-thread-project')
  button.type = 'button'
  button.title = heading.title
  button.innerHTML = icon('folder')
  const navTitle = node('span', 'agent-thread-project-name', name)
  const count = node('span', 'agent-thread-project-count')
  button.append(navTitle, count)
  const option = node('option', '', name)
  option.value = path
  return { group, summary, button, count, option }
}

export function createAgentThreadPanel(host: HTMLDialogElement, { api, openWorkspaceFile }: ThreadPanelOptions) {
  host.className = 'agent-threads'
  host.setAttribute('aria-labelledby', 'agent-threads-title')
  host.innerHTML = `
    <header class="agent-thread-header">
      <span class="agent-thread-header-mark">${icon('activity')}</span>
      <div class="agent-thread-header-title">
        <h2 id="agent-threads-title">Agent threads</h2>
        <p data-overview>Local agent activity</p>
      </div>
      <span class="agent-thread-sync" role="status" data-sync>Connecting…</span>
      <button class="agent-thread-icon" type="button" data-refresh aria-label="Refresh threads" title="Refresh threads">${icon('refresh')}</button>
      <button class="agent-thread-icon" type="button" data-close aria-label="Close agent threads" title="Close agent threads">${icon('close')}</button>
    </header>
    <div class="agent-thread-providers" role="group" aria-label="Filter by agent">
      ${providers
        .map(
          provider => `<button class="agent-thread-source" type="button" data-provider="${provider}" aria-pressed="false">
            <span class="agent-thread-provider-mark" data-provider="${provider}">${icon(provider)}</span>
            <span class="agent-thread-source-copy"><strong>${agentProviderNames[provider]}</strong><span data-source-count>Connecting…</span></span>
          </button>`,
        )
        .join('')}
    </div>
    <div class="agent-thread-layout">
      <nav class="agent-thread-projects" aria-label="Projects">
        <h3>Projects</h3>
        <div data-projects>
          <button class="agent-thread-project" type="button" data-all-projects aria-current="true">
            ${icon('grid')}<span class="agent-thread-project-name">All projects</span><span class="agent-thread-project-count"></span>
          </button>
        </div>
      </nav>
      <section class="agent-thread-roster" aria-label="Thread roster">
        <header class="agent-thread-roster-heading">
          <div class="agent-thread-roster-title">
            <h3>Threads</h3>
            <span data-matches></span>
            <select class="agent-thread-project-select" aria-label="Project"><option value="">All projects</option></select>
          </div>
          <div class="agent-thread-filters">
            <label class="agent-thread-search">${icon('search')}<input type="search" aria-label="Search threads" placeholder="Search threads" autofocus /></label>
            <button class="agent-thread-filter" type="button" aria-pressed="false" data-running>Running</button>
          </div>
        </header>
        <div class="agent-thread-list" tabindex="0" aria-label="Threads by project">
          <p class="agent-thread-empty" data-roster-empty>Finding local agent threads…</p>
        </div>
      </section>
      <section class="agent-thread-inspector" aria-label="Selected thread">
        <div class="agent-thread-inspector-empty">
          <span class="agent-thread-header-mark">${icon('activity')}</span>
          <p>Select a thread to see its activity.</p>
        </div>
        <header class="agent-thread-inspector-heading" hidden>
          <div class="agent-thread-inspector-meta">
            <span class="agent-thread-inspector-provider"></span>
            <span class="agent-thread-state"></span>
          </div>
          <h3></h3>
          <p class="agent-thread-cwd"></p>
        </header>
        <div class="agent-thread-activity-heading" hidden>
          <h4>Activity</h4>
          <span data-following></span>
          <button class="agent-thread-filter" type="button" data-latest hidden>${icon('down')}Latest</button>
        </div>
        <div class="agent-thread-events" role="log" aria-live="off" aria-label="Thread activity" tabindex="0" hidden></div>
        <section class="agent-thread-preview" aria-label="File preview" hidden>
          <header>
            <strong></strong>
            <button type="button" class="agent-thread-icon" data-close-preview aria-label="Close file preview" title="Close file preview">${icon('close')}</button>
          </header>
          <p hidden>Showing the first 256 KiB</p>
          <pre tabindex="0"></pre>
        </section>
      </section>
    </div>`

  const sync = requireElement(host, '[data-sync]', HTMLElement)
  const overview = requireElement(host, '[data-overview]', HTMLParagraphElement)
  const refresh = requireElement(host, '[data-refresh]', HTMLButtonElement)
  const query = requireElement(host, 'input[type=search]', HTMLInputElement)
  const running = requireElement(host, '[data-running]', HTMLButtonElement)
  const projectNav = requireElement(host, '[data-projects]', HTMLDivElement)
  const allProjects = requireElement(host, '[data-all-projects]', HTMLButtonElement)
  const projectSelect = requireElement(host, '.agent-thread-project-select', HTMLSelectElement)
  const totalProjectsCount = requireElement(allProjects, '.agent-thread-project-count', HTMLSpanElement)
  const matches = requireElement(host, '[data-matches]', HTMLElement)
  const list = requireElement(host, '.agent-thread-list', HTMLDivElement)
  const empty = requireElement(list, '[data-roster-empty]', HTMLParagraphElement)
  const sources = new Map(
    providers.map(provider => {
      const button = requireElement(host, `.agent-thread-source[data-provider="${provider}"]`, HTMLButtonElement)
      return [provider, { button, count: requireElement(button, '[data-source-count]', HTMLElement) }]
    }),
  )
  const inspectorEmpty = requireElement(host, '.agent-thread-inspector-empty', HTMLDivElement)
  const inspector = requireElement(host, '.agent-thread-inspector-heading', HTMLElement)
  const inspectorTitle = requireElement(inspector, 'h3', HTMLHeadingElement)
  const inspectorProvider = requireElement(inspector, '.agent-thread-inspector-provider', HTMLSpanElement)
  const inspectorState = requireElement(inspector, '.agent-thread-state', HTMLSpanElement)
  const inspectorCwd = requireElement(inspector, '.agent-thread-cwd', HTMLParagraphElement)
  const activityHeader = requireElement(host, '.agent-thread-activity-heading', HTMLDivElement)
  const following = requireElement(activityHeader, '[data-following]', HTMLSpanElement)
  const latest = requireElement(activityHeader, '[data-latest]', HTMLButtonElement)
  const events = requireElement(host, '.agent-thread-events', HTMLDivElement)
  const preview = requireElement(host, '.agent-thread-preview', HTMLElement)
  const previewTitle = requireElement(preview, 'strong', HTMLElement)
  const previewContents = requireElement(preview, 'pre', HTMLPreElement)
  const previewLimit = requireElement(preview, 'p', HTMLParagraphElement)
  const closePreview = requireElement(preview, '[data-close-preview]', HTMLButtonElement)

  const rows = new Map<string, ReturnType<typeof createThreadRow>>()
  const projects = new Map<string, ReturnType<typeof createProject>>()
  const threads = new Map<string, AgentThread>()
  let unavailable = new Set<AgentProvider>()
  let stale = false
  let loaded = false
  let providerFilter: AgentProvider | undefined
  let projectFilter = ''
  let runningOnly = false

  let subscription = ''
  let replaceHistory = false
  let listTimer = 0
  let listing = false
  let selected: AgentThread | undefined
  let selectedFile: AgentThreadFile | undefined
  let fileButton: HTMLButtonElement | undefined
  let fileRequest = 0
  let disposed = false

  function stateOf(thread: AgentThread): ThreadState {
    if (stale || unavailable.has(thread.provider) || !threads.has(thread.id)) return 'stale'
    return thread.status ?? 'unknown'
  }

  function stopFollowing() {
    const previous = subscription
    subscription = ''
    if (previous) void api.stop(previous).catch((error: unknown) => reportError(error, { silent: true }))
    fileRequest++
    selectedFile = undefined
    fileButton = undefined
    previewContents.textContent = ''
    preview.hidden = true
  }

  function showFollowError(error: unknown) {
    following.textContent = reportError(error, { silent: true }).message
  }

  async function readFile(file: AgentThreadFile, focus: boolean) {
    const current = subscription
    const request = ++fileRequest
    try {
      const result = await api.file(current, file.path)
      if (subscription !== current || request !== fileRequest) return
      if (result.kind === 'workspace') {
        if (focus) {
          close()
          try {
            await openWorkspaceFile({ ...file, path: result.path })
          } catch (error) {
            reportError(error)
          }
        }
        return
      }
      previewTitle.textContent = basename(file.path)
      previewTitle.title = file.path
      setText(previewContents, result.text)
      previewLimit.hidden = !result.limited
      preview.hidden = false
      if (focus) {
        previewContents.focus({ preventScroll: true })
        if (file.line) {
          const lineHeight = Number.parseFloat(getComputedStyle(previewContents).lineHeight)
          previewContents.scrollTop = (file.line - 1) * lineHeight
        }
      }
    } catch (error) {
      if (subscription === current && request === fileRequest) {
        if (focus) showFollowError(error)
        else if (!preview.hidden) previewContents.textContent = 'This file is no longer available.'
      }
    }
  }

  function renderEvent(event: AgentThreadEvent) {
    const article = node('article', 'agent-thread-event')
    article.dataset.kind = event.kind
    const label =
      event.kind === 'assistant' && selected ? agentProviderNames[selected.provider] : eventLabels[event.kind]
    article.append(node('h4', '', label), node('p', '', event.text))
    for (const file of event.files ?? []) {
      const link = node('button', 'agent-thread-file', `${basename(file.path)}${file.line ? `:${file.line}` : ''}`)
      link.type = 'button'
      link.title = file.path
      link.addEventListener('click', () => {
        if (!preview.hidden && selectedFile?.path !== file.path) preview.hidden = true
        fileButton = link
        selectedFile = file
        void readFile(file, true).catch(showFollowError)
      })
      article.append(link)
    }
    return article
  }

  function nearLatest() {
    return events.scrollHeight - events.scrollTop - events.clientHeight < 48
  }

  function scrollToLatest() {
    events.scrollTop = events.scrollHeight
    latest.hidden = true
  }

  function updateLatestButton() {
    latest.hidden = nearLatest()
  }

  const eventSize = new ResizeObserver(updateLatestButton)
  eventSize.observe(events)

  const unsubscribe = api.onUpdate(update => {
    if (!host.open || update.subscription !== subscription) return
    setText(
      following,
      update.error ?? (events.childElementCount || update.events.length ? 'Following' : 'Waiting for activity…'),
    )
    if (update.events.length) {
      const follow = nearLatest()
      const previousScroll = events.scrollTop
      const fragment = document.createDocumentFragment()
      for (const event of update.events.slice(-MAX_EVENTS)) fragment.append(renderEvent(event))
      if (replaceHistory) events.replaceChildren(fragment)
      else events.append(fragment)
      while (events.childElementCount > MAX_EVENTS) events.firstElementChild?.remove()
      if (follow) scrollToLatest()
      else {
        if (replaceHistory) events.scrollTop = previousScroll
        latest.hidden = nearLatest()
      }
      replaceHistory = false
    }
    if (!preview.hidden && selectedFile) {
      const path = selectedFile.path
      if (update.events.some(event => event.kind === 'edit' && event.files?.some(file => file.path === path)))
        void readFile(selectedFile, false).catch(showFollowError)
    }
  })

  function renderInspector() {
    if (!selected) return
    inspectorEmpty.hidden = true
    inspector.hidden = activityHeader.hidden = events.hidden = false
    setText(inspectorTitle, selected.title)
    inspectorTitle.title = selected.title
    setText(inspectorProvider, agentProviderNames[selected.provider])
    inspectorProvider.dataset.provider = selected.provider
    renderState(inspectorState, stateOf(selected))
    setText(inspectorCwd, selected.cwd || 'Working folder unavailable')
    inspectorCwd.title = selected.cwd
  }

  async function followThread(thread: AgentThread) {
    const sameThread = selected?.id === thread.id
    if (sameThread && subscription) return
    if (selected) rows.get(selected.id)?.button.setAttribute('aria-pressed', 'false')
    stopFollowing()
    selected = thread
    rows.get(thread.id)?.button.setAttribute('aria-pressed', 'true')
    replaceHistory = sameThread && Boolean(events.childElementCount)
    if (!replaceHistory) {
      events.replaceChildren()
      latest.hidden = true
    }
    renderInspector()
    const current = crypto.randomUUID()
    subscription = current
    setText(following, replaceHistory ? 'Reconnecting…' : 'Waiting for activity…')
    try {
      await api.follow(thread.id, current)
    } catch (error) {
      if (subscription !== current) return
      subscription = ''
      showFollowError(error)
    }
  }

  function selectProject(path: string) {
    projectFilter = path
    projectSelect.value = path
    applyFilters()
  }

  function applyFilters() {
    renderRoster()
    list.scrollTop = 0
  }

  function renderRoster() {
    const terms = query.value.trim().toLowerCase().split(/\s+/u)
    const now = Date.now()
    const counts = new Map<string, { visible: number; total: number; running: number }>()
    const byProvider = new Map(providers.map(provider => [provider, { total: 0, running: 0 }]))
    let totalRunning = 0
    let visible = 0
    for (const [id, thread] of threads) {
      const path = projectOf(thread)
      const name = path === NO_PROJECT ? 'No project' : basename(path)
      const state = stateOf(thread)
      const isRunning = state === 'running'
      let project = projects.get(path)
      if (!project) {
        project = createProject(path, name)
        projects.set(path, project)
        project.button.addEventListener('click', () => selectProject(path))
        projectNav.append(project.button)
        projectSelect.append(project.option)
        list.append(project.group)
      }

      let row = rows.get(id)
      if (!row) {
        row = createThreadRow(thread.provider)
        rows.set(id, row)
        row.button.addEventListener('click', () => {
          const current = threads.get(id)
          if (current) void followThread(current).catch(showFollowError)
        })
      }
      if (row.button.parentElement !== project.group) project.group.append(row.button)

      setText(row.title, thread.title)
      row.title.title = thread.title
      const description = [agentProviderNames[thread.provider], workingFolder(thread.cwd, path), thread.activity]
        .filter(Boolean)
        .join(' · ')
      setText(row.activity, description)
      row.activity.title = [agentProviderNames[thread.provider], thread.cwd, thread.activity]
        .filter(Boolean)
        .join(' · ')
      renderState(row.state, state)
      renderTime(row.time, thread.updatedAt, now)
      row.button.setAttribute('aria-pressed', String(selected?.id === id))
      const searchable = [thread.title, thread.activity, thread.cwd, path, agentProviderNames[thread.provider]]
        .join(' ')
        .toLowerCase()
      const matchesFilter =
        (!projectFilter || projectFilter === path) &&
        (!providerFilter || providerFilter === thread.provider) &&
        (!runningOnly || isRunning) &&
        terms.every(term => searchable.includes(term))
      if (!matchesFilter && document.activeElement === row.button) query.focus({ preventScroll: true })
      row.button.hidden = !matchesFilter

      const provider = byProvider.get(thread.provider)
      if (provider) {
        provider.total++
        if (isRunning) provider.running++
      }
      const count = counts.get(path) ?? { visible: 0, total: 0, running: 0 }
      count.total++
      if (isRunning) {
        totalRunning++
        count.running++
      }
      if (matchesFilter) {
        visible++
        count.visible++
      }
      counts.set(path, count)
    }
    for (const [id, row] of rows) {
      if (threads.has(id)) continue
      if (document.activeElement === row.button) query.focus({ preventScroll: true })
      row.button.remove()
      rows.delete(id)
    }
    for (const [path, project] of projects) {
      const count = counts.get(path)
      if (!count) {
        if (document.activeElement === project.button) allProjects.focus({ preventScroll: true })
        project.group.remove()
        project.button.remove()
        project.option.remove()
        projects.delete(path)
        continue
      }
      setText(project.count, count.running ? `${count.running} running` : String(count.total))
      project.count.dataset.active = String(Boolean(count.running))
      project.count.title = threadCount(count.total)
      setText(
        project.summary,
        count.running ? `${count.running} running · ${threadCount(count.total)}` : threadCount(count.total),
      )
      project.button.setAttribute('aria-current', String(projectFilter === path))
      project.group.hidden = !count.visible
    }
    allProjects.setAttribute('aria-current', String(!projectFilter))
    setText(totalProjectsCount, String(threads.size))
    setText(matches, loaded ? String(visible) : '')
    if (loaded) {
      const projectTotal = counts.size - Number(counts.has(NO_PROJECT))
      setText(
        overview,
        `${totalRunning} running · ${threadCount(threads.size)} · ${projectTotal} ${projectTotal === 1 ? 'project' : 'projects'}`,
      )
    }
    empty.hidden = visible > 0
    if (!empty.hidden) {
      setText(
        empty,
        threads.size
          ? 'No threads match these filters.'
          : loaded
            ? 'No local agent threads found.'
            : 'Finding local agent threads…',
      )
    }
    for (const [provider, source] of sources) {
      const count = byProvider.get(provider)
      const status = stale || unavailable.has(provider) ? (count?.total ? 'Stale' : 'Unavailable') : ''
      source.button.setAttribute('aria-pressed', String(providerFilter === provider))
      setText(
        source.count,
        status || (loaded && count ? `${count.running} running · ${count.total} total` : 'Connecting…'),
      )
      source.button.dataset.status = status.toLowerCase()
    }
    if (selected) {
      selected = threads.get(selected.id) ?? selected
      renderInspector()
    }
  }

  async function refreshList() {
    if (!host.open || listing) return
    window.clearTimeout(listTimer)
    listing = true
    try {
      const result = await api.list()
      if (!host.open || disposed) return
      unavailable = new Set(result.unavailable)
      stale = false
      const incoming = new Map(result.threads.map(thread => [thread.id, thread]))
      for (const [id, thread] of threads) {
        if (!incoming.has(id) && !unavailable.has(thread.provider)) threads.delete(id)
      }
      for (const [id, thread] of incoming) threads.set(id, thread)
      if (projectFilter && ![...threads.values()].some(thread => projectOf(thread) === projectFilter)) {
        projectFilter = ''
        projectSelect.value = ''
      }
      loaded = true
      const online = providers.length - unavailable.size
      sync.title = ''
      sync.dataset.state = online === providers.length ? 'live' : online ? 'partial' : 'offline'
      setText(
        sync,
        online === providers.length
          ? 'Updating live'
          : online
            ? `${online} of ${providers.length} sources available`
            : 'Sources unavailable',
      )
      renderRoster()
      if (!subscription) {
        const current = selected
          ? threads.get(selected.id)
          : [...threads.values()].find(thread => stateOf(thread) !== 'stale')
        if (current && stateOf(current) !== 'stale') void followThread(current).catch(showFollowError)
      }
    } catch (error) {
      if (!host.open || disposed) return
      stale = true
      sync.dataset.state = 'offline'
      setText(sync, 'Retrying sources…')
      sync.title = reportError(error, { silent: true }).message
      renderRoster()
    } finally {
      listing = false
      if (host.open && !disposed) listTimer = window.setTimeout(requestRefresh, REFRESH_MS)
    }
  }

  function requestRefresh() {
    void refreshList().catch((error: unknown) => reportError(error))
  }

  function stopUpdates() {
    window.clearTimeout(listTimer)
    stopFollowing()
  }

  function close() {
    if (!host.open) return
    stopUpdates()
    host.close()
  }

  host.addEventListener('close', () => {
    if (!host.open) stopUpdates()
  })
  requireElement(host, '[data-close]', HTMLButtonElement).addEventListener('click', close)
  refresh.addEventListener('click', requestRefresh)
  query.addEventListener('input', applyFilters)
  allProjects.addEventListener('click', () => selectProject(''))
  projectSelect.addEventListener('change', () => selectProject(projectSelect.value))
  running.addEventListener('click', () => {
    runningOnly = !runningOnly
    running.setAttribute('aria-pressed', String(runningOnly))
    applyFilters()
  })
  for (const [provider, { button }] of sources) {
    button.addEventListener('click', () => {
      providerFilter = providerFilter === provider ? undefined : provider
      applyFilters()
    })
  }
  events.addEventListener('scroll', updateLatestButton)
  latest.addEventListener('click', () => {
    scrollToLatest()
    events.focus({ preventScroll: true })
  })
  closePreview.addEventListener('click', () => {
    fileRequest++
    selectedFile = undefined
    preview.hidden = true
    if (fileButton?.isConnected) fileButton.focus()
    else events.focus()
  })

  return {
    open() {
      if (host.open || disposed) return
      host.showModal()
      requestRefresh()
    },
    close,
    dispose() {
      disposed = true
      close()
      stopUpdates()
      eventSize.disconnect()
      unsubscribe()
    },
  }
}
