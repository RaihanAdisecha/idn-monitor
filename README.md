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
| `SITREP_TOKEN` | Token gate API; kosong → token acak per-boot (lihat **Token API**) |
| `SITREP_INSECURE_TLS` | `1` = matikan validasi TLS (hanya debugging, jangan di produksi) |

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

## Pengujian & audit

```bash
npm test                      # jalankan test suite Node
node scripts/audit-reader.js  # audit noise reader: [maxPerSource] [baseUrl]
```

Kalau skrip `test` belum terdaftar di `package.json`, pakai `npm run test:signals` (regresi sinyal & signal-engine). `audit-reader.js` default `maxPerSource=2` / `baseUrl=http://localhost:8787`, hasil ditulis ke `scripts/audit-output.json`.

## Catatan

- X scraping memakai cookie akun sendiri — rotasi `auth_token`/`ct0` berkala.
- Endpoint `/img`, `/api/read`, proxy endpoints memblokir host privat (SSRF guard). `/img`, `/hls`, `/vhs` juga melewati gate token (lihat **Token API**).
- Validasi TLS **tidak lagi** diatur lewat `config.json` — flag `"insecure_tls"` di `config.json` kini **diabaikan** `server.js`. Untuk mematikannya wajib set env **`SITREP_INSECURE_TLS=1`** secara eksplisit (hanya debugging, jangan di produksi).
