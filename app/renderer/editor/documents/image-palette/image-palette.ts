const SAMPLE_EDGE = 64

export async function appendImagePalette(host: HTMLElement, image: HTMLImageElement, signal: AbortSignal) {
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = new OffscreenCanvas(width, height).getContext('2d')
  if (!context) return

  // Draw the decoded preview directly so SVGs with only a viewBox can be sampled too.
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height)
  if (!pixels.data.some((channel, index) => index % 4 === 3 && channel > 0)) return

  const { getPaletteSync } = await import('colorthief')
  if (signal.aborted) return
  const colors = getPaletteSync(pixels, { colorCount: 5, quality: 1, ignoreWhite: false, alphaThreshold: 1 })
  if (!colors?.length) return

  const strip = document.createElement('span')
  strip.className = 'preview-image-palette'
  strip.role = 'img'
  strip.setAttribute('aria-label', `Dominant colors: ${colors.map(color => color.hex()).join(', ')}`)
  for (const color of colors) {
    const swatch = document.createElement('span')
    const hex = color.hex()
    swatch.style.backgroundColor = hex
    swatch.style.flexGrow = String(color.proportion)
    swatch.title = hex
    strip.append(swatch)
  }
  host.append(strip)
  signal.addEventListener('abort', () => strip.remove(), { once: true })
}
