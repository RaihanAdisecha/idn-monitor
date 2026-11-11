'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';
const WORLD_HALF = 20037508.342789244;
const MIN_ZOOM = 6;
const MAX_ZOOM = 12;
const TILE_PX = 512;
const ID_BOUNDS = { minLon: 94.5, minLat: -11.5, maxLon: 141.5, maxLat: 6.5 };

const TRUE_COLOR_EVALSCRIPT = [
  '//VERSION=3',
  'function setup() {',
  '  return { input: ["B02", "B03", "B04"], output: { bands: 4, sampleType: "AUTO" } };',
  '}',
  'function evaluatePixel(s) {',
  '  if (s.B02 === 0 && s.B03 === 0 && s.B04 === 0) return [0, 0, 0, 0];',
  '  const g = v => Math.min(1, Math.pow(Math.max(0, 2.2 * v), 0.8));',
  '  return [g(s.B04), g(s.B03), g(s.B02), 1];',
  '}',
].join('\n');

function tileToBbox3857(z, x, y) {
  const n = 2 ** z;
  const span = (2 * WORLD_HALF) / n;
  const minX = -WORLD_HALF + x * span;
  const maxX = minX + span;
  const maxY = WORLD_HALF - y * span;
  const minY = maxY - span;
  return [minX, minY, maxX, maxY];
}

function tileToBbox4326(z, x, y) {
  const n = 2 ** z;
  const lonOf = col => (col / n) * 360 - 180;
  const latOf = row => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [lonOf(x), latOf(y + 1), lonOf(x + 1), latOf(y)];
}

function tileIntersectsBounds(z, x, y, bounds = ID_BOUNDS) {
  const [minLon, minLat, maxLon, maxLat] = tileToBbox4326(z, x, y);
  return maxLon >= bounds.minLon && minLon <= bounds.maxLon &&
    maxLat >= bounds.minLat && minLat <= bounds.maxLat;
}

function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < limit && queue.length) {
      const item = queue.shift();
      active++;
      Promise.resolve().then(item.fn).then(
        val => { active--; next(); item.resolve(val); },
        err => { active--; next(); item.reject(err); }
      );
    }
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

