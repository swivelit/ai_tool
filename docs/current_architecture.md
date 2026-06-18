# Current Swico V1 Architecture

## High Level Flow

User
↓
FastAPI Endpoint
↓
Router
↓
Agent Runtime
↓
Sarvam AI / OpenAI
↓
Response

## Components

### Router
- Receives request
- Detects intent
- Routes request

### Agent Runtime
- Executes AI workflow
- Calls AI providers

### AI Providers
- Sarvam AI
- OpenAI

## Current Challenges

- High token consumption
- Limited memory
- No centralized orchestration
- Limited retrieval optimization
