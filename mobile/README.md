# Swico mobile app

This Expo/React Native app is a native client for the same authenticated
website API used by `web/`. Normal signed-in production chat enters the
canonical backend-first path:

```text
Expo/React Native screen
  -> Firebase ID token in Authorization: Bearer
  -> /api/web/bootstrap, /api/web/threads and /api/web/chat/stream
  -> existing backend TRIAG/RAG, tier, memory, knowledge and billing state
  -> streaming response persisted to the shared web thread
```

The mobile client does not run a local model or create a second AI pipeline.
The server remains authoritative for tier availability, limits, usage,
attachments, voice and model execution. `EXPO_PUBLIC_API_BASE` should point to
the production Render API:

```text
EXPO_PUBLIC_API_BASE=https://ai-tool-rrau.onrender.com
EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=false
EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false
EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=false
```

The old local-model/orb modules remain only as isolated legacy code for existing
development and historical tests; signed-in production navigation redirects all
non-chat legacy routes to the Swico chat screen. They are not used by the
production mobile chat request path.

## Native realtime Voice

Android realtime Voice uses the existing `JaiWakeWord` Expo module only as a
PCM capture bridge: `AudioRecord` emits 16 kHz mono S16LE frames of 512 samples
to the authenticated `/api/web/voice/sessions` WebSocket. The module enables
AEC, noise suppression and AGC when the device exposes those effects. Voice
audio is returned by the backend and played natively; no local model is used.

The Android path is feature-gated by the server bootstrap capability and the
native PCM bridge. iOS keeps realtime Voice disabled until its equivalent
`AVAudioEngine` PCM bridge is implemented. Recorded dictation and reply
synthesis remain available through the canonical `/api/web/audio/*` endpoints.

## Firebase Android config

The Android application ID is `com.swico.swivel`. The existing custom deep-link
scheme remains `com.swico.tamilai://` intentionally so previously issued links
continue to resolve; the scheme is independent of the Android application ID.
The iOS bundle identifier remains `com.swico.tamilai`.

Expo Android prebuild only points to `mobile/google-services.json` when the file
exists. The file is gitignored and must not be committed.

Local debug options:

```bash
# Real Firebase Auth in debug:
GOOGLE_SERVICES_JSON_BASE64=<base64-google-services-json> ./launch-debug_apk.sh
# or place mobile/google-services.json locally.

# Debug-lite/mock auth without native Firebase config:
EXPO_PUBLIC_E2E_MOCK_AUTH=1 ./launch-debug_apk.sh
# JAI_DEBUG_LITE=1 also allows the missing file for emulator smoke work.
```

Release/EAS builds must use one of these real Firebase Android config paths:

```bash
# A. Keep the downloaded Firebase file locally. Do not commit it.
mobile/google-services.json

# B. Provide the JSON through a secret env var.
GOOGLE_SERVICES_JSON_BASE64=<base64-google-services-json>
# or GOOGLE_SERVICES_JSON / FIREBASE_GOOGLE_SERVICES_JSON

# C. These public Firebase values are still required by the JS Firebase Auth
#    configuration. They do not replace the authoritative Android config for
#    com.swico.swivel and are not used to synthesize google-services.json.
EXPO_PUBLIC_FIREBASE_API_KEY=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_PROJECT_ID=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_APP_ID=<firebase-public-value>
```

`mobile/scripts/ensure-google-services-json.js` decodes or synthesizes the file
before prebuild/build and never prints Firebase values or JSON content. Release
verification also requires the backend API base and complete Firebase public
`EXPO_PUBLIC_FIREBASE_*` values. `mobile/google-services.json` is ignored by git
and must not be committed.

## Legacy backend smoke script

`npm run smoke:chat` is a legacy diagnostic for the older `/api/chat` contract;
it is not used by the production mobile screen. With no `SMOKE_CHAT_BASE_URL`, it
defaults to mock mode and does not require auth:

```bash
cd mobile
npm run smoke:chat
```

Real backend mode requires Firebase bearer auth because `/api/chat` uses the same authenticated user ownership checks as the app. `SMOKE_CHAT_USER_ID` only fills the legacy request body; the backend resolves and owns the real user from the verified bearer token and ignores spoofed IDs.

