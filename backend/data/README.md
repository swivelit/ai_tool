# Backend Data Directory

This directory contains two categories of files:

- Versioned seed/config data: CSV files such as `classifier_dataset.csv`,
  `pipeline_questions.csv`, `fast_rag_replies.csv`, `local_rag_keywords.csv`,
  and `local_rag_synonyms.csv`.
- Runtime/private data: generated profiles, guest chat history, SQLite
  databases, exported documents, agent state, logs, and caches.

Runtime/private data must stay out of git. Safe examples should live under
`backend/data/sample/` with scrubbed placeholder values.

The runtime directories `backend/data/logs/` and `backend/data/profiles/` are
ignored by git and excluded from repository archives. Keep seed CSVs and
scrubbed sample profiles tracked.
