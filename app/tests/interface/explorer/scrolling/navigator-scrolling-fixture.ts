import type { NavigationFile } from '../../../../renderer/explorer/tree/navigation-reconcile.ts'
import { createNavigator } from '../../../../renderer/explorer/tree/navigator.js'
import { requireElement } from '../../../../renderer/shell/workspace/dom.js'
import '../../../../renderer/explorer/tree/navigator.css'

const { document, window, HTMLDivElement } = globalThis

export interface NavigatorViewport {
  path: string
  offset: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface NavigatorCoverage {
  covered: boolean
  mountedRows: number
  viewportRows: number
}

declare global {
  interface Window {
    navigatorScrollingFixture: {
      ready: () => boolean
      scrollNearBottom: () => void
      scrollToMiddle: () => void
      jumpBeforeRender: (direction: number) => NavigatorCoverage
      insertEarlierFiles: () => void
      showChanges: (showing: boolean) => void
      scrollbarGutter: () => number
      viewport: () => NavigatorViewport
    }
  }
}

function file(path: string): NavigationFile {
  return { path, index: ' ', worktree: ' ', conflicted: false, submodule: false }
}

let inventory = Array.from({ length: 1_000 }, (_, index) => file(`file-${String(index).padStart(4, '0')}.txt`))
let revision = 1
let showChanges = false
const host = requireElement(document, '#navigator', HTMLDivElement)
const navigator = createNavigator(host, { files: async () => inventory, fileAction: async () => {} }, () => {})
const list = requireElement(host, '.navigator-tree', HTMLDivElement)

function update() {
  navigator.update({
    root: '/navigator-fixture',
    files: showChanges ? [{ ...file('file-0000.txt'), worktree: 'M' }] : [],
    inventoryRevision: revision,
    revision,
  })
}

window.navigatorScrollingFixture = {
  ready: () => navigator.stats().inventoryFiles === inventory.length && !navigator.stats().loading,
  scrollNearBottom() {
    const rowHeight = Number.parseFloat(host.style.getPropertyValue('--navigator-row-height'))
    list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / rowHeight) * rowHeight - rowHeight + 7
  },
  scrollToMiddle() {
    list.scrollTop = Math.floor((list.scrollHeight - list.clientHeight) / 2)
  },
  jumpBeforeRender(direction) {
    list.scrollTop += direction * list.clientHeight * 1.5
    const bounds = list.getBoundingClientRect()
    const rectangles = [...list.querySelectorAll<HTMLDivElement>('.navigator-row')]
      .map(row => row.getBoundingClientRect())
      .toSorted((left, right) => left.top - right.top)
    let coveredUntil = bounds.top
    for (const rectangle of rectangles) {
      if (rectangle.bottom <= coveredUntil) continue
      if (rectangle.top > coveredUntil) break
      coveredUntil = rectangle.bottom
    }
    const rowHeight = Number.parseFloat(host.style.getPropertyValue('--navigator-row-height'))
    return {
      covered: coveredUntil >= bounds.bottom,
      mountedRows: navigator.stats().mountedRows,
      viewportRows: Math.ceil(list.clientHeight / rowHeight),
    }
  },
  insertEarlierFiles() {
    inventory = [
      ...Array.from({ length: 100 }, (_, index) => file(`added-${String(index).padStart(4, '0')}.txt`)),
      ...inventory,
    ]
    revision++
    update()
  },
  showChanges(showing) {
    showChanges = showing
    revision++
    update()
  },
  scrollbarGutter: () => list.offsetWidth - list.clientWidth,
  viewport() {
    const top = list.getBoundingClientRect().top
    const first = [...list.querySelectorAll<HTMLDivElement>('.navigator-row')].find(row => {
      const bounds = row.getBoundingClientRect()
      return bounds.top <= top && bounds.bottom > top
    })
    if (!first?.dataset.path) throw new Error('The first visible explorer row was not rendered.')
    return {
      path: first.dataset.path,
      offset: top - first.getBoundingClientRect().top,
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    }
  },
}

update()
