# SITREP — OSINT Console

Dashboard situasi real-time: news wire, monitor sosial (X + Threads), globe & peta insiden (gempa BMKG, gunung api, cuaca, radar, Copernicus Sentinel-2), data pasar, dan live TV/CCTV.

## Stack

- **Backend:** `server.js` — Node.js ≥24, `http` native + `franc` (`6.2.0`)
- **Worker:** `vendor/threads_*.py` — Python 3 + `curl_cffi` (pinned di `requirements.txt`)
- **Frontend:** `public/index.html` — single-file vanilla JS/CSS, tanpa build step

## Menjalankan lokal

```bash
# butuh: node >=24, python3
npm ci
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env   # isi credentials yang diperlukan
node server.js         # atau: bash start.sh
```

Buka `http://localhost:8787` — frontend auto-detect API (same-origin, `?api=`, atau `localhost:8787`).

Secara default di mode lokal, server bind ke **`127.0.0.1` (loopback)** sehingga dashboard lokal langsung berfungsi lewat `<meta name="sitrep-token">` tanpa mengekspos token ke jaringan LAN/WAN. Jangan pernah commit file `.env` atau `.env.*` (kecuali `.env.example`).

## Environment variables

Semua secret dibaca dari env / `.env` (file `.env` dimuat otomatis oleh `server.js`):

| Key | Untuk |
|---|---|
| `TOMTOM_API_KEY` | Routing/lalin di peta |
| `AISSTREAM_API_KEY` | Stream AIS kapal (WebSocket) |
| `NASA_FIRMS_API_KEY` | Hotspot karhutla |
| `FIRECRAWL_API_KEY` | Fallback reader untuk situs anti-bot (Cloudflare) |
| `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET` | Copernicus Data Space Ecosystem (Sentinel-2 L2A, Indonesia ROI, cache 24 jam) |
| `X_AUTH_TOKEN`, `X_CT0` | Cookie sesi X untuk search (mendukung rotasi multi-akun `X_AUTH_TOKEN_2..10`) |
| `X_BEARER`, `X_QUERY_ID` | Opsional — override bearer/query-id X |
| `PORT` / `SERVER_PORT` | Port listen (default `8787`) |
| `SITREP_HOST` | Host bind (default `127.0.0.1` di mode lokal, `0.0.0.0` di mode publik/session) |
| `SITREP_PUBLIC` | `1` = mode dashboard OSINT publik read-only (`viewer`, tanpa login, tanpa token di HTML) |
| `SITREP_USERS` | Daftar akun sesi + RBAC (`user:role:password` atau `scrypt$...`, role `viewer`/`operator`/`admin`) |
| `SITREP_AUTH_SECRET` | Secret HMAC-SHA256 minimal 32 karakter untuk cookie `HttpOnly` `sitrep_sess` |
| `SITREP_TOKEN` | Token gate API (dipakai di mode lokal atau klien headless/operator) |
| `SITREP_TOKEN_ROLE` | Role untuk `SITREP_TOKEN` (`operator` di public deploy, `admin` di mode lokal) |
| `SITREP_TRUST_PROXY` | `1` = percaya `X-Forwarded-For` / `X-Forwarded-Proto` di belakang reverse proxy |
| `SITREP_TRUST_CF` | `1` = prioritaskan `CF-Connecting-IP` di belakang Cloudflare |
| `SITREP_EXTRA_CA` | Path file PEM CA tambahan untuk verifikasi TLS upstream (opsional) |

`config.json` hanya berisi konfigurasi non-secret (port, host CCTV/TV). Topik sosial (X + Threads) ada di `social.js` (`SOC_TOPICS`).

### Variabel tuning lanjutan

Selain tabel di atas, ada knob opsional (semua punya default aman — lihat `.env.example` untuk daftar lengkap): `JINA_API_KEY` (fallback reader), `CUSTOM_PROXY_URL`/`PROXY_URL`, `FFMPEG_PATH`, `CDSE_*` (cap & cache Copernicus), `SITREP_NLP_*` (adapter NLP eksternal, default offline), `SITREP_RSS_CONCURRENCY`/`SITREP_RSS_JITTER_MS`, `SITREP_DOC_CACHE_BYTES`, blok `SITREP_HLS_*` (gateway CCTV), `SITREP_MAC_PROFILE`, `SITREP_NO_WESERV`, `SITREP_NO_SUPERVISOR`, `SITREP_DISABLE_QUERY_TOKEN`, `SITREP_ALLOW_LAN_TOKEN` (opt-in berbahaya — mengizinkan bind non-loopback di mode token lokal).

