const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
}

export const MAX_PIXEL_DIFF_IMAGE_BYTES = 4 * 1024 * 1024

export function isPixelDiffImage(type: string | null) {
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/bmp' || type === 'image/x-icon'
}

export function mediaType(filename: string) {
  const name = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MEDIA_TYPES, extension) ? (MEDIA_TYPES[extension] ?? null) : null
}
