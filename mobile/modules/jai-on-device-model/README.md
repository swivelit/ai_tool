# JaiOnDeviceModel native module

This local Expo module exposes the JavaScript bridge expected by
`mobile/lib/nativeOnDeviceModelBridge.ts`:

- `initialize(config)`
- `completeChat(input)`
- `embedTexts(input)`

The module is local-only. It never calls OpenAI or the backend.

## Model delivery

Production uses `modelDelivery.mode = "download_on_first_launch"` from
`mobile/data/config/models.json`.

`mobile/lib/modelDownloadManager.ts` now:

- checks required GGUF install status in app-private storage;
- resolves public/signed CDN URLs from config or `EXPO_PUBLIC_LOCAL_MODEL_*` env values;
- starts first-launch downloads from the setup screen automatically;
- shows progress through the React setup UI;
- checks available device storage when expected byte sizes are known;
- verifies non-zero size, exact `expectedBytes` when provided, and `sha256` when provided;
- deletes invalid downloads and retries according to `maxRetries`;
- passes downloaded `file://` paths to `NativeOnDeviceModelRuntime`.

Production release builds should provide all four `expectedBytes` and `sha256`
values through config/env. If integrity metadata is required and missing, setup
fails clearly. The app must not silently call backend/OpenAI because model setup
failed.

`modelDelivery.mode = "bundled_assets"` is still supported only as an optional
development/build-time path. In that mode, put GGUF files in `mobile/models/`
before prebuild and keep `plugins/withJaiOnDeviceModelAssets.js` enabled.

## Android status

`JaiOnDeviceModelModule.kt` and `JaiOnDeviceModelEngine.kt` validate configured
GGUF file paths and delegate to `JaiLlamaCppBinding.kt`.

The Android module includes a build-ready CMake/JNI seam:

- `android/src/main/cpp/CMakeLists.txt`
- `android/src/main/cpp/jai_llama_runtime.cpp`

The exported JNI functions are present:

- `nativeCompleteChat(modelPath, prompt, contextSize, threads, temperature, maxTokens)`
- `nativeEmbedText(modelPath, text, contextSize, threads)`

They still fail honestly with `JAI_LLAMA_CPP_BACKEND_MISSING`. To complete true
inference, vendor llama.cpp or pass `-DJAI_LLAMA_CPP_DIR=/path/to/llama.cpp`,
then replace the TODO branches in `jai_llama_runtime.cpp` with:

1. GGUF loading via `llama_model_load_from_file` using downloaded `file://` paths;
2. prompt formatting/tokenization;
3. context creation using requested context size and thread count;
4. decoding loop with max-token handling and temperature sampling;
5. cancellation/resource cleanup and safe model/context reuse;
6. embedding extraction for `Qwen/Qwen3-Embedding-0.6B`.

Do not claim true Gemma/Qwen on-device inference until those functions actually
load GGUF files and generate text/vectors.

## iOS status

`JaiOnDeviceModelModule.swift` exposes the same bridge and validates downloaded
or bundled GGUF files. The Swift module now calls the Objective-C++ seam:

- `ios/JaiLlamaCppBridge.h`
- `ios/JaiLlamaCppBridge.mm`

That seam still fails honestly with `JAI_LLAMA_CPP_BACKEND_MISSING` until
llama.cpp is linked and implemented. To complete true inference, wire the same
model loading, prompt/tokenization, decoding, max-token, context-size,
thread-count, and embedding extraction behavior in Objective-C++.

## Required models

- `gemma-3-4b-it-q4_k_m.gguf`
- `qwen3-8b-q4_k_m.gguf`
- `qwen3-14b-q4_k_m.gguf`
- `qwen3-embedding-0.6b-q8_0.gguf`
