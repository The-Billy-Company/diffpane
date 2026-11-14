import { createSketch } from '../../../illustrations/sketch.ts'

export function drawWelcomeArt(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const guide = 'var(--workspace-sketch-guide)'
  svg.replaceChildren(
    sketch.path('M14 20h124 M14 40h124 M14 60h124', {
      stroke: guide,
      strokeLineDash: [1, 5],
      disableMultiStroke: true,
    }),
    sketch.path('M44 40c18 0 22-20 41-20h42', { stroke: 'var(--added-edge)', strokeWidth: 1.6 }),
    sketch.path('M44 40c18 0 22 20 41 20h42', { stroke: 'var(--removed-edge)', strokeWidth: 1.6 }),
    sketch.line(16, 40, 139, 40, { stroke: 'var(--accent)', strokeWidth: 1.7 }),
    sketch.circle(44, 40, 10, {
      stroke: 'var(--accent)',
      fill: 'var(--workbench-background)',
      fillStyle: 'solid',
    }),
    sketch.circle(127, 20, 15, { stroke: 'var(--added)', fill: 'var(--added-surface)', fillStyle: 'solid' }),
    sketch.path('M123.5 20h7 M127 16.5v7', { stroke: 'var(--added)', roughness: 0.65 }),
    sketch.circle(127, 60, 15, { stroke: 'var(--removed)', fill: 'var(--removed-surface)', fillStyle: 'solid' }),
    sketch.line(123.5, 60, 130.5, 60, { stroke: 'var(--removed)', roughness: 0.65 }),
  )
}

export function drawWorkbenchArt(svg: SVGSVGElement, comparison: boolean) {
  const state = comparison ? 'comparison' : 'file'
  if (svg.dataset.sketch === state) return
  const sketch = createSketch(svg)
  const guide = 'var(--workspace-sketch-guide)'
  const paper = { stroke: 'var(--workspace-sketch-paper)', fill: 'var(--surface-raised)', fillStyle: 'solid' }
  if (comparison) {
    svg.replaceChildren(
      sketch.path('M22 22L53 16L58 58L27 63Z', paper),
      sketch.path('M84 16L115 21L111 63L79 58Z', paper),
      sketch.path('M29 30l18-3 M32 50l15-3 M91 27l17 3 M88 47l14 3', { stroke: guide }),
      sketch.path('M59 39h18', { stroke: guide, strokeLineDash: [1, 4], disableMultiStroke: true }),
      sketch.path('M31 40l20-3', { stroke: 'var(--removed)', strokeWidth: 1.8 }),
      sketch.path('M88 36v7 M84.5 39.5h7 M96 39l11 1.5', { stroke: 'var(--added)', strokeWidth: 1.7 }),
    )
  } else {
    svg.replaceChildren(
      sketch.path('M18 28h22 M25 38h15 M31 48h9 M98 28h22 M98 38h15 M98 48h9', { stroke: guide }),
      sketch.path('M47 20l34-3 6 39-34 6Z', {
        stroke: guide,
        fill: guide,
        fillWeight: 0.65,
        hachureGap: 4,
      }),
      sketch.path('M51 16h25l12 12v32H51Z', paper),
      sketch.path('M76 16v12h12 M59 35h18 M59 42h14', { stroke: paper.stroke }),
      sketch.line(59, 50, 75, 50, { stroke: 'var(--accent)', strokeWidth: 1.9 }),
    )
  }
  svg.dataset.sketch = state
}

export function drawRecentTargetArt(svg: SVGSVGElement, folder: boolean) {
  const sketch = createSketch(svg)
  const fill = 'var(--recent-sketch-fill)'
  const ink = { stroke: 'currentColor', roughness: 0.65 }
  if (folder) {
    svg.replaceChildren(
      sketch.path('M6 39V11h13l5 5h18v23Z', { ...ink, fill, fillStyle: 'solid' }),
      sketch.path('M6 39l4-16h34l-3 16Z', { ...ink, fill: 'var(--surface-raised)', fillStyle: 'solid' }),
      sketch.path('M12 36l2-9h16l-3 9Z', {
        stroke: 'none',
        fill: 'var(--recent-sketch-hatch)',
        fillWeight: 0.6,
        hachureGap: 3,
      }),
    )
  } else {
    svg.replaceChildren(
      sketch.path('M6 4h14l8 8v24H6Z', { ...ink, fill, fillStyle: 'solid' }),
      sketch.path('M20 4v8h8 M11 18h12 M11 23h10 M11 28h7', ink),
    )
  }
}
