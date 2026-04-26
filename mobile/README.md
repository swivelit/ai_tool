# J AI mobile app

This Expo/React Native app is configured to run chat through the phone-local agent pipeline first:

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
local pipeline decides fallback is required
  -> apiPostBackendOnly("/api/chat")
  -> backend/OpenAI
  -> optional local alignment
  -> reply
```

## Runtime modes

- `runtime.mode = "native_on_device"` is the intended production mode.
- `runtime.mode = "local_adapter"` is development-only and keeps `/chat/completions` and `/embeddings` as local adapter contracts.
- Production native mode requires the `JaiOnDeviceModel` native module and real bundled GGUF files. Missing native bridge/model files fail clearly and must not silently call backend/OpenAI or use hash embeddings.

## Required local model files

Place the real quantized GGUF files in `mobile/models/` before prebuild:

```text
mobile/models/gemma-3-4b-it-q4_k_m.gguf
mobile/models/qwen3-8b-q4_k_m.gguf
mobile/models/qwen3-14b-q4_k_m.gguf
mobile/models/qwen3-embedding-0.6b-q8_0.gguf
```

These files are intentionally ignored by git in this scaffold. The Expo config plugin copies non-empty files into `android/app/src/main/assets/models/` during prebuild. If a file is absent, the app can still build, but `JaiOnDeviceModel.initialize()` fails with a clear missing-model error in `native_on_device` mode.

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

Android currently exposes the bridge and validates/copies bundled model assets. The JNI seam is `JaiLlamaCppBinding`, which expects a native library named `libjai_llama_runtime.so` exporting `nativeCompleteChat` and `nativeEmbedText`. Until that llama.cpp JNI implementation is linked, native mode fails with `JAI_LLAMA_CPP_BACKEND_MISSING` rather than pretending that on-device inference works.

iOS exposes the same bridge contract and model-file validation. The Swift llama.cpp binding is a scaffold and also fails clearly until linked.

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
