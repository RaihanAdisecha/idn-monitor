/* Logika murni newswire: urutan, dedup judul, dan pemilihan lead.
   Dipakai browser (window.WireCore) dan Node test (module.exports).
   Kontrak: list selalu terbaru dulu; lead tidak boleh lebih tua dari satu siklus refresh. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WireCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const H24 = 24 * 3600e3;
  const LEAD_HOLD_MS = 120e3;        // 1 siklus refresh UI
  const FUTURE_SKEW_MS = 5 * 60e3;   // toleransi clock skew publisher

  const nkey = t => String(t || '').toLowerCase().replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  /* filter umur + buang tanggal tidak valid/masa depan + urutkan terbaru dulu,
     BARU dedup judul. Urutan ini penting: dedup setelah sort membuat copy
     terbaru yang menang posisinya, bukan copy dari sumber yang kebetulan
     diproses duluan. Kalau judul kembar, record yang SURVIVES tetap yang
     terbaru, tapi field desc+pub+src+img diadopsi dari copy dengan desc
     terpanjang — deskripsi longgar menang, badge tetap konsisten dengan
     record sumbernya. */
  function prepare(all, now) {
    const out = [];
    const idx = new Map();   // nkey -> posisi di out
    (all || [])
      .filter(h => h && typeof h.ts === 'number' && h.ts > 0)
      .filter(h => now - h.ts <= H24 && h.ts <= now + FUTURE_SKEW_MS)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .forEach(h => {
        const k = nkey(h.title);
        const i = idx.get(k);
        if (i === undefined) { idx.set(k, out.length); out.push(h); return; }
        if ((h.desc || '').length > (out[i].desc || '').length) {
          out[i] = { ...out[i], desc: h.desc, img: out[i].img || h.img };
        } else if (!out[i].img && h.img) {
          out[i] = { ...out[i], img: h.img };
        }
      });
    return out;
  }

  /* Lead sticky hanya selama masih ada di list DAN belum tertinggal lebih dari
     satu siklus. Kalau ada item yang lebih baru, hero ikut pindah. */
  function chooseLead(list, prev, prevScope, scope) {
    if (!list || !list.length) return null;
    if (prev && prevScope === scope && list.some(x => x.url === prev.url) &&
        (list[0].ts - (prev.ts || 0)) <= LEAD_HOLD_MS) return prev;
    return list[0];
  }

  const SITE_BRANDS = {
    'metrotvnews.com': 'MetroTV',
    'detik.com': 'Detik',
    'kompas.com': 'Kompas',
    'kompas.id': 'Kompas',
    'cnnindonesia.com': 'CNN Indonesia',
    'cnbcindonesia.com': 'CNBC Indonesia',
    'antaranews.com': 'Antara',
    'tempo.co': 'Tempo',
    'liputan6.com': 'Liputan6',
    'republika.co.id': 'Republika',
    'tribunnews.com': 'Tribunnews',
    'kumparan.com': 'Kumparan',
    'sindonews.com': 'Sindonews',
    'okezone.com': 'Okezone',
    'jawapos.com': 'Jawa Pos',
    'viva.co.id': 'VIVA',
    'suara.com': 'Suara',
    'jpnn.com': 'JPNN',
    'bbc.com': 'BBC Indonesia',
    'bbci.co.uk': 'BBC Indonesia',
    'dw.com': 'DW Indonesia',
    'cna.id': 'CNA Indonesia',
    'voi.id': 'VOI',
    'tvonenews.com': 'tvOne',
    'inews.id': 'iNews',
    'beritasatu.com': 'BeritaSatu',
    'merdeka.com': 'Merdeka',
    'mediaindonesia.com': 'Media Indonesia',
    'rmol.id': 'RMOL',
    'bisnis.com': 'Bisnis Indonesia',
    'kontan.co.id': 'Kontan',
    'katadata.co.id': 'Katadata',
    'tirto.id': 'Tirto',
    'bsinews.id': 'BSI News',
    'idntimes.com': 'IDN Times',
    'brilio.net': 'Brilio',
    'youtube.com': 'YouTube',
    'youtu.be': 'YouTube',
  };

  function hostOfSite(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const looksUrl = /^(?:https?:)?\/\//i.test(s) || /^www\./i.test(s);
    const looksDom = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|$)/i.test(s);
    if (!looksUrl && !looksDom) return '';
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : (/^\/\//.test(s) ? 'https:' + s : 'https://' + s));
      return u.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
    } catch {
      return '';
    }
  }

  function brandOfHost(h) {
    if (!h) return '';
    if (SITE_BRANDS[h]) return SITE_BRANDS[h];
    for (const [dom, brand] of Object.entries(SITE_BRANDS)) {
      if (h.endsWith('.' + dom)) return brand;
    }
    return '';
  }

  function cleanSiteName(rawSite, fallbackUrl) {
    const s = String(rawSite || '').trim();
    if (s) {
      const h = hostOfSite(s);
      if (h) return brandOfHost(h) || h;
      return s;
    }
    const fh = hostOfSite(fallbackUrl);
    return brandOfHost(fh) || fh || '';
  }

  return { prepare, chooseLead, nkey, cleanSiteName, LEAD_HOLD_MS, FUTURE_SKEW_MS };
});
