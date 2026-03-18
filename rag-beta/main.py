import os
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage
from rag_filter import RAGFilter

load_dotenv()

def generate_initial_response(question: str) -> str:
    """Generates a standard response from OpenAI without context (to force/simulate conflicts)."""
    llm = ChatOpenAI(model="gpt-4o", temperature=0.7)
    # We purposefully don't provide the profile here to see the filter in action
    response = llm.invoke([HumanMessage(content=question)])
    return response.content.strip()

def run_demo():
    filter_system = RAGFilter()
    
    print("\n🚀 RAG Safety Filter Beta Active")
    print("Type your questions below and press Enter.")
    print("Type 'exit' to quit the demo.\n")
    
    while True:
        user_question = input("QUESTION: ")
        
        if user_question.lower() in ['exit', 'quit', 'q']:
            print("Goodbye!")
            break
            
        if not user_question.strip():
            continue

        print(f"\n========================================")
        
        # Step 1: Initial AI Response
        initial_response = generate_initial_response(user_question)
        print(f"\nINITIAL AI RESPONSE:\n{initial_response}")
        
        # Step 2: Pass through RAG Filter
        final_response = filter_system.process_output(user_question, initial_response)
        
        # Step 3: Output Final Result
        print(f"\nFINAL SAFE RESPONSE:\n{final_response}")
        print(f"========================================\n")

if __name__ == "__main__":
    if not os.getenv("OPENAI_API_KEY"):
        print("Please set your OPENAI_API_KEY in the .env file.")
    else:
        run_demo()
