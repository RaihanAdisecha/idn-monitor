'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INCOMPLETE_CHAIN_ERR = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/i;
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[?(::1|fe80:.*|fc00:.*|fd[0-9a-f]{2}:.*|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0))\]?)$/i;

function rdIPv4Bytes(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const b = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return b.every(x => x >= 0 && x <= 255) ? b : null;
}

function rdPrivateBytes(b) {
  if (!b) return true;
  const [a, x, y] = b;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && x >= 64 && x <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && x === 254) return true;
  if (a === 172 && x >= 16 && x <= 31) return true;
  if (a === 192 && x === 0 && (y === 0 || y === 2)) return true;
  if (a === 192 && x === 168) return true;
  if (a === 198 && (x === 18 || x === 19)) return true;
  if (a === 198 && x === 51 && y === 100) return true;
  if (a === 203 && x === 0 && y === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIPv6(rawIp) {
  const s = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s || net.isIP(s) !== 6) return null;

  let work = s;
  const lastColon = work.lastIndexOf(':');
  if (lastColon >= 0 && work.slice(lastColon + 1).includes('.')) {
    const v4 = rdIPv4Bytes(work.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    work = work.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  const dbl = work.split('::');
  if (dbl.length > 2) return null;
  if (dbl.length === 2) {
    const left = dbl[0] ? dbl[0].split(':') : [];
    const right = dbl[1] ? dbl[1].split(':') : [];
    const fill = 8 - (left.length + right.length);
    if (fill < 1) return null;
    const full = [...left, ...new Array(fill).fill('0'), ...right];
    if (full.length !== 8) return null;
    return full.map(h => parseInt(h, 16));
  }
  const parts = work.split(':');
  if (parts.length !== 8) return null;
  return parts.map(h => parseInt(h, 16));
}

function rdPrivateIP(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s) return true;
  const v4 = rdIPv4Bytes(s);
  if (v4) return rdPrivateBytes(v4);
  if (net.isIP(s) !== 6) return true;

  const h = expandIPv6(s);
  if (!h || h.some(Number.isNaN)) return true;

  const isZeroPrefix5 = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0;

  if (isZeroPrefix5 && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true;

  if (isZeroPrefix5 && (h[5] === 0xffff || h[5] === 0)) {
    return rdPrivateBytes([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }

  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0xffff && h[4] === 0 && h[5] === 0) {
    return rdPrivateBytes([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }

  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    if (h[2] === 1) return true;
    if (h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      return rdPrivateBytes([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
    }
  }

  if (h[0] === 0x2002) {
    return rdPrivateBytes([h[1] >> 8, h[1] & 0xff, h[2] >> 8, h[2] & 0xff]);
  }
  if (h[0] === 0x2001 && h[1] === 0x0000) return true;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;
  if ((h[0] & 0xfe00) === 0xfc00) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true;
  if ((h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xff00) === 0xff00) return true;
  return false;
}

function publicURL(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 4096) return null;
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    const h = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    if (!h) return null;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return null;
    if (PRIVATE_HOST.test(h)) return null;
    if (net.isIP(h) && rdPrivateIP(h)) return null;
    return u;
  } catch {
    return null;
  }
}

function extractPemCerts(pemText) {
  const matches = String(pemText || '').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches ? matches.map(m => m.trim()) : [];
}

function loadTrustedRoots(extraPaths = []) {
  const list = Array.isArray(extraPaths) ? extraPaths : [extraPaths];
  const rawPems = [...tls.rootCertificates];
  for (const p of list) {
    const fp = String(p || '').trim();
    if (!fp) continue;
    try {
      const text = fs.readFileSync(fp, 'utf8');
      rawPems.push(...extractPemCerts(text));
    } catch (e) {
      console.error('[security] gagal memuat extra CA dari ' + fp + ': ' + e.message);
    }
  }

  const pems = [];
  const seen = new Set();
  const bySubject = new Map();
  const byFingerprint = new Set();

  for (const pem of rawPems) {
    try {
      const x509 = new crypto.X509Certificate(pem);
      if (seen.has(x509.fingerprint256)) continue;
      seen.add(x509.fingerprint256);
      pems.push(pem);
      byFingerprint.add(x509.fingerprint256);
      const arr = bySubject.get(x509.subject) || [];
      arr.push(x509);
      bySubject.set(x509.subject, arr);
    } catch {}
  }
  const secureContext = tls.createSecureContext(pems.length ? { ca: pems } : {});
  return { pems, bySubject, byFingerprint, secureContext };
}

const DEFAULT_TRUSTED_ROOTS = loadTrustedRoots(
  String(process.env.SITREP_EXTRA_CA || '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
);

function isCertTimeValid(cert, nowMs = Date.now()) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && nowMs >= from && nowMs <= to;
}

function isVerifiedByTrustedRoot(cert, trustedRoots, nowMs = Date.now()) {
  if (trustedRoots.byFingerprint.has(cert.fingerprint256)) {
    return isCertTimeValid(cert, nowMs);
  }
  const cands = trustedRoots.bySubject.get(cert.issuer) || [];
  for (const root of cands) {
    if (!root.ca) continue;
    if (!isCertTimeValid(root, nowMs)) continue;
    if (cert.checkIssued(root) && cert.verify(root.publicKey)) return true;
  }
  return false;
}

function parseAiaUrls(cert) {
  const info = String(cert && cert.infoAccess || '');
  const out = [];
  for (const line of info.split(/\r?\n/)) {
    const m = /CA Issuers\s*-\s*URI:(https?:\/\/\S+)/i.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseCertBuffer(buf) {
  if (!buf || !buf.length) throw new Error('sertifikat AIA kosong');
  const head = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8');
  if (head.includes('-----BEGIN CERTIFICATE-----')) {
    const pems = extractPemCerts(buf.toString('utf8'));
    if (!pems.length) throw new Error('PEM AIA tidak berisi sertifikat');
    return new crypto.X509Certificate(pems[0]);
  }
  return new crypto.X509Certificate(buf);
}

function derToPem(rawBuf) {
  const b64 = Buffer.from(rawBuf).toString('base64');
  const lines = b64.match(/.{1,64}/g) || [b64];
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----';
}

function certMatchesHost(cert, host) {
  const clean = String(host || '').replace(/^\[|\]$/g, '');
  if (!clean) return false;
  if (net.isIP(clean)) return typeof cert.checkIP === 'function' ? Boolean(cert.checkIP(clean)) : Boolean(cert.checkHost(clean));
  return Boolean(cert.checkHost(clean));
}

function normalizeHeaders(defaults, custom) {
  const out = {};
  const setOne = (k, v) => {
    if (v == null) return;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  };
  for (const [k, v] of Object.entries(defaults || {})) setOne(k, v);
  if (custom && typeof custom.forEach === 'function' && typeof custom.get === 'function') {
    custom.forEach((v, k) => setOne(k, v));
  } else if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) setOne(k, v);
  }
  return out;
}

function makeHeadersShim(rawHeaders) {
  const map = new Map();
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    if (v == null) continue;
    const lk = String(k).toLowerCase();
    map.set(lk, Array.isArray(v) ? v.join(', ') : String(v));
  }
  return {
    get: k => {
      const v = map.get(String(k || '').toLowerCase());
      return v === undefined ? null : v;
    },
    has: k => map.has(String(k || '').toLowerCase()),
    entries: () => map.entries(),
    [Symbol.iterator]: () => map.entries()
  };
}

function createDecompressedStream(res, method) {
  const status = res.statusCode || 0;
  if (String(method || 'GET').toUpperCase() === 'HEAD' || status === 204 || status === 304 || (status >= 300 && status < 400)) {
    return { stream: res, decomp: null };
  }
  const enc = String(res.headers['content-encoding'] || '').split(',')[0].trim().toLowerCase();
  let decomp = null;
  if (enc === 'gzip' || enc === 'x-gzip') decomp = zlib.createGunzip();
  else if (enc === 'deflate') decomp = zlib.createInflate();
  else if (enc === 'br' && typeof zlib.createBrotliDecompress === 'function') decomp = zlib.createBrotliDecompress();
  else return { stream: res, decomp: null };

  res.on('error', err => { try { decomp.destroy(err); } catch {} });
  res.once('aborted', () => { try { decomp.destroy(new Error('upstream connection aborted')); } catch {} });
  res.pipe(decomp);
  return { stream: decomp, decomp };
}

function wrapWebStream(nodeStream, cleanupFn, maxBytes, rawRes) {
  let bytesRead = 0;
  let cleaned = false;
  let ended = false;
  const finishCleanup = (normalEnd = false) => {
    if (cleaned) return;
    cleaned = true;
    cleanupFn(Boolean(normalEnd));
  };

  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', chunk => {
        if (ended) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buf.length;
        if (maxBytes && bytesRead > maxBytes) {
          ended = true;
          controller.error(new Error('ukuran respons melebihi batas (' + maxBytes + ' byte)'));
          finishCleanup(false);
          return;
        }
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));

        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.once('end', () => {
        if (ended) return;
        ended = true;
        controller.close();
        finishCleanup(!rawRes || rawRes.complete !== false);
      });
      nodeStream.on('error', err => {
        if (ended) return;
        ended = true;
        controller.error(err);
        finishCleanup(false);
      });
      nodeStream.once('close', () => {
        if (ended) return;
        ended = true;
        const ok = Boolean(rawRes && rawRes.complete);
        if (ok) controller.close();
        else controller.error(new Error('upstream stream closed prematurely'));
        finishCleanup(ok);
      });
    },
    pull() {
      if (nodeStream.isPaused && nodeStream.isPaused()) nodeStream.resume();
    },
    cancel() {
      ended = true;
      finishCleanup(false);
    }
  });
}

