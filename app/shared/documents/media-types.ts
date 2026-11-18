const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
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
export const MAX_AUDIO_WAVEFORM_BYTES = 4 * 1024 * 1024
export const MAX_WAVEFORM_SECONDS = 300
export const MAX_WAVEFORM_PEAKS = 4096

export function isWorkspaceMediaUrl(value: string) {
  if (!value.startsWith('http://127.0.0.1:')) return false
  try {
    const url = new URL(value)
    return (
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      !url.username &&
      !url.password &&
      (url.search === '' || /^\?v=[1-9][0-9]*$/.test(url.search)) &&
      !url.hash &&
      /^\/media\/workspace-[\w-]+\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/[^/]+$/iu.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function isPixelDiffImage(type: string | null) {
  return type === 'image/png' || type === 'image/jpeg' || type === 'image/bmp' || type === 'image/x-icon'
}

export function streamedMediaInlineLimit(type: string | null, size: number) {
  if (size <= MAX_PIXEL_DIFF_IMAGE_BYTES && isPixelDiffImage(type)) return MAX_PIXEL_DIFF_IMAGE_BYTES
  if (size <= MAX_AUDIO_WAVEFORM_BYTES && type?.startsWith('audio/')) return MAX_AUDIO_WAVEFORM_BYTES
  return 0
}

export function mediaType(filename: string) {
  const name = filename.slice(filename.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  const extension = name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MEDIA_TYPES, extension) ? (MEDIA_TYPES[extension] ?? null) : null
}
