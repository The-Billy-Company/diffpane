import { createSketch } from '../illustrations/sketch.ts'

export function drawFileSearchArt(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const folderInk = { stroke: 'currentColor', strokeWidth: 1.4 }
  const paperInk = { stroke: 'var(--illustration-paper-ink)' }
  svg.append(
    sketch.path('M21 46V19Q21 16 24 16H37L42 21H67Q70 21 70 24V46Z', {
      ...folderInk,
      fill: 'var(--illustration-fill)',
      fillStyle: 'solid',
    }),
    sketch.path('M35 35L33 14L56 9L65 16L67 34Z', {
      ...paperInk,
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M56 9L58 18L65 16 M40 20L51 18 M41 25L53 23', paperInk),
    sketch.path('M21 46L28 30Q29 27 33 27H72Q76 27 75 31L69 46Q68 49 64 49H25Q21 49 21 46Z', {
      ...folderInk,
      fill: 'var(--illustration-face)',
      fillStyle: 'solid',
    }),
    sketch.path('M28 45L33 32H46L39 45Z', {
      stroke: 'none',
      fill: 'var(--illustration-hatch)',
      hachureGap: 3.5,
      fillWeight: 0.65,
    }),
  )
}

export function drawContentSearchArt(svg: SVGSVGElement) {
  const sketch = createSketch(svg)
  const lensInk = { stroke: 'currentColor', strokeWidth: 1.65 }
  const paperInk = { stroke: 'var(--illustration-paper-ink)' }
  svg.append(
    sketch.path('M18 13L54 10L57 46L21 49Z', {
      ...paperInk,
      fill: 'var(--surface-raised)',
      fillStyle: 'solid',
    }),
    sketch.path('M25 20l14-1 M25 26l19-1.5 M26 33l12-1 M27 40l20-1.5', paperInk),
    sketch.path('M65 37L80 49Q82 51 79 54Q77 56 75 54L63 41Z', {
      ...lensInk,
      fill: 'var(--illustration-face)',
      fillStyle: 'solid',
      roughness: 0.65,
    }),
    sketch.circle(56, 28, 31, {
      ...lensInk,
      fill: 'var(--illustration-fill)',
      fillStyle: 'solid',
      roughness: 0.65,
    }),
    sketch.path('M47 23l12-.5 M48 34l14-.5', paperInk),
    sketch.line(48, 28, 63, 27.5, { stroke: 'var(--match-background)', strokeWidth: 5.5, roughness: 0.45 }),
    sketch.line(48, 28, 63, 27.5, { ...lensInk, roughness: 0.45 }),
  )
}
