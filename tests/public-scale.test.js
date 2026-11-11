'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const SEC = require('../security');
const SRV = require('../server');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server.js');

test('security: publicMode serves viewer role without login or token leak, while keeping optional operator token header', () => {
  const auth = SEC.createAuthManager({
    publicDeploy: true,
    apiToken: 'operator-secret-xyz',
    explicitToken: true,
    tokenRole: 'admin',
  });
  assert.equal(auth.publicMode, true);
  assert.equal(auth.userMode, false);

  const html = auth.injectHtmlMeta('<html><head><title>x</title></head><body></body></html>', null);
  assert.ok(html.includes('<meta name="sitrep-public" content="1">'));
  assert.equal(html.includes('sitrep-token'), false);
  assert.equal(html.includes('operator-secret-xyz'), false);

  const anon = auth.authenticate({ headers: {} }, new URL('http://x/api/news'));
  assert.deepEqual(anon, { username: 'public', role: 'viewer', via: 'public' });

  const op = auth.authenticate({ headers: { 'x-sitrep-token': 'operator-secret-xyz' } }, new URL('http://x/api/metrics'));
  assert.deepEqual(op, { username: 'api-token', role: 'admin', via: 'token' });
});

test('makeSem enforces bounded queue and fails fast with 503 when saturated', async () => {
  const sem = SRV.makeSem(1, 2);
  let releaseFirst;
  const firstDone = new Promise(r => { releaseFirst = r; });

  const p1 = sem(() => firstDone);
  const p2 = sem(async () => 'two');
  const p3 = sem(async () => 'three');
  await assert.rejects(
    () => sem(async () => 'overflow'),
    err => err && err.status === 503
  );

  releaseFirst();
  assert.deepEqual(await Promise.all([p2, p3]), ['two', 'three']);
  await p1;
});

test('singleFlight serves stale value immediately (SWR) and schedules single background refresh', async () => {
  const box = { at: Date.now() - 60000, data: { ok: true, v: 1 } };
  let calls = 0;
  let resolveBg;
  const bgDone = new Promise(r => { resolveBg = r; });

  const r1 = await SRV.singleFlight(box, 10000, async () => {
    calls++;
    await bgDone;
    box.at = Date.now();
    box.data = { ok: true, v: 2 };
    return box.data;
  });
  assert.deepEqual(r1, { ok: true, v: 1 });

  // Concurrent second caller during background refresh must also hit stale data and not trigger second upstream
  const r2 = await SRV.singleFlight(box, 10000, async () => {
    calls++;
    return { ok: true, v: 99 };
  });
  assert.deepEqual(r2, { ok: true, v: 1 });
  assert.equal(calls, 1);

  resolveBg();
  await new Promise(r => setTimeout(r, 20));
  const r3 = await SRV.singleFlight(box, 10000, async () => ({ ok: true, v: 99 }));
  assert.deepEqual(r3, { ok: true, v: 2 });
});

