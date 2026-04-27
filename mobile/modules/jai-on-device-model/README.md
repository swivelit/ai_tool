# JaiOnDeviceModel native module

This local Expo module exposes the JavaScript bridge expected by `mobile/lib/nativeOnDeviceModelBridge.ts`:

- `initialize(config)`
- `completeChat(input)`
- `embedTexts(input)`

The module is local-only. It must never call OpenAI or the backend.

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

The JavaScript runtime and native module scaffolds are wired, but true llama.cpp inference is not complete in this zip because no llama.cpp checkout or implementation is vendored.

Do **not** claim Gemma/Qwen run on-device until the native runtime actually loads the downloaded GGUF file paths and returns generated text/vectors. Until then, both platforms fail clearly with `JAI_LLAMA_CPP_BACKEND_MISSING` and do not call backend/OpenAI.

## Android llama.cpp implementation checklist

Files to finish:

```text
mobile/modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt
mobile/modules/jai-on-device-model/android/src/main/cpp/jai_llama_runtime.cpp
mobile/modules/jai-on-device-model/android/src/main/java/com/harishajahan/jai/ondevice/JaiLlamaCppBinding.kt
mobile/modules/jai-on-device-model/android/src/main/java/com/harishajahan/jai/ondevice/JaiOnDeviceModelEngine.kt
```

Build-ready vendoring options:

```bash
# Option A: local module vendor path
git submodule add https://github.com/ggml-org/llama.cpp \
  mobile/modules/jai-on-device-model/vendor/llama.cpp

# Option B: android cpp-local path
git submodule add https://github.com/ggml-org/llama.cpp \
  mobile/modules/jai-on-device-model/android/src/main/cpp/llama.cpp

# Option C: pass an absolute/relative CMake path from Gradle/CMake
-DJAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp
```

Native functions that must be implemented without changing the Kotlin signatures:

```text
Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeCompleteChat(
  JNIEnv*, jobject, jstring model_path, jstring prompt,
  jint context_size, jint threads, jdouble temperature, jint max_tokens
) -> jstring

Java_com_harishajahan_jai_ondevice_JaiLlamaCppBinding_nativeEmbedText(
  JNIEnv*, jobject, jstring model_path, jstring text,
  jint context_size, jint threads
) -> jfloatArray
```

Required Android behavior:

1. Strip/resolve any `file://` model path and load the GGUF via `llama_model_load_from_file`.
2. Create/reuse a `llama_context` with requested `contextSize`, batch size, thread count, and mobile-safe defaults.
3. Format prompt from the Kotlin-built prompt string.
4. Tokenize prompt with the model vocab.
5. Decode prompt tokens and generated tokens with max-token handling.
6. Use temperature sampling and stop on EOS/stop tokens.
7. Return generated UTF-8 text.
8. For embeddings, create an embedding-enabled context, decode the input, read pooled embeddings via the llama.cpp embedding API, validate dimensions, and return `jfloatArray`.
9. Cache/reuse model/context safely per model path, and free all resources when replaced or on process shutdown.
10. Never call backend/OpenAI from native code.

## iOS llama.cpp implementation checklist

Files to finish:

```text
mobile/modules/jai-on-device-model/ios/JaiLlamaCppBridge.h
mobile/modules/jai-on-device-model/ios/JaiLlamaCppBridge.mm
mobile/modules/jai-on-device-model/ios/JaiOnDeviceModelModule.swift
mobile/modules/jai-on-device-model/ios/JaiOnDeviceModel.podspec
```

Build-ready vendoring options:

```bash
# Suggested local vendor path
git submodule add https://github.com/ggml-org/llama.cpp \
  mobile/modules/jai-on-device-model/vendor/llama.cpp
```

Then update `JaiOnDeviceModel.podspec` to compile the needed llama.cpp/ggml source files or link a prebuilt static library built from that checkout.

Objective-C++ methods that must be implemented without changing Swift call sites:

```objc
+ (nullable NSString *)completeChatWithModelPath:(NSString *)modelPath
                                          prompt:(NSString *)prompt
                                     contextSize:(NSInteger)contextSize
                                         threads:(NSInteger)threads
                                     temperature:(double)temperature
                                       maxTokens:(NSInteger)maxTokens
                                           error:(NSError **)error;

+ (nullable NSArray<NSNumber *> *)embedTextWithModelPath:(NSString *)modelPath
                                                    text:(NSString *)text
                                             contextSize:(NSInteger)contextSize
                                                 threads:(NSInteger)threads
                                                   error:(NSError **)error;
```

Required iOS behavior is the same as Android: load downloaded GGUF file paths, create llama.cpp model/context lifecycle, tokenize, decode, sample with temperature, enforce context/max-token limits, extract embeddings, and clean up/reuse resources safely. The native module must never call backend/OpenAI.
