import json
from collections import Counter

QUESTIONS = [
    {
        "id": 1,
        "question": "What is your age group?",
        "type": "meta",
        "options": [
            {"key": "A", "answer": "18-25", "trait": "young_adult"},
            {"key": "B", "answer": "26-35", "trait": "adult"},
            {"key": "C", "answer": "36-45", "trait": "mid_age"},
            {"key": "D", "answer": "46-60", "trait": "mature"},
            {"key": "E", "answer": "60+", "trait": "senior"}
        ]
    },
    {
        "id": 2,
        "question": "Which option best describes you?",
        "type": "meta",
        "options": [
            {"key": "A", "answer": "Male", "trait": "male"},
            {"key": "B", "answer": "Female", "trait": "female"},
            {"key": "C", "answer": "Non-binary", "trait": "non_binary"},
            {"key": "D", "answer": "Prefer not to say", "trait": "neutral"}
        ]
    },
    {
        "id": 3,
        "question": "How do you usually spend your free time?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Reading or watching movies alone", "trait": "introverted"},
            {"key": "B", "answer": "Meeting a few close friends", "trait": "social"},
            {"key": "C", "answer": "Going to parties or events", "trait": "extroverted"},
            {"key": "D", "answer": "Learning new skills or hobbies", "trait": "disciplined"}
        ]
    },
    {
        "id": 4,
        "question": "How do you plan your daily activities?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Plan everything in detail", "trait": "disciplined"},
            {"key": "B", "answer": "Plan only important tasks", "trait": "disciplined"},
            {"key": "C", "answer": "Go with the flow", "trait": "spontaneous"},
            {"key": "D", "answer": "Rarely plan anything", "trait": "spontaneous"}
        ]
    },
    {
        "id": 5,
        "question": "When making decisions, you usually:",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Choose safe options", "trait": "calm_under_stress"},
            {"key": "B", "answer": "Take calculated risks", "trait": "risk_taker"},
            {"key": "C", "answer": "Follow intuition", "trait": "spontaneous"},
            {"key": "D", "answer": "Ask others for advice", "trait": "social"}
        ]
    },
    {
        "id": 6,
        "question": "How do you react under pressure?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Stay calm and solve immediately", "trait": "calm_under_stress"},
            {"key": "B", "answer": "Talk to someone", "trait": "social"},
            {"key": "C", "answer": "Take time alone", "trait": "introverted"},
            {"key": "D", "answer": "Avoid or distract", "trait": "spontaneous"}
        ]
    },
    {
        "id": 7,
        "question": "What motivates you the most?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Achievement and success", "trait": "disciplined"},
            {"key": "B", "answer": "Helping others", "trait": "social"},
            {"key": "C", "answer": "Adventure and excitement", "trait": "risk_taker"},
            {"key": "D", "answer": "Comfort and stability", "trait": "introverted"}
        ]
    },
    {
        "id": 8,
        "question": "How active is your lifestyle?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Very active", "trait": "health_focused"},
            {"key": "B", "answer": "Moderately active", "trait": "active"},
            {"key": "C", "answer": "Occasionally active", "trait": "spontaneous"},
            {"key": "D", "answer": "Mostly inactive", "trait": "introverted"}
        ]
    },
    {
        "id": 9,
        "question": "How do you handle social situations?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Prefer small groups", "trait": "introverted"},
            {"key": "B", "answer": "Enjoy meaningful talks", "trait": "social"},
            {"key": "C", "answer": "Love large gatherings", "trait": "extroverted"},
            {"key": "D", "answer": "Avoid socializing", "trait": "introverted"}
        ]
    },
    {
        "id": 10,
        "question": "How would others describe you?",
        "type": "behavior",
        "options": [
            {"key": "A", "answer": "Calm and thoughtful", "trait": "introverted"},
            {"key": "B", "answer": "Friendly and outgoing", "trait": "extroverted"},
            {"key": "C", "answer": "Hardworking and disciplined", "trait": "disciplined"},
            {"key": "D", "answer": "Adventurous and spontaneous", "trait": "risk_taker"}
        ]
    }
]

