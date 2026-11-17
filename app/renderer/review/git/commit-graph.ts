import type { GitCommit } from '../../../shared/review/git.ts'

interface Lane {
  id: string
  tone: number
  working?: boolean
}
interface Edge {
  from: number
  to: number
  tone: number
  section: 'through' | 'incoming' | 'outgoing'
  dashed?: boolean
  parent?: string
}
interface Row {
  lane: number
  tone: number
  edges: Edge[]
}

const laneSpacing = 14
const start = 19
const height = 44
const center = height / 2
const alternateTone = (lane: number) => (lane % 2 === 1 ? 1 : 2)

export function layoutCommitGraph(commits: readonly GitCommit[], head: string | null) {
  const available = new Set(commits.map(commit => commit.id))
  const visibleHead = head && available.has(head) ? head : null
  const lanes: (Lane | null)[] = visibleHead ? [{ id: visibleHead, tone: 0, working: true }] : []
  const working: Row = {
    lane: 0,
    tone: 0,
    edges: visibleHead ? [{ from: 0, to: 0, section: 'outgoing', tone: 0, dashed: true, parent: visibleHead }] : [],
  }
  const graph = new Map<string, Row>()
  let width = 1
  // Waiting parents keep their lane until they reach a commit row. Existing paths
  // keep their position across unrelated rows and converge on the same parent lane.
  for (const commit of commits) {
    const found = lanes.findIndex(lane => lane?.id === commit.id)
    const free = lanes.indexOf(null)
    const lane = found !== -1 ? found : free !== -1 ? free : lanes.length
    const current = found !== -1 ? lanes[found] : null
    const tone = current?.tone ?? alternateTone(lane)
    const edges: Edge[] = []
    for (const [index, active] of lanes.entries()) {
      if (!active) continue
      const section = index === lane ? 'incoming' : 'through'
      edges.push({ from: index, to: index, tone: active.tone, section, dashed: active.working })
    }
    lanes[lane] = null
    const reserved = new Set<number>()
    for (const [index, parent] of commit.parents.entries()) {
      const existing = lanes.findIndex(value => value?.id === parent)
      let next = existing !== -1 ? existing : index === 0 ? lane : lane + 1
      if (existing === -1) while (lanes[next] || reserved.has(next)) next++
      const firstParentOfHead = index === 0 && tone === 0
      const parentTone = firstParentOfHead ? 0 : (lanes[next]?.tone ?? (index === 0 ? tone : alternateTone(next)))
      const continuation = !available.has(parent)
      if (continuation) reserved.add(next)
      else if (!lanes[next] || firstParentOfHead) lanes[next] = { id: parent, tone: parentTone }
      edges.push({ from: lane, to: next, tone: parentTone, section: 'outgoing', dashed: continuation, parent })
      width = Math.max(width, next + 1)
    }
    width = Math.max(width, lane + 1)
    graph.set(commit.id, { lane, tone, edges })
    while (lanes.length && !lanes.at(-1)) lanes.pop()
  }
  return { width: start + (width - 1) * laneSpacing + 15, working, graph, headOutside: Boolean(head && !visibleHead) }
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value))
  return element
}

const x = (lane: number) => start + lane * laneSpacing

export function renderCommitGraphRow(
  row: Row | undefined,
  width: number,
  id: string,
  kind: 'working' | 'merge' | 'commit',
) {
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', class: 'git-graph-rail' })
  if (!row) return root
  for (const edge of row.edges) {
    const { from, to, tone, section, dashed, parent } = edge
    const a = x(from)
    const b = x(to)
    const d =
      section === 'through'
        ? `M${a},0 V${height}`
        : section === 'incoming'
          ? `M${a},0 V${center}`
          : from === to
            ? `M${a},${center} V${height}`
            : `M${a},${center} C${a},${center + 10} ${b},${height - 10} ${b},${height}`
    const path = svg('path', { d, class: 'git-graph-edge', 'data-tone': tone, 'data-dashed': String(Boolean(dashed)) })
    if (parent) {
      path.dataset.gitEdgeFrom = id
      path.dataset.gitEdgeTo = parent
    }
    root.append(path)
  }
  const cx = x(row.lane)
  root.append(svg('circle', { cx, cy: center, r: 10, class: 'git-graph-focus', 'data-tone': row.tone }))
  if (kind === 'working') {
    root.append(
      svg('rect', {
        x: cx - 4.5,
        y: center - 4.5,
        width: 9,
        height: 9,
        rx: 1.5,
        class: 'git-graph-outer',
        'data-tone': row.tone,
      }),
    )
  } else {
    if (kind === 'merge')
      root.append(svg('circle', { cx, cy: center, r: 6.5, class: 'git-graph-outer', 'data-tone': row.tone }))
    root.append(
      svg('circle', {
        cx,
        cy: center,
        r: kind === 'merge' ? 2.5 : 3.5,
        class: 'git-graph-node',
        'data-tone': row.tone,
      }),
    )
  }
  return root
}
