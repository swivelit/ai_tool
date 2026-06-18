
print("Test Started")

from backend.app.ai.master_agent import MasterAgent

print("Import Success")

master = MasterAgent()

print("Master Agent Created")

queries = [
    "save this note",
    "translate hello to tamil",
    "what is python",
    "weather in chennai"
]

for q in queries:
    print(f"\nQUERY: {q}")
    print(master.process(q))