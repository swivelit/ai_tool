from __future__ import annotations

from pathlib import Path


class E5Runtime:
    dimensions = 384

    def __init__(self, path: Path) -> None:
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer
        except ImportError as exc:
            raise RuntimeError("torch and transformers are required for embeddings") from exc
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
        self._model = AutoModel.from_pretrained(str(path), local_files_only=True)
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
