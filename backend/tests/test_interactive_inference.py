
import os
import sys

# Ensure backend directory (parent of tests) is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Disable logging spam during interactive demo
import logging
logging.basicConfig(level=logging.WARNING)
logging.getLogger("app.ai").setLevel(logging.WARNING)

# ANSI color codes
RESET = "\033[0m"
BOLD = "\033[1m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"

try:
    from app.ai.master_agent import MasterAgent
    from app.ai.agents.tamil_intent_agent import TamilIntentAgent
    from app.ai.agents.planner_agent import PlannerAgent
    from app.ai.types import AIRequest
except ImportError as e:
    print(f"{RED}Import Error:{RESET} {e}")
    print("Please make sure you run this script inside the active virtualenv:")
    print("  source backend/.venv/bin/activate")
    sys.exit(1)

def print_header():
    print("\n" + "=" * 80)
    print(f"{BOLD}{CYAN}SWICO MASTER AGENT - INTERACTIVE INFERENCE DEMO{RESET}")
    print("Type any query to calculate dynamic token & cost savings.")
    print("Type 'exit' or 'quit' to close the demo.")
    print("=" * 80)

def main():
    master = MasterAgent()
    intent_agent = TamilIntentAgent()
    planner = PlannerAgent()
    
    print_header()
    
    while True:
        try:
            query = input(f"\n{BOLD}{MAGENTA}swico-agent> {RESET}").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting demo.")
            break
            
        if not query:
            continue
            
        if query.lower() in ("exit", "quit"):
            print("Exiting demo.")
            break
            
        # 1. Run local intent detection & planning
        try:
            req = AIRequest(
                user_id=1,
                message=query,
                reply_language="en",
                channel="text",
                request_id="demo-query",
                metadata={},
                context_turns=[]
            )
            intent_res = intent_agent.classify(req)
            plan = planner.plan(req, intent_res)
            
            # 3. Search Memory & Retrieval
            memory_res = master.memory.search(query)
            retrieval_res = master.retrieval.search(query)
            if retrieval_res:
                retrieval_res = master.compressor.compress(retrieval_res)
                
        except Exception as e:
            print(f"{RED}Error processing query: {e}{RESET}")
            continue
            
        # 4. Calculate Token Details
        # --- BEFORE ARCHITECTURE ---
        before_calls = 5
        before_tokens = 2500  # Average fixed across 5 independent calls
        before_cost = before_tokens * 0.000005  # avg $5.00/1M tokens
        
        # --- AFTER ARCHITECTURE ---
        is_local = (plan.action != "provider_qa")
        
        if is_local:
            after_calls = 0
            after_tokens = 0
            after_cost = 0.0
            orchestration_desc = f"Handled fully LOCALLY via {plan.route} (Python runtime)."
        else:
            after_calls = 1
            # Dynamic calculation
            system_tokens = 280
            user_tokens = max(10, len(query) // 4)  # ~4 chars per token
            
            retrieval_tokens = 0
            if retrieval_res:
                retrieval_tokens = sum(len(doc) // 4 for doc in retrieval_res)
                
            memory_tokens = 15 if memory_res else 0
            
            # Estimate output based on intent
            if plan.intent == "coding":
                output_tokens = 400
                model_used = "gpt-5-mini ($0.25/1M in, $2.00/1M out)"
                input_tokens = system_tokens + user_tokens + retrieval_tokens + memory_tokens
                after_cost = (input_tokens * 0.00000025) + (output_tokens * 0.000002)
            else:
                output_tokens = 200
                model_used = "gpt-5-nano ($0.05/1M in, $0.40/1M out)"
                input_tokens = system_tokens + user_tokens + retrieval_tokens + memory_tokens
                after_cost = (input_tokens * 0.00000005) + (output_tokens * 0.0000004)
                
            after_tokens = input_tokens + output_tokens
            orchestration_desc = f"Routed to provider QA ({model_used})."

        # Calculate Savings
        token_savings = before_tokens - after_tokens
        pct_token_savings = (token_savings / before_tokens) * 100
        cost_savings = before_cost - after_cost
        pct_cost_savings = (cost_savings / before_cost) * 100 if before_cost > 0 else 0

        # Print Output
        print(f"\n{BOLD}CLASSIFICATION RESULTS:{RESET}")
        print(f"  {BOLD}Detected Intent:{RESET} {CYAN}{plan.intent}{RESET}")
        print(f"  {BOLD}Pipeline Action:{RESET} {CYAN}{plan.action}{RESET}")
        print(f"  {BOLD}Route Target:   {RESET} {CYAN}{plan.route}{RESET}")
        if memory_res:
            print(f"  {BOLD}Memory Match:   {RESET} {GREEN}{memory_res}{RESET}")
        if retrieval_res:
            print(f"  {BOLD}RAG Matches:    {RESET} {GREEN}{retrieval_res}{RESET}")
            
        print(f"\n{BOLD}TOKEN & COST COMPARISON:{RESET}")
        print("  " + "-" * 76)
        print(f"  {BOLD}Metric{RESET}               | {BOLD}{RED}Before (Old Agent){RESET} | {BOLD}{GREEN}After (Master Agent){RESET} | {BOLD}Savings{RESET}")
        print("  " + "-" * 76)
        print(f"  API Calls            | {before_calls:<17} | {after_calls:<20} | {GREEN if before_calls > after_calls else RESET}{before_calls - after_calls} calls saved{RESET}")
        print(f"  Tokens Consumed      | {before_tokens:<17} | {after_tokens:<20} | {GREEN}{pct_token_savings:.1f}% reduction{RESET}")
        print(f"  Estimated Cost       | ${before_cost:<16.5f} | ${after_cost:<19.5f} | {GREEN}{pct_cost_savings:.1f}% savings{RESET}")
        print("  " + "-" * 76)
        print(f"  {BOLD}Orchestration:{RESET} {orchestration_desc}")

if __name__ == "__main__":
    main()
