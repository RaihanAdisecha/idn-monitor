'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const zlib = require('node:zlib');

const SEC = require('../security');
const ROOT_DIR = path.resolve(__dirname, '..');

function listen(srv, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, host, () => resolve(srv.address().port));
  });
}

function closeServer(srv) {
  return new Promise(resolve => {
    if (!srv) return resolve();
    try { srv.close(() => resolve()); srv.closeAllConnections && srv.closeAllConnections(); }
    catch { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// 01 — SSRF Guard & DNS Rebinding Pinning
// ---------------------------------------------------------------------------

test('01a SSRF guard rejects private, loopback, octal/hex, metadata, and IPv6 mapped URLs', async () => {
  const badUrls = [
    'http://127.0.0.1/secret',
    'http://0177.0.0.1/secret',
    'http://0x7f000001/secret',
    'http://2130706433/secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/admin',
    'http://[::ffff:7f00:1]/admin',
    'http://[fc00::1]/internal',
    'http://[fe80::1]/linklocal',
    'http://localhost:8787/api/ping',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://user:pass@8.8.8.8/',
    'file:///etc/passwd'
  ];

  for (const u of badUrls) {
    assert.equal(SEC.publicURL(u), null, 'publicURL should reject ' + u);
    await assert.rejects(() => SEC.rdAssertPublic(u), 'rdAssertPublic should reject ' + u);
    await assert.rejects(() => SEC.safeFetch(u, {}, 2000), 'safeFetch should reject ' + u);
  }

  assert.equal(SEC.rdPrivateIP('8.8.8.8'), false);
  assert.equal(SEC.rdPrivateIP('2606:4700:4700::1111'), false);
  assert.equal(SEC.rdPrivateIP('2001:4860:4860::8888'), false);
  assert.equal(SEC.rdPrivateIP('::ffff:10.0.0.1'), true);
  assert.equal(SEC.rdPrivateIP('::ffff:a9fe:a9fe'), true); // 169.254.169.254
  assert.equal(SEC.rdPrivateIP('64:ff9b::7f00:1'), true);
  assert.equal(SEC.rdPrivateIP('2002:7f00:0001::'), true);
  assert.equal(SEC.rdPrivateIP('not-an-ip'), true);
});

test('01b DNS rebinding prevented: validated IP is pinned directly onto outbound socket', async () => {
  const client = SEC.createHttpClient({
    isPrivateIpFn: ip => ip === '10.99.99.99'
  });

  const srv = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-host-hdr': req.headers.host || '' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
      return;
    }
    if (req.url === '/gzip-stream') {
      const payload = Buffer.from('A'.repeat(65536));
      zlib.gzip(payload, (err, gz) => {
        if (err) { res.writeHead(500); return res.end(); }
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
        res.end(gz);
      });
      return;
    }
    if (req.url === '/to-evil-ip') {
      res.writeHead(302, { location: 'http://10.99.99.99:80/metadata' });
      res.end();
      return;
    }
    if (req.url === '/cross-origin') {
      res.writeHead(302, { location: 'http://origin-b.test:' + port + '/echo-hdr' });
      res.end();
      return;
    }
    if (req.url === '/echo-hdr') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ auth: req.headers.authorization || null, cookie: req.headers.cookie || null }));
      return;
    }
    res.writeHead(404); res.end();
  });

  const port = await listen(srv);
  try {
    let lookups = 0;
    const rebindResolver = async (host) => {
      lookups++;
      // Lookup #1 returns legitimate server IP; any unpinned 2nd lookup flips to forbidden IP
      if (lookups === 1) return [{ address: '127.0.0.1', family: 4 }];
      return [{ address: '10.99.99.99', family: 4 }];
    };

    const r = await client.safeFetch(`http://rebind.test:${port}/hello`, { resolveFn: rebindResolver }, 5000);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.ok, true);
    assert.equal(data.host, `rebind.test:${port}`);
    assert.equal(lookups, 1, 'DNS lookup must run only once and stay pinned to socket');

    // Redirect hop targeting forbidden IP must fail closed
    await assert.rejects(
      () => client.safeFetch(`http://rebind.test:${port}/to-evil-ip`, { resolveFn: async () => [{ address: '127.0.0.1', family: 4 }] }, 5000),
      /alamat privat|ditolak/
    );

    // Cross-origin redirect must strip authorization & cookie headers
    const rRedir = await client.safeFetch(`http://origin-a.test:${port}/cross-origin`, {
      resolveFn: async () => [{ address: '127.0.0.1', family: 4 }],
      headers: { authorization: 'Bearer top-secret', cookie: 'sess=abc' }
    }, 5000);
    const hdrData = await rRedir.json();
    assert.equal(hdrData.auth, null);
    assert.equal(hdrData.cookie, null);

    // Gzip response + early reader cancel cleanly aborts without crashing
    const rGz = await client.safeFetch(`http://rebind.test:${port}/gzip-stream`, {
      resolveFn: async () => [{ address: '127.0.0.1', family: 4 }]
    }, 5000);
    const reader = rGz.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value.length > 0);
    await reader.cancel();
  } finally {
    await closeServer(srv);
  }
});

