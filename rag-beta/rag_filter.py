from typing import List, Tuple
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage
from user_profile import get_vector_store

class RAGFilter:
    def __init__(self):
        self.vector_store = get_vector_store()
        self.llm = ChatOpenAI(model="gpt-4o", temperature=0)

    def retrieve_relevant_context(self, ai_response: str) -> List[str]:
        """Retrieves user profile context relevant to the AI's generated response."""
        docs = self.vector_store.similarity_search(ai_response, k=5)
        return [doc.page_content for doc in docs]

    def check_for_conflicts(self, ai_response: str, user_context: List[str]) -> Tuple[bool, str]:
        """
        Uses an LLM to check if the AI response conflicts with the retrieved user context.
        Returns (has_conflict, reasoning).
        """
        context_str = "\n".join(user_context)
        prompt = f"""
        User Profile Context:
        {context_str}

        AI Generated Response:
        "{ai_response}"

        Task: Check if the AI response conflicts with the User Profile Context (e.g., suggests an allergen, an exercise that might aggravate an injury, or violates a dietary restriction).
        
        If there is a conflict, reply with "CONFLICT: [reasoning]".
        If there is NO conflict, reply with "SAFE".
        """
        
        check_msg = self.llm.invoke([HumanMessage(content=prompt)])
        result = check_msg.content.strip()
        
        if result.startswith("CONFLICT"):
            return True, result.replace("CONFLICT:", "").strip()
        return False, ""

    def remodel_response(self, original_question: str, original_response: str, conflict_reasoning: str, user_context: List[str]) -> str:
        """Regenerates the response considering the specific constraints and conflicts."""
        context_str = "\n".join(user_context)
        prompt = f"""
        The user asked: "{original_question}"
        
        The initial AI response was: "{original_response}"
        
        However, a conflict was detected with the user's profile:
        {conflict_reasoning}
        
        Relevant User Constraints:
        {context_str}
        
        Task: Provide a new, safe, and helpful response to the user's original question that avoids the detected conflict and respects ALL user constraints.
        """
        
        remodel_msg = self.llm.invoke([HumanMessage(content=prompt)])
        return remodel_msg.content.strip()

    def process_output(self, original_question: str, ai_response: str) -> str:
        """High-level flow: Retrieve -> Check -> (Remodel if needed) -> Return."""
        print(f"\n--- Processing Output ---")
        print(f"Original Response: {ai_response[:100]}...")
        
        relevant_context = self.retrieve_relevant_context(ai_response)
        has_conflict, reasoning = self.check_for_conflicts(ai_response, relevant_context)
        
        if has_conflict:
            print(f"Conflict Detected: {reasoning}")
            print("Remodeling response...")
            return self.remodel_response(original_question, ai_response, reasoning, relevant_context)
        
        print("No conflicts detected. Response is safe.")
        return ai_response
