import os
import json
from openai import OpenAI
from app.orchestrator_task import run_orchestrator

# ── 1. SETUP ENVIRONMENT ─────────────────────────────────────────────────────
# (Key has been removed as requested)
key = os.environ.get("OPENAI_API_KEY")

if not key:
    print("\n⚠️  WARNING: No 'OPENAI_API_KEY' found. Running in [LOCAL FAST-PATH MODE].")
    print("Only Greetings, Tools (Weather/Calendar), and Emergencies will work.")
    print("Complex questions will be skipped.\n")
    client = None
else:
    # Initialize the OpenAI Client normally if a key exists
    client = OpenAI(api_key=key)

def test_loop():
    print("\n" + "="*60)
    print("🚦 SEMANTIC ORCHESTRATOR - INTERACTIVE TEST CONSOLE")
    print("="*60)
    print("Type your message to see how the 'Traffic Cop' routes it.")
    print("Type 'exit' or 'quit' to stop.\n")

    while True:
        user_input = input("👤 YOU: ").strip()
        
        if user_input.lower() in ("exit", "quit", "q"):
            print("\nGoodbye! 👋")
            break
        
        if not user_input:
            continue

        print("\n🔍 Analyzing...")
        
        try:
            # 👮‍♂️ Run the Orchestrator
            result = run_orchestrator(client, user_input)
            
            # 📊 Show results in a beautiful way
            print("\n" + "─"*20 + " [ TRAFFIC COP LOG ] " + "─"*20)
            print(f"🚦 INTENT:      {result.get('intent')}")
            print(f"📍 NEXT ACTION: {result.get('next_action')}")
            print(f"🛠️  TOOL:        {result.get('tool')}")
            
            path_type = "⚡ FAST-PATH (Rules/Regex)" if result.get("fast_path") else "🧠 LLM (AI Analysis)"
            print(f"🛣️  ROUTE TYPE:  {path_type}")
            print("-" * 60)

            # 🤖 SIMULATED AGENT RESPONSE
            # (In the real app, these would be separate files like agentic_service.py)
            print("\n🤖 FINAL AI RESPONSE:")
            
            intent = result.get("intent")
            tool = result.get("tool")

            if intent == "EMERGENCY":
                print("🚨 [Emergency Agent]: I have detected an emergency. PLEASE STAY SAFE. I am notifying emergency services immediately (112). Stay where you are.")
            
            elif intent == "GREETING":
                print(f"👋 [Greeting Agent]: Hi there! I'm your personal AI assistant. How can I help you today?")
            
            elif intent == "AMBIGUOUS":
                print(f"❓ [Clarification Agent]: {result.get('clarification_question') or 'Could you tell me more about that?'}")
            
            elif tool == "weather":
                print(f"🌦️ [Weather Agent]: Identifying location... Triggering Weather API... Success! The current temperature in your area is 30°C and sunny.")
            
            elif tool == "calendar":
                print(f"📅 [Calendar Agent]: Checking your database... Done. You have 3 meetings and 1 reminder for today.")
            
            elif tool == "web_search":
                print(f"🌐 [Web Search Agent]: Searching the internet for '{user_input}'... Compiling latest news... Found 5 relevant articles for you.")
            
            else:
                print(f"💬 [General Agent]: This is a statement or question. I'll process this using my general knowledge to give you a helpful answer.")
            
            print("\n" + "="*60 + "\n")

        except Exception as e:
            print(f"❌ ERROR: {e}\n")

if __name__ == "__main__":
    test_loop()
