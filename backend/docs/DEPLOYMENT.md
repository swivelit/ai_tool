# Deployment Guide

## System Requirements

* Python 3.14+
* SQLite / PostgreSQL
* OpenAI API Key
* Sarvam API Key

## Installation

### Clone Repository

git clone <repository-url>

### Navigate

cd backend

### Install Dependencies

pip install -r requirements.txt

### Environment Variables

Create .env file

Required:

OPENAI_API_KEY=<key>
SARVAM_API_KEY=<key>

### Database Setup

Run migrations if applicable.

### Start Application

uvicorn app.main:app --reload

## Testing

Run:

pytest

Expected:

431 passed
1 skipped
0 failed

## Production Recommendations

* Use PostgreSQL
* Enable Redis Cache
* Configure Monitoring
* Enable Log Rotation
* Use HTTPS
