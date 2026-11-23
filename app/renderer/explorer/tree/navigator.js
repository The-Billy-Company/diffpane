// Copyright (c) 2026 The Billy Company
import { IDEA_FILE_DRAG_TYPE } from '../../../shared/ideas/ideas.ts'
// MONOLITHIC: Incremental tree reconciliation, virtualized rows and keyboard focus share one navigation state. Extract the viewport once focus restoration and expansion can be verified at its boundary.
import { attemptAsync } from '../../../shared/recovery/app-errors.ts'
import { rendererDiagnostics } from '../../shell/diagnostics/diagnostics.ts'
import { reportError, runTask } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { createChangeRail } from '../change-rail/change-rail.ts'
import { createSearchFilters, filterPredicate, hasFilters } from '../project-search/search-filters.ts'
import { drawNavigatorArt } from './art/navigator-art.ts'
import { createFileActions } from './file-actions.ts'
import { applyNavigationDelta, reconcileNavigationTree } from './navigation-reconcile.ts'

/**
 * @import { NavigationFile, NavigationNode, NavigationTree } from './navigation-reconcile.ts'
 * @import { SearchFilters, LanguageFor } from '../project-search/search-filters.ts'
 * @import { InventoryUpdate } from '../../../backend/runtime/session/inventory-delta.ts'
 * @import { ShortcutAction } from '../../../shared/preferences/shortcuts.ts'
 * @import { ChangeKind } from '../change-rail/change-rail.ts'
 * @import { ChangePosition } from '../../review/comparison/review-focus.js'
 */
/** @typedef {{ node: NavigationNode, depth: number }} NavigationRow */
/** @typedef {{ path: string } & ({ kind: 'file', requested: Set<string> } | { kind: 'directory' | 'selection' })} RevealRequest */
/**
 * @typedef {{
 *   root: string,
 *   scope?: string | null,
 *   files: NavigationFile[],
 *   initialPath?: string | null,
 *   revision?: number,
 *   inventoryRevision?: number,
 *   changedPaths?: string[],
 *   error?: undefined,
 * }} NavigatorSnapshot
 */
/**
 * @typedef {{
 *   files: () => Promise<NavigationFile[]>,
 *   filesDelta?: (revision: number | null) => Promise<InventoryUpdate>,
 *   directoryExpanded?: (path: string, expanded: boolean) => Promise<unknown>,
 *   fileAction: Parameters<typeof createFileActions>[0]['fileAction'],
 * }} NavigatorApi
 */
/**
 * @typedef {{
 *   iconFor?: (node: NavigationNode, expanded: boolean) => string | undefined,
 *   onOpenChange?: (file: NavigationFile, position: ChangePosition) => unknown,
 *   onPick?: () => unknown,
 *   onFolder?: () => unknown,
 *   onOutline?: (element: HTMLElement) => unknown,
 *   onMutate?: (action: string, path: string, name?: string) => Promise<unknown>,
 *   onAttach?: Parameters<typeof createFileActions>[3],
 *   languageFor?: LanguageFor,
 *   onInitialScan?: (ready: boolean) => unknown,
 *   onReady?: () => unknown,
 *   matchesShortcut?: (event: KeyboardEvent, action: ShortcutAction) => boolean,
 * }} NavigatorOptions
 */

const ROW_HEIGHT = 24
const OVERSCAN_VIEWPORTS = 2
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** @type {Readonly<Record<string, string>>} */
const STATUS_LABELS = {
  '!': 'Merge conflict',
  A: 'Added',
  C: 'Copied',
  D: 'Deleted',
  M: 'Edited',
  R: 'Moved',
  RM: 'Moved and edited',
  T: 'Type changed',
  U: 'Untracked',
}
/** @type {Readonly<Partial<Record<string, ChangeKind>>>} */
const MARK_KINDS = {
  '!': 'conflict',
  A: 'added',
  D: 'removed',
  R: 'moved',
  RM: 'moved-edited',
  U: 'added',
}
let instance = 0

const ICONS = {
  openFile:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.5 1.5H2v13h5m1.5-13L12 5H8.5V1.5ZM12 8v7m-3.5-3.5h7" stroke="currentColor" stroke-linejoin="round"/></svg>',
  openFolder:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7 13.5H1.5v-11h4L7 4h7.5v3M1.5 6.5h13M12 9v6m-3-3h6" stroke="currentColor" stroke-linejoin="round"/></svg>',
  collapse:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 3H3v8h2m1-6h7v8H6V5Zm2 4h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.8 6.3A5 5 0 1 0 12.4 11m.4-4.7V3.4m0 2.9H9.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.9" cy="6.9" r="4" stroke="currentColor" stroke-width="1.2"/><path d="m10 10 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
}

/**
 * Build metadata for the explorer.
 * @param {NavigationFile[]} inventory
 * @param {string} [basePath]
 * @returns {NavigationTree}
 */
export function buildNavigationTree(inventory, basePath = '') {
  /** @type {NavigationNode} */
  const root = {
    key: `dir:${basePath}`,
    path: basePath,
    name: '',
    kind: 'directory',
    parentKey: null,
    children: [],
    changedCount: 0,
  }
  /** @type {NavigationTree} */
  const tree = { root, nodes: new Map([[root.key, root]]), files: new Map(), directories: new Map() }
  return reconcileNavigationTree(tree, inventory, basePath) ?? tree
}

