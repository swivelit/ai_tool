# JaiOnDeviceModel native module

This local Expo module exposes the JavaScript bridge expected by
`mobile/lib/nativeOnDeviceModelBridge.ts`:

- `initialize(config)`
- `completeChat(input)`
- `embedTexts(input)`

The module is local-only. It does not call OpenAI or the backend.

## Android status

`JaiOnDeviceModelModule.kt` and `JaiOnDeviceModelEngine.kt` validate the configured
GGUF assets and copy bundled APK assets to app-private storage before inference.
`JaiLlamaCppBinding.kt` is the JNI seam for llama.cpp and expects a native library
named `libjai_llama_runtime.so` with:

- `nativeCompleteChat(modelPath, prompt, contextSize, threads, temperature, maxTokens)`
- `nativeEmbedText(modelPath, text, contextSize, threads)`

Until the CMake/JNI llama.cpp implementation is added, calls fail clearly with
`JAI_LLAMA_CPP_BACKEND_MISSING`.

## iOS status

`JaiOnDeviceModelModule.swift` exposes the same bridge and validates bundled GGUF
resources. The Swift/C++ llama.cpp binding is intentionally a scaffold and fails
clearly until linked.

## Model assets

Put real model files in `mobile/models/` before prebuild:

- `gemma-3-4b-it-q4_k_m.gguf`
- `qwen3-8b-q4_k_m.gguf`
- `qwen3-14b-q4_k_m.gguf`
- `qwen3-embedding-0.6b-q8_0.gguf`
