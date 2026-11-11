'use strict';
const { monitorEventLoopDelay } = require('perf_hooks');

function createMetricsService() {
  const LAT_BUCKETS = [5, 15, 50, 150, 500, 1500, 5000];
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  function newLatHist() {
    return { buckets: new Array(LAT_BUCKETS.length + 1).fill(0), count: 0, sumMs: 0 };
  }
  function addLatSample(h, ms) {
    const v = Math.max(0, Number(ms) || 0);
    h.count++;
    h.sumMs += v;
    let bi = LAT_BUCKETS.length;
    for (let i = 0; i < LAT_BUCKETS.length; i++) {
      if (v <= LAT_BUCKETS[i]) { bi = i; break; }
    }
    h.buckets[bi]++;
  }
  function quantileFromHist(h, q) {
    if (!h || !h.count) return 0;
    const target = Math.ceil(h.count * q);
    let cum = 0;
    for (let i = 0; i < LAT_BUCKETS.length; i++) {
      cum += h.buckets[i];
      if (cum >= target) return LAT_BUCKETS[i];
    }
    return LAT_BUCKETS[LAT_BUCKETS.length - 1];
  }
  const METRICS = {
    startedAt: Date.now(),
    reqTotal: 0,
    rejected429: 0,
    rejected403: 0,
    rejected503: 0,
    outboundBlocked: 0,
    proxyWarning: false,
    cacheHits: 0,
    bytesOut: 0,
    bytesWindow: [],
    latency: newLatHist(),
    routes: new Map(),
    upstream: new Map(),
  };
  function addBytesOut(n) {
    if (!n || n <= 0) return;
    METRICS.bytesOut += n;
    const sec = Math.floor(Date.now() / 1000);
    const w = METRICS.bytesWindow;
    const last = w[w.length - 1];
    if (last && last.sec === sec) last.bytes += n;
    else {
      w.push({ sec, bytes: n });
      while (w.length > 15) w.shift();
    }
  }
  function originBytesPerSec() {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - 9;
    let sum = 0;
    for (const b of METRICS.bytesWindow) if (b.sec >= cutoff) sum += b.bytes;
    const span = Math.max(1, Math.min(10, Math.floor((Date.now() - METRICS.startedAt) / 1000) || 1));
    return Math.round(sum / span);
  }
  function normalizeMetricRoute(route) {
    if (!route) return 'other';
    if (/^\/(?:signals|wxicons|wire-core|cctv-core)\.[a-f0-9]{8}\.js$/.test(route)) return '/asset.js';
    if (route.startsWith('/tomtom/tile/')) return '/tomtom/tile/*';
    if (METRICS.routes.has(route) || METRICS.routes.size < 80) return route;
    return 'other';
  }
  function metricInc(route, status) {
    METRICS.reqTotal++;
    if (status === 429) METRICS.rejected429++;
    else if (status === 403) METRICS.rejected403++;
    else if (status === 503) METRICS.rejected503++;
  }
  function recordRequestMetric(route, status, ms, cacheHit, bytesOut) {
    addLatSample(METRICS.latency, ms);
    addBytesOut(bytesOut);
    const key = normalizeMetricRoute(route);
    let r = METRICS.routes.get(key);
    if (!r) {
      r = { count: 0, err: 0, cacheHits: 0, bytesOut: 0, lat: newLatHist() };
      METRICS.routes.set(key, r);
    }
    r.count++;
    if (status >= 400) r.err++;
    if (cacheHit) r.cacheHits++;
    r.bytesOut += bytesOut || 0;
    addLatSample(r.lat, ms);
  }
  function recordUpstream(provider, ok, ms) {
    const k = String(provider || 'other').slice(0, 24);
    let u = METRICS.upstream.get(k);
    if (!u) {
      if (METRICS.upstream.size >= 32) return;
      u = { count: 0, err: 0, lat: newLatHist() };
      METRICS.upstream.set(k, u);
    }
    u.count++;
    if (!ok) u.err++;
    addLatSample(u.lat, ms);
  }
  return {
    LAT_BUCKETS,
    eventLoopDelay,
    newLatHist,
    addLatSample,
    quantileFromHist,
    METRICS,
    addBytesOut,
    originBytesPerSec,
    normalizeMetricRoute,
    metricInc,
    recordRequestMetric,
    recordUpstream,
  };
}

module.exports = { createMetricsService };
