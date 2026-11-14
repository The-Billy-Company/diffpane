import { createSketch } from '../../illustrations/sketch.ts'

export function drawCreatureGreeting(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const ink = { roughness: 0.42, disableMultiStroke: true }
  svg.append(
    sketch.path('M72 20l29-8 15 8 9 39-43 11Z', {
      ...ink,
      stroke: 'var(--violet)',
      strokeWidth: 1.35,
      fill: 'var(--violet-surface)',
      fillStyle: 'solid',
    }),
    sketch.path('M101 12l3 12 12-4 M91 55l19-5 M93 61l12-3', {
      ...ink,
      stroke: 'var(--violet)',
    }),
    sketch.path('M93 34l-5 5 6 3 M107 31l7 3-4 6 M103 30l-4 13', {
      ...ink,
      stroke: 'var(--violet)',
      strokeWidth: 1.45,
    }),
    sketch.path('M17 46c0-8 3-14 9-18l-3-14 15 9q8-2 16 0l15-9-3 14c6 4 9 10 9 18 0 14-12 22-29 22S17 60 17 46Z', {
      ...ink,
      stroke: 'currentColor',
      strokeWidth: 1.75,
      fill: 'var(--accent-surface)',
      fillStyle: 'solid',
    }),
    sketch.path('M41.5 52q4.5 5 9 0', { ...ink, stroke: 'currentColor', strokeWidth: 1.6 }),
    sketch.line(19, 74, 128, 74, { ...ink, stroke: 'var(--creature-desk-line)' }),
  )
  // Solid dots keep the familiar face legible at the panel's smallest width.
  for (const x of [35, 57]) {
    const eye = svg.ownerDocument.createElementNS(svg.namespaceURI, 'circle')
    eye.setAttribute('cx', String(x))
    eye.setAttribute('cy', '43')
    eye.setAttribute('r', '2.2')
    eye.setAttribute('fill', 'currentColor')
    svg.append(eye)
  }
}

export function drawCreatureKey(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const ink = { stroke: 'currentColor', roughness: 0.4, disableMultiStroke: true, strokeWidth: 1.35 }
  svg.append(
    sketch.path('M6 7h18l6 6v12H6Z M24 7v6h6', { ...ink, stroke: 'var(--creature-key-paper)' }),
    sketch.path('M15 16a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0ZM15 16h10m-3 0v3m3-3v2', ink),
  )
}

export function drawThreadTrail(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  svg.append(
    sketch.path('M16 9h31l9 9v26H16Z M47 9v10l9-1', {
      stroke: 'var(--agent-thread-paper-ink)',
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M22 18h16 M22 24h21 M22 31h9', { stroke: 'var(--agent-thread-paper-ink)' }),
    sketch.path('M33 36c8 0 13-1 16-7 4-7 8-2 7 3-1 7-8 8-4 15 3 4 12 2 15-3', {
      stroke: 'currentColor',
      strokeWidth: 1.55,
      roughness: 0.6,
    }),
    sketch.circle(68, 42, 5, { stroke: 'currentColor', roughness: 0.5 }),
  )
}

export function drawThreadInspector(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  svg.append(
    sketch.path('M14 12h57v31H14Z', {
      stroke: 'var(--agent-thread-paper-ink)',
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M24 9v39 M18 16h3 M18 23h3 M18 30h3 M18 37h3', {
      stroke: 'var(--agent-thread-paper-ink)',
      roughness: 0.55,
    }),
    sketch.path('M31 28h7l4-8 6 16 5-8h10', {
      stroke: 'currentColor',
      strokeWidth: 1.6,
      roughness: 0.6,
    }),
  )
}
