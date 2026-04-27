# Optional bundled GGUF assets for development

Real users should **not** manually place model files in this directory.
Production uses `modelDelivery.mode = "download_on_first_launch"`: the app
checks required GGUF files on first launch/setup, downloads missing files into
app-private storage, verifies byte size and SHA-256 when production integrity
metadata is enabled, and passes downloaded `file://` paths to the native runtime.

This `mobile/models/` directory is only for optional developer
`bundled_assets` builds. Use it when you intentionally want to package model
files at build time instead of testing the first-launch downloader.

Required filenames for bundled-assets development builds:

- `gemma-3-4b-it-q4_k_m.gguf`
- `qwen3-8b-q4_k_m.gguf`
- `qwen3-14b-q4_k_m.gguf`
- `qwen3-embedding-0.6b-q8_0.gguf`

Android prebuild copies non-empty files from this directory into
`android/app/src/main/assets/models/` via
`plugins/withJaiOnDeviceModelAssets.js`.

Production `runtime.mode = "native_on_device"` must fail clearly when a model is
missing, invalid, or the llama.cpp backend is missing. It must not call
backend/OpenAI and must not fall back to hash embeddings for those errors.
