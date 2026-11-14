import { createSketch } from '../../illustrations/sketch.ts'

const MARKS = {
  head: 'M67 37h8 M67 42h8',
  checkpoint: 'M68 45V34h8l-2 3 2 3h-8',
  scope: 'M71.5 40.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 1 1 0 7 M74 40l3.5 4',
  reviewed: 'M66 40h1 M70.5 40h1 M75 40h1',
  complete: 'M66 39l3.5 4 7-8',
  error: 'M71 34v6 M71 43v1',
}

export function drawReviewArt(svg: SVGSVGElement, state: keyof typeof MARKS) {
  const sketch = createSketch(svg)
  const paperInk = 'var(--queue-paper-ink)'
  const back = sketch.polygon(
    [
      [17, 12],
      [46, 8],
      [50, 39],
      [21, 43],
    ],
    { stroke: paperInk, fill: 'var(--queue-paper-hatch)', fillWeight: 0.65, hachureGap: 4 },
  )
  const front = sketch.polygon(
    [
      [37, 12],
      [71, 15],
      [68, 47],
      [34, 44],
    ],
    { stroke: paperInk, fill: 'var(--surface-raised)', fillStyle: 'solid' },
  )
  const lines = sketch.path('M44 21l18 1.5 M43 27l13 1 M42.5 33l9 .75', { stroke: paperInk })
  const badge = sketch.circle(71, 39.5, 23, {
    stroke: 'currentColor',
    fill: 'var(--queue-badge-fill)',
    fillStyle: 'solid',
    roughness: 0.75,
  })
  const mark = sketch.path(MARKS[state], { stroke: 'currentColor', strokeWidth: 1.65, roughness: 0.65 })
  svg.replaceChildren(back, front, lines, badge, mark)
}
