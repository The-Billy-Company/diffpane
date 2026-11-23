// Copyright (c) 2026 The Billy Company
export async function ensurePopoverSupport() {
  if ('popover' in HTMLElement.prototype) return
  const { apply } = await import('@oddbird/popover-polyfill/fn')
  apply()
}
