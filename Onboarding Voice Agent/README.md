# Voice Onboarding Agent

A fully conversational, stateful onboarding agent built using LangGraph, LangChain, and FastAPI. It features a natural "Tanglish" AI agent that verbally communicates with users through a custom frontend UI, collecting profile data smoothly without feeling like a static questionnaire.

## Project Structure

```text
Voice Agent/
├── .env                    # Environment variables (OpenAI API keys, etc.)
├── api.py                  # FastAPI server providing the backend endpoints
├── main.py                 # Core LangGraph agent logic (state management, node definitions)
├── questions.json          # Formatted question bank used by the agent to guide conversations
├── requirements.txt        # Python backend dependencies
├── user_database.json      # JSON persistence file where completed user profiles are saved
└── frontend/               # User Interface
    └── index.html          # HTML, CSS, and JS for the dynamic, glassmorphic Voice UI
```

## Setup & Installation

### 1. Backend Setup

The backend leverages **Python 3.9+** and requires the necessary LangChain/FastAPI dependencies. We recommend using a virtual environment.

**For Mac/Linux:**
```bash
# 1. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure API Keys
# Make sure your `.env` file is present in the root directory and contains your `OPENAI_API_KEY`.
```

**For Windows:**
```cmd
# 1. Create and activate a virtual environment
python -m venv venv
venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure API Keys
# Make sure your `.env` file is present in the root directory and contains your `OPENAI_API_KEY`.
```

### 2. Running the Application

To run the full application, you need to start both the Python backend API and the local frontend server. We recommend running these in **two separate terminal windows**.

**Terminal 1: Start the Backend (API)**

**For Mac/Linux:**
```bash
# Ensure you are in the root directory and activate the virtual environment
source venv/bin/activate
python api.py
```

**For Windows:**
```cmd
# Ensure you are in the root directory and activate the virtual environment
venv\Scripts\activate
python api.py
```
> The FastAPI server will start running on `http://localhost:8000`

**Terminal 2: Start the Frontend (UI)**

**For Mac/Linux:**
```bash
# Navigate to the frontend folder
cd frontend

# Start a simple HTTP server to serve the UI
python3 -m http.server 3000
```

**For Windows:**
```cmd
# Navigate to the frontend folder
cd frontend

# Start a simple HTTP server to serve the UI
python -m http.server 3000
```
> The frontend will be accessible at `http://localhost:3000`. Open this in your browser to interact with the Voice Agent!

## How It Works

- The UI records your voice using the Web Speech API and sends the text transcript to the **`/api/chat`** endpoint.
- The `api.py` router pushes your message through the **LangGraph AI Agent** defined in `main.py`.
- The agent determines what question to ask next from `questions.json`, responds in natural Tanglish, and the backend converts the response to audio using `gTTS` (Text-To-Speech).
- Once the interview is complete, the user's data is parsed and appended securely into `user_database.json`.
