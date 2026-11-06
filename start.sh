#!/usr/bin/env bash
# SITREP boot: siapkan venv python (sekali) lalu jalankan server node.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet curl_cffi
fi

mkdir -p data
exec node server.js
