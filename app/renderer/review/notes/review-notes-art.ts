import { createSketch } from '../../illustrations/sketch.ts'

export function drawReviewNotesArt(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const paperInk = 'var(--review-notes-paper-ink)'
  const paper = sketch.path('M14 11l30-4 5 37-30 4Z', {
    fill: 'var(--surface-raised)',
    fillStyle: 'solid',
    stroke: paperInk,
  })
  const lines = sketch.path('M20 18l17-2 M21 23l12-1.5 M24 38l15-2', { stroke: paperInk })
  const selection = sketch.path('M19 28l23-3 1 7-23 3Z', {
    fill: 'var(--review-notes-mark-fill)',
    fillStyle: 'solid',
    stroke: 'none',
  })
  const selectedLine = sketch.path('M23 31l15-2', { stroke: 'currentColor' })
  const bubble = sketch.path('M49 16h20q5 0 5 5v7q0 5-5 5H56l-8 6 1-6q-5 0-5-5v-7q0-5 5-5Z', {
    fill: 'var(--violet-surface)',
    fillStyle: 'solid',
    stroke: 'currentColor',
  })
  const comment = sketch.path('M50 22h16 M50 27h11', { stroke: 'currentColor' })
  comment.classList.add('review-notes-art-comment')
  const check = sketch.path('M54 24l3.5 4 7-8', { stroke: 'currentColor', strokeWidth: 1.65 })
  check.classList.add('review-notes-art-check')
  svg.replaceChildren(paper, lines, selection, selectedLine, bubble, comment, check)
}