Using an existing Firebase ID token:

```bash
cd mobile
SMOKE_CHAT_BASE_URL=https://ai-tool-rrau.onrender.com \
SMOKE_CHAT_AUTH_TOKEN="$FIREBASE_ID_TOKEN" \
SMOKE_CHAT_USE_MOCK=false \
npm run smoke:chat
```

Using a dedicated Firebase email/password smoke account:

```bash
cd mobile
SMOKE_CHAT_BASE_URL=https://ai-tool-rrau.onrender.com \
SMOKE_CHAT_FIREBASE_API_KEY="$EXPO_PUBLIC_FIREBASE_API_KEY" \
SMOKE_CHAT_FIREBASE_EMAIL="smoke@example.com" \
SMOKE_CHAT_FIREBASE_PASSWORD="$SMOKE_CHAT_FIREBASE_PASSWORD" \
SMOKE_CHAT_ENSURE_USER=true \
SMOKE_CHAT_USE_MOCK=false \
npm run smoke:chat
```

For local development only, backend dev bearer tokens work when the backend is explicitly started with `AUTH_ALLOW_DEV_TOKENS=true`:

```bash
cd mobile
SMOKE_CHAT_BASE_URL=http://127.0.0.1:8000 \
SMOKE_CHAT_AUTH_TOKEN="dev:smoke-local:smoke@example.com" \
SMOKE_CHAT_USE_MOCK=false \
npm run smoke:chat
```

Common failures:

- `401`: missing or invalid bearer token.
- `404`: token is valid, but no backend user exists for that Firebase account. Sign up once in the app or set `SMOKE_CHAT_ENSURE_USER=true` for a dedicated smoke account.
- `503`: Firebase Admin, OpenAI, or another backend dependency is not configured.

## Runtime modes

- Backend AI router is the production/public primary runtime.
- `EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=false` disables local model release requirements.
- `runtime.mode = "native_on_device"` is available for explicit local fallback builds.
- `runtime.mode = "local_adapter"` is development-only and keeps `/chat/completions` and `/embeddings` as local adapter contracts.
- `modelDelivery.mode = "download_on_first_launch"` is used only when explicit native local fallback is enabled.
- `modelDelivery.mode = "bundled_assets"` is optional developer/build-time mode only.

The native Android/iOS bridge still has llama.cpp build wiring and guards for
explicit local fallback builds. Backend-first release builds do not require
llama.cpp. If local fallback is enabled, release machines must run
`npm run native:sync-llama` and `npm run native:verify-llama`.

## llama.cpp setup

Preferred path:

```text
mobile/modules/jai-on-device-model/vendor/llama.cpp
```

Initialize it on a fresh machine:

```bash
# From repo root, when the llama.cpp submodule is committed:
git submodule update --init --recursive

# Or from mobile/, works for submodule and zip checkouts:
npm run native:sync-llama
```

For CI/builds that use an external checkout:

```bash
JAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp npm run android:native
JAI_LLAMA_CPP_DIR=/absolute/path/to/llama.cpp npm run ios:native
```

For reproducible production builds, commit the submodule pointer or set `JAI_LLAMA_CPP_REF=<tag-or-commit>` when using the clone fallback in `npm run native:sync-llama`.

## CI/release verification order

Backend-first release CI does not need llama.cpp or GGUF metadata:

```bash
cd mobile
npm ci
npm run typecheck
npm test
npm run release:verify-backend-first
```

Explicit local fallback release CI must also prove llama.cpp is present and linkable before Expo prebuild generates native projects:

```bash
cd mobile
npm ci
EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=true
npm run native:sync-llama
npm run native:verify-llama
npx expo prebuild --platform android --clean
# then run the platform build, for example ./gradlew assembleRelease from android/
```

