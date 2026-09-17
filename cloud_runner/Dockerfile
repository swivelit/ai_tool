FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt /app/cloud_runner/requirements.txt
RUN pip install --no-cache-dir -r /app/cloud_runner/requirements.txt
COPY . /app/cloud_runner

# The image contains the HTTP runner and controller entry points. Render
# services select one command; neither entry point executes code in FastAPI.
CMD ["sh", "-c", "exec uvicorn cloud_runner.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
