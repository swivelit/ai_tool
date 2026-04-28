from __future__ import annotations

import builtins
import importlib

import pytest


def _block_sentence_transformers(monkeypatch: pytest.MonkeyPatch) -> None:
    real_import = builtins.__import__

    def blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "sentence_transformers" or name.startswith("sentence_transformers."):
            raise ModuleNotFoundError("No module named 'sentence_transformers'")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", blocked_import)


def test_optional_embedding_modules_import_without_sentence_transformers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _block_sentence_transformers(monkeypatch)

    semantic_cache = importlib.reload(
        importlib.import_module("app.semantic_cache")
    )
    continuous_learning = importlib.reload(
        importlib.import_module("app.continuous_learning")
    )

    assert semantic_cache.DEPRECATED is True
    assert continuous_learning.EMBED_MODEL_NAME


def test_optional_embedding_paths_raise_clear_error_without_sentence_transformers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _block_sentence_transformers(monkeypatch)
    semantic_cache = importlib.reload(
        importlib.import_module("app.semantic_cache")
    )
    continuous_learning = importlib.reload(
        importlib.import_module("app.continuous_learning")
    )

    with pytest.raises(RuntimeError, match="sentence-transformers"):
        semantic_cache.get_embedding_model()

    with pytest.raises(RuntimeError, match="sentence-transformers"):
        continuous_learning.get_embed_model()
