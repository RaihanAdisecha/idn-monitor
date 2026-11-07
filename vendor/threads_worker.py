"""Batch Threads search worker for the SITREP server.

Uses toolzerhub/threads-scraper (MIT) as a library. argv[1] is a JSON object:
  {"searches": ["query", ...], "profiles": ["user", ...]}
(an old-style JSON array is treated as searches-only). Returns one JSON
object on stdout. Requests are paced — Threads 429s datacenter IPs fast.
"""
import json
import sys
import time

from threads_scraper import ScrapeError, Threads

PACE = 0.8  # detik antar request; worker jalan paralel per chunk


def main():
    spec = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    if isinstance(spec, dict):
        queries = spec.get("searches") or []
        profiles = spec.get("profiles") or []
    else:
        queries, profiles = spec, []
    client = Threads()
    posts, seen, errs = [], set(), []

    def add(p, q):
        code = p.get("code")
        if not code or code in seen:
            return
        seen.add(code)
        p["q"] = q
        posts.append(p)

    for q in queries:
        try:
            found = client.search(q, limit=20)
        except ScrapeError as exc:
            errs.append({"q": q, "err": str(exc)})
        except Exception as exc:  # noqa: BLE001 - surface any transport failure
            errs.append({"q": q, "err": "%s: %s" % (type(exc).__name__, exc)})
        else:
            for p in found:
                add(p, q)
        time.sleep(PACE)

    for u in profiles:
        try:
            found = client.posts(u, 20)
        except ScrapeError as exc:
            errs.append({"q": "@" + u, "err": str(exc)})
        except Exception as exc:  # noqa: BLE001
            errs.append({"q": "@" + u, "err": "%s: %s" % (type(exc).__name__, exc)})
        else:
            for p in found:
                add(p, "@" + u)
        time.sleep(PACE)

    posts.sort(key=lambda p: p.get("created_at") or "", reverse=True)
    json.dump({"ok": True, "posts": posts, "errs": errs}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
