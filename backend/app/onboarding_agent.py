import os
import json
import time
from typing import Annotated, TypedDict, Optional, List
from dotenv import load_dotenv

from fastapi import APIRouter
from pydantic import BaseModel

from langchain_core.messages import AIMessage, SystemMessage, AnyMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

from langchain_openai import OpenAIEmbeddings
try:
    from langchain_chroma import Chroma
except ImportError:
    from langchain_community.vectorstores import Chroma

from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import TextLoader

# Setup directory constraints
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

CHROMA_DB_DIR = os.path.join(CURRENT_DIR, "chroma_user_db")
embeddings = OpenAIEmbeddings()

def get_vectorstore():
    return Chroma(
        collection_name="user_profiles",
        embedding_function=embeddings,
        persist_directory=CHROMA_DB_DIR
    )

def initialize_company_rag():
    try:
        kb_file = os.path.join(CURRENT_DIR, "company_knowledge.json")
        if not os.path.exists(kb_file):
            print("⚠️  company_knowledge.json not found. RAG disabled.")
            return None
        loader = TextLoader(kb_file, encoding="utf-8")
        docs = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=400, chunk_overlap=50)
        splits = splitter.split_documents(docs)
        vectorstore = Chroma.from_documents(
            documents=splits,
            embedding=embeddings,
            collection_name="company_kb",
            persist_directory=os.path.join(CURRENT_DIR, "chroma_company_kb")
        )
        print(f"✅ RAG initialized with {len(splits)} chunks from {kb_file}")
        return vectorstore.as_retriever(search_kwargs={"k": 3})
    except Exception as e:
        print(f"❌ RAG init failed: {e}")
        return None

company_retriever = initialize_company_rag()

class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]

def chat_node(state: AgentState):
    messages = state.get("messages", [])
    
    ai_question_count = sum(1 for m in messages if isinstance(m, AIMessage) and "DONE" not in m.content.upper())
    
    try:
        with open(os.path.join(CURRENT_DIR, "knowledge.json"), "r", encoding="utf-8") as f:
            flow_script = f.read()
    except Exception as e:
        print(f"Error reading knowledge.json: {e}")
        flow_script = ""
    
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
    
    from openai import OpenAI
    client = OpenAI()

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": prompt},
            *[
                {
                    "role": "user" if isinstance(m, HumanMessage) else "assistant",
                    "content": m.content
                }
                for m in messages
            ]
        ],
        temperature=0
    )

    content = response.choices[0].message.content
    
    try:
        data = json.loads(content)
        bot_tanglish = data.get("print_tanglish", "DONE")
        bot_tamil = data.get("speak_tamil", "DONE")
        bot_options = data.get("options", [])
    except:
        bot_tanglish = "DONE"
        bot_tamil = "DONE"
        bot_options = []
        
    return {"messages": [AIMessage(content=bot_tanglish, additional_kwargs={"speak_tamil": bot_tamil, "options": bot_options})]}

def save_to_vector_db_node(state: AgentState):
    messages = state["messages"]
    
    extraction_prompt = f"""
    Based on the following conversation, extract all the answers the user provided into a flat JSON object.
    Map them strictly to logical English keys (like "name", "age", "emotion", "goal", "learning_style", "motivation", "tech_level", etc.) describing the topic.
    For the values, use a clear exact English translation or readable Tanglish summary of what the user answered.
    Return ONLY valid JSON.
    """
    from openai import OpenAI
    client = OpenAI()

    conversation_msgs = [m for m in messages if "DONE" not in m.content.upper()]

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": extraction_prompt},
            *[
                {
                    "role": "user" if isinstance(m, HumanMessage) else "assistant",
                    "content": m.content
                }
                for m in conversation_msgs
            ]
        ],
        temperature=0
    )

    content = response.choices[0].message.content

    try:
        profile = json.loads(content)
    except:
        profile = {"raw_text": content}
    
    try:
        vectorstore = get_vectorstore()
        user_name = profile.get("name", "unknown")
        profile_text = json.dumps(profile, ensure_ascii=False)
        vectorstore.add_texts(
            texts=[profile_text],
            metadatas=[{"name": user_name, "source": "onboarding"}],
            ids=[f"user_{user_name}_{int(time.time())}"]
        )
        print(f"✅ Profile saved to ChromaDB for user: {user_name}")
    except Exception as e:
        print(f"❌ ChromaDB save error: {e}")
    
    db_file = os.path.join(CURRENT_DIR, "user_database.json")
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

def check_if_complete(state: AgentState) -> str:
    messages = state.get("messages", [])
    if not messages:
        return END
    last_msg = messages[-1].content.strip()
    if "DONE" in last_msg.upper():
        return "save_to_db"
    return END

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

memory = MemorySaver()
onboarding_app = workflow.compile(checkpointer=memory)

router = APIRouter()

class ChatRequest(BaseModel):
    user_id: str
    message: Optional[str] = None

@router.post("/chat")
async def onboarding_chat(request: ChatRequest):
    config = {"configurable": {"thread_id": request.user_id}}
    
    input_data = {"messages": []}
    if request.message and request.message.strip() != "":
        input_data = {"messages": [HumanMessage(content=request.message)]}
        
    response_text = ""
    status = "ONGOING"
    options = []
    
    for event in onboarding_app.stream(input_data, config=config):
        for key, value in event.items():
            if key == "Chat_Node":
                bot_msg = value["messages"][-1]
                response_text = bot_msg.content
                options = bot_msg.additional_kwargs.get("options", [])
                if "DONE" in response_text.upper():
                    status = "DONE"
            elif key == "Save_DB_Node":
                response_text = value["messages"][-1].content
                status = "COMPLETED"

    if "DONE" in response_text.upper():
        return {"text": "All set! Your profile has been created.", "options": [], "status": "COMPLETED"}

    return {
        "text": response_text,
        "options": options,
        "status": status
    }
