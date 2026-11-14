import { createSketch } from './sketch.ts'

export function drawNotebook(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const paperInk = 'var(--idea-paper-ink)'
  const cover = sketch.path('M17 22Q38 17 55 28Q73 18 94 22L94 66Q73 62 55 70Q36 62 17 65Z', {
    stroke: paperInk,
    fill: 'var(--idea-cover-ink)',
    fillWeight: 0.65,
    hachureGap: 4,
  })
  const pages = sketch.path('M20 16Q39 13 55 24Q72 13 91 16L91 61Q72 58 55 66Q39 58 20 61Z', {
    stroke: paperInk,
    fill: 'var(--surface-raised)',
    fillStyle: 'solid',
  })
  const rules = sketch.path(
    'M55 24v42 M28 33q9 0 19 4 M28 42q10 0 19 4 M28 51q8 0 15 2 M63 34q9-4 20-4 M63 43q6-3 13-3',
    { stroke: paperInk },
  )
  const title = sketch.path('M28 25q7-.5 15 2', { stroke: 'var(--accent)', strokeWidth: 1.7 })
  const pencil = sketch.path('M69 58l5-10 24-22q5-3 8 4L81 53Z', {
    stroke: 'var(--accent)',
    fill: 'var(--accent-surface)',
    fillStyle: 'solid',
    roughness: 0.65,
  })
  const pencilDetails = sketch.path('M74 48l7 5 M72 53l2 3 M94 30l7 6', {
    stroke: 'var(--accent)',
    roughness: 0.65,
  })
  svg.replaceChildren(cover, pages, rules, title, pencil, pencilDetails)
}
