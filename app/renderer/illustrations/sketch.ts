// Copyright (c) 2026 The Billy Company
import rough from 'roughjs'

export function createSketch(svg: SVGSVGElement) {
  return rough.svg(svg, {
    options: { seed: 42, roughness: 0.9, strokeWidth: 1.15, fixedDecimalPlaceDigits: 2 },
  })
}
