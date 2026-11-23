// Copyright (c) 2026 The Billy Company
import { createSketch } from '../../illustrations/sketch.ts'

export function drawReportMark(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  svg.append(
    sketch.path('M2 5v24h32', { stroke: 'var(--muted)', preserveVertices: true, roughness: 0.55 }),
    sketch.path('M7 13l8 4 7-9 10 3', { stroke: 'var(--chart-code)', strokeWidth: 1.8, roughness: 0.6 }),
    sketch.path('M7 24l8-2 8 2 9-6', { stroke: 'var(--chart-comments)', roughness: 0.55 }),
  )
}

export function drawReportPlaceholder(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const ink = 'var(--howmany-paper-ink)'
  svg.append(
    sketch.path('M17 10l31-4 6 42-31 4Z', {
      stroke: ink,
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M27 17l13-2 M29 24l15-2 M30 31l11-1 M31 39l16-2', { stroke: ink }),
    sketch.path('M36 44l38-26 7 10-38 27Z', {
      stroke: 'currentColor',
      fill: 'var(--accent-surface)',
      fillStyle: 'solid',
      roughness: 0.7,
    }),
    sketch.path('M45 39l3 4 M51 35l2 3 M57 31l3 4 M63 27l2 3 M69 23l3 4', {
      stroke: 'currentColor',
      roughness: 0.5,
    }),
  )
}
