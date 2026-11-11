'use strict';

function createReaderService({
  CFG,
  AUTH,
  API_TOKEN,
  SEC,
  MEDIA,
  EXTRACT,
  FEEDTEXT,
  PIPELINE_VERSION,
  assetReuse,
  cache,
  bodyCache,
  lruCap,
  memo,
  makeSem,
  get,
  sleep,
  openCors,
  isBannedHostUrl,
}) {
  const { publicURL, rdAssertPublic } = SEC;
  const upgradeImage = u => MEDIA.upgradeImage(u);
  const rdImgKey = u => MEDIA.imageKey(u);
  const BOT_CHALLENGE_RE = EXTRACT.BOT_CHALLENGE_RE;

  const thumbCache = new Map();
  const urlToCanon = new Map();
  const gnCache = new Map();
  const probeCache = new Map();
  const verifiedProxyImgs = new Map();

  const knownNewsUrls = new Set();
  const knownVhsUrls = new Set();
  const setAddCapped = (set, v, cap) => {
    if (!v) return;
    if (set.has(v)) { set.delete(v); set.add(v); return; }
    set.add(v);
    while (set.size > cap) set.delete(set.keys().next().value);
  };
  function registerNewsUrl(u) {
    if (!u || typeof u !== 'string') return;
    setAddCapped(knownNewsUrls, u, 8000);
    const c = MEDIA.canonicalArticleUrl(u);
    if (c && c !== u) setAddCapped(knownNewsUrls, c, 8000);
  }
  function registerVhsUrl(u) {
    if (!u || typeof u !== 'string') return;
    try {
      const p = publicURL(u);
      if (p) setAddCapped(knownVhsUrls, p.href, 2500);
    } catch {}
    setAddCapped(knownVhsUrls, u, 2500);
  }
  function isKnownNewsUrl(raw) {
    if (!raw || typeof raw !== 'string') return false;
    if (knownNewsUrls.has(raw) || urlToCanon.has(raw)) return true;
    const de = descGetEntry(raw);
    if (de !== undefined && de.pub) return true;
    const canon = MEDIA.canonicalArticleUrl(raw) || raw;
    if (knownNewsUrls.has(canon) || getReadCache(canon, raw)) return true;
    return Boolean(rdWireFind(raw));
  }
  function isKnownVhsUrl(u) {
    if (!u) return false;
    if (knownVhsUrls.has(u)) return true;
    try {
      const p = publicURL(u);
      if (p && knownVhsUrls.has(p.href)) return true;
    } catch {}
    return false;
  }

  function registerVerifiedProxyImg(urls, meta) {
    const rec = { ua: (meta && meta.ua) || '', referer: (meta && meta.referer) || '', finalUrl: (meta && meta.finalUrl) || '', at: Date.now() };
    for (const raw of urls) {
      if (!raw || typeof raw !== 'string') continue;
      verifiedProxyImgs.delete(raw);
      verifiedProxyImgs.set(raw, rec);
      lruCap(verifiedProxyImgs, 2500);
    }
  }

  const RD_BOT_UAS = [
    'WhatsApp/2.23.20.0 A',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'TelegramBot (like TwitterBot)',
    'Wget/1.21',
    'curl/8.7.1',
  ];
  const CF_WAF_HOST_RE = /(?:^|\.)(?:tempo\.co|cnnindonesia\.com|cnbcindonesia\.com|jpnn\.com|pikiran-rakyat\.com|mediaindonesia\.com|tribunnews\.com|bisnis\.com|kontan\.co\.id|kompasiana\.com|suara\.com|sindonews\.com|okezone\.com|inews\.id)$/i;

  const readMediaSem = makeSem(16);
  function sanitizeHopHeaders(headers, firstOrigin, curUrl) {
    const out = { ...(headers || {}) };
    try {
      if (firstOrigin && new URL(curUrl).origin !== firstOrigin) {
        for (const k of Object.keys(out)) {
          if (/^(?:authorization|cookie|proxy-authorization)$/i.test(k)) delete out[k];
        }
      }
    } catch (e) {}
    return out;
  }
  function rdSafeGet(raw, ms, headers, signal) {
    return readMediaSem(async () => {
      let cur = raw, firstOrigin = '';
      try { firstOrigin = new URL(raw).origin; } catch (e) {}
      for (let i = 0; i < 5; i++) {
        await rdAssertPublic(cur);
        const baseHdrs = (headers && headers['user-agent'])
          ? { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
          : {
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
            };
        const hdrs = sanitizeHopHeaders({ ...baseHdrs, ...(headers || {}) }, firstOrigin, cur);
        const opt = { redirect: 'manual', headers: hdrs, ...(signal ? { signal } : {}) };
        const r = await get(cur, opt, ms);
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location');
          try { if (r.body && r.body.cancel) await r.body.cancel(); } catch {}
          if (!loc) throw new Error('redirect tanpa lokasi');
          cur = new URL(loc, cur).href;
          continue;
        }
        return { r, url: cur };
      }
      throw new Error('terlalu banyak redirect');
    }, Boolean(signal));
  }

  const mediaSem = makeSem(24);
  async function mediaGetRaw(raw, ms, headers, hostOK, signal) {
    let cur = raw, firstOrigin = '';
    try { firstOrigin = new URL(raw).origin; } catch (e) {}
    for (let i = 0; i < 5; i++) {
      await rdAssertPublic(cur);
      if (hostOK && !hostOK(cur)) throw new Error('host tidak diizinkan');
      const opt = { redirect: 'manual', headers: sanitizeHopHeaders(headers, firstOrigin, cur), ...(signal ? { signal } : {}) };
      const r = await get(cur, opt, ms);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch {}
        if (!loc) throw new Error('redirect tanpa lokasi');
        cur = new URL(loc, cur).href;
        continue;
      }
      return { r, url: cur };
    }
    throw new Error('terlalu banyak redirect');
  }
  const mediaGet = (raw, ms, headers, hostOK, prio, signal) => mediaSem(() => mediaGetRaw(raw, ms, headers, hostOK, signal), Boolean(prio));

  async function mediaBody(r, max) {
    const len = Number(r.headers.get('content-length') || 0);
    if (len > max) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {} throw new Error('body terlalu besar'); }
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!reader) {
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > max) throw new Error('body terlalu besar');
      return b;
    }
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) { try { await reader.cancel(); } catch (e) {} throw new Error('body terlalu besar'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  const mediaText = async (r, max) => (await mediaBody(r, max)).toString('utf8');

  async function probeImageDirect(u, referer, extraHeaders = null) {
    let res;
    try {
      const hdrs = {
        accept: 'image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8',
        ...(referer ? { referer } : {}),
        ...(extraHeaders || {}),
      };
      const { r, url: finalUrl } = await mediaGet(u, 4500, hdrs);
      if (!r.ok) {
        const transient = r.status === 403 || r.status === 429 || r.status >= 500;
        res = { ok: false, reason: 'http_' + r.status, detail: String(r.status), transient };
      } else {
        const ct = r.headers.get('content-type') || '';
        const cl = Number(r.headers.get('content-length') || 0);
        const ctLow = ct.split(';')[0].trim().toLowerCase();
        if (ctLow && (/^(?:image\/svg\+xml|image\/x-icon|image\/vnd\.microsoft\.icon|text\/|application\/(?:json|xml|xhtml\+xml|javascript)|video\/|audio\/)/i.test(ctLow) || (!ctLow.startsWith('image/') && !ctLow.includes('octet-stream')))) {
          try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
          res = { ok: false, reason: 'unsupported_mime', detail: ctLow, transient: false };
        } else if (cl > 0 && cl < 4500) {
          try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
          res = { ok: false, reason: 'file_too_small', detail: cl + 'B', transient: false };
        } else {
          const reader = r.body && r.body.getReader ? r.body.getReader() : null;
          let buf = Buffer.alloc(0);
          let total = 0;
          let inspected = null;
          if (!reader) {
            buf = Buffer.from(await r.arrayBuffer());
            total = buf.length;
            inspected = MEDIA.inspectImageBuffer(buf, ct);
          } else {
            const chunks = [];
            let nextCheck = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.length;
              chunks.push(Buffer.from(value));
              if (!inspected && total >= 32 && total >= nextCheck) {
                const curBuf = Buffer.concat(chunks);
                const probeRes = MEDIA.inspectImageBuffer(curBuf, ct);
                if (probeRes.ok) inspected = probeRes;
                else if (probeRes.reason === 'svg_payload' || probeRes.reason === 'favicon_ico_payload' || probeRes.reason === 'not_an_image_payload' || probeRes.reason === 'unsupported_mime') {
                  inspected = probeRes;
                  try { await reader.cancel(); } catch (e) {}
                  break;
                }
                nextCheck = total < 256 ? 512 : total < 4096 ? 4096 : total < 32768 ? 32768 : total + 65536;
              }
              if ((inspected && inspected.ok && (total >= 6144 || cl >= 5000)) || total > 262144) {
                try { await reader.cancel(); } catch (e) {}
                break;
              }
            }
            if (!inspected) inspected = MEDIA.inspectImageBuffer(Buffer.concat(chunks), ct);
          }
          if (inspected && inspected.ok) {
            res = {
              ok: true,
              w: inspected.w,
              h: inspected.h,
              mime: inspected.mime,
              bytes: Math.max(total, cl),
              fingerprint: inspected.fingerprint,
              finalUrl: finalUrl || u,
            };
          } else {
            res = {
              ok: false,
              reason: (inspected && inspected.reason) || 'invalid_image_bytes',
              detail: ct || '',
              transient: false,
            };
          }
        }
      }
    } catch (e) {
      const msg = String(e && e.message || e);
      const isSsrf = /tidak valid|lokal|privat|diizinkan|kredensial|redirect/i.test(msg);
      res = { ok: false, reason: isSsrf ? 'ssrf_or_redirect_blocked' : 'network_or_timeout', detail: msg.slice(0, 100), transient: !isSsrf };
    }
    return res;
  }

  async function probeImage(u, referer) {
    const ck = 'v' + PIPELINE_VERSION + ':' + u;
    const hit = probeCache.get(ck);
    if (hit) {
      const ttl = hit.res.ok ? 900000 : (hit.res.transient ? 15000 : 600000);
      if (Date.now() - hit.at < ttl) return hit.res;
    }
    let res = await probeImageDirect(u, referer);

    if (!res.ok && res.transient) {
      for (const bua of RD_BOT_UAS.slice(0, 3)) {
        const botRes = await probeImageDirect(u, referer, { 'user-agent': bua });
        if (botRes.ok) {
          res = { ...botRes, viaBot: true, botUa: bua };
          break;
        }
      }
    }
    if (!res.ok && res.transient && process.env.SITREP_NO_WESERV !== '1') {
      const w = 'https://images.weserv.nl/?url=' + encodeURIComponent(String(u).replace(/^https?:\/\//, ''));
      const viaWeserv = await probeImageDirect(w, referer);
      if (viaWeserv.ok) {
        res = { ...viaWeserv, finalUrl: u, viaWeserv: true };
      }
    }
    if (res.ok) {
      registerVerifiedProxyImg([u, res.finalUrl], { ua: res.botUa || '', referer, finalUrl: res.finalUrl || u });
    }
    probeCache.set(ck, { res, at: Date.now() });
    lruCap(probeCache, 600);
    return res;
  }

  const GN_PATH = /^\/rss\/articles\/|\/articles\/|\/read\//i;
  const gnBusy = new Map();
  const decodeGNews = u => {
    const key = (() => {
      try {
        const x = new URL(u);
        const id = x.pathname.split('/').filter(Boolean).pop();
        return id ? 'gn:' + id : u;
      } catch (e) { return u; }
    })();
    const b = gnBusy.get(key);
    if (b) return b;
    const p = decodeGNewsRun(u, key);
    gnBusy.set(key, p);
    p.then(() => gnBusy.delete(key), () => gnBusy.delete(key));
    return p;
  };
  async function decodeGNewsRun(u, cacheKey) {
    const x = publicURL(u);
    if (!x || !/(^|\.)news\.google\.com$/i.test(x.hostname) || !GN_PATH.test(x.pathname)) return u;
    const hit = gnCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 1800000) return hit.url;
    const id = x.pathname.split('/').filter(Boolean).pop();
    if (!id) return u;
    const page = 'https://news.google.com/rss/articles/' + encodeURIComponent(id) + '?hl=id&gl=ID&ceid=ID:id';
    let pr = null, html = '', landedUrl = '';
    for (let i = 0; i < 2; i++) {
      try {
        const g = await rdSafeGet(page, 12000, { referer: 'https://news.google.com/', 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' });
        pr = g.r;
        landedUrl = g.url || '';
        if (landedUrl && !/(^|\.)news\.google\.com$/i.test(new URL(landedUrl).hostname)) {
          await rdAssertPublic(landedUrl);
          try { if (pr.body && pr.body.cancel) await pr.body.cancel(); } catch (e) {}
          gnCache.set(cacheKey, { url: landedUrl, at: Date.now() });
          lruCap(gnCache, 300);
          return landedUrl;
        }
        if (pr.ok) { html = await mediaText(pr, 1 << 20); break; }
      } catch (e) {}
      if (i === 0) await new Promise(res => setTimeout(res, 800));
    }
    if (!pr || !pr.ok) throw new Error('GN page ' + (pr ? pr.status : 'gagal'));

    const metaRef = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'\s>]+)/i);
    if (metaRef && metaRef[1]) {
      const refUrl = MEDIA.resolveUrl(metaRef[1], page);
      if (refUrl && !/(^|\.)news\.google\.com$/i.test(new URL(refUrl).hostname)) {
        await rdAssertPublic(refUrl);
        gnCache.set(cacheKey, { url: refUrl, at: Date.now() });
        lruCap(gnCache, 300);
        return refUrl;
      }
    }
    const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
    const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sg || !ts) {
      const anch = html.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google\.com)[^"']+)["'][^>]*>/i);
      if (anch && anch[1]) {
        const aUrl = MEDIA.resolveUrl(anch[1], page);
        if (aUrl && !/(^|\.)news\.google\.com$/i.test(new URL(aUrl).hostname)) {
          await rdAssertPublic(aUrl);
          gnCache.set(cacheKey, { url: aUrl, at: Date.now() });
          lruCap(gnCache, 300);
          return aUrl;
        }
      }
      throw new Error('GN signature tidak ada');
    }
    const ctx = [['X','X',['X','X'],null,null,1,1,'US:en',null,1,null,null,null,null,null,0,1],'X','X',1,[1,1,1],1,1,null,0,0,null,0];
    const inner = ['garturlreq', ctx, id, +ts, sg];
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', JSON.stringify(inner), null, '0']]]));
    let br = null;
    for (let i = 0; i < 2; i++) {
      try {
        br = await get('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', referer: 'https://news.google.com/' },
          body
        }, 12000);
        if (br.ok) break;
      } catch (e) {}
      if (i === 0) await new Promise(res => setTimeout(res, 800));
    }
    if (!br || !br.ok) throw new Error('GN decode ' + (br ? br.status : 'gagal'));
    const txt = await br.text();
    let url = '';
    try {
      const rows = JSON.parse(txt.replace(/^\)\]\}'\s*/, '').trim());
      for (const row of rows) {
        if (!Array.isArray(row) || row[0] !== 'wrb.fr') continue;
        let payload = row[2];
        if (typeof payload === 'string') payload = JSON.parse(payload);
        if (Array.isArray(payload) && payload[0] === 'garturlres' && /^https?:\/\//.test(payload[1])) { url = payload[1]; break; }
      }
    } catch (e) {
      const m = txt.match(/\\"garturlres\\",\\"([^"\\]+)/);
      if (m) url = m[1];
    }
    if (!url) throw new Error('GN tidak terurai');
    await rdAssertPublic(url);
    gnCache.set(cacheKey, { url, at: Date.now() });
    lruCap(gnCache, 300);
    return url;
  }

  let jinaChain = Promise.resolve(), jinaLast = 0, jinaPending = 0, jinaSkipUntil = 0;
  const jinaQP = [], jinaQN = [];
  const JINA_KEY = process.env.JINA_API_KEY || '';
  const jinaPump = () => {
    const job = jinaQP.shift() || jinaQN.shift();
    if (!job) return;
    jinaPending++;
    const p = jinaChain.then(async () => {
      if (job.alive && !job.alive()) throw new Error('jina dibatalkan');
      if (job.signal && job.signal.aborted) throw new Error('jina dibatalkan');
      if (!JINA_KEY && Date.now() < jinaSkipUntil) throw new Error('jina 402/429 cooldown');
      const wait = Math.max(0, jinaLast + 2500 - Date.now());
      if (wait) await sleep(wait);
      if (job.alive && !job.alive()) throw new Error('jina dibatalkan');
      if (job.signal && job.signal.aborted) throw new Error('jina dibatalkan');
      jinaLast = Date.now();
      const res = await mediaGet(job.u, job.ms, job.h, undefined, job.prio, job.signal);
      if (res && res.r && res.r.status === 402 && !JINA_KEY) jinaSkipUntil = Date.now() + 300000;
      else if (res && res.r && res.r.status === 429) jinaSkipUntil = Date.now() + 30000;
      return res;
    });
    jinaChain = p.catch(() => {});
    p.then(v => { jinaPending--; job.resolve(v); jinaPump(); },
           e => { jinaPending--; job.reject(e); jinaPump(); });
  };
  const jinaGet = (u, ms, h, alive, prio, signal) => {
    if (!JINA_KEY && Date.now() < jinaSkipUntil) return Promise.reject(new Error('jina 402/429 cooldown'));
    if (jinaPending + jinaQP.length + jinaQN.length >= 12) return Promise.reject(new Error('jina queue penuh'));
    const hdrs = { ...(h || {}) };
    if (JINA_KEY && !hdrs['authorization']) hdrs['authorization'] = 'Bearer ' + JINA_KEY;
    return new Promise((resolve, reject) => {
      (prio ? jinaQP : jinaQN).push({ u, ms, h: hdrs, alive, prio: !!prio, signal: signal || null, resolve, reject });
      jinaPump();
    });
  };

  const docCache = new Map();
  const docAlias = new Map();
  const DOC_CACHE_MAX_HTML = 1 << 20;
  const DOC_CACHE_MAX_BYTES = Math.max(4 << 20, Number(process.env.SITREP_DOC_CACHE_BYTES) || (48 << 20));
  let docCacheBytes = 0;
  function docCacheDelete(k) {
    const prev = docCache.get(k);
    if (prev) {
      docCacheBytes = Math.max(0, docCacheBytes - (prev.bytes || 0));
      docCache.delete(k);
    }
  }
  function docCacheGet(u) {
    if (!u) return null;
    const canon = docAlias.get(u) || MEDIA.canonicalArticleUrl(u) || u;
    const e = docCache.get(canon) || docCache.get(u);
    if (!e || Date.now() - e.at >= 300000) return null;
    const key = docCache.has(canon) ? canon : u;
    docCache.delete(key); docCache.set(key, e);
    return e;
  }
  function docCacheSet(urls, entry) {
    if (!entry || (!entry.html && !entry.jinaTxt)) return;
    const rawList = Array.isArray(urls) ? urls.filter(Boolean) : [urls].filter(Boolean);
    if (!rawList.length) return;
    const keyHint = entry.finalUrl || rawList[0];
    const canonKey = MEDIA.canonicalArticleUrl(keyHint) || keyHint;
    const htmlClipped = typeof entry.html === 'string' && entry.html.length > DOC_CACHE_MAX_HTML
      ? entry.html.slice(0, DOC_CACHE_MAX_HTML)
      : (entry.html || null);
    const jinaTxt = entry.jinaTxt || null;
    const bytes = (htmlClipped ? Buffer.byteLength(htmlClipped, 'utf8') : 0) + (jinaTxt ? Buffer.byteLength(jinaTxt, 'utf8') : 0);
    if (bytes > DOC_CACHE_MAX_BYTES) return;
    docCacheDelete(canonKey);
    const payload = { html: htmlClipped, jinaTxt, bytes, finalUrl: entry.finalUrl || '', via: entry.via || '', at: Date.now() };
    docCache.set(canonKey, payload);
    docCacheBytes += bytes;
    while ((docCache.size > 48 || docCacheBytes > DOC_CACHE_MAX_BYTES) && docCache.size) {
      docCacheDelete(docCache.keys().next().value);
    }
    for (const u of rawList) {
      docAlias.set(u, canonKey);
      lruCap(docAlias, 240);
    }
  }

  const fcFailUntil = new Map();
  const FC_FAIL_TTL = 10 * 60000;
  const fcBlocked = u => {
    const t = fcFailUntil.get(u) || 0;
    if (t > Date.now()) return true;
    if (t) fcFailUntil.delete(u);
    return false;
  };
  const fcFailMark = u => { if (u) { fcFailUntil.set(u, Date.now() + FC_FAIL_TTL); lruCap(fcFailUntil, 500); } };

  const mediaCacheKey = canon => 'v' + PIPELINE_VERSION + ':' + canon;
  function mediaCacheGet(u, canon) {
    const cUrl = canon || urlToCanon.get(u) || MEDIA.canonicalArticleUrl(u);
    if (!cUrl) return null;
    const hit = thumbCache.get(mediaCacheKey(cUrl));
    if (!hit || hit.schemaVersion !== PIPELINE_VERSION) return null;
    const v = hit.v;
    const ttl = v && v.hero && v.hero.verified ? 900000 : (v && v.transientFailure ? 15000 : 300000);
    if (Date.now() - hit.at >= ttl) return null;
    return { ...v, diagnostics: { ...(v.diagnostics || {}), cacheHit: true } };
  }
  function mediaCacheSet(urls, mediaRes) {
    if (!mediaRes || !mediaRes.canonicalUrl) return;
    const ck = mediaCacheKey(mediaRes.canonicalUrl);
    thumbCache.set(ck, { v: mediaRes, at: Date.now(), schemaVersion: PIPELINE_VERSION });
    lruCap(thumbCache, 400);
    if (mediaRes.hero && (mediaRes.hero.verified || !mediaRes.transientFailure)) {
      const nrKey = 'newsresp:v' + PIPELINE_VERSION;
      cache.delete(nrKey);
      bodyCache.delete(nrKey);
    }
    for (const u of urls) {
      if (u) {
        urlToCanon.set(u, mediaRes.canonicalUrl);
        lruCap(urlToCanon, 800);
      }
    }
  }

  function isHijackedThumbHtml(article, finalUrl, html, fromProxy) {
    const wireIt = rdWireFind(article);
    return MEDIA.isHijackedHtml(article, finalUrl, html, fromProxy, wireIt && wireIt.title);
  }

  const thumbBusy = new Map();
  const thumbSem = makeSem(12, 80);
  const thumb = u => {
    const c = MEDIA.canonicalArticleUrl(u) || u;
    const b = thumbBusy.get(c);
    if (b) return b;
    const p = thumbRun(u);
    thumbBusy.set(c, p);
    p.then(() => thumbBusy.delete(c), () => thumbBusy.delete(c));
    return p;
  };

  async function resolvePlayableVideos(html, finalUrl, title, seed = []) {
    const list = [...(Array.isArray(seed) ? seed : [])];
    const yid = finalUrl ? ytIdOf(finalUrl) : '';
    if (yid && !list.some(v => v && String(v.url || '').includes(yid))) {
      list.unshift({ url: 'https://www.youtube.com/embed/' + yid, kind: 'iframe', poster: '' });
    }
    if (html) {
      for (const v of rdVideos(html, finalUrl || '', true, title || '', rdOnTopic)) {
        if (v && v.kind !== 'probe' && !list.some(x => x && x.url === v.url)) list.push(v);
      }
    }
    const playable = list.filter(v => v && (v.kind === 'iframe' || v.kind === 'video'));
    if (!playable.length) return [];
    try {
      const gated = await rdVideoGate({ title: title || '', desc: '', paras: [], videos: playable, blocks: [] });
      const out = (gated.videos || []).filter(v => v && (v.kind === 'iframe' || v.kind === 'video')).slice(0, 4);
      for (const v of out) if (v.url) registerVhsUrl(v.url);
      return out;
    } catch {
      return playable.slice(0, 4);
    }
  }

  function formatThumbResponse(mediaRes) {
    const hero = mediaRes && mediaRes.hero;
    const bodyFallback = (!hero || !hero.verified) && Array.isArray(mediaRes && mediaRes.bodyImages)
      ? mediaRes.bodyImages.find(b => b && b.verified && b.url && b.width >= 360)
      : null;
    const chosen = (hero && hero.verified) ? hero : bodyFallback;
    const status = (hero && hero.verified) ? (hero.status || 'verified')
      : (bodyFallback ? 'verified' : ((hero && hero.status) || 'no_candidates'));
    return {
      img: (chosen && chosen.url) || '',
      w: (chosen && chosen.width) || 0,
      h: (chosen && chosen.height) || 0,
      src: mediaRes.canonicalUrl || mediaRes.requestedUrl || '',
      canonicalUrl: mediaRes.canonicalUrl || '',
      source: (chosen && chosen.source) || 'none',
      method: (chosen && (chosen.method || (bodyFallback ? 'body_fallback' : ''))) || 'none',
      aspectRatio: (chosen && chosen.aspectRatio) || 0,
      mime: (chosen && chosen.mime) || '',
      bytes: (chosen && chosen.bytes) || 0,
      verified: Boolean(chosen && (chosen.verified === true || bodyFallback)),
      proxy: Boolean(chosen && chosen.proxy),
      status,
      transient: Boolean(!chosen && mediaRes.transientFailure),
      videos: Array.isArray(mediaRes.videos) ? mediaRes.videos : [],
      schemaVersion: PIPELINE_VERSION,
      diagnostics: mediaRes.diagnostics || null,
    };
  }

  function injectSyntheticHead(html, md = {}) {
    let s = String(html || '');
    if (!md || typeof md !== 'object') return s;
    const escAttr = v => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = md.title || md.ogTitle || md['og:title'] || '';
    const desc = md.description || md.ogDescription || md['og:description'] || '';
    const site = md.ogSiteName || md['og:site_name'] || '';
    const time = md['article:published_time'] || md.publishedTime || '';
    const author = md['article:author'] || md.author || '';
    const img = md.ogImage || (Array.isArray(md['og:image']) ? md['og:image'][0] : md['og:image']) || '';

    const tags = [];
    if (title) {
      if (!/<title\b/i.test(s)) tags.push(`<title>${escAttr(title)}</title>`);
      if (!/<meta\b[^>]*property=["']og:title["']/i.test(s)) tags.push(`<meta property="og:title" content="${escAttr(title)}">`);
    }
    if (desc && !/<meta\b[^>]*property=["']og:description["']/i.test(s)) {
      tags.push(`<meta property="og:description" content="${escAttr(desc)}">`);
      tags.push(`<meta name="description" content="${escAttr(desc)}">`);
    }
    if (site && !/<meta\b[^>]*property=["']og:site_name["']/i.test(s)) {
      tags.push(`<meta property="og:site_name" content="${escAttr(site)}">`);
    }
    if (time && !/<meta\b[^>]*property=["']article:published_time["']/i.test(s)) {
      tags.push(`<meta property="article:published_time" content="${escAttr(time)}">`);
    }
    if (author && !/<meta\b[^>]*name=["']author["']/i.test(s)) {
      tags.push(`<meta name="author" content="${escAttr(author)}">`);
    }
    if (img && !/<meta\b[^>]*property=["']og:image["']/i.test(s)) {
      tags.push(`<meta property="og:image" content="${escAttr(img)}">`);
    }
    if (!tags.length) return s;

    if (/<head\b[^>]*>/i.test(s)) {
      return s.replace(/<head\b[^>]*>/i, `$&\n${tags.join('\n')}`);
    }
    if (/<body\b/i.test(s)) {
      return s.replace(/<body\b/i, `<head>\n${tags.join('\n')}\n</head>\n$&`);
    }
    return `<head>\n${tags.join('\n')}\n</head>\n${s}`;
  }

  async function thumbRun(u) {
    const x = publicURL(u);
    if (!x) throw new Error('url tidak valid');
    const bannedThumb = canonUrl => ({
      img: '', w: 0, h: 0, src: canonUrl || u, canonicalUrl: canonUrl || u,
      source: 'none', method: 'none', aspectRatio: 0, mime: '', bytes: 0,
      verified: false, proxy: false, status: 'rejected', transient: false,
      videos: [], schemaVersion: PIPELINE_VERSION, diagnostics: null,
    });
    if (isBannedHostUrl(u)) return bannedThumb(u);
    const preHit = mediaCacheGet(u);
    if (preHit) return formatThumbResponse(preHit);

    let article = u;
    if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) {
      article = await decodeGNews(u);
      if (article === u) throw new Error('gagal resolve google news');
    }
    if (isBannedHostUrl(article)) return bannedThumb(article);
    const canon = MEDIA.canonicalArticleUrl(article) || article;
    const hitA = mediaCacheGet(u, canon);
    if (hitA) return formatThumbResponse(hitA);

    if (readBusy.has(canon)) {
      try { await readBusy.get(canon); } catch (e) {}
      const hitAfter = mediaCacheGet(u, canon);
      if (hitAfter) return formatThumbResponse(hitAfter);
    }

    const rHit = getReadCache(canon);
    if (rHit && rHit.media) {
      mediaCacheSet([u, article, canon], rHit.media);
      return formatThumbResponse(rHit.media);
    }

    await rdAssertPublic(article);
    const wireIt = rdWireFind(article) || rdWireFind(u);
    return thumbSem(() => thumbFetchAndResolve(u, article, canon, wireIt));
  }

  async function thumbFetchAndResolve(u, article, canon, wireIt) {
    const thumbAc = new AbortController();
    const tryDocFetch = async (targetUrl, ms, hdrs, fromProxy = false, via = 'html') => {
      if (thumbAc.signal.aborted) throw new Error('dibatalkan');
      const g = fromProxy
        ? await mediaGet(targetUrl, ms, hdrs, null, false, thumbAc.signal)
        : await rdSafeGet(targetUrl, ms, hdrs, thumbAc.signal);
      const r = g.r;
      const finalUrl = fromProxy ? article : g.url;
      if (!r.ok) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {} throw new Error('HTTP ' + r.status); }
      const ct = r.headers.get('content-type') || '';
      if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {} throw new Error('bukan HTML'); }
      const html = await mediaText(r, 3 << 20);
      if (!html || html.length < 400) throw new Error('html tipis');
      if (BOT_CHALLENGE_RE.test(html.slice(0, 30000))) throw new Error('halaman challenge');
      if (isHijackedThumbHtml(article, finalUrl, html, fromProxy)) throw new Error('redirect mencurigakan');
      return { html, finalUrl, via };
    };

    let doc = null;
    let jinaMd = null;
    let upstreamStatus = 'ok';
    const cachedDoc = docCacheGet(canon) || docCacheGet(article) || docCacheGet(u);
    if (cachedDoc) {
      if (cachedDoc.html) doc = { html: cachedDoc.html, finalUrl: cachedDoc.finalUrl || article, via: cachedDoc.via || 'doc-cache' };
      if (cachedDoc.jinaTxt) jinaMd = cachedDoc.jinaTxt;
    }
    let artHost = '';
    try { artHost = new URL(article).hostname; } catch (e) {}
    const isWafHost = CF_WAF_HOST_RE.test(artHost);
    if (!doc && !jinaMd) {
      const directP = (isWafHost
        ? sleep(250).then(() => tryDocFetch(article, 6000, {}, false, 'direct'))
        : tryDocFetch(article, 7000, {}, false, 'direct'));
      const fastBotP = tryDocFetch(article, 6000, { 'user-agent': RD_BOT_UAS[0] }, false, 'bot');

      directP.catch(() => {});
      fastBotP.catch(() => {});
      const fast = await Promise.race([
        (isWafHost ? fastBotP : directP).catch(() => null),
        sleep(1800).then(() => 'slow')
      ]);
      if (fast && fast !== 'slow') {
        doc = fast;
        try { thumbAc.abort(); } catch {}
      } else {
        const jobs = [directP, fastBotP];
        jobs.push((async () => {
          for (const bua of RD_BOT_UAS.slice(1, 5)) {
            if (thumbAc.signal.aborted) break;
            try { return await tryDocFetch(article, 4500, { 'user-agent': bua }, false, 'bot'); }
            catch (e) {}
          }
          throw new Error('bot gagal');
        })());
        for (const av of rdAmpVariants(article).slice(0, 2)) {
          jobs.push(tryDocFetch(av, 4500, { 'user-agent': RD_BOT_UAS[0] }, false, 'amp'));
        }
        for (const px of RD_PROXIES.slice(0, CUSTOM_PROXY ? 2 : 1)) {
          jobs.push(tryDocFetch(px(article), 5000, {}, true, 'proxy'));
        }
        for (const j of jobs) j.catch(() => {});
        doc = await Promise.any(jobs).catch(() => null);
        try { thumbAc.abort(); } catch {}
      }

      if (!doc) {
        try {
          const { r } = await jinaGet('https://r.jina.ai/' + article, 9000, { accept: 'text/plain' });
          if (r.ok) {
            const txt = await mediaText(r, 2 << 20);
            if (txt && !BOT_CHALLENGE_RE.test(txt.slice(0, 5000))) jinaMd = txt;
          }
        } catch (e) {}
      }
      const FC_KEY = process.env.FIRECRAWL_API_KEY || '';
      if (!doc && !jinaMd && FC_KEY && !fcBlocked(article)) {
        let fcOk = false;
        try {
          const r = await get('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
            body: JSON.stringify({ url: article, formats: ['html'], onlyMainContent: false, timeout: 8000 })
          }, 9000);
          if (r.ok) {
            const j = await r.json();
            let html = j && j.data && j.data.html;
            const md = (j && j.data && j.data.metadata) || {};
            if (html && String(html).length > 500 && !BOT_CHALLENGE_RE.test(String(html).slice(0, 30000))) {
              html = injectSyntheticHead(String(html), md);
              doc = { html: html.slice(0, 3e6), finalUrl: article, via: 'firecrawl' };
              fcOk = true;
            }
          }
        } catch (e) {}
        if (!fcOk) fcFailMark(article);
      }
    }

    if (!doc && !jinaMd) upstreamStatus = 'upstream_blocked_or_failed';
    const targetFinal = (doc && doc.finalUrl) || article;
    const finalCanon = MEDIA.canonicalArticleUrl(targetFinal) || canon;
    const rssImgs = wireIt ? (wireIt.rssImgs || (wireIt.rssImg ? [wireIt.rssImg] : [])) : [];

    if (doc || jinaMd) {
      docCacheSet([u, article, canon, finalCanon], {
        html: doc ? doc.html : null,
        jinaTxt: jinaMd || null,
        finalUrl: targetFinal,
        via: doc ? doc.via : 'jina',
      });
    }

    let mediaRes = await MEDIA.resolveArticleMedia({
      requestedUrl: u,
      canonicalUrl: finalCanon,
      html: doc ? doc.html : null,
      jinaMarkdown: jinaMd,
      rssImgs,
      mode: 'full',
      method: doc ? doc.via : (jinaMd ? 'jina' : (rssImgs.length ? 'rss' : 'none')),
      wireTitle: (wireIt && wireIt.title) || '',
      probeFn: probeImage,
      reuseTracker: assetReuse,
      upstreamStatus,
    });

    if (!mediaRes.hero.verified && !(mediaRes.bodyImages && mediaRes.bodyImages.length) && mediaRes.hero.status === 'no_candidates' && doc && !jinaMd) {
      try {
        const { r } = await jinaGet('https://r.jina.ai/' + targetFinal, 10000, { accept: 'text/plain' });
        if (r.ok) {
          const txt = await mediaText(r, 2 << 20);
          if (txt && !BOT_CHALLENGE_RE.test(txt.slice(0, 5000))) {
            jinaMd = txt;
            docCacheSet([u, article, canon, finalCanon], { html: doc.html, jinaTxt: jinaMd, finalUrl: targetFinal, via: doc.via });
            mediaRes = await MEDIA.resolveArticleMedia({
              requestedUrl: u,
              canonicalUrl: finalCanon,
              html: doc.html,
              jinaMarkdown: jinaMd,
              rssImgs,
              mode: 'full',
              method: 'jina',
              wireTitle: (wireIt && wireIt.title) || '',
              probeFn: probeImage,
              reuseTracker: assetReuse,
              upstreamStatus,
            });
          }
        }
      } catch (e) {}
    }
    mediaRes.mode = 'full';
    if ((!doc && !jinaMd && !mediaRes.hero.verified) || (mediaRes.hero.status === 'no_candidates' && !(mediaRes.bodyImages && mediaRes.bodyImages.length))) {
      mediaRes.transientFailure = true;
      if (!doc && !jinaMd) mediaRes.hero.status = 'upstream_blocked';
    }
    mediaRes.videos = await resolvePlayableVideos(doc ? doc.html : '', targetFinal, (wireIt && wireIt.title) || '');
    mediaCacheSet([u, article, canon, finalCanon], mediaRes);
    return formatThumbResponse(mediaRes);
  }

  const IMG_HOSTS = ['fbcdn.net', 'cdninstagram.com', 'unavatar.io', 'googleusercontent.com', 'ggpht.com'];
  const imgOK = u => { try { const h = new URL(u); return h.protocol === 'https:' && IMG_HOSTS.some(d => h.hostname === d || h.hostname.endsWith('.' + d)); } catch (e) { return false; } };
  async function img(u, res) {
    const vMeta = u ? verifiedProxyImgs.get(u) : null;
    if (!u || (!imgOK(u) && !vMeta)) { res.writeHead(403); return res.end('host tidak diizinkan'); }

    const origHost = (() => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } })();
    const sameRootHost = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
    const hopOK = vMeta
      ? (hopU => {
          if (imgOK(hopU) || verifiedProxyImgs.has(hopU)) return true;
          try { const hh = new URL(hopU).hostname.toLowerCase(); return Boolean(origHost && sameRootHost(hh, origHost)); }
          catch { return false; }
        })
      : imgOK;
    const reqHdrs = vMeta
      ? {
          accept: 'image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8',
          ...(vMeta.ua ? { 'user-agent': vMeta.ua } : {}),
          ...(vMeta.referer ? { referer: vMeta.referer } : {}),
        }
      : {};
    let r;
    try { ({ r } = await mediaGet(u, 12000, reqHdrs, hopOK)); }
    catch (e) { res.writeHead(502); return res.end(); }
    if (r.status === 403 && vMeta && !vMeta.ua) {
      try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
      try { ({ r } = await mediaGet(u, 12000, { ...reqHdrs, 'user-agent': RD_BOT_UAS[0] }, hopOK)); }
      catch (e) { res.writeHead(502); return res.end(); }
    }
    if (!r.ok) { res.writeHead(r.status); return res.end(); }
    const ct = r.headers.get('content-type') || '';
    const ctLow = ct.split(';')[0].trim().toLowerCase();
    if (!/^image\//i.test(ctLow) || /^image\/svg\+xml\b/i.test(ctLow)) { res.writeHead(415); return res.end('bukan gambar'); }
    let buf;
    try { buf = await mediaBody(r, 5 << 20); }
    catch (e) { res.writeHead(/terlalu besar/.test(e.message) ? 413 : 502); return res.end('terlalu besar'); }
    const hdrs = {
      'content-type': ctLow || 'image/jpeg',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    };
    if (openCors()) hdrs['access-control-allow-origin'] = '*';
    res.writeHead(200, hdrs);
    res.end(buf);
  }

  const vhsPx = u => {
    registerVhsUrl(u);
    return (AUTH.userMode || AUTH.publicMode)
      ? ('/vhs?u=' + encodeURIComponent(u))
      : ('/vhs?u=' + encodeURIComponent(u) + '&token=' + encodeURIComponent(API_TOKEN));
  };
  async function vhs(u, req, res) {
    if (!res) { res = req; req = null; }
    let href;
    try { href = new URL(u).href; if (!/^https?:$/.test(new URL(href).protocol)) throw 0; } catch (e) { res.writeHead(400); return res.end('url tidak valid'); }
    const base = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      ...(openCors() ? { 'access-control-allow-origin': '*' } : {})
    };
    const ac = req ? new AbortController() : null;
    const onClose = ac ? () => ac.abort() : null;
    if (req && onClose) req.on('close', onClose);

    try {
      let g;
      try { g = await mediaGet(href, 15000, {}, null, true, ac ? ac.signal : null); }
      catch (e) { if (!res.writableEnded) { res.writeHead(502, base); res.end(); } return; }
      const r = g.r, furl = g.url;
      const ct = r.headers.get('content-type') || '';
      const ctLow = ct.split(';')[0].trim().toLowerCase();
      if (!r.ok) { try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {} res.writeHead(r.status, base); return res.end(); }
      if (ctLow && /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/javascript|application\/javascript|text\/xml|application\/xml)\b/i.test(ctLow)) {
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
        res.writeHead(415, base); return res.end('konten bukan media');
      }
      if (/mpegurl/i.test(ctLow) || /\.m3u8(\?|#|$)/.test(furl)) {
        let txt;
        try { txt = await mediaText(r, 2 << 20); }
        catch (e) { res.writeHead(502, base); return res.end(); }
        txt = txt.split('\n').map(l => {
          const t = l.trim(); if (!t) return l;
          if (t[0] === '#') return t.replace(/URI="([^"]+)"/g, (m, p) => 'URI="' + vhsPx(new URL(p, furl).href) + '"');
          return vhsPx(new URL(t, furl).href);
        }).join('\n');
        res.writeHead(200, { ...base, 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(txt);
      }
      if (ctLow && !/^(?:video\/|audio\/|application\/(?:octet-stream|mp4)|binary\/octet-stream$)/i.test(ctLow)) {
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
        res.writeHead(415, base); return res.end('konten bukan media');
      }
      let buf;
      try { buf = await mediaBody(r, 20 << 20); }
      catch (e) { res.writeHead(/terlalu besar/.test(e.message) ? 413 : 502, base); return res.end(); }
      res.writeHead(200, { ...base, 'content-type': ctLow || 'video/mp4' }); res.end(buf);
    } finally {
      if (req && onClose) req.off('close', onClose);
    }
  }

  async function cctvFirecrawl(url) {
    const FC_KEY = process.env.FIRECRAWL_API_KEY || '';
    if (!FC_KEY || fcBlocked(url)) return '';
    let ok = false;
    try {
      const r = await get('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
        body: JSON.stringify({ url, formats: ['html'], onlyMainContent: false, timeout: 30000 })
      }, 40000);
      if (r.ok) {
        const j = await r.json();
        const h = (j && j.data && j.data.html) || '';
        if (h) { ok = true; return h; }
      }
    } catch (e) {}
    if (!ok) fcFailMark(url);
    return '';
  }

  const ENT = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'…', mdash:'—', ndash:'–',
    lsquo:'‘', rsquo:'’', ldquo:'“', rdquo:'”', laquo:'«', raquo:'»', bull:'•', middot:'·', copy:'©', reg:'®',
    trade:'™', ntilde:'ñ', Ntilde:'Ñ', eacute:'é', Eacute:'É', egrave:'è', agrave:'à', aacute:'á', iacute:'í', oacute:'ó', uacute:'ú', uuml:'ü', ouml:'ö', auml:'ä', ccedil:'ç', acirc:'â', ecirc:'ê', ocirc:'ô', icirc:'î', ucirc:'û', szlig:'ß', oslash:'ø', aring:'å', aelig:'æ', iexcl:'¡', iquest:'¿', plusmn:'±', frac12:'½', laquo2:'«', shy:'', ensp:' ', emsp:' ', thinsp:' ', zwnj:'', zwj:'', deg:'°', times:'×', divide:'÷', euro:'€', pound:'£', yen:'¥', sect:'§', para:'¶' };
  const rdChr = n => { try { return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch (e) { return ''; } };
  const rdUnent = s => String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => rdChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => rdChr(+d))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, n) => ENT[n.toLowerCase()] != null ? ENT[n.toLowerCase()] : m);
  const rdClean = s => rdUnent(String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const rdInline = s => rdClean(s).replace(/\s+/g, ' ');
  const rdHost = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

  const rdMeta = html => EXTRACT.rdMeta(html);
  const rdLd = html => EXTRACT.rdLd(html);
  const rdOnTopic = (title, desc, paras) => EXTRACT.rdOnTopic(title, desc, paras);
  const rdVideos = (html, finalURL, dom = true, title = '') => EXTRACT.rdVideos(html, finalURL, dom, title);
  const rdExtract = (html, finalURL, opts = {}) => EXTRACT.rdExtract(html, finalURL, opts);
  const rdJinaMd = (txt, url, opts = {}) => EXTRACT.rdJinaMd(txt, url, opts);

  const RD_STOP = new Set('yang dan untuk dengan dari pada dalam akan atau juga tidak ini itu oleh para telah sudah bisa saat usai jadi lebih hingga serta kata kini ada sebagai antara bagi agar kembali ungkap soal terkait'.split(' '));
  const VID_FILE = /\.(mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i;
  const rdYT = u => { const m = String(u).match(/(?:youtube\.com\/(?:embed|shorts)\/|youtu\.be\/|youtube-nocookie\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{6,15})/i); return m ? 'https://www.youtube.com/embed/' + m[1] : ''; };

  const rdYtTitleCache = new Map();
  async function rdYtTitle(id) {
    if (rdYtTitleCache.has(id)) return rdYtTitleCache.get(id);
    let t = null;
    try { const r = await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), {}, 6000); if (r.ok) { const j = await r.json(); t = String(j.title || '') + ' ' + String(j.author_name || ''); } } catch (e) {}
    rdYtTitleCache.set(id, t); if (rdYtTitleCache.size > 300) rdYtTitleCache.delete(rdYtTitleCache.keys().next().value);
    return t;
  }

  const rdYtPlayCache = new Map();
  async function rdYtPlayable(id) {
    if (rdYtPlayCache.has(id)) return rdYtPlayCache.get(id);
    let v = null;
    try {
      const r = await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), {}, 6000);
      if (r.status === 400 || r.status === 401 || r.status === 404) v = false;
      else if (r.ok) v = true;
    } catch (e) {}
    rdYtPlayCache.set(id, v); if (rdYtPlayCache.size > 300) rdYtPlayCache.delete(rdYtPlayCache.keys().next().value);
    return v;
  }

  async function rdVideoGate(d) {
    const tokOf = x => [...new Set(String(x || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !RD_STOP.has(w)))];
    const ctx = ' ' + tokOf([d.title, d.desc, ...(d.paras || []).slice(0, 8)].join(' ')).join(' ') + ' ';
    const vids = [...(d.videos || [])];
    const hasFile = (blocks) => vids.concat((blocks || []).filter(b => b.k === 'v' && b.v).map(b => b.v)).some(v => v && v.kind === 'video');
    const verdict = new Map();
    const all = vids.concat((d.blocks || []).filter(b => b.k === 'v' && b.v).map(b => b.v));
    const positioned = new Set((d.blocks || []).filter(b => b.k === 'v' && b.v).map(b => String(b.v.url).split('?')[0]));
    await Promise.all(all.map(async v => {
      if (!v || verdict.has(v.url)) return;
      const yid = rdYT(v.url) && (v.url.match(/embed\/([\w-]{6,15})/) || [])[1];
      if (yid) {
        const play = await rdYtPlayable(yid);
        if (play === false) { verdict.set(v.url, false); return; }
        if (!positioned.has(String(v.url).split('?')[0])) {
          const t = await rdYtTitle(yid);
          if (t) { const yt = tokOf(t); if (yt.length >= 2 && !yt.some(w => ctx.includes(' ' + w))) { verdict.set(v.url, false); return; } }
        }
      }
      if (v.kind === 'iframe' && !yid && hasFile(d.blocks)) { verdict.set(v.url, false); return; }
      verdict.set(v.url, true);
    }));
    const ok = v => !v || verdict.get(v.url) !== false;
    d.videos = (d.videos || []).filter(ok);
    d.blocks = (d.blocks || []).filter(b => b.k !== 'v' || ok(b.v));
    return d;
  }

  function rdWireFind(targetUrl) {
    const norm = u => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
    const tNorm = norm(targetUrl);
    const tCanon = MEDIA.canonicalArticleUrl(targetUrl);
    for (const [k, c] of cache) {
      if (!k.startsWith('n:') || !c || !c.v || !Array.isArray(c.v.items)) continue;
      for (const i of c.v.items) {
        if (!i || !i.url) continue;
        if (norm(i.url) === tNorm || MEDIA.canonicalArticleUrl(i.url) === tCanon) return i;
        let gnKey = '';
        try {
          const x = new URL(i.url);
          if (/(^|\.)news\.google\.com$/i.test(x.hostname)) {
            const id = x.pathname.split('/').filter(Boolean).pop();
            if (id) gnKey = 'gn:' + id;
          }
        } catch (e) {}
        const g = (gnKey && gnCache.get(gnKey)) || gnCache.get(i.url);
        const gu = g && (g.url || g);
        if (gu && (norm(gu) === tNorm || MEDIA.canonicalArticleUrl(gu) === tCanon)) return { ...i, url: gu };
      }
    }
    return null;
  }
  function rdWireRssImgs(url) {
    const w = rdWireFind(url);
    if (!w) return [];
    return Array.isArray(w.rssImgs) && w.rssImgs.length ? w.rssImgs : (w.rssImg ? [w.rssImg] : (w.img ? [w.img] : []));
  }
  function rdWireImg(url) {
    const w = rdWireFind(url);
    if (!w) return '';
    if (w.imgVerified && w.img) return w.img;
    const canon = MEDIA.canonicalArticleUrl(url) || url;
    const hit = mediaCacheGet(url, canon);
    return (hit && hit.hero && hit.hero.verified && hit.hero.url) ? hit.hero.url : '';
  }
  function rdWireTitles() {
    const set = new Set();
    for (const [k, c] of cache) {
      if (!k.startsWith('n:') || !c || !c.v || !Array.isArray(c.v.items)) continue;
      for (const i of c.v.items) { const n = String(i.title || '').toLowerCase().replace(/\W+/g, ' ').trim(); if (n.length > 25) set.add(n); }
    }
    return set;
  }

  async function rdHydrateVideos(d, article) {
    const probes = (d.videos || []).filter(v => v.kind === 'probe').slice(0, 2);
    if (!probes.length) return d;
    const resolved = await Promise.all(probes.map(async p => {
      try {
        const { r } = await mediaGet(p.url, 10000, { referer: article });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        if (!/text\/html|application\//i.test(ct)) return { url: p.url, kind: VID_FILE.test(p.url) ? 'video' : 'probe', poster: p.poster };
        const innerHtml = await mediaText(r, 2 << 20);
        const im = rdMeta(innerHtml), iTitle = rdInline(im['og:title'] || im.title || '');
        const inner = rdVideos(innerHtml, p.url, true, d.title || '');
        let good = inner.find(v => v.kind === 'video') || inner.find(v => v.kind === 'iframe');
        if (good && d.title && iTitle.length > 8 && !rdOnTopic(d.title, '', [iTitle])) good = null;
        return good || null;
      } catch (e) { return null; }
    }));
    const rest = (d.videos || []).filter(v => v.kind !== 'probe');
    d.videos = [...resolved.filter(Boolean), ...rest].slice(0, 4);
    return d;
  }

  const CUSTOM_PROXY = process.env.CUSTOM_PROXY_URL || process.env.PROXY_URL || CFG.custom_proxy || '';
  const RD_PROXIES = [
    ...(CUSTOM_PROXY ? [u => CUSTOM_PROXY.includes('%s') ? CUSTOM_PROXY.replace('%s', encodeURIComponent(u)) : (CUSTOM_PROXY.endsWith('=') || CUSTOM_PROXY.endsWith('?') || CUSTOM_PROXY.endsWith('/') ? CUSTOM_PROXY + encodeURIComponent(u) : CUSTOM_PROXY + '?url=' + encodeURIComponent(u))] : []),
    u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
  ];
  const readCache = new Map();
  const READ_FAIL_TRANSIENT_TTL = 15000;
  const READ_FAIL_PERM_TTL = 180000;
  function getReadCache(canon, raw) {
    const keys = [canon, raw && urlToCanon.get(raw), raw && MEDIA.canonicalArticleUrl(raw)].filter(Boolean);
    for (const c of keys) {
      const hit = readCache.get('v' + PIPELINE_VERSION + ':' + c);
      if (hit && hit.schemaVersion === PIPELINE_VERSION && Date.now() - hit.at < hit.ttl) {
        return hit.v;
      }
    }
    return null;
  }
  function setReadCache(urls, val, ttl) {
    const canon = (val && val.canonicalUrl) || MEDIA.canonicalArticleUrl(urls[0]) || urls[0];
    if (!canon) return;
    readCache.set('v' + PIPELINE_VERSION + ':' + canon, { v: val, at: Date.now(), ttl, schemaVersion: PIPELINE_VERSION });
    lruCap(readCache, 250);
    for (const u of urls) {
      if (u) {
        urlToCanon.set(u, canon);
        lruCap(urlToCanon, 800);
      }
    }
  }

  function rdAssembleBlocks(d, mediaRes) {
    if (!d) return d;
    const origBlocks = (Array.isArray(d.blocks) && d.blocks.length)
      ? d.blocks.slice()
      : (d.paras || []).map(t => ({ k: 'p', t }));

    const origImgPos = new Map();
    const videos = [];
    const seenV = new Set();
    const pushV = (v, kPos) => {
      if (!v || v.kind === 'probe') return;
      const vk = 'v|' + String(v.url).split('?')[0];
      if (seenV.has(vk)) return;
      seenV.add(vk);
      videos.push({ b: { k: 'v', v }, k: kPos });
    };

    let tCount = 0;
    for (const b of origBlocks) {
      if (b.k === 'p' || b.k === 'h' || b.k === 'q' || b.k === 'li') {
        tCount++;
        continue;
      }
      if (b.k === 'v') {
        pushV(b.v, tCount);
        continue;
      }
      if (b.k === 'i' && b.img && b.img.url) {
        const up = upgradeImage(b.img.url);
        const ik = rdImgKey(b.img.url);
        const info = { k: tCount, cap: b.img.cap || '' };
        if (!origImgPos.has(b.img.url)) origImgPos.set(b.img.url, info);
        if (up && !origImgPos.has(up)) origImgPos.set(up, info);
        if (ik && !origImgPos.has(ik)) origImgPos.set(ik, info);
      }
    }
    for (const v of (d.videos || [])) pushV(v, -1);

    const verifiedBody = (mediaRes && Array.isArray(mediaRes.bodyImages)) ? mediaRes.bodyImages : [];
    const capKey = t => String(t || '').toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 80);
    const capSet = new Set();
    if (mediaRes && mediaRes.hero && mediaRes.hero.caption) capSet.add(capKey(mediaRes.hero.caption));
    for (const bi of verifiedBody) if (bi.cap) capSet.add(capKey(bi.cap));

    const textBlocks = origBlocks.filter(b =>
      (b.k === 'p' || b.k === 'h' || b.k === 'q' || b.k === 'li') &&
      !(b.k === 'p' && capSet.has(capKey(b.t)))
    );
    d.paras = textBlocks.filter(b => b.k !== 'h').map(b => b.t);

    const n = textBlocks.length;
    if (n === 0) {
      d.blocks = videos.map(x => x.b);
      return d;
    }

    const media = [];
    for (const bi of verifiedBody) {
      const m = origImgPos.get(bi.url) || origImgPos.get(upgradeImage(bi.url)) || origImgPos.get(rdImgKey(bi.url));
      media.push({
        b: {
          k: 'i',
          img: {
            url: bi.url,
            cap: bi.cap || (m && m.cap) || '',
            width: bi.width || 0,
            height: bi.height || 0,
            aspectRatio: bi.aspectRatio || 0,
            ...(bi.proxy ? { proxy: true } : {}),
          },
        },
        k: m ? m.k : -1,
      });
    }
    for (const x of videos) media.push(x);

    const m = media.length;
    if (!m) { d.blocks = textBlocks; return d; }

    const lo = 1;
    const hi = n >= 2 ? Math.max(lo, m > (n - 1) ? n : n - 1) : 1;
    const slots = hi - lo + 1;
    let ks = media.map((x, i) => x.k < 0 ? Math.round(n * (i + 1) / (m + 1)) : x.k);
    ks = ks.map(k => Math.min(hi, Math.max(lo, k)));
    let ok = true;
    for (let i = 1; i < ks.length; i++) {
      if (ks[i] <= ks[i - 1]) ks[i] = ks[i - 1] + 1;
      if (ks[i] > hi) ok = false;
    }
    if (!ok) ks = media.map((_, i) => Math.min(hi, lo + Math.floor(i * slots / m)));

    const out = [];
    let ti = 0, mi = 0;
    const flush = () => { while (mi < m && ks[mi] <= ti) out.push(media[mi++].b); };
    for (const tb of textBlocks) { out.push(tb); ti++; flush(); }
    while (mi < m) out.push(media[mi++].b);
    d.blocks = out;
    return d;
  }

  async function rdFinish(d, url, canonUrl, html, jinaMd, via, wireIt) {
    const hydP = rdHydrateVideos(d, url);
    const rssImgs = rdWireRssImgs(url).concat(canonUrl && canonUrl !== url ? rdWireRssImgs(canonUrl) : []);
    const upstreamStatus = (via === 'wire-fallback' || via === 'meta') ? 'upstream_blocked_or_failed' : 'ok';

    const resolvedCanon = canonUrl || MEDIA.canonicalArticleUrl(url) || url;
    const cachedMedia = mediaCacheGet(url, resolvedCanon);
    const reuseFullMedia = Boolean(
      cachedMedia && cachedMedia.schemaVersion === PIPELINE_VERSION && cachedMedia.mode === 'full' &&
      cachedMedia.canonicalUrl && !cachedMedia.transientFailure &&
      ((cachedMedia.hero && cachedMedia.hero.verified) || (Array.isArray(cachedMedia.bodyImages) && cachedMedia.bodyImages.length))
    );

    const mediaP = !/youtube\.com|youtu\.be/i.test(url)
      ? (reuseFullMedia
          ? Promise.resolve(cachedMedia)
          : MEDIA.resolveArticleMedia({
              requestedUrl: url,
              canonicalUrl: resolvedCanon,
              html: html || null,
              jinaMarkdown: jinaMd || null,
              rssImgs,
              mode: 'full',
              method: via === 'wire-fallback' ? 'rss' : via,
              wireTitle: (wireIt && wireIt.title) || d.title || '',
              probeFn: probeImage,
              reuseTracker: assetReuse,
              upstreamStatus,
            }))
      : Promise.resolve(null);

    const [, mediaRes] = await Promise.all([hydP, mediaP]);

    if (mediaRes) {
      mediaRes.mode = 'full';
      d.img = (mediaRes.hero && mediaRes.hero.url) || '';
      d.imgVerified = Boolean(mediaRes.hero && mediaRes.hero.verified);
      d.imgProxy = Boolean(mediaRes.hero && mediaRes.hero.proxy);
      d.imgStatus = (mediaRes.hero && mediaRes.hero.status) || 'no_candidates';
      d.canonicalUrl = mediaRes.canonicalUrl || resolvedCanon;
      d.media = {
        schemaVersion: mediaRes.schemaVersion,
        canonicalUrl: mediaRes.canonicalUrl,
        hero: mediaRes.hero,
        bodyImages: mediaRes.bodyImages,
        diagnostics: mediaRes.diagnostics,
      };
      if (!reuseFullMedia) mediaCacheSet([url, canonUrl, d.url, d.final].filter(Boolean), mediaRes);
    } else {
      d.img = '';
      d.imgVerified = false;
      d.imgStatus = 'none';
      d.canonicalUrl = canonUrl || url;
      d.media = null;
    }

    try { d = await rdVideoGate(d); } catch (e) {}
    d = rdAssembleBlocks(d, mediaRes);
    const playVids = (d.videos || []).filter(v => v && (v.kind === 'iframe' || v.kind === 'video'));
    if (mediaRes && playVids.length && (!Array.isArray(mediaRes.videos) || !mediaRes.videos.length)) {
      mediaRes.videos = playVids;
    }
    for (const v of (d.videos || [])) { if (v && v.url) registerVhsUrl(v.url); }
    for (const b of (d.blocks || [])) { if (b && b.k === 'v' && b.v && b.v.url) registerVhsUrl(b.v.url); }
    return d;
  }

  const ytIdOf = raw => { try { const u = new URL(raw); const h = u.hostname.replace(/^(www|m|music)\./, '');
    if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0].match(/^[\w-]{6,15}$/) ? u.pathname.slice(1).split('/')[0] : '';
    if (h === 'youtube.com') { if (u.pathname === '/watch') return (u.searchParams.get('v') || '').match(/^[\w-]{6,15}$/) ? u.searchParams.get('v') : ''; const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,15})/); return m ? m[1] : ''; }
  } catch (e) {} return ''; };

  async function rdReadYouTube(id, raw) {
    const watch = 'https://www.youtube.com/watch?v=' + id;
    let title = '', author = '', desc = '', time = '';
    try { const r = await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(watch), {}, 8000); if (r.ok) { const j = await r.json(); title = j.title || ''; author = j.author_name || ''; } } catch (e) {}
    try { const { r } = await rdSafeGet(watch, 9000); if (r.ok) { const meta = rdMeta(await r.text()); desc = rdInline(meta['og:description'] || meta.description || ''); time = meta['datepublished'] || meta['uploaddate'] || ''; if (!title) title = rdClean(meta['og:title'] || ''); } } catch (e) {}
    const paras = desc && desc.length >= 30 ? [desc] : [];
    const playable = await rdYtPlayable(id);
    const v = playable === false ? null : { url: 'https://www.youtube.com/embed/' + id, kind: 'iframe', poster: '' };
    const vblocks = v ? [{ k: 'v', v }] : [];
    return { ok: true, url: raw, final: watch, title: title || 'Video YouTube', site: 'YouTube', byline: author, time: time ? String(time) : '',
      img: '', desc, paras, thin: false, videos: v ? [v] : [], blocks: [...vblocks, ...paras.map(t => ({ k: 'p', t }))], via: 'youtube', t: { via: 'youtube' } };
  }

  const readFail = new Map();
  const READ_FAIL_TTL = 15000;
  const readBusy = new Map();

  const rdAmpVariants = u => {
    try {
      const x = new URL(u), p = x.pathname.replace(/\/+$/, '');
      if (!p || /\/(amp|amphtml)$/i.test(p)) return [];
      const ampQ = x.search ? (/[?&]amp=/i.test(x.search) ? x.search : x.search + '&amp=1') : '?amp=1';
      return [...new Set([
        x.origin + p + '/amp' + (x.search || ''),
        x.origin + p + '.amp' + (x.search || ''),
        x.origin + p + ampQ,
      ])];
    } catch (e) { return []; }
  };

  async function rdWaybackRaw(u) {
    try {
      const a = await get('https://archive.org/wayback/available?url=' + encodeURIComponent(u), {}, 8000);
      if (!a.ok) return null;
      const j = await a.json();
      const s = j && j.archived_snapshots && j.archived_snapshots.closest;
      return s && s.url ? String(s.url).replace(/\/web\/(\d+)/, '/web/$1id_') : null;
    } catch (e) { return null; }
  }

  const rdReadSem = makeSem(12, 80);
  const outboundScrapeRl = SEC.createRateLimiter({ outbound: { limit: 180, windowMs: 60000 } });

  async function rdRead(raw, bg, forceFresh = false) {
    const x = publicURL(raw);
    if (!x) throw new Error('URL tidak valid');
    if (isBannedHostUrl(raw)) {
      const eb = new Error('Sumber berbayar atau dikecualikan (' + (rdHost(raw) || 'diblokir') + ')');
      eb.transient = false;
      throw eb;
    }
    const yid = ytIdOf(raw);
    if (yid) return memo('yt:' + yid, 600000, () => rdReadYouTube(yid, raw));

    const fastHit = getReadCache(MEDIA.canonicalArticleUrl(raw), raw);
    if (fastHit && !(forceFresh && (fastHit.wireFallback || fastHit.upstreamBlocked || fastHit.isFallback))) return fastHit;

    let target = raw;
    if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) target = await decodeGNews(raw);
    if (isBannedHostUrl(target)) {
      const eb = new Error('Sumber berbayar atau dikecualikan (' + (rdHost(target) || 'diblokir') + ')');
      eb.transient = false;
      throw eb;
    }
    await rdAssertPublic(target);

    const canon = MEDIA.canonicalArticleUrl(target) || target;
    if (thumbBusy.has(canon)) {
      try { await Promise.race([thumbBusy.get(canon), sleep(8000)]); } catch (e) {}
    }
    const cacheHit = getReadCache(canon, raw);
    if (cacheHit && !(forceFresh && (cacheHit.wireFallback || cacheHit.upstreamBlocked || cacheHit.isFallback))) return cacheHit;

    if (readBusy.has(canon)) return readBusy.get(canon);

    const p = rdReadSem(async () => {
      const t0 = Date.now();
      const left = () => Math.max(5000, 40000 - (Date.now() - t0));
      const wireIt = rdWireFind(target) || rdWireFind(raw);
      const wireTitles = rdWireTitles();
      const expectedTitle = (wireIt && wireIt.title) || '';
      const extractOpts = { expectedTitle, wireTitles };

      let lastErr = null, metaD = null, metaHtml = null;
      let sawTransientUpstream = false;
      const attempts = [];
      const metaScore = d => ((d.videos || []).length * 2) + (d.desc ? 1 : 0) + ((d.paras || []).length * 0.5);

      const evaluateHtml = (html, url) => {
        if (isBannedHostUrl(url)) {
          const eb = new Error('Sumber berbayar atau dikecualikan (' + (rdHost(url) || 'diblokir') + ')');
          eb.transient = false;
          throw eb;
        }
        const d = rdExtract(html, url, extractOpts);
        const q = d.extraction && d.extraction.quality;
        if (q && q.isChallengeOrError) {
          sawTransientUpstream = true;
          throw new Error('halaman challenge/CAPTCHA');
        }
        if (d.offTopic || (q && !q.isOnTopic)) {
          throw new Error('isi tidak nyambung dengan judul');
        }
        if (metaScore(d) > (metaD ? metaScore(metaD) : -1)) {
          metaD = d;
          metaHtml = html;
        }
        const isMediaBrief = /\/(?:infografik|foto|galeri)\//i.test(url) &&
          d.textSource && d.textSource !== 'meta_description' && d.textSource !== 'none' &&
          (d.paras || []).length >= 1 && (d.paras || []).join(' ').length >= 90;
        const hasPlayableVideo = (d.videos || []).some(v => v && (v.kind === 'iframe' || v.kind === 'video')) ||
          (d.blocks || []).some(b => b.k === 'v' && b.v && (b.v.kind === 'iframe' || b.v.kind === 'video'));
        if ((!q || !q.isFullArticle) && !isMediaBrief && !hasPlayableVideo) {
          throw new Error('teks artikel tipis/JS-rendered');
        }
        return d;
      };

      let fetchMs = 0;
      const fin = async (d, url, html, jinaTxt, via) => {
        const m0 = Date.now();
        const finCanon = MEDIA.canonicalArticleUrl(url) || canon;
        if (html || jinaTxt) docCacheSet([raw, target, finCanon, url].filter(Boolean), { html, jinaTxt, finalUrl: url, via });
        const r = await rdFinish(d, url, finCanon, html, jinaTxt, via, wireIt);
        const playable = (r.videos || []).some(v => v.kind !== 'probe') || (r.blocks || []).some(b => b.k === 'v' && b.v && b.v.kind !== 'probe');
        if (r.thin && playable) r.videoPage = true;
        r.via = via;
        r.schemaVersion = PIPELINE_VERSION;
        r.canonicalUrl = r.canonicalUrl || finCanon;
        r.t = { ms: Date.now() - t0, fetch: fetchMs, media: Date.now() - m0, via };
        console.log('[read]', via, r.t.ms + 'ms', 'fetch:' + fetchMs, 'media:' + r.t.media);

        if (r && !r.wireFallback && (r.desc || (r.paras && r.paras[0]))) {
          const ds = r.desc || r.paras[0];
          if (ds && ds.length >= 26 && !BOT_CHALLENGE_RE.test(ds)) {
            descRemember([raw, target, finCanon, url, r.url, r.final].filter(Boolean), ds);
          }
        }

        const cacheTtl = (!r.thin && !r.isFallback && !r.wireFallback)
          ? 1800000
          : (r.wireFallback ? (sawTransientUpstream ? 15000 : 30000) : (sawTransientUpstream ? 30000 : 120000));
        setReadCache([raw, target, finCanon, url, r.url, r.final].filter(Boolean), r, cacheTtl);
        return r;
      };

      let targetHost = '';
      try { targetHost = new URL(target).hostname; } catch (e) {}
      const isWafHost = CF_WAF_HOST_RE.test(targetHost);

      if (!forceFresh) {
        const docHit = docCacheGet(canon) || docCacheGet(target) || docCacheGet(raw);
        if (docHit) {
          try {
            if (docHit.html) {
              const dCached = evaluateHtml(docHit.html, docHit.finalUrl || target);
              fetchMs = Date.now() - t0;
              return await fin(dCached, docHit.finalUrl || target, docHit.html, docHit.jinaTxt || null, docHit.via || 'doc-cache');
            }
            if (docHit.jinaTxt) {
              const dJ = rdJinaMd(docHit.jinaTxt, docHit.finalUrl || target, extractOpts);
              const qJ = dJ.extraction && dJ.extraction.quality;
              if (dJ.ok && qJ && !qJ.isChallengeOrError && qJ.isOnTopic && qJ.isFullArticle) {
                fetchMs = Date.now() - t0;
                return await fin(dJ, docHit.finalUrl || target, null, docHit.jinaTxt, 'jina-cache');
              }
            }
          } catch (_) {}
        }
      }

      const jobs = [];
      const raceAc = new AbortController();
      jobs.push({ via: 'direct', p: (async () => {
        if (isWafHost) {
          await sleep(2000);
          if (raceAc.signal.aborted) throw new Error('aborted');
        }
        const { r, url } = await rdSafeGet(target, Math.min(10000, left()), {}, raceAc.signal);
        if (!r.ok) {
          if (r.status === 403 || r.status === 429 || r.status >= 500) sawTransientUpstream = true;
          throw new Error('HTTP ' + r.status);
        }
        const ct = r.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan halaman HTML');
        const len = Number(r.headers.get('content-length') || 0);
        if (len > 3e6) throw new Error('halaman terlalu besar');
        let html = await mediaText(r, 5 << 20);
        if (html.length > 3e6) html = html.slice(0, 3e6);
        const d = evaluateHtml(html, url);
        return { d, html, jinaTxt: null, url };
      })() });

      jobs.push({ via: 'bot', p: (async () => {
        let lastBotErr = null;
        for (const bua of RD_BOT_UAS) {
          if (raceAc.signal.aborted || left() < 4000) break;
          try {
            const { r, url } = await rdSafeGet(target, Math.min(5500, left()), { 'user-agent': bua }, raceAc.signal);
            if (!r.ok) {
              if (r.status === 403 || r.status === 429 || r.status >= 500) sawTransientUpstream = true;
              lastBotErr = new Error('HTTP ' + r.status);
              continue;
            }
            const ct = r.headers.get('content-type') || '';
            if (!/text\/html|application\/xhtml/i.test(ct)) continue;
            let html = await mediaText(r, 5 << 20);
            if (html.length > 3e6) html = html.slice(0, 3e6);
            const d = evaluateHtml(html, url);
            return { d, html, jinaTxt: null, url };
          } catch (e) { lastBotErr = e; }
        }
        throw lastBotErr || new Error('bot challenge/block');
      })() });

      let raceSettled = false;
      jobs.push({ via: 'jina', p: (async () => {
        const { r } = await jinaGet('https://r.jina.ai/' + target, Math.min(9000, left()), { accept: 'text/plain' }, () => !raceSettled, !bg, raceAc.signal);
        if (!r.ok) {
          if (r.status === 402 || r.status === 429 || r.status >= 500) sawTransientUpstream = true;
          throw new Error('HTTP ' + r.status);
        }
        const txt = await mediaText(r, 5 << 20);
        if (!txt || txt.length <= 200) throw new Error('jina kosong');
        const d = rdJinaMd(txt, target, extractOpts);
        const q = d.extraction && d.extraction.quality;
        if (!d.ok || !q || q.isChallengeOrError) { sawTransientUpstream = true; throw new Error('jina challenge/error'); }
        if (!q.isOnTopic) throw new Error('jina tidak sesuai topik');
        if (!q.isFullArticle) throw new Error('jina artikel tipis');
        if (metaD) {
          if (!d.desc && metaD.desc) d.desc = metaD.desc;
          if ((!d.videos || !d.videos.length) && metaD.videos && metaD.videos.length) d.videos = metaD.videos;
          if (!d.time && metaD.time) d.time = metaD.time;
          if (!d.byline && metaD.byline) d.byline = metaD.byline;
        }
        return { d, html: metaHtml, jinaTxt: txt, url: target };
      })() });

      for (let pi = 0; pi < RD_PROXIES.length; pi++) {
        const px = RD_PROXIES[pi];
        const isCustom = Boolean(CUSTOM_PROXY && pi === 0);
        jobs.push({ via: 'proxy', p: (async () => {
          const { r } = await mediaGet(px(target), Math.min(isCustom ? 10000 : 5500, left()), {}, null, !bg, raceAc.signal);
          if (!r.ok) {
            if (r.status === 429 || r.status >= 500) sawTransientUpstream = true;
            throw new Error('HTTP ' + r.status);
          }
          const ct = r.headers.get('content-type') || '';
          if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan html');
          let html = await mediaText(r, 5 << 20);
          if (html.length > 3e6) html = html.slice(0, 3e6);
          const d = evaluateHtml(html, target);
          return { d, html, jinaTxt: null, url: target };
        })() });
      }

      const win = await new Promise(res => {
        let n = jobs.length, settled = false;
        const done = v => { if (!settled) { settled = true; raceSettled = true; try { raceAc.abort(); } catch {} res(v); } };
        for (const j of jobs) j.p.then(v => done({ ...v, via: j.via }), e => {
          lastErr = e;
          attempts.push({ via: j.via, err: String(e && e.message || e).slice(0, 90) });
        }).finally(() => { if (--n === 0) done(null); });
      });
      if (win) { fetchMs = Date.now() - t0; return await fin(win.d, win.url, win.html, win.jinaTxt, win.via || 'race'); }

      const FC_KEY = process.env.FIRECRAWL_API_KEY || '';
      if (FC_KEY && left() > 16000 && !fcBlocked(target)) {
        let fcOk = false;
        try {
          const r = await get('https://api.firecrawl.dev/v1/scrape', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
            body: JSON.stringify({ url: target, formats: ['html'], onlyMainContent: false, timeout: 15000 })
          }, Math.min(15000, left() - 5000));
          if (r.ok) {
            const j = await r.json();
            let html = j && j.data && j.data.html;
            const md = (j && j.data && j.data.metadata) || {};
            if (html && String(html).length > 500) {
              html = injectSyntheticHead(String(html), md);
              const d = evaluateHtml(html.slice(0, 3e6), target);
              if (!d.title || /^(undefined|null)$/i.test(d.title) || d.title === rdHost(target)) d.title = md.title || md.ogTitle || d.title;
              if (!d.desc && (md.ogDescription || md['og:description'])) d.desc = md.ogDescription || md['og:description'];
              if (!d.byline && md.author) d.byline = md.author;
              if (!d.time && md['article:published_time']) d.time = md['article:published_time'];
              fetchMs = Date.now() - t0;
              fcOk = true;
              return await fin(d, target, html, null, 'firecrawl');
            }
          }
        } catch (e) { lastErr = e; attempts.push({ via: 'firecrawl', err: String(e && e.message || e).slice(0, 90) }); }
        if (!fcOk) fcFailMark(target);
      }

      const tryDoc = async (u, ms, via) => {
        let r, url;
        try { ({ r, url } = await rdSafeGet(u, Math.min(ms, left()), { 'user-agent': RD_BOT_UAS[0] })); }
        catch (e) { ({ r, url } = await rdSafeGet(u, Math.min(ms, left()))); }
        if (!r.ok) {
          if (r.status === 403 || r.status === 429 || r.status >= 500) sawTransientUpstream = true;
          throw new Error('HTTP ' + r.status);
        }
        const ct = r.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan html');
        let html = await mediaText(r, 5 << 20);
        if (html.length > 3e6) html = html.slice(0, 3e6);
        const d = evaluateHtml(html, url);
        fetchMs = Date.now() - t0;
        return await fin(d, url, html, null, via);
      };
      if (!metaD) {
        for (const av of rdAmpVariants(target).slice(0, 2)) {
          if (left() < 7000) break;
          try { return await tryDoc(av, 4500, 'amp'); }
          catch (e) { attempts.push({ via: 'amp', err: String(e && e.message || e).slice(0, 90) }); }
        }
        if (left() > 8000) {
          const wu = await rdWaybackRaw(target);
          if (wu) {
            try { return await tryDoc(wu, 6500, 'wayback'); }
            catch (e) { attempts.push({ via: 'wayback', err: String(e && e.message || e).slice(0, 90) }); }
          } else attempts.push({ via: 'wayback', err: 'no snapshot' });
        }
      }

      if (metaD) {
        const paras = metaD.paras.length ? metaD.paras : (metaD.desc ? [metaD.desc] : []);
        const isRichDom = metaD.textSource && metaD.textSource !== 'meta_description' && metaD.textSource !== 'none' && paras.join(' ').length >= 120;
        const d = {
          ...metaD,
          paras,
          thin: !isRichDom,
          isFallback: !isRichDom,
          textSource: metaD.textSource || (paras.length ? 'meta_description' : 'none'),
          via: 'meta',
          upstreamBlocked: sawTransientUpstream,
          fallbackReason: attempts.slice(0, 5).map(a => a.via + ':' + a.err).join('; '),
        };
        d.blocks = (metaD.blocks && metaD.blocks.length ? metaD.blocks : paras.map(t => ({ k: 'p', t })))
          .filter(b => (b.k !== 'p' && b.k !== 'q' && b.k !== 'li') || paras.includes(b.t));
        fetchMs = Date.now() - t0;
        return await fin(d, target, metaHtml, null, 'meta');
      }

      if (wireIt && wireIt.title) {
        const cleanedRss = wireIt.desc ? (FEEDTEXT.descFrom({ description: wireIt.desc }, wireIt.title) || String(wireIt.desc).trim()) : '';
        const paras = cleanedRss
          ? cleanedRss.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 20 && !BOT_CHALLENGE_RE.test(p))
          : [];
        const why = attempts.slice(0, 5).map(a => a.via + ':' + a.err).join('; ');
        const d = {
          ok: true,
          url: target,
          final: target,
          title: wireIt.title,
          site: EXTRACT.cleanSiteName(wireIt.pub || wireIt.src || '', target),
          byline: wireIt.pub || wireIt.src || '',
          time: wireIt.ts ? new Date(wireIt.ts).toISOString() : '',
          img: '',
          desc: cleanedRss,
          paras,
          thin: true,
          isFallback: true,
          wireFallback: true,
          upstreamBlocked: sawTransientUpstream,
          textSource: paras.length ? 'rss_description' : 'none',
          fallbackReason: why || 'upstream_blocked',
          via: 'wire-fallback',
          videos: [],
          blocks: paras.map(t => ({ k: 'p', t })),
          extraction: {
            method: paras.length ? 'rss_description' : 'none',
            isFallback: true,
            quality: EXTRACT.computeTextQuality({ title: wireIt.title, url: target, desc: cleanedRss, blocks: paras.map(t => ({ k: 'p', t })) }),
          },
        };
        fetchMs = Date.now() - t0;
        return await fin(d, target, null, null, 'wire-fallback');
      }

      const why = attempts.slice(0, 8).map(a => a.via + ':' + a.err).join('; ');
      const e2 = new Error((lastErr ? String(lastErr.message || lastErr) : 'fetch failed') + (why ? ' [' + why + ']' : ''));
      e2.attempts = attempts.slice(0, 10);
      e2.transient = sawTransientUpstream || !attempts.some(a => /HTTP (404|410)|tidak sesuai topik/i.test(a.err));
      throw e2;
    }, !bg);

    readBusy.set(canon, p);
    p.then(() => readBusy.delete(canon), () => readBusy.delete(canon));
    return p;
  }

  const DESC_TTL = 6 * 3600e3;
  const DESC_NEG_TTL = 10 * 60000;
  const DESC_TRANSIENT_NEG_TTL = 45000;
  const DESC_CAP = 800;
  const DESC_MAX_PER_CALL = 8;
  const DESC_HOST_GAP = 400;
  const descCache = new Map();

  const descNetSem = makeSem(12, 120);
  const descHostAt = new Map();
  const descHostChain = new Map();
  const descNormKey = u => 'v' + PIPELINE_VERSION + ':' + (urlToCanon.get(u) || MEDIA.canonicalArticleUrl(u) || u);
  const descGetEntry = u => {
    const k = descNormKey(u);
    const hit = descCache.get(k);
    if (!hit) return undefined;
    descCache.delete(k); descCache.set(k, hit);
    const ttl = hit.ttl || (hit.desc ? DESC_TTL : DESC_NEG_TTL);
    return Date.now() - hit.at < ttl ? { desc: hit.desc, transient: Boolean(hit.transient), pub: hit.pub !== false } : undefined;
  };
  const descGet = u => {
    const e = descGetEntry(u);
    return e !== undefined ? e.desc : undefined;
  };
  const descRemember = (keys, desc, transient = false, opts = {}) => {
    const now = Date.now();
    const ttl = desc ? DESC_TTL : (transient ? DESC_TRANSIENT_NEG_TTL : DESC_NEG_TTL);
    const pub = opts.pub !== false;
    const normKeys = new Set();
    for (const k of keys) {
      if (!k) continue;
      normKeys.add(descNormKey(k));
      normKeys.add('v' + PIPELINE_VERSION + ':' + k);
    }
    for (const k of normKeys) { descCache.delete(k); descCache.set(k, { desc, transient: !desc && transient, pub, at: now, ttl }); }
    while (descCache.size > DESC_CAP) descCache.delete(descCache.keys().next().value);
  };
  const descRememberPriv = (keys, desc, transient = false) => descRemember(keys, desc, transient, { pub: false });
  const descDemote = keys => {
    for (const k of keys) {
      if (!k) continue;
      for (const kk of [descNormKey(k), 'v' + PIPELINE_VERSION + ':' + k]) {
        const e = descCache.get(kk);
        if (e) e.pub = false;
      }
    }
  };

  async function mediaDesc(r) {
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!reader) {
      const b = Buffer.from(await r.arrayBuffer());
      return b.toString('utf8').slice(0, 512 << 10);
    }
    const chunks = []; let total = 0, scan = '';
    const HAS_META_VAL_RE = /<meta[^>]+(?:og:description|twitter:description|name\s*=\s*["']description["'])[^>]*content\s*=\s*["'][^"']{40,}["']/i;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value)); total += value.length;
      if (total > (512 << 10)) break;
      scan += value.toString('utf8');
      if (/<\/html>/i.test(scan)) break;
      if (/<\/head>/i.test(scan)) {
        if (HAS_META_VAL_RE.test(scan) && total >= 4096) break;
        const bodyPart = scan.slice(scan.search(/<\/head>/i));
        if (/<\/article>/i.test(bodyPart)) break;
        const pCount = (bodyPart.match(/<\/p>/gi) || []).length;
        if (pCount >= 4 && total > 32768) break;
      }
    }
    try { await reader.cancel(); } catch (e) {}
    return Buffer.concat(chunks).toString('utf8');
  }

  async function descForUrl(reqUrl) {
    const cached = descGet(reqUrl);
    if (cached !== undefined) return cached;
    const x = publicURL(reqUrl);
    if (!x) return '';
    if (isBannedHostUrl(reqUrl)) { descRememberPriv([reqUrl], '', false); return ''; }
    let target = reqUrl;
    if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) {
      try { target = await decodeGNews(reqUrl); } catch (e) { descRememberPriv([reqUrl], '', true); return ''; }
      if (/(^|\.)news\.google\.com$/i.test(new URL(target).hostname)) { descRememberPriv([reqUrl], '', true); return ''; }
      if (isBannedHostUrl(target)) { descRememberPriv([reqUrl, target], '', false); return ''; }
      const viaTarget = descGet(target);
      if (viaTarget !== undefined) { descRememberPriv([reqUrl], viaTarget); return viaTarget; }
    }
    if (isBannedHostUrl(target)) { descRememberPriv([reqUrl, target], '', false); return ''; }
    const canon = MEDIA.canonicalArticleUrl(target) || target;

    const rHit = getReadCache(canon, reqUrl);
    if (rHit && !rHit.wireFallback && (rHit.desc || (rHit.paras && rHit.paras[0]))) {
      const ds = rHit.desc || rHit.paras[0];
      if (ds && ds.length >= 26 && !BOT_CHALLENGE_RE.test(ds)) {
        descRememberPriv([reqUrl, target, canon], ds);
        return ds;
      }
    }

    for (const testU of [target, canon, reqUrl]) {
      const wireIt = rdWireFind(testU);
      if (wireIt && wireIt.desc && wireIt.desc.length >= 26 && !BOT_CHALLENGE_RE.test(wireIt.desc)) {
        descRememberPriv([reqUrl, target, canon], wireIt.desc);
        return wireIt.desc;
      }
    }
    const docHit = docCacheGet(canon) || docCacheGet(target) || docCacheGet(reqUrl);
    if (docHit && docHit.html) {
      try {
        const extDoc = rdExtract(docHit.html, docHit.finalUrl || target);
        const dsDoc = extDoc && (extDoc.desc || (extDoc.paras && extDoc.paras[0])) || '';
        if (dsDoc && dsDoc.length >= 26 && !BOT_CHALLENGE_RE.test(dsDoc)) {
          descRememberPriv([reqUrl, target, canon], dsDoc);
          return dsDoc;
        }
      } catch (_) {}
    }
    const host = new URL(target).hostname;
    return descNetSem(() => descFetchNet(reqUrl, target, canon, x, host));
  }

  async function descFetchNet(reqUrl, target, canon, x, host) {
    const prev = descHostChain.get(host) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    descHostChain.set(host, Promise.race([prev, sleep(1200)]).then(() => mine));
    if (descHostChain.size > 500) descHostChain.delete(descHostChain.keys().next().value);
    await Promise.race([prev, sleep(1200)]);
    const deadline = Date.now() + 8500;
    const leftMs = () => Math.max(1200, deadline - Date.now());
    let html = '';
    let sawTransient = false;
    try {
      const waitHost = Math.max(0, (descHostAt.get(host) || 0) + DESC_HOST_GAP - Date.now());
      if (waitHost) await sleep(waitHost);
      const isGN = /(^|\.)news\.google\.com$/i.test(x.hostname);
      const baseHdrs = isGN
        ? { referer: 'https://news.google.com/', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
        : { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
      const fetchHead = async (u, extraHdrs = {}, timeoutMs = 3500) => {
        const langHdr = (extraHdrs && extraHdrs['user-agent'])
          ? {}
          : { 'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' };
        const { r } = await mediaGet(u, Math.min(timeoutMs, leftMs()), { ...baseHdrs, ...langHdr, ...extraHdrs });
        if (!r.ok) {
          if (r.status === 403 || r.status === 429 || r.status >= 500) sawTransient = true;
          throw new Error('HTTP ' + r.status);
        }
        const ct = r.headers.get('content-type') || '';
        if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) throw new Error('bukan halaman HTML');
        const h = await mediaDesc(r);
        if (h.length < 45000 && BOT_CHALLENGE_RE.test(h)) {
          sawTransient = true;
          throw new Error('halaman challenge/captcha');
        }
        return h;
      };
      const isWaf = CF_WAF_HOST_RE.test(host);
      const hdrSequence = isWaf
        ? [{ 'user-agent': RD_BOT_UAS[0] }, { 'user-agent': RD_BOT_UAS[2] }, { 'user-agent': RD_BOT_UAS[1] }, {}]
        : [{}, { 'user-agent': RD_BOT_UAS[0] }, { 'user-agent': RD_BOT_UAS[2] }];

      for (const hTry of hdrSequence) {
        if (Date.now() >= deadline - 800) break;
        try {
          html = await fetchHead(target, hTry, 3500);
          if (html) break;
        } catch (e) {
          if (!/HTTP 404/i.test(String(e && e.message || e))) sawTransient = true;
          if (hTry === hdrSequence[0]) console.log('[desc] direct gagal', host, String(e && e.message || e).slice(0, 80));
        }
      }
      if (!html && Date.now() < deadline - 1500) {
        for (const px of RD_PROXIES.slice(0, 1)) {
          try { html = await fetchHead(px(target), {}, 3200); console.log('[desc] proxy OK', host); break; }
          catch (e2) { console.log('[desc] proxy gagal', host, String(e2 && e2.message || e2).slice(0, 60)); }
        }
      }
      if (!html && Date.now() < deadline - 1500) {
        try {
          const { r } = await jinaGet('https://r.jina.ai/' + target, Math.min(5000, leftMs()), { accept: 'text/plain' });
          if (r.ok) {
            const txt = await mediaText(r, 512 << 10);
            if (!BOT_CHALLENGE_RE.test(txt.slice(0, 5000))) {
              const jDoc = rdJinaMd(txt, target);
              if (jDoc && jDoc.ok && !(jDoc.extraction && jDoc.extraction.quality && jDoc.extraction.quality.isChallengeOrError) && jDoc.paras && jDoc.paras.length) {
                const d = FEEDTEXT.descFrom({ description: jDoc.paras[0] }, jDoc.title || '');
                if (d && !BOT_CHALLENGE_RE.test(d)) {
                  descRememberPriv([reqUrl, target, canon], d);
                  return d;
                }
              }
            }
          }
        } catch (e) { sawTransient = true; }
        descRememberPriv([reqUrl, target, canon], '', sawTransient);
        return '';
      }
      if (!html) {
        descRememberPriv([reqUrl, target, canon], '', sawTransient);
        return '';
      }
    } finally {
      descHostAt.set(host, Date.now());
      if (descHostAt.size > 500) descHostAt.delete(descHostAt.keys().next().value);
      release();
    }
    const meta = rdMeta(html);
    const title = rdClean(meta['og:title'] || meta['twitter:title'] ||
      (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const ldArt = rdLd(html).find(n => /article|posting|news/i.test(String(n['@type'] || ''))) || {};
    const ldDesc = typeof ldArt.description === 'string' ? ldArt.description : '';
    const raw = meta['og:description'] || meta['twitter:description'] || meta.description || ldDesc;
    let desc = raw ? FEEDTEXT.descFrom({ description: rdInline(raw) }, title || '') : '';
    if (!desc) {
      const ex = rdExtract(html, target);
      const exQ = ex && ex.extraction && ex.extraction.quality;
      if (ex && !ex.offTopic && !(exQ && exQ.isChallengeOrError) && ex.paras && ex.paras.length) {
        desc = FEEDTEXT.descFrom({ description: ex.paras[0] }, title || ex.title || '');
      }
    }
    const out = desc && Array.from(desc).length >= 26 && !BOT_CHALLENGE_RE.test(desc) ? desc : '';
    descRememberPriv([reqUrl, target, canon], out, !out && sawTransient);
    return out;
  }

  return {
    thumbCache,
    urlToCanon,
    gnCache,
    probeCache,
    verifiedProxyImgs,
    knownNewsUrls,
    knownVhsUrls,
    registerNewsUrl,
    registerVhsUrl,
    isKnownNewsUrl,
    isKnownVhsUrl,
    probeImage,
    decodeGNews,
    docCache,
    DOC_CACHE_MAX_BYTES,
    docCacheGet,
    docCacheSet,
    getDocCacheBytes: () => docCacheBytes,
    fcBlocked,
    fcFailMark,
    mediaCacheGet,
    mediaCacheSet,
    thumb,
    img,
    vhs,
    cctvFirecrawl,
    sanitizeHopHeaders,
    rdSafeGet,
    mediaGetRaw,
    mediaGet,
    mediaBody,
    mediaText,
    rdWireFind,
    rdWireRssImgs,
    rdWireImg,
    readCache,
    READ_FAIL_TRANSIENT_TTL,
    READ_FAIL_PERM_TTL,
    getReadCache,
    setReadCache,
    rdAssembleBlocks,
    rdFinish,
    readFail,
    READ_FAIL_TTL,
    outboundScrapeRl,
    rdRead,
    DESC_MAX_PER_CALL,
    descCache,
    descGetEntry,
    descGet,
    descDemote,
    descForUrl,
  };
}

module.exports = { createReaderService };
