# J AI mobile app

This Expo/React Native app is configured so normal chat enters the phone-local agent pipeline first:

```text
apiPost("/api/chat")
  -> handleLocalChat()
  -> runLocalAssistantTurn()
  -> Profiler Agent when profile facts/onboarding gaps are detected
  -> Memory & Cache Agent
  -> Orchestrator Agent
  -> Native on-device Gemma/Qwen runtime
  -> Alignment Agent
  -> reply
```

Backend/OpenAI remains available only through the explicit fallback path:

```text
local pipeline explicitly decides fallback is required
  -> apiPostBackendOnly("/api/chat")
  -> backend/OpenAI
  -> optional local alignment
  -> reply
```

Do not change normal `/api/chat` into a backend-primary path. Missing model files, failed downloads, checksum mismatches, missing native bridge code, or missing llama.cpp bindings must fail clearly and must not silently call backend/OpenAI.

## Runtime modes

- `runtime.mode = "native_on_device"` is the intended production mode.
- `modelDelivery.mode = "download_on_first_launch"` is the production model delivery mode.
- `runtime.mode = "local_adapter"` is development-only and keeps `/chat/completions` and `/embeddings` as local adapter contracts.
- `modelDelivery.mode = "bundled_assets"` is optional developer/build-time mode only.

True Gemma/Qwen on-device inference is not complete until the native `JaiOnDeviceModel` module links llama.cpp and its native functions actually load GGUF files and generate text/vectors. Until then, native mode fails with `JAI_LLAMA_CPP_BACKEND_MISSING` instead of pretending inference works.

## Production model delivery

Production users do **not** manually place GGUF files in `mobile/models/`.

Production startup/setup flow:

```text
App launches
  -> app checks required GGUF files in app-private storage
  -> if any file is missing/invalid, /model-setup opens
  -> /model-setup automatically starts required downloads
  -> each file is saved under FileSystem.documentDirectory + "models/"
  -> size and SHA-256 are verified
  -> invalid files are deleted and retried
  -> downloaded file:// paths are passed to NativeOnDeviceModelRuntime
```

The setup screen shows current model, per-model progress, total progress, required download size, Wi-Fi/storage warning, clear errors, and retry.

Required files:

```text
gemma-3-4b-it-q4_k_m.gguf
qwen3-8b-q4_k_m.gguf
qwen3-14b-q4_k_m.gguf
qwen3-embedding-0.6b-q8_0.gguf
```

## Required production environment values

Use either one public CDN base URL or per-model public/signed URLs. Do not put long-lived secrets in `EXPO_PUBLIC_*` values because they are bundled into the app.

```bash
# Option A: one public CDN base used with cdn://models/<fileName>
EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL=https://cdn.example.com/jai

# Option B: per-model public or release-generated signed URLs
EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B=https://cdn.example.com/jai/models/gemma-3-4b-it-q4_k_m.gguf
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B=https://cdn.example.com/jai/models/qwen3-8b-q4_k_m.gguf
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B=https://cdn.example.com/jai/models/qwen3-14b-q4_k_m.gguf
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED=https://cdn.example.com/jai/models/qwen3-embedding-0.6b-q8_0.gguf

# Exact byte sizes from your release artifact pipeline
EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B=<exact-bytes>
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B=<exact-bytes>
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B=<exact-bytes>
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED=<exact-bytes>

# SHA-256 of the exact GGUF files users will download
EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B=<64-hex-sha256>
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B=<64-hex-sha256>
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B=<64-hex-sha256>
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED=<64-hex-sha256>
```

For production EAS builds with `runtime.mode=native_on_device` and `modelDelivery.mode=download_on_first_launch`, `mobile/app.config.ts` fails the build clearly when the CDN URL path or integrity metadata is missing.

## Optional developer bundled-assets mode

Use `mobile/models/` only when intentionally testing a bundled-assets development build:

```text
mobile/models/gemma-3-4b-it-q4_k_m.gguf
mobile/models/qwen3-8b-q4_k_m.gguf
mobile/models/qwen3-14b-q4_k_m.gguf
mobile/models/qwen3-embedding-0.6b-q8_0.gguf
```

Then set:

```bash
EXPO_PUBLIC_LOCAL_MODEL_DELIVERY_MODE=bundled_assets
```

The Expo config plugin copies non-empty files from `mobile/models/` into native assets during prebuild. This is not the real-user production flow.

## Native app build path

Expo Go cannot load custom native inference code. Use a custom development build or prebuild/bare React Native workflow.

```bash
npm install
npx expo prebuild --clean
npm run android:native
# or
npm run ios:native
```

The checked-in native module scaffold is at:

```text
modules/jai-on-device-model/
```

Android validates downloaded/bundled GGUF paths and delegates to `JaiLlamaCppBinding`, which expects `libjai_llama_runtime.so` to export `nativeCompleteChat` and `nativeEmbedText`.

iOS validates downloaded/bundled GGUF paths and delegates to `JaiLlamaCppBridge.mm`.

The remaining native implementation is documented in `modules/jai-on-device-model/README.md`. The native module must never call backend/OpenAI.

## Development local adapter

For local development only, you can point the app at an OpenAI-compatible LAN adapter:

```bash
EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE=local_adapter \
EXPO_PUBLIC_LOCAL_MODEL_BASE_URL=http://192.168.1.23:10000/v1 \
npx expo start
```

Do not use `local_adapter` for production builds.

## Tests

```bash
npm test
npm run test:local-agents
npm run test:profiler
```
