from __future__ import annotations

import json
from pathlib import Path


def resolve_e5_transformer_path(path: Path) -> Path:
    """Resolve a plain Transformers or SentenceTransformers local layout."""
    modules_path = path / "modules.json"
    if not modules_path.is_file():
        return path
    try:
        modules = json.loads(modules_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("the local E5 modules.json is not valid JSON") from exc
    if not isinstance(modules, list):
        raise RuntimeError("the local E5 modules.json must contain a module list")

    transformer_module: dict[str, object] | None = None
    for module in modules:
        if not isinstance(module, dict):
            continue
        module_type = str(module.get("type") or "").strip()
        if (
            module_type == "sentence_transformers.models.Transformer"
            or module_type.rsplit(".", 1)[-1].casefold() == "transformer"
        ):
            transformer_module = module
            break
    if transformer_module is None:
        raise RuntimeError("the local E5 modules.json has no Transformer module")
    if "path" not in transformer_module or not isinstance(transformer_module["path"], str):
        raise RuntimeError("the local E5 Transformer module has an invalid path")

    relative_path = Path(transformer_module["path"])
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise RuntimeError("the local E5 Transformer module path must stay inside the model directory")
    root = path.resolve()
    transformer = (path / relative_path).resolve()
    try:
        transformer.relative_to(root)
    except ValueError as exc:
        raise RuntimeError("the local E5 Transformer module path must stay inside the model directory") from exc
    if not transformer.is_dir():
        display_path = transformer_module["path"] or "."
        raise RuntimeError(f"the local E5 Transformer module path does not exist: {display_path}")
    return transformer


def validate_e5_artifacts(path: Path) -> Path:
    if not path.is_dir():
        raise RuntimeError("SWICO_FREE_E5_MODEL_PATH must point to a local model directory")
    transformer = resolve_e5_transformer_path(path)
    if not (transformer / "config.json").is_file():
        raise RuntimeError("the local E5 model is missing config.json")
    tokenizer_files = (
        "tokenizer.json", "tokenizer.model", "sentencepiece.bpe.model",
        "spiece.model", "vocab.txt",
    )
    if not any((transformer / name).is_file() for name in tokenizer_files):
        raise RuntimeError(
            "the local E5 model is missing tokenizer files; export tokenizer.json, tokenizer.model, sentencepiece.bpe.model, spiece.model, or vocab.txt"
        )
    weight_files = (
        "model.safetensors", "pytorch_model.bin", "model.safetensors.index.json",
        "pytorch_model.bin.index.json",
    )
    if not any((transformer / name).is_file() for name in weight_files):
        raise RuntimeError(
            "the local E5 model is missing model weights; expected model.safetensors or pytorch_model.bin"
        )
    return transformer


class E5Runtime:
    dimensions = 384

    def __init__(self, path: Path, *, threads: int = 2) -> None:
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("torch and transformers are required for embeddings") from exc
        transformer_path = validate_e5_artifacts(path)
        self._torch = torch
        torch.set_num_threads(threads)
        try:
            torch.set_num_interop_threads(max(1, min(threads, 2)))
        except RuntimeError:
            # PyTorch only permits this once per process; the model remains bounded.
            pass
        self._tokenizer = AutoTokenizer.from_pretrained(str(transformer_path), local_files_only=True)
        self._model = AutoModel.from_pretrained(str(transformer_path), local_files_only=True)
        self._model.eval()
        self._model.to("cpu")
        if int(getattr(self._model.config, "hidden_size", 0)) != self.dimensions:
            raise RuntimeError("the configured embedding model must produce 384 dimensions")

    def embed(self, texts: list[str], modes: list[str]) -> list[list[float]]:
        if len(texts) != len(modes):
            raise ValueError("texts and modes must have equal length")
        prefixed = [f"{mode}: {text}" for mode, text in zip(modes, texts)]
        with self._torch.inference_mode():
            encoded = self._tokenizer(prefixed, padding=True, truncation=True, max_length=512, return_tensors="pt")
            output = self._model(**encoded).last_hidden_state
            mask = encoded["attention_mask"].unsqueeze(-1).expand(output.size()).float()
            pooled = (output * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            pooled = self._torch.nn.functional.normalize(pooled, p=2, dim=1)
        vectors = pooled.cpu().tolist()
        if any(len(vector) != self.dimensions for vector in vectors):
            raise RuntimeError("embedding runtime returned the wrong dimension")
        return [[float(value) for value in vector] for vector in vectors]
