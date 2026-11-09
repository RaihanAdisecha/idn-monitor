"""Threads thread worker for the SITREP server.

Reads {"url": "..."} from argv[1], returns one JSON object on stdout with the
root post and its conversation. The public Threads page already ships the whole
reply batch flat, each reply tagged with reply_level and reply_to_username, so
the tree is rebuilt here instead of hammering one page per reply.
"""
import json
import sys

from threads_scraper import Threads


def build_tree(flat):
    """Attach each reply to the nearest earlier reply it answers."""
    roots, seen = [], []
    for raw in flat:
        node = dict(raw)
        node["replies"] = []
        raw_level = node.get("reply_level")
        level = raw_level if isinstance(raw_level, int) and raw_level >= 1 else 1
        node["reply_level"] = level
        parent = None
        if level > 1:
            who = node.get("reply_to_username")
            for prev in reversed(seen):
                if (prev.get("reply_level") or 1) < level and prev.get("username") == who:
                    parent = prev
                    break
        (parent["replies"] if parent else roots).append(node)
        seen.append(node)
    return roots


def main():
    try:
        req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    except Exception:  # noqa: BLE001
        req = {}
    if not isinstance(req, dict):
        req = {}
    url = req.get("url")
    if not url:
        json.dump({"ok": False, "err": "url kosong"}, sys.stdout)
        return
    auth = req.get("auth") if isinstance(req.get("auth"), dict) else None
    proxy = req.get("proxy") if isinstance(req.get("proxy"), str) else None
    try:
        root = Threads(proxy=proxy, cookies=auth).post(url)
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "err": "%s: %s" % (type(exc).__name__, exc)}, sys.stdout)
        return

    flat = (root.get("replies") or [])[:40]
    tree = build_tree(flat)
    root["replies"] = tree
    json.dump({"ok": True, "kind": "threads", "post": root, "replies": tree,
               "count": root.get("reply_count") if root.get("reply_count") is not None else len(flat)},
              sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
