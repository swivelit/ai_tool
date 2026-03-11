from __future__ import annotations

import json
import math
import re
import unicodedata
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from config import (
    DATA_DIR,
    LOGS_DIR,
    MAX_HISTORY_DOCS,
    MAX_PROFILE_MEMORY_ROWS,
    MEDICAL_SAFETY_NOTE,
    PREGNANCY_CUSTOM_AVOID_LIST,
    PROFILE_VERSION,
    PROFILES_DIR,
    QUESTION_COUNT,
)


QUESTIONS: List[Dict[str, Any]] = [
    {
        "id": "age_group",
        "prompt": "What is your age group?",
        "type": "single",
        "options": ["18-25", "26-35", "36-45", "46-60", "60+"],
    },
    {
        "id": "gender_context",
        "prompt": "Which option fits you best?",
        "type": "single",
        "options": ["woman", "man", "non-binary", "prefer_not_to_say", "other"],
    },
    {
        "id": "life_stage",
        "prompt": "Which life-stage or health context fits you right now?",
        "type": "single",
        "options": [
            "pregnant",
            "postpartum_or_breastfeeding",
            "trying_to_conceive",
            "none_of_these",
            "prefer_not_to_say",
        ],
    },
    {
        "id": "food_preference",
        "prompt": "What best describes your food preference?",
        "type": "single",
        "options": ["vegetarian", "non_vegetarian", "eggetarian", "vegan", "mixed_flexible"],
    },
    {
        "id": "health_conditions",
        "prompt": "Pick up to 3 health conditions or sensitivities that matter most.",
        "type": "multi",
        "max_choices": 3,
        "options": [
            "none",
            "diabetes_or_sugar_control",
            "blood_pressure_or_heart_care",
            "thyroid_or_hormonal_care",
            "allergy_digestion_kidney_or_other",
        ],
    },
    {
        "id": "food_caution",
        "prompt": "Which food caution best matches you?",
        "type": "single",
        "options": [
            "no_special_caution",
            "avoid_sugary_foods",
            "avoid_spicy_or_oily_foods",
            "avoid_packaged_or_junk_foods",
            "allergy_or_doctor_given_restrictions",
        ],
    },
    {
        "id": "daily_activity",
        "prompt": "How active are you on most days?",
        "type": "single",
        "options": ["mostly_sitting", "light_movement", "moderate_walks", "active_work", "fitness_focused"],
    },
    {
        "id": "sleep_pattern",
        "prompt": "How is your sleep usually?",
        "type": "single",
        "options": ["poor", "inconsistent", "average", "good", "very_good"],
    },
    {
        "id": "personality_style",
        "prompt": "Which personality style sounds most like you?",
        "type": "single",
        "options": ["calm", "friendly", "practical", "ambitious", "emotional_sensitive"],
    },
    {
        "id": "stress_support",
        "prompt": "When stressed, what kind of support helps you most?",
        "type": "single",
        "options": ["gentle_reassurance", "direct_solution", "step_by_step_plan", "motivation", "space_and_time"],
    },
    {
        "id": "communication_tone",
        "prompt": "How should the assistant talk to you?",
        "type": "single",
        "options": ["warm", "respectful", "short_direct", "detailed", "friendly_casual"],
    },
    {
        "id": "answer_length",
        "prompt": "How long should answers usually be?",
        "type": "single",
        "options": ["very_short", "short", "medium", "detailed", "depends_on_question"],
    },
    {
        "id": "hobbies",
        "prompt": "Pick up to 3 things you enjoy most.",
        "type": "multi",
        "max_choices": 3,
        "options": ["music", "movies", "reading", "cooking", "travel"],
    },
    {
        "id": "main_goal",
        "prompt": "What matters most to you right now?",
        "type": "single",
        "options": ["health", "family", "career_or_business", "peace_of_mind", "learning_and_growth"],
    },
    {
        "id": "family_role",
        "prompt": "Which role sounds closest to your current daily life?",
        "type": "single",
        "options": ["student", "working_professional", "homemaker", "caregiver_parent", "self_employed"],
    },
]


