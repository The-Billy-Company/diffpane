import { createSketch } from '../../../illustrations/sketch.ts'

export function drawNavigatorArt(svg: SVGSVGElement, searching: boolean) {
  const state = searching ? 'filter' : 'empty'
  if (svg.dataset.sketch === state) return
  const sketch = createSketch(svg)
  const line = 'var(--navigator-sketch-paper)'
  if (searching) {
    svg.replaceChildren(
      sketch.path('M12 15h26 M16 24h21 M20 33h18 M24 42h14', { stroke: line }),
      sketch.path('M39 12h32L58 29v10l-7 5V29Z', {
        fill: 'var(--modified-surface)',
        fillStyle: 'solid',
        stroke: 'var(--modified)',
        strokeWidth: 1.5,
      }),
      sketch.path('M46 17h17 M49 22h10', { stroke: 'var(--modified)', roughness: 0.55 }),
    )
  } else {
    svg.replaceChildren(
      sketch.path('M13 17h22 M18 25h17 M22 33h13', { stroke: line }),
      sketch.path('M36 16h12l4 5h18v20H36Z', {
        fill: 'var(--modified-surface)',
        fillStyle: 'solid',
        stroke: 'var(--modified)',
      }),
      sketch.path('M36 41l5-13h33l-4 13Z', {
        fill: 'var(--surface-raised)',
        fillStyle: 'solid',
        stroke: 'var(--modified)',
      }),
      sketch.path('M46 35h14 M49 18l1-5 M54 16l3-4', { stroke: 'var(--modified)', roughness: 0.6 }),
    )
  }
  svg.dataset.sketch = state
}
