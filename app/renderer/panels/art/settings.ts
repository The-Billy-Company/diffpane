// Copyright (c) 2026 The Billy Company
import { createSketch } from '../../illustrations/sketch.ts'

export function drawThemeWindow(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const edge = { stroke: 'var(--control-border)', roughness: 0.55 }
  svg.append(
    sketch.path('M10 5h102q4 0 4 4v39q0 4-4 4H10q-4 0-4-4V9q0-4 4-4Z', {
      ...edge,
      fill: 'var(--workbench-background)',
      fillStyle: 'solid',
    }),
    sketch.path('M10 5h102q4 0 4 4v7H6V9q0-4 4-4Z M6 16h33v36H10q-4 0-4-4Z', {
      ...edge,
      fill: 'var(--surface)',
      fillStyle: 'solid',
    }),
    sketch.path('M13 24h16 M13 31h13 M13 38h16 M48 24h32 M48 45h20', {
      stroke: 'var(--subtle)',
      roughness: 0.55,
    }),
    sketch.path('M16 10h.5 M48 31h48', { stroke: 'var(--removed)', strokeWidth: 1.65, roughness: 0.45 }),
    sketch.path('M22 10h.5', { stroke: 'var(--warning)', strokeWidth: 1.8, roughness: 0.45 }),
    sketch.path('M28 10h.5 M48 38h38', { stroke: 'var(--added)', strokeWidth: 1.65, roughness: 0.45 }),
  )
}

export function drawKeyboardMark(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const options = { stroke: 'currentColor', strokeWidth: 1.35, roughness: 0.55, disableMultiStroke: true }
  svg.append(
    sketch.path('M4.5 4.5h11q2 0 2 2v7q0 2-2 2h-11q-2 0-2-2v-7q0-2 2-2Z', options),
    sketch.path('M6 8h.5 M9.75 8h.5 M13.5 8h.5 M6 11.5h.5 M9.75 11.5H14', options),
  )
}

export function drawReadinessMark(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  svg.append(
    sketch.path('M4 5.5l15.5-.5 1 13.5-16 .5Z', {
      stroke: 'var(--violet)',
      fill: 'var(--violet-surface)',
      fillStyle: 'solid',
      roughness: 0.5,
    }),
    sketch.path('M6 12h3l1.6-3 2.5 6 1.6-3h3.5', {
      stroke: 'currentColor',
      roughness: 0.55,
      strokeWidth: 1.4,
    }),
  )
}