function buildFetchResponse(res, finalUrl, method, cleanupFn, maxBytes) {
  const { stream, decomp } = createDecompressedStream(res, method);
  const fullCleanup = (normalEnd = false) => {
    try { if (decomp && !decomp.destroyed) decomp.destroy(); } catch {}
    cleanupFn(normalEnd);
  };
  const body = wrapWebStream(stream, fullCleanup, maxBytes, res);
  const hdrs = makeHeadersShim(res.headers);
  const status = res.statusCode || 0;

  async function readAllBuffer() {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      chunks.push(b);
      total += b.length;
    }
    return Buffer.concat(chunks, total);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: res.statusMessage || '',
    url: finalUrl,
    headers: hdrs,
    body,
    arrayBuffer: async () => {
      const buf = await readAllBuffer();
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    text: async () => (await readAllBuffer()).toString('utf8'),
    json: async () => JSON.parse((await readAllBuffer()).toString('utf8'))
  };
}

function createHttpClient(clientOpts = {}) {
  const customPrivateCheck = typeof clientOpts.isPrivateIpFn === 'function';
  const isPrivateIp = customPrivateCheck ? clientOpts.isPrivateIpFn : rdPrivateIP;
  const defaultRoots = clientOpts.trustedRoots || DEFAULT_TRUSTED_ROOTS;
  const rdDnsCache = new Map();
  const aiaRepairCache = new Map();
  const secureCtxCache = new Map();
  const agentPool = new Map();

  function getSecureContext(trustedRoots, extraCaPems) {
    if ((!extraCaPems || !extraCaPems.length) && trustedRoots && trustedRoots.secureContext) {
      return trustedRoots.secureContext;
    }
    const basePems = (trustedRoots && trustedRoots.pems) || [];
    const allPems = extraCaPems && extraCaPems.length ? [...basePems, ...extraCaPems] : basePems;
    const key = crypto.createHash('sha1').update(allPems.join('\n')).digest('hex');
    let ctx = secureCtxCache.get(key);
    if (ctx) {
      secureCtxCache.delete(key);
      secureCtxCache.set(key, ctx);
      return ctx;
    }
    ctx = tls.createSecureContext(allPems.length ? { ca: allPems } : {});
    secureCtxCache.set(key, ctx);
    if (secureCtxCache.size > 64) secureCtxCache.delete(secureCtxCache.keys().next().value);
    return ctx;
  }

  function getPooledAgent(isTls, resolved, secureContext) {
    const addrsKey = resolved.addrs.map(a => a.address + ':' + a.family).join(',');
    const port = resolved.url.port ? Number(resolved.url.port) : (isTls ? 443 : 80);
    const ctxId = secureContext ? (secureContext._sitrepId || (secureContext._sitrepId = crypto.randomBytes(6).toString('hex'))) : 'def';
    const key = (isTls ? 'https:' : 'http:') + resolved.host + ':' + port + '|' + addrsKey + '|' + ctxId;
    let ag = agentPool.get(key);
    if (ag) {
      agentPool.delete(key);
      agentPool.set(key, ag);
      return ag;
    }
    const opts = {
      keepAlive: true,
      maxSockets: 16,
      maxFreeSockets: 4,
      keepAliveMsecs: 15000,
      timeout: 30000
    };
    if (isTls && secureContext) opts.secureContext = secureContext;
    ag = isTls ? new https.Agent(opts) : new http.Agent(opts);
    agentPool.set(key, ag);
    while (agentPool.size > 128) {
      const oldestKey = agentPool.keys().next().value;
      const oldest = agentPool.get(oldestKey);
      agentPool.delete(oldestKey);
      try {
        if (oldest) {
          oldest.maxFreeSockets = 0;
          for (const socks of Object.values(oldest.freeSockets || {})) {
            for (const s of socks || []) { try { s.destroy(); } catch {} }
          }
          const busy = Object.keys(oldest.sockets || {}).length > 0 || Object.keys(oldest.requests || {}).length > 0;
          if (!busy) oldest.destroy();
        }
      } catch {}
    }
    return ag;
  }

  function rememberAiaRepair(fp, pems, nowMs) {
    aiaRepairCache.set(fp, { pems, at: nowMs });
    while (aiaRepairCache.size > 200) aiaRepairCache.delete(aiaRepairCache.keys().next().value);
  }

  function cleanExpiredDnsCache(now) {
    if (rdDnsCache.size <= 500) return;
    for (const [k, v] of rdDnsCache) {
      if (now - v.at > 60000 || rdDnsCache.size > 500) rdDnsCache.delete(k);
      if (rdDnsCache.size <= 450) break;
    }
  }

  function isForbiddenHostname(h) {
    const clean = String(h || '').replace(/\.+$/, '');
    if (!clean || clean === 'localhost' || clean.endsWith('.localhost') || clean.endsWith('.local') || clean.endsWith('.internal')) return true;
    return customPrivateCheck ? false : PRIVATE_HOST.test(clean);
  }

  async function resolvePublicAddrs(raw, opts = {}) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { throw new Error('URL tidak valid'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL tidak valid');
    if (u.username || u.password) throw new Error('URL berkredensial ditolak');

    const h = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    if (!h || isForbiddenHostname(h)) throw new Error('host lokal ditolak');

    const literalFamily = net.isIP(h);
    if (literalFamily) {
      if (isPrivateIp(h)) throw new Error('alamat privat ditolak');
      return { url: u, host: h, addrs: [{ address: h, family: literalFamily }] };
    }

    const resolveFn = typeof opts.resolveFn === 'function'
      ? opts.resolveFn
      : (host) => dns.lookup(host, { all: true, verbatim: true });

    const now = Date.now();
    const useCache = !opts.noCache && typeof opts.resolveFn !== 'function';
    let ent = useCache ? rdDnsCache.get(h) : null;
    if (!ent || now - ent.at > 60000) {
      const rawAddrs = await resolveFn(h);
      const list = Array.isArray(rawAddrs) ? rawAddrs : (rawAddrs ? [rawAddrs] : []);
      const addrs = list
        .map(a => {
          if (typeof a === 'string') return { address: a, family: net.isIP(a) };
          const addr = String(a && a.address || '').trim();
          const fam = Number(a && a.family) || net.isIP(addr);
          return { address: addr, family: fam };
        })
        .filter(a => a.address && (a.family === 4 || a.family === 6));
      ent = { addrs, at: now };
      if (useCache && addrs.length) {
        rdDnsCache.set(h, ent);
        cleanExpiredDnsCache(now);
      }
    }
    if (!ent.addrs.length) throw new Error('host tidak ditemukan');
    if (ent.addrs.some(a => isPrivateIp(a.address))) throw new Error('alamat privat ditolak');
    return { url: u, host: h, addrs: ent.addrs.map(a => ({ address: a.address, family: a.family })) };
  }

  async function rdAssertPublic(raw, opts = {}) {
    const res = await resolvePublicAddrs(raw, opts);
    return res.url;
  }

  function makePinnedLookup(expectedHost, pinnedAddrs) {
    const normExpected = String(expectedHost || '').replace(/^\[|\]$/g, '').toLowerCase();
    const safeAddrs = pinnedAddrs.filter(a => a && a.address && !isPrivateIp(a.address));

    return function pinnedLookup(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const opts = typeof options === 'number' ? { family: options } : (options || {});
      const reqHost = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
      if (reqHost !== normExpected) {
        const err = new Error('DNS pinned lookup host mismatch: ' + reqHost);
        err.code = 'ENOTFOUND';
        return process.nextTick(() => callback(err));
      }
      if (!safeAddrs.length) {
        const err = new Error('alamat privat ditolak saat koneksi');
        err.code = 'EACCES';
        return process.nextTick(() => callback(err));
      }
      const fam = opts.family === 4 || opts.family === 6 ? opts.family : 0;
      const matched = fam ? safeAddrs.filter(a => a.family === fam) : safeAddrs;
      if (!matched.length) {
        const err = new Error('tidak ada IP keluarga IPv' + fam + ' yang dipin');
        err.code = 'ENOTFOUND';
        return process.nextTick(() => callback(err));
      }
      if (opts.all) {
        return process.nextTick(() => callback(null, matched.map(a => ({ address: a.address, family: a.family }))));
      }
      return process.nextTick(() => callback(null, matched[0].address, matched[0].family));
    };
  }

  function probePeerChain(resolved, port, servername, ms = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = tls.connect({
        host: resolved.host,
        port: port || 443,
        servername: net.isIP(resolved.host) ? undefined : (servername || resolved.host),
        lookup: makePinnedLookup(resolved.host, resolved.addrs),
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        ALPNProtocols: ['http/1.1']
      });
      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock.destroy(); } catch {}
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => finish(new Error('TLS certificate probe timeout')), ms);
      sock.once('secureConnect', () => {
        try {
          const peer = sock.getPeerCertificate(true);
          if (!peer || !peer.raw) return finish(new Error('peer tidak mengirim sertifikat'));
          const chain = [];
          const seen = new Set();
          let cur = peer;
          while (cur && cur.raw && chain.length < 8) {
            const x = new crypto.X509Certificate(cur.raw);
            if (seen.has(x.fingerprint256)) break;
            seen.add(x.fingerprint256);
            chain.push(x);
            cur = cur.issuerCertificate && cur.issuerCertificate !== cur ? cur.issuerCertificate : null;
          }
          finish(null, chain);
        } catch (e) {
          finish(e);
        }
      });
      sock.on('error', e => finish(e));
    });
  }

  async function repairCertChain(resolved, port, servername, opt = {}) {
    const trustedRoots = opt.trustedRoots || defaultRoots;
    const nowMs = Date.now();
    const peerChain = await probePeerChain(resolved, port, servername, Math.min(opt.ms || 8000, 8000));
    if (!peerChain.length) return null;

    const leaf = peerChain[0];
    if (!isCertTimeValid(leaf, nowMs)) return null;
    if (!certMatchesHost(leaf, servername || resolved.host)) return null;

    const cached = aiaRepairCache.get(leaf.fingerprint256);
    if (cached && nowMs - cached.at < 21600000) return cached.pems;

    for (let i = 0; i < peerChain.length; i++) {
      if (!isCertTimeValid(peerChain[i], nowMs)) return null;
      if (i > 0) {
        if (!peerChain[i].ca) return null;
        if (!peerChain[i - 1].checkIssued(peerChain[i]) || !peerChain[i - 1].verify(peerChain[i].publicKey)) {
          return null;
        }
      }
    }

    let cur = peerChain[peerChain.length - 1];
    const collected = peerChain.slice(1).map(c => derToPem(c.raw));
    const seenFp = new Set(peerChain.map(c => c.fingerprint256));

    if (isVerifiedByTrustedRoot(cur, trustedRoots, nowMs)) {
      rememberAiaRepair(leaf.fingerprint256, collected, nowMs);
      return collected;
    }

    for (let depth = 0; depth < 4; depth++) {
      const aiaUrls = parseAiaUrls(cur);
      if (!aiaUrls.length) break;
      let nextCert = null;
      for (const aiaUrl of aiaUrls.slice(0, 3)) {
        try {
          const res = await safeFetch(aiaUrl, {
            redirect: 'follow',
            allowAia: false,
            maxBytes: 65536,
            resolveFn: opt.resolveFn,
            trustedRoots
          }, 5000);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const cand = parseCertBuffer(buf);
          if (seenFp.has(cand.fingerprint256)) continue;
          if (!cand.ca) continue;
          if (!isCertTimeValid(cand, nowMs)) continue;
          if (!cur.checkIssued(cand) || !cur.verify(cand.publicKey)) continue;
          nextCert = cand;
          break;
        } catch {}
      }
      if (!nextCert) break;
      seenFp.add(nextCert.fingerprint256);
      collected.push(derToPem(nextCert.raw));
      cur = nextCert;
      if (isVerifiedByTrustedRoot(cur, trustedRoots, nowMs)) {
        rememberAiaRepair(leaf.fingerprint256, collected, nowMs);
        return collected;
      }
    }
    return null;
  }

  function singlePinnedRequest(resolved, method, headers, bodyData, extraCaPems, trustedRoots, externalSignal, deadlineAt, maxBytes) {
    return new Promise((resolve, reject) => {
      if (externalSignal && externalSignal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return reject(err);
      }

      const u = resolved.url;
      const isTls = u.protocol === 'https:';
      const mod = isTls ? https : http;
      const port = u.port ? Number(u.port) : (isTls ? 443 : 80);

      const remaining = Math.max(250, deadlineAt - Date.now());
      let settled = false;
      let resObj = null;
      let timer = null;

      const secureCtx = isTls ? getSecureContext(trustedRoots, extraCaPems) : null;
      const reqOpts = {
        protocol: u.protocol,
        hostname: resolved.host,
        port,
        path: (u.pathname || '/') + (u.search || ''),
        method,
        headers,
        agent: getPooledAgent(isTls, resolved, secureCtx),
        lookup: makePinnedLookup(resolved.host, resolved.addrs),
        timeout: remaining
      };

      if (isTls) {
        if (!net.isIP(resolved.host)) reqOpts.servername = resolved.host;
        reqOpts.rejectUnauthorized = true;
      }

      const req = mod.request(reqOpts, res => {
        if (settled) return;
        settled = true;
        resObj = res;
        res.on('error', () => {});
        resolve(buildFetchResponse(res, u.href, method, cleanupReq, maxBytes));
      });

      const cleanupReq = (normalEnd = false) => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
        if (normalEnd && resObj && resObj.complete) return;
        try { if (resObj && !resObj.destroyed) resObj.destroy(); } catch {}
        try {
          if (req.socket && !req.socket.destroyed && req.socket.listenerCount('error') === 0) {
            req.socket.on('error', () => {});
          }
        } catch {}
        try { if (!req.destroyed) req.destroy(); } catch {}
      };

      const fail = (err) => {
        cleanupReq();
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      req.on('error', fail);

      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        if (resObj && !resObj.destroyed) resObj.destroy(err);
        fail(err);
      };

      timer = setTimeout(() => {
        const err = new Error('HTTP request timeout after ' + remaining + 'ms');
        err.name = 'TimeoutError';
        err.code = 'ETIMEDOUT';
        if (resObj && !resObj.destroyed) resObj.destroy(err);
        fail(err);
      }, remaining);

      if (externalSignal) {
        if (externalSignal.aborted) return onAbort();
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }

      req.once('timeout', () => {
        const err = new Error('socket timeout');
        err.code = 'ETIMEDOUT';
        fail(err);
      });

      if (bodyData != null && method !== 'GET' && method !== 'HEAD') {
        req.end(bodyData);
      } else {
        req.end();
      }
    });
  }

  async function safeFetch(rawUrl, opt = {}, ms = 10000) {
    const redirectMode = opt.redirect || 'follow';
    const maxHops = Number.isInteger(opt.maxRedirects) ? opt.maxRedirects : 6;
    const trustedRoots = opt.trustedRoots || defaultRoots;
    const allowAia = opt.allowAia !== false;
    const maxBytes = opt.maxBytes || 0;
    const deadlineAt = Date.now() + Math.max(500, ms);

    let curUrl = String(rawUrl || '').trim();
    let method = String(opt.method || 'GET').toUpperCase();
    let bodyData = opt.body != null ? opt.body : null;
    const headers = normalizeHeaders({
      'user-agent': DEFAULT_UA,
      'accept': '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'id-ID,id;q=0.9,en;q=0.8'
    }, opt.headers);

    let firstOrigin = null;

    for (let hop = 0; hop <= maxHops; hop++) {
      const resolved = await resolvePublicAddrs(curUrl, { resolveFn: opt.resolveFn });
      if (!firstOrigin) firstOrigin = resolved.url.origin;
      else if (resolved.url.origin !== firstOrigin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers['proxy-authorization'];
      }

      let res;
      try {
        res = await singlePinnedRequest(resolved, method, headers, bodyData, null, trustedRoots, opt.signal, deadlineAt, maxBytes);
      } catch (err) {
        const msg = String((err && (err.code || err.message)) || '');
        const hasSecHdr = Boolean(headers.authorization || headers.cookie);
        if (resolved.url.protocol === 'https:' && allowAia && !hasSecHdr && INCOMPLETE_CHAIN_ERR.test(msg)) {
          const port = resolved.url.port ? Number(resolved.url.port) : 443;
          const repairedPems = await repairCertChain(resolved, port, resolved.host, {
            trustedRoots,
            resolveFn: opt.resolveFn,
            ms: Math.max(1000, deadlineAt - Date.now())
          }).catch(() => null);
          if (repairedPems && repairedPems.length) {
            res = await singlePinnedRequest(resolved, method, headers, bodyData, repairedPems, trustedRoots, opt.signal, deadlineAt, maxBytes);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      if (res.status >= 300 && res.status < 400 && redirectMode !== 'manual') {
        const loc = res.headers.get('location');
        if (redirectMode === 'error') {
          try { await res.body.cancel(); } catch {}
          throw new Error('redirect ditolak');
        }
        if (!loc) return res;
        try { await res.body.cancel(); } catch {}
        if (hop >= maxHops) throw new Error('terlalu banyak redirect');
        const nextHref = new URL(loc, curUrl).href;
        if (res.status === 301 || res.status === 302 || res.status === 303) {
          if (method !== 'GET' && method !== 'HEAD') {
            method = 'GET';
            bodyData = null;
            delete headers['content-length'];
            delete headers['content-type'];
          }
        }
        curUrl = nextHref;
        continue;
      }

      return res;
    }
    throw new Error('terlalu banyak redirect');
  }

  function closeAllAgents() {
    for (const ag of agentPool.values()) {
      try { ag && ag.destroy(); } catch {}
    }
    agentPool.clear();
  }

  return {
    resolvePublicAddrs,
    rdAssertPublic,
    makePinnedLookup,
    repairCertChain,
    safeFetch,
    closeAllAgents
  };
}

const defaultClient = createHttpClient();
const {
  resolvePublicAddrs,
  rdAssertPublic,
  makePinnedLookup,
  repairCertChain,
  safeFetch,
  closeAllAgents
} = defaultClient;

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

function scryptHashAsync(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }, (err, dk) => {
      if (err) reject(err);
      else resolve(dk);
    });
  });
}

