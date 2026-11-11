'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

function makeLane(max, perHost, maxQueue = Infinity) {
  let n = 0, cancelled = 0; const per = new Map(); const q = [];
  const pump = () => {
    for (let i = 0; i < q.length && n < max;) {
      const j = q[i];
      if ((per.get(j.host) || 0) >= perHost) { i++; continue; }
      q.splice(i, 1);
      if (j.cleanup) j.cleanup();
      if (j.signal && j.signal.aborted) {
        cancelled++;
        const err = new Error('antrean dibatalkan klien');
        err.name = 'AbortError'; err.status = 499;
        j.rej(err);
        continue;
      }
      n++; per.set(j.host, (per.get(j.host) || 0) + 1);
      Promise.resolve().then(j.fn).then(j.res, j.rej).finally(() => {
        n--; const c = (per.get(j.host) || 1) - 1; if (c) per.set(j.host, c); else per.delete(j.host);
        pump();
      });
    }
  };
  return {
    run: (host, fn, signal = null) => new Promise((res, rej) => {
      if (signal && signal.aborted) {
        cancelled++;
        const err = new Error('antrean dibatalkan klien');
        err.name = 'AbortError'; err.status = 499;
        return rej(err);
      }
      if (q.length >= maxQueue) {
        const err = new Error('antrean gateway penuh');
        err.status = 503;
        return rej(err);
      }
      const j = { host, fn, res, rej, signal, cleanup: null };
      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          const idx = q.indexOf(j);
          if (idx >= 0) {
            q.splice(idx, 1);
            j.cleanup && j.cleanup();
            cancelled++;
            const err = new Error('antrean dibatalkan klien');
            err.name = 'AbortError'; err.status = 499;
            j.rej(err);
          }
        };
        j.cleanup = () => { try { signal.removeEventListener('abort', onAbort); } catch {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      q.push(j);
      pump();
    }),
    stats: () => ({ active: n, queued: q.length, maxQueue: Number.isFinite(maxQueue) ? maxQueue : null, hosts: per.size, cancelled })
  };
}

function makeBucket(rate, burst, now = Date.now) {
  const m = new Map();
  const ensure = (k, t) => {
    let b = m.get(k);
    if (!b) {
      b = { v: burst, t };
      m.set(k, b);
      if (m.size > 5000) m.delete(m.keys().next().value);
    }
    return b;
  };
  const take = (k, cost = 1) => {
    const t = now(); const b = ensure(k, t);
    b.v = Math.min(burst, b.v + (t - b.t) / 1000 * rate); b.t = t;
    if (b.v < cost) return false;
    b.v -= cost; return true;
  };

  const charge = (k, cost) => {
    const t = now(); const b = ensure(k, t);
    b.v = Math.min(burst, b.v + (t - b.t) / 1000 * rate) - cost;
    b.t = t;
  };
  const ok = k => { const b = m.get(k); if (!b) return true; const t = now(); return Math.min(burst, b.v + (t - b.t) / 1000 * rate) > 0; };
  return { take, charge, ok, size: () => m.size };
}

function makeLru(maxBytes, now = Date.now) {
  const m = new Map(); let bytes = 0;
  const del = k => { const e = m.get(k); if (e) { bytes -= e.size; m.delete(k); } };
  return {
    get(k) { const e = m.get(k); if (!e) return null; if (now() > e.exp) { del(k); return null; } m.delete(k); m.set(k, e); return e.v; },
    set(k, v, size, ttl) {
      if (size > maxBytes) return;
      del(k); m.set(k, { v, size, exp: now() + ttl }); bytes += size;
      while (bytes > maxBytes && m.size) del(m.keys().next().value);
    },
    stats: () => ({ entries: m.size, bytes })
  };
}

function createGateway(d) {
  const {
    getRaw,
    hostAllowed,
    headersFor,
    rewriteUrl,
    px,
    trustProxy = false,
    allowCors: allowCorsTop,
    allowPublicCache: allowPublicCacheTop,
    getClientIp: injectedClientIp,
    rateKey: injectedRateKey,
    isKnown = () => true,
    isKnownHost = () => true,
  } = d;
  const O = Object.assign({
    maxActive: 48, perHost: 8, maxQueue: 64, snapActive: 2, snapMaxQueue: 16,
    segCacheBytes: 64 << 20, segTtl: 30000, segCacheMax: 16 << 20, segMax: 25 << 20,
    plMin: 500, plMax: 2500,
    reqRate: 40, reqBurst: 200, byteRate: 3 << 20, byteBurst: 120 << 20,
    globalByteRate: 45 << 20, globalByteBurst: 180 << 20,
    snapTtl: 90000, upstreamMs: 25000
  }, d.options || {});
  const allowCors = allowCorsTop !== undefined ? Boolean(allowCorsTop) : (O.allowCors !== undefined ? Boolean(O.allowCors) : true);
  const allowPublicCache = Boolean(allowPublicCacheTop || O.allowPublicCache);

  const lane = makeLane(O.maxActive, O.perHost, O.maxQueue);
  const snapLane = makeLane(O.snapActive, O.snapActive, O.snapMaxQueue);
  const reqRl = makeBucket(O.reqRate, O.reqBurst);
  const byteRl = makeBucket(O.byteRate, O.byteBurst);
  const byteGlobal = makeBucket(O.globalByteRate, O.globalByteBurst);
  const cache = makeLru(O.segCacheBytes);
  const inflight = new Map();
  const m = { req: 0, hit: 0, coalesced: 0, upstream: 0, rl: 0, globalRl: 0, bytesOut: 0, errors: 0, aborted: 0, rejected503: 0 };
  const normIp = typeof injectedRateKey === 'function' ? injectedRateKey : (v => v);

  const clientIp = req => {
    let raw;
    if (typeof injectedClientIp === 'function') raw = injectedClientIp(req, trustProxy);
    else if (trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (xf.length) {
        const hops = Math.max(1, Number(process.env.SITREP_TRUSTED_HOPS) || 1);
        raw = xf[Math.max(0, xf.length - hops)];
      }
    }
    return normIp(raw || (req.socket && req.socket.remoteAddress) || 'x');
  };
  const chargeBytes = (ip, n) => {
    m.bytesOut += n;
    if (ip) byteRl.charge(ip, n);
    byteGlobal.charge('_', n);
  };
  const corsHdr = allowCors ? { 'access-control-allow-origin': '*' } : {};
  const secHdr = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" };
  const base = { ...corsHdr, ...secHdr, 'cache-control': 'no-store' };
  const segCacheHdr = allowCors ? 'public, max-age=60' : 'private, max-age=60';
  const plCacheHdr = allowCors ? 'public, max-age=1' : 'no-store';
  const deny = (res, code, extra) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { ...base, ...(extra || {}) }); res.end();
  };
  const rate = (req, res) => {
    const ip = clientIp(req);
    const globalOk = byteGlobal.take('_', 0);
    if (!globalOk || !reqRl.take(ip, 1) || !byteRl.take(ip, 0)) {
      m.rl++;
      if (!globalOk) m.globalRl++;
      deny(res, 429, { 'retry-after': '5' });
      return null;
    }
    return ip;
  };

  function canonicalKey(raw) {
    try {
      const u = new URL(raw);
      if (/(^|\.)pantaucctv\.com$/i.test(u.hostname) && u.searchParams.has('t')) {
        const t = u.searchParams.get('t') || '';
        const b64 = t.split('.')[0];
        if (b64) {
          try {
            const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
            const inner = payload && (payload.u || payload.url || payload.stream);
            if (typeof inner === 'string') {
              const iu = new URL(inner);
              return 'pc:' + iu.host.toLowerCase() + iu.pathname;
            }
          } catch {}
        }
        u.searchParams.delete('t');
        return 'pc:' + u.host.toLowerCase() + u.pathname + u.search;
      }
      if (/^cctv\.molecool\.id$/i.test(u.hostname)) {
        return 'mc:' + u.pathname;
      }
      if (/(^|\.)dpuprkotang\.info$/i.test(u.hostname)) {
        const src = (u.searchParams.get('src') || '').toLowerCase();
        return 'kt:' + u.pathname.toLowerCase() + ':' + src;
      }
    } catch {}
    return raw;
  }

  function resolveDirectSnapUrl(raw) {
    try {
      const u = new URL(raw);
      if (/(^|\.)dpuprkotang\.info$/i.test(u.hostname)) {
        u.pathname = '/api/frame.jpeg';
        u.searchParams.delete('t');
        u.searchParams.delete('v');
        return u.href;
      }
      if (/\/api\/frame\.jpe?g|\/preview\.jpe?g|\.(?:jpe?g|png|webp)(?:\?|#|$)/i.test(u.pathname)) {
        u.searchParams.delete('t');
        u.searchParams.delete('v');
        return u.href;
      }
      if (/(^|\.)dsdajakarta\.id$/i.test(u.hostname) || /(^|\.)dsdadki\.web\.id$/i.test(u.hostname)) {
        return u.href;
      }
    } catch {}
    return null;
  }

  function rewritePlaylist(txt, furl) {
    return txt.split('\n').map(l => {
      const t = l.trim(); if (!t) return l;
      if (t[0] === '#') return t.replace(/URI="([^"]+)"/g, (mm, p) => 'URI="' + px(new URL(p, furl).href) + '"');
      return px(new URL(t, furl).href);
    }).join('\n');
  }
  const plTtl = txt => {
    if (/#EXT-X-ENDLIST/.test(txt)) return 30000;
    const td = +((/#EXT-X-TARGETDURATION:(\d+)/.exec(txt) || [])[1] || 4);
    return Math.max(O.plMin, Math.min(O.plMax, td * 250));
  };
  const sendEntry = (res, e, ip) => {
    if (res.writableEnded || res.destroyed) return;
    if (e.status !== 200) {
      if (e.status === 503) m.rejected503++;
      const extra = e.status === 503 ? { 'retry-after': '3' } : {};
      res.writeHead(e.status, { ...base, ...extra });
      return res.end();
    }
    const buf = e.buf;
    const cc = e.pl ? plCacheHdr : segCacheHdr;
    chargeBytes(ip, buf.length);
    res.writeHead(200, { ...base, 'cache-control': cc, 'content-type': e.ct, 'content-length': buf.length });
    res.end(buf);
  };
  const waitDrain = res => new Promise(ok => {
    if (!res || res.destroyed || res.writableEnded) return ok();
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      res.off('drain', fin);
      res.off('close', fin);
      res.off('error', fin);
      ok();
    };
    res.once('drain', fin);
    res.once('close', fin);
    res.once('error', fin);
    if (res.destroyed || res.writableEnded) fin();
  });

  function sanitizeMediaCt(ct, url = '') {
    const low = String(ct || '').split(';')[0].trim().toLowerCase();
    if (!low || low === 'text/vnd.trolltech.linguist' || low === 'text/plain') return 'video/mp2t';
    if (/\.ts(?:\?|#|$)/i.test(url) && (low.startsWith('text/') || low === 'application/octet-stream')) return 'video/mp2t';
    if (/\.m4s(?:\?|#|$)/i.test(url)) return 'video/iso.segment';
    if (/^(?:text\/html|application\/xhtml|image\/svg|text\/javascript|application\/javascript)/i.test(low)) return 'application/octet-stream';
    return low;
  }

  function startFlight(key, url, host, keepBackground) {
    const ac = new AbortController();
    const fl = {
      key,
      ac,
      subscribers: new Set(),
      bgRef: keepBackground ? 1 : 0,
      chunks: [],
      total: 0,
      collect: true,
      isPl: null,
      ct: '',
      status: 0,
      aborted: false,
      promise: null
    };
    const maybeAbortUpstream = () => {
      if (fl.subscribers.size === 0 && fl.bgRef === 0 && !fl.aborted) {
        fl.aborted = true;
        m.aborted++;
        try { fl.ac.abort(); } catch {}
      }
    };
    fl.attach = (res, ip) => {
      if (!res || res.destroyed || res.writableEnded) return () => {};
      const sub = { res, ip, headersSent: false, queue: Promise.resolve(), closed: false };
      fl.subscribers.add(sub);
      const onClose = () => {
        sub.closed = true;
        fl.subscribers.delete(sub);
        maybeAbortUpstream();
      };
      res.once('close', onClose);
      res.once('error', onClose);

      if (fl.isPl === false && fl.status === 200 && !fl.collect) {

        fl.subscribers.delete(sub);
        res.off('close', onClose);
        res.off('error', onClose);
        return null;
      }
      if (fl.isPl === false && fl.status === 200) {
        const backlog = fl.chunks.slice();
        sub.queue = sub.queue.then(async () => {
          if (sub.closed || res.destroyed || res.writableEnded) return;
          res.writeHead(200, { ...base, 'cache-control': segCacheHdr, 'content-type': fl.ct });
          sub.headersSent = true;
          for (const prev of backlog) {
            if (sub.closed || res.destroyed || res.writableEnded) return;
            chargeBytes(ip, prev.length);
            if (!res.write(prev)) await waitDrain(res);
          }
        }).catch(() => {});
      }
      return () => {
        res.off('close', onClose);
        res.off('error', onClose);
        fl.subscribers.delete(sub);
      };
    };

    const pushChunk = b => {
      for (const sub of fl.subscribers) {
        if (sub.closed || sub.res.destroyed || sub.res.writableEnded) continue;
        sub.queue = sub.queue.then(async () => {
          if (sub.closed || sub.res.destroyed || sub.res.writableEnded) return;
          chargeBytes(sub.ip, b.length);
          if (!sub.headersSent) {
            sub.res.writeHead(200, { ...base, 'cache-control': segCacheHdr, 'content-type': fl.ct });
            sub.headersSent = true;
          }
          if (!sub.res.write(b)) await waitDrain(sub.res);
        }).catch(() => {});
      }
    };

    const endSubscribers = async () => {
      const waits = [];
      for (const sub of fl.subscribers) {
        waits.push(sub.queue.then(() => {
          if (!sub.closed && !sub.res.destroyed && !sub.res.writableEnded) {
            if (!sub.headersSent && fl.status === 200) {
              sub.res.writeHead(200, { ...base, 'cache-control': segCacheHdr, 'content-type': fl.ct });
            }
            sub.res.end();
          }
        }).catch(() => {}));
      }
      await Promise.all(waits);
    };

    fl.promise = lane.run(host, async () => {
      if (fl.aborted) return { status: 499, noCache: true };
      m.upstream++;
      let g;
      try { g = await getRaw(url, O.upstreamMs, headersFor(url), hostAllowed, fl.ac.signal); }
      catch (e) { if (!fl.aborted) m.errors++; return { status: fl.aborted ? 499 : 502, noCache: true }; }
      const r = g.r, furl = g.url, ct = r.headers.get('content-type') || '';
      if (!r.ok) { try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) {} return { status: r.status, noCache: true }; }
      const isPl = /mpegurl/i.test(ct) || /\.m3u8(\?|#|$)/i.test(furl);
      fl.isPl = isPl;
      fl.ct = isPl ? 'application/vnd.apple.mpegurl' : sanitizeMediaCt(ct, furl);
      fl.status = 200;
      const reader = r.body && r.body.getReader ? r.body.getReader() : null;
      const limit = isPl ? 2 << 20 : O.segMax;
      try {
        if (!reader) {
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > limit) return { status: 413, noCache: true };
          fl.chunks.push(b); fl.total = b.length;
        } else {
          for (;;) {
            if (fl.aborted) { try { await reader.cancel(); } catch {} return { status: 499, noCache: true }; }
            const { done, value } = await reader.read();
            if (done) break;
            fl.total += value.length;
            if (fl.total > limit) {
              try { await reader.cancel(); } catch {}
              for (const sub of fl.subscribers) { if (sub.headersSent && !sub.res.destroyed) sub.res.destroy(); }
              return { status: 413, noCache: true };
            }
            const b = Buffer.from(value);
            if (fl.collect) {
              if (fl.total > O.segCacheMax && !isPl) {
                fl.collect = false;
                if (fl.bgRef === 0) fl.chunks.length = 0;
                else {

                  let kept = 0, cut = 0;
                  while (cut < fl.chunks.length && kept < (2 << 20)) kept += fl.chunks[cut++].length;
                  fl.chunks.length = cut;
                }
              } else {
                fl.chunks.push(b);
              }
            }
            if (!isPl) pushChunk(b);
          }
        }
      } catch (e) {
        if (!fl.aborted) m.errors++;
        for (const sub of fl.subscribers) { if (sub.headersSent && !sub.res.destroyed) sub.res.destroy(); }
        return { status: fl.aborted ? 499 : 502, noCache: true };
      }
      if (isPl) {
        let txt = Buffer.concat(fl.chunks).toString('utf8');
        if (!txt.includes('#EXTM3U')) return { status: 502, noCache: true };
        try { txt = rewritePlaylist(txt, furl); } catch (e) { return { status: 502, noCache: true }; }
        const buf = Buffer.from(txt);
        return { status: 200, ct: 'application/vnd.apple.mpegurl', buf, ttl: plTtl(txt), pl: true };
      }
      await endSubscribers();
      const buf = fl.collect ? Buffer.concat(fl.chunks) : null;
      return { status: 200, ct: fl.ct, buf, snapPrefix: (!fl.collect && fl.bgRef > 0 && fl.chunks.length) ? Buffer.concat(fl.chunks) : null, ttl: O.segTtl, streamed: true };
    }, fl.ac.signal);
    return fl;
  }

  async function hls(rawUrl, req, res) {
    m.req++;
    if (req.destroyed || res.destroyed) return;
    const ip = rate(req, res); if (!ip) return;
    if (!rawUrl || !hostAllowed(rawUrl)) return deny(res, 403);
    let url = rawUrl;
    try { url = await rewriteUrl(rawUrl); } catch (e) {}
    if (req.destroyed || res.destroyed) return;
    let host; try { host = new URL(url).host; } catch (e) { return deny(res, 400); }
    const key = canonicalKey(url);
    const hit = cache.get(key);
    if (hit) { m.hit++; return sendEntry(res, hit, ip); }

    let fl = inflight.get(key);
    let isLeader = false;
    if (fl) {
      m.coalesced++;
    } else {
      isLeader = true;
      fl = startFlight(key, url, host, false);
      inflight.set(key, fl);
    }

    const detach = fl.attach(res, ip);
    if (detach === null) {

      const solo = startFlight(key + '#solo', url, host, false);
      const soloDetach = solo.attach(res, ip);
      let se;
      try { se = await solo.promise; } catch (err) { se = { status: (err && err.status) || 502, noCache: true }; }
      if (soloDetach) soloDetach();
      return finish(res, se, ip);
    }

    let e;
    try { e = await fl.promise; } catch (err) { e = { status: (err && err.status) || 502, noCache: true }; }
    if (isLeader) {
      inflight.delete(key);
      if (e.status === 200 && e.buf && !e.noCache) cache.set(key, e, e.buf.length, e.ttl);
    }
    if (detach) detach();
    finish(res, e, ip);
  }
  function finish(res, e, ip) {
    if (!res || res.writableEnded || res.destroyed) return;
    if (e.streamed && res.headersSent) return res.end();
    if (res.headersSent) return res.end();
    if (e.status === 200 && e.buf) return sendEntry(res, e, ip);
    return sendEntry(res, { status: e.status || 502 }, ip);
  }

  async function getBuffered(url) {
    const key = canonicalKey(url);
    const hit = cache.get(key); if (hit && hit.buf) return hit;
    let fl = inflight.get(key);
    let isLeader = false;
    if (fl) {
      fl.bgRef++;
    } else {
      isLeader = true;
      const host = new URL(url).host;
      fl = startFlight(key, url, host, true);
      inflight.set(key, fl);
    }
    let e;
    try { e = await fl.promise; }
    finally {
      fl.bgRef = Math.max(0, fl.bgRef - 1);
      if (isLeader) {
        inflight.delete(key);
        if (e && e.status === 200 && e.buf && !e.noCache) cache.set(key, e, e.buf.length, e.ttl);
      }
    }
    return e;
  }
  const upstreamOf = pxUrl => { try { return new URL(pxUrl, 'http://x').searchParams.get('u') || pxUrl; } catch (e) { return pxUrl; } };

  let ffmpegOk = null;
  const ffbin = d.ffmpeg || process.env.FFMPEG_PATH || (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  function detectFfmpeg() {
    if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
    return new Promise(ok => {
      try {
        const c = spawn(ffbin, ['-version'], { stdio: 'ignore' });
        c.on('error', () => { ffmpegOk = false; ok(false); });
        c.on('exit', code => { ffmpegOk = code === 0; ok(ffmpegOk); });
      } catch (e) { ffmpegOk = false; ok(false); }
    });
  }
  const snaps = makeLru(24 << 20), snapIn = new Map(), snapFail = new Map();
  function jpegFrom(buf) {
    return new Promise((ok, no) => {
      const c = spawn(ffbin, ['-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '7', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const out = []; let size = 0;
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) {} no(new Error('ffmpeg timeout')); }, 9000);
      c.stdout.on('data', x => { size += x.length; if (size > 1 << 20) { try { c.kill('SIGKILL'); } catch (e) {} } else out.push(x); });
      c.on('error', e => { clearTimeout(t); no(e); });
      c.on('close', () => { clearTimeout(t); size > 0 && size <= 1 << 20 ? ok(Buffer.concat(out)) : no(new Error('ffmpeg kosong')); });
      c.stdin.on('error', () => {});
      c.stdin.end(buf);
    });
  }
  async function snapshotFor(url, signal) {
    const directUrl = resolveDirectSnapUrl(url);
    if (directUrl) {
      m.upstream++;
      const g = await getRaw(directUrl, O.upstreamMs, headersFor(directUrl), hostAllowed, signal);
      const r = g.r;
      if (!r.ok) {
        try { r.body && r.body.cancel && await r.body.cancel(); } catch (e) {}
        throw new Error('snap ' + r.status);
      }
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('multipart/x-mixed-replace')) {
        const reader = r.body && r.body.getReader ? r.body.getReader() : null;
        if (!reader) throw new Error('stream mjpeg tidak dapat dibaca');
        const chunks = [];
        let totalLen = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalLen += value.length;
            const b = Buffer.concat(chunks, totalLen);
            const start = b.indexOf(Buffer.from([0xff, 0xd8]));
            if (start !== -1) {
              const end = b.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
              if (end !== -1 && (end + 2 - start) >= 1024) {
                try { reader.cancel(); } catch (e) {}
                return b.slice(start, end + 2);
              }
            }
            if (totalLen > (2 << 20)) { try { reader.cancel(); } catch (e) {} break; }
          }
        } catch (e) {
          try { reader.cancel(); } catch (err) {}
          throw e;
        }
        throw new Error('mjpeg frame tidak ditemukan');
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 128 || buf.length > (4 << 20)) throw new Error('snap kosong');
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      if (!ct.startsWith('image/') && !isJpeg && !isPng) throw new Error('snap bukan gambar');
      return buf;
    }
    let cur = url;
    for (let i = 0; i < 4; i++) {
      const e = await getBuffered(cur);
      if (e.status !== 200 || !e.buf) throw new Error('playlist ' + e.status);
      const txt = e.buf.toString('utf8');
      const lines = txt.split('\n').map(s => s.trim()).filter(s => s && s[0] !== '#');
      if (!lines.length) throw new Error('playlist kosong');
      if (/#EXT-X-STREAM-INF/.test(txt)) { cur = new URL(upstreamOf(lines[0]), cur).href; continue; }
      const mapMatch = txt.match(/#EXT-X-MAP:URI="([^"]+)"/);
      let initBuf = null;
      if (mapMatch) {
        try {
          const initUrl = new URL(upstreamOf(mapMatch[1]), cur).href;
          const ie = await getBuffered(initUrl);
          if (ie && ie.status === 200 && ie.buf) initBuf = ie.buf;
        } catch (e) {}
      }
      const seg = new URL(upstreamOf(lines[lines.length - 1]), cur).href;
      const s = await getBuffered(seg);
      let segBuf = (s && (s.buf || s.snapPrefix)) || null;
      if (!s || s.status !== 200 || !segBuf) throw new Error('segmen ' + (s ? s.status : 502));
      if (initBuf) segBuf = Buffer.concat([initBuf, segBuf]);
      return jpegFrom(segBuf);
    }
    throw new Error('terlalu dalam');
  }
  async function snap(rawUrl, req, res) {
    if (req.destroyed || res.destroyed) return;
    const ip = rate(req, res); if (!ip) return;
    if (!rawUrl || !hostAllowed(rawUrl)) return deny(res, 403);
    const directUrl = resolveDirectSnapUrl(rawUrl);
    if (!directUrl && !(await detectFfmpeg())) return deny(res, 501);
    const maxAge = directUrl ? 15 : 60;
    const jh = { ...corsHdr, ...secHdr, 'content-type': 'image/jpeg', 'cache-control': (allowCors || allowPublicCache) ? `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}` : `private, max-age=${maxAge}` };
    const snapKey = canonicalKey(directUrl || rawUrl);
    const hit = snaps.get(snapKey);
    if (hit) { res.writeHead(200, jh); return res.end(hit); }
    const f = snapFail.get(snapKey); if (f && f > Date.now()) return deny(res, 503, { 'retry-after': '30' });
    let entry = snapIn.get(snapKey);
    if (!entry) {
      const ac = new AbortController();
      const flight = {
        ac,
        waiters: 0,
        promise: snapLane.run('snap', async () => {
          let u = directUrl || rawUrl; try { u = await rewriteUrl(u); } catch (e) {}
          return snapshotFor(u, ac.signal);
        }, ac.signal),
      };
      flight.promise.finally(() => snapIn.delete(snapKey)).catch(() => {});
      entry = flight;
      snapIn.set(snapKey, entry);
    }
    entry.waiters++;
    const onClose = () => {
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters === 0) { try { entry.ac.abort(); } catch {} }
    };
    req.once('close', onClose);
    let jpg;
    try {
      jpg = await entry.promise;
    } catch (e) {
      req.off('close', onClose);
      if (!e || (e.status !== 503 && e.status !== 499)) {
        snapFail.set(snapKey, Date.now() + (directUrl ? 15000 : 45000));
        if (snapFail.size > 2000) snapFail.delete(snapFail.keys().next().value);
      }
      return deny(res, 503, { 'retry-after': e && e.status === 503 ? '5' : (directUrl ? '15' : '45') });
    }
    req.off('close', onClose);
    if (!jpg || res.destroyed || res.writableEnded) return;
    snaps.set(snapKey, jpg, jpg.length, directUrl ? Math.min(O.snapTtl, 15000) : O.snapTtl);
    res.writeHead(200, jh); res.end(jpg); chargeBytes(ip, jpg.length);
  }

  const reports = new Map();
  const repRl = makeBucket(1, 30);
  const DEAD_WINDOW = 1200000;
  const hashIp = ip => crypto.createHash('sha1').update(String(ip)).digest('hex').slice(0, 12);
  function report(u, ok, ip) {
    if (!u || typeof u !== 'string' || u.length > 500) return false;
    if (!repRl.take(ip || 'x', 1)) return false;
    if (!isKnown(u)) return false;
    const now = Date.now();
    let r = reports.get(u);
    if (!r) { r = { fails: new Map(), okAt: 0 }; reports.set(u, r); }
    if (ok) { r.okAt = now; r.fails.clear(); }
    else r.fails.set(hashIp(ip), now);
    if (reports.size > 5000) {
      for (const [k, v] of reports) { const last = Math.max(v.okAt, ...v.fails.values(), 0); if (now - last > 3600000) reports.delete(k); }
    }
    return true;
  }
  const reportedDead = u => {
    const r = reports.get(u); if (!r) return false;
    const now = Date.now(); let n = 0;
    for (const t of r.fails.values()) if (now - t < DEAD_WINDOW && t > r.okAt) n++;
    return n >= 2;
  };

  const rum = new Map();
  const rumRl = makeBucket(0.5, 10);
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  function rumIngest(events, ip) {
    if (!Array.isArray(events) || !rumRl.take(ip || 'x', 1)) return 0;
    let n = 0;
    for (const e of events.slice(0, 100)) {
      if (!e || typeof e.h !== 'string' || e.h.length > 120 || !/^[a-z0-9.:-]+$/i.test(e.h)) continue;
      if (!isKnownHost(e.h)) continue;
      let s = rum.get(e.h);
      if (!s) { if (rum.size >= 300) continue; s = { ok: 0, fail: 0, stalls: 0, ttff: [] }; rum.set(e.h, s); }
      if (e.f) s.fail++;
      else if (Number.isFinite(e.t) && e.t >= 0 && e.t < 300000) { s.ok++; s.ttff.push(Math.round(e.t)); if (s.ttff.length > 300) s.ttff.shift(); }
      if (Number.isFinite(e.s) && e.s > 0 && e.s < 1000) s.stalls += e.s | 0;
      n++;
    }
    return n;
  }
  const rumStats = () => {
    const hosts = {};
    for (const [h, s] of rum) hosts[h] = { ok: s.ok, fail: s.fail, stalls: s.stalls, ttff_p50: q(s.ttff, 0.5), ttff_p95: q(s.ttff, 0.95) };
    return hosts;
  };

  return {
    hls, snap, report, reportedDead, rumIngest, rumStats, detectFfmpeg,
    stats: () => ({ ...m, lane: lane.stats(), snapLane: snapLane.stats(), cache: cache.stats(), snapCache: snaps.stats(), inflight: inflight.size, reports: reports.size })
  };
}

module.exports = { createGateway, makeLane, makeBucket, makeLru };
