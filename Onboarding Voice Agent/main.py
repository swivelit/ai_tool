import os
import json
from typing import Annotated, TypedDict
from dotenv import load_dotenv

from langchain_core.messages import AIMessage, SystemMessage, AnyMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

# Load environment variables
load_dotenv()

# --- 1. Define the Graph State ---
class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]

# --- 2. Build LLMs & ChromaDB VectorDB ---
try:
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
except Exception as e:
    print(f"Failed to initialize LLM. Make sure OPENAI_API_KEY is in your .env file: {e}")
    exit(1)

from langchain_openai import OpenAIEmbeddings
try:
    from langchain_chroma import Chroma
except ImportError:
    from langchain_community.vectorstores import Chroma

# Initialize persistent ChromaDB for user profiles
CHROMA_DB_DIR = "chroma_user_db"
embeddings = OpenAIEmbeddings()

def get_vectorstore():
    return Chroma(
        collection_name="user_profiles",
        embedding_function=embeddings,
        persist_directory=CHROMA_DB_DIR
    )

# --- RAG: Company Knowledge Retriever ---
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import TextLoader

def initialize_company_rag():
    """Embeds company_knowledge.txt into ChromaDB for RAG retrieval."""
    try:
        kb_file = "company_knowledge.txt"
        if not os.path.exists(kb_file):
            print("⚠️  company_knowledge.txt not found. RAG disabled.")
            return None
        loader = TextLoader(kb_file, encoding="utf-8")
        docs = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=400, chunk_overlap=50)
        splits = splitter.split_documents(docs)
        vectorstore = Chroma.from_documents(
            documents=splits,
            embedding=embeddings,
            collection_name="company_kb",
            persist_directory="chroma_company_kb"
        )
        print(f"✅ RAG initialized with {len(splits)} chunks from {kb_file}")
        return vectorstore.as_retriever(search_kwargs={"k": 3})
    except Exception as e:
        print(f"❌ RAG init failed: {e}")
        return None

company_retriever = initialize_company_rag()

