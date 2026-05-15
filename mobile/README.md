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

## Backend chat smoke test

`npm run smoke:chat` runs the seeded 10-question chat smoke test. With no `SMOKE_CHAT_BASE_URL`, it defaults to mock mode and does not require auth:

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

- `runtime.mode = "native_on_device"` is the intended production mode.
- `modelDelivery.mode = "download_on_first_launch"` is the production model delivery mode.
- `runtime.mode = "local_adapter"` is development-only and keeps `/chat/completions` and `/embeddings` as local adapter contracts.
- `modelDelivery.mode = "bundled_assets"` is optional developer/build-time mode only.

The native Android/iOS bridge now has production llama.cpp build wiring and production guards. Production `native_on_device` builds refuse to compile if llama.cpp is missing instead of shipping with `JAI_LLAMA_CPP_AVAILABLE=0`. The native verifier now performs an Android NDK compile/link probe for `jai_llama_runtime` and compiles the iOS Objective-C++ bridge on macOS.

This zip does not include the llama.cpp checkout itself, so release machines must still run `npm run native:sync-llama`. Do not claim true target-device Gemma/Qwen on-device inference is complete until a native app build with the synced llama.cpp checkout loads downloaded GGUF `file://` paths and returns generated text/vectors on physical devices. Use `npm run native:verify-llama -- --smoke --model /path/to/tiny.gguf` for an optional host GGUF smoke test that calls `completeChat` and `embedTexts`.

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

## CI/release native verification order

Release CI must prove llama.cpp is present and linkable before Expo prebuild generates native projects:

```bash
cd mobile
npm ci
npm run native:sync-llama
npm run native:verify-llama
npx expo prebuild --platform android --clean
# then run the platform build, for example ./gradlew assembleRelease from android/
```

`npm run native:verify-llama` checks the vendored `include/llama.h` and `CMakeLists.txt`, configures Android CMake with `JAI_REQUIRE_LLAMA_CPP=ON`, compiles and links `jai_llama_runtime` with the Android NDK, verifies Android/iOS `JAI_LLAMA_CPP_AVAILABLE=1` wiring, compiles `JaiLlamaCppBridge.mm` on macOS, verifies production/release missing-llama guards, and updates `nativeImplementationStatus` only after those checks pass. On non-macOS hosts it clearly reports that iOS compile verification was skipped while keeping podspec structural checks; macOS CI/release builds must run the same verifier on macOS.

Optional GGUF smoke test:

```bash
npm run native:verify-llama -- --smoke --model /path/to/tiny.gguf
# Or use a separate embedding GGUF:
npm run native:verify-llama -- --smoke --model /path/to/tiny-chat.gguf --embedding-model /path/to/tiny-embed.gguf
```

The smoke mode builds a small host probe against llama.cpp, loads the supplied GGUF, and calls `completeChat` plus `embedTexts`. It still does not replace real target-device Gemma/Qwen validation in the mobile app with downloaded `file://` model paths.

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

For any production EAS build with `runtime.mode=native_on_device`, `mobile/app.config.ts`, Android Gradle/CMake, and the iOS podspec fail clearly when llama.cpp is missing.

## Local APK builds

From the repo root, `./build-apk.sh` builds a local Android APK and automatically loads mobile environment files before release verification, native verification, Expo config, Expo prebuild, and Gradle:

```bash
./build-apk.sh
```

Local APK builds load `mobile/.env` first and `mobile/.env.local` second. Values already exported in the shell take highest priority, so command-specific overrides such as `BUILD_TYPE=debug ./build-apk.sh` are preserved. The script logs only the loaded file names and precedence, never environment values.

Release APK builds default to `arm64-v8a`, which is the intended target for the on-device llama.cpp runtime on Android phones. Debug APK builds use the same `JAI_ANDROID_ABIS` source of truth across React Native, app Gradle, and the Jai native module. `./launch-debug_apk.sh` reads the connected device ABI with adb and builds a matching debug APK, including `x86_64` for supported emulators. You can override explicitly with:

```bash
JAI_ANDROID_ABIS=x86_64 BUILD_TYPE=debug ./build-apk.sh
JAI_ANDROID_ABIS=arm64-v8a ./build-apk.sh
```

After Gradle finishes, `./build-apk.sh` validates the APK native libraries and fails before install if `libreactnative.so` or `libjai_llama_runtime.so` is missing for any selected ABI, or if the APK contains native libraries for an unselected ABI.

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

For EAS/cloud builds, set the same `EXPO_PUBLIC_LOCAL_MODEL_*`, `EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE`, and llama.cpp-related values as EAS environment variables or CI secrets. EAS/cloud builders do not receive your local `mobile/.env` or `mobile/.env.local` unless you explicitly provide those values to the build environment.

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
