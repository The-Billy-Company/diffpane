// Copyright (c) 2026 The Billy Company
// Unicode mode matches lone surrogates while treating a valid pair as one code point.
const loneSurrogates = /[\uD800-\uDFFF]/gu

export function isWellFormedUtf16(value: string) {
  return value.search(loneSurrogates) < 0
}

export function toWellFormedUtf16(value: string) {
  return value.replace(loneSurrogates, '\uFFFD')
}