# --- 3. Node: Conversational Chat Logic ---
def chat_node(state: AgentState):
    """Dynamically chooses the next question based on the script and previous answers."""
    messages = state.get("messages", [])
    
    # Count how many questions the AI has asked so far
    ai_question_count = sum(1 for m in messages if isinstance(m, AIMessage) and "DONE" not in m.content.upper())
    
    # Load the onboarding flow script (direct, not RAG)
    try:
        with open("knowledge.txt", "r", encoding="utf-8") as f:
            flow_script = f.read()
    except Exception as e:
        print(f"Error reading knowledge.txt: {e}")
        flow_script = ""
    
    # RAG: Retrieve company knowledge if user asked a question
    rag_context = ""
    if messages and company_retriever:
        last_human_msgs = [m for m in reversed(messages) if isinstance(m, HumanMessage)]
        if last_human_msgs:
            user_query = last_human_msgs[0].content
            try:
                docs = company_retriever.invoke(user_query)
                if docs:
                    rag_context = "\n".join([d.page_content for d in docs])
            except Exception as e:
                print(f"RAG retrieval error: {e}")
        
    prompt = f"""
    You are a smart Tamil AI onboarding assistant.
    
    *** QUESTION COUNTER: You have asked {ai_question_count} questions so far. ***
    
    STRICT RULES:
    - You MUST ask AT LEAST 12 questions before you can say DONE.
    - If the counter above shows LESS than 12, you are ABSOLUTELY FORBIDDEN from outputting DONE. Keep asking questions!
    - Target: 12 to 15 questions total. After 15, you MUST stop.
    - Current status: {ai_question_count} asked, {"KEEP GOING! DO NOT SAY DONE!" if ai_question_count < 12 else "You may finish after this question."}
    
    You must strictly follow this behavior based on the provided Onboarding Flow Script:
    1. Ask ONLY one question at a time from the ONBOARDING FLOW SCRIPT.
    2. Wait for user answer before asking the next question.
    3. Follow the sequence of the ONBOARDING FLOW SCRIPT perfectly. 
    4. Select the next question based on the script's flow and the user's previous answers checking the IF/ELSE blocks.
    5. You MUST ask every applicable question in the script (which will be at least 12 to 15 questions based on the flow). Do not skip sections unless the IF/ELSE logic tells you to skip.
    6. Do NOT repeat questions.
    7. Keep conversation natural, friendly, and short.
    8. Always speak in natural spoken Tanglish (Tamil + English mixture).
    9. If user gives an unexpected answer, still continue smoothly to the next question.
    10. Base your questions directly on the exact questions in the script, just adjusting tone for the age group. Do not make up random questions outside the script!
    11. Make sure to provide the "Options" exactly as specified in the script if they exist.
    
    --- HYBRID RAG: COMPANY KNOWLEDGE ---
    If the user asks a QUESTION (about pricing, features, support, data privacy, etc.) instead of answering your onboarding question, use the following retrieved Company Knowledge to answer them ACCURATELY in Tanglish:
    
    [{rag_context}]
    
    RULES for RAG answers:
    - Answer their question briefly and accurately using ONLY the company knowledge above.
    - Do NOT make up information that is not in the knowledge base.
    - After answering, IMMEDIATELY steer back to the onboarding by asking the next question.
    - This RAG answer should NOT count as one of the 12-15 onboarding questions.
    
    --- AGE-WISE TONE RULES ---
    CRITICAL: Once you know the user's age group, you MUST adapt your speaking tone for ALL remaining questions:
    
    IF age = Under 18:
    → Use a FUN, CASUAL, BIG-BROTHER/SISTER tone. Use slang, emojis, and hype words.
    → Example: "Dai super da! 🔥 Seri next... nee school ah college ah?"
    → Use "nee", "da/di", keep it playful and energetic.
    
    IF age = 18-24:
    → Use a COOL, FRIENDLY, MOTIVATIONAL peer tone. Like a supportive friend.
    → Example: "Nice bro! Semma choice 💪 Seri tell me, side income try pannirukiya?"
    → Use "bro/sis", "neenga/nee" casually, be encouraging and upbeat.
    
    IF age = 25-34:
    → Use a WARM, PROFESSIONAL, RESPECTFUL tone. Like a helpful mentor.
    → Example: "Super choice 👍 Unga experience ku suit aagum. Next, career change panna yosichirukeenga?"
    → Use "neenga", be supportive but mature.
    
    IF age = 35-50:
    → Use a HIGHLY RESPECTFUL, CALM, PROFESSIONAL tone. Like a trusted advisor.
    → Example: "Romba nalla iruku 🙏 Ungaloda experience valuable. Seri, technology use panna comfortable ah?"
    → Use "neenga", "ungaloda", speak with dignity and patience.
    
    IF age = 50+:
    → Use an EXTREMELY RESPECTFUL, PATIENT, GENTLE tone. Like speaking to an elder with full respect.
    → Example: "Romba nandri 🙏 Ungalukku comfortable ah irukanum, athaan important. Seri, daily phone use panreengala?"
    → Use "neenga", "ungalukku", speak slowly, simply, avoid tech jargon, be very warm and patient.
    
    OUTPUT RULE:
    You MUST return valid JSON exactly matching this format:
    {{
        "print_tanglish": "<Agent response and question in Tanglish>",
        "speak_tamil": "<Agent response and question in Tamil script>",
        "options": ["Option 1", "Option 2"] // ONLY include this field if the question in the script explicitly has Options. Otherwise, return an empty list.
    }}
    Do not output anything else. If the user hits the END condition of the script, output exactly:
    {{ "print_tanglish": "DONE", "speak_tamil": "DONE", "options": [] }}
    
    --- ONBOARDING FLOW SCRIPT ---
    {flow_script}
    """
    
    sys_msg = SystemMessage(content=prompt)
    response = llm.bind(response_format={"type": "json_object"}).invoke([sys_msg] + messages)
    
    try:
        data = json.loads(response.content)
        bot_tanglish = data.get("print_tanglish", "DONE")
        bot_tamil = data.get("speak_tamil", "DONE")
        bot_options = data.get("options", [])
    except:
        bot_tanglish = "DONE"
        bot_tamil = "DONE"
        bot_options = []
        
    return {"messages": [AIMessage(content=bot_tanglish, additional_kwargs={"speak_tamil": bot_tamil, "options": bot_options})]}

# --- 4. Node: Database Save Logic (ChromaDB Vector Store) ---
def save_to_vector_db_node(state: AgentState):
    """Extracts final JSON profile and saves to ChromaDB vector store + JSON backup."""
    messages = state["messages"]
    
    # Run a quick extraction to build the final JSON profile from history
    extraction_prompt = f"""
    Based on the following conversation, extract all the answers the user provided into a flat JSON object.
    Map them strictly to logical English keys (like "name", "age", "emotion", "goal", "learning_style", "motivation", "tech_level", etc.) describing the topic.
    For the values, use a clear exact English translation or readable Tanglish summary of what the user answered.
    Return ONLY valid JSON.
    """
    sys_msg = SystemMessage(content=extraction_prompt)
    
    extraction_llm = ChatOpenAI(model="gpt-4o-mini", temperature=0).bind(response_format={"type": "json_object"})
    conversation_msgs = [m for m in messages if "DONE" not in m.content.upper()]
    extracted_data = extraction_llm.invoke([sys_msg] + conversation_msgs)
    
    try:
        profile = json.loads(extracted_data.content)
    except:
        profile = {"raw_text": extracted_data.content}
    
    # --- Save to ChromaDB Vector Store ---
    try:
        vectorstore = get_vectorstore()
        user_name = profile.get("name", "unknown")
        profile_text = json.dumps(profile, ensure_ascii=False)
        
        vectorstore.add_texts(
            texts=[profile_text],
            metadatas=[{"name": user_name, "source": "onboarding"}],
            ids=[f"user_{user_name}_{int(__import__('time').time())}"]
        )
        print(f"✅ Profile saved to ChromaDB for user: {user_name}")
    except Exception as e:
        print(f"❌ ChromaDB save error: {e}")
    
    # --- Also save to JSON backup ---
    db_file = "user_database.json"
    try:
        if os.path.exists(db_file):
            with open(db_file, "r", encoding="utf-8") as f:
                db_data = json.load(f)
        else:
            db_data = []
    except Exception:
        db_data = []
        
    db_data.append(profile)
    
    with open(db_file, "w", encoding="utf-8") as f:
        json.dump(db_data, f, indent=4, ensure_ascii=False)
        
    final_msg = "Super done! Ellam save aagiduchu 🎉"
    return {"messages": [AIMessage(content=final_msg)]}

