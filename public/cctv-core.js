

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CctvCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  function streamKey(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)pantaucctv\.com$/i.test(u.hostname) && /api\/stream/i.test(u.pathname)) {
        const id = u.searchParams.get('id'); if (id) return 'pc:' + id.toLowerCase();
      }
      if (/(^|\.)dpuprkotang\.info$/i.test(u.hostname)) {
        const src = u.searchParams.get('src'); if (src) return 'kt:' + src.toLowerCase();
      }
      if (/(^|\.)molecool\.id$/i.test(u.hostname)) return 'mc:' + (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
      const qId = u.searchParams.get('src') || u.searchParams.get('id') || u.searchParams.get('stream');
      const dir = u.pathname.replace(/\/(index|mono|playlist|master)\.m3u8$/i, '').replace(/\/tracks-v\d+\/[^/]*$/i, '');
      return (u.host + dir + (qId ? '?' + qId : '')).toLowerCase();
    } catch (e) { return String(url || ''); }
  }

  function dedupe(list) {
    const seen = new Set(), out = [];
    for (const c of list) {
      if (!c || !c.s) continue;
      const k = streamKey(c.s);
      if (seen.has(k)) continue;
      seen.add(k); out.push(c);
    }
    return out;
  }

  function sanitizeFb(cam) {
    if (!cam || !cam.fb) return cam;
    const arr = Array.isArray(cam.fb) ? cam.fb : [cam.fb];
    const nk = norm(cam.n), own = streamKey(cam.s);
    const keep = arr.filter(f => {
      if (!f) return false;
      if (streamKey(f) === own) return true;
      let path = f; try { path = decodeURIComponent(new URL(f).pathname + new URL(f).search); } catch (e) {}
      return nk.length >= 6 && norm(path).includes(nk);
    });
    const out = { ...cam };
    if (keep.length) out.fb = keep; else delete out.fb;
    return out;
  }

  function playSteps(cam, proxyFn) {
    const urls = [cam.s].concat(cam.fb ? (Array.isArray(cam.fb) ? cam.fb : [cam.fb]) : []).filter(Boolean);
    const steps = [], seen = new Set();
    const add = (url, via) => { const k = via + '|' + url; if (!seen.has(k)) { seen.add(k); steps.push({ url, via }); } };
    const noDirect = cam.d === 0;
    const isProgressiveVid = u => /\.(mp4|webm)(\?|#|$)/i.test(String(u || ''));
    const variants = [];
    try {
      const u = new URL(cam.s);
      if (!/pantaucctv\.com/i.test(u.hostname) && !/api\/stream/i.test(u.pathname) && !isProgressiveVid(u.pathname)) {
        const dir = u.pathname.replace(/[^/]+$/, '');
        ['index.m3u8', 'mono.m3u8', 'playlist.m3u8'].forEach(f => { const v = new URL(u.href); v.pathname = dir + f; if (v.href !== cam.s) variants.push(v.href); });
      }
    } catch (e) {}
    urls.forEach((url, i) => {
      if (!noDirect || isProgressiveVid(url)) add(url, 'direct');
      if (proxyFn && !isProgressiveVid(url)) add(proxyFn(url), 'proxy');
    });
    variants.forEach(url => { if (!noDirect) add(url, 'direct'); });
    return steps;
  }

  function pickStarts(cands, st) {
    const maxLoad = st.maxLoad, perHost = st.perHost;
    let total = st.loadingTotal | 0;
    const byHost = new Map(Object.entries(st.loadingByHost || {}).map(([k, v]) => [k, v | 0]));
    const buckets = new Map();
    for (const c of cands) { if (!buckets.has(c.host)) buckets.set(c.host, []); buckets.get(c.host).push(c); }
    const picked = [];
    let progress = true;
    while (progress && total < maxLoad) {
      progress = false;
      for (const [h, q] of buckets) {
        if (total >= maxLoad) break;
        if (!q.length) continue;
        if ((byHost.get(h) || 0) >= perHost) continue;
        const c = q.shift();
        picked.push(c.key); byHost.set(h, (byHost.get(h) || 0) + 1); total++; progress = true;
      }
    }
    return picked;
  }

  function shouldDemote(p, now, hasWaitingOthers, softMs) {
    return !!(p && p.loading && !p.loaded && hasWaitingOthers && now - p.t0 > softMs && (p.dem || 0) < 3);
  }

  function quantile(arr, q) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  }

  function effectiveVisBounds(opts) {
    const o = opts || {};
    const ih = Number(o.innerHeight) || 0;
    const usePb = !!(o.pbRect && (o.pbOverflowY === 'auto' || o.pbOverflowY === 'scroll'));
    let top = 0, bot = ih;
    if (usePb) {
      top = Math.max(0, o.pbRect.top);
      bot = Math.min(ih, o.pbRect.bottom);
    }
    const stickyTop = Number(o.stickyTop) || 0;
    if (stickyTop > 0 && stickyTop < bot) top = Math.max(top, stickyTop);
    return { top, bot, usePb };
  }

  function measureCell(rect, frameRect, vr) {
    if (!rect || rect.width <= 0 || rect.height <= 0 || !vr || vr.bot <= vr.top) {
      return { inView: false, visH: 0, boxVisH: 0, visFrac: 0, topClip: 0, botClip: 0 };
    }
    const visH = Math.max(0, Math.min(rect.bottom, vr.bot) - Math.max(rect.top, vr.top));
    const box = frameRect && frameRect.height > 0 ? frameRect : rect;
    const boxVisH = Math.max(0, Math.min(box.bottom, vr.bot) - Math.max(box.top, vr.top));
    const visFrac = box.height > 0 ? boxVisH / box.height : 0;
    const topClip = Math.max(0, vr.top - box.top);
    const botClip = Math.max(0, box.bottom - vr.bot);
    const inView = visH > 8 && boxVisH >= 20 && visFrac >= 0.20 &&
      box.bottom > vr.top + 16 && rect.bottom > vr.top + 20 && rect.top < vr.bot - 8;
    return {
      inView,
      visH,
      boxVisH,
      visFrac,
      topClip,
      botClip,
    };
  }

  function pickLiveKeys(cells, vr, cap) {
    const atBottom = !!(vr && vr.atBottom);
    const cands = [], fallback = [];
    for (const item of cells || []) {
      if (!item) continue;
      const m = item.m || measureCell(item.rect, item.frameRect, vr);
      if (!m.inView) continue;
      const clean = atBottom
        ? (m.topClip <= 6 && (m.botClip <= 16 || m.visFrac >= 0.35))
        : (m.topClip <= 2 && m.botClip <= 4);
      const topSafe = m.topClip <= (atBottom ? 6 : 4);
      let tier = 2;
      if (clean) tier = 0;
      else if (topSafe && m.visFrac >= (atBottom ? 0.20 : 0.55)) tier = 1;
      const entry = {
        key: item.key,
        bad: item.bad ? 1 : 0,
        tier,
        idx: item.idx || 0,
        top: (item.rect && item.rect.top) || 0,
        left: (item.rect && item.rect.left) || 0,
        visFrac: m.visFrac,
        boxVisH: m.boxVisH,
        topClip: m.topClip,
      };
      if (entry.tier < 2) cands.push(entry);
      else if (topSafe && m.boxVisH >= (atBottom ? 18 : 24)) fallback.push(entry);
    }
    const cmp = (a, b) =>
      (atBottom ? 0 : (a.bad - b.bad)) ||
      (a.tier - b.tier) ||
      (a.tier === 0
        ? (atBottom ? (b.top - a.top) || (a.left - b.left) || (a.bad - b.bad) || (b.idx - a.idx) : (a.top - b.top) || (a.left - b.left) || (a.idx - b.idx))
        : (atBottom ? (b.top - a.top) || (b.visFrac - a.visFrac) || (a.left - b.left) || (a.bad - b.bad) || (b.idx - a.idx) : (b.visFrac - a.visFrac) || (a.topClip - b.topClip) || (a.top - b.top) || (a.left - b.left) || (a.idx - b.idx)));
    const list = cands.length ? cands : fallback;
    list.sort(cmp);
    const out = list.map(x => x.key);
    return cap == null ? out : out.slice(0, Math.max(0, cap | 0));
  }
  return { hostOf, norm, streamKey, dedupe, sanitizeFb, playSteps, pickStarts, shouldDemote, quantile, effectiveVisBounds, measureCell, pickLiveKeys };
});
