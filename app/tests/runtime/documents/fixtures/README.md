---
doc_radar:
  sentinels:
    - file: app/tests/runtime/documents/media.test.mjs
      contains: ['opus.ogg', '48_000', 'vorbis.ogg', '44_100']
---

# Audio fixtures

These short 500 Hz tones were generated with FFmpeg for the Ogg fallback tests. The Opus fixture is mono at 48 kHz. The Vorbis fixture is stereo at 44.1 kHz.
