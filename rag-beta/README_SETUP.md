# Setup and Execution Guide

Follow these steps to install and run the RAG-beta prototype.

## 📋 Prerequisites
- **Python**: 3.10 or higher.
- **OpenAI API Key**: Required for embeddings and LLM calls.

## 🛠 Installation

1. **Navigate to the folder**:
   ```powershell
   cd rag-beta
   ```

2. **Create a Virtual Environment**:
   ```powershell
   python -m venv .venv
   ```

3. **Activate the Environment**:
   - **Windows (PowerShell)**: `.\.venv\Scripts\Activate.ps1`
   - **Mac/Linux**: `source .venv/bin/activate`

4. **Install Dependencies**:
   ```powershell
   pip install -r requirements.txt
   pip install langchain-community
   ```

## 🔑 Environment Setup
Create a file named `.env` in the `rag-beta` folder and add your key:
```env
OPENAI_API_KEY=your_key_here
```

## 🚀 Running the Demo
Execute the main script using the virtual environment's Python:
```powershell
.\.venv\Scripts\python.exe main.py
```

## 🧪 Testing New Scenarios
To test different behaviors, simply open `user_profile.py` and modify the `USER_PROFILE` list (e.g., change allergies or injuries). The system will automatically adjust its filtering logic.
