'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SEC = require('../security');
const SRV = require('../server');
const HISTORY = require('../social-history');
const SOC = require('../social');

test('publicURL blocks trailing-dot localhost, loopback and cloud metadata hosts', () => {
  assert.equal(SEC.publicURL('https://localhost./admin'), null);
  assert.equal(SEC.publicURL('https://127.0.0.1./x'), null);
  assert.equal(SEC.publicURL('http://metadata.google.internal./computeMetadata/v1/'), null);
  assert.equal(SEC.publicURL('https://localhost/foo'), null);
  const ok = SEC.publicURL('https://example.com/berita?id=1');
  assert.ok(ok && ok.hostname === 'example.com');
});

test('isSameOriginPost enforces strict origin/referer/sec-fetch-site and proxy scheme', () => {
  assert.equal(SEC.isSameOriginPost({ headers: { host: 'sitrep.test' } }), false, 'missing origin+referer+sec-fetch-site must fail');
  assert.equal(SEC.isSameOriginPost({ headers: { host: 'sitrep.test', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(SEC.isSameOriginPost({ headers: { host: 'sitrep.test', 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(SEC.isSameOriginPost({ headers: { host: 'sitrep.test', origin: 'https://sitrep.test', 'x-forwarded-proto': 'https' } }, true), true);
  assert.equal(SEC.isSameOriginPost({ headers: { host: 'sitrep.test', origin: 'http://sitrep.test', 'x-forwarded-proto': 'https' } }, true), false, 'scheme mismatch under TLS proxy must fail');
});

test('revokeToken keeps >1000 revocations effective against jti un-revocation attack', () => {
  const auth = SEC.createAuthManager({
    usersSpec: 'op1:verysecretpass123:operator',
    authSecret: '00000000000000000000000000000000',
    sessionTtlSec: 3600,
  });
  const tokens = [];
  for (let i = 0; i < 1050; i++) {
    const { token } = auth.signSession('op1', 'operator');
    auth.revokeToken(token);
    if (i < 5) tokens.push(token);
  }
  for (const tok of tokens) {
    assert.equal(auth.authenticate({ headers: { cookie: 'sitrep_sess=' + tok } }), null, 'early revoked tokens must stay revoked past 1000');
  }
  const fresh = auth.signSession('op1', 'operator').token;
  assert.ok(auth.authenticate({ headers: { cookie: 'sitrep_sess=' + fresh } }), 'fresh session remains valid');
});

test('getClientIp selects rightmost untrusted hop and ignores spoofed left XFF entry', () => {
  const req1 = {
    headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.42' },
    socket: { remoteAddress: '::ffff:127.0.0.1' },
  };
  assert.equal(SEC.getClientIp(req1, true), '203.0.113.42');
  const req2 = {
    headers: { 'x-forwarded-for': '8.8.8.8, 203.0.113.42, 10.1.2.3' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(SEC.getClientIp(req2, true, 2), '203.0.113.42');
  assert.equal(SEC.getClientIp(req1, false), '::ffff:127.0.0.1');
});

test('sanitizeHopHeaders strips sensitive credentials across origin redirects', () => {
  const hdrs = { Authorization: 'Bearer sec', cookie: 's=1', 'Proxy-Authorization': 'Basic x', 'user-agent': 'UA' };
  const same = SRV.sanitizeHopHeaders(hdrs, 'https://a.example', 'https://a.example/next');
  assert.equal(same.Authorization, 'Bearer sec');
  assert.equal(same.cookie, 's=1');
  const cross = SRV.sanitizeHopHeaders(hdrs, 'https://a.example', 'https://b.example/next');
  assert.equal(cross.Authorization, undefined);
  assert.equal(cross.cookie, undefined);
  assert.equal(cross['Proxy-Authorization'], undefined);
  assert.equal(cross['user-agent'], 'UA');
});

test('projectAssessment preserves UI/signal fields while dropping heavy internal debug structures', () => {
  const full = SOC.socAssess('Kebakaran hebat melanda pasar tradisional di Depok malam ini, dua unit damkar dikerahkan');
  full.provenance = { sourceType: 'eyewitness', authorityWeight: 0.7, rawMetrics: { likes: 99 } };
  const slim = SRV.projectAssessment(full);
  assert.equal(slim.version, full.version);
  assert.deepEqual(slim.topics, full.topics);
  assert.equal(slim.scope, full.scope);
  assert.equal(slim.reportType, full.reportType);
  assert.equal(slim.feedLane, full.feedLane);
  assert.equal(slim.signalEligible, full.signalEligible);
  assert.equal(slim.feedEligible, full.feedEligible);
  assert.deepEqual(slim.events, full.events);
  assert.equal(slim.provenance.sourceType, 'eyewitness');
  assert.equal(slim.provenance.rawMetrics, undefined);
  assert.equal(slim.normalizedText, undefined);
  assert.equal(slim.layerTrace, undefined);
  assert.equal(slim.extractedEvents, undefined);
  assert.equal(slim.classification, undefined);
});

test('social-history retag fast-paths current _tagSig and invalidates when registry changes', () => {
  const now = Date.now();
  const map = new Map();
  const p = { text: 'Kebakaran gudang di Bekasi barat dilaporkan warga malam ini', url: 'https://x.com/u/status/1', ts: now - 600e3 };
  assert.equal(HISTORY.tag(p, [], now), true);
  assert.ok(p._tagSig && p._tagSig.startsWith(SOC.CLASSIFIER_VERSION + '|'));
  map.set(p.url, p);
  const verBefore = p.assessment.version;
  HISTORY.retag(map, () => true, [], now);
  assert.equal(map.size, 1);
  assert.equal(p.assessment.version, verBefore);
  // Corrupt assessment + change extra topic signature -> must recompute
  p.assessment.feedEligible = false;
  HISTORY.retag(map, () => true, [{ id: 'custom-topic', pos: /custom/i }], now);
  assert.equal(map.size, 1);
  assert.equal(p.assessment.feedEligible, true);
});

describe('SITREP_SERVER HTTP audit P0 contracts', () => {
  let baseUrl = '';
  let port = 0;

  before(async () => {
    await new Promise(resolve => SRV.SITREP_SERVER.listen(0, '127.0.0.1', resolve));
    port = SRV.SITREP_SERVER.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    SRV.cache.clear();
    SRV.bodyCache.clear();
    SRV.SITREP_SERVER.closeAllConnections && SRV.SITREP_SERVER.closeAllConnections();
    await new Promise(resolve => SRV.SITREP_SERVER.close(resolve));
  });

  function rawRequest(reqLine) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(reqLine + '\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      const chunks = [];
      sock.on('data', d => chunks.push(d));
      sock.on('error', reject);
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  test('malformed request path GET //[ returns 400 JSON without crashing server', async () => {
    const raw = await rawRequest('GET //[ HTTP/1.1');
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.match(raw, /"ok":false/);
    const ping = await fetch(baseUrl + '/api/ping');
    assert.equal(ping.status, 200);
  });

  test('/api/nodes caches publicly and returns 304 Not Modified on If-None-Match', async () => {
    const hdrs = { 'x-sitrep-token': SRV.AUTH.apiToken };
    const r1 = await fetch(baseUrl + '/api/nodes', { headers: hdrs });
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('cache-control') || '', /max-age=86400/);
    const etag = r1.headers.get('etag');
    assert.ok(etag && etag.length > 4);
    const j1 = await r1.json();
    assert.equal(j1.ok, true);
    assert.ok(Array.isArray(j1.items) && j1.items.length >= 100);

    const r2 = await fetch(baseUrl + '/api/nodes', { headers: { ...hdrs, 'If-None-Match': etag } });
    assert.equal(r2.status, 304);
    assert.equal((await r2.text()).length, 0);
  });

  test('bodyCache single-flight gzip does not poison on prior identity fetch and supports concurrent 304', async () => {
    const hdrs = { 'x-sitrep-token': SRV.AUTH.apiToken };
    const bigItems = Array.from({ length: 60 }, (_, i) => ({
      eid: 'ev' + i, name: 'Bandung', la: -6.91, lo: 107.61, prec: 'kab', kind: 'fire',
      label: 'Kebakaran', title: 'Kebakaran pabrik garmen ke-' + i + ' di Bandung Timur', ts: Date.now() - i * 1000, weight: 0.5
    }));
    bigItems.push({ name: 'Node X', la: -6.9, lo: 107.6, fixed: true, kind: 'node' });
    SRV.bodyCache.clear();
    SRV.cache.set('incidents', {
      at: Date.now(),
      v: { ok: true, items: bigItems, total: 60, raw: 60, places: 1, at: Date.now(), newest: Date.now(), stale: false }
    });

    // Warm first with plain identity encoding (must not lock gz: null for subsequent gzip clients)
    const plainRes = await fetch(baseUrl + '/api/incidents?nodes=0', { headers: { ...hdrs, 'accept-encoding': 'identity' } });
    assert.equal(plainRes.status, 200);
    const plainJson = await plainRes.json();
    assert.equal(plainJson.nodesOmitted, true);
    assert.ok(plainJson.items.every(i => !i.fixed), 'nodes=0 must omit fixed nodes');

    // Concurrent gzip clients must receive valid gzip + same ETag
    const gzReqs = await Promise.all(Array.from({ length: 8 }, () =>
      fetch(baseUrl + '/api/incidents?nodes=0', { headers: { ...hdrs, 'accept-encoding': 'gzip' } })
    ));
    let etag = '';
    for (const r of gzReqs) {
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-encoding'), 'gzip');
      etag = etag || r.headers.get('etag');
      const d = await r.json();
      assert.equal(d.items.length, 60);
    }
    assert.ok(SRV.bodyCache.get('incidents:nonodes').gz instanceof Buffer);

    const cond = await fetch(baseUrl + '/api/incidents?nodes=0', { headers: { ...hdrs, 'If-None-Match': etag } });
    assert.equal(cond.status, 304);
  });

  test('POST /api/desc and /api/cctv/report return 413 on oversized bodies', async () => {
    const hdrs = { 'x-sitrep-token': SRV.AUTH.apiToken, 'content-type': 'application/json' };
    const rDesc = await fetch(baseUrl + '/api/desc', {
      method: 'POST', headers: hdrs, body: JSON.stringify({ urls: ['https://example.com/' + 'a'.repeat(9000)] })
    });
    assert.equal(rDesc.status, 413);

    const rRep = await fetch(baseUrl + '/api/cctv/report', {
      method: 'POST', headers: hdrs, body: JSON.stringify({ u: 'https://example.com/' + 'b'.repeat(5000), ok: false })
    });
    assert.equal(rRep.status, 413);
  });

  test('/vhs and /img enforce scheme/host allowlist and CSP/nosniff security headers', async () => {
    const hdrs = { 'x-sitrep-token': SRV.AUTH.apiToken };
    const rBadScheme = await fetch(baseUrl + '/vhs?u=' + encodeURIComponent('javascript:alert(1)'), { headers: hdrs });
    assert.equal(rBadScheme.status, 400);

    const rLocal = await fetch(baseUrl + '/vhs?u=' + encodeURIComponent('http://127.0.0.1/evil.html'), { headers: hdrs });
    assert.equal(rLocal.status, 502);
    assert.equal(rLocal.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(rLocal.headers.get('content-security-policy'), "default-src 'none'; sandbox");

    const rImg = await fetch(baseUrl + '/img?u=' + encodeURIComponent('https://evil.example/a.svg'), { headers: hdrs });
    assert.equal(rImg.status, 403);
  });
});

test('public/index.html static invariants: no hostBad ReferenceError, CSS order, exponential kill backoff, same-origin ?api=', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.equal(html.includes('hostBad.delete'), false, 'hostBad ReferenceError must be gone');
  assert.ok(html.includes('camBad.delete(camKey(cc.s))'));
  assert.equal(html.includes('cells.forEach(c => camGrid.appendChild(c))'), false, 'orderCams must not detach active video nodes');
  assert.ok(html.includes("c.style.order = String((p.bad ? 100000 : 0) + (p.idx || 0))"));
  assert.equal(html.includes('p.tries = Math.max(0, p.tries - 1)'), false, 'kill backoff must not decrement tries');
  assert.ok(html.includes('resolved.origin === location.origin'), '?api= must restrict to same-origin outside localhost');
  assert.ok(html.includes("/api/incidents?' + qs"), 'client should fetch /api/incidents with nodes=0 optimization');
  assert.equal(html.includes("rootMargin:'200px 0px'"), false, 'vio must not let offscreen 200px margin steal LIVE_CAP slots');
  assert.ok(html.includes('const wantLive = new Set(visRanked.slice(0, LIVE_CAP)'), 'pump must deterministically grant LIVE_CAP slots to top visible cells');
  assert.ok(html.includes('dropLoadingCell(c)'), 'offscreen still-loading cells must abort/release slots on scroll');
});

test('safeFetch handles pre-aborted and mid-flight AbortSignal without uncaught socket hang up', async () => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://public.example.test:' + srv.address().port + '/slow';
  const client = SEC.createHttpClient({ isPrivateIpFn: () => false });
  const resolveFn = async () => [{ address: '127.0.0.1', family: 4 }];

  let caughtUncaught = null;
  const onUncaught = e => { caughtUncaught = e; };
  process.on('uncaughtException', onUncaught);
  try {
    await assert.rejects(
      () => client.safeFetch(url, { signal: AbortSignal.abort(), resolveFn }, 2000),
      err => err && err.name === 'AbortError'
    );
    const ac = new AbortController();
    const p = client.safeFetch(url, { signal: ac.signal, resolveFn }, 2000);
    setTimeout(() => ac.abort(), 15);
    await p.then(r => r.text()).catch(() => {});
    await new Promise(r => setTimeout(r, 40));
    assert.equal(caughtUncaught, null, 'abort must never emit uncaught socket hang up');
  } finally {
    process.off('uncaughtException', onUncaught);
    client.closeAllAgents();
    srv.closeAllConnections && srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
});
