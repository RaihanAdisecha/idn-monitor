"""Scrape public Threads profiles, posts, replies and search with Python. No login, one file."""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote, urlencode, urlparse

from curl_cffi import requests

BASE = "https://www.threads.com"
APP_ID = "238260118697367"  # the public id Threads' own web app sends
# The id of the web app's "profile posts" query. It changes now and then; when
# `posts` stops paging past the first few posts, grab the new id from the web app.
DOC_PROFILE_POSTS = "26400202666284393"
PAGE_SIZE = 20
# Feature switches the web app sends with the profile posts query. Threads
# rejects the query unless every one is present; the logged-out values are fixed.
FLAGS_ON = (
    "BarcelonaHasGhostPostNullStateStringrelayprovider",
    "BarcelonaHasDearAlgoConsumptionrelayprovider",
    "BarcelonaHasPodcastConsumptionrelayprovider",
    "BarcelonaHasCommunitiesrelayprovider",
    "IsTagIndicatorEnabledrelayprovider",
    "BarcelonaHasGhostPostConsumptionrelayprovider",
    "BarcelonaOptionalCookiesEnabledrelayprovider",
    "BarcelonaQuotedPostUFIEnabledrelayprovider",
    "BarcelonaHasTopicTagsrelayprovider",
)
FLAGS_OFF = (
    "BarcelonaIsLoggedInrelayprovider",
    "BarcelonaHasProfileSelfReplyContextrelayprovider",
    "BarcelonaIsReplyApprovalEnabledrelayprovider",
    "BarcelonaHasEventBadgerelayprovider",
    "BarcelonaIsReplyApprovalsConsumptionEnabledrelayprovider",
    "BarcelonaIsSearchDiscoveryEnabledrelayprovider",
    "BarcelonaHasGameScoreSharerelayprovider",
    "BarcelonaHasMusicrelayprovider",
    "BarcelonaHasSelfThreadCountrelayprovider",
    "BarcelonaHasDeepDiverelayprovider",
    "BarcelonaHasSpoilerStylingInforelayprovider",
    "BarcelonaHasGhostPostEmojiActivationrelayprovider",
    "BarcelonaHasDearAlgoWebProductionrelayprovider",
    "BarcelonaIsCrawlerrelayprovider",
    "BarcelonaHasDisplayNamesrelayprovider",
    "BarcelonaHasCommunityTopContributorsrelayprovider",
    "BarcelonaCanSeeSponsoredContentrelayprovider",
    "BarcelonaShouldShowFediverseM075Featuresrelayprovider",
    "BarcelonaImplicitTrendsGKrelayprovider",
    "BarcelonaIsInternalUserrelayprovider",
)

JSON_SCRIPT = re.compile(r'<script\b[^>]*type="application/json"[^>]*>(.*?)</script>', re.DOTALL)
MEDIA_TYPES = {1: "image", 2: "video", 8: "carousel", 19: "text"}


class ScrapeError(Exception):
    pass


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def walk(node):
    """Yield every dict inside a parsed JSON tree, parents first."""
    if isinstance(node, dict):
        yield node
        node = list(node.values())
    if isinstance(node, list):
        for value in node:
            yield from walk(value)


def page_blobs(html):
    """The page carries its data as JSON in <script type="application/json"> tags."""
    blobs = []
    for raw in JSON_SCRIPT.findall(html):
        try:
            blobs.append(json.loads(raw))
        except ValueError:
            continue
    return blobs


def username_of(value):
    value = value.strip()
    if "/@" in value:
        value = value.split("/@", 1)[1].split("/", 1)[0]
    return value.lstrip("@").strip("/")


def post_path_of(value):
    """Turn a post URL into /@user/post/CODE."""
    parts = [p for p in urlparse(value.strip()).path.split("/") if p]
    if len(parts) < 3 or not parts[0].startswith("@") or parts[1] != "post":
        raise ScrapeError(f"Not a Threads post URL: {value} (expected https://www.threads.com/@user/post/CODE)")
    return "/" + "/".join(parts[:3])


def clean_post(p):
    info = p.get("text_post_app_info") or {}
    user = p.get("user") or {}
    fragments = (info.get("text_fragments") or {}).get("fragments") or []
    links = [f["link_fragment"]["uri"] for f in fragments if f.get("link_fragment") and f["link_fragment"].get("uri")]
    preview = info.get("link_preview_attachment") or {}
    if preview.get("url") and preview["url"] not in links:
        links.append(preview["url"])
    media = []
    # A carousel keeps its items in carousel_media. Text posts carry no media.
    for item in [] if p.get("media_type") == 19 else p.get("carousel_media") or [p]:
        videos = item.get("video_versions") or []
        images = (item.get("image_versions2") or {}).get("candidates") or []
        if videos:
            media.append({"type": "video", "url": videos[0].get("url")})
        elif images:
            media.append({"type": "image", "url": images[0].get("url")})
    text = (p.get("caption") or {}).get("text")
    if text is None:
        text = "".join(f.get("plaintext") or "" for f in fragments) or None
    return {
        "id": str(p.get("pk")),
        "code": p.get("code"),
        "url": f"{BASE}/@{user.get('username')}/post/{p.get('code')}",
        "text": text,
        "created_at": iso(p.get("taken_at")),
        "username": user.get("username"),
        "full_name": user.get("full_name"),
        "avatar": user.get("profile_pic_url") or (user.get("hd_profile_pic_url_info") or {}).get("url"),
        "is_verified": user.get("is_verified"),
        "like_count": p.get("like_count"),
        "reply_count": info.get("direct_reply_count"),
        "repost_count": info.get("repost_count"),
        "quote_count": info.get("quote_count"),
        "is_reply": bool(info.get("is_reply")),
        "reply_to_username": (info.get("reply_to_author") or {}).get("username"),
        "reply_level": info.get("reply_level") or 0,
        "type": MEDIA_TYPES.get(p.get("media_type"), p.get("media_type")),
        "media": media,
        "links": links,
    }


