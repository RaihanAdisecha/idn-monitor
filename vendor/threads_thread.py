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
        level = node.get("reply_level") or 1
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
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    url = req.get("url")
    if not url:
        json.dump({"ok": False, "err": "url kosong"}, sys.stdout)
        return
    try:
        root = Threads().post(url)
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "err": "%s: %s" % (type(exc).__name__, exc)}, sys.stdout)
        return

    flat = (root.get("replies") or [])[:40]
    root["replies"] = build_tree(flat)
    json.dump({"ok": True, "kind": "threads", "post": root,
               "count": root.get("reply_count") or len(flat)},
              sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
