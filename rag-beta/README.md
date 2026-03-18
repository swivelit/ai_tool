# RAG-Based Output Filtering System (Beta Skeleton)

This project is a prototype of an AI safety system that filters and remodels generated responses based on a specific "User Shadow" (profile).

## 🚀 The Concept: "The Chef & The Waiter"
To understand how this code works, imagine a restaurant:
1. **The Chef (OpenAI):** Generates a response (the food) based on a general request.
2. **The Waiter (The RAG Filter):** Knows the customer's allergies and preferences. He checks the food before serving it.
3. **The Remodel:** If the Chef made a steak but the customer is vegetarian, the Waiter goes back to the kitchen and has the Chef prepare a delicious vegetarian meal instead.

## 📂 Project Structure
- **`main.py`**: The entry point. It runs the demo scenarios (Diet Plan and Workout).
- **`rag_filter.py`**: The logic engine. It retrieves context, detects conflicts, and remodels responses.
- **`user_profile.py`**: The "User Shadow". It stores the 15 profile points and handles the Vector Database (FAISS).
- **`requirements.txt`**: List of Python libraries needed (LangChain, OpenAI, FAISS).
- **`.env`**: Stores your OpenAI API Key securely.

## 🧠 How the Logic Works
When you ask a question like "Give me a workout":
1. **OpenAI** generates a standard workout (e.g., Push-ups).
2. **FAISS** searches the profile and finds: "User has a left-hand injury."
3. **The Filter** sees the conflict: Push-ups are bad for a hand injury.
4. **OpenAI** is asked to rewrite the workout to be safe (e.g., Wall Push-ups).

---
*Created for the Beta Skeleton validation phase.*








------------------------------------------------------------------------------------


This is a part-by-part breakdown of how your RAG-based safety system works, following a single question from start to finish.

Part 1: Initializing the "User Shadow"
File: 

user_profile.py

What happens: Your profile (age, diet, health conditions) is converted into "embeddings" (numbers that the AI can search through).

Lines 30-46: This is your Profile Storage. It’s a dictionary containing your specific health and lifestyle constraints.
Lines 49-63 (

get_vector_store
): This function takes that dictionary, converts it into descriptive sentences (e.g., "Food Preference: Vegetarian"), and stores them in a FAISS Vector Database. This allows the system to find the right rules instantly when needed.
Part 2: Asking the Question
File: 

main.py

What happens: The user types a question, and the generic AI gives a first answer.

Line 24 (user_question = input(...)): Captures your live input.
Lines 9-14 (

generate_initial_response
): This function sends your question to OpenAI without tellining it about your profile yet. This allows it to generate a "naive" draft that might contain mistakes (like suggesting meat to a vegetarian).
Part 3: Searching the Profile (RAG Retrieval)
File: 

rag_filter.py

What happens: The system scans your profile to see if any rules apply to the AI's first answer.

Lines 11-13 (

retrieve_relevant_context
): This function takes the AI's first draft and searches the FAISS database. If the AI mentioned "dinner," the database will return your "Vegetarian" and "Heart Care" rules because they are related to food.
Part 4: The Conflict "Judge"
File: 

rag_filter.py

What happens: A second AI call acts as a safety inspector.

Lines 15-41 (

check_for_conflicts
):
It sends both the Draft Answer and the Retrieved Rules to OpenAI.
It uses a "Judge" prompt (Line 24) to ask: "Does this answer violate these rules?"
If it finds a mistake, it returns a message starting with CONFLICT: along with a reason why (e.g., "User is vegetarian but you suggested chicken").
Part 5: Fixing the Answer (Remodeling)
File: 

rag_filter.py

What happens: If the judge finds a conflict, the AI rewrites the answer.

Lines 43-61 (

remodel_response
): This is the final step. It sends a message to OpenAI saying: "Keep the original request in mind, but FIX the conflict I found."
Line 60: It generates a new, safe response that replaces the bad one.
Part 6: Sending the Safe Response
File: 

rag_filter.py
 What happens: The user gets the final, safe text.

Lines 74-88 (

process_output
): This is the high-level manager. It coordinates Steps 3, 4, and 5. If everything is safe, it returns the original answer. If not, it returns the newly remodeled "Safe" version.
📝 Summary Flow in 

main.py
:
Line 41:

python
final_response = filter_system.process_output(user_question, initial_response)
Input: Your question + AI's draft.
Output: A safe, remodeled answer that follows your health and diet rules.
