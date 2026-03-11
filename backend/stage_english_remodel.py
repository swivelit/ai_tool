from __future__ import annotations

import csv
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from config import (
    DATA_DIR,
    DIRECT_MATCH_FORCE_THRESHOLD,
    DIRECT_MATCH_ROUTE_THRESHOLD,
    DIRECT_MATCH_SEMANTIC_THRESHOLD,
    DIRECT_MATCH_STRONG_THRESHOLD,
    DIRECT_MATCH_WEAK_THRESHOLD,
    HEALTH_RISK_KEYWORDS,
    MEDICAL_SAFETY_NOTE,
    REMODEL_MIN_OUTPUT_CHARS,
    REMODEL_MIN_SIMILARITY_TO_RAW,
    REMODEL_TEMPERATURE,
)


WORD_RE = re.compile(r"[a-zA-Z0-9_\u0B80-\u0BFF]+")


def _normalize_text(text: str) -> str:
    return " ".join(str(text or "").strip().lower().split())


def _tokenize(text: str) -> List[str]:
    return WORD_RE.findall(_normalize_text(text))


def _jaccard_similarity(text1: str, text2: str) -> float:
    s1, s2 = set(_tokenize(text1)), set(_tokenize(text2))
    if not s1 and not s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    return len(s1 & s2) / len(s1 | s2)


def _sequence_similarity(text1: str, text2: str) -> float:
    a = _normalize_text(text1)
    b = _normalize_text(text2)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    common = sum((Counter(a.split()) & Counter(b.split())).values())
    return (2.0 * common) / max(1, len(a.split()) + len(b.split()))


def _coerce_csv_rows(path: Path) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            text = str(row.get("text", "")).strip()
            label = str(row.get("label", "")).strip() or "unknown"
            answer = str(row.get("answer", "")).strip()
            if text and answer:
                rows.append({"text": text, "label": label, "answer": answer})
    return rows


@dataclass
class DirectAnswerMatch:
    query: str
    answer: str
    label: str
    confidence: float
    match_type: str


@dataclass
class RoutingDecision:
    route: str
    route_reason: str
    predicted_label: str
    direct_answer_source: str = ""
    direct_answer_confidence: float = 0.0
    risk_level: str = "low"


class EmbeddedTextClassifier:
    def __init__(self, dataset_path: Optional[Path] = None) -> None:
        self.dataset_path = dataset_path or (DATA_DIR / "classifier_dataset.csv")
        self.rows = self._load_dataset()
        self.label_centroids: Dict[str, Counter[str]] = self._train()

    def _resolve_dataset_path(self) -> Path:
        return self.dataset_path

    def preprocess(self, text: str) -> str:
        return _normalize_text(text)

    def _load_dataset(self) -> List[Dict[str, str]]:
        return _coerce_csv_rows(self._resolve_dataset_path())

    def _train(self) -> Dict[str, Counter[str]]:
        bucket: Dict[str, Counter[str]] = defaultdict(Counter)
        for row in self.rows:
            bucket[row["label"]].update(_tokenize(row["text"]))
        return dict(bucket)

    def predict(self, text: str) -> str:
        probs = self.predict_proba_map(text)
        return max(probs.items(), key=lambda item: item[1])[0] if probs else "unknown"

    def predict_proba_map(self, text: str) -> Dict[str, float]:
        query_counter = Counter(_tokenize(text))
        if not query_counter or not self.label_centroids:
            return {"unknown": 1.0}
        scores: Dict[str, float] = {}
        for label, centroid in self.label_centroids.items():
            scores[label] = self._cosine_dense(query_counter, centroid)
        total = sum(max(score, 0.0) for score in scores.values()) or 1.0
        return {label: round(max(score, 0.0) / total, 6) for label, score in scores.items()}

    @staticmethod
    def _cosine_dense(v1: Counter[str], v2: Counter[str]) -> float:
        common = set(v1) & set(v2)
        dot = sum(v1[k] * v2[k] for k in common)
        norm1 = math.sqrt(sum(v * v for v in v1.values()))
        norm2 = math.sqrt(sum(v * v for v in v2.values()))
        if norm1 == 0 or norm2 == 0:
            return 0.0
        return dot / (norm1 * norm2)

    def _fuzzy_match(self, user_query: str) -> Optional[DirectAnswerMatch]:
        query = _normalize_text(user_query)
        best: Optional[DirectAnswerMatch] = None
        for row in self.rows:
            score = max(_jaccard_similarity(query, row["text"]), _sequence_similarity(query, row["text"]))
            if best is None or score > best.confidence:
                best = DirectAnswerMatch(row["text"], row["answer"], row["label"], round(score, 4), "fuzzy")
        return best

    def _semantic_match(self, user_query: str) -> Optional[DirectAnswerMatch]:
        query_tokens = Counter(_tokenize(user_query))
        best: Optional[DirectAnswerMatch] = None
        for row in self.rows:
            score = self._cosine_dense(query_tokens, Counter(_tokenize(row["text"])))
            if best is None or score > best.confidence:
                best = DirectAnswerMatch(row["text"], row["answer"], row["label"], round(score, 4), "semantic")
        return best

    def get_direct_answer_match(self, text: str) -> Optional[DirectAnswerMatch]:
        fuzzy = self._fuzzy_match(text)
        semantic = self._semantic_match(text)
        candidates = [m for m in (fuzzy, semantic) if m is not None]
        if not candidates:
            return None
        best = max(candidates, key=lambda item: item.confidence)
        threshold = DIRECT_MATCH_WEAK_THRESHOLD if best.match_type == "fuzzy" else DIRECT_MATCH_SEMANTIC_THRESHOLD
        return best if best.confidence >= threshold else None


