# ai_tool
#Whenever you work on backend in a new terminal 

cd /Users/hari/Documents/my_git/ai_tool/backend
source .venv/bin/activate
uvicorn app.main:app --reload

# AI Tool

This project has 3 parts:

1. **Mobile App (APK / Expo app)**
2. **Main Backend API** (`backend/app/main.py`)
3. **Local Theni-Tamil Model API** (`backend/theni_tamil_api.py`)

## Important

The app can open and run, but for **cost-free Theni-Tamil conversion** you should also run the **local model API** on your machine/server.

- **Without the local model API:** the backend can fall back to OpenAI for Tamil → Theni-Tamil conversion.
- **With the local model API:** the backend will use your local trained model instead, which avoids extra OpenAI cost for that conversion stage.

> Complex answers may still use OpenAI depending on your architecture.
> Greetings / small-talk / cached / local-RAG answers can be handled locally and may not call OpenAI.

---

## Project Structure

```text
ai_tool-main/
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   └── local_rag_service.py
│   ├── data/
│   │   ├── fast_rag_replies.csv
│   │   ├── classifier_dataset.csv
│   │   └── pipeline_questions.csv
│   ├── models/
│   │   └── stage_tamil_thenitamil_model/
│   ├── theni_tamil_api.py
│   ├── requirements.txt
│   └── .venv/
├── mobile/
└── README.md


1. Backend setup

Open a terminal and go to backend:

cd backend

Create and activate virtual environment:

python3 -m venv .venv
source .venv/bin/activate

Install backend dependencies:

pip install -r requirements.txt

Install local model dependencies also:

pip install transformers torch sentencepiece accelerate
2. Create the local model folder

Create this folder inside backend:

mkdir -p backend/models/stage_tamil_thenitamil_model

Put your Tamil → Theni-Tamil Hugging Face model files inside:

backend/models/stage_tamil_thenitamil_model/
├── config.json
├── generation_config.json          (optional)
├── tokenizer.json / tokenizer_config.json
├── special_tokens_map.json         (optional)
├── sentencepiece.bpe.model         (if used by your tokenizer)
├── pytorch_model.bin
# or
├── model.safetensors
Note

The folder must contain a valid Hugging Face model directory.
At minimum, it should usually have:

config.json

tokenizer files

model weights (.bin or .safetensors)

If your model is inside a nested subfolder, the API will try to find it automatically.

3. Environment variables

Create a backend/.env file if it does not already exist.

Example:

OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4.1-mini

# Main backend will call the local Theni API here
THENI_TAMIL_API_URL=http://127.0.0.1:9009/convert
THENI_TAMIL_API_TIMEOUT=90
Important

THENI_TAMIL_API_URL is used by the main backend

THENI_MODEL_ROOT is used by the local model API process

4. Run the local Theni-Tamil model API

From the backend/ folder:

source .venv/bin/activate
export THENI_MODEL_ROOT=./models/stage_tamil_thenitamil_model
uvicorn theni_tamil_api:app --host 127.0.0.1 --port 9009

Health check:

curl http://127.0.0.1:9009/health

If everything is correct, you should see JSON showing the resolved model folder.

5. Run the main backend

Open another terminal:

cd backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
6. Run the mobile app

Open another terminal:

cd mobile
npm install
npx expo start

Or build/install your APK as usual.

7. How the response pipeline works
Fast local flow

Some simple inputs can be answered without OpenAI:

greetings (hi, hello, hey)

small-talk

saved/cached answers

local CSV-based RAG replies

reminder/schedule summary answers from local DB

These are handled by:

backend/app/local_rag_service.py

backend/data/fast_rag_replies.csv

backend/data/classifier_dataset.csv

Main flow

For complex questions:

User sends query

Main backend generates English answer

English is translated to Tamil

Tamil is converted to Theni-Tamil

first tries local model API

if unavailable, may fall back to other configured logic

8. What happens if the local model API is not running?

The app and backend can still run.

But:

Tamil → Theni-Tamil local conversion will not use your local trained model

the system may fall back to OpenAI or other fallback logic

this can increase API cost

So for the best low-cost setup, run both:

main backend

local Theni-Tamil model API

9. One-command local model startup script

You can create this file:

backend/run_local_model_api.sh

Make it executable:

chmod +x backend/run_local_model_api.sh

Then run:

cd backend
./run_local_model_api.sh