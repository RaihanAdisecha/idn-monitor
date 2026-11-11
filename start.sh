#!/usr/bin/env bash
# SITREP boot: siapkan venv python (bila ada) lalu jalankan server node dengan supervisor restart.
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1 && [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv 2>/dev/null && {
    .venv/bin/pip install --quiet --upgrade pip 2>/dev/null
    .venv/bin/pip install --quiet curl_cffi 2>/dev/null
  } || echo "[start] venv python gagal — Threads nonaktif, server tetap jalan"
fi

mkdir -p data
export UV_THREADPOOL_SIZE=16
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"

if command -v caffeinate >/dev/null 2>&1 && { [ "${SITREP_PUBLIC:-0}" = "1" ] || [ "${SITREP_KEEP_AWAKE:-0}" = "1" ]; }; then
  caffeinate -is -w $$ >/dev/null 2>&1 &
fi

if [ "${SITREP_NO_SUPERVISOR:-0}" = "1" ]; then
  exec node server.js
fi

STOP=0
CHILD_PID=""

forward_signal() {
  STOP=1
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -"$1" "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  exit 0
}

trap '' HUP
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

backoff=1
while [ "$STOP" -eq 0 ]; do
  started_at=$(date +%s)
  node server.js &
  CHILD_PID=$!
  wait "$CHILD_PID"
  rc=$?
  CHILD_PID=""

  if [ "$STOP" -eq 1 ]; then
    exit 0
  fi

  # Exit normal (0) atau error konfigurasi permanen seperti port terpakai (78) tidak di-restart
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 78 ]; then
    exit "$rc"
  fi

  uptime=$(( $(date +%s) - started_at ))
  if [ "$uptime" -ge 60 ]; then
    backoff=1
  fi

  echo "[supervisor] server mati dengan kode $rc setelah ${uptime}s; restart dalam ${backoff}s..." >&2
  sleep "$backoff" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true
  SLEEP_PID=""

  if [ "$backoff" -lt 30 ]; then
    backoff=$(( backoff * 2 ))
    if [ "$backoff" -gt 30 ]; then backoff=30; fi
  fi
done
