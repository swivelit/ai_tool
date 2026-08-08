# Swico Free node on Windows 11

This folder is a separate CPU inference service for Swico Free. It is not imported by the Render backend and its dependencies must not be added to `backend/requirements.txt`.

The service is sized for the 8 GB CPU-only laptop: one active generation, at most ten waiting requests, a 4096-token context, and at most 512 output tokens. Run one worker so both models load once and remain resident.

## Workflow A: Windows PowerShell

From a fresh Windows 11 PowerShell, install the basic tools (or install the same tools from their official installers):

```powershell
winget install --id Python.Python.3.11 --exact
winget install --id Git.Git --exact
winget install --id Kitware.CMake --exact
```

Close and reopen PowerShell after installation, then run:

```powershell
git clone <your-repository-url>
Set-Location .\ai_tool\swico_free_node
Copy-Item .env.example .env
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\doctor.ps1
.\scripts\install.ps1
```

If `llama-cpp-python` has no compatible wheel for the selected Python version, install the Visual Studio 2022 C++ Build Tools workload and rerun `install.ps1`; the package may then build locally.

Edit `.env`. `SWICO_FREE_NODE_TOKEN` must be the same long random secret later configured in Render. `SWICO_FREE_QWEN_GGUF_PATH` must point to an existing quantized GGUF file, and `SWICO_FREE_E5_MODEL_PATH` must point to a local Transformers model directory. The node never downloads a base model when these paths are configured.

The recommended values for the i5-8265U / 8 GB laptop are:

```dotenv
SWICO_FREE_NODE_HOST=127.0.0.1
SWICO_FREE_NODE_PORT=8765
SWICO_FREE_QWEN_THREADS=4
SWICO_FREE_QWEN_BATCH_SIZE=128
SWICO_FREE_E5_THREADS=2
SWICO_FREE_MAX_CONCURRENT_GENERATIONS=1
SWICO_FREE_MAX_QUEUE_SIZE=10
SWICO_FREE_MAX_OUTPUT_TOKENS=512
SWICO_FREE_MAX_CONCURRENT_EMBEDDINGS=1
SWICO_FREE_MAX_EMBEDDING_QUEUE_SIZE=4
```

The trained Qwen artifact must be exported before use: merge any adapter into the intended checkpoint, convert it with a compatible llama.cpp conversion tool, and quantize the resulting GGUF (for example, a tested Q4_K_M or Q5_K_M build). This repository does not include the base model, adapter, conversion tools, or weights. Do not point the node at an adapter directory or an unconverted Transformers checkpoint.

## Validate models before starting

Run this after configuring `.env`. It performs local-only artifact checks, loads both models, verifies 384-dimensional E5 output, and performs tiny smoke generations. It does not download anything:

```powershell
Set-Location .\swico_free_node
.\scripts\validate_models.ps1
```

For a SentenceTransformers export, `SWICO_FREE_E5_MODEL_PATH` may point to the saved directory containing `modules.json` and `0_Transformer`. The validator uses that transformer subdirectory and reports the missing local file category if the export is incomplete.

## Start and test locally

```powershell
Set-Location .\swico_free_node
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\run.ps1
```

In another PowerShell:

```powershell
Set-Location .\swico_free_node
.\scripts\health.ps1
. .\scripts\dotenv.ps1
Import-SwicoFreeDotEnv (Join-Path (Get-Location) '.env')
$token = $env:SWICO_FREE_NODE_TOKEN
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri http://127.0.0.1:8765/v1/embed -Method Post -Headers $headers -ContentType 'application/json' -Body '{"texts":["query text","document text"],"modes":["query","passage"]}'
Invoke-RestMethod -Uri http://127.0.0.1:8765/v1/generate -Method Post -Headers $headers -ContentType 'application/json' -Body '{"messages":[{"role":"user","content":"Say hello in one sentence."}],"max_output_tokens":32}'
```

The repository also includes a no-secret-output smoke script:

```powershell
.\scripts\smoke.ps1
```

Benchmark the already-running node. The output contains timings, generated-token count, throughput, and queue counters, but never prompts, paths, or tokens:

```powershell
.\scripts\benchmark.ps1
```

The lightweight doctor does not load either model. It checks Windows, Python,
the virtual environment, dotenv values, local artifact paths, port 8765, and
Tailscale status. It prints a safe `Next:` action for every failure.

## Workflow B: Git Bash / MINGW64

Use this workflow when the terminal prompt looks like:
`SHAJAHAN@DESKTOP-QTF7F78 MINGW64 /d/swico/ai_tool/swico_free_node`.
The `.sh` files are wrappers around the existing PowerShell scripts; they do
not duplicate node or inference logic. They convert Git Bash paths such as
`/d/swico/...` to Windows paths and invoke `powershell.exe` with
`-NoProfile -ExecutionPolicy Bypass`.

From Git Bash:

```bash
cd /d/swico/ai_tool/swico_free_node
./scripts/doctor.sh
./scripts/install.sh
./scripts/validate_models.sh
./scripts/run.sh
```

Run the last command in its own terminal. In a second Git Bash terminal:

```bash
cd /d/swico/ai_tool/swico_free_node
./scripts/smoke.sh
./scripts/funnel_smoke.sh
./scripts/benchmark.sh
```

On a first run, `doctor.sh` may report expected failures for `.venv`, `.env`,
the local model paths, port 8765, or Funnel before the later setup commands
have been completed. Follow each printed `Next:` action and run it again.

To test a Funnel URL without changing `.env`:

```bash
./scripts/funnel_smoke.sh -FunnelUrl https://desktop-qtf7f78.tailbdb31e.ts.net
```

## Tailscale Funnel

Keep the API bound to `127.0.0.1:8765`; browsers must never call it directly. After signing in to Tailscale on this laptop, run:

```powershell
tailscale funnel --bg 8765
tailscale funnel status
```

Copy the returned HTTPS URL into Render as `SWICO_FREE_INFERENCE_BASE_URL`. Keep the same token in the laptop `.env` as `SWICO_FREE_NODE_TOKEN` and in Render as `SWICO_FREE_INFERENCE_TOKEN`. Do not bind the model API to `0.0.0.0` and do not enable broad CORS.

The local Funnel smoke test uses the token from `.env` without printing it:

```bash
./scripts/funnel_smoke.sh
```

## Keep the laptop awake and start after login

When the laptop is plugged in, prevent sleep and hibernation so the Funnel remains available:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Register the node to start for the current Windows user after login. Run PowerShell as the same user who owns the Tailscale session:

```powershell
$NodeRoot = (Resolve-Path .\swico_free_node).Path
$Action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$NodeRoot\scripts\run.ps1`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'Swico Free Node' -Action $Action -Trigger $Trigger -Description 'Start the local Swico Free inference node' -RunLevel Limited -Force
```

Start Tailscale Funnel after login unless Tailscale itself is already configured to start Funnel. Confirm both services before enabling Free in Render:

```powershell
tailscale funnel status
Invoke-RestMethod -Uri https://desktop-qtf7f78.tailbdb31e.ts.net/health -Headers @{ Authorization = "Bearer <same-token>" }
```