test('SITREP_PUBLIC=1 HTTP contract: no login wall, no token leak, CDN cache headers, snapshot allowlist & operator gate', { timeout: 90000 }, async (t) => {
  const port = 21000 + Math.floor(Math.random() * 18000);
  const base = `http://127.0.0.1:${port}`;
  const opToken = 'pub-op-token-test-991';
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), SITREP_PUBLIC: '1', SITREP_TOKEN: opToken },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  after(cleanup);

  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('public server exited early');
    try {
      const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, 'public server must respond on /api/ping');

  await t.test('GET / serves dashboard without login form and never leaks operator token', async () => {
    const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(9000) });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('<meta name="sitrep-public" content="1">'));
    assert.equal(html.includes('<meta name="sitrep-token" content='), false);
    assert.equal(html.includes(opToken), false);
    assert.equal(html.includes('Autentikasi Diperlukan'), false, 'must NOT serve login gate');
  });

  await t.test('GET /api/ping reports mode=public and omits wildcard CORS', async () => {
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'public');
  });

  await t.test('Public snapshots succeed without login and emit CDN-cacheable Cache-Control headers', async () => {
    const r = await fetch(`${base}/api/nodes`, { signal: AbortSignal.timeout(9000) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /public,\s*max-age=86400/);
    const etag = r.headers.get('etag');
    assert.ok(etag);
    const r304 = await fetch(`${base}/api/nodes`, { headers: { 'If-None-Match': etag }, signal: AbortSignal.timeout(5000) });
    assert.equal(r304.status, 304);
  });

  await t.test('Anonymous public visitors cannot abuse operator controls, ?fresh=1, or arbitrary external URLs', async () => {
    const blocked = [
      ['/api/metrics'],
      ['/api/xdiag'],
      ['/api/incidents?fresh=1'],
      ['/api/news?fresh=1'],
      ['/api/situation?fresh=1'],
      ['/api/xq?q=arbitrary-unknown-query-xyz'],
      ['/api/thq?q=arbitrary-unknown-query-xyz'],
      ['/api/read?u=' + encodeURIComponent('https://arbitrary.example/secret-article')],
      ['/api/thumb?u=' + encodeURIComponent('https://arbitrary.example/secret-article')],
      ['/api/thread?u=' + encodeURIComponent('https://x.com/someone/status/1999999999999999')],
      ['/vhs?u=' + encodeURIComponent('https://arbitrary.example/big.mp4')],
      ['/api/social/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"test"}' }],
      ['/api/cctv/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"u":"https://x.example/cam.m3u8","ok":false}' }],
    ];
    for (const [p, opt] of blocked) {
      const r = await fetch(base + p, { ...(opt || {}), signal: AbortSignal.timeout(5000) });
      assert.equal(r.status, 403, `expected 403 for public caller on ${p}, got ${r.status}`);
    }
    const badTile = await fetch(`${base}/tomtom/tile/flow/10/999999/0.png`, { signal: AbortSignal.timeout(5000) });
    assert.equal(badTile.status, 400);
    assert.equal(badTile.headers.get('access-control-allow-origin'), null);
  });

  await t.test('Explicit operator token grants access to /api/metrics', async () => {
    const r = await fetch(`${base}/api/metrics`, {
      headers: { 'x-sitrep-token': opToken },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'public');
    assert.ok(j.reqTotal >= 1);
    assert.ok(j.memoryMb && j.memoryMb.rss > 0);
  });

  await t.test('Concurrent burst against public snapshots handles 240 requests at 60 concurrency cleanly', async () => {
    for (let wave = 0; wave < 4; wave++) {
      const res = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          fetch(`${base}${i % 2 === 0 ? '/api/nodes' : '/api/ping'}`, { signal: AbortSignal.timeout(10000) })
        )
      );
      assert.ok(res.every(r => r.status === 200), `wave ${wave}: all 60 concurrent public hits must return 200`);
    }
  });

  cleanup();
});

