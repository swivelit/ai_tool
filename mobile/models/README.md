# Local GGUF model assets

Do **not** commit the real model weights to git unless your repo/storage policy allows it.
The native `JaiOnDeviceModel` bridge expects these exact files at build time:

- `models/gemma-3-4b-it-q4_k_m.gguf`
- `models/qwen3-8b-q4_k_m.gguf`
- `models/qwen3-14b-q4_k_m.gguf`
- `models/qwen3-embedding-0.6b-q8_0.gguf`

Android prebuild copies non-empty files from this directory into
`android/app/src/main/assets/models/` via `plugins/withJaiOnDeviceModelAssets.js`.

Production `runtime.mode = "native_on_device"` intentionally fails clearly when a
file is missing. It must not call backend/OpenAI or fall back to hash embeddings.