/** @param {NavigationNode} folder */
function singleSubfolder(folder) {
  const children = folder.children
  const child = !folder.file?.ignored && children?.length === 1 ? children[0] : undefined
  return child?.kind === 'directory' && !child.file?.ignored ? child : undefined
}

/** @param {NavigationNode} folder @param {Set<string>} expanded */
export function expandFolderChain(folder, expanded) {
  let changed = false
  /** @type {NavigationNode | undefined} */
  let current = folder
  while (current) {
    if (!expanded.has(current.path)) {
      expanded.add(current.path)
      changed = true
    }
    current = singleSubfolder(current)
  }
  return changed
}

/** @param {NavigationNode} root @param {Set<string>} expanded */
export function expandInitialFolderChains(root, expanded) {
  if (!expanded.has(root.path)) return
  const onlyFolder = singleSubfolder(root)
  if (onlyFolder) expandFolderChain(onlyFolder, expanded)
  else {
    for (const child of root.children ?? []) {
      if (singleSubfolder(child)) expandFolderChain(child, expanded)
    }
  }
}

/**
 * @param {NavigationTree} tree
 * @param {ReadonlySet<string>} expanded
 * @param {string} [query]
 * @param {SearchFilters} [filters]
 * @param {LanguageFor} [languageFor]
 * @returns {NavigationRow[]}
 */
export function flattenNavigationTree(tree, expanded, query = '', filters, languageFor) {
  if (query || (filters && hasFilters(filters))) {
    const needle = query.toLocaleLowerCase()
    const matches = filters && filterPredicate(filters, languageFor)
    /** @type {NavigationRow[]} */
    const results = []
    /** @param {NavigationNode[]} nodes @param {boolean} directory */
    const scan = (nodes, directory) => {
      for (const node of nodes) {
        const folded = (node.searchPath ??= node.path.toLocaleLowerCase())
        if (needle && !folded.includes(needle)) continue
        if (!matches || matches({ path: node.path, directory }, folded)) results.push({ node, depth: 1 })
      }
    }
    if (filters?.kind !== 'folders') {
      if (!tree.searchFiles) {
        tree.searchFiles = [...tree.files.values()]
        tree.searchFiles.sort((a, b) => COLLATOR.compare(a.path, b.path))
      }
      scan(tree.searchFiles, false)
    }
    if (filters?.kind !== 'files' && !filters?.language && !filters?.extension) {
      tree.searchDirectories ??= [...tree.nodes.values()].filter(node => node.children && node !== tree.root)
      scan(tree.searchDirectories, true)
    }
    return results
  }
  /** @type {NavigationRow[]} */
  const visible = []
  const stack = [{ node: tree.root, depth: 0 }]
  for (let row = stack.pop(); row; row = stack.pop()) {
    visible.push(row)
    const children = row.node.children
    if (children && expanded.has(row.node.path)) {
      for (let index = children.length - 1; index >= 0; index--) {
        const node = children[index]
        if (node) stack.push({ node, depth: row.depth + 1 })
      }
    }
  }
  return visible
}

/** @param {NavigationFile | null | undefined} file */
export function navigationStatus(file) {
  if (file?.conflicted) return '!'
  const { index, worktree, renameEdited } = file ?? {}
  const status = worktree && ![' ', '.'].includes(worktree) ? worktree : index
  if (status === 'R' || (index === 'R' && (status === 'M' || status === 'T'))) {
    return renameEdited || status === 'M' || status === 'T' || index === 'M' || index === 'T' ? 'RM' : 'R'
  }
  return !status || [' ', '.'].includes(status) ? '' : status === '?' ? 'U' : status
}

/**
 * Check a folder's direct files before descending into a changed subfolder.
 * @param {NavigationNode} folder
 * @param {ChangePosition} position
 */
export function findChangedFile(folder, position) {
  const find = position === 'first' ? 'find' : 'findLast'
  for (let children = folder.children; children;) {
    const file = children[find](child => child.kind === 'file' && child.changedCount > 0)
    if (file) return file
    children = children[find](child => child.changedCount > 0)?.children ?? null
  }
  return undefined
}

/** @param {string | null | undefined} path */
function lastPathSegment(path) {
  return path?.split(/[\\/]/).findLast(segment => segment.length > 0) ?? ''
}

/** @param {NavigatorSnapshot} snapshot */
function scopePrefix(snapshot) {
  const root = snapshot.root?.replaceAll('\\', '/').replace(/\/$/, '') ?? ''
  const scope = snapshot.scope?.replaceAll('\\', '/').replace(/\/$/, '') ?? root
  return scope.startsWith(`${root}/`) ? scope.slice(root.length + 1) : ''
}

/** @param {HTMLElement} label @param {string} text @param {number} offset @param {RegExpExecArray | null} match */
function renderSearchText(label, text, offset, match) {
  const start = match ? Math.max(0, match.index - offset) : text.length
  const end = match ? Math.min(text.length, match.index + match[0].length - offset) : 0
  if (end <= start) {
    if (label.firstElementChild || label.textContent !== text) label.textContent = text
    return
  }
  const mark = document.createElement('mark')
  mark.textContent = text.slice(start, end)
  label.replaceChildren(text.slice(0, start), mark, text.slice(end))
}

/**
 * @param {HTMLElement} container
 * @param {NavigatorApi} api
 * @param {(file: NavigationFile) => unknown} onOpen
 * @param {NavigatorOptions} [options]
 */
