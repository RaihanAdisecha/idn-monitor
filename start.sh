#!/usr/bin/env bash
# SITREP boot: siapkan venv python (bila ada) lalu jalankan server node.
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1 && [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv 2>/dev/null && {
    .venv/bin/pip install --quiet --upgrade pip 2>/dev/null
    .venv/bin/pip install --quiet curl_cffi 2>/dev/null
  } || echo "[start] venv python gagal — Threads nonaktif, server tetap jalan"
fi

mkdir -p data
exec node server.js
