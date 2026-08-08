# Swico Free node on Windows 11

This folder is a separate CPU inference service for Swico Free. It is not imported by the Render backend and its dependencies must not be added to `backend/requirements.txt`.

The service is sized for the 8 GB CPU-only laptop: one active generation, at most ten waiting requests, a 4096-token context, and at most 512 output tokens. Run one worker so both models load once and remain resident.

## Fresh PowerShell setup

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
.\scripts\install.ps1
```

If `llama-cpp-python` has no compatible wheel for the selected Python version, install the Visual Studio 2022 C++ Build Tools workload and rerun `install.ps1`; the package may then build locally.

Edit `.env`. `SWICO_FREE_NODE_TOKEN` must be the same long random secret later configured in Render. `SWICO_FREE_QWEN_GGUF_PATH` must point to an existing quantized GGUF file, and `SWICO_FREE_E5_MODEL_PATH` must point to a local Transformers model directory. The node never downloads a base model when these paths are configured.

The trained Qwen artifact must be exported before use: merge any adapter into the intended checkpoint, convert it with a compatible llama.cpp conversion tool, and quantize the resulting GGUF (for example, a tested Q4_K_M or Q5_K_M build). This repository does not include the base model, adapter, conversion tools, or weights. Do not point the node at an adapter directory or an unconverted Transformers checkpoint.

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
$token = (Get-Content .env | Where-Object { $_ -match '^SWICO_FREE_NODE_TOKEN=' }) -replace '^SWICO_FREE_NODE_TOKEN=', ''
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri http://127.0.0.1:8765/v1/embed -Method Post -Headers $headers -ContentType 'application/json' -Body '{"texts":["query text","document text"],"modes":["query","passage"]}'
Invoke-RestMethod -Uri http://127.0.0.1:8765/v1/generate -Method Post -Headers $headers -ContentType 'application/json' -Body '{"messages":[{"role":"user","content":"Say hello in one sentence."}],"max_output_tokens":32}'
```

## Tailscale Funnel

Keep the API bound to `127.0.0.1:8765`; browsers must never call it directly. After signing in to Tailscale on this laptop, run:

```powershell
tailscale funnel --bg 8765
tailscale funnel status
```

Copy the returned HTTPS URL into Render as `SWICO_FREE_INFERENCE_BASE_URL`. Keep the same token in the laptop `.env` as `SWICO_FREE_NODE_TOKEN` and in Render as `SWICO_FREE_INFERENCE_TOKEN`. Do not bind the model API to `0.0.0.0` and do not enable broad CORS.
