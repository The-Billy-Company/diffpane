export interface NavigationFile {
  path: string
  directory?: boolean
  index?: string
  worktree?: string
  conflicted?: boolean
  submodule?: boolean
  ignored?: boolean
  originalPath?: string | null
  renameEdited?: boolean
  reviewVersion?: number
}
export interface NavigationNode {
  key: string
  path: string
  name: string
  kind: string
  parentKey: string | null
  children: NavigationNode[] | null
  changedCount: number
  file?: NavigationFile | null
  inventoryEpoch?: number
  searchPath?: string
}
export interface NavigationTree {
  root: NavigationNode
  nodes: Map<string, NavigationNode>
  files: Map<string, NavigationNode>
  directories: Map<string, NavigationNode>
  searchFiles?: NavigationNode[]
  searchDirectories?: NavigationNode[]
  inventoryEpoch?: number
}
interface ChildChanges {
  added: NavigationNode[]
  removed?: Set<NavigationNode>
}
type TouchedFolders = Map<NavigationNode, ChildChanges>

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const INCREMENTAL_LIMIT = 8

function order(a: NavigationNode, b: NavigationNode) {
  return a.kind !== b.kind
    ? a.kind === 'directory'
      ? -1
      : 1
    : COLLATOR.compare(a.name, b.name) || COLLATOR.compare(a.path, b.path)
}

function entry(tree: NavigationTree, file: NavigationFile) {
  return (file.directory ? tree.directories : tree.files).get(file.path)
}

function changesFor(touched: TouchedFolders, parent: NavigationNode) {
  let changes = touched.get(parent)
  if (!changes) {
    changes = { added: [] }
    touched.set(parent, changes)
  }
  return changes
}

function insert(tree: NavigationTree, file: NavigationFile, touched: TouchedFolders) {
  const existing = entry(tree, file)
  if (existing) {
    existing.file = file
    return existing
  }
  const basePath = tree.root.path
  if (file.path === basePath && file.directory) {
    tree.root.file = file
    tree.directories.set(file.path, tree.root)
    return tree.root
  }
  const prefix = basePath ? `${basePath}/` : ''
  if (prefix && !file.path.startsWith(prefix)) return null
  const relative = file.path.slice(prefix.length)
  if (!relative) return null
  const parts = relative.split('/')
  let parent = tree.root
  let pathname = basePath
  for (const [index, part] of parts.entries()) {
    pathname = pathname ? `${pathname}/${part}` : part
    const directory = index < parts.length - 1 || file.directory === true
    const key = `${directory ? 'dir' : 'file'}:${pathname}`
    let child = tree.nodes.get(key)
    if (!child) {
      child = {
        key,
        path: pathname,
        name: part,
        kind: directory ? 'directory' : 'file',
        parentKey: parent.key,
        children: directory ? [] : null,
        changedCount: 0,
        file: directory ? null : file,
      }
      tree.nodes.set(key, child)
      if (directory) tree.searchDirectories = undefined
      changesFor(touched, parent).added.push(child)
      if (!directory) tree.files.set(pathname, child)
    }
    parent = child
  }
  parent.file = file
  if (file.directory) tree.directories.set(file.path, parent)
  if (!file.directory) tree.searchFiles = undefined
  return parent
}

function detach(tree: NavigationTree, node: NavigationNode, touched: TouchedFolders): NavigationNode | undefined {
  const parent = node.parentKey === null ? undefined : tree.nodes.get(node.parentKey)
  if (!parent) return undefined
  const changes = changesFor(touched, parent)
  const removed = (changes.removed ??= new Set())
  removed.add(node)
  return parent
}

function remove(tree: NavigationTree, node: NavigationNode, touched: TouchedFolders) {
  if (node.kind === 'file') {
    tree.files.delete(node.path)
    tree.nodes.delete(node.key)
    tree.searchFiles = undefined
    detach(tree, node, touched)
  } else {
    tree.directories.delete(node.path)
    node.file = null
    changesFor(touched, node)
  }
}

