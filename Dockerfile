FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV UV_THREADPOOL_SIZE=16
ENV NODE_OPTIONS="--max-old-space-size=1536"
COPY package.json package-lock.json requirements.txt ./
RUN npm ci --omit=dev
COPY *.js config.json start.sh ./
COPY geo/ ./geo/
COPY public/ ./public/
COPY vendor/ ./vendor/

RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir --quiet --upgrade pip \
 && .venv/bin/pip install --no-cache-dir --quiet -r requirements.txt

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||process.env.SERVER_PORT||8787;fetch('http://127.0.0.1:'+p+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bash", "start.sh"]
