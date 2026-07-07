
import logging

from .intent import classify_intent

from .agents.planner_agent import PlannerAgent
from .agents.memory_agent import MemoryAgent
from .agents.retrieval_agent import RetrievalAgent
from .agents.tool_execution_agent import ToolExecutionAgent
from .agents.cost_optimizer_agent import CostOptimizerAgent
from .context_compressor import ContextCompressor


logger = logging.getLogger(__name__)


class MasterAgent:

    def __init__(self):
        self.planner = PlannerAgent()
        self.memory = MemoryAgent()
        self.retrieval = RetrievalAgent()
        self.tool_executor = ToolExecutionAgent()
        self.cost_optimizer = CostOptimizerAgent()
        self.compressor = ContextCompressor()

    def process(self, message: str):

        # Step 1: Intent Detection
        intent_result = classify_intent(message)

        intent = intent_result.intent
        logger.debug(
            "master_agent_intent_detected",
            extra={
                "intent": intent,
                "route": getattr(intent_result, "route", None),
                "intent_result_type": type(intent_result).__name__,
            },
        )

        # Step 2: Provider Selection
        provider = self.select_provider(intent) 
        optimized_provider = provider
        

        # Step 3: Planner Execution
        plan = None

        # Step 4: Memory Check
        memory_result = None

        try:
            if hasattr(self.memory, "search"):
                memory_result = self.memory.search(message)
                logger.debug(
                    "master_agent_memory_lookup_completed",
                    extra={"has_memory_result": memory_result is not None},
                )
        except Exception:
            logger.exception("master_agent_memory_lookup_failed")

        # Step 5: Retrieval Check
        retrieval_result = None

        try:
            if hasattr(self.retrieval, "search"):
                retrieval_result = self.retrieval.search(message)

            if retrieval_result:
                retrieval_result = self.compressor.compress(
                    retrieval_result
                )    
                logger.debug("master_agent_retrieval_lookup_completed")
    
        except Exception:
            logger.exception("master_agent_retrieval_lookup_failed")

        # Step 6: Tool Execution
        tool_result = None

        return {
            "intent": intent,
            "provider": optimized_provider,
            "agent": self.select_agent(intent),
            "plan": plan,
            "memory_result": memory_result,
            "retrieval_result": retrieval_result,
            "tool_result": tool_result
}

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
            "task": "planner",
            "note": "memory",
            "document": "retrieval",
            "reminder": "tool_execution"
        }

        return mapping.get(intent, "general")
