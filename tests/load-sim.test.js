'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { createGateway } = require('../cctv-gateway');
const SEC = require('../security');
const MEDIA = require('../article-media');
const SRV = require('../server');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server.js');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function pooledGet(agent, port, reqPath) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, agent, headers: { 'accept-encoding': 'br' } }, res => {
      let bytes = 0;
      res.on('data', c => { bytes += c.length; });
      res.on('end', () => resolve({
        status: res.statusCode,
        bytes,
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        cc: res.headers['cache-control'] || '',
      }));
    });
    req.on('error', reject);
  });
}

test('Load Test A — Loopback bind + Edge/Origin HIT simulation across stepped waves (50 -> 100 -> 250 -> 500 -> 1000 -> 1800)', { timeout: 90000 }, async () => {
  const port = 22000 + Math.floor(Math.random() * 15000);
  const opToken = 'load-test-op-token-32-chars-minimum-x';
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      SITREP_HOST: '127.0.0.1',
      SITREP_PUBLIC: '1',
      SITREP_TOKEN: opToken,
      SITREP_MAC_PROFILE: '1',
      SITREP_TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let bootOut = '';
  child.stdout.on('data', d => { bootOut += d.toString('utf8'); });
  child.stderr.on('data', () => {});
  const cleanup = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  after(cleanup);

  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early');
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(ready, 'loopback 127.0.0.1 server must boot');
  assert.ok(bootOut.includes('http://127.0.0.1:' + port), 'startup log must reflect loopback BIND_HOST');

  await fetch(`http://127.0.0.1:${port}/`);
  await fetch(`http://127.0.0.1:${port}/api/nodes`);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });
  const waves = [50, 100, 250, 500, 1000, 1800];
  try {
    for (const totalReqs of waves) {
      const lats = [];
      let idx = 0;
      let badStatus = 0;
      const worker = async () => {
        for (;;) {
          const i = idx++;
          if (i >= totalReqs) return;
          const p = i % 3 === 0 ? '/' : (i % 3 === 1 ? '/api/nodes' : '/api/ping');
          const r = await pooledGet(agent, port, p);
          if (r.status !== 200) badStatus++;
          lats.push(r.ms);
        }
      };
      await Promise.all(Array.from({ length: Math.min(80, totalReqs) }, () => worker()));
      lats.sort((a, b) => a - b);
      const p95 = percentile(lats, 0.95);
      assert.equal(badStatus, 0, `wave ${totalReqs}: expected zero non-200 responses, got ${badStatus}`);
      assert.ok(p95 < 1500, `wave ${totalReqs}: p95 latency ${p95.toFixed(1)}ms should stay well below 1500ms`);
    }

    const metricsRes = await (await fetch(`http://127.0.0.1:${port}/api/metrics`, {
      headers: { 'x-sitrep-token': opToken },
    })).json();
    assert.equal(metricsRes.ok, true);
    assert.ok(metricsRes.reqTotal >= 3700);
    assert.ok(metricsRes.latencyMs.p95 <= 500, `origin aggregate p95 bucket ${metricsRes.latencyMs.p95}ms`);
    assert.equal(metricsRes.gateway.lane.maxQueue, 64, 'Mac profile must enforce maxQueue=64');
  } finally {
    agent.destroy();
    cleanup();
  }
});

