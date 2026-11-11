/* Logika murni grid CCTV: dedupe stream, sanitasi fallback, urutan langkah
   playback, dan scheduler per-host (round-robin). Dipakai browser
   (window.CctvCore) dan Node test (module.exports). Tanpa DOM, tanpa fetch. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CctvCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const hostOf = u => { try { return new URL(u).host; } catch (e) { return ''; } };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  /* Kunci kanonik satu stream fisik: dua entri dengan kunci sama = kamera sama. */
  function streamKey(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)pantaucctv\.com$/i.test(u.hostname) && /api\/stream/i.test(u.pathname)) {
        const id = u.searchParams.get('id'); if (id) return 'pc:' + id.toLowerCase();
      }
      if (/(^|\.)molecool\.id$/i.test(u.hostname)) return 'mc:' + (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
      const dir = u.pathname.replace(/\/(index|mono|playlist|master)\.m3u8$/i, '').replace(/\/tracks-v\d+\/[^/]*$/i, '');
      return (u.host + dir).toLowerCase();
    } catch (e) { return String(url || ''); }
  }
  /* Buang entri dengan stream yang sama (pertama menang). */
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
  /* Fallback `fb` hanya boleh menunjuk KAMERA YANG SAMA: stream sama-direktori
     atau URL fallback memuat nama kamera. Selain itu label bohong. */
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
  /* Urutan langkah playback. Tiap langkah = {url, via:'direct'|'proxy'}.
     direct dulu (hemat egress server), lalu proxy, lalu fallback, lalu varian
     path hasil tebakan (paling akhir). cam.d === 0 → direct dilewati (host tanpa CORS). */
  function playSteps(cam, proxyFn) {
    const urls = [cam.s].concat(cam.fb ? (Array.isArray(cam.fb) ? cam.fb : [cam.fb]) : []).filter(Boolean);
    const steps = [], seen = new Set();
    const add = (url, via) => { const k = via + '|' + url; if (!seen.has(k)) { seen.add(k); steps.push({ url, via }); } };
    const noDirect = cam.d === 0;
    const variants = [];
    try {
      const u = new URL(cam.s);
      if (!/pantaucctv\.com/i.test(u.hostname) && !/api\/stream/i.test(u.pathname)) {
        const dir = u.pathname.replace(/[^/]+$/, '');
        ['index.m3u8', 'mono.m3u8', 'playlist.m3u8'].forEach(f => { const v = new URL(u.href); v.pathname = dir + f; if (v.href !== cam.s) variants.push(v.href); });
      }
    } catch (e) {}
    urls.forEach((url, i) => {
      if (!noDirect) add(url, 'direct');
      if (proxyFn) add(proxyFn(url), 'proxy');
    });
    variants.forEach(url => { if (!noDirect) add(url, 'direct'); });
    return steps;
  }

  /* Scheduler: pilih sel mana yang boleh mulai load.
     cands = [{key, host}] sudah terurut prioritas. Round-robin antar host supaya satu
     host lambat tidak memonopoli slot; batas perHost (mis. 2) dan maxLoad global. */
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
  /* Sel yang loading terlalu lama dan masih ada antrean host lain → lepas slot. */
  function shouldDemote(p, now, hasWaitingOthers, softMs) {
    return !!(p && p.loading && !p.loaded && hasWaitingOthers && now - p.t0 > softMs && (p.dem || 0) < 3);
  }

  /* Statistik RUM ringkas. */
  function quantile(arr, q) {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  }

  /* Area pandang efektif grid CCTV: pakai bounds `.pb` saat overflow-y:auto/scroll (desktop/tablet),
     atau viewport di bawah header sticky/fixed (mobile) supaya kartu yang ketutupan header
     atau terpotong di atas/bawah tidak dianggap terlihat / mendapat prioritas LIVE. */
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

  /* Ukur keterlihatan satu sel (`.cam`) + frame videonya terhadap bounds `vr`.
     Kartu yang bagian atasnya sudah tertutup scroll area (topClip > 6) atau
     sudah keluar pandangan tidak boleh dianggap inView untuk slot LIVE. */
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

  /* Pilih sel mana yang berhak mendapat slot LIVE (`cap`), memprioritaskan sel yang utuh
     terlihat (`topClip <= 2 && botClip <= 4`) dari atas ke bawah, lalu sel yang masuk dari bawah
     (`topClip <= 4 && visFrac >= 0.55`). Kartu yang sudah ter-scroll ke atas dan bagian atasnya
     sudah tertutup scroll area (`topClip > 4`) DILARANG mencuri slot LIVE dari kartu utuh. */
  function pickLiveKeys(cells, vr, cap) {
    const cands = [], fallback = [];
    for (const item of cells || []) {
      if (!item) continue;
      const m = item.m || measureCell(item.rect, item.frameRect, vr);
      if (!m.inView) continue;
      const clean = m.topClip <= 2 && m.botClip <= 4;
      const topSafe = m.topClip <= 4;
      let tier = 2;
      if (clean) tier = 0;
      else if (topSafe && m.visFrac >= 0.55) tier = 1;
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
      else if (topSafe && m.boxVisH >= 24) fallback.push(entry);
    }
    const cmp = (a, b) =>
      (a.bad - b.bad) ||
      (a.tier - b.tier) ||
      (a.tier === 0
        ? (a.top - b.top) || (a.left - b.left) || (a.idx - b.idx)
        : (b.visFrac - a.visFrac) || (a.topClip - b.topClip) || (a.top - b.top) || (a.left - b.left) || (a.idx - b.idx));
    const list = cands.length ? cands : fallback;
    list.sort(cmp);
    const out = list.map(x => x.key);
    return cap == null ? out : out.slice(0, Math.max(0, cap | 0));
  }
  return { hostOf, norm, streamKey, dedupe, sanitizeFb, playSteps, pickStarts, shouldDemote, quantile, effectiveVisBounds, measureCell, pickLiveKeys };
});