function hashPassword(password) {
  const saltHex = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + saltHex + '$' + dk.toString('hex');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;
  try {
    const derived = await scryptHashAsync(password, saltHex);
    const expected = Buffer.from(hashHex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function parseUsersSpec(spec) {
  const users = new Map();
  const entries = String(spec || '').split(/[;\n,]+/).map(s => s.trim()).filter(Boolean);
  for (const ent of entries) {
    const idx1 = ent.indexOf(':');
    if (idx1 <= 0) continue;
    const username = ent.slice(0, idx1).trim();
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) continue;

    const rest = ent.slice(idx1 + 1);
    const idx2 = rest.indexOf(':');
    let role = 'admin';
    let secretPart = '';
    if (idx2 > 0) {
      const maybeRole = rest.slice(0, idx2).trim().toLowerCase();
      if (ROLE_RANK[maybeRole]) {
        role = maybeRole;
        secretPart = rest.slice(idx2 + 1).trim();
      } else {
        secretPart = rest.trim();
      }
    } else {
      secretPart = rest.trim();
    }
    if (!secretPart) continue;
    const hash = secretPart.startsWith('scrypt$') ? secretPart : hashPassword(secretPart);
    users.set(username, { username, role, hash });
  }
  return users;
}

function hasRole(principal, minRole) {
  if (!principal) return false;
  const rank = ROLE_RANK[principal.role] || 0;
  const reqRank = ROLE_RANK[minRole] || 99;
  return rank >= reqRank;
}

function timingEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req && req.headers && req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1).trim();
    try { v = decodeURIComponent(v); } catch {}
    out[k] = v;
  }
  return out;
}