test('security: getClientIp handles Cloudflare CF-Connecting-IP fallback and strict SITREP_TRUST_CF mode', () => {
  const SEC = require('../security');
  assert.equal(
    SEC.getClientIp({ headers: { 'cf-connecting-ip': '203.0.113.50' }, socket: { remoteAddress: '127.0.0.1' } }, true),
    '203.0.113.50'
  );
  // Default: rightmost untrusted XFF wins over CF-Connecting-IP unless SITREP_TRUST_CF=1
  assert.equal(
    SEC.getClientIp({ headers: { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1, 203.0.113.99' }, socket: { remoteAddress: '127.0.0.1' } }, true),
    '203.0.113.99'
  );
  const prev = process.env.SITREP_TRUST_CF;
  process.env.SITREP_TRUST_CF = '1';
  try {
    assert.equal(
      SEC.getClientIp({ headers: { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '1.1.1.1, 203.0.113.99' }, socket: { remoteAddress: '127.0.0.1' } }, true),
      '198.51.100.2'
    );
  } finally {
    if (prev === undefined) delete process.env.SITREP_TRUST_CF;
    else process.env.SITREP_TRUST_CF = prev;
  }
});

test('cctv-gateway: allowPublicCache allows edge-cached /api/cctv/snap while keeping HLS private when allowCors=false', async () => {
  const http = require('http');
  const { createGateway } = require('../cctv-gateway');
  const gw = createGateway({
    hostAllowed: () => true,
    headersFor: () => ({}),
    rewriteUrl: async u => u,
    px: u => u,
    allowCors: false,
    allowPublicCache: true,
    getClientIp: (req, tp) => require('../security').getClientIp(req, tp),
    trustProxy: true,
    getRaw: async (url) => ({
      r: {
        ok: true,
        status: 200,
        headers: { get: k => /content-type/i.test(k) ? 'application/vnd.apple.mpegurl' : null },
        body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('#EXTM3U\n#EXTINF:2,\nseg1.ts\n')); c.close(); } }),
      },
      url,
    }),
  });
  const srv = http.createServer((req, res) => gw.hls('https://cam.example/live/index.m3u8', req, res));
  await new Promise(r => srv.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, {
      headers: { 'cf-connecting-ip': '203.0.113.77' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
});

test('cctv-gateway: global egress byte budget and IPv6 /64 rateKey limit multi-IP floods', async () => {
  const http = require('http');
  const { createGateway } = require('../cctv-gateway');
  const gw = createGateway({
    hostAllowed: () => true,
    headersFor: () => ({}),
    rewriteUrl: async u => u,
    px: u => u,
    trustProxy: true,
    rateKey: SEC.rateKey,
    getClientIp: (req, tp) => SEC.getClientIp(req, tp),
    options: { reqRate: 0.01, reqBurst: 2, globalByteRate: 1, globalByteBurst: 2500, byteRate: 10 << 20, byteBurst: 10 << 20 },
    getRaw: async (url) => ({
      r: {
        ok: true,
        status: 200,
        headers: { get: k => /content-type/i.test(k) ? 'video/mp2t' : null },
        body: new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(1024, 7)); c.close(); } }),
      },
      url,
    }),
  });
  const srv = http.createServer((req, res) => gw.hls('https://cam.example/live/seg1.ts', req, res));
  await new Promise(r => srv.listen(0, r));
  try {
    const port = srv.address().port;
    // Different IPv6 addresses inside the same /64 share 1 reqRl bucket (burst=2)
    const r1 = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '2001:db8:1:2::1' } });
    const r2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '2001:db8:1:2::2' } });
    const r3 = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '2001:db8:1:2::3' } });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429, 'rotating IPv6 suffix inside /64 must still hit shared reqRl bucket');

    // First IPv4 brings total charged bytes from 2048 -> 3072 (> 2500 globalByteBurst)
    const r4 = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '198.51.100.88' } });
    assert.equal(r4.status, 200);
    // Subsequent distinct IPv4 must fail on exhausted global egress cap
    const r5 = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '198.51.100.89' } });
    assert.equal(r5.status, 429, 'global egress byte cap must throttle cross-IP flood');
    assert.ok(gw.stats().globalRl >= 1);
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
});

