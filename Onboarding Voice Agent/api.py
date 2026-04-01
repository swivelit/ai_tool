import os
import io
import base64
from typing import Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from langchain_core.messages import HumanMessage

from main import onboarding_app

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
     allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    user_id: str
    message: Optional[str] = None

@app.post("/api/chat")
async def chat(request: ChatRequest):
    config = {"configurable": {"thread_id": request.user_id}}
    
    input_data = {"messages": []}
    if request.message and request.message.strip() != "":
        input_data = {"messages": [HumanMessage(content=request.message)]}
        
    response_text = ""
    response_audio_text = ""
    status = "ONGOING"
    options = []
    
    for event in onboarding_app.stream(input_data, config=config):
        for key, value in event.items():
            if key == "Chat_Node":
                bot_msg = value["messages"][-1]
                response_text = bot_msg.content
                response_audio_text = bot_msg.additional_kwargs.get("speak_tamil", response_text)
                options = bot_msg.additional_kwargs.get("options", [])
                if "DONE" in response_text.upper():
                    status = "DONE"
            elif key == "Save_DB_Node":
                response_text = value["messages"][-1].content
                response_audio_text = response_text
                status = "COMPLETED"

    if "DONE" in response_text.upper():
        return {"text": "All set! Your profile has been created.", "audio_base64": None, "options": [], "status": "COMPLETED"}

    return {
        "text": response_text,
        "audio_base64": None,
        "options": options,
        "status": status
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
