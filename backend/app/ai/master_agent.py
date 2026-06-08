
from .intent import classify_intent


class MasterAgent:

    def detect_intent(self, query):
        decision = classify_intent(query)
        return decision.intent

    def select_provider(self, intent):

        sarvam_intents = [
            "translation",
            "note",
            "task",
            "document",
            "reminder"
        ]

        if intent in sarvam_intents:
            return "sarvam"

        return "openai"

    def select_agent(self, intent):

        mapping = {
            "note": "memory_agent",
            "task": "task_agent",
            "translation": "retrieval_agent",
            "coding": "coding_agent",
            "weather": "web_search_agent"
        }

        return mapping.get(intent, "general_agent")

    def process(self, user_query):

        intent = self.detect_intent(user_query)

        return {
            "intent": intent,
            "provider": self.select_provider(intent),
            "agent": self.select_agent(intent)
        }