function getClientIp(req, trustProxy = false, trustedHops = Number(process.env.SITREP_TRUSTED_HOPS) || 1) {
  if (trustProxy && req && req.headers) {
    const cfRaw = String(req.headers['cf-connecting-ip'] || '').trim().replace(/^\[|\]$/g, '');
    const cfValid = cfRaw && net.isIP(cfRaw) !== 0 ? cfRaw : '';

    const viaCloudflare = Boolean(req.headers['cf-ray']);
    if (cfValid && (process.env.SITREP_TRUST_CF === '1' || viaCloudflare)) return cfValid;
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const ips = String(xff)
        .split(',')
        .map(s => s.trim().replace(/^\[|\]$/g, ''))
        .filter(ip => net.isIP(ip) !== 0);
      if (ips.length) {
        const hops = Math.max(1, Number.isFinite(trustedHops) ? Math.floor(trustedHops) : 1);
        return ips[Math.max(0, ips.length - hops)];
      }
    }
    if (cfValid) return cfValid;
    const xr = String(req.headers['x-real-ip'] || '').trim().replace(/^\[|\]$/g, '');
    if (xr && net.isIP(xr) !== 0) return xr;
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateKey(ip) {
  const raw = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!raw || net.isIP(raw) === 0) return raw || 'unknown';
  if (net.isIP(raw) === 4) return raw;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const full = expandIPv6(raw);
  if (!Array.isArray(full) || full.length !== 8) return raw;
  return full.slice(0, 4).map(n => n.toString(16)).join(':') + '::/64';
}

