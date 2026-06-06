# Agent Analysis Report

## Agents Analyzed

### PlannerAgent
File: backend/app/ai/agents/planner_agent.py

Responsibilities:
- Route requests
- Build execution plans
- Decide next action

Inputs:
- User request
- Intent
- Session context

Outputs:
- AgentPlan

---

### MemoryAgent
File: backend/app/ai/agents/memory_agent.py

Responsibilities:
- Memory routing
- Profile retrieval
- Memory decisions

Outputs:
- Memory results / boolean decisions

---

### RetrievalAgent
File: backend/app/ai/agents/retrieval_agent.py

Responsibilities:
- Document retrieval
- File retrieval
- Date resolution

---

### ToolExecutionAgent
File: backend/app/ai/agents/tool_execution_agent.py

Responsibilities:
- Execute backend tools
- Handle reminders
- Handle tasks
- Handle settings

---

## Findings
PlannerAgent acts as the orchestration layer while ToolExecutionAgent performs execution.
