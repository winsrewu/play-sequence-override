# syntax=docker/dockerfile:1.7
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TMPDIR=/tmp \
    NUMBA_CACHE_DIR=/tmp/numba \
    JOBLIB_TEMP_FOLDER=/tmp \
    MPLCONFIGDIR=/tmp/matplotlib

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt ./
# CPU-only wheels: the service is designed for a small CPU container.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.15.0+cpu \
        torchaudio==2.11.1+cpu \
        torchvision==0.29.2+cpu \
    && pip install -r requirements.txt

COPY server/app ./app
COPY server/vendor ./vendor
COPY server/assets ./assets
COPY server/data ./data
COPY LICENSE ./LICENSE
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md

RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app \
    && chown -R 10001:10001 /app

USER 10001

EXPOSE 8000

# There is deliberately no /health endpoint. A TCP connect is enough to prove
# the single worker is listening, and it does not add a second public route.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD python -c "import socket; s=socket.create_connection(('127.0.0.1',8000),2); s.close()"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-server-header"]
