#!/usr/bin/env node
/* Audit reader in-app: per sumber berita, cek gambar/video & teks yang ikut terambil.
   Butuh server jalan:  node scripts/media-audit.js [--base http://localhost:8787] [--n 3] [--src ANTARA,DETIK] [--json out.json]
   Flag:
     IMG-JUNK     gambar hero/body cocok pola ikon/emoji/avatar/logo/badge/ads
     IMG-SMALL    ukuran di URL < 600px (thumbnail related)
     IMG-OTHER    gambar hero/body sama dengan gambar artikel LAIN di feed (related/sidebar)
     IMG-DUP-HOST gambar hero sama di >1 artikel satu sumber (aset situs)
     IMG-NONE     tidak ada hero sama sekali
     TXT-RELATED  paragraf mirip judul artikel lain di feed / diawali "baca juga" dst
     TXT-LINKY    paragraf pendek tanpa tanda baca akhir (judul link / menu)
     TXT-BOILER   boilerplate (cookie, langganan, hak cipta, ikuti kami)
     TXT-THIN     < 2 paragraf
   exit 1 bila ada flag (CI-friendly). */
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://localhost:8787'), N = +opt('n', 3), ONLY = (opt('src', '') || '').split(',').filter(Boolean), OUT = opt('json', '');