// ---------------------------------------------------------------------------
// 02 — TLS Verification & Cryptographic AIA Chain Repair (no rejectUnauthorized:false)
// ---------------------------------------------------------------------------

function makeTestPki(tmpDir, aiaUrl) {
  const runSsl = (args) => execFileSync('openssl', args, { cwd: tmpDir, stdio: 'pipe' });

  const cnf = `
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Test
[v3_root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[v3_inter]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[v3_leaf]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:aia-target.test
authorityInfoAccess = caIssuers;URI:${aiaUrl}
[v3_self]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:self.test
`;
  const cnfPath = path.join(tmpDir, 'openssl.cnf');
  fs.writeFileSync(cnfPath, cnf);

  // Root CA
  runSsl(['genrsa', '-out', 'root.key', '2048']);
  runSsl(['req', '-new', '-x509', '-key', 'root.key', '-subj', '/CN=SITREP-Test-Root', '-days', '30', '-config', cnfPath, '-extensions', 'v3_root', '-out', 'root.pem']);

  // Intermediate CA
  runSsl(['genrsa', '-out', 'inter.key', '2048']);
  runSsl(['req', '-new', '-key', 'inter.key', '-subj', '/CN=SITREP-Test-Intermediate', '-out', 'inter.csr']);
  runSsl(['x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '15', '-extfile', cnfPath, '-extensions', 'v3_inter', '-out', 'inter.pem']);
  runSsl(['x509', '-in', 'inter.pem', '-outform', 'DER', '-out', 'inter.der']);

  // Leaf signed by Intermediate CA (served WITHOUT intermediate on TLS server!)
  runSsl(['genrsa', '-out', 'leaf.key', '2048']);
  runSsl(['req', '-new', '-key', 'leaf.key', '-subj', '/CN=aia-target.test', '-out', 'leaf.csr']);
  runSsl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '7', '-extfile', cnfPath, '-extensions', 'v3_leaf', '-out', 'leaf.pem']);

  // Rogue self-signed cert
  runSsl(['genrsa', '-out', 'self.key', '2048']);
  runSsl(['req', '-new', '-x509', '-key', 'self.key', '-subj', '/CN=self.test', '-days', '7', '-config', cnfPath, '-extensions', 'v3_self', '-out', 'self.pem']);

  // Expired leaf cert (End-date backdated to 2020-2021? Use -startdate / -enddate via x509 or faketime? Test with OpenSSL ca not needed — let's test wrong-host leaf!)
  const wrongCnf = cnf.replace('DNS:aia-target.test', 'DNS:other-domain.test');
  fs.writeFileSync(path.join(tmpDir, 'wrong.cnf'), wrongCnf);
  runSsl(['req', '-new', '-key', 'leaf.key', '-subj', '/CN=other-domain.test', '-out', 'wrong.csr']);
  runSsl(['x509', '-req', '-in', 'wrong.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '7', '-extfile', 'wrong.cnf', '-extensions', 'v3_leaf', '-out', 'wrong.pem']);
}

test('02 TLS stays strictly verified: valid AIA chains succeed while untrusted/self-signed/mismatch fail closed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-pki-'));
  let aiaHits = 0;
  let tlsSrv, selfSrv, wrongHostSrv;

  const aiaSrv = http.createServer((req, res) => {
    if (req.url === '/inter.der') {
      aiaHits++;
      res.writeHead(200, { 'content-type': 'application/pkix-cert' });
      res.end(fs.readFileSync(path.join(tmpDir, 'inter.der')));
      return;
    }
    res.writeHead(404); res.end();
  });
  const aiaPort = await listen(aiaSrv);

  try {
    makeTestPki(tmpDir, `http://aia-ca.test:${aiaPort}/inter.der`);

    // Serve ONLY leaf.pem (missing inter.pem) to simulate broken .go.id server chains
    tlsSrv = tls.createServer({
      key: fs.readFileSync(path.join(tmpDir, 'leaf.key')),
      cert: fs.readFileSync(path.join(tmpDir, 'leaf.pem'))
    }, sock => {
      sock.once('data', () => {
        sock.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 12\r\nConnection: close\r\n\r\nVERIFIED_AIA');
      });
    });
    const tlsPort = await listen(tlsSrv);

    selfSrv = tls.createServer({
      key: fs.readFileSync(path.join(tmpDir, 'self.key')),
      cert: fs.readFileSync(path.join(tmpDir, 'self.pem'))
    }, sock => {
      sock.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nEVIL');
    });
    const selfPort = await listen(selfSrv);

    wrongHostSrv = tls.createServer({
      key: fs.readFileSync(path.join(tmpDir, 'leaf.key')),
      cert: fs.readFileSync(path.join(tmpDir, 'wrong.pem'))
    }, sock => {
      sock.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nEVIL');
    });
    const wrongPort = await listen(wrongHostSrv);

    const resolveFn = async () => [{ address: '127.0.0.1', family: 4 }];
    const client = SEC.createHttpClient({ isPrivateIpFn: () => false });
    const withRoot = SEC.loadTrustedRoots([path.join(tmpDir, 'root.pem')]);
    const withoutRoot = SEC.loadTrustedRoots([]);

    // A) Incomplete chain + valid AIA anchored to trusted Root CA -> PASSES with rejectUnauthorized: true!
    const okRes = await client.safeFetch(`https://aia-target.test:${tlsPort}/`, {
      resolveFn,
      trustedRoots: withRoot
    }, 5000);
    assert.equal(okRes.status, 200);
    assert.equal(await okRes.text(), 'VERIFIED_AIA');
    assert.equal(aiaHits, 1, 'AIA intermediate cert should be fetched once');

    // Second request uses repaired chain cache without hitting AIA again
    const okRes2 = await client.safeFetch(`https://aia-target.test:${tlsPort}/`, {
      resolveFn,
      trustedRoots: withRoot
    }, 5000);
    assert.equal(await okRes2.text(), 'VERIFIED_AIA');
    assert.equal(aiaHits, 1, 'repaired chain should be cached per leaf fingerprint');

    // B) Same AIA server when Root CA is NOT trusted -> MUST FAIL CLOSED!
    const freshClient = SEC.createHttpClient({ isPrivateIpFn: () => false });
    await assert.rejects(
      () => freshClient.safeFetch(`https://aia-target.test:${tlsPort}/`, {
        resolveFn,
        trustedRoots: withoutRoot
      }, 5000)
    );

    // C) Self-signed certificate -> MUST FAIL CLOSED!
    await assert.rejects(
      () => client.safeFetch(`https://self.test:${selfPort}/`, {
        resolveFn,
        trustedRoots: withRoot
      }, 5000)
    );

    // D) Wrong hostname SAN even though signed by trusted intermediate/root -> MUST FAIL CLOSED!
    await assert.rejects(
      () => client.safeFetch(`https://aia-target.test:${wrongPort}/`, {
        resolveFn,
        trustedRoots: withRoot
      }, 5000)
    );
  } finally {
    await closeServer(tlsSrv);
    await closeServer(selfSrv);
    await closeServer(wrongHostSrv);
    await closeServer(aiaSrv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 03 — Session Authentication, Non-Injection of Token in HTML, RBAC & Rate Limit
// ---------------------------------------------------------------------------

function startSitrepServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const port = 29000 + Math.floor(Math.random() * 10000);
    const proc = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      env: { ...process.env, PORT: String(port), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('server start timeout: ' + out + err)); }, 15000);
    proc.stdout.on('data', d => {
      out += d.toString();
      if (out.includes('SITREP jalan')) {
        clearTimeout(timer);
        resolve({ proc, base: `http://127.0.0.1:${port}`, logs: () => out + err });
      }
    });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('exit', c => { clearTimeout(timer); reject(new Error(`server exited ${c}: ${out}${err}`)); });
  });
}