test('server: /api/news?rev= serves CDN-cacheable delta responses and Brotli JSON compression', async () => {
  const http = require('http');
  const feedId = SRV.NEWS[0][0];
  const now = Date.now();
  const baseItems = Array.from({ length: 12 }, (_, i) => ({
    title: `Banjir merendam jalan utama sektor ${i} di Bekasi hari ini`,
    url: `https://news.example.id/bekasi-${i}`,
    ts: now - i * 60000,
    img: '',
    pub: 'Antara',
    desc: 'Debit sungai meningkat sejak dini hari dan petugas melakukan pemantauan.',
    src: feedId,
  }));
  SRV.NEWS.forEach(([id]) => {
    SRV.cache.set('n:' + id, {
      at: now,
      v: { id, ok: true, stale: false, items: id === feedId ? baseItems : [], at: now },
    });
  });
  SRV.invalidateDerivedFromNews();

  const port = await new Promise((resolve, reject) => {
    const onErr = err => reject(err);
    SRV.SITREP_SERVER.once('error', onErr);
    SRV.SITREP_SERVER.listen(0, '127.0.0.1', () => {
      SRV.SITREP_SERVER.off('error', onErr);
      resolve(SRV.SITREP_SERVER.address().port);
    });
  });
  try {
    const hdr = { 'x-sitrep-token': process.env.SITREP_TOKEN };
    const rFull = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/news', headers: { ...hdr, 'accept-encoding': 'br' } }, res => {
        const ch = [];
        res.on('data', d => ch.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          enc: res.headers['content-encoding'],
          cc: res.headers['cache-control'],
          body: res.headers['content-encoding'] === 'br'
            ? require('zlib').brotliDecompressSync(Buffer.concat(ch)).toString('utf8')
            : Buffer.concat(ch).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rFull.status, 200);
    const parsed = JSON.parse(rFull.body);
    assert.ok(Number.isInteger(parsed.rev), '/api/news must include integer rev');
    if (Buffer.byteLength(rFull.body) > 8192) {
      assert.equal(rFull.enc, 'br', 'large JSON API payload must honor Accept-Encoding: br');
    }

    const rSame = await (await fetch(`http://127.0.0.1:${port}/api/news?rev=${parsed.rev}`, { headers: hdr })).json();
    assert.equal(rSame.delta, true);
    assert.equal(rSame.unchanged, true);
    assert.equal(rSame.rev, parsed.rev);

    // Mutate one feed & bump rev -> delta returns only the changed source
    SRV.cache.set('n:' + feedId, {
      at: Date.now(),
      v: {
        id: feedId, ok: true, stale: false, at: Date.now(),
        items: [{ ...baseItems[0], title: 'Kebakaran gudang di Cikarang sore ini', url: 'https://news.example.id/cikarang-baru', ts: Date.now() }, ...baseItems],
      },
    });
    SRV.invalidateDerivedFromNews();
    const rDiff = await (await fetch(`http://127.0.0.1:${port}/api/news?rev=${parsed.rev}`, { headers: hdr })).json();
    assert.equal(rDiff.delta, true);
    assert.equal(rDiff.unchanged, false);
    assert.ok(rDiff.rev > parsed.rev);
    assert.deepEqual(rDiff.changedSources.map(s => s.id), [feedId]);
  } finally {
    SRV.SITREP_SERVER.closeAllConnections && SRV.SITREP_SERVER.closeAllConnections();
    await new Promise(r => SRV.SITREP_SERVER.close(r));
  }
});

