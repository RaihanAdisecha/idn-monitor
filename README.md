# SITREP — OSINT Console

Dashboard situasi real-time: news wire, monitor sosial (X + Threads), globe insiden (gempa BMKG, gunung api, cuaca, radar), data pasar, dan live TV/CCTV.

## Stack

- **Backend:** `server.js` — Node.js ≥18, zero npm dependencies (raw `http`)
- **Worker:** `vendor/threads_*.py` — Python + `curl_cffi` (Threads scraper)
- **Frontend:** `public/index.html` — single-file vanilla JS/CSS, no build step

## Menjalankan lokal

```bash
# butuh: node ≥18, python3
python3 -m venv .venv
.venv/bin/pip install curl_cffi

cp .env.example .env   # isi credentials
node server.js         # atau: bash start.sh
```

Buka `http://localhost:8787` — frontend auto-detect API (same-origin, `?api=`, atau `localhost:8787`).

## Environment variables

Semua secret dibaca dari env / `.env` (file `.env` dimuat otomatis oleh `server.js`):

| Key | Untuk |
|---|---|
| `TOMTOM_API_KEY` | Routing/lalin di peta |
| `AISSTREAM_API_KEY` | Stream AIS kapal (WebSocket) |
| `NASA_FIRMS_API_KEY` | Hotspot karhutla |
| `FIRECRAWL_API_KEY` | Fallback reader untuk situs anti-bot (Cloudflare) |
| `X_AUTH_TOKEN` + `X_CT0` | Cookie sesi X untuk search (wajib untuk `/api/x`) |
| `X_BEARER`, `X_QUERY_ID` | Opsional — override bearer/query-id X |
| `PORT` / `SERVER_PORT` | Port listen (default 8787) |

`config.json` hanya berisi non-secret: port, host CCTV/TV. Topik sosial (X + Threads) ada di `social.js` (`SOC_TOPICS`): satu registry untuk query, klasifikasi, dan chip.

## Struktur

```
server.js          API + scraping + proxy + WS
public/index.html  seluruh UI (CSS+JS inline)
vendor/            threads scraper python
start.sh           bootstrap venv + jalankan server (untuk panel host)
data/              history sosial persisten (runtime, di-gitignore)
fxhist.json        histori forex (runtime, di-gitignore)
```

## Deploy

Butuh host dengan proses persistent + filesystem writable + outbound WebSocket — **bukan** serverless (Vercel/Workers tidak support `child_process`, WS persisten, dan penulisan file).

Cocok: VPS (pm2/systemd), Railway/Render disk persisten, atau panel game-bot (Botkeep dkk) via `bash start.sh`.

```bash
bash start.sh   # start command di panel
```

## Catatan

- X scraping memakai cookie akun sendiri — rotasi `auth_token`/`ct0` berkala.
- Endpoint `/img`, `/api/read`, proxy endpoints memblokir host privat (SSRF guard).
- `config.json` → `"insecure_tls": true` mematikan validasi TLS — jangan di produksi.