class AdvancedLocalRAG:
    def __init__(self, documents: Iterable[Dict[str, Any]]) -> None:
        self.documents = list(documents)

    def _jaccard(self, text1: str, text2: str) -> float:
        return _jaccard_similarity(text1, text2)

    def _cosine_dense(self, v1: Counter[str], v2: Counter[str]) -> float:
        return EmbeddedTextClassifier._cosine_dense(v1, v2)

    def retrieve(self, query: str, top_k: int = 3, min_score: float = 0.15) -> List[Dict[str, Any]]:
        query_counter = Counter(_tokenize(query))
        scored: List[Tuple[float, Dict[str, Any]]] = []
        for doc in self.documents:
            text = str(doc.get("text", ""))
            score = max(self._jaccard(query, text), self._cosine_dense(query_counter, Counter(_tokenize(text))))
            if score >= min_score:
                scored.append((round(score, 4), doc))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [{**doc, "score": score} for score, doc in scored[:top_k]]


class EnglishRemodeler:
    def __init__(self, core: Any, dataset_path: Optional[Path] = None) -> None:
        self.core = core
        self.classifier = EmbeddedTextClassifier(dataset_path)
        self.rag = AdvancedLocalRAG(self._build_rag_documents())

    def _build_rag_documents(self) -> List[Dict[str, Any]]:
        docs: List[Dict[str, Any]] = []
        for row in self.classifier.rows:
            docs.append({"text": row["text"], "answer": row["answer"], "label": row["label"]})
        return docs

    def get_direct_answer_match(self, user_query: str) -> Optional[DirectAnswerMatch]:
        return self.classifier.get_direct_answer_match(user_query)

    @staticmethod
    def _safe_join(items: Iterable[str], default: str = "") -> str:
        values = [str(item).strip() for item in items if str(item).strip()]
        return ", ".join(values) if values else default

    def _is_health_sensitive(self, text: str, profile: Dict[str, Any]) -> bool:
        haystack = f"{text} {json_safe(profile)}".lower()
        return any(keyword in haystack for keyword in HEALTH_RISK_KEYWORDS)

    @staticmethod
    def _post_process_answer(text: str) -> str:
        text = re.sub(r"\n{3,}", "\n\n", str(text or "").strip())
        text = re.sub(r"[ \t]{2,}", " ", text)
        return text.strip()

    def _estimate_answer_quality(self, answer: str) -> float:
        answer = str(answer or "").strip()
        if not answer:
            return 0.0
        score = 0.0
        if len(answer) >= REMODEL_MIN_OUTPUT_CHARS:
            score += 0.35
        if any(punct in answer for punct in ".!?"):
            score += 0.15
        if len(answer.split()) >= 8:
            score += 0.2
        if len(set(_tokenize(answer))) >= 6:
            score += 0.15
        if len(answer) <= 650:
            score += 0.15
        return round(min(score, 1.0), 4)

    def decide_route(self, user_query: str, raw_answer: str, profile: Dict[str, Any]) -> RoutingDecision:
        match = self.get_direct_answer_match(user_query)
        predicted_label = self.classifier.predict(user_query)
        risk_level = "high" if self._is_health_sensitive(user_query, profile) else ("medium" if predicted_label == "High" else "low")

        if match and match.confidence >= DIRECT_MATCH_FORCE_THRESHOLD:
            return RoutingDecision(
                route="dataset_direct_answer",
                route_reason="High-confidence dataset match; skip rewrite for determinism.",
                predicted_label=match.label,
                direct_answer_source=f"{match.match_type}:{match.query}",
                direct_answer_confidence=match.confidence,
                risk_level=risk_level,
            )

        quality = self._estimate_answer_quality(raw_answer)
        if match and match.confidence >= DIRECT_MATCH_ROUTE_THRESHOLD:
            return RoutingDecision(
                route="hybrid_rewrite",
                route_reason="Strong dataset match available; use it as supporting context during rewrite.",
                predicted_label=match.label,
                direct_answer_source=f"{match.match_type}:{match.query}",
                direct_answer_confidence=match.confidence,
                risk_level=risk_level,
            )

        if quality < 0.45:
            return RoutingDecision(
                route="full_rewrite",
                route_reason="Raw answer quality is weak; generate a stronger profile-aware response.",
                predicted_label=predicted_label,
                risk_level=risk_level,
            )

        return RoutingDecision(
            route="light_rewrite",
            route_reason="Raw answer is usable; polish tone, clarity, and personalization.",
            predicted_label=predicted_label,
            risk_level=risk_level,
        )

    def _guard_answer(self, raw_answer: str, remodeled_answer: str, routing: RoutingDecision) -> str:
        remodeled_answer = self._post_process_answer(remodeled_answer)
        if not remodeled_answer:
            return raw_answer
        similarity = max(_jaccard_similarity(raw_answer, remodeled_answer), _sequence_similarity(raw_answer, remodeled_answer))
        if raw_answer.strip() and similarity < REMODEL_MIN_SIMILARITY_TO_RAW and routing.route == "light_rewrite":
            return raw_answer.strip()
        if routing.risk_level == "high" and MEDICAL_SAFETY_NOTE.lower() not in remodeled_answer.lower():
            return f"{remodeled_answer}\n\n{MEDICAL_SAFETY_NOTE}".strip()
        return remodeled_answer

    def remodel_with_meta(self, user_query: str, raw_answer: str, profile: Dict[str, Any]) -> Dict[str, Any]:
        routing = self.decide_route(user_query, raw_answer, profile)
        match = self.get_direct_answer_match(user_query)
        retrieved = self.rag.retrieve(user_query, top_k=3, min_score=0.18)

        if routing.route == "dataset_direct_answer" and match:
            final_answer = match.answer
        else:
            profile_summary = str(profile.get("profile_summary", "")).strip()
            profile_card = json_safe(profile.get("profile_card", {}))
            behaviour_rules = self._safe_join(profile.get("behaviour_rules", []), default="No explicit rules")
            rag_context = "\n".join(
                f"- label={doc.get('label','')} score={doc.get('score','')} q={doc.get('text','')} a={doc.get('answer','')}"
                for doc in retrieved
            ) or "- No local examples retrieved"
            direct_hint = match.answer if match and routing.direct_answer_confidence >= DIRECT_MATCH_STRONG_THRESHOLD else ""
            system_prompt = (
                "You are an English response remodeler. Improve clarity, relevance, tone, and personalization "
                "without inventing facts. Keep the answer natural and easy to translate into Tamil."
            )
            user_prompt = f"""
User question:
{user_query}

Current raw answer:
{raw_answer}

Profile summary:
{profile_summary}

Profile card:
{profile_card}

Behaviour rules:
{behaviour_rules}

Closest local examples:
{rag_context}

Direct answer hint:
{direct_hint}

Rewrite mode:
{routing.route}

Task:
1. Improve the answer for clarity and personalization.
2. Keep meaning faithful to the question and raw answer.
3. Use a practical, human tone.
4. Avoid overlong explanations.
5. If medically sensitive, stay cautious.
6. Output only the improved English answer.
""".strip()
            generated = self.core.generate_text(system_prompt, user_prompt, temperature=REMODEL_TEMPERATURE, max_output_tokens=900)
            final_answer = self._guard_answer(raw_answer, generated, routing)

        return {
            "answer": final_answer,
            "route": routing.route,
            "route_reason": routing.route_reason,
            "predicted_label": routing.predicted_label,
            "direct_answer_source": routing.direct_answer_source,
            "direct_answer_confidence": routing.direct_answer_confidence,
            "risk_level": routing.risk_level,
            "quality_score": self._estimate_answer_quality(final_answer),
            "local_rag_hits": retrieved,
        }

    def remodel(self, user_query: str, raw_answer: str, profile: Dict[str, Any]) -> str:
        return str(self.remodel_with_meta(user_query, raw_answer, profile).get("answer", raw_answer)).strip() or raw_answer


def json_safe(value: Any) -> str:
    try:
        import json

        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)