const JUNK = /logo|icon|sprite|avatar|badge|placeholder|blank|pixel|spacer|advert|\/ads?\/|banner|emoji|emoticon|reaction|button|share|gravatar|favicon|wartawan|appstore|playstore|(^|\/)(ig|fb|tw|wa)[-_.]/i;
const SMALL = /(?:^|[\/=_.-])(\d{2,4})[x\/](\d{2,4})(?=[\/_?.&#]|$)/;
const BOILER = /cookie|berlangganan|langganan|hak cipta|copyright|ikuti kami|follow us|subscribe|newsletter|baca juga|simak juga|lihat juga|berita terkait|artikel terkait|iklan|advertisement/i;
const norm = s => String(s || '').toLowerCase().replace(/\W+/g, ' ').trim();
const imgKey = u => String(u).split('?')[0].replace(/-\d+x\d+(?=\.\w+$)/, '').toLowerCase();

async function j(path, ms = 50000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await (await fetch(BASE + path, { signal: c.signal })).json(); } catch (e) { return { ok: false, err: String(e.message || e) }; } finally { clearTimeout(t); }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

(async () => {
  const feed = await j('/api/news');
  if (!feed.sources) { console.error('server tidak menjawab /api/news:', feed.err || ''); process.exit(2); }
  const allItems = feed.sources.flatMap(s => s.items.map(i => ({ ...i, src: s.id })));
  const otherTitles = allItems.map(i => ({ t: norm(i.title), url: i.url, src: i.src })).filter(x => x.t.length > 25);
  const feedImgs = new Map();   // imgKey -> set(url artikel)
  for (const i of allItems) if (i.img) { const k = imgKey(i.img); if (!feedImgs.has(k)) feedImgs.set(k, new Set()); feedImgs.get(k).add(i.url); }

  const jobs = [];
  for (const s of feed.sources) {
    if (ONLY.length && !ONLY.includes(s.id)) continue;
    // GNEWS: sampel lebih sedikit (semua lewat decode GN yang sama)
    const take = /^GNEWS/.test(s.id) ? Math.min(2, N) : N;
    for (const it of s.items.slice(0, take)) jobs.push({ src: s.id, it });
  }
  console.log(`Audit ${jobs.length} artikel dari ${new Set(jobs.map(x => x.src)).size} sumber...\n`);

  const results = await pool(jobs, 4, async ({ src, it }) => {
    const d = await j('/api/read?u=' + encodeURIComponent(it.url));
    const flags = [], notes = [];
    if (!d.ok) return { src, url: it.url, title: it.title, err: d.err || 'gagal' };
    const self = it.url;
    const imgs = [];
    if (d.img) imgs.push({ where: 'hero', url: d.img });
    for (const b of d.blocks || []) if (b.k === 'i' && b.img) imgs.push({ where: 'body', url: b.img.url });
    if (!d.img) flags.push('IMG-NONE');
    for (const im of imgs) {
      const p = im.url.split('?')[0];
      if (JUNK.test(p)) flags.push('IMG-JUNK'), notes.push(`${im.where} junk: ${im.url}`);
      const sm = p.match(SMALL); if (sm && +sm[1] < 600 && im.where === 'body') flags.push('IMG-SMALL'), notes.push(`${im.where} kecil: ${im.url}`);
      const owners = feedImgs.get(imgKey(im.url));
      if (owners && [...owners].some(u => u !== self && u !== d.final)) flags.push('IMG-OTHER'), notes.push(`${im.where} milik artikel lain: ${im.url}`);
    }
    const mine = norm(d.title);
    const paras = (d.blocks || []).filter(b => b.k === 'p').map(b => b.t);
    for (const t of paras) {
      const n = norm(t);
      if (/^(baca juga|simak juga|lihat juga|berita terkait|artikel terkait)/i.test(t)) { flags.push('TXT-RELATED'); notes.push('related: ' + t.slice(0, 90)); continue; }
      const hit = otherTitles.find(o => o.t !== mine && (n === o.t || (n.length < o.t.length + 40 && n.includes(o.t))));
      if (hit) { flags.push('TXT-RELATED'); notes.push(`mirip judul ${hit.src}: ${t.slice(0, 90)}`); continue; }
      if (t.length < 90 && !/[.!?"”')]$/.test(t)) { flags.push('TXT-LINKY'); notes.push('linky: ' + t.slice(0, 90)); continue; }
      if (t.length < 200 && BOILER.test(t)) { flags.push('TXT-BOILER'); notes.push('boiler: ' + t.slice(0, 90)); }
    }
    if (d.thin || paras.length < 2) flags.push('TXT-THIN');
    return { src, url: it.url, title: it.title, via: d.via || 'html', hero: d.img || '', nImg: imgs.length - (d.img ? 1 : 0), nVid: (d.videos || []).length, nPara: paras.length, flags: [...new Set(flags)], notes: notes.slice(0, 6) };
  });

  // IMG-DUP-HOST: hero sama di banyak artikel satu sumber
  const bySrc = {};
  for (const r of results) if (r.hero) ((bySrc[r.src] = bySrc[r.src] || {})[imgKey(r.hero)] = (bySrc[r.src][imgKey(r.hero)] || [])).push(r);
  for (const m of Object.values(bySrc)) for (const rs of Object.values(m)) if (rs.length > 1) for (const r of rs) { r.flags.push('IMG-DUP-HOST'); r.notes.push('hero dipakai ' + rs.length + 'x: ' + r.hero); }

  let bad = 0; const summary = {};
  for (const r of results) {
    const s = summary[r.src] = summary[r.src] || { n: 0, ok: 0, flags: {} };
    s.n++;
    if (r.err) { s.flags.ERR = (s.flags.ERR || 0) + 1; bad++; continue; }
    if (!r.flags.length) s.ok++; else bad++;
    for (const f of r.flags) s.flags[f] = (s.flags[f] || 0) + 1;
  }
  for (const r of results) {
    if (!r.err && !r.flags.length) continue;
    console.log(`[${r.src}] ${r.title.slice(0, 80)}\n   ${r.url}`);
    if (r.err) console.log('   ERR ' + r.err); else { console.log(`   via=${r.via} img=${r.nImg} vid=${r.nVid} para=${r.nPara}  ${r.flags.join(' ')}`); for (const n of r.notes) console.log('     - ' + n); }
  }
  console.log('\n=== RINGKASAN per sumber (bersih/total) ===');
  for (const [k, s] of Object.entries(summary)) console.log(k.padEnd(20), `${s.ok}/${s.n}`, Object.entries(s.flags).map(([f, c]) => f + ':' + c).join(' '));
  if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(results, null, 1));
  process.exit(bad ? 1 : 0);
})();