TRAIT_EXPLANATIONS = {
    "introverted": "reflective, reserved, and comfortable with independent thinking",
    "extroverted": "outgoing, expressive, and energized by interaction",
    "disciplined": "organized, structured, and goal-oriented",
    "spontaneous": "flexible, intuitive, and adaptable",
    "risk_taker": "bold, exploratory, and comfortable with uncertainty",
    "social": "supportive, collaborative, and people-focused",
    "health_focused": "wellness-conscious and attentive to physical habits",
    "active": "energetic and action-oriented",
    "calm_under_stress": "steady, composed, and practical under pressure"
}

def ask_question(question_data):
    print(f"\nQ{question_data['id']}. {question_data['question']}")
    for option in question_data["options"]:
        print(f"  {option['key']}. {option['answer']}")
    while True:
        choice = input("Enter your choice: ").strip().upper()
        valid_keys = [opt["key"] for opt in question_data["options"]]
        if choice in valid_keys:
            selected = next(opt for opt in question_data["options"] if opt["key"] == choice)
            return {
                "question_id": question_data["id"],
                "question": question_data["question"],
                "selected_key": selected["key"],
                "selected_answer": selected["answer"],
                "trait": selected["trait"],
                "type": question_data["type"],
            }
        print("Invalid input. Please enter one of:", ", ".join(valid_keys))

def build_summary(meta_answers, behavior_scores):
    top_traits = [trait for trait, score in behavior_scores.most_common(3)]
    if not top_traits:
        return "No behavioral data available."

    trait_lines = [TRAIT_EXPLANATIONS.get(t, t) for t in top_traits]

    age = meta_answers.get("age_group", "Unknown")
    gender = meta_answers.get("gender", "Unknown")

    character_parts = []
    behavior_parts = []

    if "disciplined" in top_traits:
        character_parts.append("structured and dependable")
    if "social" in top_traits:
        character_parts.append("people-oriented and cooperative")
    if "introverted" in top_traits:
        character_parts.append("thoughtful and inward-focused")
    if "extroverted" in top_traits:
        character_parts.append("expressive and outgoing")
    if "risk_taker" in top_traits:
        character_parts.append("adventurous and willing to try new paths")
    if "calm_under_stress" in top_traits:
        character_parts.append("steady during pressure")
    if "spontaneous" in top_traits:
        behavior_parts.append("adapts quickly and prefers flexibility")
    if "health_focused" in top_traits:
        behavior_parts.append("shows awareness of healthy routines")
    if "active" in top_traits:
        behavior_parts.append("tends to be energetic in day-to-day life")
    if "social" in top_traits:
        behavior_parts.append("often engages well with others")
    if "introverted" in top_traits:
        behavior_parts.append("may prefer smaller groups or personal space")
    if "disciplined" in top_traits:
        behavior_parts.append("is likely to plan, organize, and follow through")

    character_text = ", ".join(dict.fromkeys(character_parts)) if character_parts else "balanced"
    behavior_text = "; ".join(dict.fromkeys(behavior_parts)) if behavior_parts else "shows mixed behavioral patterns"

    summary = (
        f"Age group: {age}\n"
        f"Gender: {gender}\n\n"
        f"Top traits: {', '.join(top_traits)}\n"
        f"Trait meaning: {', '.join(trait_lines)}.\n\n"
        f"Character summary:\n"
        f"This person appears {character_text}.\n\n"
        f"Behavior summary:\n"
        f"This person {behavior_text}."
    )
    return summary

def main():
    print("=" * 70)
    print("PERSONALITY CHARACTER & BEHAVIOR ASSESSMENT")
    print("=" * 70)
    print("Answer the following 10 questions by entering the option letter.\n")

    responses = []
    behavior_scores = Counter()
    meta_answers = {}

    for question in QUESTIONS:
        response = ask_question(question)
        responses.append(response)

        if question["id"] == 1:
            meta_answers["age_group"] = response["selected_answer"]
        elif question["id"] == 2:
            meta_answers["gender"] = response["selected_answer"]
        else:
            behavior_scores[response["trait"]] += 1

    summary = build_summary(meta_answers, behavior_scores)

    result = {
        "responses": responses,
        "behavior_trait_scores": dict(behavior_scores),
        "summary": summary
    }

    print("\n" + "=" * 70)
    print("ASSESSMENT RESULT")
    print("=" * 70)
    print(summary)

    with open("personality_assessment_result.json", "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("\nSaved result file: personality_assessment_result.json")

if __name__ == "__main__":
    main()