function isHttpsReq(req, trustProxy = false) {
  if (req && req.socket && req.socket.encrypted) return true;
  if (trustProxy && req && req.headers) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https') return true;
  }
  return false;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isSameOriginPost(req, trustProxy = false) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;
  if (!host) return false;
  const expectedProto = isHttpsReq(req, trustProxy) ? 'https:' : 'http:';
  const matchesOriginUrl = (raw) => {
    try {
      const u = new URL(raw);
      if (u.host.toLowerCase() !== String(host).toLowerCase()) return false;
      return !trustProxy || u.protocol === expectedProto;
    } catch {
      return false;
    }
  };
  if (origin) return matchesOriginUrl(origin);
  if (referer) return matchesOriginUrl(referer);
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return sfs === 'same-origin';
}

function createAuthManager(opts = {}) {
  const apiToken = String(opts.apiToken || crypto.randomBytes(16).toString('hex'));
  const explicitToken = Boolean(opts.explicitToken);
  const users = parseUsersSpec(opts.usersSpec || '');
  const userMode = users.size > 0;
  const publicMode = !userMode && Boolean(opts.publicDeploy);
  const rawSecret = String(opts.authSecret || '');
  if (userMode && rawSecret.length < 32) {
    throw new Error('SITREP_AUTH_SECRET wajib minimal 32 karakter saat SITREP_USERS (mode session) aktif');
  }
  const signingKey = rawSecret.length >= 32
    ? crypto.createHash('sha256').update(rawSecret).digest()
    : crypto.randomBytes(32);
  const sessionTtlSec = Math.max(300, Number(opts.sessionTtlSec) || 43200);
  const trustProxy = Boolean(opts.trustProxy);
  const tokenRole = ROLE_RANK[opts.tokenRole] ? opts.tokenRole : 'admin';
  const allowQueryToken = opts.allowQueryToken !== undefined
    ? Boolean(opts.allowQueryToken)
    : (!publicMode && !userMode && process.env.SITREP_DISABLE_QUERY_TOKEN !== '1');

  const revoked = new Map();

  function signSession(username, role) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      u: username,
      r: role,
      iat: now,
      exp: now + sessionTtlSec,
      jti: crypto.randomBytes(12).toString('hex')
    };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', signingKey).update(b64).digest('base64url');
    return { token: b64 + '.' + sig, payload };
  }

  function verifySessionToken(rawTok) {
    if (!rawTok || typeof rawTok !== 'string') return null;
    const dot = rawTok.indexOf('.');
    if (dot <= 0) return null;
    const b64 = rawTok.slice(0, dot);
    const sig = rawTok.slice(dot + 1);
    const expected = crypto.createHmac('sha256', signingKey).update(b64).digest('base64url');
    if (!timingEqualStr(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);
      if (!payload || typeof payload.u !== 'string' || !ROLE_RANK[payload.r]) return null;
      if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
      if (!users.has(payload.u)) return null;
      if (payload.jti && revoked.has(payload.jti)) return null;
      return {
        username: payload.u,
        role: users.get(payload.u).role,
        via: 'session',
        jti: payload.jti,
        exp: payload.exp
      };
    } catch {
      return null;
    }
  }

  function revokeToken(rawTok) {
    const p = verifySessionToken(rawTok);
    if (p && p.jti) {
      revoked.set(p.jti, p.exp * 1000);
      if (revoked.size > 1000) {
        const nowMs = Date.now();
        for (const [k, expMs] of revoked) {
          if (expMs <= nowMs) revoked.delete(k);
        }

        while (revoked.size > 25000) {
          revoked.delete(revoked.keys().next().value);
        }
      }
    }
  }

  function authenticate(req, parsedUrl) {
    const hdrTok = req.headers['x-sitrep-token'];
    const qryTok = allowQueryToken && parsedUrl && parsedUrl.searchParams ? parsedUrl.searchParams.get('token') : null;

    if (!userMode) {
      if (publicMode) {
        if (explicitToken && (timingEqualStr(hdrTok, apiToken) || timingEqualStr(qryTok, apiToken))) {
          return { username: 'api-token', role: tokenRole, via: 'token' };
        }
        return { username: 'public', role: 'viewer', via: 'public' };
      }
      if (timingEqualStr(hdrTok, apiToken) || timingEqualStr(qryTok, apiToken)) {
        return { username: 'local', role: 'admin', via: 'token' };
      }
      return null;
    }

    const cookies = parseCookies(req);
    const sessPrincipal = verifySessionToken(cookies.sitrep_sess);
    if (sessPrincipal) return sessPrincipal;

    if (explicitToken && (timingEqualStr(hdrTok, apiToken) || timingEqualStr(qryTok, apiToken))) {
      return { username: 'api-token', role: tokenRole, via: 'token' };
    }
    return null;
  }

  function sessionCookieHeader(req, tokenValue, maxAgeSec) {
    const parts = [
      'sitrep_sess=' + tokenValue,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + Math.max(0, Math.floor(maxAgeSec))
    ];
    if (isHttpsReq(req, trustProxy)) parts.push('Secure');
    return parts.join('; ');
  }

  function renderLoginHtml() {
    return [
      '<!doctype html>',
      '<html lang="id"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>SITREP ... Autentikasi Diperlukan</title>',
      '<style>',
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0d12;color:#e6edf3;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace}',
      '.card{width:100%;max-width:360px;background:#11161f;border:1px solid #263042;border-radius:10px;padding:28px;box-shadow:0 16px 40px rgba(0,0,0,.45)}',
      'h1{font-size:18px;letter-spacing:.08em;text-transform:uppercase;color:#f0f6fc;margin-bottom:6px}',
      'p.sub{color:#8b949e;font-size:12px;margin-bottom:20px}',
      'label{display:block;font-size:12px;color:#9ea7b3;margin-bottom:6px}',
      'input{width:100%;padding:10px 12px;margin-bottom:14px;border-radius:6px;border:1px solid #2d3748;background:#090c10;color:#f0f6fc;font:14px inherit}',
      'input:focus{outline:none;border-color:#58a6ff}',
      'button{width:100%;padding:10px 14px;border:0;border-radius:6px;background:#238636;color:#fff;font:600 14px inherit;cursor:pointer}',
      'button:hover{background:#2ea043}',
      '.err{min-height:18px;color:#f85149;font-size:12px;margin-bottom:10px}',
      '</style></head><body>',
      '<form class="card" id="f">',
      '<h1>SITREP</h1>',
      '<p class="sub">Masuk dengan akun operator untuk mengakses dashboard OSINT.</p>',
      '<div class="err" id="err"></div>',
      '<label for="u">Username</label>',
      '<input id="u" name="username" autocomplete="username" required autofocus>',
      '<label for="p">Password</label>',
      '<input id="p" name="password" type="password" autocomplete="current-password" required>',
      '<button type="submit">Masuk</button>',
      '</form>',
      '<script>',
      'const f=document.getElementById("f"),err=document.getElementById("err");',
      'f.addEventListener("submit",async e=>{e.preventDefault();err.textContent="";',
      'try{const r=await fetch("/api/auth/login",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},',
      'body:JSON.stringify({username:f.username.value,password:f.password.value})});',
      'const j=await r.json().catch(()=>({}));',
      'if(!r.ok||!j.ok){err.textContent=j.err||"Login gagal ("+r.status+")";return;}',
      'location.reload();}catch{err.textContent="Koneksi gagal";}});',
      '</script></body></html>'
    ].join('');
  }

  return {
    userMode,
    publicMode,
    allowQueryToken,
    apiToken,
    authenticate,
    verifyPassword: async (username, password) => {
      const rec = users.get(String(username || '').trim());
      if (!rec) {

        await verifyPassword(password || 'x', 'scrypt$00112233445566778899aabbccddeeff$' + '00'.repeat(64));
        return null;
      }
      const ok = await verifyPassword(password, rec.hash);
      return ok ? { username: rec.username, role: rec.role } : null;
    },
    signSession,
    revokeToken,
    parseCookies,
    sessionCookieHeader,
    renderLoginHtml,
    hasRole,
    isSameOriginPost: (req) => isSameOriginPost(req, trustProxy),
    injectHtmlMeta: (html, principal) => {
      let meta = '';
      if (publicMode) {
        meta = '<meta name="sitrep-public" content="1">';
      } else if (!userMode) {
        meta = '<meta name="sitrep-token" content="' + escHtml(apiToken) + '">';
      } else if (principal) {
        meta = '<meta name="sitrep-user" content="' + escHtml(principal.username + ':' + principal.role) + '">';
      }
      if (!meta) return html;
      return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + meta) : meta + html;
    }
  };
}