class LocalHybridRAG:
    """Small dependency-free hybrid retriever for profile grounding and memory."""

    def __init__(self, documents: List[Dict[str, Any]]) -> None:
        self.documents = documents or []
        self.stopwords = {
            "a", "an", "the", "and", "or", "but", "if", "to", "for", "of", "in", "on",
            "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
            "this", "that", "these", "those", "it", "its", "into", "about", "your", "you",
            "user", "question", "answer", "profile", "assistant", "most", "best", "how", "what",
            "which", "when", "do", "does", "can", "should", "would", "could", "right", "now",
        }
        self.synonyms = {
            "pregnancy": ["pregnant", "conceive", "postpartum", "breastfeeding"],
            "sugar": ["diabetes", "sweet", "glucose", "dessert"],
            "blood": ["pressure", "heart", "salt"],
            "stress": ["anxiety", "reassurance", "support"],
            "health": ["wellness", "medical", "safe", "safety", "condition"],
            "food": ["diet", "meal", "eat", "caution", "preference"],
            "tone": ["style", "communication", "talk"],
            "work": ["career", "business", "professional", "job"],
            "family": ["parent", "caregiver", "home", "homemaker"],
            "greeting": ["hi", "hello", "vanakkam", "hey"],
        }
        self.doc_tokens: List[List[str]] = []
        self.doc_vectors: List[Dict[str, float]] = []
        self.idf: Dict[str, float] = {}
        self._fit()

    @staticmethod
    def _normalize(text: Any) -> str:
        text = "" if text is None else str(text)
        text = unicodedata.normalize("NFKC", text).lower().strip()
        text = text.replace("_", " ").replace("-", " ")
        text = re.sub(r"[^\w\s\u0B80-\u0BFF]", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _tokenize(self, text: Any) -> List[str]:
        return [t for t in self._normalize(text).split() if t and t not in self.stopwords]

    def _expand_tokens(self, tokens: List[str]) -> List[str]:
        expanded = list(tokens)
        token_set = set(tokens)

        for token in list(token_set):
            if token in self.synonyms:
                expanded.extend(self.synonyms[token])

        for root, values in self.synonyms.items():
            if token_set.intersection(values):
                expanded.append(root)
                expanded.extend(values)

        return expanded

    def _fit(self) -> None:
        if not self.documents:
            return

        df_counts: Counter = Counter()
        tokenized_docs: List[List[str]] = []

        for doc in self.documents:
            tokens = self._tokenize(doc.get("text", ""))
            tokenized_docs.append(tokens)
            self.doc_tokens.append(tokens)
            for token in set(tokens):
                df_counts[token] += 1

        total_docs = max(len(tokenized_docs), 1)
        self.idf = {token: math.log((1 + total_docs) / (1 + count)) + 1.0 for token, count in df_counts.items()}
        self.doc_vectors = [self._tfidf_vector(tokens) for tokens in tokenized_docs]

    def _tfidf_vector(self, tokens: List[str]) -> Dict[str, float]:
        if not tokens:
            return {}
        counts = Counter(tokens)
        total = sum(counts.values()) or 1
        vector = {token: (count / total) * self.idf.get(token, 1.0) for token, count in counts.items()}
        norm = math.sqrt(sum(value * value for value in vector.values())) or 1.0
        return {token: value / norm for token, value in vector.items()}

    @staticmethod
    def _cosine_sparse(v1: Dict[str, float], v2: Dict[str, float]) -> float:
        if not v1 or not v2:
            return 0.0
        if len(v1) > len(v2):
            v1, v2 = v2, v1
        return sum(value * v2.get(token, 0.0) for token, value in v1.items())

    @staticmethod
    def _jaccard(tokens1: List[str], tokens2: List[str]) -> float:
        s1, s2 = set(tokens1), set(tokens2)
        if not s1 or not s2:
            return 0.0
        return len(s1 & s2) / max(len(s1 | s2), 1)

    def retrieve(
        self,
        query: str,
        *,
        top_k: int = 6,
        min_score: float = 0.03,
        mmr_lambda: float = 0.78,
    ) -> List[Dict[str, Any]]:
        if not self.documents:
            return []

        query_tokens = self._expand_tokens(self._tokenize(query))
        query_vec = self._tfidf_vector(query_tokens)

        scored: List[Tuple[int, float]] = []
        for idx, doc in enumerate(self.documents):
            semantic = self._cosine_sparse(query_vec, self.doc_vectors[idx])
            lexical = self._jaccard(query_tokens, self.doc_tokens[idx])
            meta = doc.get("metadata", {})
            kind = str(meta.get("kind", ""))
            freshness_boost = 0.0
            if kind in {"history", "rule", "profile", "personality_example"}:
                freshness_boost += 0.03
            if kind == "profile_summary":
                freshness_boost += 0.05
            score = (0.68 * semantic) + (0.24 * lexical) + freshness_boost
            if score >= min_score:
                scored.append((idx, score))

        if not scored:
            return []

        scored.sort(key=lambda item: item[1], reverse=True)
        candidates = [idx for idx, _ in scored[: max(top_k * 3, top_k)]]
        selected_indices: List[int] = []
        results: List[Dict[str, Any]] = []

        while candidates and len(selected_indices) < top_k:
            best_idx = None
            best_mmr = -1e9
            for idx in list(candidates):
                relevance = next(score for cand_idx, score in scored if cand_idx == idx)
                diversity_penalty = 0.0
                if selected_indices:
                    diversity_penalty = max(
                        self._cosine_sparse(self.doc_vectors[idx], self.doc_vectors[chosen])
                        for chosen in selected_indices
                    )
                mmr_score = (mmr_lambda * relevance) - ((1 - mmr_lambda) * diversity_penalty)
                if mmr_score > best_mmr:
                    best_mmr = mmr_score
                    best_idx = idx

            if best_idx is None:
                break

            candidates.remove(best_idx)
            selected_indices.append(best_idx)
            original_score = next(score for cand_idx, score in scored if cand_idx == best_idx)
            result = dict(self.documents[best_idx])
            result["retrieval_score"] = round(float(original_score), 4)
            results.append(result)

        return results


class BehaviourQuestionnaire:
    def __init__(self, profiles_dir: Path = PROFILES_DIR) -> None:
        self.profiles_dir = profiles_dir
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        self.personality_dataset_path = DATA_DIR / "personality_15_question_dataset.json"
        self.rag = LocalHybridRAG(self._build_knowledge_documents())

    @staticmethod
    def _sanitize_user_id(user_id: str) -> str:
        safe = "".join(ch for ch in str(user_id).strip() if ch.isalnum() or ch in ("_", "-"))
        return safe or "default_user"

    def _profile_path(self, user_id: str) -> Path:
        return self.profiles_dir / f"{self._sanitize_user_id(user_id)}.json"

    def _history_log_path(self, user_id: str) -> Path:
        return LOGS_DIR / f"{self._sanitize_user_id(user_id)}_history.jsonl"

    def profile_exists(self, user_id: str) -> bool:
        return self._profile_path(user_id).exists()

    def load_profile(self, user_id: str) -> Dict[str, Any]:
        path = self._profile_path(user_id)
        if not path.exists():
            raise FileNotFoundError(f"Profile not found for user_id={user_id}")
        profile = json.loads(path.read_text(encoding="utf-8"))
        return self._upgrade_profile(profile)

    def save_profile(self, user_id: str, profile: Dict[str, Any]) -> None:
        upgraded = self._upgrade_profile(profile)
        path = self._profile_path(user_id)
        path.write_text(json.dumps(upgraded, indent=2, ensure_ascii=False), encoding="utf-8")

    def ensure_profile(self, user_id: str) -> Dict[str, Any]:
        if self.profile_exists(user_id):
            return self.load_profile(user_id)
        return self.run_first_time_questionnaire(user_id)

    def _upgrade_profile(self, profile: Dict[str, Any]) -> Dict[str, Any]:
        answers = profile.get("answers", {}) or {}
        behaviour_rules = profile.get("behaviour_rules", {}) or {}
        personality_rag = profile.get("rag_personality_hints", {}) or {}

        if not behaviour_rules:
            behaviour_rules = self._derive_behaviour_rules(answers)
        if not personality_rag:
            personality_rag = self._infer_personality_rag_from_answers(answers)

        profile.setdefault("user_id", "default_user")
        profile.setdefault("created_at", datetime.utcnow().isoformat() + "Z")
        profile["profile_version"] = PROFILE_VERSION
        profile["answers"] = answers
        profile["behaviour_rules"] = behaviour_rules
        profile["rag_personality_hints"] = personality_rag
        profile["profile_summary"] = self._build_profile_summary(answers, behaviour_rules, personality_rag)
        profile["profile_card"] = self._build_profile_card(answers, behaviour_rules, personality_rag)
        return profile

    def run_first_time_questionnaire(self, user_id: str) -> Dict[str, Any]:
        print("\nFirst-time profile setup started.")
        print(f"Please answer these {QUESTION_COUNT} questions so responses can be personalized safely.\n")

        answers: Dict[str, Any] = {}
        for index, question in enumerate(QUESTIONS, start=1):
            print(f"Q{index}. {question['prompt']}")
            for option_index, option in enumerate(question["options"], start=1):
                print(f"  {option_index}. {option}")
            if question["type"] == "single":
                answers[question["id"]] = self._ask_single_choice(question)
            else:
                answers[question["id"]] = self._ask_multi_choice(question)
            print()

        behaviour_rules = self._derive_behaviour_rules(answers)
        personality_rag = self._infer_personality_rag_from_answers(answers)

        profile = {
            "profile_version": PROFILE_VERSION,
            "user_id": self._sanitize_user_id(user_id),
            "created_at": datetime.utcnow().isoformat() + "Z",
            "answers": answers,
            "behaviour_rules": behaviour_rules,
            "rag_personality_hints": personality_rag,
        }
        profile = self._upgrade_profile(profile)
        self.save_profile(user_id, profile)
        print("Profile created successfully.\n")
        return profile

    def _ask_single_choice(self, question: Dict[str, Any]) -> str:
        max_index = len(question["options"])
        while True:
            raw = input("Select one option number: ").strip()
            if raw.isdigit() and 1 <= int(raw) <= max_index:
                return question["options"][int(raw) - 1]
            print("Invalid choice. Please enter a valid option number.")

    def _ask_multi_choice(self, question: Dict[str, Any]) -> List[str]:
        max_index = len(question["options"])
        max_choices = int(question.get("max_choices", 3))

        while True:
            raw = input(f"Select up to {max_choices} option numbers separated by comma: ").strip()
            parts = [part.strip() for part in raw.split(",") if part.strip()]
            if not parts:
                print("Please select at least one option.")
                continue
            if not all(part.isdigit() for part in parts):
                print("Only numbers separated by commas are allowed.")
                continue

            indexes = [int(part) for part in parts]
            if any(index < 1 or index > max_index for index in indexes):
                print("One or more options are out of range.")
                continue

            unique_indexes = sorted(set(indexes))
            if len(unique_indexes) > max_choices:
                print(f"Please choose only up to {max_choices} options.")
                continue

            selected = [question["options"][index - 1] for index in unique_indexes]
            if "none" in selected and len(selected) > 1:
                print("If you choose 'none', do not combine it with other options.")
                continue
            return selected

    def _derive_behaviour_rules(self, answers: Dict[str, Any]) -> Dict[str, Any]:
        health_conditions = answers.get("health_conditions", []) or []
        life_stage = str(answers.get("life_stage", ""))
        food_caution = str(answers.get("food_caution", ""))
        sleep_pattern = str(answers.get("sleep_pattern", ""))
        daily_activity = str(answers.get("daily_activity", ""))

        is_pregnant = life_stage == "pregnant"
        postpartum_related = life_stage == "postpartum_or_breastfeeding"
        trying_to_conceive = life_stage == "trying_to_conceive"
        has_diabetes = "diabetes_or_sugar_control" in health_conditions
        has_bp = "blood_pressure_or_heart_care" in health_conditions
        has_thyroid = "thyroid_or_hormonal_care" in health_conditions
        has_other_sensitive = "allergy_digestion_kidney_or_other" in health_conditions

        avoid_items: List[str] = []
        avoid_topics: List[str] = []
        mandatory_notes: List[str] = [MEDICAL_SAFETY_NOTE]
        response_style_bias: List[str] = []

        if is_pregnant:
            avoid_items.extend(PREGNANCY_CUSTOM_AVOID_LIST)
            mandatory_notes.append(
                "If the user is pregnant, avoid risky food, medicine, herbal, or crash-diet suggestions. Do not recommend pineapple."
            )
        if postpartum_related:
            mandatory_notes.append(
                "If the user is postpartum or breastfeeding, keep dietary and medicine advice extra cautious and avoid strong unsupported claims."
            )
        if trying_to_conceive:
            mandatory_notes.append(
                "If the user is trying to conceive, avoid risky fertility claims or food certainty."
            )

        if has_diabetes or food_caution == "avoid_sugary_foods":
            avoid_items.extend(["high sugar drinks", "excess sweets", "dessert-heavy suggestions"])
            avoid_topics.append("sugar spikes")
            mandatory_notes.append("For sugar-control users, avoid advice that increases sugar load.")
        if has_bp:
            avoid_items.extend(["high salt foods", "energy drinks", "stimulant-heavy suggestions"])
            avoid_topics.append("high stimulant recommendations")
            mandatory_notes.append("For blood pressure or heart-care users, avoid high-salt and stimulant-heavy advice.")
        if has_thyroid:
            avoid_topics.append("diagnosis-like certainty")
            mandatory_notes.append("For thyroid or hormonal-care users, avoid confident medical certainty and diagnosis-like phrasing.")
        if has_other_sensitive or food_caution == "allergy_or_doctor_given_restrictions":
            avoid_topics.append("confident ingredient safety claims")
            mandatory_notes.append(
                "For allergy, digestion, kidney, or doctor-restricted users, avoid ingredient-specific certainty unless the user confirms safety."
            )
        if food_caution == "avoid_spicy_or_oily_foods":
            avoid_items.extend(["very spicy foods", "deep fried foods", "heavy oily meals"])
        if food_caution == "avoid_packaged_or_junk_foods":
            avoid_items.extend(["ultra-processed snacks", "junk food", "packaged sweet drinks"])

        tone_map = {
            "warm": "warm, caring, and clear",
            "respectful": "respectful and polished",
            "short_direct": "brief and direct",
            "detailed": "detailed and structured",
            "friendly_casual": "friendly and conversational",
        }
        answer_length_map = {
            "very_short": "2-3 lines",
            "short": "1 short paragraph",
            "medium": "1-2 balanced paragraphs",
            "detailed": "2-4 detailed paragraphs or bullet points",
            "depends_on_question": "adapt length to question complexity",
        }

        personality_style = str(answers.get("personality_style", ""))
        stress_support = str(answers.get("stress_support", ""))
        main_goal = str(answers.get("main_goal", ""))
        family_role = str(answers.get("family_role", ""))

        personality_bias_map = {
            "calm": "Keep wording calm and steady.",
            "friendly": "Use encouraging and socially warm language.",
            "practical": "Prefer concrete, actionable steps over abstract advice.",
            "ambitious": "Frame suggestions in goal-oriented language.",
            "emotional_sensitive": "Use gentle, emotionally careful wording.",
        }
        stress_bias_map = {
            "gentle_reassurance": "Start with reassurance before giving advice.",
            "direct_solution": "Give the answer quickly, then the supporting detail.",
            "step_by_step_plan": "Prefer numbered or stepwise explanations.",
            "motivation": "Use a supportive tone without exaggeration.",
            "space_and_time": "Avoid sounding pushy unless safety requires it.",
        }
        goal_bias_map = {
            "health": "Prioritize health-conscious framing.",
            "family": "Acknowledge family practicality when relevant.",
            "career_or_business": "Prefer efficient and outcome-focused framing.",
            "peace_of_mind": "Reduce unnecessary alarm in phrasing.",
            "learning_and_growth": "Include short explanatory context when helpful.",
        }
        role_bias_map = {
            "student": "Use simple and approachable language.",
            "working_professional": "Keep answers time-efficient and practical.",
            "homemaker": "Allow home and routine-oriented framing when relevant.",
            "caregiver_parent": "Be mindful of time, stress, and caregiving load.",
            "self_employed": "Keep recommendations flexible and outcome-focused.",
        }

        for mapping, key in [
            (personality_bias_map, personality_style),
            (stress_bias_map, stress_support),
            (goal_bias_map, main_goal),
            (role_bias_map, family_role),
        ]:
            if key in mapping:
                response_style_bias.append(mapping[key])

        if sleep_pattern in {"poor", "inconsistent"}:
            response_style_bias.append("Keep suggestions realistic for someone with low or inconsistent energy.")
        if daily_activity in {"active_work", "fitness_focused"}:
            response_style_bias.append("Use energetic but practical wording when discussing routines or food.")
        elif daily_activity == "mostly_sitting":
            response_style_bias.append("Prefer sustainable, low-friction suggestions.")

        return {
            "preferred_tone": tone_map.get(answers.get("communication_tone", "warm"), "warm and clear"),
            "preferred_answer_length": answer_length_map.get(answers.get("answer_length", "medium"), "1-2 balanced paragraphs"),
            "primary_goal": answers.get("main_goal", ""),
            "avoid_items": sorted(set(avoid_items)),
            "avoid_topics": sorted(set(avoid_topics)),
            "mandatory_notes": list(dict.fromkeys(mandatory_notes)),
            "response_style_bias": list(dict.fromkeys(response_style_bias)),
            "health_flags": {
                "pregnant": is_pregnant,
                "postpartum_or_breastfeeding": postpartum_related,
                "trying_to_conceive": trying_to_conceive,
                "diabetes_or_sugar_control": has_diabetes,
                "blood_pressure_or_heart_care": has_bp,
                "thyroid_or_hormonal_care": has_thyroid,
                "allergy_digestion_kidney_or_other": has_other_sensitive,
            },
        }

    def _build_profile_card(
        self,
        answers: Dict[str, Any],
        behaviour_rules: Dict[str, Any],
        personality_rag: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return {
            "tone": behaviour_rules.get("preferred_tone", "warm and clear"),
            "answer_length": behaviour_rules.get("preferred_answer_length", "1-2 balanced paragraphs"),
            "life_stage": answers.get("life_stage", ""),
            "food_preference": answers.get("food_preference", ""),
            "health_conditions": answers.get("health_conditions", []) or [],
            "main_goal": answers.get("main_goal", ""),
            "style_bias": behaviour_rules.get("response_style_bias", []) or [],
            "avoid_items": behaviour_rules.get("avoid_items", []) or [],
            "personality_traits": (personality_rag or {}).get("top_traits", []),
        }

    def _build_profile_summary(
        self,
        answers: Dict[str, Any],
        behaviour_rules: Dict[str, Any],
        personality_rag: Optional[Dict[str, Any]] = None,
    ) -> str:
        hobbies = ", ".join(answers.get("hobbies", [])) or "no hobby preference recorded"
        health_conditions = ", ".join(answers.get("health_conditions", [])) or "none"
        avoid_items = ", ".join(behaviour_rules.get("avoid_items", [])) or "none"
        traits = ", ".join((personality_rag or {}).get("top_traits", [])) or "balanced"
        personality_sentence = (personality_rag or {}).get("personality_summary", "")

        return (
            f"User age group: {answers.get('age_group', '')}. "
            f"Gender context: {answers.get('gender_context', '')}. "
            f"Life stage: {answers.get('life_stage', '')}. "
            f"Food style: {answers.get('food_preference', '')}. "
            f"Health context: {health_conditions}. "
            f"Food caution: {answers.get('food_caution', '')}. "
            f"Daily activity: {answers.get('daily_activity', '')}. Sleep pattern: {answers.get('sleep_pattern', '')}. "
            f"Personality style: {answers.get('personality_style', '')}. Stress support preference: {answers.get('stress_support', '')}. "
            f"Preferred assistant tone: {behaviour_rules.get('preferred_tone', '')}. Preferred answer length: {behaviour_rules.get('preferred_answer_length', '')}. "
            f"Hobbies: {hobbies}. Main goal: {answers.get('main_goal', '')}. Family role: {answers.get('family_role', '')}. "
            f"Avoid recommending: {avoid_items}. Top personality traits: {traits}. {personality_sentence}".strip()
        )

    def _build_knowledge_documents(self) -> List[Dict[str, Any]]:
        docs: List[Dict[str, Any]] = []

        for question in QUESTIONS:
            docs.append(
                {
                    "doc_id": f"question::{question['id']}",
                    "text": (
                        f"Question id {question['id']}. Prompt: {question['prompt']}. "
                        f"Type: {question['type']}. Options: {', '.join(question.get('options', []))}."
                    ),
                    "metadata": {"kind": "question", "question_id": question["id"]},
                }
            )

        docs.extend(
            [
                {
                    "doc_id": "rule::pregnancy",
                    "text": (
                        "If the user is pregnant, trying to conceive, postpartum, or breastfeeding, use medically cautious guidance. "
                        "Avoid risky food or medicine suggestions, alcohol, smoking, and crash dieting."
                    ),
                    "metadata": {"kind": "rule", "topic": "pregnancy"},
                },
                {
                    "doc_id": "rule::conditions",
                    "text": (
                        "For diabetes or sugar control, avoid high sugar suggestions. For blood pressure or heart care, avoid high salt or stimulant-heavy advice. "
                        "For allergy, digestion, kidney, or doctor restrictions, avoid ingredient certainty."
                    ),
                    "metadata": {"kind": "rule", "topic": "health_conditions"},
                },
                {
                    "doc_id": "rule::tone_and_length",
                    "text": (
                        "Assistant tone should match user preference: warm, respectful, short direct, detailed, or friendly casual. "
                        "Answer length can be very short, short, medium, detailed, or adaptive depending on complexity."
                    ),
                    "metadata": {"kind": "rule", "topic": "style"},
                },
            ]
        )

        if self.personality_dataset_path.exists():
            try:
                personality_data = json.loads(self.personality_dataset_path.read_text(encoding="utf-8"))
                for item in personality_data.get("questions", []):
                    qid = item.get("id")
                    qtext = item.get("question", "")
                    for index, option in enumerate(item.get("options", []), start=1):
                        docs.append(
                            {
                                "doc_id": f"personality::{qid}::{index}",
                                "text": (
                                    f"Personality benchmark question: {qtext}. "
                                    f"Possible answer: {option.get('answer', '')}. Trait: {option.get('trait', 'unknown')}."
                                ),
                                "metadata": {
                                    "kind": "personality_example",
                                    "trait": option.get("trait", "unknown"),
                                    "source_question_id": qid,
                                },
                            }
                        )

                sample_output = personality_data.get("sample_output", {})
                if sample_output:
                    docs.append(
                        {
                            "doc_id": "personality::sample_output",
                            "text": (
                                f"Sample personality summary: {sample_output.get('personality_summary', '')}. "
                                f"Trait scores example: {json.dumps(sample_output.get('trait_scores', {}), ensure_ascii=False)}."
                            ),
                            "metadata": {"kind": "personality_summary", "topic": "sample_output"},
                        }
                    )
            except Exception:
                pass

        return docs

    def _infer_personality_rag_from_answers(self, answers: Dict[str, Any]) -> Dict[str, Any]:
        trait_scores: Counter = Counter()

        hobby_map = {
            "reading": "introverted",
            "movies": "calm_under_stress",
            "music": "social",
            "cooking": "disciplined",
            "travel": "risk_taker",
        }
        tone_map = {
            "warm": "social",
            "respectful": "disciplined",
            "short_direct": "disciplined",
            "detailed": "health_focused",
            "friendly_casual": "extroverted",
        }
        personality_map = {
            "calm": "calm_under_stress",
            "friendly": "social",
            "practical": "disciplined",
            "ambitious": "active",
            "emotional_sensitive": "introverted",
        }
        activity_map = {
            "mostly_sitting": "introverted",
            "light_movement": "health_focused",
            "moderate_walks": "health_focused",
            "active_work": "active",
            "fitness_focused": "active",
        }

        for hobby in answers.get("hobbies", []) or []:
            mapped = hobby_map.get(hobby)
            if mapped:
                trait_scores[mapped] += 1

        for field_name, mapping in [
            ("communication_tone", tone_map),
            ("personality_style", personality_map),
            ("daily_activity", activity_map),
        ]:
            value = answers.get(field_name)
            mapped = mapping.get(value)
            if mapped:
                trait_scores[mapped] += 2

        if answers.get("main_goal") == "health":
            trait_scores["health_focused"] += 2
        if answers.get("stress_support") == "step_by_step_plan":
            trait_scores["disciplined"] += 2
        if answers.get("stress_support") == "space_and_time":
            trait_scores["introverted"] += 1
        if answers.get("stress_support") == "motivation":
            trait_scores["extroverted"] += 1

        top_traits = [trait for trait, _ in trait_scores.most_common(3)]
        retrieval_query = " ".join(
            [
                str(answers.get("personality_style", "")),
                str(answers.get("communication_tone", "")),
                str(answers.get("stress_support", "")),
                str(answers.get("daily_activity", "")),
                str(answers.get("main_goal", "")),
                " ".join(answers.get("hobbies", []) or []),
                " ".join(top_traits),
            ]
        ).strip()

        retrieved = self.rag.retrieve(retrieval_query, top_k=4, min_score=0.02)
        retrieved_traits = [item.get("metadata", {}).get("trait") for item in retrieved if item.get("metadata", {}).get("trait")]
        merged_traits = list(dict.fromkeys(top_traits + retrieved_traits))[:4]
        personality_summary = (
            "Based on the questionnaire and retrieved personality examples, the user appears relatively "
            f"{', '.join(merged_traits)}."
            if merged_traits
            else ""
        )

        return {
            "top_traits": merged_traits,
            "retrieved_examples": [
                {
                    "doc_id": item.get("doc_id", ""),
                    "text": item.get("text", ""),
                    "score": item.get("retrieval_score", 0.0),
                }
                for item in retrieved
            ],
            "personality_summary": personality_summary,
        }

    def _load_history_documents(self, user_id: str, user_query: Optional[str] = None) -> List[Dict[str, Any]]:
        log_path = self._history_log_path(user_id)
        if not log_path.exists():
            return []

        try:
            lines = log_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []

        documents: List[Dict[str, Any]] = []
        for idx, line in enumerate(lines[-MAX_PROFILE_MEMORY_ROWS:]):
            try:
                item = json.loads(line)
            except Exception:
                continue

            query = str(item.get("query", "")).strip()
            result = item.get("result", {}) or {}
            answer = str(result.get("remodeled_english", "")).strip() or str(result.get("raw_english", "")).strip()
            if not query and not answer:
                continue

            documents.append(
                {
                    "doc_id": f"history::{idx}",
                    "text": f"Past user query: {query}. Past assistant answer: {answer}.",
                    "metadata": {"kind": "history", "timestamp": item.get("timestamp", "")},
                }
            )

        if not documents:
            return []

        if user_query:
            temp_rag = LocalHybridRAG(documents)
            return temp_rag.retrieve(user_query, top_k=MAX_HISTORY_DOCS, min_score=0.05)

        return documents[-MAX_HISTORY_DOCS:]

    def _profile_to_query(self, profile: Dict[str, Any], user_query: Optional[str] = None) -> str:
        answers = profile.get("answers", {}) or {}
        rules = profile.get("behaviour_rules", {}) or {}
        rag_hints = profile.get("rag_personality_hints", {}) or {}

        return " ".join(
            [
                str(user_query or ""),
                str(answers.get("life_stage", "")),
                str(answers.get("food_preference", "")),
                " ".join(answers.get("health_conditions", []) or []),
                str(answers.get("food_caution", "")),
                str(answers.get("communication_tone", "")),
                str(answers.get("answer_length", "")),
                str(answers.get("personality_style", "")),
                str(answers.get("stress_support", "")),
                str(answers.get("main_goal", "")),
                str(answers.get("family_role", "")),
                " ".join(answers.get("hobbies", []) or []),
                " ".join(rules.get("avoid_items", []) or []),
                " ".join(rules.get("avoid_topics", []) or []),
                " ".join(rag_hints.get("top_traits", []) or []),
            ]
        ).strip()

    def build_runtime_context(self, profile: Dict[str, Any], user_query: Optional[str] = None) -> str:
        profile = self._upgrade_profile(profile)
        rules = profile.get("behaviour_rules", {}) or {}
        answers = profile.get("answers", {}) or {}
        user_id = profile.get("user_id", "default_user")

        retrieval_query = self._profile_to_query(profile, user_query=user_query)
        retrieved = self.rag.retrieve(retrieval_query, top_k=6, min_score=0.02)
        history_docs = self._load_history_documents(user_id, user_query=user_query)

        personalization_context = [
            f"- [{item.get('metadata', {}).get('kind', 'unknown')}] {item.get('text', '')} (score={item.get('retrieval_score', 0.0)})"
            for item in retrieved
        ]
        memory_context = [
            f"- {item.get('text', '')} (score={item.get('retrieval_score', 0.0)})"
            for item in history_docs
        ]

        profile_card = profile.get("profile_card", {}) or {}
        rag_hints = profile.get("rag_personality_hints", {}) or {}

        mandatory_notes = rules.get("mandatory_notes", [])
        mandatory_notes_block = "\n- ".join(mandatory_notes) if mandatory_notes else "No special notes"

        return f"""
Stored user profile summary:
{profile.get('profile_summary', '')}

Compact profile card:
- Tone: {profile_card.get('tone', 'warm and clear')}
- Answer length: {profile_card.get('answer_length', '1-2 balanced paragraphs')}
- Life stage: {profile_card.get('life_stage', answers.get('life_stage', ''))}
- Food preference: {profile_card.get('food_preference', answers.get('food_preference', ''))}
- Health conditions: {', '.join(profile_card.get('health_conditions', [])) or 'none'}
- Main goal: {profile_card.get('main_goal', answers.get('main_goal', ''))}
- Style bias: {', '.join(profile_card.get('style_bias', [])) or 'none'}
- Avoid items: {', '.join(profile_card.get('avoid_items', [])) or 'none'}
- Personality traits: {', '.join(profile_card.get('personality_traits', [])) or 'none'}

Behavior rules:
- Preferred tone: {rules.get('preferred_tone', 'warm and clear')}
- Preferred answer length: {rules.get('preferred_answer_length', '1-2 balanced paragraphs')}
- Avoid items: {', '.join(rules.get('avoid_items', [])) or 'none'}
- Avoid topics: {', '.join(rules.get('avoid_topics', [])) or 'none'}
- Mandatory notes:
- {mandatory_notes_block}

Retrieved personality hints:
- Top traits: {', '.join(rag_hints.get('top_traits', [])) or 'none'}
- Summary: {rag_hints.get('personality_summary', 'No additional personality summary available.')}

Relevant personalization context:
{chr(10).join(personalization_context) if personalization_context else '- No retrieved personalization context'}

Relevant past conversation memory:
{chr(10).join(memory_context) if memory_context else '- No matching history memory'}

Important behavior instruction:
- Personalize the answer using the stored profile and relevant memory, but do not expose profile internals.
- Keep the answer aligned with safety notes, avoid items, and avoid topics.
- If the topic is health-sensitive, avoid overclaiming and keep the answer cautious.
""".strip()