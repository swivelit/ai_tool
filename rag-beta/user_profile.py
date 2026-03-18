import os
from typing import List, Dict
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import FAISS
from dotenv import load_dotenv

load_dotenv()

# # Hardcoded sample user profile representing the "user shadow"
# USER_PROFILE = [
#     "Allergy: Beetroot",
#     "Allergy: Peanuts",
#     "Activity level: Light movement (limited by injury)",
#     "Condition: Left hand injury, needs low-impact exercises",
#     "Diet preference: Vegetarian",
#     "Medical history: Hypertension (high blood pressure)",
#     "Personality: Reflective, prefers detailed explanations",
#     "Lifestyle: Early riser, works from home",
#     "Goal: Weight management and joint health",
#     "Food aversion: Spicy food",
#     "Condition: Mouth and tongue are injured; cannot chew or eat solid, crispy, or hard foods.",
#     "Sleep pattern: 7-8 hours, but light sleeper",
#     "Mobility: Restricted range of motion in left shoulder",
#     "Preference: Prefers home-cooked meals over outside food",
#     "Supplementation: Takes Vitamin D and Omega-3",
#     "Mental wellness: Practices mindfulness daily"
# ]

# The new USER_PROFILE is derived from these answers
USER_PROFILE = {
    "age_group": "18-25",
    "gender_context": "man",
    "life_stage": "none_of_these",
    "food_preference": "vegetarian",
    "health_conditions": ["blood_pressure_or_heart_care"],
    "food_caution": "avoid_spicy_or_oily_foods",
    "daily_activity": "moderate_walks",
    "sleep_pattern": "average",
    "personality_style": "practical",
    "stress_support": "step_by_step_plan",
    "communication_tone": "harsh",
    "answer_length": "simple",
    "hobbies": ["reading", "cooking"],
    "main_goal": "health",
    "family_role": "working_professional",
}


def get_vector_store():
    """Converts the profile into embeddings and stores them in a FAISS vector store."""
    embeddings = OpenAIEmbeddings()
    
    # Convert the dictionary into a list of descriptive strings for RAG
    profile_strings = []
    if isinstance(USER_PROFILE, dict):
        for key, value in USER_PROFILE.items():
            formatted_key = key.replace('_', ' ').title()
            profile_strings.append(f"{formatted_key}: {value}")
    else:
        profile_strings = USER_PROFILE

    vector_store = FAISS.from_texts(profile_strings, embeddings)
    return vector_store

if __name__ == "__main__":
    # Test vector store creation
    store = get_vector_store()
    print("Vector store created successfully.")
