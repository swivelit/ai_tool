# JaiOnDeviceModel native module

This local Expo module exposes the JavaScript bridge expected by `mobile/lib/nativeOnDeviceModelBridge.ts`:

- `initialize(config)`
- `completeChat(input)`
- `embedTexts(input)`

The module is local-only. It must never call OpenAI or the backend.

## llama.cpp source requirement

Production `native_on_device` builds require a usable llama.cpp checkout at:

```text
mobile/modules/jai-on-device-model/vendor/llama.cpp
```

Fresh machines should initialize it before prebuild/build:

```bash
# From the repository root, when this repo is configured with the submodule:
git submodule update --init --recursive

# Or from mobile/, works for submodule checkouts and zip checkouts:
npm run native:sync-llama
```

`npm run native:sync-llama` first tries the submodule path and then falls back to a shallow clone into the same vendor directory. Set `JAI_LLAMA_CPP_REF=<tag-or-commit>` in CI if you use the clone fallback instead of a committed submodule pointer.

You may also point native builds at an external checkout:

```bash
JAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp npm run android:native
JAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp npm run ios:native
```

## Production guard behavior

The Android Gradle/CMake path and iOS podspec now refuse production `native_on_device` builds when llama.cpp is missing:

- Android passes `-DJAI_REQUIRE_LLAMA_CPP=ON` for `EAS_BUILD_PROFILE=production` and `EXPO_PUBLIC_LOCAL_MODEL_RUNTIME_MODE=native_on_device`.
- Android CMake sets `JAI_LLAMA_CPP_AVAILABLE=1` only when it finds `CMakeLists.txt` and `include/llama.h` in the llama.cpp checkout.
- Android CMake fails production configure instead of silently compiling `JAI_LLAMA_CPP_AVAILABLE=0`.
- iOS podspec raises during pod install/build for the same production profile when llama.cpp is missing.
- iOS podspec sets `JAI_LLAMA_CPP_AVAILABLE=1` when the vendored checkout exists, or `0` only for non-production development scaffolds.

`JAI_LLAMA_CPP_BACKEND_MISSING` is therefore allowed only in non-production/dev missing-backend builds.

## Model delivery

Production uses `modelDelivery.mode = "download_on_first_launch"` from `mobile/data/config/models.json`.

`mobile/lib/modelDownloadManager.ts`:

- checks required GGUF install status in app-private storage;
- resolves public/signed CDN URLs from `EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL` or per-model `EXPO_PUBLIC_LOCAL_MODEL_URL_*` values;
- starts first-launch downloads automatically from `/model-setup`;
- shows progress through the React setup UI;
- checks available device storage when expected byte sizes are known;
- verifies non-zero size, exact `expectedBytes`, and `sha256` when production integrity metadata is enabled;
- deletes invalid downloads and retries according to `maxRetries`;
- passes downloaded `file://` paths to `NativeOnDeviceModelRuntime`.

Production native-on-device builds require these values:

```text
EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL
EXPO_PUBLIC_LOCAL_MODEL_BYTES_GEMMA_4B
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_8B
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_14B
EXPO_PUBLIC_LOCAL_MODEL_BYTES_QWEN_EMBED
EXPO_PUBLIC_LOCAL_MODEL_SHA256_GEMMA_4B
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_8B
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_14B
EXPO_PUBLIC_LOCAL_MODEL_SHA256_QWEN_EMBED
```

You may replace the CDN base URL with per-model URL values:

```text
EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_8B
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_14B
EXPO_PUBLIC_LOCAL_MODEL_URL_QWEN_EMBED
```

Use public CDN URLs or release-generated signed URLs. Do not hardcode secrets into the app.

`modelDelivery.mode = "bundled_assets"` is still supported only as an optional development/build-time path. In that mode, put GGUF files in `mobile/models/` before prebuild and keep `plugins/withJaiOnDeviceModelAssets.js` enabled.

## Required models

- `gemma-3-4b-it-q4_k_m.gguf`
- `qwen3-8b-q4_k_m.gguf`
- `qwen3-14b-q4_k_m.gguf`
- `qwen3-embedding-0.6b-q8_0.gguf`

## Current inference status

The JavaScript runtime, model download flow, Android JNI bridge, iOS Objective-C++ bridge, and llama.cpp build wiring are in place. Production builds now fail before shipping if llama.cpp is missing.

This zip still does **not** include the llama.cpp checkout itself and I did not run a native Android/iOS build with real GGUF files here. Do **not** claim true Gemma/Qwen on-device inference is complete until a native build with the synced llama.cpp checkout loads the downloaded GGUF `file://` paths and returns generated text/vectors on target devices.

## Android llama.cpp implementation

Files involved:

```text
mobile/modules/jai-on-device-model/android/build.gradle
mobile/modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt
mobile/modules/jai-on-device-model/android/src/main/cpp/jai_llama_runtime.cpp
mobile/modules/jai-on-device-model/android/src/main/java/com/harishajahan/jai/ondevice/JaiLlamaCppBinding.kt
mobile/modules/jai-on-device-model/android/src/main/java/com/harishajahan/jai/ondevice/JaiOnDeviceModelEngine.kt
```

Behavior:

1. Strip/resolve any `file://` model path and load the GGUF via `llama_model_load_from_file`.
2. Create a llama.cpp context with requested `contextSize`, batch size, thread count, and mobile-safe defaults.
3. Format prompt from the Kotlin-built prompt string.
4. Tokenize prompt with the model vocab.
5. Decode prompt tokens and generated tokens with max-token handling.
6. Use temperature sampling and stop on EOS/stop tokens.
7. Return generated UTF-8 text.
8. For embeddings, create an embedding-enabled context, decode the input, read pooled embeddings via the llama.cpp embedding API, validate dimensions, and return `jfloatArray`.
9. Cache/reuse model handles safely by model path.
10. Never call backend/OpenAI from native code.

## iOS llama.cpp implementation

Files involved:

```text
mobile/modules/jai-on-device-model/ios/JaiLlamaCppBridge.h
mobile/modules/jai-on-device-model/ios/JaiLlamaCppBridge.mm
mobile/modules/jai-on-device-model/ios/JaiOnDeviceModelModule.swift
mobile/modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec
```

The iOS behavior mirrors Android: load downloaded GGUF file paths, create llama.cpp model/context lifecycle, tokenize, decode, sample with temperature, enforce context/max-token limits, extract embeddings, and clean up/reuse resources safely. The native module must never call backend/OpenAI.
