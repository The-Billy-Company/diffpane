import { createSketch } from './sketch.ts'

const CALLOUT_MARKS = new Map([
  ['note', 'M4 3h12v10H9l-4 4v-4H4Z M7 7h6 M7 10h4'],
  ['tip', 'M7 15c0-3-3-4-3-7a6 6 0 0 1 12 0c0 3-3 4-3 7Z M8 18h4'],
  ['important', 'M10 2l2.6 5.1 5.7.9-4.1 4 .9 5.7-5.1-2.7-5.1 2.7.9-5.7-4.1-4 5.7-.9Z'],
  ['warning', 'M10 3l8 14H2Z M10 8v3.5 M10 14v.4'],
  ['caution', 'M6 3h8l3 3v8l-3 3H6l-3-3V6Z M7.5 7.5l5 5 M12.5 7.5l-5 5'],
])

function editorArt(viewBox: string, className: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  return svg
}

export function createCalloutArt(tone: string) {
  const path = CALLOUT_MARKS.get(tone)
  if (!path) return null
  const svg = editorArt('0 0 20 20', 'md-callout-art')
  svg.append(createSketch(svg).path(path, { stroke: 'currentColor', roughness: 0.55, strokeWidth: 1.35 }))
  return svg
}

export function createDiagramIssueArt() {
  const svg = editorArt('0 0 36 22', 'md-diagram-issue-art')
  const sketch = createSketch(svg)
  const ink = { stroke: 'currentColor', roughness: 0.65 }
  svg.append(
    sketch.rectangle(2, 6, 8, 10, ink),
    sketch.rectangle(26, 6, 8, 10, ink),
    sketch.path('M10 11h4 M22 11h4 M16 14l4-6', ink),
  )
  return svg
}

export function createDocumentArt(kind: 'markdown' | 'preview' | 'fallback') {
  const compact = kind === 'fallback'
  const svg = editorArt(compact ? '6 0 28 22' : '0 0 76 54', 'document-state-art')
  const sketch = createSketch(svg)
  const ink = { stroke: 'currentColor' }
  if (compact) {
    svg.append(sketch.path('M10 4h19v14H10Z M13 15l4-5 3 3 2-2 4 4 M11 19L29 3', { ...ink, roughness: 0.55 }))
    return svg
  }
  const paperInk = { stroke: 'var(--document-paper-ink)' }
  svg.append(
    sketch.polygon(
      [
        [17, 12],
        [46, 8],
        [54, 42],
        [23, 47],
      ],
      { ...paperInk, fill: 'var(--document-hatch)', hachureGap: 4, fillWeight: 0.65 },
    ),
    sketch.path('M28 6l22 3 10 11-4 27-33-4Z M50 9l-2 11 12 0', {
      ...paperInk,
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path(kind === 'markdown' ? 'M34 24l-4 13 M42 25l-4 13 M30 28l15 2 M29 33l14 2' : 'M31 26l19 2-1 11-20-2Z', {
      ...ink,
      strokeWidth: 1.55,
      roughness: 0.65,
    }),
  )
  return svg
}