## Mode Keamanan & Deployment

SITREP memiliki tiga mode autentikasi fail-closed (detail di [`SECURITY.md`](SECURITY.md)):

1. **Mode Token Lokal (default lokal):**
   - Aktif bila `SITREP_PUBLIC` dan `SITREP_USERS` kosong.
   - Server otomatis bind ke `127.0.0.1` dan menyisipkan `<meta name="sitrep-token">` ke `GET /`.
   - **Startup Guard:** server menolak jalan (`exit 78`) bila dipaksa bind ke alamat non-loopback (mis. `SITREP_HOST=0.0.0.0`) tanpa `SITREP_PUBLIC=1`, tanpa `SITREP_USERS`, atau tanpa opt-in eksplisit `SITREP_ALLOW_LAN_TOKEN=1`.
2. **Mode Dashboard Publik OSINT (`SITREP_PUBLIC=1`):**
   - Cocok untuk deployment publik read-only (Railway/Render/VPS di belakang reverse proxy).
   - Pengunjung anonim mendapat role `viewer` dan **tidak ada token API yang disisipkan ke HTML**.
   - Akses operator/otomasi (`?fresh=1`, `/api/metrics`) memakai header `x-sitrep-token` dengan `SITREP_TOKEN`.
3. **Mode Sesi Multi-User (`SITREP_USERS` + `SITREP_AUTH_SECRET`):**
   - Cocok untuk deployment privat/tim yang mewajibkan login.
   - Menggunakan password `scrypt`, cookie `HttpOnly` `sitrep_sess`, RBAC, dan verifikasi CSRF same-origin.

Untuk panggilan lintas-origin atau CLI (`curl`, `scripts/audit-reader.js`), kirim header `x-sitrep-token: <TOKEN>` atau parameter `?token=<TOKEN>` (hanya aktif di mode lokal kecuali `SITREP_DISABLE_QUERY_TOKEN=1`).

## Struktur

```text
server.js              API + scraping + proxy + WS + startup auth guard
security.js            SSRF guard, DNS-pinned HTTP/TLS client, AIA repair, RBAC, rate-limit
copernicus.js          Proxy tile Sentinel-2 L2A (CDSE) + kuota atomik & disk cache
cctv-gateway.js        Gateway /hls, cache segmen, coalescing & RUM
public/index.html      UI utama (CSS + JS vanilla)
vendor/                Worker scraper Python (lihat vendor/THREADS-SCRAPER-LICENSE)
geo/                   Gazetteer & indeks wilayah Indonesia
start.sh               Bootstrap venv + supervisor restart loop
```

## Deploy

Butuh host dengan proses persisten + filesystem writable + outbound WebSocket (VPS `systemd`/`pm2`, Railway/Render disk persisten, atau Docker).

```bash
# Contoh Docker publik read-only di balik reverse proxy:
docker build -t sitrep .
docker run -d --name sitrep -p 8787:8787 \
  -e SITREP_PUBLIC=1 \
  -e SITREP_TRUST_PROXY=1 \
  --env-file .env \
  -v sitrep-data:/app/data \
  sitrep
```

Untuk deployment di balik reverse proxy/Cloudflare Tunnel, set `SITREP_TRUST_PROXY=1` (dan `SITREP_TRUST_CF=1` jika di balik Cloudflare).

Volume `-v sitrep-data:/app/data` menjaga history berita/insiden, cache Copernicus, dan data pasar tetap ada saat container di-recreate — tanpa volume itu semua state hilang.

`config.json` hanya untuk konfigurasi **non-secret** (port, host CCTV/TV, tuning). Credential (cookie X/Threads, API key, client secret) **wajib** lewat env/`.env` — server menolak membaca secret dari `config.json` dan akan mencetak peringatan bila field secret terisi.

## Pengujian & Audit

```bash
npm test                      # jalankan seluruh test suite (tests/*.js)
node scripts/audit-reader.js  # audit reader: [maxPerSource] [baseUrl]
```

## Lisensi & Atribusi

Kode SITREP dilisensikan di bawah [`LICENSE`](LICENSE) (MIT). Komponen vendor, library, dan dataset pihak ketiga tunduk pada ketentuannya masing-masing yang tercantum di [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
