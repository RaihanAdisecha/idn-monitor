# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories (or directly to the repository maintainer) rather than opening a public issue with exploit details. Include steps to reproduce, affected deployment mode (`local-token`, `public-osint`, or `session-auth`), and impact.

## Deployment Security Model

SITREP supports three distinct operating modes enforced in `security.js` and `server.js`:

1. **Local Loopback Mode (default when `SITREP_PUBLIC` and `SITREP_USERS` are unset):**
   - Binds to `127.0.0.1` (loopback only) by default.
   - Injects a per-boot (or configured `SITREP_TOKEN`) `<meta name="sitrep-token">` into `GET /` so the local browser console works without manual login.
   - **Startup Guard (Fail-Closed):** Refuses to bind to non-loopback addresses (`0.0.0.0`, LAN/WAN IPs) in local-token mode (exits with code `78`) unless `SITREP_ALLOW_LAN_TOKEN=1` is explicitly set.

2. **Public OSINT Read-Only Mode (`SITREP_PUBLIC=1`, auto-enabled on Railway/Render/Fly/etc.):**
   - Unauthenticated visitors receive role `viewer` and **no API token is ever injected into HTML**.
   - Sensitive operator controls (`?fresh=1`, `/api/metrics`, unallowlisted upstream fetches) require an explicit `SITREP_TOKEN` via `x-sitrep-token` header (`SITREP_TOKEN_ROLE=operator` by default in public mode).

3. **Private Session Mode (`SITREP_USERS` + `SITREP_AUTH_SECRET` >= 32 chars):**
   - Requires login with `scrypt`-hashed passwords, `HttpOnly` HMAC-SHA256 `sitrep_sess` cookies, strict RBAC (`viewer` / `operator` / `admin`), revocation tracking, and same-origin CSRF checks on mutating requests.

## Outbound SSRF & TLS Guarantees

- **SSRF & DNS Rebinding Protection (`security.js`):** Outbound fetches on `/img`, `/hls`, `/vhs`, and `/api/read` validate hostnames/schemes, block private/loopback/link-local/metadata IP ranges, and pin the validated IP directly onto the outbound socket. Sensitive auth headers are stripped across cross-origin redirects.
- **TLS Verification (`probePeerChain` vs `singlePinnedRequest`):** `probePeerChain()` opens a metadata-only TLS handshake (`zero` HTTP bytes transmitted) solely to read leaf certificates and AIA CA Issuers URIs when an upstream server omits intermediate certificates. Any repaired chain is strictly verified (signature, validity window, hostname, CA constraints) against trusted root CAs (`tls.rootCertificates` + `SITREP_EXTRA_CA`), and every actual application HTTP request (`singlePinnedRequest`) enforces `rejectUnauthorized = true`.
