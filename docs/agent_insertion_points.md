# AI Agent Insertion Points

## Current Flow

User
↓
Router
↓
Agent Runtime
↓
OpenAI / Sarvam
↓
Response

## Proposed Flow

User
↓
Router
↓
Orchestrator Agent
↓
Memory Agent
↓
Retrieval Agent
↓
Tool Agent
↓
Verifier Agent
↓
OpenAI / Sarvam
↓
Response

## Recommended Insertion Point

File:
backend/app/ai/agent_runtime.py

Reason:
This file controls the AI execution flow and is the best location to introduce an orchestrator-based architecture.

## Future Agent Responsibilities

### Orchestrator Agent
- Task planning
- Agent selection
- Workflow control

### Memory Agent
- Context storage
- Conversation summarization

### Retrieval Agent
- Knowledge retrieval
- Document search

### Tool Agent
- Calendar
- Reminder
- Weather
- Task execution

### Verifier Agent
- Response validation
- Hallucination reduction
