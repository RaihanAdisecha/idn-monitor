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
          out[i] = { ...out[i], desc: h.desc, pub: h.pub, src: h.src, img: h.img };
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

  return { prepare, chooseLead, nkey, LEAD_HOLD_MS, FUTURE_SKEW_MS };
});