function createCopernicusProxy(opts = {}) {
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  const cacheDir = opts.cacheDir || path.join(dataDir, 's2-cache');
  const quotaFile = opts.quotaFile || path.join(dataDir, 's2-quota.json');
  const clientId = String(opts.clientId || '').trim();
  const clientSecret = String(opts.clientSecret || '').trim();
  const fetchFn = opts.fetchFn || (typeof fetch === 'function' ? ((u, o, ms) => fetch(u, o)) : null);
  const nowFn = opts.nowFn || (() => Date.now());
  const dailyCap = Math.max(0, Number.isFinite(Number(opts.dailyCap)) ? Number(opts.dailyCap) : 1200);
  const monthCap = Math.max(0, Number.isFinite(Number(opts.monthCap)) ? Number(opts.monthCap) : 9500);
  const cacheTtlMs = Math.max(60000, Number(opts.cacheTtlMs) || 86400000);
  const maxCacheBytes = Math.max(4 << 20, Number(opts.maxCacheBytes) || (256 << 20));
  const lookbackDays = Math.max(7, Math.min(90, Number(opts.lookbackDays) || 45));
  const memCap = Math.max(16, Number(opts.memCap) || 64);
  const memMaxBytes = Math.max(2 << 20, Number(opts.memMaxBytes) || (20 << 20));
  const upstreamSem = makeSemaphore(Math.max(1, Number(opts.concurrency) || 4));

  const memCache = new Map();
  const inflight = new Map();
  let tokenState = { token: '', expiresAt: 0 };
  let tokenInflight = null;
  let cooldownUntil = 0;
  let writeCount = 0;
  let quotaState = loadQuota();

  function utcKeys(ms) {
    const iso = new Date(ms).toISOString();
    return { dayKey: iso.slice(0, 10), monthKey: iso.slice(0, 7) };
  }

  function loadQuota() {
    const { dayKey, monthKey } = utcKeys(nowFn());
    try {
      const raw = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
      return {
        dayKey: typeof raw.dayKey === 'string' ? raw.dayKey : dayKey,
        dailyUsed: Math.max(0, Number(raw.dailyUsed) || 0),
        monthKey: typeof raw.monthKey === 'string' ? raw.monthKey : monthKey,
        monthUsed: Math.max(0, Number(raw.monthUsed) || 0),
      };
    } catch {
      return { dayKey, dailyUsed: 0, monthKey, monthUsed: 0 };
    }
  }

  function saveQuota() {
    try {
      fs.mkdirSync(path.dirname(quotaFile), { recursive: true });
      const tmp = quotaFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(quotaState), 'utf8');
      fs.renameSync(tmp, quotaFile);
    } catch {}
  }

  function rolloverQuota(ms = nowFn()) {
    const { dayKey, monthKey } = utcKeys(ms);
    let dirty = false;
    if (quotaState.dayKey !== dayKey) {
      quotaState.dayKey = dayKey;
      quotaState.dailyUsed = 0;
      dirty = true;
    }
    if (quotaState.monthKey !== monthKey) {
      quotaState.monthKey = monthKey;
      quotaState.monthUsed = 0;
      dirty = true;
    }
    if (dirty) saveQuota();
    return quotaState;
  }

  function canSpendQuota(ms = nowFn()) {
    if (ms < cooldownUntil) return false;
    const q = rolloverQuota(ms);
    if (dailyCap > 0 && q.dailyUsed >= dailyCap) return false;
    if (monthCap > 0 && q.monthUsed >= monthCap) return false;
    return true;
  }

  function reserveQuotaSlot(ms = nowFn()) {
    if (!canSpendQuota(ms)) return null;
    const q = rolloverQuota(ms);
    q.dailyUsed += 1;
    q.monthUsed += 1;
    saveQuota();
    return { dayKey: q.dayKey, monthKey: q.monthKey };
  }

  function refundQuotaSlot(slot) {
    if (!slot) return;
    if (quotaState.dayKey === slot.dayKey && quotaState.dailyUsed > 0) quotaState.dailyUsed -= 1;
    if (quotaState.monthKey === slot.monthKey && quotaState.monthUsed > 0) quotaState.monthUsed -= 1;
    saveQuota();
  }

  function memBytes() {
    let n = 0;
    for (const v of memCache.values()) n += v.buf.length;
    return n;
  }

  function memSet(key, entry) {
    memCache.delete(key);
    memCache.set(key, entry);
    while (memCache.size > memCap || (memCache.size > 1 && memBytes() > memMaxBytes)) {
      memCache.delete(memCache.keys().next().value);
    }
  }

  function tilePath(z, x, y) {
    return path.join(cacheDir, `${z}_${x}_${y}.png`);
  }

  function makeEtag(buf) {
    return 'W/"s2-' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 14) + '"';
  }

  function readDiskTile(z, x, y) {
    const fp = tilePath(z, x, y);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size <= 0) return null;
      const buf = fs.readFileSync(fp);
      return { buf, at: st.mtimeMs, etag: makeEtag(buf) };
    } catch {
      return null;
    }
  }

  function writeDiskTile(z, x, y, buf) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const fp = tilePath(z, x, y);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, fp);
      if (++writeCount % 25 === 0) pruneDiskCache();
    } catch {}
  }

  function scanCacheStats() {
    try {
      const names = fs.readdirSync(cacheDir);
      let bytes = 0;
      let count = 0;
      for (const name of names) {
        if (!name.endsWith('.png')) continue;
        try {
          const st = fs.statSync(path.join(cacheDir, name));
          if (st.isFile()) { count++; bytes += st.size; }
        } catch {}
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  function pruneDiskCache() {
    try {
      const names = fs.readdirSync(cacheDir).filter(n => n.endsWith('.png'));
      const entries = [];
      let total = 0;
      for (const name of names) {
        const fp = path.join(cacheDir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          total += st.size;
          entries.push({ fp, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
      if (total <= maxCacheBytes) return;
      entries.sort((a, b) => a.mtime - b.mtime);
      const target = Math.floor(maxCacheBytes * 0.85);
      for (const item of entries) {
        if (total <= target) break;
        try { fs.unlinkSync(item.fp); total -= item.size; } catch {}
      }
    } catch {}
  }

  async function getAccessToken() {
    const now = nowFn();
    if (tokenState.token && now < tokenState.expiresAt - 60000) return tokenState.token;
    if (tokenInflight) return await tokenInflight;
    tokenInflight = (async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString();
      const res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }, 12000);
      if (!res || !res.ok) {
        const code = res ? res.status : 0;
        if (code === 401 || code === 403 || code === 429) cooldownUntil = nowFn() + 15 * 60000;
        throw new Error(`CDSE auth gagal (${code || 'network'})`);
      }
      const data = await res.json();
      const accessToken = String((data && data.access_token) || '');
      if (!accessToken) throw new Error('CDSE token kosong');
      const ttlSec = Math.max(120, Number(data.expires_in) || 600);
      tokenState = { token: accessToken, expiresAt: nowFn() + ttlSec * 1000 };
      return accessToken;
    })().finally(() => { tokenInflight = null; });
    return await tokenInflight;
  }

  async function fetchUpstreamTile(z, x, y) {
    const slot = reserveQuotaSlot(nowFn());
    if (!slot) {
      const err = new Error('CDSE daily/monthly cap tercapai');
      err.code = 'CAP';
      throw err;
    }
    try {
      return await upstreamSem(async () => {
        const token = await getAccessToken();
        const endMs = nowFn();
        const startMs = endMs - lookbackDays * 86400000;
        const payload = {
          input: {
            bounds: {
              properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/3857' },
              bbox: tileToBbox3857(z, x, y),
            },
            data: [{
              type: 'sentinel-2-l2a',
              dataFilter: {
                timeRange: {
                  from: new Date(startMs).toISOString(),
                  to: new Date(endMs).toISOString(),
                },
                mosaickingOrder: 'leastCC',
              },
            }],
          },
          output: {
            width: TILE_PX,
            height: TILE_PX,
            responses: [{ identifier: 'default', format: { type: 'image/png' } }],
          },
          evalscript: TRUE_COLOR_EVALSCRIPT,
        };
        const res = await fetchFn(PROCESS_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'image/png',
          },
          body: JSON.stringify(payload),
          maxBytes: 4 << 20,
        }, 20000);
        if (!res) throw new Error('CDSE tidak merespons');
        if (res.status === 401) {
          tokenState = { token: '', expiresAt: 0 };
          throw new Error('CDSE token ditolak (401)');
        }
        if (res.status === 429 || res.status === 402) {
          cooldownUntil = nowFn() + 15 * 60000;
          throw new Error(`CDSE kuota/rate limit (${res.status})`);
        }
        if (!res.ok) throw new Error(`CDSE HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        const buf = Buffer.from(ab);
        if (!buf.length) throw new Error('CDSE tile kosong');
        return buf;
      });
    } catch (err) {
      refundQuotaSlot(slot);
      throw err;
    }
  }

  function isConfigured() {
    return Boolean(clientId && clientSecret);
  }

  async function getTile(zRaw, xRaw, yRaw) {
    const z = Number(zRaw), x = Number(xRaw), y = Number(yRaw);
    const maxCoord = (1 << Math.max(0, Math.min(18, z | 0))) - 1;
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
        z < 0 || z > 18 || x < 0 || y < 0 || x > maxCoord || y > maxCoord) {
      return { status: 400, buf: Buffer.from('koordinat tile tidak valid'), ct: 'text/plain', cacheState: 'BAD-COORD' };
    }
    if (z < MIN_ZOOM || z > MAX_ZOOM || !tileIntersectsBounds(z, x, y)) {
      return { status: 204, buf: Buffer.alloc(0), ct: 'image/png', cacheState: 'OUT-OF-ROI' };
    }
    if (!isConfigured()) {
      return { status: 503, buf: Buffer.from('Copernicus CDSE credentials belum dikonfigurasi'), ct: 'text/plain', cacheState: 'UNCONFIGURED' };
    }
    const key = `${z}/${x}/${y}`;
    const now = nowFn();

    const mHit = memCache.get(key);
    if (mHit && now - mHit.at < cacheTtlMs) {
      memCache.delete(key);
      memCache.set(key, mHit);
      return { status: 200, buf: mHit.buf, ct: 'image/png', etag: mHit.etag, cacheState: 'HIT-MEM' };
    }

    const dHit = readDiskTile(z, x, y);
    if (dHit && now - dHit.at < cacheTtlMs) {
      memSet(key, dHit);
      return { status: 200, buf: dHit.buf, ct: 'image/png', etag: dHit.etag, cacheState: 'HIT-DISK' };
    }

    if (!canSpendQuota(now)) {
      if (dHit) {
        memSet(key, dHit);
        return { status: 200, buf: dHit.buf, ct: 'image/png', etag: dHit.etag, cacheState: 'STALE-CAP', stale: true };
      }
      return { status: 204, buf: Buffer.alloc(0), ct: 'image/png', cacheState: 'CAP-EXHAUSTED' };
    }

    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        const buf = await fetchUpstreamTile(z, x, y);
        const entry = { buf, at: nowFn(), etag: makeEtag(buf) };
        memSet(key, entry);
        writeDiskTile(z, x, y, buf);
        return entry;
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }

    try {
      const entry = await job;
      return { status: 200, buf: entry.buf, ct: 'image/png', etag: entry.etag, cacheState: 'MISS-FETCH' };
    } catch (e) {
      if (dHit) {
        memSet(key, dHit);
        return { status: 200, buf: dHit.buf, ct: 'image/png', etag: dHit.etag, cacheState: 'STALE-ERR', stale: true };
      }
      return { status: 204, buf: Buffer.alloc(0), ct: 'image/png', cacheState: 'ERR', error: String(e && e.message || e) };
    }
  }

  function getStatus() {
    const now = nowFn();
    const q = rolloverQuota(now);
    const stats = scanCacheStats();
    return {
      ok: true,
      configured: isConfigured(),
      dayKey: q.dayKey,
      monthKey: q.monthKey,
      dailyUsed: q.dailyUsed,
      dailyCap,
      monthUsed: q.monthUsed,
      monthCap,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      tileSize: TILE_PX,
      cacheTtlHours: +(cacheTtlMs / 3600000).toFixed(1),
      lookbackDays,
      cacheEntries: stats.count,
      cacheBytes: stats.bytes,
      cooldownSec: cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0,
    };
  }

  return {
    isConfigured,
    getTile,
    getStatus,
    pruneDiskCache,
    tileToBbox3857,
    tileToBbox4326,
    tileIntersectsBounds,
  };
}

module.exports = {
  createCopernicusProxy,
  tileToBbox3857,
  tileToBbox4326,
  tileIntersectsBounds,
  MIN_ZOOM,
  MAX_ZOOM,
  TILE_PX,
  ID_BOUNDS,
};
