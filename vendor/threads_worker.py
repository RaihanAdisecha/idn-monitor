"""Batch Threads search worker for the SITREP server.

Uses toolzerhub/threads-scraper (MIT) as a library. Reads a JSON array of
queries from argv[1], returns one JSON object on stdout.
"""
import json
import sys

from threads_scraper import ScrapeError, Threads


def main():
    queries = json.loads(sys.argv[1]) if len(sys.argv) > 1 else []
    client = Threads()
    posts, seen, errs = [], set(), []
    for q in queries:
        try:
            found = client.search(q, limit=20)
        except ScrapeError as exc:
            errs.append({"q": q, "err": str(exc)})
            continue
        except Exception as exc:  # noqa: BLE001 - surface any transport failure
            errs.append({"q": q, "err": "%s: %s" % (type(exc).__name__, exc)})
            continue
        for p in found:
            code = p.get("code")
            if not code or code in seen:
                continue
            seen.add(code)
            p["q"] = q
            posts.append(p)
    posts.sort(key=lambda p: p.get("created_at") or "", reverse=True)
    json.dump({"ok": True, "posts": posts[:48], "errs": errs}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
