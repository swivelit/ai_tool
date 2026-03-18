# Agent Intelligence Report: RAG Filter Architecture

This document provides a technical explanation of the filtering pipeline for developers and AI agents.

## 🏗 System Architecture

The system follows a synchronous **Post-Generation Processing** pipeline:

1. **Initial Inference**: A generic LLM call produces a draft response.
2. **Contextual Retrieval**: 
   - Uses `OpenAIEmbeddings` to vectorize the draft response.
   - Performs a `similarity_search` in a local `FAISS` vector store containing user profile strings.
3. **Conflict Detection (The Judge)**:
   - A secondary LLM call receives the `User Profile Context` and the `Draft Response`.
   - It is prompted to act as a safety judge, outputting `CONFLICT: [reasoning]` or `SAFE`.
4. **Response Remodeling (The Editor)**:
   - If a conflict is flagged, a final LLM call combines the original question, the draft response, the conflict reasoning, and the user constraints.
   - It outputs a refined, constraint-compliant response.

## 🛠 Tech Stack
- **Framework**: LangChain (v0.3+)
- **Vector Store**: FAISS (Facebook AI Similarity Search)
- **Model**: OpenAI GPT-4o
- **Embeddings**: `text-embedding-3-small` (default via OpenAI)

## 🔑 Key Code Snippet
The core logic resides in `rag_filter.py`:
```python
def process_output(self, original_question, ai_response):
    relevant_context = self.retrieve_relevant_context(ai_response)
    has_conflict, reasoning = self.check_for_conflicts(ai_response, relevant_context)
    if has_conflict:
        return self.remodel_response(original_question, ai_response, reasoning, relevant_context)
    return ai_response
```

## 📈 Technical Considerations
- **K-Value**: Currently set to `k=5` for retrieval depth.
- **Temperature**: Set to `0` for Detection and Remodeling to ensure maximum consistency and compliance.
