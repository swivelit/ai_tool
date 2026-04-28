# Backend Data Directory

This directory contains two categories of files:

- Versioned seed/config data: CSV files such as `classifier_dataset.csv`,
  `pipeline_questions.csv`, `fast_rag_replies.csv`, `local_rag_keywords.csv`,
  and `local_rag_synonyms.csv`.
- Runtime/private data: generated profiles, guest chat history, SQLite
  databases, exported documents, agent state, logs, and caches.

Runtime/private data must stay out of git. Safe examples should live under
`backend/data/sample/` with scrubbed placeholder values.

The following files currently look like runtime data and should be removed from
git tracking in a separate cleanup commit after confirming no user data is
needed in history:

- `backend/data/logs/guest_history.jsonl`
- `backend/data/profiles/1.json`
- `backend/data/profiles/guest.json`
