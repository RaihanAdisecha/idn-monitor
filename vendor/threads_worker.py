"""Batch Threads search worker for the SITREP server.

Uses toolzerhub/threads-scraper (MIT) as a library. argv[1] is a JSON object:
  {"searches": ["query", ...], "profiles": ["user", ...]}
(an old-style JSON array is treated as searches-only). Returns one JSON
object on stdout. Requests are paced — Threads 429s datacenter IPs fast.

On fatal error the worker still dumps whatever it collected, with the
failure recorded in "errs" — a crash must not lose the whole batch.
"""
import json
import re
import sys
import time

from threads_scraper import ScrapeError, Threads

PACE = 0.8          # detik antar request; worker jalan paralel per chunk
MAX_CONSEC_RL = 3   # 429/403 beruntun -> anggap IP diblokir, hentikan sisa kerja
RATE_LIMIT_RE = re.compile(r"HTTP (?:429|403)|rate.?limit", re.I)


def as_str_list(v):
    """searches/profiles boleh string tunggal; selain list/string -> []."""
    if isinstance(v, str):
        return [v]
    if isinstance(v, (list, tuple)):
        return [x for x in v if isinstance(x, str) and x]
    return []


def main():
    try:
        spec = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    except Exception:  # noqa: BLE001 - spec rusak = batch kosong, tetap emit JSON
        spec = []
    if isinstance(spec, dict):
        queries = as_str_list(spec.get("searches"))
        profiles = as_str_list(spec.get("profiles"))
        auth = spec.get("auth") if isinstance(spec.get("auth"), dict) else None
    else:
        queries, profiles, auth = as_str_list(spec), [], None

    posts, seen, errs = [], set(), []
    halt = False       # rate-limit parah: lewati sisa queries DAN profiles
    consec_rl = 0      # kegagalan 429/403 beruntun

    try:
        # Dual-mode: search SELALU logged-out — SERP logged-in di-render lazy
        # via GraphQL dan HTML-nya cuma embed ~1 hasil (terbukti: auth "banjir"
        # = 1 post vs logged-out = 20). Profil tetap pakai auth: paginasi
        # GraphQL butuh session (walau logged-out kebetulan masih jalan,
        # auth lebih stabil & dapat jatah akun, bukan anon).
        search_client = Threads()
        profile_client = Threads(cookies=auth) if auth else search_client

        def add(p, q):
            if not isinstance(p, dict):
                return
            code = p.get("code")
            if not code or code in seen:
                return
            seen.add(code)
            p["q"] = q
            posts.append(p)

        def note_rl(exc):
            """True bila error adalah throttle/block; hitung beruntun & backoff.
            Deteksi dari PESAN, bukan kelas: 429/403 juga bisa dilempar sbg
            transport exception generik, bukan cuma ScrapeError. Dipanggil tepat
            sekali per kegagalan (tiap except hanya menangani satu exception)."""
            nonlocal consec_rl, halt
            if not RATE_LIMIT_RE.search(str(exc)):
                consec_rl = 0
                return False
            consec_rl += 1
            if consec_rl >= MAX_CONSEC_RL:
                halt = True
            else:
                time.sleep(min(60.0, PACE * (2 ** consec_rl)))  # backoff eksponensial
            return True

        for i, q in enumerate(queries):
            if halt:
                # sisa query diskip karena rate-limit: laporkan supaya server
                # tidak menganggap topiknya sudah ter-fetch
                for q2 in queries[i:]:
                    errs.append({"q": q2, "err": "skipped: rate-limit"})
                break
            try:
                found = search_client.search(q, limit=20)
            except ScrapeError as exc:
                errs.append({"q": q, "err": str(exc)})
                if note_rl(exc):
                    continue
            except Exception as exc:  # noqa: BLE001 - surface any transport failure
                errs.append({"q": q, "err": "%s: %s" % (type(exc).__name__, exc)})
                if note_rl(exc):
                    continue
            else:
                consec_rl = 0
                try:
                    for p in found:
                        add(p, q)
                except Exception as exc:  # noqa: BLE001 - satu item rusak jangan gagalkan batch
                    errs.append({"q": q, "err": "item: %s: %s" % (type(exc).__name__, exc)})
            time.sleep(PACE)

        for i, u in enumerate(profiles):
            if halt:
                for u2 in profiles[i:]:
                    errs.append({"q": "@" + u2, "err": "skipped: rate-limit"})
                break
            try:
                found = profile_client.posts(u, 80)   # posts() punya paginasi — 80 post/profil per siklus
            except ScrapeError as exc:
                errs.append({"q": "@" + u, "err": str(exc)})
                if note_rl(exc):
                    continue
            except Exception as exc:  # noqa: BLE001
                errs.append({"q": "@" + u, "err": "%s: %s" % (type(exc).__name__, exc)})
                if note_rl(exc):
                    continue
            else:
                consec_rl = 0
                try:
                    for p in found:
                        add(p, "@" + u)
                except Exception as exc:  # noqa: BLE001
                    errs.append({"q": "@" + u, "err": "item: %s: %s" % (type(exc).__name__, exc)})
            time.sleep(PACE)
    except Exception as exc:  # noqa: BLE001 - fatal: tetap dump hasil parsial
        errs.append({"q": "*", "err": "fatal: %s: %s" % (type(exc).__name__, exc)})

    posts.sort(key=lambda p: str(p.get("created_at") or ""), reverse=True)
    json.dump({"ok": True, "posts": posts, "errs": errs}, sys.stdout, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
