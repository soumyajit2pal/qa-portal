FROM docker.io/library/python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini ./alembic.ini
COPY alembic ./alembic
COPY app ./app

ENV UPLOAD_STORAGE_ROOT=/data/qualityops/uploads
ENV DOCUMENT_PORTAL_STORAGE_HOST_PATH=/data/qualityops/uploads/document-portal
ENV PYTHONDONTWRITEBYTECODE=1

# All runtime uploads live below one stable container path. Docker Compose
# supplies the explicit durable bind mount. Do not declare an image VOLUME
# here: that would silently create writable anonymous volumes for the migrate
# and Document Portal containers and leave orphaned data behind.
RUN mkdir -p /data/qualityops/uploads/document-portal \
    && chown -R root:root /data/qualityops/uploads

EXPOSE 8000

ENV WEB_CONCURRENCY=4
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY}"]