test('P0/P1/P2 production hardening: loopback bind, HLS queue+abort, no s-maxage, asset immutable, docCache bytes, auth secret & metrics', async () => {
  const fs = require('fs');
  const http = require('http');
  const SEC = require('../security');
  const { makeLane } = require('../cctv-gateway');
  const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
  const serverJs = fs.readFileSync(SERVER, 'utf8');

  // P0: SITREP_SERVER.listen passes BIND_HOST
  assert.ok(serverJs.includes('SITREP_SERVER.listen({ host: BIND_HOST, port: Number(PORT) || 8787'), 'listen must bind explicit BIND_HOST');

  // P1: makeLane enforces maxQueue=503 and removes aborted queued jobs before execution
  const lane = makeLane(1, 1, 2);
  let release0;
  const p0 = lane.run('cam-a', () => new Promise(r => { release0 = r; }));
  const ac = new AbortController();
  const p1 = lane.run('cam-a', async () => 'ran-1', ac.signal);
  const p2 = lane.run('cam-a', async () => 'ran-2');
  await assert.rejects(() => lane.run('cam-a', async () => 'overflow'), err => err && err.status === 503);
  ac.abort();
  await assert.rejects(() => p1, err => err && err.name === 'AbortError');
  assert.equal(lane.stats().queued, 1, 'aborted queued job must be removed from queue');
  release0('done-0');
  assert.equal(await p0, 'done-0');
  assert.equal(await p2, 'ran-2');
  assert.equal(lane.stats().cancelled, 1);

  // P1: Static assets versioned immutable + lazy-load hls.js & Leaflet (inline L.VelocityLayer wrapped)
  assert.equal(html.includes('cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>'), false, 'hls.min.js must be lazy-loaded');
  assert.equal(html.includes('cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>'), false, 'leaflet.js must be lazy-loaded');
  assert.ok(html.includes('function ensureHls()') && html.includes('function ensureLeaflet()') && html.includes('function initLeafletVelocity()'));

  const vMap = SRV.getAssetVersionMap();
  const sigInfo = vMap.get('signals.js');
  assert.ok(sigInfo && /^signals\.[a-f0-9]{8}\.js$/.test(sigInfo.versioned));
  const vAsset = SRV.staticEntry('/' + sigInfo.versioned);
  assert.ok(vAsset && vAsset.cc === 'public, max-age=31536000, immutable');
  const htmlEntry = SRV.staticEntry('/');
  assert.ok(htmlEntry && htmlEntry.buf.toString('utf8').includes(sigInfo.versioned));

  // P2: docCache tracks combined HTML + jinaTxt bytes and enforces aggregate budget
  const hugeTxt = 'x'.repeat(300 * 1024);
  SRV.docCache.clear();
  for (let i = 0; i < 6; i++) {
    SRV.docCacheSet([`https://doc-budget.example/a${i}`], { html: hugeTxt, jinaTxt: hugeTxt, finalUrl: `https://doc-budget.example/a${i}`, via: 'direct' });
  }
  assert.ok(SRV.getDocCacheBytes() <= SRV.DOC_CACHE_MAX_BYTES);
  assert.ok(SRV.getDocCacheBytes() > 0);
  SRV.docCache.clear();

  // P2: session mode requires >=32-char SITREP_AUTH_SECRET; public/session disable ?token= query param
  assert.throws(
    () => SEC.createAuthManager({ usersSpec: 'op:strongpass123:operator', authSecret: 'short-secret' }),
    /minimal 32 karakter/
  );
  const pubAuth = SEC.createAuthManager({ publicDeploy: true, apiToken: 'tok-abc-123', explicitToken: true, tokenRole: 'operator' });
  assert.equal(pubAuth.allowQueryToken, false);
  assert.equal(pubAuth.authenticate({ headers: {} }, new URL('http://x/api/metrics?token=tok-abc-123')).role, 'viewer', 'query token must be ignored in publicMode');
  assert.equal(pubAuth.authenticate({ headers: { 'x-sitrep-token': 'tok-abc-123' } }, new URL('http://x/api/metrics')).role, 'operator');

  // P1 & P2 HTTP check: no s-maxage on /api/news & /api/nodes, plus enriched /api/metrics fields
  const port = await new Promise((resolve) => {
    SRV.SITREP_SERVER.listen(0, '127.0.0.1', () => resolve(SRV.SITREP_SERVER.address().port));
  });
  try {
    const hdr = { 'x-sitrep-token': process.env.SITREP_TOKEN };
    const rNodes = await fetch(`http://127.0.0.1:${port}/api/nodes`, { headers: hdr });
    const ccNodes = rNodes.headers.get('cache-control') || '';
    assert.ok(!/s-maxage/i.test(ccNodes), `/api/nodes must omit s-maxage, got: ${ccNodes}`);

    const rNews = await fetch(`http://127.0.0.1:${port}/api/news`, { headers: hdr });
    const ccNews = rNews.headers.get('cache-control') || '';
    assert.ok(!/s-maxage/i.test(ccNews), `pubCC must omit s-maxage, got: ${ccNews}`);
    assert.match(ccNews, /public,\s*max-age=\d+,\s*stale-while-revalidate=/);

    const rMetrics = await (await fetch(`http://127.0.0.1:${port}/api/metrics`, { headers: hdr })).json();
    assert.ok(rMetrics.latencyMs && typeof rMetrics.latencyMs.p95 === 'number');
    assert.ok(rMetrics.eventLoopLagMs && typeof rMetrics.eventLoopLagMs.p95 === 'number');
    assert.ok(rMetrics.egress && typeof rMetrics.egress.originBytesPerSec === 'number');
    assert.ok(rMetrics.feeds && typeof rMetrics.feeds.total === 'number');
    assert.ok(typeof rMetrics.caches.docBytes === 'number');
    assert.ok(typeof rMetrics.memoryMb.external === 'number');
    assert.ok(rMetrics.gateway && rMetrics.gateway.lane && 'maxQueue' in rMetrics.gateway.lane);
  } finally {
    SRV.SITREP_SERVER.closeAllConnections && SRV.SITREP_SERVER.closeAllConnections();
    await new Promise(r => SRV.SITREP_SERVER.close(r));
  }
});
