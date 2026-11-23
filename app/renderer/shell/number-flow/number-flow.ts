// Copyright (c) 2026 The Billy Company
import NumberFlow from 'number-flow'

/** Pair the animated digits with an accessible label or status in the caller. */
export function createRollingNumber() {
  const number = new NumberFlow()
  number.setAttribute('aria-hidden', 'true')
  number.format = { numberingSystem: 'latn' }
  number.transformTiming = { duration: 360, easing: 'ease-out' }
  number.opacityTiming = { duration: 180, easing: 'ease-out' }
  return number
}
