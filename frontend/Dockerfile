# Minimal Dockerfile
# Designed for Google Cloud Run / GCE. The container listens on $PORT (default 8080).

FROM python:3.11-slim

# Set a working directory
WORKDIR /app

# Install system deps (ca-certificates are usually present, but ensure minimal tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy just the requirements first for better caching
COPY requirements.txt ./

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . /app

# Ensure the entrypoint uses the PORT env var provided by Cloud Run
ENV PORT 8080

# Allow custom env file path (will be passed by deploy.sh via --set-env-vars)
# Default to empty - when empty, frontend.py will use find_dotenv() fallback
ENV ENV_FILE_PATH=""

# Expose the port (informational)
EXPOSE 8080

# Use a simple, robust command to run the Flask app with Gunicorn for production
# - Bind to 0.0.0.0:$PORT
# - Use 1 worker for small apps; Cloud Run will scale instances instead
# - Use --preload to slightly speed startup

RUN pip install --no-cache-dir gunicorn

CMD ["gunicorn", "frontend:app", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4"]