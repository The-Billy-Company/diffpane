---
doc_radar:
  sentinels:
    - file: app/renderer/editor/documents/audio-waveform/ogg/decoder.ts
      contains: ['MAX_AUDIO_WAVEFORM_BYTES', 'createWaveWriter']
    - file: app/renderer/editor/documents/audio-waveform/ogg/wave.ts
      contains: ['MAX_PCM_BYTES = 64 * 1024 * 1024']
---

# Ogg audio fallback

The document preview uses the original media URL where WebKit can play it. If the media element reports unsupported Ogg audio, a dedicated worker lazily loads the Opus or Vorbis decoder and builds a seekable PCM WAVE preview. The fallback uses the document's existing 4 MiB inline audio budget and limits PCM to 64 MiB. Ogg files beyond those limits and files with multiple logical streams still need native codec support. The raw-byte preview remains available.

The worker reads one compressed page per decoder call. Closing the preview terminates the worker and releases its output URL.
