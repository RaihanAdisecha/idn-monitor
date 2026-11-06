FROM node:20-slim

# Install python & build dependencies for curl_cffi
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Setup virtualenv and install curl_cffi
RUN python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir --upgrade pip && \
    .venv/bin/pip install --no-cache-dir curl_cffi

RUN mkdir -p data

EXPOSE 8787
ENV PORT=8787

CMD ["node", "server.js"]