# --- 5. Edge routing ---
def check_if_complete(state: AgentState) -> str:
    """Routing function: checks if the LLM outputted DONE."""
    messages = state.get("messages", [])
    if not messages:
        return END
        
    last_msg = messages[-1].content.strip()
    
    if "DONE" in last_msg.upper():
        return "save_to_db"
    return END

# --- 6. Graph Compilation ---
workflow = StateGraph(AgentState)

workflow.add_node("Chat_Node", chat_node)
workflow.add_node("Save_DB_Node", save_to_vector_db_node)

workflow.set_entry_point("Chat_Node")

workflow.add_conditional_edges(
    "Chat_Node",
    check_if_complete,
    {
        "save_to_db": "Save_DB_Node",
        END: END
    }
)

workflow.add_edge("Save_DB_Node", END)

# Add MemorySaver to persist state between loops easily
memory = MemorySaver()
onboarding_app = workflow.compile(checkpointer=memory)

# --- Audio/Speech Inputs ---
import subprocess

try:
    import speech_recognition as sr
    from openai import OpenAI
    openai_client = OpenAI()
except ImportError:
    sr = None
    openai_client = None

def get_user_input():
    """Allows user to type or fallback to voice recording."""
    user_text = input("\nYou (Type your answer, or simply press Enter to Speak 🎤): ")
    if user_text.strip() != "":
        return user_text
        
    if not sr or not openai_client:
        print("Speech libraries not installed. Please run: pip install SpeechRecognition pyaudio openai")
        return input("\nYou (Type): ")
        
    print("🎙️  Recording... (Speak now)")
    recognizer = sr.Recognizer()
    try:
        with sr.Microphone() as source:
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            audio = recognizer.listen(source, timeout=10, phrase_time_limit=15)
            
        temp_wav = "temp_input.wav"
        with open(temp_wav, "wb") as f:
            f.write(audio.get_wav_data())
            
        print("⏳  Transcribing voice...")
        with open(temp_wav, "rb") as audio_file:
            transcript = openai_client.audio.transcriptions.create(
                model="whisper-1", 
                file=audio_file,
                prompt="The user is speaking Tanglish (Tamil and English mixing). Transcribe accurately in Latin script."
            )
        print(f"[🎤 Voice Transcription]: {transcript.text}")
        return transcript.text
    except Exception as e:
        print(f"Voice input failed: {e}")
        return input("\nYou (Type): ")

# --- Interation Execution Loop ---
if __name__ == "__main__":
    print("-" * 50)
    print("Welcome to the Onboarding Agent (Now With Voice!) 🗣️")
    print("-" * 50)
    
    config = {"configurable": {"thread_id": "1"}}
    
    # Kick off the first question without any human input
    first_stream = onboarding_app.stream({"messages": []}, config=config)
    for event in first_stream:
        for key, value in event.items():
            if key == "Chat_Node":
                bot_msg = value['messages'][-1]
                bot_text = bot_msg.content
                print(f"\nBot: {bot_text}")

    while True:
        try:
            user_message = get_user_input()
            if user_message.lower() in ['exit', 'quit', 'bye', 'stop']:
                print("Exiting...")
                break
                
            for event in onboarding_app.stream({"messages": [HumanMessage(content=user_message)]}, config=config):
                for key, value in event.items():
                    if key == "Chat_Node":
                        bot_msg = value["messages"][-1]
                        bot_response = bot_msg.content
                        if "DONE" not in bot_response.upper():
                            print(f"\nBot: {bot_response}")

                    if key == "Save_DB_Node":
                        bot_response = value["messages"][-1].content
                        print(f"\nBot: {bot_response}")
                        print("\n[System]: Process Complete.")
                        exit(0)
                        
        except (KeyboardInterrupt, EOFError):
            print("\nExiting...")
            break