`npm run native:verify-llama` checks the vendored `include/llama.h` and `CMakeLists.txt`, configures Android CMake with `JAI_REQUIRE_LLAMA_CPP=ON`, compiles and links `jai_llama_runtime` with the Android NDK, verifies Android/iOS `JAI_LLAMA_CPP_AVAILABLE=1` wiring, compiles `JaiLlamaCppBridge.mm` on macOS, verifies explicit local-fallback missing-llama guards, and updates `nativeImplementationStatus` only after those checks pass. On non-macOS hosts it clearly reports that iOS compile verification was skipped while keeping podspec structural checks; explicit local fallback macOS CI/release builds must run the same verifier on macOS.

Optional GGUF smoke test:

```bash
npm run native:verify-llama -- --smoke --model /path/to/tiny.gguf
# Or use a separate embedding GGUF:
npm run native:verify-llama -- --smoke --model /path/to/tiny-chat.gguf --embedding-model /path/to/tiny-embed.gguf
```

The smoke mode builds a small host probe against llama.cpp, loads the supplied GGUF, and calls `completeChat` plus `embedTexts`. It still does not replace real target-device Gemma/Qwen validation in the mobile app with downloaded `file://` model paths.

## Optional local model delivery

Backend-first production users do **not** need GGUF files. When explicit local
fallback is enabled, users do **not** manually place GGUF files in
`mobile/models/`.

Optional local fallback startup/setup flow:

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

Lite first-launch required files:

```text
gemma-3-4b-it-q4_k_m.gguf
qwen3-embedding-0.6b-q8_0.gguf
```

Tiered/optional files:

```text
qwen3-8b-q4_k_m.gguf
qwen3-14b-q4_k_m.gguf
```

`mobile/data/config/models.json` defaults `modelDelivery.defaultTier` to `lite`, so first launch/basic chat requires only Gemma 4B plus the Qwen embedding model. Qwen 8B and Qwen 14B are downloaded only when the selected tier requires them, or when a release configuration deliberately validates metadata for all production model entries.

## Required EAS/mobile environment values

Backend-first release:

```bash
EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false
EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=false
EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=false
EXPO_PUBLIC_API_BASE=https://<your-render-service>
EXPO_PUBLIC_FIREBASE_API_KEY=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_PROJECT_ID=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<firebase-public-value>
EXPO_PUBLIC_FIREBASE_APP_ID=<firebase-public-value>

# Optional if you prefer JSON-secret input instead of synthesis from public env.
GOOGLE_SERVICES_JSON_BASE64=<base64-google-services-json>
# or GOOGLE_SERVICES_JSON / FIREBASE_GOOGLE_SERVICES_JSON
```

Explicit local fallback release additionally needs llama.cpp and GGUF delivery metadata.

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

When `EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=true` with
`runtime.mode=native_on_device` and `modelDelivery.mode=download_on_first_launch`,
`mobile/app.config.ts` fails the build clearly when the CDN URL path or
integrity metadata is missing. Explicit local fallback builds also fail clearly
when llama.cpp is missing.

## Local APK builds

From the repo root, `./build-apk.sh` builds a local Android APK and automatically loads mobile environment files before release verification, native verification, Expo config, Expo prebuild, and Gradle:

```bash
./build-apk.sh
```

Local APK builds load `mobile/.env` first and `mobile/.env.local` second. Values already exported in the shell take highest priority, so command-specific overrides such as `BUILD_TYPE=debug ./build-apk.sh` are preserved. The script logs only the loaded file names and precedence, never environment values.

Release APK builds default to `arm64-v8a`, which is the intended Android phone target and also the required target for explicit on-device llama.cpp fallback builds. Debug APK builds use the same `JAI_ANDROID_ABIS` source of truth across React Native, app Gradle, and the Jai native module. `./launch-debug_apk.sh` reads the connected device ABI with adb and builds a matching debug APK, including `x86_64` for supported emulators. You can override explicitly with:

```bash
JAI_ANDROID_ABIS=x86_64 BUILD_TYPE=debug ./build-apk.sh
JAI_ANDROID_ABIS=arm64-v8a ./build-apk.sh
```

After Gradle finishes, `./build-apk.sh` validates the APK native libraries and fails before install if required React Native libraries are missing for any selected ABI, or if the APK contains native libraries for an unselected ABI. It only requires `libjai_llama_runtime.so` when explicit local model fallback is enabled.

