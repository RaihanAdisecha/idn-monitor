# Contributing to SITREP

Thanks for your interest. SITREP is a real-time OSINT console — correctness of incident data and security of the proxy surface matter more than feature velocity.

## Setup

```bash
npm ci
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env   # isi hanya yang kamu butuhkan
node server.js         # http://localhost:8787
```

Requirements: Node.js >= 24, Python 3.10+.

## Rules

- **Never commit secrets.** Credentials go in `.env` / environment variables only. `config.json` is for non-secret config (hosts, port, tuning) — the server warns at boot if it detects credential-looking fields. `data/`, `*.log`, `fxhist.json` are runtime state and gitignored.
- **No new runtime dependencies without justification.** The backend is intentionally dependency-light (`franc` only). Prefer `node:` builtins.
- **Preserve API compatibility.** Frontend, tests, and scripts consume `/api/*` — don't change response shapes without updating all consumers.
- **All outbound fetches must go through `SEC.safeFetch`** (or `mediaGet`/`rdSafeGet` wrappers) so SSRF/DNS-pinning/TLS verification stay intact. Raw `fetch`/`http.get` to arbitrary URLs is not acceptable.
- **Untrusted content must be escaped** before reaching `innerHTML`/attribute sinks in `public/`.

## Testing

```bash
npm test                                  # full suite (node --test tests/*.js)
node --check server.js                    # syntax
python3 -m py_compile vendor/*.py         # worker syntax
```

Every security fix needs a regression test. Tests must use synthetic fixtures and mock servers — never real credentials or live third-party accounts. A skipped test must be reported as skipped, not passed.

## Pull requests

- Keep changes focused; small reviewable diffs beat big rewrites.
- `server.js` and `public/index.html` are large monoliths — extract modules only when it improves security/testability, not for aesthetics.
- CI must stay green: tests on Node 24 & 26, gitleaks history scan, `npm audit`, `pip-audit`.
- Do not weaken or bypass security controls (rate limits, SSRF guards, auth gates, TLS verification) to make tests pass.

## Reporting vulnerabilities

See [SECURITY.md](SECURITY.md) — do not open public issues for security reports.
