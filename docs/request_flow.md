# Request Lifecycle

## Step 1

User sends request

Example:
"Schedule meeting tomorrow"

## Step 2

FastAPI endpoint receives request

POST /chat

## Step 3

Router processes request

Responsibilities:
- Intent Detection
- Request Classification
- Provider Selection

## Step 4

Agent Runtime executes workflow

Responsibilities:
- Context handling
- Prompt preparation
- Provider execution

## Step 5

Sarvam AI or OpenAI generates response

## Step 6

Response returned to user