function childBoundary(children: NavigationNode[], node: NavigationNode, afterEqual: boolean) {
  let low = 0
  let high = children.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const sibling = children[middle]
    if (!sibling) break
    const difference = order(sibling, node)
    if (difference < 0 || (afterEqual && difference === 0)) low = middle + 1
    else high = middle
  }
  return low
}

function updateChildren(node: NavigationNode, { added, removed }: ChildChanges) {
  const children = node.children
  if (!children) return
  if (!children.length) {
    const next = removed ? added.filter(child => !removed.has(child)) : added
    if (next.length > 1) next.sort(order)
    node.children = next
    return
  }
  // Use the sorted sibling array directly for small edits and compact once for larger batches.
  if (added.length + (removed?.size ?? 0) > INCREMENTAL_LIMIT) {
    const next = removed ? children.filter(child => !removed.has(child)) : children
    if (added.length) {
      for (const child of added) if (!removed?.has(child)) next.push(child)
      next.sort(order)
    }
    node.children = next
    return
  }
  if (removed)
    for (const child of removed) {
      if (added.includes(child)) continue
      const start = childBoundary(children, child, false)
      for (let index = start; index < children.length; index++) {
        const sibling = children[index]
        if (sibling === child) {
          children.splice(index, 1)
          break
        }
        if (!sibling || order(sibling, child) !== 0) break
      }
    }
  // Insert after equivalent names to preserve the stable order among collator ties.
  for (const child of added) if (!removed?.has(child)) children.splice(childBoundary(children, child, true), 0, child)
}

function canPrune(tree: NavigationTree, node: NavigationNode, changes: ChildChanges | undefined) {
  if (node === tree.root || node.file || !node.children || !changes) return false
  return node.children.length + changes.added.length === (changes.removed?.size ?? 0)
}

function finish(tree: NavigationTree, touched: TouchedFolders) {
  const empty: NavigationNode[] = []
  for (const [node, changes] of touched) if (canPrune(tree, node, changes)) empty.push(node)
  for (let node = empty.pop(); node; node = empty.pop()) {
    tree.nodes.delete(node.key)
    tree.searchDirectories = undefined
    const parent = detach(tree, node, touched)
    if (parent && canPrune(tree, parent, touched.get(parent))) empty.push(parent)
  }
  for (const [node, changes] of touched) if (tree.nodes.has(node.key)) updateChildren(node, changes)
  return tree
}

/** Retain unchanged nodes and sort only touched folders during large-repository churn. */
export function reconcileNavigationTree(tree: NavigationTree, inventory: readonly NavigationFile[], basePath = '') {
  if (tree.root.path !== basePath) return null
  const epoch = (tree.inventoryEpoch ?? 0) + 1
  tree.inventoryEpoch = epoch
  const touched: TouchedFolders = new Map()
  for (const file of inventory) {
    if (entry(tree, file)?.inventoryEpoch === epoch) continue
    const node = insert(tree, file, touched)
    if (node) node.inventoryEpoch = epoch
  }
  for (const node of tree.files.values()) if (node.inventoryEpoch !== epoch) remove(tree, node, touched)
  for (const node of tree.directories.values()) if (node.inventoryEpoch !== epoch) remove(tree, node, touched)
  return finish(tree, touched)
}

/** IPC deltas touch only changed nodes; the rest of the catalog stays in place. */
export function applyNavigationDelta(
  tree: NavigationTree,
  files: readonly NavigationFile[],
  removed: readonly string[],
) {
  const touched: TouchedFolders = new Map()
  const removePath = (pathname: string) => {
    const file = tree.files.get(pathname)
    const directory = tree.directories.get(pathname)
    if (file) remove(tree, file, touched)
    if (directory) remove(tree, directory, touched)
  }
  for (const pathname of removed) removePath(pathname)
  for (const file of files) {
    // Each IPC delta carries a single inventory entry per path; a new kind replaces its marker.
    const previous = (file.directory ? tree.files : tree.directories).get(file.path)
    if (previous) remove(tree, previous, touched)
    insert(tree, file, touched)
  }
  return finish(tree, touched)
}
