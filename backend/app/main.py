from fastapi import FastAPI

app = FastAPI(title="Tamil Voice AI Backend")


@app.get("/health")
def health_check():
    return {"status": "ok", "message": "Tamil Voice AI backend is running 🚀"}