Android 15 introduced devices and emulator images with 16 KB memory pages. Apps that package native `.so` files must have uncompressed APK entries aligned for 16 KB loading and every ELF `LOAD` segment aligned to at least `0x4000`; otherwise Android 15+/Android 16-style 16 KB devices can show the Android App Compatibility warning or refuse to load the native code in future releases. [Android's guidance](https://developer.android.com/guide/practices/page-sizes) says NDK r28+ emits 16 KB-aligned shared libraries by default, while NDK r27 requires `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` or explicit linker flags. Expo SDK 54 / React Native 0.81.5 currently pins NDK `27.1.12297006` in `react-native/gradle/libs.versions.toml`, and the local SDK used by this repo has NDK r27 installed, so this project keeps r27 and applies the documented r27 flags instead of overriding Expo/RN to r28.

The custom Jai runtime is source-built by `mobile/modules/jai-on-device-model/android/src/main/cpp/CMakeLists.txt` and links `libjai_llama_runtime.so` with:

```text
-Wl,-z,max-page-size=16384
-Wl,-z,common-page-size=16384
```

The generated app CMake target (`libappmodules.so`) gets `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` from the local Expo config plugin. React Native, Hermes, Expo modules, Reanimated/Worklets, Screens, and other source-built native dependencies already receive the same r27 CMake argument from their Gradle integrations. Prebuilt AAR/Prefab libraries such as `libreactnative.so`, `libhermes.so`, `libhermestooling.so`, `libjsi.so`, `libfbjni.so`, `libc++_shared.so`, and Fresco/image pipeline libraries must come from package versions that ship 16 KB-compatible prebuilts; `./build-apk.sh` validates the final APK so incompatible dependency upgrades are caught immediately.

`./build-apk.sh` now runs both checks on the final `dist/tamil-ai-<type>.apk`:

```bash
zipalign -c -P 16 -v 4 dist/tamil-ai-debug.apk
llvm-readelf -l -W <each extracted lib/<abi>/*.so>
```

If `zipalign` or `llvm-readelf`/`readelf` is missing, the build fails with the exact Android SDK Build-Tools or NDK path to install. For quick local debug installs only, `JAI_ANDROID_ALLOW_16KB_INCOMPATIBLE_DEBUG=1 BUILD_TYPE=debug ./build-apk.sh` allows the build to continue after printing a strong warning. Release/production builds can never skip 16 KB validation.

To test on a 16 KB emulator:

```bash
adb shell getconf PAGE_SIZE
BUILD_TYPE=debug ./build-apk.sh
./launch-debug_apk.sh
zipalign -c -P 16 -v 4 dist/tamil-ai-debug.apk
```

`./launch-debug_apk.sh` prints `16 KB page-size emulator detected; APK must pass 16 KB native library validation.` when `adb shell getconf PAGE_SIZE` returns `16384`, and stops before install if validation fails unless the explicit debug escape hatch above is set.

For EAS/cloud backend-first builds, set Firebase public values, `EXPO_PUBLIC_API_BASE`, and the backend-first routing flags shown above. Set `EXPO_PUBLIC_LOCAL_MODEL_*` and llama.cpp-related values only for explicit local fallback builds. EAS/cloud builders do not receive your local `mobile/.env` or `mobile/.env.local` unless you explicitly provide those values to the build environment.

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

## Explicit Local Native Build Path

Expo Go cannot load custom native inference code. Use this path only when intentionally developing the optional local model fallback in a custom development build or prebuild/bare React Native workflow.

```bash
npm install
npm run native:sync-llama
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

Android CMake links the vendored llama.cpp `llama` target and sets `JAI_LLAMA_CPP_AVAILABLE=1` when the checkout exists.

iOS validates downloaded/bundled GGUF paths and delegates to `JaiLlamaCppBridge.mm`. The podspec compiles the vendored llama.cpp/ggml sources or links prebuilt static libraries under `vendor/llama.cpp/build-ios/**/lib*.a`, and sets `JAI_LLAMA_CPP_AVAILABLE=1` when the checkout exists.

The native module must never call backend/OpenAI.

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
