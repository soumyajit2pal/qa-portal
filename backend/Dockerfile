# Backend API image -- FastAPI/SQLAlchemy/Oracle. Independent of the
# frontend images entirely; the frontend only ever talks to this over HTTP
# (see each frontend package's VITE_BACKEND_URL / dev proxy).
FROM python:3.11-slim

WORKDIR /app

# System deps: none required for the Oracle driver itself (oracledb runs in
# thin mode by default -- no Oracle Instant Client install needed, see the
# comment on requirements.txt's oracledb line). build-essential is kept for
# any dependency that needs to compile a wheel on install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Uploaded documents (see app/documents.py, app/routers/qa_requests.py
# UPLOAD_ROOT) persist under app/uploads -- mount a volume here in
# docker-compose.yml/production so uploads survive container restarts
# instead of living only in the image's writable layer.
RUN mkdir -p /app/app/uploads
VOLUME ["/app/app/uploads"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
