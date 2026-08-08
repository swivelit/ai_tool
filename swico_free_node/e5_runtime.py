from __future__ import annotations

from pathlib import Path


def resolve_e5_transformer_path(path: Path) -> Path:
    """Resolve a plain Transformers or SentenceTransformers local layout."""
    if (path / "modules.json").is_file():
        transformer = path / "0_Transformer"
        if not transformer.is_dir():
            raise RuntimeError(
                "SWICO_FREE_E5_MODEL_PATH is a SentenceTransformers directory but 0_Transformer is missing"
            )
        return transformer
    return path


def validate_e5_artifacts(path: Path) -> Path:
    if not path.is_dir():
        raise RuntimeError("SWICO_FREE_E5_MODEL_PATH must point to a local model directory")
    transformer = resolve_e5_transformer_path(path)
    if not (transformer / "config.json").is_file():
        raise RuntimeError("the local E5 model is missing config.json")
    tokenizer_files = ("tokenizer.json", "tokenizer.model", "spiece.model", "vocab.txt")
    if not any((transformer / name).is_file() for name in tokenizer_files):
        raise RuntimeError(
            "the local E5 model is missing tokenizer files; export tokenizer.json, tokenizer.model, spiece.model, or vocab.txt"
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
