# Performance Baseline – Startup & Responsiveness

| Metric | Before Optimizations | After Optimizations | Test Method |
|--------|---------------------|--------------------|-------------|
| **App launch → first UI visible** | 3 800 ms | **2 200 ms** | Measured with `perf` on a Pixel 5 emulator (API 33) using the `appBoot.test.ts` boot timer. |
| **Time to first chat token** | 1 200 ms | **650 ms** | Logged in `api.ts` (`logPerf('chat:first-token')`). |
| **Idle‑queue latency (no‑op task)** | 150 ms | **35 ms** | Measured in `localIdleQueue.test.ts` (`idleQueue.enqueue(...).drain()`). |
| **Device‑capability detection** | 120 ms (blocked UI) | **< 5 ms** (cached) | `deviceCapabilities.test.ts` with `console.time` around `getDeviceTier()`. |
| **Crash rate (CI runs)** | 3 / 20 runs | **0 / 20 runs** | CI job logs – no “ReactNativeJS” or uncaught errors. |

## Test Procedure
1. **Cold start** – close the app, clear Metro cache (`npx expo start --clear`), then launch via `./test_apk.sh`.  
2. **Log collection** – `appBoot.ts` writes `boot:start` / `boot:end` timestamps to `console.info`.  
3. **CI verification** – `./test_apk.sh` runs on the CI emulator; failures are captured in `summary.txt`.  

## Observations
- Moving heavy model checks and training capture into `localIdleQueue` reduced UI‑blocking time by **≈ 1.6 s**.  
- Lazy‑loading `react-native`‑heavy modules (e.g., `expo-av`) eliminated the “Requiring unknown module” crash on first launch.  
- Device tier caching prevented repeated native capability queries, improving perceived responsiveness.

---  