function createRateLimiter(buckets = {}) {
  const store = new Map();
  const cfg = {
    login: { limit: 10, windowMs: 300000 },

    heavy: { limit: 600, windowMs: 60000 },
    api: { limit: 1200, windowMs: 60000 },
    ...buckets
  };
  const MAX_KEYS = 20000;

  function sweep(now) {
    if (store.size <= MAX_KEYS) return;

    for (const [k, v] of store) {
      if (v.resetAt <= now) store.delete(k);
    }

    while (store.size > MAX_KEYS) {
      const k = store.keys().next().value;
      if (String(k).startsWith('login:')) break;
      store.delete(k);
    }
  }

  return {
    size: () => store.size,
    check(bucketName, ip, opts = {}) {
      const rule = opts.rule || cfg[bucketName] || cfg.api;
      if (opts.exempt) return { allowed: true, limit: rule.limit, remaining: rule.limit, resetSec: 0, exempt: true };
      const now = Date.now();
      sweep(now);
      const key = bucketName + ':' + rateKey(ip);
      let ent = store.get(key);
      if (!ent || ent.resetAt <= now) {
        ent = { count: 0, resetAt: now + rule.windowMs };
        store.set(key, ent);
      }
      ent.count++;
      const allowed = ent.count <= rule.limit;
      const remaining = Math.max(0, rule.limit - ent.count);
      const resetSec = Math.max(1, Math.ceil((ent.resetAt - now) / 1000));
      return { allowed, limit: rule.limit, remaining, resetSec };
    }
  };
}

