# SITREP — OSINT Console

Dashboard situasi real-time: news wire, monitor sosial (X + Threads), globe insiden (gempa BMKG, gunung api, cuaca, radar), data pasar, dan live TV/CCTV.

## Stack

- **Backend:** `server.js` — Node.js ≥18, `http` native + satu dependensi npm: `franc` (deteksi bahasa)
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

`.env.example` hanya berisi placeholder (`your-key-here` / kosong); jangan commit `.env` yang sudah diisi secret asli. Lihat juga bagian **Token API** di bawah kalau endpoint mulai membalas `403`.

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
| `SITREP_TOKEN` | Token gate API (dipakai di mode lokal atau klien headless bila diset eksplisit) |
| `SITREP_USERS` | Daftar akun sesi + RBAC (`user:role:password` atau `scrypt$...`, role `viewer`/`operator`/`admin`) |
| `SITREP_AUTH_SECRET` | Secret HMAC-SHA256 untuk cookie `HttpOnly` `sitrep_sess` |
| `SITREP_TRUST_PROXY` | `1` = percaya `X-Forwarded-For` / `X-Forwarded-Proto` di belakang reverse proxy |
| `SITREP_EXTRA_CA` | Path file PEM CA tambahan untuk verifikasi TLS upstream (opsional) |

> **Catatan:** file `.env` yang ada saat ini **belum memuat `FIRECRAWL_API_KEY`**, padahal kode dan README merujuknya. Tambahkan dari `.env.example` agar fallback reader anti-bot berfungsi.

`config.json` hanya berisi non-secret: port, host CCTV/TV. Topik sosial (X + Threads) ada di `social.js` (`SOC_TOPICS`): satu registry untuk query, klasifikasi, dan chip.

## Token API (`SITREP_TOKEN`)

Semua endpoint sensitif kini dilindungi token. **Token efektif** = `process.env.SITREP_TOKEN` bila diset; kalau kosong, server membuat token acak (hex) **per-boot**.

- `GET /` menyisipkan `<meta name="sitrep-token" content="TOKEN">` tepat setelah `<head>`. Frontend membaca meta ini lalu mengirim header `x-sitrep-token` pada tiap request API, dan menambahkan `&token=` pada URL proxy media.
- Gate menerima token lewat **header `x-sitrep-token`** **atau** **query param `?token=`**.
- Yang kena gate: **semua `/api/*` kecuali `/api/ping`**, ditambah **`/img`, `/hls`, `/vhs`**. `/api/ping` sengaja dikecualikan untuk cek hidup frontend dan **tidak** mengembalikan token.

**Mode lintas-origin (`?api=`):** kalau halaman frontend tidak dimuat dari server SITREP (mis. dibuka di host lain atau lewat `?api=https://server-sitrep`), meta tag tidak tersedia, jadi token harus dikirim lewat URL halaman:

```
http://<host-frontend>/?api=https://server-sitrep&token=<TOKEN>
```

`<TOKEN>` = nilai `SITREP_TOKEN` di server, atau token yang tampil di meta tag `GET /` server tersebut. Untuk panggilan langsung (curl, `scripts/audit-reader.js`), kirim header `x-sitrep-token` atau set env `SITREP_TOKEN` — tool audit akan menolak jalan dengan pesan jelas kalau token tidak bisa diperoleh.

## Struktur

```
server.js          API + scraping + proxy + WS
security.js        DNS-pinned HTTP/TLS client, AIA repair, sesi/RBAC, rate-limit, fatal guard
public/index.html  seluruh UI (CSS+JS inline)
vendor/            threads scraper python
start.sh           bootstrap venv + supervisor restart loop server
data/              history sosial persisten (runtime, di-gitignore)
fxhist.json        histori forex (runtime, di-gitignore)
```

## Deploy

Butuh host dengan proses persistent + filesystem writable + outbound WebSocket — **bukan** serverless (Vercel/Workers tidak support `child_process`, WS persisten, dan penulisan file).

Cocok: VPS (pm2/systemd), Railway/Render disk persisten, atau panel game-bot (Botkeep dkk) via `bash start.sh`.

```bash
bash start.sh   # start command di panel
```

## Pengujian & audit

```bash
npm test                      # jalankan test suite Node
node scripts/audit-reader.js  # audit noise reader: [maxPerSource] [baseUrl]
```

`npm test` menjalankan seluruh `tests/*.js` (sinyal, geo, event-merge, token gate API, worker Python, pipeline klasifikasi). `npm run test:signals` tersedia untuk regresi sinyal & signal-engine saja. `audit-reader.js` default `maxPerSource=2` / `baseUrl=http://localhost:8787`, hasil ditulis ke `scripts/audit-output.json`; skrip ini butuh token (lihat **Token API**).

## Catatan

- X scraping memakai cookie akun sendiri — rotasi `auth_token`/`ct0` berkala.
- Endpoint `/img`, `/hls`, `/vhs`, `/api/read` mempin IP hasil validasi DNS ke socket koneksi (tahan DNS rebinding) dan memblokir host privat.
- Verifikasi sertifikat TLS selalu aktif (tidak ada fallback `rejectUnauthorized: false`). Upstream yang rantai intermediate-nya tidak lengkap ditambal lewat AIA chain repair yang terjangkar ke CA tepercaya (`tls.rootCertificates` + `SITREP_EXTRA_CA`).
- Untuk deployment publik, set **`SITREP_USERS`** dan **`SITREP_AUTH_SECRET`** agar login memakai cookie `HttpOnly` dan RBAC (`viewer` / `operator` / `admin`) tanpa menanam token API ke HTML.

## CCTV: arsitektur & operasi

Prinsip: **control plane di server, data plane langsung dari browser ke origin kamera**. Proxy `/hls` hanya cadangan (host tanpa CORS, geo-block), jadi dibuat murah.

| Bagian | File | Fungsi |
|---|---|---|
| Logika murni klien | `public/cctv-core.js` | dedupe stream, sanitasi `fb`, urutan langkah playback, scheduler per-host (round-robin) |
| Gateway server | `cctv-gateway.js` | lane `/hls` sendiri (maks 48, 8 per host), cache playlist + segmen, coalescing, tee-stream, rate limit per IP (request + byte), snapshot ffmpeg, laporan kesehatan (kuorum 2 pelapor), RUM |
| Katalog + probe | `server.js` | sumber BPJT/Jogja/Bekasi/Molecool, probe 12 paralel via lane terpisah, deteksi CORS per host (`d:0` = langsung proxy) |

Endpoint: `/hls`, `/api/cctv`, `/api/cctv/snap?u=` (butuh `ffmpeg`, 501 bila tidak ada), `/api/cctv/report`, `/api/cctv/rum` (POST), `/api/cctv/stats` (ttff p50/p95, gagal, stall per host + metrik gateway).

Env: `TRUST_PROXY=1` (otomatis di Railway) agar IP klien dibaca dari `x-forwarded-for`; `SITREP_DATA_DIR` memindahkan folder history (mis. ke volume Railway); `FFMPEG_PATH` bila ffmpeg tidak ada di PATH.

Batas klien (`index.html`): 6 load paralel, 2 per host, 6 live bersamaan (`LIVE_CAP`), sisanya snapshot; slot yang macet >12 dtk dilepas bila host lain antre; sel di luar layar >20 dtk dibongkar (decoder + elemen video).

Skala lanjut (belum diimplementasi, butuh keputusan infrastruktur): pisah proses web/gateway vs worker sosial, katalog + status kesehatan di Redis untuk multi-replica, CDN di depan `/hls`.