test('03 Session auth with HttpOnly cookie, RBAC, CSRF check, and rate limit in user mode', async () => {
  const adminHash = SEC.hashPassword('admin-pass-999');
  const srv = await startSitrepServer({
    SITREP_USERS: `viewer1:viewer:view-pass,op1:operator:op-pass,admin1:admin:${adminHash}`,
    SITREP_AUTH_SECRET: 'test-session-signing-secret-xyz-1234',
    SITREP_TOKEN: 'headless-secret-token-never-in-html',
    SITREP_INSECURE_TLS: '1'
  });

  try {
    // 1. Public health check still returns 200 without revealing secrets, and legacy SITREP_INSECURE_TLS=1 is ignored
    const ping = await fetch(`${srv.base}/api/ping`);
    assert.equal(ping.status, 200);
    const pingJson = await ping.json();
    assert.equal(pingJson.ok, true);
    assert.equal(pingJson.mode, 'session');
    assert.ok(srv.logs().includes('SITREP_INSECURE_TLS=1 diabaikan'));

    // 2. Unauthenticated GET / shows login form and NEVER leaks SITREP_TOKEN
    const loginPage = await fetch(`${srv.base}/`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.ok(loginHtml.includes('/api/auth/login'), 'login form expected');
    assert.equal(loginHtml.includes('headless-secret-token-never-in-html'), false, 'token must never be injected into HTML in session mode');
    assert.equal(loginHtml.includes('<meta name="sitrep-token" content='), false);

    // 3. Unauthenticated gated API returns 401
    const unauthApi = await fetch(`${srv.base}/api/alerts`);
    assert.equal(unauthApi.status, 401);

    // 4. Login as viewer1 fails on bad password, succeeds on valid password with HttpOnly cookie
    const badLogin = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer1', password: 'wrong-password' })
    });
    assert.equal(badLogin.status, 401);

    const viewerLogin = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'viewer1', password: 'view-pass' })
    });
    assert.equal(viewerLogin.status, 200);
    const viewerSetCookie = viewerLogin.headers.get('set-cookie') || '';
    assert.ok(viewerSetCookie.includes('sitrep_sess='));
    assert.ok(/httponly/i.test(viewerSetCookie));
    assert.ok(/samesite=lax/i.test(viewerSetCookie));
    const viewerCookie = viewerSetCookie.split(';')[0];

    // 5. Authenticated GET / renders dashboard with sitrep-user meta, still ZERO sitrep-token in HTML
    const dashRes = await fetch(`${srv.base}/`, { headers: { cookie: viewerCookie } });
    assert.equal(dashRes.status, 200);
    const dashHtml = await dashRes.text();
    assert.ok(dashHtml.includes('<meta name="sitrep-user" content="viewer1:viewer">'));
    assert.equal(dashHtml.includes('headless-secret-token-never-in-html'), false);
    assert.equal(dashHtml.includes('<meta name="sitrep-token" content='), false);

    // 6. RBAC enforcement: viewer cannot access operator/admin endpoints
    const xdiagAsViewer = await fetch(`${srv.base}/api/xdiag`, { headers: { cookie: viewerCookie } });
    assert.equal(xdiagAsViewer.status, 403);

    const xqAsViewer = await fetch(`${srv.base}/api/xq?q=`, { headers: { cookie: viewerCookie } });
    assert.equal(xqAsViewer.status, 403);

    const reportAsViewer = await fetch(`${srv.base}/api/cctv/report`, {
      method: 'POST',
      headers: { cookie: viewerCookie, origin: srv.base, 'content-type': 'application/json' },
      body: JSON.stringify({ u: 'https://example.com', ok: true })
    });
    assert.equal(reportAsViewer.status, 403);

    // 7. Operator login (plaintext hashed in memory) passes operator routes but fails admin routes
    const opLogin = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'op1', password: 'op-pass' })
    });
    assert.equal(opLogin.status, 200);
    const opCookie = (opLogin.headers.get('set-cookie') || '').split(';')[0];

    const xqAsOp = await fetch(`${srv.base}/api/xq?q=`, { headers: { cookie: opCookie } });
    assert.equal(xqAsOp.status, 200); // passed RBAC gate -> reached query validation

    const xdiagAsOp = await fetch(`${srv.base}/api/xdiag`, { headers: { cookie: opCookie } });
    assert.equal(xdiagAsOp.status, 403); // admin-only rejected

    // 8. CSRF protection on cookie-authenticated POST with cross-origin Origin header
    const csrfBlocked = await fetch(`${srv.base}/api/cctv/report`, {
      method: 'POST',
      headers: { cookie: opCookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ u: 'https://example.com', ok: true })
    });
    assert.equal(csrfBlocked.status, 403);

    // 9. Scrypt-hashed admin login + logout jti revocation
    const adminLogin = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin1', password: 'admin-pass-999' })
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = (adminLogin.headers.get('set-cookie') || '').split(';')[0];

    const logoutRes = await fetch(`${srv.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: adminCookie, origin: srv.base }
    });
    assert.equal(logoutRes.status, 200);

    // Reusing revoked session cookie must immediately fail with 401
    const afterLogout = await fetch(`${srv.base}/api/xq?q=`, { headers: { cookie: adminCookie } });
    assert.equal(afterLogout.status, 401);

    // 10. Rate limiting kicks in (login bucket allows 10 req / 5m; we already used 4 above)
    let got429 = null;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${srv.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin1', password: 'wrong' })
      });
      if (r.status === 429) { got429 = r; break; }
    }
    assert.ok(got429, 'rate limiter must trigger 429 on brute-force login attempts');
    assert.ok(Number(got429.headers.get('retry-after')) >= 1);
  } finally {
    srv.proc.kill('SIGTERM');
    await new Promise(r => srv.proc.once('exit', r));
  }
});

// ---------------------------------------------------------------------------
// 04 — Runtime Resilience: Worker Isolation & Fail-Fast Fatal Shutdown
// ---------------------------------------------------------------------------

test('04a runIsolated swallows background worker errors while createFatalGuard exits once after flushing', async () => {
  const res = await SEC.runIsolated('testWorker', async () => {
    throw new Error('transient feed failure');
  });
  assert.equal(res, null);

  let flushed = 0, closed = 0, exitCode = null;
  const guard = SEC.createFatalGuard({
    onFlush: () => { flushed++; },
    onClose: (cb) => { closed++; cb(); },
    exitFn: (code) => { exitCode = code; }
  });
  assert.equal(guard.isShuttingDown(), false);
  guard.trigger('uncaughtException', new Error('corrupted state'));
  guard.trigger('unhandledRejection', new Error('secondary error'));
  assert.equal(guard.isShuttingDown(), true);
  assert.equal(flushed, 1);
  assert.equal(closed, 1);
  assert.equal(exitCode, 1);
});

test('04b fatal uncaughtException flushes, closes server, and exits 1 (does not stay alive)', async () => {
  const exitResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const http = require('http');
      const SEC = require('./security');
      let flushed = false;
      const srv = http.createServer((req, res) => res.end('ok'));
      const fatal = SEC.createFatalGuard({
        onFlush: () => { flushed = true; process.stdout.write('FLUSHED\\n'); },
        onClose: (cb) => srv.close(cb),
        timeoutMs: 1000
      });
      fatal.install(process);
      srv.listen(0, '127.0.0.1', () => {
        setTimeout(() => { throw new Error('unrecoverable invariant failure'); }, 30);
      });
    `], { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child stayed alive!')); }, 5000);
    child.on('exit', code => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });

  assert.equal(exitResult.code, 1);
  assert.ok(exitResult.stdout.includes('FLUSHED'));
  assert.ok(exitResult.stderr.includes('[FATAL:uncaughtException]'));
});