async function runIsolated(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error('[worker:' + label + '] error terisolasi:', e && e.stack ? e.stack : e);
    return null;
  }
}

function createFatalGuard(opts = {}) {
  const onFlush = typeof opts.onFlush === 'function' ? opts.onFlush : () => {};
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};
  const exitFn = typeof opts.exitFn === 'function' ? opts.exitFn : (code) => process.exit(code);
  const timeoutMs = Math.max(200, Number(opts.timeoutMs) || 2500);
  let shuttingDown = false;

  function trigger(kind, err) {
    console.error('[FATAL:' + kind + ']', err && err.stack ? err.stack : err);
    if (shuttingDown) return;
    shuttingDown = true;

    try { onFlush(); } catch (e) {
      console.error('[FATAL] flush gagal:', e && e.message || e);
    }

    let exited = false;
    const doExit = () => {
      if (exited) return;
      exited = true;
      exitFn(1);
    };

    const forceTimer = setTimeout(doExit, timeoutMs);
    if (forceTimer.unref) forceTimer.unref();

    try {
      onClose(() => {
        clearTimeout(forceTimer);
        doExit();
      });
    } catch {
      clearTimeout(forceTimer);
      doExit();
    }
  }

  return {
    isShuttingDown: () => shuttingDown,
    trigger,
    install(proc = process) {
      proc.on('uncaughtException', (err, origin) => trigger(origin || 'uncaughtException', err));
      proc.on('unhandledRejection', (reason) => trigger('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
    }
  };
}

module.exports = {
  DEFAULT_UA,
  PRIVATE_HOST,
  DEFAULT_TRUSTED_ROOTS,
  rdIPv4Bytes,
  rdPrivateBytes,
  rdPrivateIP,
  publicURL,
  createHttpClient,
  rdAssertPublic,
  resolvePublicAddrs,
  makePinnedLookup,
  loadTrustedRoots,
  repairCertChain,
  safeFetch,
  hashPassword,
  verifyPassword,
  parseUsersSpec,
  hasRole,
  createAuthManager,
  createRateLimiter,
  rateKey,
  getClientIp,
  isHttpsReq,
  isSameOriginPost,
  closeAllAgents,
  runIsolated,
  createFatalGuard
};
