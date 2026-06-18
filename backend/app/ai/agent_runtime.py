from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import asdict
from typing import Any, Optional

logger = logging.getLogger(__name__)

from sqlmodel import Session, select

from ..models import AgentRun, AgentStep
from ..observability import sanitize_log_text
from .agent_schemas import AgentPlan, AgentRuntimeResult
from .agents import (
    CostOptimizerAgent,
    DocumentAgent,
    MemoryAgent,
    PlannerAgent,
    RetrievalAgent,
    TamilIntentAgent,
    ToolExecutionAgent,
    VerifierAgent,
)
from .tools import _pending_reminder_from_context
from .types import AIRequest


def agentic_mode_enabled() -> bool:
    return os.getenv("AGENTIC_MODE_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}

# ============================================================================
# Master Agent Runtime
# Central orchestrator coordinating Intent, Planning, Memory, Retrieval,
# Cost Optimization, Verification, Tool Execution and Provider Routing.
# ============================================================================
class AgentRuntime:
    def __init__(self) -> None:
        self.intent_agent = TamilIntentAgent()
        self.planner_agent = PlannerAgent()
        self.cost_optimizer_agent = CostOptimizerAgent()
        self.tool_execution_agent = ToolExecutionAgent()
        self.memory_agent = MemoryAgent()
        self.document_agent = DocumentAgent()
        self.retrieval_agent = RetrievalAgent()
        self.verifier_agent = VerifierAgent()

    def run(self, session: Session, request: AIRequest) -> AgentRuntimeResult:

        logger.info("Agent runtime started")
        
        started = time.perf_counter()
        run = self._create_run(session, request)
        pending = _pending_reminder_from_context(request)
        logger.info("Step 1 - Intent Agent")
        
        intent = self._step(
            session,
            run,
            "tamil_intent_agent",
            {"message": _safe_message_payload(request), "pending_reminder": bool(pending)},
            lambda: self.intent_agent.classify(request, pending_reminder=pending),
        )
        logger.info("Step 2 - Planner Agent")

        plan = self._step(
            session,
            run,
            "planner_agent",
        {
        "message": _safe_message_payload(request),
        "intent": asdict(intent),
        },
        lambda: self.planner_agent.plan(
            request,
            intent,
            pending_reminder=bool(pending),
        ),
        )

        logger.debug("Planner Result: %s", plan)

        logger.info("Step 3 - Memory Agent")

        memory_result = self.memory_agent.should_use_local_memory(
            session,
            plan,
        )

        logger.debug("Memory Result: %s", memory_result)

        logger.info("Step 4 - Retrieval Agent")

        retrieval_result = self.retrieval_agent.can_handle(
        plan,
        )

        logger.debug("Retrieval Result: %s", retrieval_result)
        
        
        logger.info("Step 5 - Cost Optimizer Agent")

        plan = self._step(
            session,
            run,
            "cost_optimizer_agent",
            {"plan": asdict(plan)},
            lambda: self.cost_optimizer_agent.optimize(plan),
        )
        logger.info("Step 6 - Verifier Agent")
        plan = self._step(
            session,
            run,
            "verifier_agent",
            {"plan": asdict(plan), "message": _safe_message_payload(request)},
            lambda: self.verifier_agent.verify(request, plan),
        )

        logger.info("Step 7 - Tool Execution Agent")
        response = None
        if plan.action != "provider_qa":
            response = self._step(
                session,
                run,
                "tool_execution_agent",
                {"plan": asdict(plan)}, 
                lambda: self.tool_execution_agent.execute(session, request, plan),
            )

        self._finalize_run(
            session,
            run,
            plan,
            provider_calls=1 if plan.action == "provider_qa" else 0,
            duration_ms=int(round((time.perf_counter() - started) * 1000)),
        )
        return AgentRuntimeResult(response=response, plan=plan, run_id=run.id)

    def _create_run(self, session: Session, request: AIRequest) -> AgentRun:
        def build_run(user_id: Optional[int]) -> AgentRun:
            return AgentRun(
                user_id=user_id,
                request_id=request.request_id,
                channel=request.channel or "text",
                message_hash=_message_hash(request.message),
                message_preview=sanitize_log_text(str(request.message or ""), 120),
                final_route="agent_started",
                final_intent="unknown",
                confidence=0.0,
                provider_calls=0,
                metadata_json=_json(
                    {
                        "reply_language": request.reply_language,
                        "context_turn_count": len(request.context_turns or []),
                    }
                ),
            )

        run = build_run(request.user_id)
        session.add(run)
        try:
            session.commit()
        except Exception:
            session.rollback()
            if request.user_id is None:
                raise
            run = build_run(None)
            session.add(run)
            session.commit()
        session.refresh(run)
        return run

    def _step(self, session: Session, run: AgentRun, name: str, input_payload: dict[str, Any], fn):
        started = time.perf_counter()
        output: Any = None
        try:
            output = fn()
            return output
        finally:
            duration_ms = int(round((time.perf_counter() - started) * 1000))
            confidence = float(getattr(output, "confidence", 0.0) or 0.0) if output is not None else 0.0
            session.add(
                AgentStep(
                    run_id=int(run.id or 0),
                    step_name=name,
                    input_json=_json(input_payload),
                    output_json=_json(_safe_output(output)),
                    confidence=confidence,
                    duration_ms=duration_ms,
                )
            )
            session.commit()

    @staticmethod
    def _finalize_run(session: Session, run: AgentRun, plan: AgentPlan, *, provider_calls: int, duration_ms: int) -> None:
        run.final_route = plan.route
        run.final_intent = plan.intent
        run.confidence = plan.confidence
        run.provider_calls = provider_calls
        run.estimated_cost_amount = 0.0
        run.estimated_cost_currency = "USD" if provider_calls else ""
        run.metadata_json = _json({**plan.metadata, "duration_ms": duration_ms, "agentic_mode_enabled": True})
        session.add(run)
        session.commit()


def fetch_agent_run_for_user(session: Session, run_id: int, user_id: int) -> Optional[dict[str, Any]]:
    run = session.get(AgentRun, int(run_id))
    if run is None or int(run.user_id or 0) != int(user_id):
        return None
    steps = list(session.exec(select(AgentStep).where(AgentStep.run_id == int(run.id)).order_by(AgentStep.id)).all())
    return {
        "id": run.id,
        "user_id": run.user_id,
        "request_id": run.request_id,
        "channel": run.channel,
        "message_hash": run.message_hash,
        "message_preview": run.message_preview,
        "final_route": run.final_route,
        "final_intent": run.final_intent,
        "confidence": run.confidence,
        "provider_calls": run.provider_calls,
        "estimated_cost_amount": run.estimated_cost_amount,
        "estimated_cost_currency": run.estimated_cost_currency,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "metadata": _loads(run.metadata_json),
        "steps": [
            {
                "id": step.id,
                "step_name": step.step_name,
                "input": _loads(step.input_json),
                "output": _loads(step.output_json),
                "confidence": step.confidence,
                "duration_ms": step.duration_ms,
                "created_at": step.created_at.isoformat() if step.created_at else None,
            }
            for step in steps
        ],
    }


def _message_hash(message: str) -> str:
    return hashlib.sha256(str(message or "").encode("utf-8")).hexdigest()


def _safe_message_payload(request: AIRequest) -> dict[str, Any]:
    return {
        "message_hash": _message_hash(request.message),
        "message_preview": sanitize_log_text(str(request.message or ""), 120),
        "channel": request.channel,
        "reply_language": request.reply_language,
    }


def _safe_output(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "__dataclass_fields__"):
        return asdict(value)
    if hasattr(value, "text") and hasattr(value, "route"):
        return {
            "provider": getattr(value, "provider", ""),
            "route": getattr(value, "route", ""),
            "intent": getattr(value, "intent", ""),
            "language": getattr(value, "language", ""),
            "text_preview": sanitize_log_text(str(getattr(value, "text", "") or ""), 160),
        }
    return value


def _json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return "{}"


def _loads(value: str) -> Any:
    try:
        return json.loads(value or "{}")
    except Exception:
        return {}
