import { hierarchy, treemap } from 'd3-hierarchy'
import type { BreakdownRow } from '../../../backend/tools/analysis/howmany.mjs'

const WIDTH = 360
const HEIGHT = 150
const COLORS = ['--accent', '--violet', '--added', '--warning', '--modified', '--removed']
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })

interface LanguageNode {
  row?: BreakdownRow
  children?: LanguageNode[]
}

export function createLanguageTreemap(rows: readonly BreakdownRow[]) {
  const children = rows.filter(row => row.code_lines > 0).map(row => ({ row }))
  if (!children.length) return null

  const root = hierarchy<LanguageNode>({ children }).sum(({ row }) => row?.code_lines ?? 0)
  const layout = treemap<LanguageNode>().size([WIDTH, HEIGHT])(root)
  const total = root.value ?? 0
  const colors = new Map<BreakdownRow, string>()
  const chart = document.createElement('div')
  chart.className = 'howmany-language-map'
  // The language rows carry the same data in a readable order.
  chart.setAttribute('aria-hidden', 'true')

  for (const [index, leaf] of layout.leaves().entries()) {
    const { data, x0, y0, x1, y1 } = leaf
    const { row } = data
    if (!row) continue
    const color = `var(${COLORS[index] ?? '--subtle'})`
    colors.set(row, color)
    const share = row.code_lines / total
    const label = share < 0.001 ? `<${percent.format(0.001)}` : percent.format(share)
    const lines = row.code_lines === 1 ? 'line' : 'lines'

    const tile = document.createElement('div')
    tile.className = 'howmany-language-tile'
    tile.title = `${row.language} · ${row.code_lines.toLocaleString()} code ${lines} · ${label}`
    tile.style.setProperty('--language-color', color)
    tile.style.left = `${(x0 / WIDTH) * 100}%`
    tile.style.top = `${(y0 / HEIGHT) * 100}%`
    tile.style.width = `${((x1 - x0) / WIDTH) * 100}%`
    tile.style.height = `${((y1 - y0) / HEIGHT) * 100}%`

    const name = document.createElement('span')
    name.className = 'howmany-language-tile-name'
    name.textContent = row.language
    const amount = document.createElement('span')
    amount.className = 'howmany-language-tile-share'
    amount.textContent = label
    tile.append(name, amount)
    chart.append(tile)
  }

  return { chart, colors }
}
