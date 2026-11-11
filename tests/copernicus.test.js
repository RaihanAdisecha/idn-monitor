'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCopernicusProxy,
  tileToBbox3857,
  tileIntersectsBounds,
} = require('../copernicus');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-s2-'));
}

function makeFakeFetch(opts = {}) {
  let tokenCalls = 0;
  let processCalls = 0;
  let pngSeq = 0;
  const fetchFn = async (url, reqOpt) => {
    if (String(url).includes('/openid-connect/token')) {
      tokenCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-' + tokenCalls, expires_in: 600 }),
      };
    }
    if (String(url).includes('/api/v1/process')) {
      processCalls++;
      if (opts.failWithStatus) {
        return { ok: false, status: opts.failWithStatus, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const payload = Buffer.from(`PNG-TILE-${++pngSeq}-${reqOpt.body.length}`);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  return {
    fetchFn,
    counts: () => ({ tokenCalls, processCalls }),
  };
}

// Jakarta ~ (-6.2, 106.8) at z=8: x=203, y=132
const JKT_Z8 = { z: 8, x: 203, y: 132 };
// Darwin Australia ~ (-12.5, 130.8) at z=8: x=221, y=137 (outside Indonesia ROI)
const DRW_Z8 = { z: 8, x: 221, y: 137 };
// London ~ (51.5, -0.1) at z=8: x=127, y=85
const LON_Z8 = { z: 8, x: 127, y: 85 };

test('ROI filter rejects out-of-Indonesia tiles without hitting upstream', () => {
  assert.equal(tileIntersectsBounds(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y), true);
  assert.equal(tileIntersectsBounds(DRW_Z8.z, DRW_Z8.x, DRW_Z8.y), false);
  assert.equal(tileIntersectsBounds(LON_Z8.z, LON_Z8.x, LON_Z8.y), false);
  const bbox = tileToBbox3857(0, 0, 0);
  assert.equal(Math.round(bbox[0]), -20037508);
  assert.equal(Math.round(bbox[2]), 20037508);
});

test('Unconfigured credentials returns 503 for Indonesia tile and 204 out of ROI', async () => {
  const dir = mkTmpDir();
  try {
    const proxy = createCopernicusProxy({ dataDir: dir, fetchFn: async () => { throw new Error('must not fetch'); } });
    assert.equal(proxy.isConfigured(), false);
    const jkt = await proxy.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y);
    assert.equal(jkt.status, 503);
    assert.equal(jkt.cacheState, 'UNCONFIGURED');

    const lon = await proxy.getTile(LON_Z8.z, LON_Z8.x, LON_Z8.y);
    assert.equal(lon.status, 204);
    assert.equal(lon.cacheState, 'OUT-OF-ROI');

    const bad = await proxy.getTile(8, 9999, 0);
    assert.equal(bad.status, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Shared cache deduplicates concurrent fetches and persists across restart for 24h', async () => {
  const dir = mkTmpDir();
  const fake = makeFakeFetch();
  let now = Date.now();
  try {
    const p1 = createCopernicusProxy({
      dataDir: dir,
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: fake.fetchFn,
      nowFn: () => now,
      dailyCap: 10,
    });

    // 10 concurrent users requesting the exact same tile -> only 1 upstream process call
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => p1.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y))
    );
    for (const r of burst) {
      assert.equal(r.status, 200);
      assert.ok(r.buf.length > 0);
    }
    assert.equal(fake.counts().tokenCalls, 1);
    assert.equal(fake.counts().processCalls, 1);
    assert.equal(p1.getStatus().dailyUsed, 1);

    // Restart simulation: fresh instance with empty RAM reads disk cache & quota
    const p2 = createCopernicusProxy({
      dataDir: dir,
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: fake.fetchFn,
      nowFn: () => now,
      dailyCap: 10,
    });
    const diskHit = await p2.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y);
    assert.equal(diskHit.status, 200);
    assert.equal(diskHit.cacheState, 'HIT-DISK');
    assert.equal(fake.counts().processCalls, 1);
    assert.equal(p2.getStatus().dailyUsed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Daily cap enforces strict ceiling under concurrent bursts and keeps serving stale cache', async () => {
  const dir = mkTmpDir();
  const fake = makeFakeFetch();
  let now = Date.now();
  try {
    const proxy = createCopernicusProxy({
      dataDir: dir,
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: fake.fetchFn,
      nowFn: () => now,
      dailyCap: 1,
      cacheTtlMs: 86400000,
    });

    // Fire 4 distinct adjacent tiles concurrently when dailyCap=1 -> MUST spend at most 1!
    const burst = await Promise.all([
      proxy.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y),
      proxy.getTile(JKT_Z8.z, JKT_Z8.x + 1, JKT_Z8.y),
      proxy.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y + 1),
      proxy.getTile(JKT_Z8.z, JKT_Z8.x - 1, JKT_Z8.y),
    ]);
    assert.equal(burst.filter(r => r.status === 200).length, 1);
    assert.equal(burst.filter(r => r.status === 204).length, 3);
    assert.equal(fake.counts().processCalls, 1);
    assert.equal(proxy.getStatus().dailyUsed, 1);

    // Advance clock 25h within SAME or NEXT day check:
    // First advance +24h+1m WITHOUT hitting next UTC day if clock started early in day,
    // wait: use deterministic same-day expire test? +25h guarantees next UTC day!
    // To test STALE-CAP specifically, set cacheTtlMs short inside a separate proxy instance
    const pShort = createCopernicusProxy({
      dataDir: dir,
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: fake.fetchFn,
      nowFn: () => now,
      dailyCap: 1,
      cacheTtlMs: 60000,
    });
    now += 120000; // same UTC day unless exactly 23:59Z, safely expires 60s TTL
    const staleHit = await pShort.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y);
    assert.equal(staleHit.status, 200);
    assert.equal(staleHit.cacheState, 'STALE-CAP');
    assert.equal(staleHit.stale, true);
    assert.equal(fake.counts().processCalls, 1);

    // Advance +25h -> guarantees new UTC day rollover -> quota resets -> refreshes stale tile
    now += 25 * 3600000;
    const refreshed = await pShort.getTile(JKT_Z8.z, JKT_Z8.x, JKT_Z8.y);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.cacheState, 'MISS-FETCH');
    assert.equal(fake.counts().processCalls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UI places Citra (Foto + S2) toggles right after API unit and before #map-refresh', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const apiIdx = html.indexOf('<span class="mly-grp">API</span>');
  const citraIdx = html.indexOf('<span class="mly-grp">Citra</span>');
  const fotoIdx = html.indexOf('data-layer="basemap-sat"');
  const s2Idx = html.indexOf('data-layer="sentinel2"');
  const refreshIdx = html.indexOf('id="map-refresh"');
  assert.ok(apiIdx > 0);
  assert.ok(citraIdx > apiIdx, 'Citra unit must appear after API unit');
  assert.ok(fotoIdx > citraIdx && s2Idx > fotoIdx, 'Foto and S2 toggles must be inside Citra unit');
  assert.ok(refreshIdx > s2Idx, 'Citra toggles must appear before #map-refresh');
  assert.ok(html.includes('World_Imagery/MapServer/tile/{z}/{y}/{x}'));
  assert.ok(/data-layer="basemap-sat"[^>]*aria-pressed="true"/.test(html), 'Foto must default ON');
  assert.ok(/data-layer="sat-ir"[^>]*aria-pressed="false"/.test(html), 'IR must default OFF');
  assert.ok(/data-layer="gempa"[^>]*aria-pressed="true"/.test(html), 'Gempa must default ON');
  assert.ok(/data-layer="gunung"[^>]*aria-pressed="true"/.test(html), 'Gn.Api must default ON');
  assert.ok(/data-layer="wind"[^>]*aria-pressed="true"/.test(html), 'Wind must default ON');
  assert.ok(/data-layer="fires"[^>]*aria-pressed="true"/.test(html), 'Hotspot must default ON');
  assert.ok(/data-layer="air"[^>]*aria-pressed="true"/.test(html), 'Udara must default ON');

  const mlStart = html.indexOf('<div class="map-layers"');
  const mlEnd = html.indexOf('<div class="radar-ctrl"');
  const mlBlock = html.slice(mlStart, mlEnd);
  const hrefs = [...mlBlock.matchAll(/<button\b(?![^>]*\bhidden\b)[^>]*>[\s\S]*?<use href="(#[^"]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, 26, 'Expected 26 visible map toolbar buttons');
  assert.equal(new Set(hrefs).size, hrefs.length, 'Every visible map toolbar button must have a unique icon');
});