class Threads:
    def __init__(self, proxy=None, cookies=None):
        # One Chrome-like session: the first page sets the cookies the later queries need.
        self.http = requests.Session(impersonate="chrome", proxies={"http": proxy, "https": proxy} if proxy else None)
        # Hybrid auth: cookies opsional (mis. {"sessionid": "...", "csrftoken": "..."}).
        # Logged-in → flag IsLoggedIn ON, header logged-out dimatikan, pagination
        # search/profil ikut jatah akun, bukan anon ~20 hasil.
        self.auth = False
        if cookies:
            for k, v in cookies.items():
                if v:
                    self.http.cookies.set(str(k), str(v), domain=".threads.com")
            self.auth = bool(self.http.cookies.get("sessionid"))

    def _send(self, method, url, **kwargs):
        try:
            resp = self.http.request(method, url, timeout=30, allow_redirects=False, **kwargs)
        except requests.RequestsError as exc:
            raise ScrapeError(f"Network error: {exc}") from exc
        where = resp.headers.get("location") or ""
        # Threads sends missing users and posts to its login page or home page with an error.
        # The same redirect shows up when it rate-limits an IP, so the message names both.
        if resp.status_code in (301, 302) and ("/login" in where or "error=" in where):
            raise ScrapeError(
                f"Not found: {url}. If it does exist, Threads redirected to login/error; "
                "try again, use a home connection or --proxy."
            )
        if resp.status_code in (301, 302):
            raise ScrapeError(f"Threads redirected HTTP {resp.status_code} for {url} -> {where}")
        if resp.status_code in (401, 403, 429):
            raise ScrapeError(
                f"Threads answered HTTP {resp.status_code}: rate-limited or blocked. "
                "Cloud and datacenter IPs are blocked most; try a home connection or --proxy."
            )
        if resp.status_code == 404:
            raise ScrapeError("Not found.")
        if resp.status_code != 200:
            raise ScrapeError(f"Unexpected HTTP {resp.status_code} from Threads.")
        return resp

    def page(self, path):
        """Fetch a page and return its embedded JSON blobs."""
        headers = {"accept": "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.9"}
        html = self._send("GET", BASE + path, headers=headers).text
        if "Barcelona404ErrorRoot" in html:
            raise ScrapeError(f"Not found: {BASE + path}")
        blobs = page_blobs(html)
        if not blobs:
            raise ScrapeError("The page had no data. Threads may have changed its pages, or this IP is blocked.")
        return blobs

    # --- profile and posts -------------------------------------------------

    def _user_page(self, username):
        blobs = self.page(f"/@{quote(username)}")
        for node in walk(blobs):
            if str(node.get("username", "")).lower() == username.lower() and "follower_count" in node:
                return node, blobs
        raise ScrapeError(f"No profile data on the page for {username}. The user may not exist.")

    def profile(self, username):
        user, _ = self._user_page(username)
        pics = user.get("hd_profile_pic_versions") or []
        return {
            "id": str(user.get("pk") or user.get("id")),
            "username": user.get("username"),
            "url": f"{BASE}/@{user.get('username')}",
            "full_name": user.get("full_name"),
            "biography": user.get("biography"),
            "bio_links": [link.get("url") for link in user.get("bio_links") or [] if link.get("url")],
            "followers_count": user.get("follower_count"),
            "is_verified": user.get("is_verified"),
            "is_private": user.get("text_post_app_is_private"),
            "profile_pic_url": pics[-1].get("url") if pics else user.get("profile_pic_url"),
        }

    def posts(self, username, limit=20):
        user, blobs = self._user_page(username)
        feed = next((n for n in walk(blobs) if isinstance(n.get("edges"), list) and isinstance(n.get("page_info"), dict)
                     and any("thread_items" in (e.get("node") or {}) for e in n["edges"])), None)
        if feed is None:
            raise ScrapeError(f"No posts on the page for {username}. The account may be private or have no posts.")
        out = []
        while True:
            for edge in feed["edges"]:
                for item in edge["node"].get("thread_items") or []:
                    if item.get("post"):
                        out.append(clean_post(item["post"]))
            info = feed.get("page_info") or {}
            if len(out) >= limit or not info.get("has_next_page") or not info.get("end_cursor"):
                break
            try:
                feed = self._more_posts(str(user.get("pk") or user.get("id")), info["end_cursor"])
            except ScrapeError:
                break
        return out[:limit]

    def _more_posts(self, user_id, cursor):
        """The web app's own query for the next page of a profile's posts."""
        variables = {
            "userID": user_id, "after": cursor, "before": None, "first": PAGE_SIZE, "last": None,
            "allow_page_info_for_lox_user": True, "skipGhostPosts": False,
        }
        variables.update({f"__relay_internal__pv__{name}": True for name in FLAGS_ON})
        flags_off = [f for f in FLAGS_OFF if f != "BarcelonaIsLoggedInrelayprovider" or not self.auth]
        variables.update({f"__relay_internal__pv__{name}": False for name in flags_off})
        if self.auth:
            variables["__relay_internal__pv__BarcelonaIsLoggedInrelayprovider"] = True
        body = {"server_timestamps": "true", "doc_id": DOC_PROFILE_POSTS, "variables": json.dumps(variables, separators=(",", ":"))}
        headers = {
            "content-type": "application/x-www-form-urlencoded",
            "origin": BASE, "referer": BASE + "/",
            "x-ig-app-id": APP_ID,
            "x-csrftoken": self.http.cookies.get("csrftoken") or "",  # must match the cookie
            "x-root-field-name": "xdt_api__v1__text_feed__user_id__profile__connection",
        }
        # Tanpa header ini Threads bilang "User not found" untuk user asli —
        # khusus mode logged-out; saat auth pakai session jangan dikirim.
        if not self.auth:
            headers["x-logged-out-threads-migrated-request"] = "true"
        data = self._send("POST", BASE + "/graphql/query", data=urlencode(body), headers=headers).json()
        feed = (data.get("data") or {}).get("mediaData")
        if not feed:
            raise ScrapeError(f"Threads returned no more posts: {str(data.get('errors'))[:200]}")
        return feed

    # --- one post ----------------------------------------------------------

    def post(self, url):
        path = post_path_of(url)
        code = path.rsplit("/", 1)[1]
        blobs = self.page(path)
        post = next((n for n in walk(blobs) if n.get("code") == code and n.get("user") and n.get("taken_at")), None)
        if post is None:
            raise ScrapeError(f"Post not found or not public: {url}")
        result = clean_post(post)
        # Replies sit in a second record with the same id as the post. The "related
        # posts" elsewhere on the page are recommendations, not replies.
        post_key = post.get("pk") or post.get("id")
        host = next((n for n in walk(blobs) if post_key and (n.get("pk") or n.get("id")) == post_key and (n.get("text_post_app_info") or {}).get("direct_replies")), None)
        replies = (((host or {}).get("text_post_app_info") or {}).get("direct_replies") or {}).get("edges") or []
        result["replies"] = [
            clean_post(r["node"])
            for edge in replies
            for r in ((edge.get("node") or {}).get("posts") or {}).get("edges") or []
            if r.get("node")
        ]
        return result

    # --- search ------------------------------------------------------------

    def search(self, keyword, limit=20):
        """Threads shows about 20 results to logged-out visitors and no second page."""
        blobs = self.page(f"/search?{urlencode({'q': keyword, 'serp_type': 'default'})}")
        results = next((n for n in walk(blobs) if isinstance(n.get("edges"), list)
                        and any(isinstance((e.get("node") or {}).get("thread"), dict) for e in n["edges"])), None)
        if results is None:
            return []
        out = []
        for edge in results["edges"]:
            for item in edge["node"]["thread"].get("thread_items") or []:
                if item.get("post"):
                    out.append(clean_post(item["post"]))
        return out[:limit]


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY"), help="proxy URL, e.g. http://user:pass@host:port")
    common.add_argument("-o", "--output", help="write JSON to this file")
    parser = argparse.ArgumentParser(description="Scrape public Threads data. No login.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("profile", parents=[common], help="public profile").add_argument("usernames", nargs="+")
    p = sub.add_parser("posts", parents=[common], help="a profile's latest posts")
    p.add_argument("username")
    p.add_argument("--limit", type=int, default=20)
    sub.add_parser("post", parents=[common], help="one post with its replies").add_argument("posts", nargs="+", help="post URL")
    p = sub.add_parser("search", parents=[common], help="posts for a keyword")
    p.add_argument("keyword")
    p.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    try:
        threads = Threads(args.proxy)
        if args.command == "profile":
            data = [threads.profile(username_of(u)) for u in args.usernames]
        elif args.command == "posts":
            data = threads.posts(username_of(args.username), args.limit)
        elif args.command == "post":
            data = [threads.post(u) for u in args.posts]
        else:
            data = threads.search(args.keyword, args.limit)
    except ScrapeError as exc:
        sys.exit(f"Error: {exc}")

    if args.command in ("profile", "post") and len(data) == 1:
        data = data[0]
    text = json.dumps(data, indent=2, ensure_ascii=False)
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(text + "\n")
        except OSError as exc:
            sys.exit(f"Error: cannot write {args.output}: {exc.strerror}")
        print(f"Saved to {args.output}")
    else:
        print(text)


if __name__ == "__main__":
    main()