export function createNavigator(
  container,
  api,
  onOpen,
  {
    iconFor,
    onOpenChange = file => onOpen(file),
    onPick,
    onFolder,
    onOutline,
    onMutate,
    onAttach,
    languageFor,
    onInitialScan,
    onReady,
    matchesShortcut,
  } = {},
) {
  const id = ++instance
  container.classList.add('navigator')
  container.style.setProperty('--navigator-row-height', `${ROW_HEIGHT}px`)
  container.setAttribute('aria-label', 'Project explorer')
  container.dataset.searching = 'false'
  container.innerHTML = `
    <div class="navigator-heading">
      <button type="button" class="navigator-root" data-action="root" aria-expanded="true">
        <span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-project">Project</span>
      </button>
      <div class="navigator-actions">
        <button type="button" class="navigator-action" data-action="open-file" aria-label="Search files" title="Search files">${ICONS.openFile}</button>
        <button type="button" class="navigator-action" data-action="open-folder" aria-label="Open folder" title="Open folder">${ICONS.openFolder}</button>
        <button type="button" class="navigator-action" data-action="refresh" aria-label="Refresh explorer" title="Refresh explorer">${ICONS.refresh}</button>
        <button type="button" class="navigator-action" data-action="collapse" aria-label="Collapse folders" title="Collapse folders">${ICONS.collapse}</button>
      </div>
    </div>
    <div class="navigator-controls">
      <div class="navigator-search">
        ${ICONS.search}
        <input type="search" placeholder="Find files…" aria-label="Find files or folders in explorer" spellcheck="false" autocomplete="off">
      </div>
      <div class="navigator-filter-host"></div>
      <div class="navigator-summary" role="status">Reading files…</div>
    </div>
    <div class="navigator-tree-region">
      <div class="navigator-tree" id="navigator-${id}-tree" role="tree" aria-label="Project files" tabindex="0">
        <div class="navigator-rows"><div class="navigator-branch-trace" aria-hidden="true"></div></div>
      </div>
      <div class="navigator-empty" hidden>
        <svg viewBox="0 0 84 56" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>
        <p>No project files yet</p>
      </div>
    </div>
    <details class="navigator-outline"><summary>Outline</summary><div class="symbol-list navigator-symbols"></div></details>
    <div class="navigator-footer"><span>Project files</span><span class="navigator-total"></span></div>`
  const list = requireElement(container, '.navigator-tree', HTMLDivElement)
  const changeRail = createChangeRail(list, ROW_HEIGHT, index => visible[index]?.node.name)
  list.after(changeRail.rail)
  const rows = requireElement(container, '.navigator-rows', HTMLDivElement)
  const branchTrace = requireElement(rows, '.navigator-branch-trace', HTMLDivElement)
  const input = requireElement(container, 'input', HTMLInputElement)
  const summary = requireElement(container, '.navigator-summary', HTMLDivElement)
  const empty = requireElement(container, '.navigator-empty', HTMLDivElement)
  const emptyArt = requireElement(empty, 'svg', SVGSVGElement)
  const emptyLabel = requireElement(empty, 'p', HTMLParagraphElement)
  const total = requireElement(container, '.navigator-total', HTMLSpanElement)
  const refreshButton = requireElement(container, '[data-action="refresh"]', HTMLButtonElement)
  const rootButton = requireElement(container, '[data-action="root"]', HTMLButtonElement)
  const outline = requireElement(container, '.navigator-outline', HTMLDetailsElement)
  const heading = requireElement(container, '.navigator-heading', HTMLDivElement)
  const project = requireElement(container, '.navigator-project', HTMLSpanElement)
  const symbols = requireElement(outline, '.symbol-list', HTMLDivElement)
  function onOutlineToggle() {
    if (outline.open) runTask('Show navigator outline', () => onOutline?.(symbols))
  }
  outline.addEventListener('toggle', onOutlineToggle)
  let tree = buildNavigationTree([])
  let expanded = new Set([''])
  /** @type {NavigationRow[]} */
  let visible = []
  /** @type {Map<string, number>} */
  let visibleIndex = new Map()
  /** @type {NavigatorSnapshot | null} */
  let snapshot = null
  /** @type {string | null} */
  let key = null
  /** @type {number | undefined} */
  let inventoryRevision
  /** @type {number | null} */
  let appliedInventoryRevision = null
  let inventoryReady = false
  let expandOnLoad = true
  /** @type {string | null} */
  let activeKey = tree.root.key
  /** @type {string | null} */
  let selectedPath = null
  /** @type {number | undefined | null} */
  let tracedIndex = null
  const tracedParents = new Set()
  /** @type {RevealRequest | null} */
  let revealPath = null
  /** @type {Set<NavigationNode>} */
  let statusNodes = new Set()
  /** @type {Map<NavigationNode, 'R' | 'RM'>} */
  const folderMoves = new Map()
  /** @type {Map<string, NavigationFile>} */
  let changes = new Map()
  let loading = false
  let wanted = 0
  let disposed = false
  /** @type {number | null} */
  let frame = null
  let query = ''
  /** @type {RegExp | null} */
  let queryPattern = null
  let catalogRequests = 0
  let rowRevision = 0
  let changeRailDirty = true
  /** @type {Map<string, HTMLDivElement>} */
  const mounted = new Map()
  /** @type {WeakMap<HTMLDivElement, number>} */
  const rowRevisions = new WeakMap()
  const filters = createSearchFilters(
    requireElement(container, '.navigator-filter-host', HTMLDivElement),
    `navigator-${id}-search-filters`,
    () => onSearch(false),
    languageFor,
  )
  const actions = createFileActions(
    api,
    async (action, pathname, name) => {
      if (action === 'open') {
        const node = tree.files.get(pathname) ?? tree.nodes.get(`dir:${pathname}`)
        if (node) choose(node)
      } else if (action === 'first-change' || action === 'last-change') {
        const folder = tree.nodes.get(`dir:${pathname}`)
        const position = action === 'first-change' ? 'first' : 'last'
        const node = folder && findChangedFile(folder, position)
        const file = node && changes.get(node.path)
        if (!file) return
        reveal({ path: file.path, kind: 'file', requested: new Set() })
        await onOpenChange(file, position)
      } else await onMutate?.(action, pathname, name)
    },
    message => {
      summary.textContent = message
      container.dataset.searching = 'true'
    },
    onAttach,
  )
  function searching() {
    return Boolean(query) || filters.active()
  }

  function schedule() {
    if (frame !== null || disposed) return
    frame = requestAnimationFrame(() => {
      frame = null
      render()
    })
  }

  function refreshProjection(preserve = true, refineSearch = false) {
    rowRevision++
    changeRailDirty = true
    tracedIndex = null
    const index = Math.floor(list.scrollTop / ROW_HEIGHT)
    const anchor = preserve ? visible[index]?.node.key : null
    const offset = list.scrollTop % ROW_HEIGHT
    const filterState = filters.value()
    const showingResults = Boolean(query) || hasFilters(filterState)
    visible = refineSearch
      ? visible.filter(({ node }) => node.searchPath?.includes(query))
      : flattenNavigationTree(tree, expanded, query, filterState, languageFor)
    if (!showingResults) visible.shift()
    container.dataset.results = String(showingResults)
    container.dataset.searching = String(showingResults || document.activeElement === input)
    visibleIndex = new Map()
    for (let position = 0; position < visible.length; position++) {
      const item = visible[position]
      if (item) visibleIndex.set(item.node.key, position)
    }
    rootButton.setAttribute('aria-expanded', String(expanded.has(tree.root.path)))
    if (activeKey === null || !visibleIndex.has(activeKey)) activeKey = visible[0]?.node.key ?? null
    // Restore against the new scroll range so inserted rows do not clamp the anchor.
    rows.style.height = `${visible.length * ROW_HEIGHT}px`
    if (anchor) {
      const next = visibleIndex.get(anchor)
      if (next !== undefined) list.scrollTop = next * ROW_HEIGHT + offset
    }
    delete summary.dataset.state
    summary.removeAttribute('title')
    if (showingResults)
      summary.textContent = visible.length
        ? `${visible.length.toLocaleString()} matching ${visible.length === 1 ? 'item' : 'items'}`
        : 'No matching files or folders'
    else
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`
    total.textContent = tree.files.size.toLocaleString()
    render()
  }

  /** @param {boolean} showingResults */
  function renderBranchTrace(showingResults) {
    const index = showingResults || selectedPath === null ? undefined : visibleIndex.get(`file:${selectedPath}`)
    if (index === tracedIndex) return
    tracedIndex = index
    tracedParents.clear()
    const segments = document.createDocumentFragment()
    for (let childIndex = index; childIndex !== undefined;) {
      const child = visible[childIndex]
      if (!child?.node.parentKey) break
      const parentIndex = visibleIndex.get(child.node.parentKey)
      if (parentIndex === undefined) break
      tracedParents.add(child.node.parentKey)

      const segment = document.createElement('span')
      segment.className = 'navigator-branch-segment'
      segment.classList.toggle('is-leaf', child.node.kind === 'file')
      segment.style.setProperty('--navigator-depth', String(child.depth - 1))
      const chevronClearance = 6
      segment.style.top = `${parentIndex * ROW_HEIGHT + ROW_HEIGHT / 2 + chevronClearance}px`
      segment.style.height = `${(childIndex - parentIndex) * ROW_HEIGHT - chevronClearance + 1}px`
      segments.appendChild(segment)
      childIndex = parentIndex
    }
    branchTrace.replaceChildren(segments)
  }

  /** @returns {Generator<{ row: number; kind: ChangeKind }>} */
  function* changeMarks() {
    const folders = new Set()
    for (const [path, file] of changes) {
      const node = tree.files.get(path)
      if (!node) continue
      const row = visibleIndex.get(node.key)
      if (row !== undefined) {
        yield { row, kind: MARK_KINDS[navigationStatus(file)] ?? 'modified' }
        continue
      }

      // Represent hidden descendants at their nearest visible folder.
      for (let parent = node.parentKey; parent !== null; parent = tree.nodes.get(parent)?.parentKey ?? null) {
        if (folders.has(parent)) break
        const folderRow = visibleIndex.get(parent)
        if (folderRow === undefined) continue
        folders.add(parent)
        yield { row: folderRow, kind: 'folder' }
        break
      }
    }
  }

  function render() {
    if (disposed || container.hidden) return
    const height = list.clientHeight || 400
    // Keep rows ready while native scrolling advances ahead of the next render.
    const overscan = Math.ceil(height / ROW_HEIGHT) * OVERSCAN_VIEWPORTS
    const scrollTop = list.scrollTop
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan)
    const end = Math.min(visible.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + overscan)
    const showingResults = searching()
    empty.hidden =
      !inventoryReady ||
      loading ||
      summary.dataset.state === 'error' ||
      visible.length > 0 ||
      (!showingResults && Boolean(tree.root.children?.length))
    if (!empty.hidden) {
      emptyLabel.hidden = showingResults
      drawNavigatorArt(emptyArt, showingResults)
    }
    if (changeRailDirty) {
      changeRail.setMarks(visible.length, showingResults ? [] : changeMarks())
      changeRailDirty = false
    }
    changeRail.sync()
    renderBranchTrace(showingResults)
    const retained = new Set()
    let activeId = null
    for (let index = start; index < end; index++) {
      const item = visible[index]
      if (!item) continue
      const { node, depth } = item
      retained.add(node.key)
      let row = mounted.get(node.key)
      if (!row) {
        row = document.createElement('div')
        row.className = 'navigator-row'
        row.setAttribute('role', 'treeitem')
        row.dataset.key = node.key
        row.dataset.path = node.path
        row.dataset.kind = node.kind
        row.draggable = Boolean(onAttach && node.kind === 'file')
        row.innerHTML =
          '<span class="navigator-chevron" aria-hidden="true"></span><span class="navigator-icon"></span><span class="navigator-name"></span><span class="navigator-directory"></span>'
        mounted.set(node.key, row)
        rows.appendChild(row)
      }
      const active = node.key === activeKey
      if (active) activeId = `navigator-${id}-row-${index}`
      const activeState = String(active)
      if (row.dataset.active !== activeState) row.dataset.active = activeState
      const onSelectedPath = tracedParents.has(node.key)
      if (row.hasAttribute('data-selected-ancestor') !== onSelectedPath)
        row.toggleAttribute('data-selected-ancestor', onSelectedPath)
      const selected = String(node.kind === 'file' && node.path === selectedPath)
      if (row.getAttribute('aria-selected') !== selected) row.setAttribute('aria-selected', selected)
      if (rowRevisions.get(row) === rowRevision) continue
      rowRevisions.set(row, rowRevision)
      row.id = `navigator-${id}-row-${index}`
      row.style.top = `${index * ROW_HEIGHT}px`
      row.style.setProperty('--navigator-depth', String(depth))
      row.setAttribute('aria-level', String(depth + 1))
      if (node.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(node.path)))
      const file = changes.get(node.path) ?? node.file
      const status = node.kind === 'file' ? navigationStatus(file) : (folderMoves.get(node) ?? '')
      row.dataset.status = status
      row.dataset.changed = String(node.changedCount > 0)
      row.dataset.ignored = String(node.file?.ignored === true)
      let description = status ? (STATUS_LABELS[status] ?? 'Changed') : ''
      if (node.kind === 'directory' && node.changedCount) {
        description = `${node.changedCount} changed ${node.changedCount === 1 ? 'file' : 'files'}`
        if (status === 'R') description += '. Contains a move'
        else if (status === 'RM') description += '. Contains a move with edits'
      }
      const titlePath = node.path || (snapshot?.scope ?? snapshot?.root ?? '')
      row.title = description ? `${titlePath}\n${description}` : titlePath
      if (description) row.setAttribute('aria-description', description)
      else row.removeAttribute('aria-description')
      const glyph = iconFor?.(node, expanded.has(node.path))
      const icon = requireElement(row, '.navigator-icon', HTMLSpanElement)
      if (glyph && icon.dataset.glyph !== glyph) {
        const image = document.createElement('img')
        image.src = glyph
        image.alt = ''
        image.draggable = false
        icon.replaceChildren(image)
        icon.dataset.glyph = glyph
      }
      const name = node.name || lastPathSegment(snapshot?.scope) || lastPathSegment(snapshot?.root) || 'Project'
      const directory = showingResults ? node.path.slice(0, node.path.lastIndexOf('/') + 1) : ''
      const match = query && queryPattern ? queryPattern.exec(node.path) : null
      renderSearchText(requireElement(row, '.navigator-name', HTMLSpanElement), name, directory.length, match)
      renderSearchText(requireElement(row, '.navigator-directory', HTMLSpanElement), directory, 0, match)
    }
    for (const [pathname, row] of mounted) {
      if (!retained.has(pathname)) {
        row.remove()
        mounted.delete(pathname)
      }
    }
    if (list.getAttribute('aria-activedescendant') !== activeId) {
      if (activeId) list.setAttribute('aria-activedescendant', activeId)
      else list.removeAttribute('aria-activedescendant')
    }
  }

  function markChanges() {
    for (const node of statusNodes) node.changedCount = 0
    statusNodes = new Set()
    folderMoves.clear()
    for (const file of snapshot?.files ?? []) {
      const status = navigationStatus(file)
      const moved = status === 'R' || status === 'RM'
      let node = tree.files.get(file.path)
      while (node) {
        if (moved && node.kind === 'directory' && folderMoves.get(node) !== 'RM') folderMoves.set(node, status)
        node.changedCount++
        statusNodes.add(node)
        node = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
      }
    }
  }

  /** @param {string} pathname */
  function ensureVisible(pathname, focus = false, directory = false) {
    const folder = tree.nodes.get(`dir:${pathname}`)
    const node = directory ? folder : (tree.files.get(pathname) ?? folder)
    if (!node) return false
    let projectionChanged = directory && setExpanded(node, true)
    let parent = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
    while (parent) {
      if (!expanded.has(parent.path)) projectionChanged = true
      expanded.add(parent.path)
      parent = parent.parentKey === null ? undefined : tree.nodes.get(parent.parentKey)
    }
    if (!filters.matches({ path: node.path, directory: node.kind === 'directory' })) {
      filters.reset()
      projectionChanged = true
    }
    if (query && !pathname.toLocaleLowerCase().includes(query)) {
      input.value = ''
      query = ''
      projectionChanged = true
    }
    activeKey = node.key
    if (projectionChanged || !visibleIndex.has(node.key)) refreshProjection()
    scrollToActive()
    if (focus) list.focus()
    return true
  }

  function scrollToActive() {
    const index = activeKey === null ? undefined : visibleIndex.get(activeKey)
    if (index === undefined) return
    const top = index * ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight)
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight
    render()
  }

  // Only one scan can update the delta baseline at a time. Changes during the
  // scan queue another pass using the revision from the previous result.
  async function fetchCatalog() {
    if (loading || disposed || !snapshot) return
    loading = true
    empty.hidden = true
    refreshButton.setAttribute('data-loading-status', '')
    refreshButton.setAttribute('aria-busy', 'true')
    if (!searching()) summary.textContent = 'Reading files…'

    async function scan() {
      if (disposed || !snapshot) return
      const prior = tree
      const rootKey = key
      const generation = wanted
      const base = scopePrefix(snapshot)
      catalogRequests++
      const startedAt = performance.now()
      const result = await attemptAsync(
        async () => {
          if (api.filesDelta) return { delta: await api.filesDelta(appliedInventoryRevision) }
          return { inventory: await api.files() }
        },
        { operation: 'Read navigator files' },
      )
      if (disposed) return
      if (key === rootKey) {
        if (result.ok) {
          if (result.value.delta) {
            const { delta } = result.value
            tree = delta.reset
              ? buildNavigationTree(delta.files, base)
              : applyNavigationDelta(tree, delta.files, delta.removed)
            appliedInventoryRevision = delta.revision
          } else {
            const { inventory } = result.value
            tree = reconcileNavigationTree(tree, inventory, base) ?? buildNavigationTree(inventory, base)
          }
          if (prior.root.path !== tree.root.path) expanded = new Set([tree.root.path])
          if (!inventoryReady && expandOnLoad) expandInitialFolderChains(tree.root, expanded)
          // Publish each completed scan even when edits have already queued another one.
          inventoryReady = true
          filters.update(() => tree.files.values())
          markChanges()
          if (generation === wanted) loading = false
          refreshProjection()
          revealSelection()
        } else {
          reportError(result.error, { silent: true })
          if (generation === wanted) {
            summary.dataset.state = 'error'
            summary.title = result.error.message
            summary.textContent = 'Couldn’t read files'
            container.dataset.searching = 'true'
          }
        }
        reportInitialScan(result.ok)
      }
      rendererDiagnostics.measure('renderer.navigator-catalog-scan', startedAt, result)
      if (generation !== wanted) await scan()
    }

    try {
      await scan()
    } finally {
      loading = false
      refreshButton.removeAttribute('data-loading-status')
      refreshButton.removeAttribute('aria-busy')
      if (!disposed) {
        reportInitialScan(false)
        runTask('Complete navigator scan', () => onReady?.())
      }
    }
  }

  let initialScanReported = false
  /** @param {boolean} ready */
  function reportInitialScan(ready) {
    if (initialScanReported) return
    initialScanReported = true
    runTask('Complete initial navigator scan', () => onInitialScan?.(ready))
  }

  /** @param {NavigatorSnapshot | { error: unknown } | null | undefined} next */
  function update(next) {
    if (disposed || !next || !('root' in next)) return
    const nextKey = `${next.root}\0${next.scope ?? next.root}`
    /** @type {Map<string, NavigationFile>} */
    const nextChanges = new Map()
    let newPath = false
    let newStatus = false
    for (const file of next.files) {
      nextChanges.set(file.path, file)
      const previous = changes.get(file.path)
      if (!previous) newPath = true
      else if (!newStatus && navigationStatus(previous) !== navigationStatus(file)) newStatus = true
    }
    const different = newPath || changes.size !== nextChanges.size
    const changedRoot = key !== nextKey
    const fresh = next.revision !== snapshot?.revision
    const refresh =
      changedRoot ||
      (Number.isFinite(next.inventoryRevision)
        ? next.inventoryRevision !== inventoryRevision
        : different ||
          (fresh &&
            next.changedPaths?.some(
              pathname => pathname === '*' || (!tree.files.has(pathname) && !tree.nodes.has(`dir:${pathname}`)),
            ) === true))
    snapshot = next
    rowRevision++
    changeRailDirty = true
    const titlePath = next.scope?.length ? next.scope : next.root
    project.textContent = lastPathSegment(titlePath) || 'Project'
    rootButton.title = titlePath
    changes = nextChanges
    inventoryRevision = next.inventoryRevision
    key = nextKey
    if (changedRoot) {
      appliedInventoryRevision = null
      inventoryReady = false
      expandOnLoad = true
      expanded = new Set([scopePrefix(next)])
      tree = buildNavigationTree([], scopePrefix(next))
      activeKey = tree.root.key
      selectedPath = next.initialPath?.length ? next.initialPath : null
      revealPath = selectedPath === null ? null : { path: selectedPath, kind: 'selection' }
      list.scrollTop = 0
      input.value = ''
      query = ''
      filters.reset()
      refreshProjection(false)
    }
    if (different || changedRoot || newStatus) markChanges()
    if (!searching())
      summary.textContent = loading
        ? 'Reading files…'
        : `${changes.size.toLocaleString()} changed ${changes.size === 1 ? 'file' : 'files'}`
    schedule()
    if (refresh) {
      wanted++
      runTask('Read navigator files', fetchCatalog)
    }
  }

  /** @param {NavigationNode} node @param {boolean} value */
  function setExpanded(node, value) {
    const changed = value ? expandFolderChain(node, expanded) : expanded.delete(node.path)
    if (!value) {
      for (const pathname of expanded) {
        if ((!node.path || pathname.startsWith(`${node.path}/`)) && tree.nodes.get(`dir:${pathname}`)?.file?.ignored)
          expanded.delete(pathname)
      }
    }
    if ((node.file?.ignored || !value) && api.directoryExpanded) {
      const root = key
      const operation = value ? 'Expand folder' : 'Collapse folder'
      runTask(operation, async () => {
        const result = await attemptAsync(() => api.directoryExpanded?.(node.path, value), { operation })
        if (!result.ok && !disposed && key === root) {
          reportError(result.error, { silent: true })
          summary.textContent = result.error.message
        }
      })
    }
    return changed
  }

  /** @param {NavigationNode} node */
  function choose(node) {
    if (node === tree.root) {
      setExpanded(node, !expanded.has(node.path))
      refreshProjection()
    } else if (node.kind === 'directory' && searching()) {
      reveal({ path: node.path, kind: 'directory' })
    } else if (node.kind === 'directory') {
      setExpanded(node, !expanded.has(node.path))
      activeKey = node.key
      refreshProjection()
      scrollToActive()
    } else {
      selectedPath = node.path
      activeKey = node.key
      render()
      runTask('Open navigator file', () => onOpen({ path: node.path, ...node.file, ...changes.get(node.path) }))
    }
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.key || !rows.contains(row)) return
    const node = tree.nodes.get(row.dataset.key)
    if (!node) return
    choose(node)
    list.focus()
  }

  function focusSearch() {
    container.dataset.searching = 'true'
    input.focus()
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing) return
    const active = activeKey === null ? undefined : tree.nodes.get(activeKey)
    if (matchesShortcut?.(event, 'renameExplorerItem') && active && active !== tree.root && !active.file?.submodule) {
      event.preventDefault()
      if (!event.repeat) actions.rename(active)
      return
    }
    if (
      (matchesShortcut?.(event, 'explorerContextMenu') || matchesShortcut?.(event, 'explorerContextMenuKey')) &&
      active &&
      active !== tree.root
    ) {
      event.preventDefault()
      const bounds = mounted.get(active.key)?.getBoundingClientRect() ?? list.getBoundingClientRect()
      if (!event.repeat) actions.show(active, bounds.left + 20, bounds.top + ROW_HEIGHT, list)
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== ' ') {
      event.preventDefault()
      focusSearch()
      input.value += event.key
      onSearch()
      return
    }
    const index = (activeKey === null ? undefined : visibleIndex.get(activeKey)) ?? 0
    const node = visible[index]?.node
    if (!node) return
    let target = index
    if (event.key === 'ArrowDown') target = Math.min(visible.length - 1, index + 1)
    else if (event.key === 'ArrowUp') target = Math.max(0, index - 1)
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = visible.length - 1
    else if (event.key === 'PageDown')
      target = Math.min(visible.length - 1, index + Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)))
    else if (event.key === 'PageUp')
      target = Math.max(0, index - Math.max(1, Math.floor(list.clientHeight / ROW_HEIGHT)))
    else if (event.key === 'ArrowRight' && !searching()) {
      if (node.kind === 'directory' && !expanded.has(node.path)) {
        setExpanded(node, true)
        refreshProjection()
      } else if (node.kind === 'directory' && node.children?.length) target = index + 1
    } else if (event.key === 'ArrowLeft' && !searching()) {
      if (node.kind === 'directory' && expanded.has(node.path)) {
        setExpanded(node, false)
        refreshProjection()
      } else {
        const parent = node.parentKey === null ? undefined : visibleIndex.get(node.parentKey)
        if (parent !== undefined) target = parent
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(node)
      return
    } else return
    event.preventDefault()
    activeKey = visible[target]?.node.key ?? activeKey
    scrollToActive()
  }

  function onSearch(reuseMatches = true) {
    const previous = query
    query = input.value.trim().toLocaleLowerCase()
    queryPattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu') : null
    list.scrollTop = 0
    // Extending the text query can only narrow the current results while filters stay the same.
    refreshProjection(false, reuseMatches && Boolean(previous) && query.startsWith(previous))
  }

  const onSearchInput = () => onSearch()

  function onSearchBlur() {
    if (!searching() && summary.dataset.state !== 'error') container.dataset.searching = 'false'
  }

  /** @param {KeyboardEvent} event */
  function onSearchKey(event) {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowDown' && visible.length) {
      event.preventDefault()
      activeKey = visible[0]?.node.key ?? null
      scrollToActive()
      list.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = ''
      onSearch()
      list.focus()
    } else if (event.key === 'Enter') {
      const node = activeKey === null ? undefined : tree.nodes.get(activeKey)
      if (node) {
        event.preventDefault()
        choose(node)
        list.focus()
      }
    }
  }

  function collapseFolders() {
    revealPath = null
    expandOnLoad = false
    setExpanded(tree.root, false)
    expanded = new Set([tree.root.path])
    activeKey = tree.root.key
    list.scrollTop = 0
    refreshProjection(false)
  }

  /** @param {MouseEvent} event */
  function onAction(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null
    const action = button instanceof HTMLButtonElement ? button.dataset.action : undefined
    if (action === 'collapse') {
      collapseFolders()
    } else if (action === 'refresh') {
      wanted++
      runTask('Read navigator files', fetchCatalog)
    } else if (action === 'root') {
      choose(tree.root)
    } else if (action === 'open-file') {
      runTask('Open file picker', () => onPick?.())
    } else if (action === 'open-folder') {
      runTask('Open folder picker', () => onFolder?.())
    }
  }

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row') : null
    const node = row instanceof HTMLDivElement && row.dataset.key ? tree.nodes.get(row.dataset.key) : undefined
    if (!node || node === tree.root) return
    event.preventDefault()
    activeKey = node.key
    render()
    actions.show(node, event.clientX, event.clientY, list)
  }
  /** @param {DragEvent} event */
  function onDragStart(event) {
    const row = event.target instanceof Element ? event.target.closest('.navigator-row[draggable="true"]') : null
    if (!(row instanceof HTMLDivElement) || !row.dataset.path || !event.dataTransfer || !snapshot?.root) return
    event.dataTransfer.setData(
      IDEA_FILE_DRAG_TYPE,
      JSON.stringify({ path: row.dataset.path, workspace: snapshot.root }),
    )
    event.dataTransfer.effectAllowed = 'link'
  }
  list.addEventListener('dragstart', onDragStart)
  list.addEventListener('contextmenu', onContextMenu)
  list.addEventListener('scroll', schedule, { passive: true })
  list.addEventListener('click', onClick)
  list.addEventListener('keydown', onKey)
  list.addEventListener('focus', schedule)
  input.addEventListener('input', onSearchInput)
  input.addEventListener('blur', onSearchBlur)
  input.addEventListener('keydown', onSearchKey)
  heading.addEventListener('click', onAction)
  const resize = new ResizeObserver(schedule)
  resize.observe(list)

  /** @param {string} pathname @param {Set<string>} requested @param {boolean} available */
  function expandIgnoredAncestors(pathname, requested, available) {
    let opened = false
    for (let slash = pathname.indexOf('/'); slash > 0; slash = pathname.indexOf('/', slash + 1)) {
      const ancestor = tree.directories.get(pathname.slice(0, slash))
      if (!ancestor?.file?.ignored || requested.has(ancestor.path)) continue
      // Refresh lazy descendants when a pending collapse may remove them from the catalog.
      if (available && ancestor !== tree.root && expanded.has(ancestor.path)) continue
      requested.add(ancestor.path)
      setExpanded(ancestor, true)
      opened = true
    }
    return opened
  }

  function revealSelection() {
    if (!revealPath) return false
    const { path, kind } = revealPath
    if (kind === 'file') {
      const available = tree.files.has(path)
      const opened = expandIgnoredAncestors(path, revealPath.requested, available)
      if (!available) {
        if (opened) refreshProjection()
        return false
      }
    }
    const found = ensureVisible(path, kind !== 'selection', kind === 'directory')
    if (found) revealPath = null
    return found
  }

  /** @param {RevealRequest} request */
  function reveal(request) {
    const wasSearching = searching()
    input.value = ''
    query = ''
    queryPattern = null
    filters.reset()
    if (wasSearching) refreshProjection(false)
    revealPath = request
    revealSelection()
  }

  return {
    update,
    focusSearch,
    collapseFolders,
    /** @param {string} from @param {string} to */
    renamed(from, to) {
      expanded = new Set(
        [...expanded].map(pathname =>
          pathname === from || pathname.startsWith(`${from}/`) ? to + pathname.slice(from.length) : pathname,
        ),
      )
      refreshProjection()
    },
    /** @param {string} pathname */
    revealDirectory(pathname) {
      reveal({ path: pathname, kind: 'directory' })
    },
    /** @param {string} pathname */
    revealFile(pathname) {
      selectedPath = pathname
      reveal({ path: pathname, kind: 'file', requested: new Set() })
    },
    /** @param {string | null} pathname */
    select(pathname) {
      selectedPath = pathname
      revealPath = pathname === null ? null : { path: pathname, kind: 'selection' }
      if (!revealSelection()) schedule()
    },
    toggle() {
      container.hidden = !container.hidden
      if (!container.hidden) schedule()
      return !container.hidden
    },
    dispose() {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      resize.disconnect()
      changeRail.dispose()
      actions.dispose()
      list.removeEventListener('dragstart', onDragStart)
      list.removeEventListener('contextmenu', onContextMenu)
      outline.removeEventListener('toggle', onOutlineToggle)
      list.removeEventListener('scroll', schedule)
      list.removeEventListener('click', onClick)
      list.removeEventListener('keydown', onKey)
      list.removeEventListener('focus', schedule)
      input.removeEventListener('input', onSearchInput)
      input.removeEventListener('blur', onSearchBlur)
      input.removeEventListener('keydown', onSearchKey)
      heading.removeEventListener('click', onAction)
      mounted.clear()
      container.replaceChildren()
    },
    stats: () => ({
      inventoryFiles: tree.files.size,
      treeNodes: tree.nodes.size,
      visibleRows: visible.length,
      mountedRows: mounted.size,
      expandedFolders: expanded.size,
      catalogRequests,
      loading,
      selectedPath,
      hidden: container.hidden,
    }),
  }
}
