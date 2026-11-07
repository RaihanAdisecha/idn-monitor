FROM node:20-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js social.js social-history.js assessment.js geocode.js config.json start.sh ./
COPY geo/ ./geo/
COPY public/ ./public/
COPY vendor/ ./vendor/

RUN python3 -m venv .venv \
 && .venv/bin/pip install --quiet --upgrade pip \
 && .venv/bin/pip install --quiet curl_cffi

EXPOSE 8787
CMD ["node", "server.js"]
