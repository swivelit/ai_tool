# JaiOnDeviceModel native module

This local Expo module exposes the JavaScript bridge expected by
`mobile/lib/nativeOnDeviceModelBridge.ts`:

- `initialize(config)`
- `completeChat(input)`
- `embedTexts(input)`

The module is local-only. It does not call OpenAI or the backend.

## Model delivery

Production should use `modelDelivery.mode = "download_on_first_launch"` from
`mobile/data/config/models.json`. `mobile/lib/modelDownloadManager.ts` downloads
missing GGUF files into app-private storage, verifies non-zero size plus optional
`expectedBytes` / `sha256`, and passes downloaded `file://` paths to this native
module.

`modelDelivery.mode = "bundled_assets"` is still supported as an optional
development/build-time path. In that mode, put GGUF files in `mobile/models/`
before prebuild and keep `plugins/withJaiOnDeviceModelAssets.js` enabled.

## Android status

`JaiOnDeviceModelModule.kt` and `JaiOnDeviceModelEngine.kt` validate configured
GGUF file paths and delegate to `JaiLlamaCppBinding.kt`.

The Android module now includes the CMake/JNI structure for
`libjai_llama_runtime.so`:

- `android/src/main/cpp/CMakeLists.txt`
- `android/src/main/cpp/jai_llama_runtime.cpp`

The exported JNI functions are present:

- `nativeCompleteChat(modelPath, prompt, contextSize, threads, temperature, maxTokens)`
- `nativeEmbedText(modelPath, text, contextSize, threads)`

They currently fail honestly with `JAI_LLAMA_CPP_BACKEND_MISSING`. To complete
true inference, link llama.cpp and implement model loading, tokenization,
decoding, context reuse, cancellation, memory limits, and embedding extraction in
`jai_llama_runtime.cpp`.

## iOS status

`JaiOnDeviceModelModule.swift` exposes the same bridge and validates downloaded
or bundled GGUF files. The module also includes an Objective-C++ seam for the
future llama.cpp backend:

- `ios/JaiLlamaCppBridge.h`
- `ios/JaiLlamaCppBridge.mm`

The Swift binding still fails honestly with `JAI_LLAMA_CPP_BACKEND_MISSING`
until llama.cpp is linked and the Swift/C++ bridge is completed. Do not claim
Gemma/Qwen on-device inference is complete until these methods actually load and
run the downloaded GGUF files.

## Required models

- `gemma-3-4b-it-q4_k_m.gguf`
- `qwen3-8b-q4_k_m.gguf`
- `qwen3-14b-q4_k_m.gguf`
- `qwen3-embedding-0.6b-q8_0.gguf`
