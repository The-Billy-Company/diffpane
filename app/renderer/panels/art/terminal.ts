// Copyright (c) 2026 The Billy Company
import { createSketch } from '../../illustrations/sketch.ts'

export function drawTerminalPrompt(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  svg.append(
    sketch.path('M10 11l53-2 2 34-53 2Z', {
      stroke: 'var(--terminal-paper-ink)',
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M11 19l52-2 M17 15h2 M22 15h2', { stroke: 'var(--terminal-paper-ink)' }),
    sketch.path('M20 25l7 6-6 6 M32 36l14-.5', { stroke: 'currentColor', strokeWidth: 1.75, roughness: 0.6 }),
  )
}
