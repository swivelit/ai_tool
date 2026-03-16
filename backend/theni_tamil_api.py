from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    import torch
except Exception:
    torch = None

try:
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
except Exception:
    AutoModelForSeq2SeqLM = None
    AutoTokenizer = None


MODEL_ROOT = Path(os.getenv("THENI_MODEL_ROOT", "./models/stage_tamil_thenitamil_model")).resolve()
MAX_LENGTH = int(os.getenv("THENI_MODEL_MAX_LENGTH", "192"))
NUM_BEAMS = int(os.getenv("THENI_MODEL_NUM_BEAMS", "4"))
DEVICE = os.getenv("THENI_MODEL_DEVICE", "cpu").strip().lower() or "cpu"

app = FastAPI(title="Theni Tamil Local API")

_tokenizer = None
_model = None
_loaded_model_dir: Optional[Path] = None


class ConvertRequest(BaseModel):
    text: str


class ConvertResponse(BaseModel):
    ok: bool
    input_text: str
    theni_tamil_text: str
    source: str = "local_model_api"


def _is_hf_weight_file(filename: str) -> bool:
    return filename.endswith((".bin", ".safetensors"))


def _looks_like_full_hf_model_dir(model_dir: Path) -> bool:
    if not model_dir.is_dir():
        return False
    has_config = (model_dir / "config.json").exists()
    has_weights = any(_is_hf_weight_file(path.name) for path in model_dir.iterdir() if path.is_file())
    return has_config and has_weights


def _pick_best_model_dir(root: Path) -> Optional[Path]:
    if _looks_like_full_hf_model_dir(root):
        return root
    candidates = [path for path in root.glob("**/*") if _looks_like_full_hf_model_dir(path)]
    return sorted(candidates, key=lambda p: len(str(p)))[0] if candidates else None


def _cleanup(text: str) -> str:
    return " ".join(str(text or "").strip().split())


def _resolved_device() -> str:
    if DEVICE == "cuda" and torch is not None and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _ensure_model_loaded() -> None:
    global _tokenizer, _model, _loaded_model_dir

    if AutoTokenizer is None or AutoModelForSeq2SeqLM is None:
        raise RuntimeError("transformers is not installed. Install transformers, torch, sentencepiece, and safetensors.")

    model_dir = _pick_best_model_dir(MODEL_ROOT)
    if model_dir is None:
        raise RuntimeError(f"No Hugging Face model directory found under: {MODEL_ROOT}")

    if _loaded_model_dir == model_dir and _tokenizer is not None and _model is not None:
        return

    _tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
    _model = AutoModelForSeq2SeqLM.from_pretrained(str(model_dir))

    device = _resolved_device()
    if hasattr(_model, "to"):
        _model = _model.to(device)

    _loaded_model_dir = model_dir


@app.get("/health")
def health():
    model_dir = _pick_best_model_dir(MODEL_ROOT)
    return {
        "ok": True,
        "model_root": str(MODEL_ROOT),
        "resolved_model_dir": str(model_dir) if model_dir else None,
        "loaded": _loaded_model_dir is not None,
        "device": _resolved_device(),
    }


@app.post("/warmup")
def warmup():
    try:
        _ensure_model_loaded()
        return {
            "ok": True,
            "loaded": True,
            "resolved_model_dir": str(_loaded_model_dir),
            "device": _resolved_device(),
        }
    except Exception as exc:
        raise HTTPException(500, f"Warmup failed: {exc}")


@app.post("/convert", response_model=ConvertResponse)
def convert(payload: ConvertRequest):
    text = _cleanup(payload.text)
    if not text:
        raise HTTPException(400, "text is required")

    try:
        _ensure_model_loaded()
        encoded = _tokenizer(text, return_tensors="pt", truncation=True, max_length=MAX_LENGTH)

        if torch is not None:
            device = _resolved_device()
            encoded = {key: value.to(device) for key, value in encoded.items()}

        output_ids = _model.generate(**encoded, max_length=MAX_LENGTH, num_beams=NUM_BEAMS)
        output_text = _tokenizer.batch_decode(output_ids, skip_special_tokens=True)[0]
        return ConvertResponse(
            ok=True,
            input_text=text,
            theni_tamil_text=_cleanup(output_text),
        )
    except Exception as exc:
        raise HTTPException(500, f"Conversion failed: {exc}")