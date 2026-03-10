# ============================================
# Sprout AI Server — Hugging Face Spaces
# ============================================
# Docker deployment for Flask + SocketIO server
# Runs on port 7860 (HF Spaces requirement)
# ============================================

FROM python:3.9-slim

# System deps for OpenCV + general build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (HF Spaces best practice)
RUN useradd -m -u 1000 appuser

WORKDIR /app

# Copy and install Python deps first (Docker cache optimization)
COPY server/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY server/ .

# Create writable dirs for model cache
RUN mkdir -p /app/model_cache /tmp/ultralytics && \
    chown -R appuser:appuser /app /tmp/ultralytics

# Env vars
ENV PORT=7860
ENV PYTHONUNBUFFERED=1
ENV ULTRALYTICS_CONFIG_DIR=/tmp/ultralytics

# Switch to non-root user
USER appuser

EXPOSE 7860

# Start with gunicorn + eventlet worker for WebSocket support
CMD ["gunicorn", \
     "--bind", "0.0.0.0:7860", \
     "--worker-class", "eventlet", \
     "--workers", "1", \
     "--timeout", "120", \
     "--log-level", "info", \
     "app:app"]