test('Load Test B — Origin MISS simulation: 50 mock RSS feeds (bounded concurrency), delta rev, 100 unique articles docCache, HLS burst & recovery', async () => {

  let active = 0, maxSeen = 0;
  let calls = 0;
  const mockFeeds = Array.from({ length: 50 }, (_, i) => ({
    id: `MOCK_${i}`,
    failOnce: i % 10 === 0,
  }));
  const rssResults = await Promise.all(mockFeeds.map((f, idx) => SRV.rssSem(async () => {
    active++;
    if (active > maxSeen) maxSeen = active;
    calls++;
    await new Promise(r => setTimeout(r, 8));
    active--;
    if (f.failOnce && idx === 0) return { id: f.id, ok: false, items: [] };
    return { id: f.id, ok: true, items: [{ title: `Berita ${idx}`, url: `https://mock.news/${idx}` }] };
  })));
  assert.equal(calls, 50);
  assert.ok(maxSeen <= 8, `RSS semaphore max concurrency must stay <= 8, observed ${maxSeen}`);
  assert.equal(rssResults.filter(x => x.ok).length, 49);

  SRV.docCache.clear();
  for (let i = 0; i < 100; i++) {
    const htmlBody = '<html><body><article><p>' + `Artikel uji ke-${i} `.repeat(400) + '</p></article></body></html>';
    const doc = { html: htmlBody, jinaTxt: `Ringkasan jina ${i}`, finalUrl: `https://mock.news/art-${i}`, via: 'direct' };
    SRV.docCacheSet([`https://mock.news/art-${i}`], doc);
  }
  assert.ok(SRV.docCache.size <= 48, 'docCache count stays <= 48');
  assert.ok(SRV.getDocCacheBytes() <= SRV.DOC_CACHE_MAX_BYTES, 'docCache bytes stay within aggregate budget');

  const artHtml = '<html><head><meta property="og:image" content="https://mock.news/lead.jpg"></head><body><article><p>Kebakaran pasar terjadi.</p></article></body></html>';
  const mRes = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://mock.news/art-1',
    canonicalUrl: 'https://mock.news/art-1',
    html: artHtml,
    mode: 'full',
    probeFn: async u => ({ ok: true, w: 800, h: 450, mime: 'image/jpeg', bytes: 32000, fingerprint: 'fp-1', finalUrl: u }),
  });
  assert.equal(mRes.hero.verified, true);
  SRV.docCache.clear();

  let failUpstream = true;
  let releaseHold;
  let holdDone = new Promise(r => { releaseHold = r; });
  const gw = createGateway({
    hostAllowed: () => true,
    headersFor: () => ({}),
    rewriteUrl: async u => u,
    px: u => u,
    rateKey: SEC.rateKey,
    getClientIp: req => req.socket.remoteAddress,
    options: { maxActive: 1, perHost: 1, maxQueue: 2, reqRate: 200, reqBurst: 500, globalByteRate: 6 << 20, globalByteBurst: 20 << 20 },
    getRaw: async (url) => {
      if (url.includes('recover')) {
        if (failUpstream) throw new Error('upstream down');
        return {
          r: {
            ok: true, status: 200,
            headers: { get: k => /content-type/i.test(k) ? 'application/vnd.apple.mpegurl' : null },
            body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('#EXTM3U\n#EXTINF:2,\nseg0.ts\n')); c.close(); } }),
          },
          url,
        };
      }
      await holdDone;
      return {
        r: {
          ok: true, status: 200,
          headers: { get: k => /content-type/i.test(k) ? 'video/mp2t' : null },
          body: new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(512, 1)); c.close(); } }),
        },
        url,
      };
    },
  });

  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    gw.hls(u.searchParams.get('u') || 'https://cam.example/live/a.ts', req, res);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const f1 = fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/s1.ts')}`);
    const f2 = fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/s2.ts')}`);
    const f3 = fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/s3.ts')}`);
    await new Promise(r => setTimeout(r, 30));
    const f4 = await fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/s4.ts')}`);
    assert.equal(f4.status, 503, 'HLS queue overflow beyond maxQueue=2 must fail fast with 503');
    releaseHold();
    const [r1, r2, r3] = await Promise.all([f1, f2, f3]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);

    const downRes = await fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/recover.m3u8')}`);
    assert.equal(downRes.status, 502);
    failUpstream = false;
    const upRes = await fetch(`http://127.0.0.1:${port}/?u=${encodeURIComponent('https://cam.example/recover.m3u8')}`);
    assert.equal(upRes.status, 200);
  } finally {
    srv.closeAllConnections && srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
});