test('05 startup guard fails closed (exit 78) on non-loopback local-token bind and defaults local bind to 127.0.0.1', async () => {
  // Clean env without Railway/SITREP_PUBLIC/SITREP_USERS
  const cleanEnv = { ...process.env };
  for (const k of ['RAILWAY_ENVIRONMENT', 'RENDER', 'FLY_APP_NAME', 'VERCEL', 'HEROKU_APP_NAME', 'K_SERVICE', 'SITREP_PUBLIC', 'SITREP_USERS', 'SITREP_ALLOW_LAN_TOKEN', 'BIND_HOST']) {
    delete cleanEnv[k];
  }

  const denied = await new Promise((resolve, reject) => {
    const port = 29000 + Math.floor(Math.random() * 10000);
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: { ...cleanEnv, PORT: String(port), SITREP_HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('expected immediate exit 78')); }, 6000);
    child.on('exit', code => { clearTimeout(t); resolve({ code, stderr }); });
  });
  assert.equal(denied.code, 78);
  assert.match(denied.stderr, /non-loopback/i);

  // Default local bind must be 127.0.0.1 without requiring SITREP_HOST
  const cleanBootEnv = { ...cleanEnv };
  delete cleanBootEnv.SITREP_HOST;
  const localSrv = await new Promise((resolve, reject) => {
    const port = 29000 + Math.floor(Math.random() * 10000);
    const proc = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: { ...cleanBootEnv, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('local boot timeout: ' + out + err)); }, 10000);
    proc.stdout.on('data', d => {
      out += d.toString();
      if (out.includes('SITREP jalan')) { clearTimeout(t); resolve({ proc, out }); }
    });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('exit', c => { clearTimeout(t); reject(new Error(`local boot exited ${c}: ${out}${err}`)); });
  });
  try {
    assert.ok(localSrv.out.includes('http://127.0.0.1:'), 'local-token mode must bind 127.0.0.1 by default');
    assert.ok(localSrv.out.includes('[local-token]'));
  } finally {
    localSrv.proc.kill('SIGKILL');
  }

  // Release hygiene checks
  const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
  const dockerignore = fs.readFileSync(path.join(ROOT_DIR, '.dockerignore'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT_DIR, 'Dockerfile'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.ok(gitignore.includes('.env.*') && gitignore.includes('!.env.example'));
  assert.ok(dockerignore.includes('.env.*') && dockerignore.includes('!.env.example'));
  assert.ok(!/muse/i.test(gitignore) && !/muse/i.test(dockerignore));
  assert.match(dockerfile, /^FROM node:24/m);
  assert.equal(pkg.engines.node, '>=24');
  for (const rel of ['LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'requirements.txt', '.github/workflows/ci.yml']) {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, rel)), `Missing required release file: ${rel}`);
  }
});
