// node server.js  (Node 18+, tanpa dependency)
const SOC = require('./social');
const HISTORY = require('./social-history');
const ASSESS = require('./assessment');
const http = require('http'), fs = require('fs'), path = require('path'), dns = require('dns').promises;
// muat .env sederhana (satu baris KEY=VALUE) agar TOMTOM_API_KEY bisa dari env
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) {}
let CFG = {}; try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
if (CFG.insecure_tls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const PORT = process.env.PORT || process.env.SERVER_PORT || CFG.port || 8787;
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY || (CFG.tomtom && (CFG.tomtom.api_key || CFG.tomtom.key)) || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HTML = path.join(__dirname, 'public', 'index.html');
const gn = q => 'https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent(q + ' when:2d');
const NEWS = [
  ['ANTARA', 'https://www.antaranews.com/rss/terkini.xml'],
  ['VOI', 'https://voi.id/rss'],
  ['SINDO', 'https://www.sindonews.com/rss'],
  ['CNN INDONESIA', 'https://www.cnnindonesia.com/rss'],
  ['DETIK', 'https://news.detik.com/rss'],
  ['TEMPO', 'https://rss.tempo.co/'],
  ['LIPUTAN6', 'https://feed.liputan6.com/rss/news'],
  ['REPUBLIKA', 'https://www.republika.co.id/rss'],
  ['TRIBUN', 'https://www.tribunnews.com/rss'],
  ['CNBC ID', 'https://www.cnbcindonesia.com/news/rss'],
  ['GNEWS · DEMO', gn('demo OR "unjuk rasa" OR "aksi massa"')],
  ['GNEWS · KEBAKARAN', gn('kebakaran OR karhutla OR "kebakaran hutan"')],
  ['GNEWS · BANJIR', gn('banjir OR longsor OR "cuaca ekstrem"')],
  ['GNEWS · BENCANA', gn('gempa OR tsunami OR erupsi OR letusan')],   // "bencana" saja terlalu longgar: tas bencana, pusdalops, bantuan — bukan kejadian
  ['GNEWS · INSIDEN', gn('kecelakaan OR ledakan OR ambruk')],
  ['GNEWS · KRIMINAL', gn('penembakan OR pembunuhan OR penangkapan OR terorisme')],
  ['GNEWS · KESEHATAN', gn('wabah OR dbd OR influenza OR campak OR "tangan kaki mulut" OR leptospirosis OR rabies OR kolera OR mpox OR polio OR TBC OR "gagal ginjal" OR KLB OR "tuberkulosis" OR stunting OR imunisasi')],
  ['GNEWS · EKONOMI', gn('phk OR rupiah OR bbm OR "listrik padam"')],
  ['GNEWS · POLITIK', gn('pemilu OR pilkada OR pilpres OR kpu OR perang OR konflik OR "gencatan senjata" OR ultimatum OR kudeta OR invasi OR "partai politik" OR DPR')],
  ['GNEWS · SIBER', gn('ransomware OR "serangan siber" OR phishing OR "bocor data" OR BSSN OR "akun dibajak" OR "dompet kripto" OR exploit OR "zero day" OR deepfake OR "data breach" OR "peretasan"')],
  ['GNEWS · LINGKUNGAN', gn('karhutla OR deforestasi OR "sungai tercemar" OR "sampah plastik" OR longsor OR "tambang ilegal"')],
].concat((CFG.news_extra || []).map(x => [x.id, x.url]));

const cache = new Map();
/* ---------- history buffer sosial: post lama tetap ada antar-sync & restart ---------- */
const HIST_DIR = path.join(__dirname, 'data');
const xHist = new Map(), tHist = new Map();
const histKey = HISTORY.keyOf, histTs = HISTORY.tsOf;
const HIST_MAX = { x: 1500, th: 800 }, HIST_AGE = 24 * 3600e3;
let ADHOC = [];   // topik dinamis dari berita yang lagi naik (nama kasus), in-memory
const histUser = p => String(p.handle || p.username || '').toLowerCase();
// anti-astroturf: teks identik dari >=3 akun berbeda = koordinasi bot, bukan liputan.
// retweet ("RT @") di-skip — viral legit memang share teks yang sama.
// astroturfSig dipotong 160 char: dua posting beda bisa tabrakan di prefix. Karena itu
// sig cuma dipakai buat kandidat — penghapusan mensyaratkan teks ternormalisasi PENUH identik.
const astroturfFull = t => String(t || '').toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/@[\w]+/g, ' ')
  .replace(/#[\p{L}\p{N}_]+/gu, ' ')
  .replace(/[^\p{L}\p{N} ]/gu, ' ')
  .replace(/\s+/g, ' ').trim();   // replika persis astroturfSig tanpa .slice(0,160)
function histAstroturf(map) {
  const eligible = p => { const t = String(p.text || ''); return t.length >= 50 && !/^\s*(rt\s+)?@/i.test(t); };
  const cand = new Map();   // sig -> Map(fullText -> Set(user))
  for (const [k, p] of map) {
    if (!eligible(p)) continue;
    const sig = SOC.astroturfSig(p.text);
    if (sig.length < 40) continue;
    if (!cand.has(sig)) cand.set(sig, new Map());
    const byFull = cand.get(sig), full = astroturfFull(p.text);
    if (!byFull.has(full)) byFull.set(full, new Set());
    byFull.get(full).add(histUser(p));
  }
  for (const [k, p] of map) {
    if (!eligible(p)) continue;
    const byFull = cand.get(SOC.astroturfSig(p.text));
    const users = byFull && byFull.get(astroturfFull(p.text));
    if (users && users.size >= 3) map.delete(k);
  }
}
function histMerge(map, posts, max, file) {
  for (const p of posts) { const k = histKey(p); if (k) map.set(k, p); }
  const now = Date.now();
  histRetag(map, map === xHist ? SOC.socKeepX : SOC.socKeepTh);
  histAstroturf(map);
  const arr = [...map.values()].filter(p => histTs(p) > 0 && histTs(p) <= now && now - histTs(p) <= HIST_AGE).sort((a, b) => histTs(b) - histTs(a));
  const kept = SOC.socBalance(arr, max, histUser);   // cap per topik + per akun, biar karhutla nggak makan buffer
  // laporan terverifikasi (signalEligible) adalah sinyal insiden nyata — jangan sampai
  // di-evict cap per-topik. Langka (~5% post), jadi re-add dengan bound kecil di atas max.
  const keptSet = new Set(kept);
  const rescueCap = Math.max(10, Math.ceil(max * 0.05));
  let rescued = 0;
  for (const p of arr) {
    if (rescued >= rescueCap) break;
    if (keptSet.has(p) || !(p.assessment && p.assessment.signalEligible === true)) continue;
    kept.push(p); keptSet.add(p); rescued++;
  }
  map.clear();
  for (const p of kept) map.set(histKey(p), p);
  histMarkDirty(file, map, max);
}
// klasifikasi ulang history yang dimuat dari disk: buang post lama yang nggak lolos aturan sekarang
function histRetag(map, keep) { HISTORY.retag(map, keep, ADHOC); }
const histSaveAt = {};
const histDirty = new Map();   // file -> {map, max}: ada update yang belum tentu tersimpan
function histSave(file, map, max, force) {
  const now = Date.now();
  if (!force && now - (histSaveAt[file] || 0) < 60000) return;
  histSaveAt[file] = now;
  try {
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const posts = [...map.values()].sort((a, b) => histTs(b) - histTs(a)).slice(0, max);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ classifierVersion: SOC.CLASSIFIER_VERSION, posts }));
    fs.renameSync(tmp, file);
    histDirty.delete(file);
  } catch (e) { console.error('[hist] gagal simpan ' + file + ': ' + (e.message || e)); }
}
function histMarkDirty(file, map, max) { histDirty.set(file, { map, max }); histSave(file, map, max); }
// flush berkala untuk update yang tertahan throttle 60 dtk + flush paksa saat shutdown
setInterval(() => { for (const [f, m] of histDirty) histSave(f, m.map, m.max, true); }, 30000).unref();
const histFlushAll = () => { for (const [f, m] of histDirty) histSave(f, m.map, m.max, true); };
process.on('SIGINT', () => { histFlushAll(); process.exit(0); });
process.on('SIGTERM', () => { histFlushAll(); process.exit(0); });
// aggregator read-only: exception stray tidak boleh membunuh seluruh dashboard
process.on('uncaughtException', e => console.error('[fatal-ish] uncaught:', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[fatal-ish] rejection:', e && e.stack || e));
function histLoad(file, map) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of j.posts || []) { const k = histKey(p); if (k) map.set(k, p); }
  } catch (e) {}
}
histLoad(path.join(HIST_DIR, 'x-history.json'), xHist);
histLoad(path.join(HIST_DIR, 'threads-history.json'), tHist);
histRetag(xHist, SOC.socKeepX); histRetag(tHist, SOC.socKeepTh);
histAstroturf(xHist); histAstroturf(tHist);
const memoRetry = new Map();   // k -> jumlah retry gagal beruntun
// good(v): predikat "payload ini layak jadi data". Hasil fetch yang resolve tapi
// gagal (mis. {ok:false}) TIDAK boleh menghapus last-good — diperlakukan seperti throw.
const memo = (k, ttl, fn, good) => {
  const isGood = good || (v => true);
  const kick = () => {   // refresh background + auto-retry backoff bila gagal (self-heal tanpa nunggu request)
    const cur = cache.get(k);
    if (!cur || cur.p) return;
    cur.p = fn().then(v => accept(v), () => fail());
  };
  const fail = () => {
    const cur = cache.get(k), now = Date.now();
    cache.set(k, { at: now - ttl + 15000, v: cur && cur.v });
    const n = (memoRetry.get(k) || 0) + 1;
    memoRetry.set(k, n);
    if (n <= 5) setTimeout(kick, Math.min(90000, 15000 * n)).unref();
  };
  const accept = v => {
    const cur = cache.get(k);
    if (cur && cur.v !== undefined && isGood(cur.v) && !isGood(v)) return fail();
    cache.set(k, { at: Date.now(), v }); memoRetry.delete(k); return v;
  };
  const c = cache.get(k);
  if (c && c.v !== undefined) {
    if (Date.now() - c.at < ttl) return Promise.resolve(c.v);
    kick();
    return Promise.resolve(c.v);
  }
  if (c && c.p) return c.p;
  const p = fn().then(v => accept(v),
    e => { cache.delete(k); memoRetry.delete(k); throw e; });
  cache.set(k, { at: 0, v: undefined, p }); return p;
};
// semaphore kecil: batasi konkurensi ke upstream yang sama (X GraphQL, worker Threads).
// Lazy fetch antre di slot yang sama dengan sweep utama — lebih baik menunggu daripada kena 429.
const makeSem = max => {
  let n = 0; const q = [];
  return fn => new Promise((res, rej) => {
    const run = () => {
      n++;
      Promise.resolve().then(fn).then(res, rej).finally(() => { n--; const nx = q.shift(); if (nx) nx(); });
    };
    if (n < max) run(); else q.push(run);
  });
};
// last-good untuk cache manual: payload gagal tidak menghapus data valid.
// `at` dimundurkan supaya request berikutnya retry cepat, data lama tetap tersaji.
function cacheFail(cache, ttl, data) {
  const bad = !data || data.ok === false;
  if (bad && cache.data && cache.data.ok) {
    cache.at = Date.now() - ttl + 30000;
    return cache.data;
  }
  cache.at = Date.now(); cache.data = data; return data;
}
async function get(url, opt = {}, ms = 10000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opt, signal: ctl.signal, redirect: opt.redirect || 'follow',
      headers: { 'user-agent': UA, 'accept': '*/*', 'accept-language': 'id-ID,id;q=0.9,en;q=0.8', ...(opt.headers || {}) } });
  } finally { clearTimeout(t); }
}
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
const tag = (b, n) => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? dec(m[1]) : ''; };
function feedImage(b) {
  const u = feedImageRaw(b);
  if (!u) return '';
  const p = u.split('?')[0];
  if (/\.(svg|gif|ico)$/i.test(p) || rdSmallHint(u) || rdJunkUrl(u) || /(logo|favicon|sprite|placeholder|avatar|icon|emoji|emoticon|default[-_]|no[-_]?image|blank|pixel)[^/]*$/i.test(p)) return '';
  return u;
}
function feedImageRaw(b) {
  const custom = b.match(/<img>\s*(https?:\/\/[^<\s]+)\s*<\/img>/i);
  if (custom) return dec(custom[1]);
  const direct = b.match(/<media:content[^>]*url="([^"]+)"/i)
    || b.match(/<media:thumbnail[^>]*url="([^"]+)"/i)
    || b.match(/<enclosure[^>]*type="image[^"]*"[^>]*url="([^"]+)"/i)
    || b.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"/i);
  if (direct) return dec(direct[1]);
  const body = b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || b.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
  const img = body && body[1].match(/<img[^>]*src=["']([^"']+)["']/i);
  return img ? dec(img[1]) : '';
}
const descOf = b => {
  let t = dec(tag(b, 'content:encoded') || tag(b, 'description'))
    .replace(/^[A-Za-z0-9.&' ]{4,60},\s*[A-Z][A-Z0-9 .&']{2,50}\s*--\s*/, '');   // buang dateline "SITUS, KOTA --"
  // buang kredit foto/ilustrasi & boilerplate yang bukan isi berita
  t = t
    .replace(/\((?:[^()]{0,90})\)/g, m => /foto|dok|sumber|istimewa|illustrasi|dokumen|istock|shutterstock|getty/i.test(m) ? ' ' : m)
    .replace(/\b(?:foto|illustrasi|gambar|video|dokumen)\s*[:.-]\s*(?:oleh\s+)?[^.,;)\]]{0,90}/gi, ' ')
    .replace(/\bdok\.[^.,;)\]]{0,60}/gi, ' ')
    .replace(/\bsumber\s*:\s*[^.,;)\]]{0,60}/gi, ' ')
    .replace(/^[A-Z0-9.&'() ]{2,50}?\s+--\s+/, '')        // sisa "Sumber --" / "BNPB --" di awal
    .replace(/^[\s.:;,\-–—]+/, '')
    .replace(/\s+/g, ' ').trim();
  // buang ')' tanpa pasangan '(' (sisa caption yang terpotong), dan '(' tak tertutup di akhir
  let depth = 0, out = '';
  for (const ch of t) {
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; else continue; }
    out += ch;
  }
  t = out.replace(/\(\s*$/, '').trim();
  return t.length > 520 ? t.slice(0, 517).replace(/\s+\S*$/, '') + '…' : t;
};
// <source> Google News kadang berisi URL (https://www.situs.id/) bukan nama media → jadikan hostname rapi
const cleanPub = v => {
  v = String(v || '').trim();
  if (/^(https?:)?\/\//i.test(v) || /^www\./i.test(v)) { try { return new URL(/^www\./i.test(v) ? 'https://' + v : v).hostname.replace(/^www\./i, ''); } catch (e) { return ''; } }
  return v;
};
// domain/sumber yang dilarang — item langsung dibuang dari semua feed.
// kompasiana = platform opini/blog, bukan berita; masuk lewat agregat Google News.
const BANNED_SRC = /infopublik\.id|infopublik|kompasiana|mediacenter\.palangkaraya\.go\.id|viva\.co\.id\/foto/i;
function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const b = m[1], title = tag(b, 'title'), url = tag(b, 'link') || tag(b, 'guid'), d = tag(b, 'pubDate');
    if (title && url && !BANNED_SRC.test(b)) out.push({ title, url, ts: d ? Date.parse(d) || 0 : 0, img: feedImage(b), pub: cleanPub(tag(b, 'source')), desc: descOf(b) });
  }
  for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
    const b = m[1], l = b.match(/<link[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*>([^<]+)<\/link>/i), d = tag(b, 'updated') || tag(b, 'published');
    const t = tag(b, 'title');
    if (l && t && !BANNED_SRC.test(b)) out.push({ title: t, url: (l[1] || '').trim(), ts: Date.parse(d) || 0 });
  }
  return out;
}
/* ---------- bersihkan suffix "- Sumber" dari headline, biar judul cuma judul ---------- */
const SRC_TAIL = /(kompas|antara|detik|cnn|tempo|liputan6|republika|tribun|cnbc|jpnn|okezone|jawapos|viva|kumparan|suara|radar|inilah|merdeka|indosport|youtube|news|kabar|berita|radio|bmkg|bnpb|bpbd|kemendagri|kapolri|tni|voice|akurat|acehinfo|polda|conversation|\btv\b)/i;
function cleanTitle(t) {
  let s0 = String(t || '').trim();
  const pp = s0.indexOf(' | ');
  if (pp > 15) s0 = s0.slice(0, pp).trim();   // "Judul | NamaSitus" — pipe selalu suffix publisher
  let s = s0.replace(/\s[-–—]\s*(?:https?|www)\b[^\s]*(?:\)[^\s]*)?$/i, '').trim();
  for (let i = 0; i < 3; i++) {   // GN kadang dobel suffix: "judul - domain.id - PENERBIT"
    const m = s.match(/^(.{8,}?)\s[-–—]\s([A-Za-z0-9][A-Za-z0-9.&'®™ ()]{1,60})$/);
    if (!m) break;
    const tail = m[2].trim();
    const words = tail.split(/\s+/).map(w => w.replace(/[®™]/g, '')).filter(Boolean);
    if (words.length > 5) break;                    // kelanjutkalimat panjang, bukan label sumber
    const isPub = (!/[,;.:?!]/.test(tail) && words.every(w => /^[A-Z0-9]/.test(w)))   // title-case = label sumber
      || (!/[,;.:?!]/.test(tail) && words.length <= 3 && tail.length <= 30 && words.every(w => /^[a-z0-9]/.test(w)))  // lowercase pendek = publisher kecil
      || /\.(com|id|net|co\.id|go\.id|org|tv|info|media)$/i.test(tail)                  // domain/TLD
      || SRC_TAIL.test(tail);                                                          // institusi/media dikenal
    if (!isPub) break;
    s = m[1].trim();
  }
  return s;
}
const news = () => Promise.all(NEWS.map(([id, url]) => memo('n:' + id, 55000, async () => {
  const attempts = [
    url,
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    'https://corsproxy.io/?url=' + encodeURIComponent(url),
    'https://proxy.corsfix.com/?' + encodeURIComponent(url),
    'https://test.cors.workers.dev/?' + encodeURIComponent(url)
  ];
  let lastErr = '';
  const t0 = Date.now();
  // rss.tempo.co di-blokir Cloudflare (403) dan feed aslinya mandek — Google News site query didahulukan
  if (id === 'TEMPO') attempts.unshift('https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent('site:tempo.co when:2d'));
  outer: for (const u of attempts) {
    for (let i = 0; i < 2; i++) {
      if (Date.now() - t0 > 26000) break outer;   // deadline per feed: jangan biarkan satu feed macetkan semua
      try {
        const r = await get(u, {}, 12000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const items = parseFeed(await r.text());
        if (!items.length) throw new Error('feed kosong');
        const fresh = items.filter(it => !it.ts || Date.now() - it.ts <= 24 * 3600e3);
        const newest = Math.max(0, ...fresh.map(i => i.ts || 0));
        return { id, ok: true, stale: !!(newest && Date.now() - newest > 3 * 3600e3), items: fresh.slice(0, 100).map(it => ({ ...it, title: cleanTitle(it.title), src: id })), at: Date.now() };
      } catch (e) {
        lastErr = String(e.message || e);
        if (i === 0) await new Promise(res => setTimeout(res, 350));
      }
    }
  }
  return { id, ok: false, err: ('gagal direct + proxy: ' + lastErr).slice(0, 140), items: [] };
}, v => v.ok === true)));

/* ---------- taksonomi: insiden fisik (geo) + topik sosial ---------- */
// Daftar penyakit/wabah — satu sumber untuk CATS (News Wire) & HEALTH_EVENT_RE
// (gate plotOk peta/globe). Sumber istilah: daftar infeksi emerging Kemenkes +
// pola judul kesehatan media RI (TBC, DBD, influenza, HFMD, leptospirosis, dst).
const HEALTH_DZ = String.raw`wabah|\bklb\b|kejadian luar biasa|dbd|\bdhf\b|demam berdarah|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|typhoid|kolera|rabies|gila anjing|anjing gila|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|rotavirus|flu burung|h1n1|malaria`;
// istilah insiden layanan/kondisi kesehatan (bukan nama penyakit) — ikut ke
// HEALTH_EVENT_RE supaya plotOk tidak membuang item yang CATS sudah terima
const HEALTH_EVT = String.raw`gagal ginjal|gizi buruk|busung lapar|malnutrisi|donor darah|bank darah|transfusi darah|stok darah|obat palsu|talasemia|hemofilia`;
const CATS = [
  { id:'demo', label:'Demo', sev:0.82, geo:true, re:/(\bdemo\b(?!\s*(aplikasi|game|produk|sistem|fitur|cara|tutorial|masak|memasak|kuliner|spesial|special))(?<!cooking demo|cooking\s+demo)|unjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|\bmassa\b|long march|audiensi|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day)/i },
  { id:'fire', label:'Kebakaran', sev:0.96, geo:true, re:/(kebakaran|karhutla|kebakaran hutan|kebakaran lahan|terbakar|kobaran api|asap tebal)/i },
  { id:'flood', label:'Banjir', sev:0.86, geo:true, re:/(banjir|genangan|longsor|tanah longsor|cuaca ekstrem|hujan deras|\brob\b)/i },
  { id:'disaster', label:'Bencana', sev:1, geo:true, re:/(gempa|tsunami|erupsi|letusan|bencana|evakuasi|korban jiwa|ambruk|tenggelam|hanyut|banjir bandang)/i },
  { id:'insiden', label:'Insiden', sev:0.62, geo:true, re:/(kecelakaan|ledakan|pohon tumbang|runtuh|tabrakan|tabrak lari|kapal karam|pesawat jatuh|tergelincir|terjun)/i },
  { id:'siber', label:'Siber', sev:0.55, geo:false, re:/(peretasan|peretas|hacker|ransomware|phishing|malware|ddos|botnet|zero[- ]day|n[- ]?day|\bcve[- ]?\d{4}|exploit|dieksploitasi|kerentanan|vulnerabilit|backdoor|spyware|skimming|carding|cryptojack|deepfake|deface|defacement|vishing|smishing|sextortion|kebocoran data|bocor data|data breach|pencurian data|akun dibajak|akun palsu|scam|penipuan online|pinjol ilegal|investasi bodong|bssn|badan siber|serangan siber|serangan cyber|insiden keamanan|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|layanan lumpuh|situs lumpuh|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|infrastruktur kritis|apt\d{1,2}\b|command and control|leak site|akun (media sosial|instagram|facebook|whatsapp|telegram|x|tiktok) (dibajak|diretas|dibobol))/i },
  { id:'kriminal', label:'Kriminal', sev:0.78, geo:true, re:/(penembakan|pembunuhan|pengeroyokan|begal|curat|pencurian|perampokan|penangkapan|ditangkap|tersangka|kabur dari lapas|napi kabur|terorisme|radikalisasi|suap|gratifikasi|penipuan|narkoba|psikotropika|penculikan|perkosaan|rudapaksa)/i },
  { id:'kesehatan', label:'Kesehatan', sev:0.6, geo:true, re:new RegExp('(?:' + HEALTH_DZ + '|' + HEALTH_EVT + '|stunting|obesitas|vaksin|vaksinasi|imunisasi|kemenkes|bpom|faskes|puskesmas|kanker)', 'i') },
  { id:'ekonomi', label:'Ekonomi', sev:0.5, geo:false, re:/(phk|rupiah|kurs dollar|inflasi|defisit|apbn|apbd|ihsg|bursa efek|saham|emiten|dividen|stock split|buyback|right issue|utang negara|subsidi|bbm|pertamax|solar|listrik padam|padam listrik|pemadaman listrik|pertamina|\bpln\b|ojk|bank indonesia|umk\b|ump\b|thr\b|belanja negara|bea cukai|ekspor|impor|suku bunga|bappebti|kripto|bitcoin|pinjol|fintech|paylater|harga (cabai|beras|daging|minyak|emas))/i },
  { id:'politik', label:'Politik', sev:0.55, geo:false, re:/(pilpres|pilkada|pilgub|pilbup|pilgici|pemilu|\bkpu\b|kpud|bawaslu|capres|cawapres|partai politik|caleg|capil|\bdpr\b|\bdprd\b|parlemen|fraksi|koalisi|oposisi|pelantikan|menteri|wakil presiden|\bistana\b|senayan|bansos|rapat paripurna|mahkamah konstitusi|impeachment|majelis kehormatan|reshuffle|menko|kadin|perang|konflik|invasi|aneksasi|pendudukan|gencatan senjata|ultimatum|kudeta|pemberontakan|separatis|genosida|blokade|embargo|sandera|pertempuran|peluru kendali|\brudal\b|\bdron\b|serangan udara|perjanjian damai|perundingan damai|program mbg|makan bergizi)/i }
];
const SKIP_RE = /(pascabencana|pascagempa|pascabanjir|mitigasi|kesiapsiagaan|potensi bencana|rawan bencana|risiko bencana|kajian risiko|simulasi|edukasi|sosialisasi|pelatihan|antisipasi|siaga bencana|hadapi bencana|menghadapi bencana|peringatan dini|early warning|asuransi|operasi patuh|imbau|himbau|ingatkan|waspada|waspadai|ranperda|perda|godok|korupsi|dana bencana|tas bencana|go[- ]?bag|pusdalops|kebutuhan darurat|peralatan bencana|salurkan bantuan|menyalurkan|penyaluran|modus|ruu|boikot dirinya|joget|liga|top skor|voli|sepak bola|piala|kualifikasi|gaun|mahalini|fashion|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|penghargaan|jasa raharja|warisan|turun-temurun|sepanjang 20\d\d|berdampak ke ekonomi|brasil|brazil|amerika serikat|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|perancis|paris|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza|poland|polandia|polonia|krakow|warsaw|warszawa|lublin|czechia|ceko|prague|austria|wina|vienna|finland|finlandia|singapura|singapore|suriah|syria|irak|iraq|mesir|egypt|libya|libia|maroko|morocco|aljazair|algeria|tunisia|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|hungaria|hungary|rumania|romania|bulgaria|serbia|kroasia|croatia|slowakia|slovakia|slovenia|belgia|belgium|irlandia|ireland|estonia|latvia|lithuania|belarus|mongolia|maladewa|maldives|timor leste|selandia baru|new zealand|kuba|cuba|jamaika|jamaica|haiti|nikaragua|kosta rika|costa rica|kolombia|colombia|venezuela|bolivia|ekuador|ecuador|peru|paraguay|uruguay|congo|rwanda|uganda|tanzania|zambia|zimbabwe|mozambique|angola|namibia|botswana|lesotho|madagascar|mauritius|somalia|eritrea|djibouti|afghanistan|bhutan|brunei|albania|armenia|azerbaijan|cyprus|iceland|kosovo|luxembourg|malta|moldova|montenegro|san marino|vatikan|vatican|monako|monaco|georgia|jordan|panama|senegal|cameroon|gambia|guinea|sierra leone|liberia|mauritania|burkina faso|tokyo|seoul|beijing|shanghai|hong kong|taipei|bangkok|hanoi|manila|kualalumpur|kathmandu|moskwa|moscow|berlin|rome|roma|madrid|amsterdam|brussels|zurich|stockholm|oslo|copenhagen|helsinki|dublin|budapest|bucharest|sofia|belgrade|zagreb|vilnius|riga|tallinn|minsk|kiev|kyiv|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|nairobi|kampala|kigali|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|bangui|yaounde|conakry|lome|cotonou|abidjan|nouakchott|maseru|mbabane|gaborone|windhoek|maputo|antananarivo|moroni|port louis|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|port-au-prince|nassau|bridgetown|castries|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|sucre|guayaquil)/i;
const catMeta = id => CATS.find(c => c.id === id) || { id:'', label:'Insiden', sev:0.5, geo:true };
const assessNews = t => SOC.socAssess(t);
const catOf = t => {
  const a = assessNews(t);
  // Feed categorization = topic relevance, BUKAN signal eligibility.
  // events[] hanya untuk alarm/klaster; headline berita jarang punya EVENT_ACTION
  // jadi events kosong untuk sebagian besar judul legit.
  if (!a.topics.length || SKIP_RE.test(t)) return '';
  // konflik/perang internasional memang scope foreign — tetap masuk tab Politik
  // (geo:false, topik naratif). Topik geo lain tetap dibuang saat semua foreign.
  if (a.findings.length && a.findings.every(f => f.scope === 'foreign') && !a.topics.some(tp => tp === 'konflik' || ASSESS.CATEGORY[tp] === 'siber')) return '';
  const ids = new Set(a.topics.map(tp => ASSESS.CATEGORY[tp]).filter(Boolean));
  const hit = CATS.find(c => ids.has(c.id));
  return hit ? hit.id : '';
};
const INCIDENT_RE = new RegExp(CATS.map(c => c.re.source).join('|'), 'i');
// feed topik menjamin tabnya tidak kosong: item GNEWS·SIBER yang lolos SKIP_RE tapi
// tidak kena regex tetap masuk kategori feed-nya
const FEED_CAT = { demo:'demo', kebakaran:'fire', banjir:'flood', bencana:'disaster', insiden:'insiden', kriminal:'kriminal', kesehatan:'kesehatan', ekonomi:'ekonomi', politik:'politik', siber:'siber', lingkungan:'disaster' };
const feedCatOf = id => FEED_CAT[String(id || '').toLowerCase().split('·').pop().trim()] || '';

/* ---------- breaking wire: subset panas, dipakai marquee (fetch 45s) ---------- */
const breakNorm = t => String(t).toLowerCase().replace(/\s+-\s+[^-]{2,45}$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const breaking = () => memo('breaking', 25000, async () => {
  const srcs = await news(), seen = new Set(), items = [];
  const now = Date.now();
  let matched = 0;
  for (const s of srcs) {
    if (!s.ok) continue;
    for (const it of s.items) {
      const cat = catOf(it.title);
      if (!cat || catMeta(cat).geo === false) continue;
      const k = breakNorm(it.title).slice(0, 48);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      matched++;
      const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > 24 * 3600e3) continue;
      const recency = Math.max(0.12, Math.exp(-age / (16 * 3600e3)));
      const meta = catMeta(cat);
      items.push({ ...it, assessment: assessNews(it.title), src: s.id, cat, label: meta.label, score: +(meta.sev * recency).toFixed(3) });
    }
  }
  // Kandidat diambil stabil: per kategori terbaru, dedupe tajuk (content-key, bukan URL mentah).
  const ord = { demo: 0, fire: 1, flood: 2, disaster: 3, insiden: 4, kriminal: 5, kesehatan: 6 };
  items.sort((a, b) => (ord[a.cat] ?? 9) - (ord[b.cat] ?? 9) || (b.ts || 0) - (a.ts || 0));
  const per = {}, ranked = [], sigs = [];
  const toks = s => new Set(breakNorm(s).split(' ').filter(w => w.length > 2));
  const jac = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n); };
  for (const it of items) {
    if (ranked.length >= 14) break;
    const cap = it.cat === 'disaster' ? 4 : 3;
    if ((per[it.cat] || 0) >= cap) continue;
    const sig = toks(it.title);
    if (sigs.some(s => jac(s, sig) > 0.62)) continue;
    per[it.cat] = (per[it.cat] || 0) + 1;
    sigs.push(sig);
    ranked.push(it);
  }
  // Urutan di marquee harus stabil: urut per kategori lalu waktu, bukan berubah per fetch.
  ranked.sort((a, b) => (ord[a.cat] ?? 9) - (ord[b.cat] ?? 9) || (b.ts || 0) - (a.ts || 0));
  const prev = cache.get('breaking');
  if (!ranked.length && prev && prev.v && prev.v.items && prev.v.items.length) return { ...prev.v, at: Date.now(), stale: true };
  return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, items: ranked, total: matched, at: Date.now(), cycle: 45 };
});

/* ---------- X via cookie sendiri (auth_token + ct0 dari config.json) ---------- */
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const FEATURES = { rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false, creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true, c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true, tweetypie_unmention_optimization_enabled: true, responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true, view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true, responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false, creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true, standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true, rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true, longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false };
const X = CFG.x || {};
X.auth_token = process.env.X_AUTH_TOKEN || X.auth_token || '';
X.ct0 = process.env.X_CT0 || X.ct0 || '';
X.bearer = process.env.X_BEARER || X.bearer || '';
X.query_id = process.env.X_QUERY_ID || X.query_id || '';
const xHas = () => !!(X.auth_token && X.ct0);
async function xQueryId() {
  if (X.query_id) return X.query_id;
  return memo('xqid', 6 * 3600e3, async () => {
    const hdr = xHas() ? { cookie: `auth_token=${X.auth_token}; ct0=${X.ct0}`, 'x-csrf-token': X.ct0 } : {};
    const html = await (await get('https://x.com/home', { headers: hdr }, 20000)).text();
    let urls = [...new Set([...html.matchAll(/https:\/\/abs\.twimg\.com\/[^"'\s]*?\.js/g)].map(m => m[0]))];
    urls.sort((a, b) => (/\/main\.[\w]+\.js$/.test(b) ? 1 : 0) - (/\/main\.[\w]+\.js$/.test(a) ? 1 : 0));
    for (const u of urls) {
      try {
        const js = await (await get(u, {}, 25000)).text();
        const m = js.match(/queryId:"([\w-]+)",operationName:"SearchTimeline"/);
        if (m) { console.log('[x] SearchTimeline queryId:', m[1]); return m[1]; }
      } catch (e) {}
    }
    throw new Error('queryId SearchTimeline tidak ketemu; isi x.query_id manual di config.json');
  });
}
function collect(o, out) {
  if (!o || typeof o !== 'object') return;
  if (o.legacy && o.legacy.full_text && o.rest_id) {
    const u = o.core && o.core.user_results && o.core.user_results.result;
    const lg = (u && u.legacy) || {};
    const uc = (u && u.core) || {};
    const h = uc.screen_name || lg.screen_name || '';
    const nt = o.note_tweet && o.note_tweet.note_tweet_results && o.note_tweet.note_tweet_results.result;
    const extractedUrls = [];
    if (o.legacy.entities && Array.isArray(o.legacy.entities.urls)) {
      for (const uo of o.legacy.entities.urls) {
        if (uo.expanded_url) extractedUrls.push(uo.expanded_url);
        else if (uo.url) extractedUrls.push(uo.url);
      }
    }
    if (nt && nt.entity_set && Array.isArray(nt.entity_set.urls)) {
      for (const uo of nt.entity_set.urls) {
        if (uo.expanded_url) extractedUrls.push(uo.expanded_url);
        else if (uo.url) extractedUrls.push(uo.url);
      }
    }
    out.set(o.rest_id, {
      id: o.rest_id,
      handle: h ? '@' + h : '',
      name: uc.name || lg.name || h,
      avatar: String((u && u.avatar && u.avatar.image_url) || lg.profile_image_url_https || '').replace(/_normal(\.\w+)$/, '_bigger$1'),
      text: (nt && nt.text) || o.legacy.full_text,
      urls: extractedUrls,
      ts: Date.parse(o.legacy.created_at) || 0,
      created_at: o.legacy.created_at || '',
      url: h ? `https://x.com/${h}/status/${o.rest_id}` : '',
      replies: o.legacy.reply_count || 0,
      reposts: o.legacy.retweet_count || 0,
      likes: o.legacy.favorite_count || 0,
      views: o.views ? (+o.views.count || 0) : 0,
      parent: o.legacy.in_reply_to_status_id_str || '',
      to: o.legacy.in_reply_to_screen_name || '',
      verified: !!(u && (u.is_blue_verified || (u.verification && u.verification.verified)))
    });
  }
  for (const k in o) collect(o[k], out);
}
function bottomCursor(j) {
  let c = '';
  const walk = o => {
    if (!o || typeof o !== 'object' || c) return;
    if (o.cursorType === 'Bottom' && typeof o.value === 'string') { c = o.value; return; }
    for (const k in o) walk(o[k]);
  };
  walk(j);
  return c;
}
const xSem = makeSem(4);   // maks 4 SearchTimeline paralel — lazy & sweep berbagi slot yang sama
async function xSearchGo(q, cursor, winH) {
  const id = await xQueryId();
  // winH: jendela since_time dalam jam; <=0 = tanpa filter waktu (dipakai conversation_id)
  const win = winH == null ? 46 : winH;
  const vars = { rawQuery: q + (win > 0 ? ' since_time:' + Math.floor((Date.now() - win * 3600e3) / 1000) : ''), count: 20, querySource: 'typed_query', product: 'Latest' };
  if (cursor) vars.cursor = cursor;   // halaman berikut: rawQuery wajib tetap ada, kalau tidak 422
  const url = `https://api.x.com/graphql/${id}/SearchTimeline`;
  const r = await get(url, { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: 'Bearer ' + (X.bearer || BEARER), cookie: `auth_token=${X.auth_token}; ct0=${X.ct0}`,
    'x-csrf-token': X.ct0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'id', referer: 'https://x.com/search?q=' + encodeURIComponent(q) + '&f=live' },
    body: JSON.stringify({ variables: vars, features: X.features || FEATURES }) }, 20000);
  if (!r.ok) {
    const textSnippet = (await r.text()).slice(0, 160);
    const err = new Error('X HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' (cookie kadaluarsa?)' : '') + ' ' + textSnippet);
    err.status = r.status;
    const resetHdr = r.headers.get('x-rate-limit-reset');
    err.resetTime = resetHdr ? parseInt(resetHdr, 10) * 1000 : 0;
    throw err;
  }
  const j = await r.json(), out = new Map(); collect(j, out);
  if (!out.size && !cursor) {   // 200 tapi nol tweet: jangan diam, tampilkan bentuk respons biar kelihatan (IP datacenter / sesi diflag / query kosong)
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
    const raw = JSON.stringify(j);
    throw new Error('X HTTP 200 tapi 0 tweet (' + raw.length + 'B): ' + raw.slice(0, 180));
  }
  if (j.errors && j.errors.length && !out.size) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return { posts: [...out.values()].map(p => ({ ...p, q })), cursor: bottomCursor(j) };
}
const xSearch = (q, cursor, winH) => xSem(() => xSearchGo(q, cursor, winH));
/* ---------- query adaptif: frasa yang sedang naik dari headline ---------- */
const TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu minggu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri').split(' '));
const TBLK = new Set(('detik cnn tempo liputan6 republika tribun cnbc antara jawapos okezone kumparan suara merdeka sindonews jpnn tvri inews media news kompas viva metrotvnews rmol infopublik jabarprov korankaltim tvone merahputih poskota beritasatu gridoto wowkeren bola bolaoverza mediaindonesia faktualnews berita foto video gallery wawancara investigasi khusus daerah nasional internasional ekonomi hiburan selebriti olahraga dishub cumplik').split(' '));
const GEO_INC_RE = new RegExp(CATS.filter(c => c.geo).map(c => c.re.source).join('|'), 'i');
const trendingQueries = () => memo('trending', 10 * 60e3, async () => {
  try {
    const srcs = await news(), titles = [], seenT = new Set();
    for (const s of srcs) if (s.ok) for (const it of s.items.slice(0, 40)) {
      const k = String(it.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (k.length > 10 && !seenT.has(k)) { seenT.add(k); titles.push(it.title); }
    }
    if (titles.length < 40) return [];
    const score = new Map();
    for (const t of titles) {
      const inc = GEO_INC_RE.test(t) ? 1 : 0, seen = new Set();
      for (const m of String(t).matchAll(/[A-Z][A-Za-z'&]{2,}(?:\s+(?:[A-Z][A-Za-z'&]{2,}|[A-Z]{2,8})){0,3}/g)) {
        const ph = m[0].toLowerCase().replace(/\s+/g, ' ').trim();
        if (ph.length < 4 || ph.length > 42 || seen.has(ph)) continue;
        seen.add(ph);
        const words = ph.split(' ');
        if (words.some(w => w.length < 3 || TSTOP.has(w) || TBLK.has(w))) continue;
        const e = score.get(ph) || [0, 0];
        e[0]++; e[1] += inc; score.set(ph, e);
      }
    }
    const out = [];
    for (const [ph, [n, ctx]] of [...score.entries()].sort((a, b) => (b[1][0] + 2 * b[1][1]) - (a[1][0] + 2 * a[1][1]))) {
      const single = !ph.includes(' ');
      const need = single ? 5 : 3;
      if (n < need) continue;
      if (single && ctx < 2) continue;   // kata tunggal wajib muncul di konteks insiden ≥2 judul
      out.push(ph);
      if (out.length >= 8) break;
    }
    return out;
  } catch (e) { return []; }
});
/* ---------- X + Threads: pipeline berbasis topic registry (social.js) ---------- */
const adhocRefresh = async () => {
  try {
    const tr = (await trendingQueries()).filter(ph => ph.length <= 30 && !SKIP_RE.test(ph) && !SOC.SOC_FOREIGN_RE.test(ph)
      && !SOC.SOC_TOPICS.some(t => t.id === ph.toLowerCase()));
    ADHOC = SOC.socAdhoc(tr);
  } catch (e) { ADHOC = []; }
  return ADHOC;
};
const topicOf = q => SOC.SOC_TOPICS.concat(ADHOC).find(t => t.id === String(q).toLowerCase());
const tagX = (p, extra) => HISTORY.tag(p, extra || ADHOC) && SOC.socKeepX(p);
const tagTh = (p, extra) => HISTORY.tag(p, extra || ADHOC) && SOC.socKeepTh(p);
const socPosts = () => [
  ...[...xHist.values()].map(p => ({ topics: p.topics, platform: 'x', user: p.handle, ts: histTs(p) })),
  ...[...tHist.values()].map(p => ({ topics: p.topics, platform: 'th', user: p.username, ts: histTs(p) }))];
// chip + trending + statistik lintas platform, semuanya dari history sosial itu sendiri
const socMeta = () => {
  const { stats, hot } = SOC.socHot(socPosts());
  return { queries: SOC.SOC_TOPICS.map(t => t.id).concat(ADHOC.map(t => t.id)),
    trending: hot.map(h => h.id), both: hot.filter(h => h.both).map(h => h.id), hot, stats };
};
const xSeen = new Map();   // topik -> ts fetch terakhir, buat rotasi sadar-panas
let xTick = 0;
const xposts = () => memo('x', 300000, async () => {
  await adhocRefresh();
  const meta0 = socMeta();
  if (!xHas()) return { ok: false, err: 'auth_token / ct0 belum diisi di config.json', posts: [], ...meta0 };
  // rotasi sadar-panas: topik yang lama nggak disapu & lagi ramai didahulukan; ad-hoc + 2 terpanas selalu masuk
  const all = SOC.socQueries('x', ADHOC), first = xTick === 0, now = Date.now();
  xTick++;
  const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
  const heat = t => { const s = stats[t]; return s ? (s.x || 0) + (s.th || 0) : 0; };
  const byTopic = new Map();
  for (const e of all) { const a = byTopic.get(e.t); if (a) a.push(e); else byTopic.set(e.t, [e]); }
  const forced = new Set(ADHOC.map(a => a.id).concat(hotTop));
  const chosen = new Set();
  if (first) { for (const t of byTopic.keys()) chosen.add(t); }
  else {
    const N = 12, pri = t => ((now - (xSeen.get(t) || 0)) / 60000) * (1 + Math.min(heat(t), 60) / 15);
    const rest = [...byTopic.keys()].filter(t => !forced.has(t)).sort((a, b) => pri(b) - pri(a));
    let used = 0;
    // forced bisa berisi id topik tanpa query (trending basi / ad-hoc yang sudah
    // keluar registry) — byTopic.get(t) undefined di situ, jangan sampai TypeError.
    for (const t of forced) { if (!byTopic.has(t)) continue; chosen.add(t); used += byTopic.get(t).length; }
    for (const t of rest) { const n = (byTopic.get(t) || []).length; if (used + n > N) continue; chosen.add(t); used += n; }
  }
  const sel = new Map();
  // tick pertama: satu query per topik saja — sweep semua query sekaligus = burst 429.
  if (first) { for (const t of chosen) { const l = byTopic.get(t) || []; if (l[0]) sel.set(l[0].q, l[0]); } }
  else for (const t of chosen) for (const e of byTopic.get(t) || []) sel.set(e.q, e);
  for (const t of chosen) xSeen.set(t, now);
  const queries = [...sel.values()], errs = [], batch = [], page2 = [];
  let rawN = 0, dropTs = 0, dropTag = 0, dropSample = null, newest = 0;
  const ingest = (e, list) => {
    for (const p of list) {
      rawN++; if (p.ts > newest) newest = p.ts;
      if (!p.ts || now - p.ts > 48 * 3600e3) { dropTs++; if (!dropSample) dropSample = { ts: p.ts, ca: p.created_at, txt: String(p.text || '').slice(0, 60) }; continue; }
      if (!tagX(p)) { dropTag++; continue; }
      p.q = e.t; p.qs = p.topics.slice();
      batch.push(p);
    }
  };
  for (let i = 0; i < queries.length; i += 5) {
    const chunk = queries.slice(i, i + 5);
    const rs = await Promise.allSettled(chunk.map(e => xSearch(e.q)));
    rs.forEach((r, j) => {
      const e = chunk[j];
      if (r.status === 'rejected') { errs.push(e.t + ': ' + String(r.reason && r.reason.message || r.reason)); return; }
      ingest(e, r.value.posts);
      if (r.value.cursor && r.value.posts.length >= 15) page2.push({ e, cursor: r.value.cursor, n: r.value.posts.length });
    });
  }
  // halaman 2 cuma untuk topik yang beneran ramai/hangat — tiap page = 1 request, maks 4 per siklus
  page2.sort((a, b) => (forced.has(b.e.t) ? 1 : 0) - (forced.has(a.e.t) ? 1 : 0) || b.n - a.n);
  for (let i = 0; i < Math.min(4, page2.length); i += 4) {
    const chunk = page2.slice(i, i + 4);
    const rs = await Promise.allSettled(chunk.map(x => xSearch(x.e.q, x.cursor)));
    rs.forEach((r, j) => {
      const x = chunk[j];
      if (r.status === 'rejected') { errs.push(x.e.t + '/p2: ' + String(r.reason && r.reason.message || r.reason)); return; }
      ingest(x.e, r.value.posts);
    });
  }
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  const posts = [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
  let err = errs.join(' | ');
  if (!posts.length && !err) err = '0 post lolos filter: ' + rawN + ' tweet dari ' + queries.length + ' query (drop ts:' + dropTs + ' topik:' + dropTag + ', tweet terbaru=' + (newest ? new Date(newest).toISOString() : '-') + ', qid=' + (X.query_id ? 'env/config:' + X.query_id : 'auto') + ')' + (dropSample ? ' | contoh ts=' + dropSample.ts + ' created_at="' + dropSample.ca + '" "' + dropSample.txt + '"' : '');
  return { ok: errs.length < queries.length, err, posts, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
}, v => (v.posts || []).length > 0);
/* ---------- X lazy: satu topik on-demand (klik chip yang masih kosong) ---------- */
const xqLazy = q => memo('xq:' + String(q).toLowerCase(), 600000, async () => {
  if (!xHas()) throw new Error('auth_token / ct0 belum diisi');
  const tp = topicOf(q), extra = tp ? ADHOC : ADHOC.concat(SOC.socAdhoc([q]));
  const qs = tp ? tp.x : ['"' + q + '" -filter:replies'];
  const rs = await Promise.allSettled(qs.map(x => xSearch(x)));
  const now = Date.now(), batch = [];
  for (const r of rs) if (r.status === 'fulfilled') for (const p of r.value.posts) {
    if (!p.ts || now - p.ts > 48 * 3600e3 || !tagX(p, extra)) continue;
    p.q = String(q).toLowerCase(); p.qs = p.topics.slice(); batch.push(p);
  }
  if (!batch.length && rs.every(r => r.status === 'rejected')) throw rs[0].reason;
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  return [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
});

/* ---------- Threads: toolzerhub/threads-scraper (MIT) lewat worker Python ---------- */
const { execFile } = require('child_process');
const TH = CFG.threads || {};
const PY_BIN = [
  TH.python,
  path.join(__dirname, '.venv', 'bin', 'python'),
  path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
  'python3'
].filter(Boolean).find(p => p === 'python3' || fs.existsSync(p));
// spec bisa array query (kompat lama) atau {searches:[...], profiles:[...]}
const thSem = makeSem(3);   // maks 3 worker Threads paralel — lazy thq antre di slot yang sama
const runThRaw = (spec, timeout) => new Promise((resolve, reject) => {
  execFile(PY_BIN, [path.join(__dirname, 'vendor', 'threads_worker.py'), JSON.stringify(spec)],
    { timeout, maxBuffer: 12 << 20 },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).replace(/\s+/g, ' ').slice(0, 240)));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('worker bukan JSON valid')); }
    });
});
const runTh = (spec, timeout) => thSem(() => runThRaw(spec, timeout));
function thCollect(rs, extra) {
  const now = Date.now(), batch = [], errs = [];
  for (const r of rs) {
    if (r.status === 'rejected') { errs.push({ q: '*', err: String(r.reason && r.reason.message || r.reason) }); continue; }
    for (const e of r.value.errs || []) errs.push(e);
    for (const p of r.value.posts || []) {
      if (!p || !p.code || !p.text) continue;
      if (p.created_at && now - Date.parse(p.created_at) > 72 * 3600e3) continue;
      if (!tagTh(p, extra)) continue;
      p.qs = p.topics.slice();
      batch.push(p);
    }
  }
  return { batch, errs };
}
// Watchlist profil Threads: akun dari config (threads.watch) + penulis yang
// post-nya sudah lolos klasifier di history — dinamis, bukan tebakan handle.
// Profile posts dipakai karena search logged-out cuma dapat ~20 hasil tanpa halaman 2.
const TH_WATCH = (Array.isArray(TH.watch) ? TH.watch : [])
  .map(s => String(s).replace(/^@/, '').trim()).filter(Boolean);
const dynWatch = (now) => {
  const uc = Object.create(null);
  for (const p of tHist.values()) {
    const u = String(p.username || '').toLowerCase();
    if (u && histTs(p) > now - 24 * 3600e3) uc[u] = (uc[u] || 0) + 1;
  }
  return Object.entries(uc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
};
const thSeen = new Map();   // topik -> ts fetch terakhir
let thTick = 0;
const threads = () => memo('threads', 300000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan. Jalankan: python3 -m venv .venv && .venv/bin/pip install curl_cffi');
  await adhocRefresh();
  const meta0 = socMeta(), now = Date.now();
  thTick++;
  // Dulu semua ~29 query tiap 4 menit = ~430 request/jam logged-out → kena 429 terus.
  // Sekarang rotasi sadar-panas seperti X: ~10 query + 5 profil per siklus.
  const entries = SOC.socQueries('th', ADHOC);
  const byTopic = new Map();
  for (const e of entries) { const a = byTopic.get(e.t); if (a) a.push(e.q); else byTopic.set(e.t, [e.q]); }
  const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
  const heat = t => { const s = stats[t]; return s ? (s.th || 0) + (s.x || 0) : 0; };
  const forced = new Set(ADHOC.map(a => a.id).concat(hotTop));
  const chosen = new Set();
  // throttle sejak siklus pertama: burst ~30 request langsung memicu 429 Threads
  const N = 13, pri = t => ((now - (thSeen.get(t) || 0)) / 60000) * (1 + Math.min(heat(t), 60) / 15);
  const rest = [...byTopic.keys()].filter(t => !forced.has(t)).sort((a, b) => pri(b) - pri(a));
  let used = 0;
  for (const t of forced) { chosen.add(t); used += byTopic.get(t).length; }
  for (const t of rest) { const n = byTopic.get(t).length; if (used + n > N) continue; chosen.add(t); used += n; }
  for (const t of chosen) thSeen.set(t, now);
  const searches = [...new Set([...chosen].flatMap(t => byTopic.get(t)))];
  const watch = [...new Set(TH_WATCH.concat(dynWatch(now)))];
  // profil watchlist: semua kalau ≤6, rotasi sisanya per siklus
  const wN = Math.min(8, watch.length), wOff = watch.length ? (thTick - 1) % watch.length : 0;
  const profiles = watch.length <= wN ? watch.slice() :
    Array.from({ length: wN }, (_, i) => watch[(wOff + i) % watch.length]);
  const chunks = [{ s: [], p: [] }, { s: [], p: [] }, { s: [], p: [] }];
  searches.forEach((q, i) => chunks[i % 3].s.push(q));
  profiles.forEach((u, i) => chunks[i % 3].p.push(u));
  const rs = await Promise.allSettled(chunks.filter(c => c.s.length || c.p.length)
    .map(c => runTh({ searches: c.s, profiles: c.p }, 150000)));
  if (rs.every(r => r.status === 'rejected')) throw rs[0].reason;
  const { batch, errs } = thCollect(rs);
  histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
  const posts = [...tHist.values()].sort((a, b) => histTs(b) - histTs(a));
  return { ok: rs.some(r => r.status === 'fulfilled' && (r.value.posts?.length > 0 || !r.value.errs?.length)), posts, errs, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
}, v => (v.posts || []).length > 0);
/* ---------- Threads lazy: topik on-demand (sebelumnya nggak ada, makanya chip kosong) ---------- */
const thqLazy = q => memo('thq:' + String(q).toLowerCase(), 600000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan');
  const tp = topicOf(q), extra = tp ? ADHOC : ADHOC.concat(SOC.socAdhoc([q]));
  const r = await Promise.allSettled([runTh(tp ? tp.th : [String(q)], 90000)]);
  if (r[0].status === 'rejected') throw r[0].reason;
  const { batch } = thCollect(r, extra);
  histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
  return [...tHist.values()].sort((a, b) => histTs(b) - histTs(a));
});

let socialSnapshotAt = 0;
function socialResponse(result, map, keep) {
  histRetag(map, keep);
  socialSnapshotAt = Math.max(Date.now(), socialSnapshotAt + 1);
  return { ...result, ...HISTORY.snapshot(map, Date.now()), ...socMeta(),
    ok: result.ok === true, snapshotAt: socialSnapshotAt, partial: !!result.partial };
}

/* ---------- THREAD: post + balasan (X via search conversation, Threads via worker) ---------- */
function tweetId(u) {
  const m = String(u).match(/(?:status|statuses)\/(\d{5,25})/);
  return m ? m[1] : '';
}
async function synTweet(id) {
  const r = await get('https://cdn.syndication.twimg.com/tweet-result?id=' + id + '&lang=id&token=' + Math.random().toString(36).slice(2), {}, 12000);
  if (!r.ok) throw new Error('syndication HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.id_str) throw new Error('tweet tidak ditemukan');
  const u = j.user || {};
  const photos = (j.photos || []).map(p => ({ type: 'image', url: p.url }));
  const vid = j.video && j.video.poster ? [{ type: 'image', url: j.video.poster }] : [];
  return {
    id: j.id_str,
    handle: u.screen_name ? '@' + u.screen_name : '',
    name: u.name || u.screen_name || '',
    avatar: String(u.profile_image_url_https || '').replace(/_normal(\.\w+)$/, '_bigger$1'),
    text: j.text || '',
    ts: Date.parse(j.created_at) || 0,
    url: u.screen_name ? `https://x.com/${u.screen_name}/status/${j.id_str}` : '',
    replies: j.conversation_count || 0,
    reposts: j.retweet_count || 0,
    likes: j.favorite_count || 0,
    views: 0,
    verified: !!u.verified,
    media: photos.concat(vid)
  };
}
function xTree(rootId, flat) {
  const by = new Map(), roots = [];
  for (const p of flat) by.set(p.id, { ...p, kids: [] });
  for (const p of by.values()) {
    if (p.id === rootId) continue;
    const par = by.get(p.parent);
    if (par && par.id !== rootId) par.kids.push(p);
    else roots.push(p);
  }
  const sort = a => { a.sort((x, y) => (x.ts || 0) - (y.ts || 0)); a.forEach(x => sort(x.kids)); };
  sort(roots);
  let n = 0;
  const trim = a => a.filter(x => { if (n++ > 80) return false; x.kids = trim(x.kids); return true; });
  return trim(roots);
}
const xThread = (id) => memo('xth:' + id, 300000, async () => {
  let post = null, err = '';
  try { post = await synTweet(id); } catch (e) { err = e.message; }
  let flat = [], cursor = '', pages = 0;
  try {   // conversation_id: paginate sampai 3 halaman / 60 post, jendela 7 hari
    for (;;) {
      const r = await xSearch('conversation_id:' + id, cursor, 0);   // tanpa since_time: rawQuery stabil antar-halaman + balasan tua ikut
      flat.push(...r.posts); cursor = r.cursor; pages++;
      if (!cursor || pages >= 3 || flat.length >= 60) break;
    }
  } catch (e) { err = err || e.message; }
  if (!post && !flat.length) throw new Error(err || 'post tidak ditemukan');
  if (!post && flat.length) {
    const f = flat.find(p => p.id === id) || flat[0];
    post = { ...f, replies: f.replies || flat.length };
  }
  const seenId = new Set(); flat = flat.filter(p => p.id && !seenId.has(p.id) && seenId.add(p.id));
  // Nested replies point at parents the search page did not return. Pull those
  // few parents so the tree can actually nest instead of flattening everything.
  const known = new Set(flat.map(p => p.id));
  const missing = [...new Set(flat.map(p => p.parent).filter(pid => pid && pid !== id && !known.has(pid)))].slice(0, 12);
  if (missing.length) {
    const got = await Promise.allSettled(missing.map(pid => synTweet(pid)));
    for (const r of got) if (r.status === 'fulfilled' && r.value) flat.push({ ...r.value, parent: id });
  }
  const replies = xTree(id, flat.filter(p => p.id !== id));
  return { ok: true, kind: 'x', post, replies, count: (post && post.replies) || flat.length, err };
});
const thThread = (url) => memo('thth:' + url, 300000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan');
  const raw = await new Promise((resolve, reject) => {
    execFile(PY_BIN, [path.join(__dirname, 'vendor', 'threads_thread.py'), JSON.stringify({ url })],
      { timeout: 45000, maxBuffer: 12 << 20 },
      (e, out, err2) => {
        if (e) return reject(new Error(String(err2 || e.message).replace(/\s+/g, ' ').slice(0, 240)));
        try { resolve(JSON.parse(out)); } catch (e2) { reject(new Error('worker bukan JSON valid')); }
      });
  });
  if (!raw.ok) throw new Error(raw.err || 'gagal membaca thread');
  return raw;
});
const threadOf = (raw) => {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
  const id = tweetId(x.href);
  if (id && /(^|\.)(x|twitter)\.com$/i.test(x.hostname)) return xThread(id);
  if (/(^|\.)threads\.(com|net)$/i.test(x.hostname) && /\/post\//.test(x.pathname)) return thThread(x.href);
  throw new Error('bukan tautan post X/Threads');
};

/* ---------- Peta insiden: demo & bencana seluruh Indonesia ---------- */
/* Geocoder: lihat geocode.js (gazetteer 514 kab/kota Kepmendagri 2025, match per-token, presisi jujur) */
const GEO = require('./geocode');
const EVM = require('./evmerge');
const placeOf = t => GEO.locate(t);
// Judul yang menyebut tempat + kata insiden tapi BUKAN kejadian baru di tempat itu: bantuan, reses, apresiasi, program kesehatan umum.
// Dipakai hanya untuk titik peta/statistik wilayah; berita tetap tampil di news wire.
const NOT_EVENT_RE = /\b(reses|apresiasi|penghargaan|salurkan|menyalurkan|penyaluran|bantuan (?:rp|tahap|untuk|bagi|kemanusiaan)|kirim bantuan|donasi|santunan|gagasan|webinar|seminar|rakor|rapat koordinasi|kunjungan kerja|kunker|dipulangkan|pemulangan|ucapan duka|doa bersama|pekarangan|ketahanan pangan|kesejahteraan|proklim|sinkronkan|disinkronkan|inovasi|sosialisasi|edukasi|kesiapsiagaan|mitigasi|pencegahan|simulasi|pelatihan|resmikan|launching|dihadiri|hadiri|tinjau|opini|analisis|kolom|imbau|pemakaman)\b/i;
const HEALTH_EVENT_RE = new RegExp('(?:' + HEALTH_DZ + '|' + HEALTH_EVT + ')', 'i');
const plotOk = (title, cat) => !NOT_EVENT_RE.test(title) && (cat !== 'kesehatan' || HEALTH_EVENT_RE.test(title));
const GEO_WINDOW = 24 * 3600e3;
const incidents = () => memo('incidents', 55000, async () => {
  const srcs = await news(), now = Date.now(), out = [], seen = new Set();
  for (const s of srcs) {
    if (!s.ok) continue;
    for (const it of s.items) {
      const cat = catOf(it.title);
      if (!cat || catMeta(cat).geo === false) continue;
      // pin hanya untuk kejadian berscope Indonesia — catOf sudah membuang
      // finding 'foreign', tapi 'unknown' + tempat lemah (desa/poi) masih bisa
      // lolos (mis. "penembakan di Alun-alun Krakow Polandia" → desa Alun-Alun).
      const sc = assessNews(it.title);
      if (sc.findings.length && sc.findings.every(f => f.scope !== 'Indonesia')) continue;
      const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > GEO_WINDOW) continue;                       // jendela sama dengan /api/situation → angka sinkron
      const k = breakNorm(it.title).slice(0, 56);
      if (!k || seen.has(k)) continue;
      if (!plotOk(it.title, cat)) continue;
      const place = placeOf(it.title);
      if (!place) continue;
      seen.add(k);
      const recency = Math.max(0.16, Math.exp(-age / (20 * 3600e3)));
      const heat = catMeta(cat).sev * recency;
      // judul dengan beberapa tempat sederajat ("banjir di Aceh dan Sumut") → satu titik per tempat, bobot dibagi
      const places = place.all && place.all.length > 1 ? place.all : [place];
      for (const pl of places)
        out.push({ name: pl.name, la: pl.la, lo: pl.lo, prec: pl.prec, prov: pl.prov, kind: cat,
          label: catMeta(cat).label, title: it.title, multi: places.length > 1 || undefined,
          desc: String(it.desc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) || undefined,
          assessment: assessNews(it.title), src: s.id, url: it.url, ts: it.ts, weight: +(heat / Math.sqrt(places.length)).toFixed(3) });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  /* Event-level merge ada di evmerge.js (unit-tested): peristiwa sama
     (kategori + tempat + token langka / jendela hazard) → satu pin,
     eid stabil lintas refresh lewat rt, rep dipilih dari kualitas laporan. */
  const prevPins = ((((cache.get('incidents') || {}).v) || {}).items) || [];
  const merged = EVM.mergeEvents(out, prevPins, { normPlace: s => GEO.norm(s) });
  merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const items = merged.slice(0, 400);
  for (const p of GEO.NODES) {
    items.push({ name: p.name, la: p.la, lo: p.lo, prov: p.prov, prec: 'kab', kind: 'node', label: 'Node',
      title: 'Node pemantauan · ' + p.name, src: 'NODE', url: '', ts: now, weight: 0.16, fixed: true });
  }
  return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, items, total: merged.length, raw: out.length, places: GEO.NODES.length, at: now };
});

/* ---------- Situasi: agregat kategori + wilayah buat panel dossier ---------- */
const situation = () => memo('situation', 45000, async () => {
  const srcs = await news(), now = Date.now(), items = [], seen = new Set();
  const stats = {}; for (const c of CATS) stats[c.id] = 0;
  const regions = new Map();
  for (const s of srcs) {
    if (!s.ok) continue;
    for (const it of s.items) {
      const cat = catOf(it.title);
      if (!cat) continue;
      const age = it.ts ? now - it.ts : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > GEO_WINDOW) continue;
      const k = breakNorm(it.title).slice(0, 56);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const place = placeOf(it.title);
      const recency = Math.max(0.12, Math.exp(-age / (24 * 3600e3)));
      const meta = catMeta(cat);
      items.push({ title: it.title, url: it.url, src: s.id, ts: it.ts, assessment: assessNews(it.title),
        cat, label: meta.label, place: place ? place.name : '',
        weight: +(meta.sev * recency).toFixed(3) });
      stats[cat]++;
      if (place && meta.geo !== false && plotOk(it.title, cat)) regions.set(place.name, (regions.get(place.name) || 0) + 1);
    }
  }
  items.sort((a, b) => b.weight - a.weight || (b.ts || 0) - (a.ts || 0));
  const regionRows = [...regions.entries()].map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n).slice(0, 20);
  return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, stats, total: items.length, items: items.slice(0, 60), regions: regionRows,
    sources: srcs.map(s => ({ id: s.id, ok: s.ok, n: s.items.length, err: s.err || '' })), at: now };
});

/* ---------- MARKET: tape realtime via TradingView scanner (tanpa key) ----------
   Quotes: scanner.tradingview.com — IDX stock, IHSG (IDX:COMPOSITE), forex.
   Sparkline closes tetap Yahoo per-simbol, lazy via /api/closes. */
const STOCK_BLUE = new Set(['BBCA', 'TLKM', 'GOTO', 'BMRI', 'ASII', 'UNVR', 'KLBF']);
const FOREX_PAIRS = [['USDIDR', 'USD/IDR']];
const FX_NAME = Object.fromEntries(FOREX_PAIRS);
// komoditas: [sym TradingView, label, market scan, sym Yahoo untuk closes]
const COMMODITIES = [
  ['COMEX:GC1!', 'Gold', 'futures', 'GC=F'],
  ['COMEX:SI1!', 'Silver', 'futures', 'SI=F'],
  ['NYMEX:CL1!', 'WTI Oil', 'futures', 'CL=F'],
  ['NYMEX:NG1!', 'Nat Gas', 'futures', 'NG=F'],
  ['COMEX:HG1!', 'Copper', 'futures', 'HG=F'],
  ['COMEX:ALI1!', 'Aluminum', 'futures', 'ALI=F'],
  ['NYMEX:HO1!', 'Heat Oil', 'futures', 'HO=F'],
  ['CBOT:ZR1!', 'Rice', 'futures', 'ZR=F'],
  ['CBOT:ZW1!', 'Wheat', 'futures', 'ZW=F'],
  ['CBOT:ZC1!', 'Corn', 'futures', 'ZC=F'],
  ['CBOT:ZS1!', 'Soybean', 'futures', 'ZS=F'],
  ['CME:DC1!', 'Milk', 'futures', 'DC=F'],
  ['ICEUS:KC1!', 'Coffee', 'futures', 'KC=F'],
  ['ICEUS:SB1!', 'Sugar', 'futures', 'SB=F'],
  ['ICEUS:CC1!', 'Cocoa', 'futures', 'CC=F'],
  ['BINANCE:BTCUSDT', 'Bitcoin', 'crypto', 'BTC-USD']
];
const CMD_YH = Object.fromEntries(COMMODITIES.map(c => [c[0], c[3]]));
const YH_FX = t => t === 'USDIDR' ? 'IDR=X' : t + '=X';   // USDIDR di Yahoo = IDR=X
async function tvScan(market, body) {
  const r = await get(`https://scanner.tradingview.com/${market}/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, 15000);
  if (!r.ok) throw new Error('tv scan ' + r.status);
  const d = await r.json();
  return (d && d.data) || [];
}
const COLS = ['name', 'close', 'change', 'change_abs', 'volume'];
const row = (market, s) => {
  const d = s.d || [];
  return { sym: s.s, ticker: d[0], name: d[0], price: d[1], pct: d[2] || 0,
    chg: d[3] || 0, vol: d[4] || 0, mkt: market };
};
const FXHIST_F = path.join(__dirname, 'fxhist.json');
let fxhist = [];
try { fxhist = JSON.parse(fs.readFileSync(FXHIST_F, 'utf8')); } catch (e) {}
const saveFx = () => { try { fs.writeFileSync(FXHIST_F, JSON.stringify(fxhist.slice(-400))); } catch (e) {} };
async function usdidr() {   // floatrates — fixing USD/IDR harian, lebih fresh dari Yahoo/TV yang stale
  try {
    const r = await get('https://www.floatrates.com/daily/usd.json', {}, 10000);
    if (!r.ok) return null;
    const d = await r.json();
    const it = d && d.idr;
    if (!it || !it.rate) return null;
    const day = it.date ? new Date(it.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    const price = +it.rate;
    const last = fxhist[fxhist.length - 1];
    if (!last || last.d !== day) { fxhist.push({ d: day, v: price }); saveFx(); }
    const prev = fxhist.length > 1 ? fxhist[fxhist.length - 2].v : null;
    const chg = prev ? price - prev : 0;
    if (fxhist.length < 25) backfillFx();
    return { price, chg, pct: prev ? chg / prev * 100 : 0, closes: fxhist.slice(-60).map(h => h.v) };
  } catch (e) { return null; }
}
let fxBackfill = null;
function backfillFx() {   // sekali saja: isi histori ~30 hari dari currency-api per-tanggal
  if (fxBackfill) return fxBackfill;
  fxBackfill = (async () => {
    const days = [];
    for (let i = 29; i >= 1; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    for (let i = 0; i < days.length; i += 4) {
      await Promise.all(days.slice(i, i + 4).map(async day => {
        try {
          const r = await get(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`, {}, 10000);
          if (!r.ok) return;
          const d = await r.json();
          const v = d && d.usd && d.usd.idr;
          if (v != null && !fxhist.some(h => h.d === day)) fxhist.push({ d: day, v: +v });
        } catch (e) {}
      }));
    }
    fxhist = [...new Map(fxhist.map(h => [h.d, h])).values()].sort((a, b) => a.d < b.d ? -1 : 1);
    saveFx();
  })().catch(() => {});
  return fxBackfill;
}
/* indeks global untuk ticker tape — Yahoo chart (meta + closes harian) */
const WORLD_IDX = [
  ['^GSPC', 'S&P 500'], ['^NDX', 'NASDAQ 100'], ['^DJI', 'DOW'], ['^RUT', 'RUSSELL'],
  ['^N225', 'NIKKEI'], ['^KS11', 'KOSPI'], ['^HSI', 'HANG SENG'], ['^TWII', 'TAIEX'],
  ['^GDAXI', 'DAX'], ['^FTSE', 'FTSE 100'], ['^FCHI', 'CAC 40'], ['^SSMI', 'SMI'],
  ['^AXJO', 'ASX 200'], ['^BSESN', 'SENSEX'], ['^NSEI', 'NIFTY'], ['^STI', 'STI'],
  ['000001.SS', 'SSE'], ['^BVSP', 'IBOVESPA']
];
async function yahooIndex(sym) {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await get(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo`, {}, 9000);
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      const meta = res && res.meta;
      const price = meta && meta.regularMarketPrice;
      if (!isFinite(price)) continue;
      const qq = res.indicators && res.indicators.quote && res.indicators.quote[0];
      const closes = ((qq && qq.close) || []).filter(Number.isFinite).slice(-40);
      const prev = closes.length > 1 ? closes[closes.length - 2] : (meta.previousClose || meta.chartPreviousClose || null);
      return { price, prev, pct: prev ? (price - prev) / prev * 100 : 0, chg: prev ? price - prev : 0, closes };
    } catch (e) { /* host berikutnya */ }
  }
  return null;
}
const worldIndex = () => memo('worldidx', 60000, async () => {
  const out = [];
  for (let i = 0; i < WORLD_IDX.length; i += 5) {
    await Promise.all(WORLD_IDX.slice(i, i + 5).map(async ([sym, name]) => {
      const q = await yahooIndex(sym);
      if (q) out.push({ sym, ticker: name, name, ...q });
    }));
  }
  return out;
});
const market = () => memo('market', 45000, async () => {
  const cmdTick = m => COMMODITIES.filter(c => c[2] === m).map(c => c[0]);
  const [idx, fx, cmdF, cmdC, ihsgR, idrQ, world] = await Promise.all([
    tvScan('indonesia', { columns: COLS, range: [0, 900],
      symbols: { query: { types: ['stock'] }, tickers: [] } }),
    tvScan('forex', { columns: COLS.slice(0, 4),
      symbols: { query: { types: [] }, tickers: FOREX_PAIRS.map(p => 'FX_IDC:' + p[0]) } }),
    tvScan('futures', { columns: COLS.slice(0, 4),
      symbols: { query: { types: [] }, tickers: cmdTick('futures') } }),
    tvScan('crypto', { columns: COLS.slice(0, 4),
      symbols: { query: { types: [] }, tickers: cmdTick('crypto') } }),
    tvScan('indonesia', { columns: COLS,
      symbols: { query: { types: [] }, tickers: ['IDX:COMPOSITE'] } }),
    usdidr(),
    worldIndex().catch(() => [])
  ]);
  const stocks = idx.map(s => {
    const it = row('IDX', s);
    it.blue = STOCK_BLUE.has(it.ticker);
    return it;
  }).filter(x => isFinite(x.price) && x.price > 0);
  if (!stocks.length) throw new Error('market kosong');
  const ihsg = ihsgR.length ? { ...row('IDX', ihsgR[0]), name: 'IHSG', ticker: 'IHSG' } : null;
  const forex = fx.map(s => {
    const it = row('FX', s);
    it.name = FX_NAME[it.ticker] || it.ticker;
    return it;
  }).filter(x => isFinite(x.price));
  const cmdRows = [...cmdF, ...cmdC];
  for (const [sym, name] of COMMODITIES) {
    const s = cmdRows.find(x => x.s === sym);
    if (!s) continue;
    const it = row('CMD', s);
    it.name = name;
    if (isFinite(it.price)) forex.push(it);
  }
  const idr = forex.find(x => x.ticker === 'USDIDR');
  if (idr && idrQ) Object.assign(idr, { price: idrQ.price, chg: idrQ.chg, pct: idrQ.pct, closes: idrQ.closes });   // feed TV USDIDR stale — pakai floatrates + history harian
  return { ok: true, ihsg, stocks: { ok: true, items: stocks }, forex: { ok: true, items: forex }, world, at: Date.now() };
});
/* sparkline closes — lazy per simbol, Yahoo batching kecil, memo per key */
const closeMemo = new Map();
async function yahooCloses(sym, q = 'interval=1m&range=1d') {
  const key = sym + '|' + q;
  const hit = closeMemo.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.closes;
  let closes = [];
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await get(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?${q}`, {}, 9000);
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      const qq = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      closes = ((qq && qq.close) || []).filter(Number.isFinite).slice(-90);
      if (closes.length) break;
    } catch (e) { /* host berikutnya */ }
  }
  closeMemo.set(key, { at: Date.now(), closes });
  if (closeMemo.size > 400) closeMemo.delete(closeMemo.keys().next().value);
  return closes;
}
async function closes(list) {
  const out = {};
  const keys = [...new Set((list || []).filter(Boolean))].slice(0, 60);
  for (let i = 0; i < keys.length; i += 4) {
    await Promise.all(keys.slice(i, i + 4).map(async k => {
      let sym = k;
      if (k === 'IDX:COMPOSITE') sym = '^JKSE';
      else if (k.startsWith('IDX:')) sym = k.slice(4) + '.JK';
      else if (k.startsWith('FX_IDC:')) sym = YH_FX(k.slice(7));
      else if (CMD_YH[k]) sym = CMD_YH[k];
      if (!sym) return;
      if (k.startsWith('FX_IDC:')) out[k] = await yahooCloses(sym, 'interval=15m&range=5d');
      else {
        out[k] = await yahooCloses(sym);
        if (!out[k].length) out[k] = await yahooCloses(sym, 'interval=1d&range=1mo');   // saham ilikuid: fallback harian
      }
    }));
  }
  return { ok: true, closes: out };
}

/* ---------- PENERBANGAN: adsb.lol (ADS-B REST, tanpa key) — multi-titik cover Indonesia ---------- */
const FL_PTS = [[3.6, 98.7, 250], [-6.2, 106.8, 250], [-3, 114.6, 250], [-2, 120.5, 250],
  [-8.6, 115.3, 250], [-2.5, 140.7, 250]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let flCache = { at: 0, items: [] };
async function flights() {
  if (flCache.items.length && Date.now() - flCache.at < 20000) return flCache.items;
  const seen = new Map();
  const norm = a => {
    if (a.lat == null || a.lon == null || a.alt_baro == null || a.alt_baro < 0) return;
    const k = a.hex || (a.flight + a.lat + a.lon);
    if (!seen.has(k)) seen.set(k, { cs: (a.flight || '').trim() || a.hex || '?', lat: a.lat, lon: a.lon,
      alt: Math.round(a.alt_baro * 0.3048), gs: a.gs != null ? Math.round(a.gs * 1.852) : null,
      hdg: a.track != null ? Math.round(a.track) : null, type: a.t || a.desc || '' });
  };
  for (const [lat, lon, dist] of FL_PTS) {
    // adsb.fi open data dulu (gratis tanpa key), fallback adsb.lol
    try {
      const r = await get(`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`, {}, 15000);
      if (r.ok) { const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
      else throw new Error('fi ' + r.status);
    } catch (e) {
      try {
        const r = await get(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {}, 15000);
        if (r.ok) { const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
      } catch (e2) {}
    }
    await sleep(1050); // rate limit adsb.fi 1 req/s
  }
  flCache = { at: Date.now(), items: [...seen.values()] };
  return flCache.items;
}

/* ---------- BENCANA: BMKG gempa + MAGMA gunung api + Open-Meteo cuaca + RainViewer radar ---------- */
const disCache = { at: 0, data: null };
const VOLCANO_COORDS = {
  'Anak Krakatau':[-6.10,105.42],'Merapi':[-7.54,110.44],'Semeru':[-8.11,112.92],'Ibu':[-1.49,127.63],
  'Dukono':[1.69,127.88],'Sangeang Api':[-8.20,119.07],'Bromo':[-7.94,112.95],'Agung':[-8.34,115.51],
  'Sinabung':[3.17,98.39],'Kerinci':[-1.70,101.26],'Dempo':[-4.02,103.13],'Papandayan':[-7.32,107.73],
  'Guntur':[-7.25,107.85],'Batu Tara':[-7.79,123.58],'Karangetang':[2.78,125.41],'Lokon':[1.37,124.83],
  'Dempo':[-4.02,103.13],'Kelimutu':[-8.77,122.80],'Egon':[-8.68,122.45],'Lewotobi':[-8.54,122.77],
  'Lewotolo':[-8.27,123.50],'Paluweh':[-8.32,121.78],'Ili Lewotolok':[-8.27,123.50],'Sirung':[-8.49,124.13],
  'Namlegung':[-8.07,123.40],'Iya':[-8.89,121.63],'Batur':[-8.24,115.38],'Gamalama':[-8.08,127.32],
  'Dieng':[-7.20,109.90],'Slamet':[-7.24,109.21],'Lawu':[-7.63,111.19],'Merbabu':[-7.45,110.44],
  'Kelud':[-7.93,112.31],'Raung':[-8.13,114.06],'Argopuro':[-7.77,113.58],'Ijen':[-8.06,114.24]
};
function parseMagma(html){
  const marks = [...html.matchAll(/Level\s+(IV|III|II|I)\s*\((Awas|Siaga|Waspada|Normal)\)/g)];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const sec = html.slice(marks[i].index, marks[i+1] ? marks[i+1].index : html.length);
    for (const m of sec.matchAll(/<td>\s*([^<>]+?)\s*-\s*([^<>]+?)\s*<a/g)) {
      const name = m[1].trim();
      out.push({ name, loc: m[2].trim(), level: 'LEVEL ' + marks[i][1], status: marks[i][2],
        lat: VOLCANO_COORDS[name] ? VOLCANO_COORDS[name][0] : null,
        lon: VOLCANO_COORDS[name] ? VOLCANO_COORDS[name][1] : null });
    }
  }
  return out;
}
async function disaster(){
  const now = Date.now();
  if (disCache.data && now - disCache.at < 120000) return disCache.data;
  const [auto, hist, magma] = await Promise.allSettled([
    get('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json', {}, 15000).then(r => r.json()),
    get('https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json', {}, 15000).then(r => r.json()),
    get('https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas', {}, 15000).then(r => r.text())
  ]);
  const gempa = [];
  const push = g => {
    const [lat, lon] = String(g.Coordinates || '').split(',').map(Number);
    if (!isFinite(lat) || !isFinite(lon)) return;
    gempa.push({ mag: parseFloat(g.Magnitude) || 0, lat, lon, depth: g.Kedalaman || '',
      wilayah: g.Wilayah || '', mmi: g.Dirasakan || '', potensi: g.Potensi || '', time: g.DateTime || g.Tanggal || '' });
  };
  if (auto.status === 'fulfilled') { const g = auto.value?.Infogempa?.gempa; if (g) push(g); }
  if (hist.status === 'fulfilled') { const arr = hist.value?.Infogempa?.gempa || []; arr.slice(0, 15).forEach(push); }
  const gunung = magma.status === 'fulfilled' ? parseMagma(magma.value) : [];
  const seen = new Set(), dedup = gempa.filter(g => { const k = g.lat.toFixed(3) + g.lon.toFixed(3) + g.mag; if (seen.has(k)) return false; seen.add(k); return true; });
  disCache.at = now; disCache.data = { ok: true, gempa: dedup, gunung, at: now };
  return disCache.data;
}
const WX_PTS = [[95.3,5.5],[99.5,0.5],[105.8,-6.2],[110.4,-7.5],[114.5,-3],[119.4,-0.5],[117.0,-5.1],[113.6,-7.3],[120.9,0.5],[119.9,-4.5],[123.0,-1.5],[124.8,0.9],[127.4,0.9],[130.8,-1.5],[131.3,-3],[136.1,-4.5],[137.8,-3],[140.5,-3.7],[113.9,0.5],[95.3,3.6]];
const wxCache = { at: 0, data: null };
async function weather(){
  if (wxCache.data && Date.now() - wxCache.at < 600000) return wxCache.data;
  try {
    const lats = WX_PTS.map(p => p[1]).join(','), lons = WX_PTS.map(p => p[0]).join(',');
    const r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,precipitation_probability,pressure_msl,relative_humidity_2m,visibility&timezone=Asia%2FJakarta`, {}, 20000);
    const d = await r.json();
    const list = Array.isArray(d) ? d : [d];
    const items = list.map((w, i) => ({ lat: WX_PTS[i][1], lon: WX_PTS[i][0],
      temp: w.current?.temperature_2m, code: w.current?.weather_code,
      wind: w.current?.wind_speed_10m, wdir: w.current?.wind_direction_10m,
      gust: w.current?.wind_gusts_10m, cloud: w.current?.cloud_cover,
      precip: w.current?.precipitation, precipProb: w.current?.precipitation_probability,
      pressure: w.current?.pressure_msl, humidity: w.current?.relative_humidity_2m,
      visibility: w.current?.visibility }));
    wxCache.at = Date.now(); wxCache.data = { ok: true, items, at: Date.now() };
  } catch(e) { return cacheFail(wxCache, 600000, { ok: false, err: String(e.message||e).slice(0,150), items: [] }); }
  return wxCache.data;
}
const radarCache = { at: 0, data: null };
async function radar(){
  if (radarCache.data && Date.now() - radarCache.at < 300000) return radarCache.data;
  try {
    const r = await get('https://api.rainviewer.com/public/weather-maps.json', {}, 15000);
    const d = await r.json();
    const past = (d.radar && d.radar.past) || [];
    radarCache.at = Date.now();
    radarCache.data = { ok: true, generated: Number(d.generated) || Date.now() / 1000,
      host: String(d.host || 'https://tilecache.rainviewer.com'),
      frames: past.map(f => ({ time: Number(f.time), path: String(f.path || '') })), at: Date.now() };
    return radarCache.data;
  } catch(e) { return { ok: false, err: String(e.message||e).slice(0,150), frames: [] }; }
}

/* ---------- NASA FIRMS hotspot, queried through firms2 ---------- */
const fireCache = { at: 0, data: null };
const FIRE_SOURCES = [
  ['VIIRS_SNPP_NRT', 'VIIRS SNPP', 3],
  ['VIIRS_NOAA20_NRT', 'VIIRS NOAA-20', 3],
  ['VIIRS_NOAA21_NRT', 'VIIRS NOAA-21', 3],
  ['MODIS_NRT', 'MODIS', 2]
];
function csvLine(line){
  // NASA FIRMS CSV ini tidak berisi quoted fields sesuai format contoh.
  return line.split(',').map(v => v.trim());
}
function parseCsv(text){
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const head = csvLine(lines[0]).map(h => h.toLowerCase());
  const idx = name => head.indexOf(name);
  const iLat = idx('latitude'), iLon = idx('longitude'), iDate = idx('acq_date'), iTime = idx('acq_time');
  const iSat = idx('satellite'), iInstr = idx('instrument'), iConf = idx('confidence'), iFrp = idx('frp'), iDay = idx('daynight');
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0) return [];
  return lines.slice(1).map(line => {
    const c = csvLine(line);
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    const hhmm = String(c[iTime] || '0').padStart(4, '0');
    const ts = Date.parse(`${c[iDate]}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00Z`) || 0;
    return {
      lat, lon, time: ts, acqDate: c[iDate], acqTime: hhmm,
      satellite: iSat >= 0 ? c[iSat] : '', instrument: iInstr >= 0 ? c[iInstr] : '',
      confidence: iConf >= 0 ? c[iConf] : '', frp: iFrp >= 0 ? parseFloat(c[iFrp]) || null : null,
      daynight: iDay >= 0 ? c[iDay] : ''
    };
  }).filter(Boolean);
}
async function fires(){
  if (fireCache.data && Date.now() - fireCache.at < 600000) return fireCache.data;
  const key = (process.env.NASA_FIRMS_API_KEY || (CFG.firms && CFG.firms.api_key) || '').trim();
  if (!key) { fireCache.at = Date.now(); fireCache.data = { ok: false, err: 'NASA_FIRMS_API_KEY belum diset', items: [], at: Date.now(), sources: [] }; return fireCache.data; }
  const out = [];
  const sourceStatus = [];
  for (const [id, label] of FIRE_SOURCES) {
    try {
      const r = await get(`https://firms2.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${id}/95,-11,141,6/1`, {}, 20000);
      const text = await r.text();
      if (!r.ok || /Invalid MAP_KEY|provided MAP_KEY/i.test(text)) {
        sourceStatus.push({ id, ok: false, err: 'invalid key or request' }); continue;
      }
      const items = parseCsv(text).map(p => ({ ...p, source: id, sensor: label }));
      sourceStatus.push({ id, ok: true, count: items.length });
      out.push(...items);
    } catch(e) {
      sourceStatus.push({ id, ok: false, err: String(e.message || e).slice(0,100) });
    }
  }
  out.sort((a,b) => b.time - a.time);
  return cacheFail(fireCache, 600000, { ok: sourceStatus.some(s => s.ok), items: out, sources: sourceStatus, at: Date.now() });
}

/* ---------- SIPONGI+ Kemenhut: hotspot karhutla + stasiun kualitas udara ---------- */
const sipongiCache = { at: 0, data: null };
const SIPONGI = 'https://opsroom.sipongidata.my.id';
// Endpoint internal yang dipakai frontend resmi sipongi.gakkum.kehutanan.go.id/peta
const SIPONGI_HOTSPOT_URL = SIPONGI + '/api/opsroom/indoHotspot?wilayah=IN&filterperiode=false&from=&to=&late=24' +
  '&satelit%5B%5D=NASA-MODIS&satelit%5B%5D=NASA-SNPP&satelit%5B%5D=NASA-NOAA20&satelit%5B%5D=NASA-NOAA21' +
  '&satelit%5B%5D=LPN-MODIS&satelit%5B%5D=LPN-NPP&satelit%5B%5D=LPN-NOAA20&satelit%5B%5D=LPN-LANDSAT8' +
  '&confidence%5B%5D=low&confidence%5B%5D=medium&confidence%5B%5D=high&provinsi=&kabkota=';
async function sipongi(){
  if (sipongiCache.data && Date.now() - sipongiCache.at < 600000) return sipongiCache.data;
  try {
    const [hsR, aqR] = await Promise.all([
      get(SIPONGI_HOTSPOT_URL, {}, 45000),
      get(SIPONGI + '/api/aqms', {}, 30000)
    ]);
    if (!hsR.ok && !aqR.ok) throw new Error(`sipongi http ${hsR.status}/${aqR.status}`);
    const hs = hsR.ok ? await hsR.json() : { features: [] };
    const aq = aqR.ok ? await aqR.json() : { features: [] };
    const spots = (hs.features || []).map(f => {
      const c = (f.geometry && f.geometry.coordinates) || [];
      const p = f.properties || {};
      const lon = parseFloat(c[0]), lat = parseFloat(c[1]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return {
        lat, lon, time: Date.parse(p.date_hotspot_ori || p.hs_id || '') || 0,
        sumber: p.sumber || '', confidence: p.confidence_level || '',
        desa: p.desa || '', kecamatan: p.kecamatan || '', kabkota: p.kabkota || '',
        provinsi: p.nama_provinsi || ''
      };
    }).filter(Boolean);
    const air = (aq.features || []).map(f => {
      const c = (f.geometry && f.geometry.coordinates) || [];
      const p = f.properties || {};
      const lon = parseFloat(c[0]), lat = parseFloat(c[1]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat, lon, kota: p.kota || '', provinsi: p.provinsi || '', alamat: p.alamat || '',
        nilai: p.nilai != null ? String(p.nilai) : (p.val != null ? String(p.val) : ''),
        cat: p.cat || '', waktu: p.waktu || '' };
    }).filter(Boolean);
    return cacheFail(sipongiCache, 600000, { ok: spots.length > 0 || air.length > 0, hotspots: spots, air, at: Date.now() });
  } catch(e) {
    return cacheFail(sipongiCache, 600000, { ok: false, err: String(e.message || e).slice(0,150), hotspots: [], air: [], at: Date.now() });
  }
}

const modelRunCache = { at: 0, data: null };
async function bmkgModelRun(){
  if (modelRunCache.data && Date.now() - modelRunCache.at < 300000) return modelRunCache.data;
  try {
    const r = await get('https://satellite.bmkg.go.id/api22/modelrun', {}, 15000);
    const d = await r.json();
    modelRunCache.at = Date.now();
    modelRunCache.data = { ok: true, himawari9: d.himawari9 || [], at: Date.now() };
    return modelRunCache.data;
  } catch(e) { return { ok: false, err: String(e.message || e).slice(0,150), himawari9: [] }; }
}

/* ---------- Satellite product metadata (HEAD only, no content copied) ---------- */
const SAT_PRODUCTS = [
  { id: 'ir', name: 'IR Enhanced', layerType: 'tile', param: 'EH', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_EH_Indonesia.png' },
  { id: 'natural', name: 'Natural Color (siang)', layerType: 'tile', param: 'NC', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_NC_Indonesia.png' },
  { id: 'water', name: 'Water Vapor Enhanced', layerType: 'tile', param: 'WV', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_WE_Indonesia.png' },
  { id: 'rain', name: 'Rainfall Potential', layerType: 'tile', param: 'RP', updateMinutes: 10, dataType: 'derived', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_RP_Indonesia.png' },
  { id: 'geohotspot', name: 'Geohotspot', layerType: 'image', updateMinutes: 10, dataType: 'derived', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/GEOHOTSPOT/H08_GH_Asean.png' },
  { id: 'cth', name: 'Cloud Top Height', layerType: 'image', updateMinutes: 60, dataType: 'derived', source: 'BMKG × JMA', url: 'https://inderaja.bmkg.go.id/IMAGE/HCAI/HTC/HCAI_HTC_Indonesia.png' },
  { id: 'ctype', name: 'Cloud Type', layerType: 'image', updateMinutes: 60, dataType: 'derived', source: 'BMKG × JMA', url: 'https://inderaja.bmkg.go.id/IMAGE/HCAI/CLC/HCAI_CLC_Indonesia.png' }
];
const satelliteCache = { at: 0, data: null };
async function satelliteProducts(){
  if (satelliteCache.data && Date.now() - satelliteCache.at < 600000) return satelliteCache.data;
  const products = await Promise.all(SAT_PRODUCTS.map(async p => {
    try {
      const r = await get(p.url, { method: 'HEAD' }, 15000);
      return { ...p, lastModified: r.headers.get('last-modified') || null, contentLength: Number(r.headers.get('content-length')) || null, status: r.status, error: null };
    } catch(e) {
      return { ...p, lastModified: null, contentLength: null, status: 0, error: String(e.message || e).slice(0,150) };
    }
  }));
  satelliteCache.at = Date.now();
  satelliteCache.data = { ok: products.some(p => p.status === 200), products, attribution: 'BMKG · Himawari-9', at: Date.now() };
  return satelliteCache.data;
}

/* ---------- WIND GRID: Open-Meteo untuk leaflet-velocity (format grib2json) ---------- */
const WIND_LATS_DESC = [6,4,2,0,-2,-4,-6,-8,-10];   // utara → selatan
const WIND_LONS = [95,98,101,104,107,110,113,116,119,122,125,128,131,134,137,140];   // tetap, rapat n cukup buat Indonesia
const WIND_GRID = [];
for (const la of WIND_LATS_DESC) for (const lo of WIND_LONS) WIND_GRID.push([la, lo]);
const windCache = { at: 0, data: null };
async function windGrid(){
  if (windCache.data && Date.now() - windCache.at < 900000) return windCache.data;
  try {
    const lats = WIND_GRID.map(p => p[0]).join(','), lons = WIND_GRID.map(p => p[1]).join(',');
    const r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m&timezone=Asia%2FJakarta`, {}, 30000);
    const d = await r.json();
    const list = Array.isArray(d) ? d : [d];
    // map key "lat,lon" → current
    const cur = new Map();
    list.forEach((w, i) => cur.set(WIND_GRID[i][0] + ',' + WIND_GRID[i][1], w.current || {}));
    const uData = [], vData = [];
    for (const la of WIND_LATS_DESC) {
      for (const lo of WIND_LONS) {
        const w = cur.get(la + ',' + lo) || {};
        const speed = (w.wind_speed_10m || 0) / 3.6;   // m/s
        const dir = (w.wind_direction_10m || 0) * Math.PI / 180;   // meteorological, from-direction
        uData.push(-speed * Math.sin(dir));
        vData.push(-speed * Math.cos(dir));
      }
    }
    const refTime = Date.now();
    const mkHeader = n => ({
      lo1: WIND_LONS[0], la1: WIND_LATS_DESC[0], dx: 3, dy: 2,
      nx: WIND_LONS.length, ny: WIND_LATS_DESC.length,
      refTime, forecastTime: 0, parameterCategory: 2, parameterNumber: n,
      parameterName: n === 2 ? 'u-component_of_wind' : 'v-component_of_wind'
    });
    windCache.at = Date.now();
    windCache.data = { ok: true, data: [
      { header: mkHeader(2), data: uData },
      { header: mkHeader(3), data: vData }
    ], at: Date.now() };
  } catch(e) { return cacheFail(windCache, 900000, { ok: false, err: String(e.message||e).slice(0,150), data: null }); }
  return windCache.data;
}

/* ---------- BMKG PERINGATAN DINI CUACA (CAP) ---------- */
const alertCache = { at: 0, data: null };
function parseCapField(xml, tag){
  const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
}
function parsePolygon(text){
  // "lat,lon lat,lon ..." or "lat lon lat lon"
  const pts = [];
  const tokens = text.trim().split(/\s+/);
  for (const t of tokens) {
    const parts = t.split(',');
    if (parts.length === 2) {
      const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
      if (isFinite(a) && isFinite(b)) pts.push([a, b]);
    }
  }
  // If tokens are "lat lon" pairs split by space in groups of 2
  if (pts.length === 0) {
    const nums = text.trim().split(/[\s,]+/).map(Number).filter(isFinite);
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i+1]]);
  }
  return pts;
}
async function alerts(){
  if (alertCache.data && Date.now() - alertCache.at < 300000) return alertCache.data;
  const out = [];
  try {
    const r = await get('https://www.bmkg.go.id/alerts/nowcast/id', {}, 20000);
    const xml = await r.text();
    // parse RSS items
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
    const details = [];
    for (const it of items) {
      const title = parseCapField(it, 'title');
      const link = parseCapField(it, 'link');
      const desc = parseCapField(it, 'description');
      const pubDate = parseCapField(it, 'pubDate');
      details.push({ title, link, desc, pubDate });
    }
    // fetch detail CAP for each (limit concurrency)
    const conc = 4;
    for (let i = 0; i < details.length; i += conc) {
      const batch = details.slice(i, i + conc);
      const res = await Promise.all(batch.map(async d => {
        if (!d.link) return null;
        try {
          const rr = await get(d.link, {}, 15000);
          const cx = await rr.text();
          const event = parseCapField(cx, 'event') || parseCapField(cx, 'headline') || d.title;
          const headline = parseCapField(cx, 'headline') || d.title;
          const description = parseCapField(cx, 'description') || d.desc;
          const effective = parseCapField(cx, 'effective');
          const expires = parseCapField(cx, 'expires');
          const severity = parseCapField(cx, 'severity');
          const urgency = parseCapField(cx, 'urgency');
          const certainty = parseCapField(cx, 'certainty');
          const web = parseCapField(cx, 'web');
          // area polygon: <area><polygon>...</polygon></area> or <polygon>
          let polyText = '';
          const areaMatch = cx.match(/<polygon[^>]*>([\s\S]*?)<\/polygon>/i);
          if (areaMatch) polyText = areaMatch[1];
          else {
            const am = cx.match(/<area>([\s\S]*?)<\/area>/i);
            if (am) {
              const pm = am[1].match(/<polygon[^>]*>([\s\S]*?)<\/polygon>/i);
              if (pm) polyText = pm[1];
            }
          }
          const polygon = parsePolygon(polyText);
          return { event, headline, description, effective, expires, severity, urgency, certainty, web, polygon };
        } catch(e) { return null; }
      }));
      for (const r of res) if (r) out.push(r);
    }
    alertCache.at = Date.now();
    alertCache.data = { ok: true, items: out, at: Date.now() };
  } catch(e) {
    return cacheFail(alertCache, 300000, { ok: false, err: String(e.message||e).slice(0,150), items: [] });
  }
  return alertCache.data;
}

/* ---------- KAPAL: AISStream.io websocket publik (tanpa key, bbox Indonesia) ---------- */
const shipMap = new Map();
let wsSock = null, wsBuf = Buffer.alloc(0), wsRetry = 0;
function wsSend(text){
  if (!wsSock || wsSock.destroyed) return;
  const p = Buffer.from(text), mask = require('crypto').randomBytes(4);
  let h;
  if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0]=0x81; h[1]=0x80|126; h.writeUInt16BE(p.length,2); }
  else { h = Buffer.alloc(10); h[0]=0x81; h[1]=0x80|127; h.writeBigUInt64BE(BigInt(p.length),2); }
  const masked = Buffer.from(p); for (let i=0;i<masked.length;i++) masked[i] ^= mask[i&3];
  try { wsSock.write(Buffer.concat([h, mask, masked])); } catch(e){}
}
function wsFrames(){
  for(;;){
    if (wsBuf.length < 2) return;
    const op = wsBuf[0] & 0x0f, len0 = wsBuf[1] & 0x7f; let off = 2, len = len0;
    if (len0 === 126){ if (wsBuf.length < 4) return; len = wsBuf.readUInt16BE(2); off = 4; }
    else if (len0 === 127){ if (wsBuf.length < 10) return; len = Number(wsBuf.readBigUInt64BE(2)); off = 10; }
    if (wsBuf.length < off + len) return;
    const pl = wsBuf.slice(off, off + len); wsBuf = wsBuf.slice(off + len);
    if (op === 9) { // ping -> pong
      const mask = require('crypto').randomBytes(4), pl2 = Buffer.from(pl);
      for (let i=0;i<pl2.length;i++) pl2[i] ^= mask[i&3];
      const h = Buffer.from([0x8a, 0x80 | pl2.length]);
      try { wsSock.write(Buffer.concat([h, mask, pl2])); } catch(e){}
    } else if (op === 8) { try{wsSock.end()}catch(e){} wsSock=null; }
    else if (op === 1 || op === 2) {
      try {
        const d = JSON.parse(pl.toString());
        if (!global._aisLogged) { global._aisLogged = 1; console.log('[ais] msg', d.MessageType, JSON.stringify(d).slice(0,200)); }
        if (d.MessageType === 'PositionReport' && d.Message && d.Message.PositionReport) {
          const p = d.Message.PositionReport, m = d.MetaData || {};
          if (p.Latitude != null && p.Longitude != null)
            shipMap.set(String(p.UserID), { mmsi: p.UserID, name: (m.ShipName||'').trim(),
              dest: (m.Destination||'').trim(), type: m.ShipType||'', lat: p.Latitude, lon: p.Longitude,
              sog: p.Sog != null ? +p.Sog.toFixed(1) : null, hdg: p.TrueHeading>0?p.TrueHeading:(p.Cog!=null?Math.round(p.Cog):null), at: Date.now() });
          if (shipMap.size > 3000) shipMap.delete(shipMap.keys().next().value);
        }
      } catch(e){}
    }
  }
}
function aisConnect(){
  if (wsSock && !wsSock.destroyed) return;
  const key = require('crypto').randomBytes(16).toString('base64');
  const req = require('https').request({ host:'stream.aisstream.io', path:'/v0/stream', method:'GET',
    headers:{ Connection:'Upgrade', Upgrade:'websocket', 'Sec-WebSocket-Key':key, 'Sec-WebSocket-Version':'13', 'User-Agent':UA } });
  req.on('upgrade', (res, socket) => {
    wsSock = socket; wsBuf = Buffer.alloc(0); wsRetry = 0;
    socket.on('data', c => { wsBuf = Buffer.concat([wsBuf, c]); wsFrames(); });
    socket.on('close', () => { wsSock = null; setTimeout(aisConnect, 15000); });
    socket.on('error', () => { wsSock = null; });
    wsSend(JSON.stringify({ APIKey: process.env.AISSTREAM_API_KEY || (CFG.aisstream && CFG.aisstream.api_key) || '',
      BoundingBoxes:[[[-11,95],[6.5,141]]],
      FilterMessageTypes:['PositionReport'], FiltersShipMMSI:[] }));
  });
  req.on('response', (res) => { console.log('[ais] rejected', res.statusCode); req.destroy(); setTimeout(aisConnect, Math.min(120000, 15000 * ++wsRetry)); });
  req.on('error', (e) => { console.log('[ais]', e.message); setTimeout(aisConnect, Math.min(120000, 15000 * ++wsRetry)); });
  req.on('upgrade', () => console.log('[ais] connected'));
  req.end();
}
aisConnect();
async function ships() {
  const cutoff = Date.now() - 10 * 60000;
  return [...shipMap.values()].filter(s => s.at > cutoff)
    .sort((a, b) => (b.sog || 0) - (a.sog || 0)).slice(0, 800);
}

/* ---------- TRANSIT: TransJakarta realtime — guest REST polling (full armada ~3.5k bus) ---------- */
const TJ_API = 'https://tijeapi.transjakarta.co.id';
const TJ_H = { 'Content-Type':'application/json', 'User-Agent':'okhttp/4.12.0',
  'X-App-OS':'android', 'X-App-Version':'2.10.2', 'X-Device-ID':'sitrep-console' };
let tjToken = null, tjTokenAt = 0, busCache = { at:0, items:[] };
async function tjAuth(){
  if (tjToken && Date.now() - tjTokenAt < 20 * 3600e3) return tjToken;
  const r = await get(TJ_API + '/v1/auth/login/guest', { method:'POST', headers: TJ_H, body:'{}' }, 15000);
  const d = await r.json();
  if (!d.token) throw new Error('tj guest login gagal');
  tjToken = d.token; tjTokenAt = Date.now();
  return tjToken;
}
async function transit(){
  if (busCache.items.length && Date.now() - busCache.at < 25000) return busCache.items;
  try {
    const tok = await tjAuth();
    const r = await get(TJ_API + '/v1/bus?latitude=-6.1754&longitude=106.8272&radius=20',
      { headers: { ...TJ_H, Authorization: 'Bearer ' + tok } }, 25000);
    const d = await r.json();
    const arr = Array.isArray(d.data) ? d.data : (d.data && d.data.buses) || [];
    const items = arr.filter(b => b.latitude != null && b.longitude != null).map(b => ({
      id: b.bus_body_no || b.trip_id || '?', route: b.route_code || '', name: b.route_name || b.route_long_name || '',
      dest: b.trip_headsign || b.direction || '', speed: b.speed != null ? b.speed : null,
      bearing: b.bearing != null ? Math.round(b.bearing) : null, lat: b.latitude, lon: b.longitude }));
    if (items.length) busCache = { at: Date.now(), items };
    else busCache.at = Date.now(); // jangan spam retry tiap request
  } catch(e) { busCache.at = Date.now(); }
  return busCache.items;
}
transit();
/* ---------- THUMB: gambar asli dari artikel sumber, bukan og:image Google News ---------- */
const thumbCache = new Map();
const gnCache = new Map();

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)(?::|$)/i;
function publicURL(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    const h = x.hostname.replace(/^\[|\]$/g, '');
    if (PRIVATE_HOST.test(h) || h.endsWith('.local') || h === 'localhost') return null;
    return x;
  } catch (e) { return null; }
}

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    o[m[1].toLowerCase()] = dec(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || '');
  }
  return o;
}

function addCandidate(out, raw, base, kind) {
  if (!raw || /^(data:|javascript:|blob:)/i.test(raw)) return;
  try {
    const x = new URL(raw, base);
    if (!/^https?:$/.test(x.protocol)) return;
    if (/\.(svg|gif)(\?|$)/i.test(x.pathname)) return;
    const fn = x.pathname.split('/').pop() || '';
    if (/(logo|logotype|semangka|favicon|sprite|watermark|placeholder|avatar|icon|default)/i.test(fn)) return;   // aset situs, bukan foto berita
    if (rdJunkUrl(x.href)) return;   // badge app-store, icon sosmed, tracker, foto wartawan, dll
    if (rdSmallHint(x.href)) return;   // thumb/24x24, ?w=100 — terlalu kecil untuk foto berita
    const url = x.href;
    if (!out.some(c => c.url === url)) out.push({ url, kind });
  } catch (e) {}
}

function ldImages(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { for (const n of node) ldImages(n, out); return; }
  if (typeof node === 'string') { out.push(node); return; }
  if (typeof node !== 'object') return;
  if (typeof node.url === 'string') out.push(node.url);
  for (const k of ['image', 'thumbnailUrl', 'thumbnail', 'primaryImageOfPage']) {
    if (node[k]) ldImages(node[k], out);
  }
}

function sourceImages(html, base, bodyHtml) {
  const meta = [], body = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property || a.name || '').toLowerCase();
    if (!a.content) continue;
    if (/^(og:image|og:image:secure_url|og:image:url|twitter:image|twitter:image:src|thumbnailurl)$/.test(k)) {
      addCandidate(meta, a.content, base, 'og');
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel || '').toLowerCase() === 'image_src' && a.href) addCandidate(meta, a.href, base, 'meta');
  }
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.poster) addCandidate(meta, a.poster, base, 'meta');
  }
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const rows = [], stack = [JSON.parse(m[1])];
      while (stack.length) {
        const n = stack.pop();
        if (Array.isArray(n)) { for (const x of n) stack.push(x); continue; }
        if (!n || typeof n !== 'object') continue;
        for (const k of ['@graph', 'mainEntity', 'itemListElement']) if (n[k]) stack.push(n[k]);
        // Person/Organization = foto author & logo publisher, bukan foto berita
        if (!/person|organization/i.test(String(n['@type'] || ''))) ldImages(n.image || n.thumbnailUrl || n.thumbnail, rows);
      }
      for (const u of rows) addCandidate(meta, u, base, 'ld');
    } catch (e) {}
  }
  const scan = bodyHtml || html;
  for (const m of scan.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/logo|icon|avatar|badge|spacer|pixel|blank|sprite|watermark|author|wartawan|penulis|byline|social|app[-_ ]?(store|badge)/i.test((a.class || '') + ' ' + (a.alt || ''))) continue;
    if (a.srcset) {
      const best = a.srcset.split(',').map(s => s.trim().split(/\s+/))
        .sort((x, y) => (parseInt(y[1], 10) || 0) - (parseInt(x[1], 10) || 0))[0];
      if (best) addCandidate(body, best[0], base, 'body');
    }
    for (const k of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
      if (a[k]) addCandidate(body, a[k], base, 'body');
    }
  }
  return { meta, body };
}

function upgradeImage(u) {
  let x;
  try { x = new URL(u); } catch (e) { return u; }
  const h = x.hostname;
  if (/(^|\.)googleusercontent\.com$/i.test(h)) {
    return u.replace(/=s\d+(?:-[^?]*)?$/, '=s0').replace(/=w\d+(?:-h\d+)?(?:-[^?]*)?$/, '=w1600');
  }
  if (/(^|\.)detik\.net\.id$/i.test(h) || /(^|\.)detik\.com$/i.test(h)) {
    const w = parseInt(x.searchParams.get('w') || '0', 10);
    if (!w || w < 1200) x.searchParams.set('w', '1200');
    const q = parseInt(x.searchParams.get('q') || '0', 10);
    if (!q || q < 90) x.searchParams.set('q', '90');
    return x.href;
  }
  if (/(^|\.)antaranews\.com$/i.test(h) && /\/cache\/\d+x\d+\//.test(x.pathname)) {
    return u.replace(/\/cache\/\d+x\d+\//, '/cache/1200x800/');
  }
  if (/(^|\.)tribunnews\.com$/i.test(h) && /\/\d+x\d+\//.test(x.pathname)) {
    return u.replace(/\/\d+x\d+\//, '/1200x675/');
  }
  return u;
}

function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const t = buf.toString('ascii', 12, 16);
    if (t === 'VP8X' && buf.length >= 30) {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    }
    if (t === 'VP8 ' && buf.length >= 30) {
      const i = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
      if (i > 0 && i + 7 <= buf.length) return { w: buf.readUInt16LE(i + 3) & 0x3fff, h: buf.readUInt16LE(i + 5) & 0x3fff };
    }
    if (t === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
  }
  return null;
}

async function probeImage(u, referer) {
  const r = await get(u, { headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', ...(referer ? { referer } : {}) } }, 9000);
  if (!r.ok) return null;
  const ct = r.headers.get('content-type') || '';
  // CDN berita sering kirim application/octet-stream — imageSize() tetap jadi hakim
  // akhir lewat magic bytes, jadi cukup tolak tipe yang jelas bukan gambar
  if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) return null;
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 2.5e6) { try { await reader.cancel(); } catch (e) {} break; }
    chunks.push(Buffer.from(value));
  }
  const dim = imageSize(Buffer.concat(chunks));
  return dim && dim.w > 0 && dim.h > 0 ? { ...dim, bytes: total } : null;
}

function imageScore(c, dim) {
  let s = 0;
  if (dim.w >= 1000) s += 34; else if (dim.w >= 760) s += 26; else if (dim.w >= 600) s += 15; else s -= 35;
  const ar = dim.w / dim.h;
  if (ar >= 1.55) s += 24; else if (ar >= 1.25) s += 14; else if (ar >= 1.0) s += 4; else s -= 16;
  if (c.kind === 'meta' || c.kind === 'og') s += 12;
  if (c.kind === 'og') s += 20;   // og:image = gambar yang sama dengan reader → konsisten
  if (/logo|icon|sprite|avatar|badge|placeholder|blank|pixel|advert|ads?|banner|header|footer|nav|share|whatsapp|facebook|twitter|instagram|youtube/i.test(c.url)) s -= 40;
  if (/foto|photo|image|img|news|berita|upload|media|visual|original/i.test(c.url)) s += 4;
  return s;
}

const GN_PATH = /^\/rss\/articles\/|\/articles\/|\/read\//i;
async function decodeGNews(u) {
  const x = publicURL(u);
  if (!x || !/(^|\.)news\.google\.com$/i.test(x.hostname) || !GN_PATH.test(x.pathname)) return u;
  const hit = gnCache.get(u);
  if (hit && Date.now() - hit.at < 1800000) return hit.url;
  const id = x.pathname.split('/').filter(Boolean).pop();
  if (!id) return u;
  const page = 'https://news.google.com/rss/articles/' + encodeURIComponent(id) + '?hl=id&gl=ID&ceid=ID:id';
  let pr = null, html = '';
  for (let i = 0; i < 2; i++) {
    try {
      pr = await get(page, { headers: { referer: 'https://news.google.com/', 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' } }, 12000);
      if (pr.ok) { html = await pr.text(); break; }
    } catch (e) {}
    if (i === 0) await new Promise(res => setTimeout(res, 800));
  }
  if (!pr || !pr.ok) throw new Error('GN page ' + (pr ? pr.status : 'gagal'));
  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) throw new Error('GN signature tidak ada');
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
  gnCache.set(u, { url, at: Date.now() });
  if (gnCache.size > 200) gnCache.delete(gnCache.keys().next().value);
  return url;
}

// og:image yang sama muncul di banyak artikel berbeda pada satu host = aset situs (logo), bukan foto berita
const ogReuseMap = new Map();   // host -> Map(imgUrl -> Set(articleUrl))
function ogReuse(host, imgUrl, article) {
  imgUrl = rdImgKey(imgUrl);   // normalisasi: ?w=, /300x169/, varian CDN = gambar yang sama
  let m = ogReuseMap.get(host);
  if (!m) { m = new Map(); ogReuseMap.set(host, m); if (ogReuseMap.size > 60) ogReuseMap.delete(ogReuseMap.keys().next().value); }
  let s = m.get(imgUrl);
  if (!s) { s = new Set(); m.set(imgUrl, s); if (m.size > 120) m.delete(m.keys().next().value); }
  const seen = s.size;
  s.add(article);
  return seen;
}

/* core pemilihan gambar dari HTML yang sudah di-fetch — dipakai thumb() dan rdFinish()
   supaya reader tidak fetch artikel dua kali */
async function thumbFromHtml(rawHtml, article) {
  const html = String(rawHtml || '').slice(0, 1800000);
  // body scan dibatasi ke container artikel (rdArticleCandidates[0] = paling presisi)
  // dan dipotong sebelum seksi "berita terkait" — menghilangkan thumbnail related/news lain
  let bodySrc = rdArticleCandidates(html)[0] || html;
  bodySrc = rdStripCardLinks(rdStripJunkContainers(bodySrc), article);   // buang author box/related/widget sebelum scan gambar body
  const relAt = bodySrc.search(/baca juga|berita terkait|artikel terkait|lihat juga|bacaan|recommended|baca selengkapnya/i);
  if (relAt > 1500) bodySrc = bodySrc.slice(0, relAt);
  const { meta, body } = sourceImages(html, article, bodySrc);
  const host = new URL(article).hostname;
  const probe = async (c) => {
    const img = upgradeImage(c.url);
    const dim = await probeImage(img, article).catch(() => null);
    return dim ? { img, w: dim.w, h: dim.h, src: article, score: imageScore(c, dim) } : null;
  };
  const strictOK = p => p && p.w >= 600 && !rdJunkUrl(p.img) && !rdSmallHint(p.img) && !RD_IMG_JUNK.test(p.img.split('?')[0]) && ogReuse(host, p.img, article) < 1;
  const looseOK = p => p && p.w >= 600 && !rdJunkUrl(p.img) && !rdSmallHint(p.img) && !RD_IMG_JUNK.test(p.img.split('?')[0]);
  // hero = urutan prioritas dokumen (ld+json → og → meta), bukan score tertinggi:
  // thumbnail harus konsisten dengan gambar yang sama yang dipakai reader
  const seenU = new Set();
  const dedupe = c => { if (seenU.has(c.url)) return false; seenU.add(c.url); return true; };
  const tiers = [meta.filter(c => c.kind === 'ld'), meta.filter(c => c.kind === 'og'), meta.filter(c => c.kind === 'meta')]
    .map(t => t.filter(dedupe));
  const probeTier = async (tier, ok) => {
    const rs = await Promise.all(tier.slice(0, 4).map(probe));
    for (const p of rs) if (ok(p)) return p;
    return null;
  };
  let best = null;
  for (const tier of tiers) {
    best = await probeTier(tier, strictOK);
    if (best) break;
  }
  if (!best) {
    const bs = await Promise.all(body.filter(c => !seenU.has(c.url)).slice(0, 8).map(probe));
    best = bs.filter(Boolean).sort((a, b) => b.score - a.score).find(strictOK) || null;
  }
  if (!best) {
    // longgar: ogReuse menolak gambar yang sama di banyak artikel — tapi gambar
    // artikel yang kebetulan dipakai ulang tetap lebih baik daripada tanpa gambar
    for (const tier of tiers) {
      best = await probeTier(tier, looseOK);
      if (best) break;
    }
  }
  const v = best ? { img: best.img, w: best.w, h: best.h, src: article } : { img: '', src: article };
  return v;
}

async function thumb(u) {
  const x = publicURL(u);
  if (!x) throw new Error('url tidak valid');
  const hit = thumbCache.get(u);
  if (hit && Date.now() - hit.at < (hit.v.img ? 600000 : 60000)) return hit.v;
  let article = u;
  if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) {
    article = await decodeGNews(u);
    if (article === u) throw new Error('gagal resolve google news');
  }
  let r = null, lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      r = await get(article, { headers: article !== u ? { referer: 'https://news.google.com/' } : {} }, 12000);
      if (r.ok) break;
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    if (i === 0) await new Promise(res => setTimeout(res, 700));
  }
  if (!r || !r.ok) {
    // 403/timeout langsung → coba proxy publik (sama seperti feed berita)
    for (const px of RD_PROXIES.slice(0, 2)) {
      try {
        const pr = await get(px(article), {}, 12000);
        if (pr.ok) { r = pr; break; }
      } catch (e) {}
    }
  }
  if (!r || !r.ok) throw lastErr || new Error('fetch gagal');
  let html = await r.text();
  // HTTP 200 tapi isinya halaman challenge/JS-shell (mediaindonesia dll):
  // tidak ada meta og sama sekali → coba proxy publik untuk HTML asli
  if (html.length < 15000 && !/<meta[^>]+(?:property|name)=["']og:/i.test(html)) {
    for (const px of RD_PROXIES.slice(0, 2)) {
      try {
        const pr = await get(px(article), {}, 12000);
        if (!pr.ok) continue;
        const t = await pr.text();
        if (t.length > html.length) { html = t; break; }
      } catch (e) {}
    }
  }
  const v = await thumbFromHtml(html, article);
  thumbCache.set(u, { v, at: Date.now() });
  if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value);
  return v;
}

/* ---------- IMG: proxy avatar CDN (Instagram kirim CORP same-origin, hotlink diblokir browser) ---------- */
const IMG_HOSTS = ['fbcdn.net', 'cdninstagram.com', 'unavatar.io', 'googleusercontent.com', 'ggpht.com'];
const imgOK = u => { try { const h = new URL(u); return h.protocol === 'https:' && IMG_HOSTS.some(d => h.hostname === d || h.hostname.endsWith('.' + d)); } catch (e) { return false; } };
async function img(u, res) {
  if (!u || !imgOK(u)) { res.writeHead(403); return res.end('host tidak diizinkan'); }
  const r = await get(u, {}, 12000);
  if (!r.ok) { res.writeHead(r.status); return res.end(); }
  const ct = r.headers.get('content-type') || '';
  if (!/^image\//i.test(ct)) { res.writeHead(415); return res.end('bukan gambar'); }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > (2 << 20)) { res.writeHead(413); return res.end('terlalu besar'); }
  res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
  res.end(buf);
}

/* ---------- CCTV: proxy HLS (CORS/hotlink/mixed-content aman) + cek hidup ---------- */
const hostOK = u => { try { const h = new URL(u).hostname; return (CFG.cctv_hosts || ['balitower.co.id', 'jakarta.go.id']).concat(CFG.tv_hosts || []).some(d => h === d || h.endsWith('.' + d)); } catch (e) { return false; } };
const isTvHost = u => { try { const h = new URL(u).hostname; return (CFG.tv_hosts || []).some(d => h === d || h.endsWith('.' + d)); } catch (e) { return false; } };
const px = u => '/hls?u=' + encodeURIComponent(u);
async function hls(u, res) {
  if (!hostOK(u)) { res.writeHead(403); return res.end('host tidak diizinkan'); }
  // TV: tanpa referer. Detik/CNN menolak referer localhost (403) tapi menerima permintaan kosong.
  const hdrs = isTvHost(u) ? {} : { referer: 'https://smartcity.jakarta.go.id/', origin: 'https://smartcity.jakarta.go.id' };
  const r = await get(u, { headers: hdrs }, 12000);
  const ct = r.headers.get('content-type') || '';
  const base = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (!r.ok) { res.writeHead(r.status, base); return res.end(); }
  if (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/.test(u)) {
    const txt = (await r.text()).split('\n').map(l => {
      const t = l.trim(); if (!t) return l;
      if (t[0] === '#') return t.replace(/URI="([^"]+)"/g, (m, p) => 'URI="' + px(new URL(p, u).href) + '"');
      return px(new URL(t, u).href);
    }).join('\n');
    res.writeHead(200, { ...base, 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(txt);
  }
  res.writeHead(200, { ...base, 'content-type': ct || 'video/mp2t' }); res.end(Buffer.from(await r.arrayBuffer()));
}
// proxy video untuk instant reader: CDN berita (vod.detik dll) menolak Referer localhost → 403.
// Server fetch tanpa referer; playlist m3u8 ditulis ulang rekursif lewat endpoint yang sama.
const vhsPx = u => '/vhs?u=' + encodeURIComponent(u);
async function vhs(u, res) {
  let href;
  try { href = new URL(u).href; if (!/^https?:$/.test(new URL(href).protocol)) throw 0; } catch (e) { res.writeHead(400); return res.end('url tidak valid'); }
  const r = await get(href, { headers: {} }, 15000);
  const ct = r.headers.get('content-type') || '';
  const base = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (!r.ok) { res.writeHead(r.status, base); return res.end(); }
  if (/mpegurl/i.test(ct) || /\.m3u8(\?|#|$)/.test(href)) {
    const txt = (await r.text()).split('\n').map(l => {
      const t = l.trim(); if (!t) return l;
      if (t[0] === '#') return t.replace(/URI="([^"]+)"/g, (m, p) => 'URI="' + vhsPx(new URL(p, href).href) + '"');
      return vhsPx(new URL(t, href).href);
    }).join('\n');
    res.writeHead(200, { ...base, 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(txt);
  }
  res.writeHead(200, { ...base, 'content-type': ct || 'video/mp4' }); res.end(Buffer.from(await r.arrayBuffer()));
}
const camList = () => { try { return JSON.parse(fs.readFileSync(HTML, 'utf8').match(/id="cam-data">([\s\S]*?)<\/script>/)[1]); } catch (e) { return []; } };
const alive = () => memo('alive', 150000, async () => {
  const cams = camList(), res = new Array(cams.length).fill(false); let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => { while (i < cams.length) { const k = i++;
    if (/jakcctv\.jakarta\.go\.id/i.test(cams[k].s)) { res[k] = true; continue; }   // geo-block DC IP — client playback direct
    try { const r = await get(cams[k].s, { headers: { referer: 'https://smartcity.jakarta.go.id/' } }, 6000);
      res[k] = r.ok && (await r.text()).includes('#EXTM3U'); } catch (e) {} } }));
  return { alive: res, at: Date.now() };
});

/* ---------- CCTV multi-source catalog: tol BPJT + pemda (non-Jakarta) ---------- */
const BPJT_OP = { jm:'Jasa Marga', hk:'Hutama Karya', wtr:'Waskita', tbs:'Trans Bumi Serbaraja',
  pptr:'Pembangunan Perumahan', ppsd:'PP Superblok', smr:'SMR', mbmr:'MBM', cct:'Citra Catur',
  ctp:'Cipta Trans', mun:'Murni Sago', lms:'Lamsida', csj:'Citra Loka', mms:'Marga Mandalasakti',
  hmw:'HM Wijaya', wsp:'Wika Sidoarjo', btb:'Bintaro', tjt:'TJT', kkdm:'KKDM', jtd:'JTD',
  jlb:'Jelajah Bahari', wst:'Wika Sumbertama', mhi:'MH Indonesia', pbtr:'PB', man:'Mandala',
  ckjt:'CKJT', cmlj:'Cikarang-Madura', mlj:'Madura', tlkj:'Tanjung Priok', cw:'Citra Wijaya',
  cmnp:'Citra Marga', cms:'Citra Marga Sentosa', mtn:'Matanusa',
  'pt bintaro serpong damai':'Bintaro' };
/* klasifikasi kota terdekat (kira2, equirectangular) lalu fallback provinsi by bbox */
const ID_CITIES = [
  ['Jakarta',-6.21,106.85],['Tangerang',-6.18,106.63],['Bekasi',-6.24,106.99],['Depok',-6.4,106.82],
  ['Bogor',-6.6,106.8],['Bandung',-6.92,107.61],['Cilegon',-5.98,106.0],['Serang',-6.11,106.15],
  ['Yogyakarta',-7.8,110.36],['Surakarta',-7.57,110.82],['Semarang',-6.97,110.42],['Magelang',-7.48,110.4],
  ['Surabaya',-7.25,112.75],['Malang',-7.98,112.63],['Batu',-7.86,112.52],['Kediri',-7.8,112.02],
  ['Madiun',-7.63,111.52],['Jember',-8.18,113.71],['Banyuwangi',-8.22,114.37],
  ['Medan',3.6,98.67],['Binjai',3.6,98.49],['Padang',-0.95,100.42],['Padang Sidempuan',1.28,99.06],
  ['Pekanbaru',0.51,101.45],['Jambi',-1.61,103.61],['Palembang',-2.99,104.76],['Bengkulu',-3.79,102.26],
  ['Bandar Lampung',-5.45,105.27],['Prabumulih',-3.3,103.2],['Tanjung Balai',-3.02,99.85],
  ['Batam',1.16,104.05],['Tanjung Pinang',0.93,104.45],['Palangkaraya',-2.2,113.92],['Banjarmasin',-3.32,114.59],
  ['Samarinda',-0.5,117.15],['Balikpapan',-1.24,116.83],['Bontang',1.04,116.85],['Tarakan',3.3,117.59],
  ['Pontianak',-0.03,109.32],['Singkawang',0.92,108.98],['Sambas',1.35,109.27],
  ['Denpasar',-8.65,115.21],['Mataram',-8.58,116.12],['Kupang',-10.16,123.6],['Ende',-8.84,121.66],
  ['Makassar',-5.15,119.42],['Parepare',-4.02,119.87],['Palopo',-3.0,120.19],['Manado',1.47,124.85],
  ['Kendari',-3.98,122.51],['Palangga',-5.98,122.75],['Mamuju',-2.68,118.9],['Ternate',0.79,127.38],
  ['Ambon',-3.7,128.18],['Jayapura',-2.53,140.72],['Merauke',-8.57,140.4],['Sorong',-0.88,131.25],
  ['Lhokseumawe',5.17,97.15],['Sibolga',1.75,98.79],['Tegal',-6.87,109.14],['Purwokerto',-7.42,109.24],
  ['Cilacap',-7.73,109.05],['Pekalongan',-6.89,109.68],['Tegal',-6.87,109.14],['Salatiga',-7.31,110.5],
  ['Pati',-6.75,111.04],['Rembang',-6.7,111.34],['Pacitan',-8.2,111.18],['Ngawi',-7.6,111.47],
  ['Lumajang',-8.14,113.23],['Probolinggo',-7.75,113.21],['Pasuruan',-7.65,112.91],['Sidoarjo',-7.45,112.72],
  ['Gresik',-7.16,112.65],['Mojokerto',-7.47,112.43],['Blitar',-8.1,112.17],['Tulungagung',-8.07,111.9],
  ['Nganjuk',-7.6,111.47],['Magetan',-7.63,111.28],['Ponorogo',-8.05,111.45],['Trenggalek',-8.0,111.43]
];
const ID_PROV = [
  ['Banten', -5.6,-7.3, 105.1,106.7], ['DKI Jakarta', -6.05,-6.4, 106.7,107.1],
  ['Jawa Barat', -6.3,-7.8, 106.5,109.0], ['DI Yogyakarta', -7.6,-8.25, 110.1,110.9],
  ['Jawa Tengah', -6.7,-8.3, 108.9,111.7], ['Jawa Timur', -6.8,-8.8, 111.4,114.5],
  ['Bali', -8.05,-8.85, 114.35,115.95], ['Nusa Tenggara', -8.3,-10.9, 115.9,125.2],
  ['Sumatera Utara', 5.9,0.5, 97.5,100.5], ['Sumatera Barat', -0.3,-3.4, 99.4,102.6],
  ['Riau', 0.5,-2.0, 100.8,104.6], ['Jambi', -1.2,-3.0, 101.6,104.7],
  ['Sumatera Selatan', -2.4,-4.5, 102.5,106.2], ['Bengkulu', -3.0,-4.5, 100.9,103.0],
  ['Lampung', -4.4,-6.0, 103.5,106.1], ['Kepulauan Bangka Belitung', -2.0,-3.2, 104.0,107.0],
  ['Kalimantan Barat', 0.9,-3.4, 108.7,111.4], ['Kalimantan Tengah', -1.5,-3.5, 110.5,114.5],
  ['Kalimantan Selatan', -2.9,-4.2, 114.3,117.4], ['Kalimantan Timur', -0.5,2.5, 114.5,119.5],
  ['Kalimantan Utara', 2.0,4.5, 116.5,120.0], ['Sulawesi Utara', 0.5,2.0, 123.5,127.0],
  ['Sulawesi Tengah', -0.5,1.2, 119.3,122.0], ['Sulawesi Selatan', -2.5,-6.2, 118.5,121.8],
  ['Sulawesi Tenggara', -3.3,-5.6, 121.5,124.5], ['Sulawesi Barat', -0.5,-3.5, 118.8,120.6],
  ['Maluku', -2.5,-4.5, 126.5,131.0], ['Maluku Utara', -0.5,3.0, 127.0,129.5],
  ['Papua', -0.5,-9.0, 130.9,141.0], ['Papua Barat', -0.2,-3.5, 129.0,133.0]
];
function idRegion(la, lo){
  let best = null, bd = 60;   // km — di atas ini tidak yakin kota
  for (const [n, clat, clo] of ID_CITIES) {
    const d = Math.hypot((la - clat) * 111, (lo - clo) * 111 * Math.cos(la * Math.PI / 180));
    if (d < bd) { bd = d; best = n; }
  }
  if (best) return 'Kota ' + best;
  for (const [n, a, b, c2, d2] of ID_PROV)
    if (la >= Math.min(a, b) && la <= Math.max(a, b) && lo >= Math.min(c2, d2) && lo <= Math.max(c2, d2)) return n;
  return 'Lainnya';
}
/* IP datacenter (Railway) diblokir situs pemda/pemerintah — fallback lewat public proxy
   seperti news(). Proxy dipakai hanya kalau direct gagal. */
async function cctvFetch(url, ms, headers){
  const attempts = [url,
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    'https://corsproxy.io/?url=' + encodeURIComponent(url)];
  let lastErr = '';
  for (const u of attempts) {
    try {
      // header hanya untuk attempt direct — proxy publik tidak meneruskan header custom
      const r = await get(u, u === url && headers ? { headers } : {}, ms);
      if (r.ok) return await r.text();
      lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = String(e.message || e); }
  }
  throw new Error(lastErr || 'fetch gagal');
}
/* Firecrawl render — terakhir untuk halaman berat yang diblokir IP datacenter
   (bpjt.pu.go.id). API key sudah dipakai reader; catalog di-memo 30 mnt supaya
   tidak bakar credit tiap refresh. */
async function cctvFirecrawl(url){
  const FC_KEY = process.env.FIRECRAWL_API_KEY || CFG.firecrawl_key || '';
  if (!FC_KEY) return '';
  try {
    const r = await get('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
      body: JSON.stringify({ url, formats: ['html'], onlyMainContent: false, timeout: 30000 })
    }, 40000);
    if (!r.ok) return '';
    const j = await r.json();
    return (j && j.data && j.data.html) || '';
  } catch (e) { return ''; }
}
async function cctvBpjtFetch(){
  // halaman ~1MB dan bisa lambat — timeout longgar, direct dulu baru proxy
  let h = '';
  try { h = await cctvFetch('https://bpjt.pu.go.id/cctv/', 30000); } catch (e) {}
  if (!h || !h.includes('allStreams')) h = await cctvFirecrawl('https://bpjt.pu.go.id/cctv/');
  if (!h || !h.includes('allStreams')) return [];
  const m = h.match(/const allStreams = (\{[\s\S]*?\});\s*\n/);
  if (!m) return [];
  const groups = JSON.parse(m[1]), seen = new Set(), out = [];
  for (const g of Object.values(groups)) for (const c of g) {
    const s = String(c.streamhls || '');
    if (!/m3u8/i.test(s) || seen.has(s)) continue;
    if (!['online', '1'].includes(String(c.status))) continue;
    const la = +c.lat, lo = +c.lon;
    if (!isFinite(la) || !isFinite(lo) || la < -11 || la > 6 || lo < 95 || lo > 141) continue;
    seen.add(s);
    out.push({ n: String(c.nama_km || c.nama_segment || 'CCTV') + ' · ' + String(c.nama_ruas || '').replace(/-/g, ' '),
      s, e: '', la, lo, c: idRegion(la, lo), src: 'bpjt' });
  }
  return out;
}
const cctvBpjt = () => memo('cctv:bpjt', 1800000, cctvBpjtFetch, v => v.length > 0);
async function cctvBekasi(){
  let d = null;
  try { d = JSON.parse(await cctvFetch('https://eofficev2.bekasikota.go.id/backupcctv/m3/list.json', 20000)); } catch (e) {}
  if (!Array.isArray(d)) return [];
  return d.filter(x => x && x.path).map(x => ({
    n: String(x.name || x.path).replace(/_/g, ' '),
    s: 'https://eofficev2.bekasikota.go.id/backupcctv/m3/' + x.path,
    e: '', la: null, lo: null, c: 'Kota Bekasi', src: 'pemda'
  }));
}
/* Pemkot Yogyakarta — 150+ cam publik (17 di sepanjang Malioboro), API JSON
   cctv.jogjakota.go.id/home/getdata, stream HLS Wowza di cctvjss.jogjakota.go.id */
async function cctvJogja(){
  let d = null;
  try { d = JSON.parse(await cctvFetch('https://cctv.jogjakota.go.id/home/getdata', 20000,
    { referer: 'https://cctv.jogjakota.go.id/', 'x-requested-with': 'XMLHttpRequest' })); } catch (e) {}
  if (!Array.isArray(d)) return [];
  return d.filter(x => x && x.cctv_link && /\.m3u8(\?|$)/i.test(x.cctv_link)).map(x => ({
    n: 'CCTV ' + String(x.cctv_title || 'Jogja').replace(/_/g, ' '),
    s: x.cctv_link,
    e: '',
    la: parseFloat(x.cctv_latitude) || null,
    lo: parseFloat(x.cctv_longitude) || null,
    c: 'Kota Yogyakarta', src: 'jogja'
  }));
}
/* probe 3 level: master playlist → variant/media playlist → segmen .ts pertama.
   cam hanya "hidup" kalau segmen beneran ke-load — playlist 200 doang tidak cukup. */
const cctvProbe = { alive: new Set(), done: new Set(), running: false, last: 0 };
const HLS_UA = { 'user-agent': UA, referer: 'https://bpjt.pu.go.id/' };
function hlsLines(t){ return t.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')); }
async function probeHls(url, depth){
  if (depth > 3) return false;
  try {
    const r = await get(url, { headers: HLS_UA }, 7000);
    if (!r.ok) return false;
    const t = await r.text();
    if (!t.includes('#EXTM3U')) return false;
    const lines = hlsLines(t);
    if (!lines.length) return false;
    const first = lines[0];
    if (/\.ts(\?|$)/i.test(first) || first.startsWith('http') && /\.(ts|m4s)(\?|$)/i.test(first)) {
      // ini media playlist — cek segmen pertama bisa di-fetch (Range 4KB, bukan full segmen)
      try {
        const seg = new URL(first, url).href;
        const sr = await get(seg, { headers: { ...HLS_UA, range: 'bytes=0-4096' } }, 8000);
        if (!sr.ok && sr.status !== 206) return false;
        const buf = await sr.arrayBuffer();
        return buf.byteLength > 500;
      } catch (e) { return false; }
    }
    // master playlist → recurse ke variant pertama
    return await probeHls(new URL(first, url).href, depth + 1);
  } catch (e) { return false; }
}
async function warmCctv(){
  if (cctvProbe.running || Date.now() - cctvProbe.last < 1500000) return;
  cctvProbe.running = true; cctvProbe.last = Date.now();
  const next = { alive: new Set(), done: new Set() };
  try {
    let cams = await cctvBpjt().catch(() => []);
    if (!cams.length) { await new Promise(s => setTimeout(s, 30000)); cams = await cctvBpjt().catch(() => []); }   // fetch gagal → retry sekali
    if (!cams.length) { console.log('[cctv] bpjt fetch kosong, skip sweep'); cctvProbe.running = false; return; }
    const jogja = await cctvJogja().catch(() => []);
    cams = cams.concat(jogja);
    let i = 0;
    await Promise.all(Array.from({ length: 24 }, async () => { while (i < cams.length) { const c = cams[i++];
      const ok = await probeHls(c.s, 0);
      next.done.add(c.s);
      if (ok) next.alive.add(c.s);
    } }));
    cctvProbe.alive = next.alive; cctvProbe.done = next.done;
    cache.delete('cctvcat');   // paksa katalog refresh — cam playable langsung muncul
    console.log('[cctv] probe selesai:', next.alive.size, '/', cams.length, 'cam playable');
  } catch (e) {} finally { cctvProbe.running = false; }
}
/* laporan playback real dari client — cam yang gagal di browser langsung turun,
   tidak perlu nunggu sweep probe 25 menit */
const cctvReports = new Map();   // url -> { fails, last }
function camReport(u, ok){
  if (!u || typeof u !== 'string' || u.length > 500) return;
  const r = cctvReports.get(u) || { fails: 0, last: 0 };
  if (ok) { r.fails = 0; } else { r.fails = Math.min(9, r.fails + 1); }
  r.last = Date.now(); cctvReports.set(u, r);
  if (cctvReports.size > 5000) { const cutoff = Date.now() - 3600000;
    for (const [k, v] of cctvReports) if (v.last < cutoff) cctvReports.delete(k); }
}
const cctvReportedDead = s => { const r = cctvReports.get(s);
  return r && r.fails >= 2 && Date.now() - r.last < 1200000; };   // 2x gagal dlm 20 mnt → exclude
const cctvCatalog = () => memo('cctvcat', 300000, async () => {
  const rs = await Promise.allSettled([cctvBpjt(), cctvBekasi(), cctvJogja()]);
  const bpjt = [], jogja = [], other = [];
  for (const r of rs) if (r.status === 'fulfilled') for (const c of r.value)
    (c.src === 'bpjt' ? bpjt : c.src === 'jogja' ? jogja : other).push(c);
  // BPJT + Jogja: hanya yang probe-confirmed playable + tidak dilaporkan mati client.
  // Sebelum probe selesai → kosong (konsisten dengan jalur BPJT).
  const probeable = cctvProbe.done.size ? [...bpjt, ...jogja].filter(c => cctvProbe.alive.has(c.s)) : [];
  const verified = probeable.filter(c => !cctvReportedDead(c.s));
  return { ok: true, cams: [...other.filter(c => !cctvReportedDead(c.s)), ...verified], bpjt_alive: cctvProbe.alive.size, bpjt_total: bpjt.length, probing: cctvProbe.running, at: Date.now() };
});

/* ---------- READ: ekstrak teks halaman buat panel baca (bukan iframe) ---------- */
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

function rdPrivateIP(ip) {
  const s = String(ip).toLowerCase();
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('ff')) return true;
    if (s.startsWith('::ffff:')) return rdPrivateIP(s.slice(7));
    return false;
  }
  const p = s.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
    p[0] >= 224;
}
const rdDnsCache = new Map();   // host -> { addrs, at } — DNS lookup per redirect hop mahal, cache 5 mnt
async function rdAssertPublic(raw) {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
  if (x.username || x.password) throw new Error('URL berkredensial ditolak');
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('host lokal ditolak');
  let ent = rdDnsCache.get(h);
  if (!ent || Date.now() - ent.at > 300000) {
    const addrs = await dns.lookup(h, { all: true, verbatim: true });
    ent = { addrs, at: Date.now() };
    rdDnsCache.set(h, ent);
    if (rdDnsCache.size > 500) rdDnsCache.delete(rdDnsCache.keys().next().value);
  }
  if (!ent.addrs.length) throw new Error('host tidak ditemukan');
  if (ent.addrs.some(a => rdPrivateIP(a.address))) throw new Error('alamat privat ditolak');
  return x;
}
async function rdSafeGet(raw, ms) {
  let cur = raw;
  for (let i = 0; i < 5; i++) {
    await rdAssertPublic(cur);
    const r = await get(cur, { redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } }, ms);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('redirect tanpa lokasi');
      cur = new URL(loc, cur).href;
      continue;
    }
    return { r, url: cur };
  }
  throw new Error('terlalu banyak redirect');
}
function rdMeta(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    const k = t.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i);
    const v = t.match(/content\s*=\s*["']([\s\S]*?)["']/i);
    if (k && v) {
      const val = rdInline(v[1]);
      if (val && !/^(undefined|null|nan|\[object object\])$/i.test(val)) out[k[1].toLowerCase()] = val;
    }
  }
  return out;
}
function rdLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim());
      for (const n of Array.isArray(j) ? j : [j]) {
        if (n && typeof n === 'object') {
          out.push(n);
          if (Array.isArray(n['@graph'])) out.push(...n['@graph']);
        }
      }
    } catch (e) {}
  }
  return out;
}
function rdName(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return rdName(v[0]);
  if (typeof v === 'object') return v.name || v.headline || '';
  return '';
}
const RD_SKIP = /^(baca juga|simak juga|lihat juga|berita terkait|artikel terkait|advertisement|iklan|scroll|lanjutkan|ikuti|bagikan|komentar|rekomendasi|topik|tags?|sumber|foto|video|infografis|follow|newsletter|subscribe|langganan|whatsapp)\b/i;
const RD_CREDIT = /\b(?:foto|istimewa|dok\.?)\s*:/i;
const VID_IFRAME = /(?:youtube\.com\/(?:embed|shorts)\/|youtube-nocookie\.com\/(?:embed|shorts)\/|youtu\.be\/|player\.vimeo\.com\/|facebook\.com\/plugins\/video|\/embed\/|\/player\/|\/video-embed\/)/i;
const VID_FILE = /\.(mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i;
const RD_IMG_JUNK = /logo|icon|sprite|avatar|badge|placeholder|blank|pixel|spacer|advert|\/ads?\/|[-_/.]ads?[-_/.]|banner|emoji|button|share|loading|lazy\.|default[-_]|no[-_]?image|gravatar|thumb(?:nail)?s?\/small/i;
// blacklist URL gambar sampah (audit 12 feed): badge app-store, icon sosmed, tracker/pixel,
// aset UI publisher, thumbnail youtube, foto wartawan — berlaku untuk hero (addCandidate)
// maupun gambar body (pickImg), satu sumber kebenaran
const RD_JUNK_URL = /appstore|playstore|googleplay|gettheapp|framebarasset|asset-template|(?:^|\/)slide[-_]|assets_frontend\/images|\/assets\/(?:img|images)\/(?:ui|icons?|buttons?|social)|share[-_ ]?preview|social[-_ ]?(?:share|card)|og[-_]?(?:default|image)\b|partials\/|widgets-nocache|analytics_page_request|inpicture_widget|wartawan|scorecard|criteo|doubleclick|googlesyndication|adservice|hotjar|facebook\.net|img\.youtube\.com|(^|\/)ic_[a-z0-9]|en-flag|id-flag|thumb_|\/mini\/|\/small\/|\/img\/site\/|foot[-_ ]?network|foto[-_/]bank(?!\/originals)|fotobank/i;
const RD_JUNK_BASE = /^(google|gnews|googlenews|telegram|threads|bluesky|pinterest|line|ig|fb|twitter|x|tiktok|instagram|youtube|wa|whatsapp|linkedin|googleplay|appstore|playstore|en-flag|id-flag)([-_. ]|$)/i;
function rdJunkUrl(u) {
  const path = String(u).split('?')[0];
  if (RD_JUNK_URL.test(path)) return true;
  return RD_JUNK_BASE.test(path.split('/').pop() || '');
}
// container DOM yang isinya bukan konten artikel: reaksi, author box, foto wartawan,
// section related/baca-juga — dibuang sebelum scan gambar maupun paragraf
const RD_BAD_BOX = /reaction|reactions|rating|emoticon|emoji|vote|poll|like-box|dislike|social-share|article-tools|post-tools|share-tools|komentar|comment-box|author[-_ ]?(box|img|image|photo|profile|info|bio)|wartawan|penulis|byline|redaksi|profile[-_ ]?(box|img|image)|related|baca[-_ ]?juga|terkait|recommend|most[-_ ]?read|injected|sidebar|widget|latest[-_ ]?(?:news|post)|popular|trending|terbaru|berita[-_ ]?lain|lainnya|more[-_ ]?(?:news|stor)|also[-_ ]?read|you[-_ ]?may|jnews_|td-related|jeg_(?:block|sidebar)|advert|iklan|banner|ticker|breaking[-_ ]?news|see[-_ ]?also|summary[-_ ]?article|read-page--summary|inbetween|banner_article_slide/i;
function rdStripJunkContainers(s) {
  const re = new RegExp('<(div|span|p|section|ul|ol|table|figure)\\b[^>]*(?:class|id)=["\'][^"\']*(?:' + RD_BAD_BOX.source + ')[^"\']*["\'][^>]*>[\\s\\S]*?<\\/\\1\\s*>|<(div|span|p|section|ul|ol|table|figure)\\b[^>]*(?:class|id)=["\'][^"\']*(?:' + RD_BAD_BOX.source + ')[^"\']*["\'][^>]*\\/>', 'gi');
  let prev, i = 0;
  do { prev = s; s = s.replace(re, ' '); } while (s !== prev && ++i < 3);
  return s;
}
const rdImgKey = u => {
  const p = String(u).split('?')[0].split('#')[0].toLowerCase().replace(/\.\w{2,5}$/, '');
  const base = (p.split('/').pop() || '').replace(/[-_]\d{2,4}x\d{2,4}$/, '').replace(/[-_]169$/, '').replace(/[-_](?:small|medium|large|thumb|thumbnail|original|full)$/, '');
  return base.length >= 8 && /[a-z]/.test(base + 'a') && !/^(?:image|photo|foto|img|picture|default|thumb|cover|poster|index)\d*$/.test(base) ? base : p.replace(/\/(?:thumb|fill|resize|crop|cache)?\/?\d{2,4}(?:x|\/)\d{2,4}\//g, '/');   // nama file cukup unik → abaikan host/CDN/ukuran
};
// petunjuk ukuran dari URL: thumb/24x24, 450x280, /fill/450/280/, ?w=100 → true bila jelas terlalu kecil buat foto berita
function rdSmallHint(u) {
  const x = String(u);
  for (const m of x.split('?')[0].matchAll(/(?:^|[\/_=.-])(\d{2,4})x(\d{2,4})(?=[\/_.-]|$)/g)) if (+m[1] < 400 || +m[2] < 200) return true;
  const f = x.match(/\/(?:fill|fit|resize|crop|w)\/(\d{2,4})\/(\d{2,4})\//i); if (f && (+f[1] < 400 || +f[2] < 200)) return true;
  const q = x.match(/[?&](?:w|width|size)=(\d{2,4})(?=&|$)/i); if (q && +q[1] < 400) return true;
  return false;
}
const rdProbeCache = new Map();
async function rdProbeFull(u, referer) {
  if (rdProbeCache.has(u)) return rdProbeCache.get(u);
  let out = null;
  try {
    const r = await get(u, { headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', ...(referer ? { referer } : {}) } }, 8000);
    if (r.ok && /^image\//i.test(r.headers.get('content-type') || '')) {
      // stream-cap 1.5MB: cukup untuk header dimensi + fingerprint hash.
      // Gambar yang sama via URL/CDN beda berbagi byte awal → dedupe tetap jalan.
      const reader = r.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 1.5e6) { try { await reader.cancel(); } catch (e) {} break; }
        chunks.push(Buffer.from(value));
      }
      const buf = Buffer.concat(chunks);
      const dim = imageSize(buf.subarray(0, 4e6));
      if (dim && dim.w > 0 && dim.h > 0) out = { w: dim.w, h: dim.h, bytes: total, hash: require('crypto').createHash('sha1').update(buf).digest('hex') };
    }
  } catch (e) {}
  rdProbeCache.set(u, out);
  if (rdProbeCache.size > 400) rdProbeCache.delete(rdProbeCache.keys().next().value);
  return out;
}
const rdYtTitleCache = new Map();
async function rdYtTitle(id) {
  if (rdYtTitleCache.has(id)) return rdYtTitleCache.get(id);
  let t = null;
  try { const r = await get('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id), {}, 6000); if (r.ok) { const j = await r.json(); t = String(j.title || '') + ' ' + String(j.author_name || ''); } } catch (e) {}
  rdYtTitleCache.set(id, t); if (rdYtTitleCache.size > 300) rdYtTitleCache.delete(rdYtTitleCache.keys().next().value);
  return t;
}
// playability: false HANYA bila oembed menolak (video dihapus/private) — embed-disabled
// tidak terdeteksi andal tanpa PO token, jadi netral (facade frontend yang menanggung UX-nya)
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
// video harus bersangkutan: file langsung menang atas iframe player situs yang sama; YouTube dicek judulnya vs isi artikel
async function rdVideoGate(d) {
  const tokOf = x => [...new Set(String(x || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !RD_STOP.has(w)))];
  const ctx = ' ' + tokOf([d.title, d.desc, ...(d.paras || []).slice(0, 8)].join(' ')).join(' ') + ' ';
  const vids = [...(d.videos || [])];
  const hasFile = (blocks) => vids.concat((blocks || []).filter(b => b.k === 'v' && b.v).map(b => b.v)).some(v => v && v.kind === 'video');
  const verdict = new Map();
  const all = vids.concat((d.blocks || []).filter(b => b.k === 'v' && b.v).map(b => b.v));
  // video yang posisinya ada di body = bukti kuat milik artikel — judul tidak perlu dicek ulang
  const positioned = new Set((d.blocks || []).filter(b => b.k === 'v' && b.v).map(b => String(b.v.url).split('?')[0]));
  await Promise.all(all.map(async v => {
    if (!v || verdict.has(v.url)) return;
    const yid = rdYT(v.url) && (v.url.match(/embed\/([\w-]{6,15})/) || [])[1];
    if (yid) {
      const play = await rdYtPlayable(yid);
      if (play === false) { verdict.set(v.url, false); return; }              // embed dimatikan/private → iframe pasti error
      if (!positioned.has(String(v.url).split('?')[0])) {
        const t = await rdYtTitle(yid);
        if (t) { const yt = tokOf(t); if (yt.length >= 2 && !yt.some(w => ctx.includes(' ' + w))) { verdict.set(v.url, false); return; } }
      }
    }
    if (v.kind === 'iframe' && !yid && hasFile(d.blocks)) { verdict.set(v.url, false); return; }   // embed player situs + file langsung = video sama dua kali
    verdict.set(v.url, true);
  }));
  const ok = v => !v || verdict.get(v.url) !== false;
  d.videos = (d.videos || []).filter(ok);
  d.blocks = (d.blocks || []).filter(b => b.k !== 'v' || ok(b.v));
  return d;
}
// gerbang terakhir SEMUA media reader: ukuran asli, ikon/avatar, duplikat (konten sama walau URL/CDN beda)
async function rdFinalGate(d, article) {
  const slots = [];   // {get,drop,kind}
  if (d.img) slots.push({ url: d.img, hero: true });
  (d.blocks || []).forEach((b, i) => { if (b.k === 'i' && b.img) slots.push({ url: b.img.url, idx: i }); });
  const res = await Promise.all(slots.slice(0, 10).map(async sl => {
    if (rdSmallHint(sl.url) || rdJunkUrl(sl.url)) return { sl, bad: true };
    const pr = await rdProbeFull(sl.url, article);
    if (!pr) return { sl, bad: !sl.hero };                  // gambar tak bisa dimuat server → buang (hero dibiarkan, browser yang coba)
    const ar = pr.w / pr.h;
    if (pr.w < 400 || pr.h < 200 || pr.bytes < 6000) return { sl, bad: true };
    if (!sl.hero && (ar > 3.2 || ar < 0.4)) return { sl, bad: true };
    return { sl, pr };
  }));
  const seenH = new Set(), seenK = new Set(), dropIdx = new Set();
  let hero = d.img;
  for (const r of res) {                                    // hero lebih dulu (urutan slots)
    const { sl } = r;
    let bad = r.bad;
    if (!bad) {
      const k = rdImgKey(sl.url);
      if ((r.pr && seenH.has(r.pr.hash)) || seenK.has(k)) bad = true;
      else { if (r.pr) seenH.add(r.pr.hash); seenK.add(k); }
    }
    if (bad) { if (sl.hero) hero = ''; else dropIdx.add(sl.idx); }
  }
  d.img = hero || '';
  if (dropIdx.size) d.blocks = d.blocks.filter((b, i) => !dropIdx.has(i));
  // sisa blok gambar di luar 10 teratas: buang (batas keras)
  { let n = 0; d.blocks = (d.blocks || []).filter(b => b.k !== 'i' || ++n <= 8); }
  return d;
}
const rdAbs = (u, base) => { if (!u) return ''; try { u = new URL(u, base).href; } catch (e) { return ''; } return /^https?:/i.test(u) ? u : ''; };
const rdYT = u => { const m = String(u).match(/(?:youtube\.com\/(?:embed|shorts)\/|youtu\.be\/|youtube-nocookie\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{6,15})/i); return m ? 'https://www.youtube.com/embed/' + m[1] : ''; };
function rdVideoEl(tag, finalURL) {
  if (/^<iframe/i.test(tag)) {
    const u = rdAbs((tag.match(/\bsrc=["']([^"']+)/i) || [])[1], finalURL);
    if (!u) return null;
    const yt = rdYT(u);
    if (yt) return { url: yt, kind: 'iframe', poster: '' };
    if (VID_IFRAME.test(u) && !VID_FILE.test(u)) return { url: u, kind: 'iframe', poster: '' };
    return null;
  }
  const src = (tag.match(/\bsrc=["']([^"']+)/i) || [])[1]
    || (tag.match(/<source\b[^>]*\bsrc=["']([^"']+)/i) || [])[1];
  const u = rdAbs(src, finalURL);
  if (!u) return null;
  return { url: u, kind: 'video', poster: rdAbs((tag.match(/\bposter=["']([^"']+)/i) || [])[1], finalURL) };
}
// boilerplate/CTA publisher yang bukan isi berita
const RD_BOILER = /baca berita terkini|berita terkini dan terpercaya|dapatkan (?:berita|update|info)|untuk mendapatkan berita|follow (?:channel|akun|kami)|ikuti (?:kami|saluran|channel|akun)|gabung (?:di )?(?:channel|grup|saluran)|lorem ipsum|all rights reserved|hak cipta|download aplikasi|unduh aplikasi|informasi seputar .{0,60}(?:bisa|dapat) diakses|bergabunglah|klik (?:di sini|link)|whatsapp channel|google news|dilarang (?:keras )?(?:mengambil|menyalin|mengutip|mengcopy)|crawling|pengindeksan otomatis|download sekarang|menyajikan berita terhangat|tinggalkan komentar|^©|^copyright|unduh .{0,30}app|install aplikasi|dapatkan notifikasi|aktifkan notifikasi|laporkan (?:iklan|konten)|unblock notifications|real[- ]time updates|know more|sign up for|subscribe to|sponsored|advertisement|sumber (?:utama|pilihan|terpercaya) di google|preferred source|tambahkan .{0,40}sumber|tas darurat.{0,3}ada apa|isi komentar|tanggung jawab (?:pengguna|penulis komentar)|promo rp|jajan pakai|diskon hingga|beli sekarang|daftar sekarang|^(?:sumber|source)\s*:|^(?:editor|penulis|reporter|redaktur|kontributor)\s*:|(?:window|modal|dialog|jendela|log)\s*(?:ini|log)?[^.\n]{0,50}(?:ditutup|close)|(?:tekan|press|aktifkan|activate)[^.\n]{0,40}(?:escape|\besc\b|tombol tutup|close button|tombol close)|dapat ditutup dengan/i;
// paragraf berupa caption foto / kredit / domain telanjang / sampah percent-encoding
const rdCaptionish = t => t.length < 220 && (/^[A-Z][A-Z0-9 ,'.&-]{5,45}\s[-–:]\s/.test(t) || /\([^()]*(?:\/|commons|photo|credit|foto)[^()]*\)\.?$/i.test(t) && t.length < 180 || /^(?:ilustrasi|foto ilustrasi|foto|dok\.?|dokumentasi|gambar|suasana|caption)\b/i.test(t) || /\((?:foto|antara|dok|sumber|istimewa|reuters|afp|ap|getty)[^)]*\)?\.?$/i.test(t) || /^[\w.-]+\.[a-z]{2,}(?:\/\S*)?…?$/i.test(t));
const rdGarbage = t => (t.match(/%[0-9A-F]{2}/gi) || []).length >= 3 || /^(?:https?:\/\/|www\.)\S+$/i.test(t) || (t.match(/[\\{}<>|]/g) || []).length > 6;
// penanda akhir artikel: semua setelahnya = footer/related/rekomendasi
const RD_END = /^(?:baca (?:juga|berita|selengkapnya)|simak (?:juga|berita)|berita (?:terkait|lainnya|terpopuler|populer|rekomendasi)|artikel (?:terkait|lainnya|populer)|terpopuler|rekomendasi(?: untuk anda)?|tag:|topik:|related (?:news|articles?|posts?)|read (?:more|also)|you (?:may|might) (?:also )?like|karin adalah|apresiasi spesial|gabung membership|kamu bisa bertanya tentang|kontribusi (?:ini|yang) |tambahkan .{0,40}(?:sebagai|jadi) sumber|syarat dan ketentuan|disclaimer\b)/i;
// judul berita lain yang sedang tampil di wire — kalau muncul sebagai "paragraf" = widget related
function rdWireImg(url) {
  for (const [k, c] of cache) {
    if (!k.startsWith('n:') || !c || !c.v || !Array.isArray(c.v.items)) continue;
    for (const i of c.v.items) { if (!i.img) continue; if (i.url === url) return i.img; const g = gnCache.get(i.url); if (g && g.url === url) return i.img; }
  }
  return '';
}
function rdWireTitles() {
  const set = new Set();
  for (const [k, c] of cache) {
    if (!k.startsWith('n:') || !c || !c.v || !Array.isArray(c.v.items)) continue;
    for (const i of c.v.items) { const n = String(i.title || '').toLowerCase().replace(/\W+/g, ' ').trim(); if (n.length > 25) set.add(n); }
  }
  return set;
}
// relevansi: isi harus nyambung dengan judul. Beda total (widget partner/artikel lain) = ditolak.
const RD_STOP = new Set('yang dan untuk dengan dari pada dalam akan atau juga tidak ini itu oleh para telah sudah bisa saat usai jadi lebih hingga serta kata kini ada sebagai antara bagi agar kembali ungkap soal terkait'.split(' '));
function rdOnTopic(title, desc, paras) {
  const toks = s => String(s || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !RD_STOP.has(w));
  const tt = [...new Set(toks(title))];
  if (tt.length < 2 || !paras.length) return true;
  const body = ' ' + toks(paras.slice(0, 12).join(' ') + ' ' + (desc || '')).join(' ') + ' ';
  const hit = tt.filter(w => body.includes(' ' + w) ).length;
  return hit >= Math.min(2, tt.length) && hit / tt.length >= 0.2;
}
// blok (p/li/h/div terdalam) yang hampir seluruhnya <a> pendek = judul link berita lain / menu, bukan paragraf
function rdStripLinkBlocks(s) {
  s = s.replace(/<(h[1-6]|span|strong|b|p|em|i|label)\b[^>]*>\s*(?:baca|simak|lihat|baca juga|simak juga|lihat juga|selengkapnya|berita terkait)\s*:?\s*<\/\1\s*>/gi, ' ');
  const re = /<(p|li|h[1-6]|div|span|td)\b[^>]*>((?:(?!<\/?(?:p|li|div|ul|ol|h[1-6]|section|article|table|tr)\b)[\s\S])*?)<\/\1\s*>/gi;
  return s.replace(re, (m, t, inner) => {
    if (!/<a\b/i.test(inner)) return m;
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain || plain.length > 240) return m;
    let linked = 0;
    for (const a of inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) linked += a[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    return linked / plain.length >= 0.8 ? ' ' : m;
  });
}
// kartu berita lain: <a href=halaman-lain> berisi <img> + judul/teks. Foto di dalamnya BUKAN foto artikel ini.
function rdStripCardLinks(s, base) {
  let basePath = ''; try { basePath = new URL(base).pathname; } catch (e) {}
  return String(s).replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (m, at, inner) => {
    if (!/<img\b/i.test(inner)) return m;
    const href = (at.match(/href=["']([^"']+)/i) || [])[1] || '';
    if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(href) || !href || href[0] === '#') return m;   // link ke gambar besar = foto artikel
    const txt = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/<h[1-6]\b/i.test(inner) || txt.length > 25) return ' ';                             // kartu: gambar + judul
    try { const h = new URL(href, base); if (h.pathname.length > 12 && h.pathname !== basePath) return ' '; } catch (e) {}   // thumbnail yang mengarah ke artikel lain
    return m;
  });
}
// kalimat berformat judul berita: Title Case, tanpa tanda baca akhir, pendek
const rdHeadlineish = t => {
  if (t.length > 160 || /[.!?"”')]$/.test(t) || /^[\d\-–•*·]/.test(t)) return false;
  const w = t.split(/\s+/).filter(x => /[A-Za-z]/.test(x));
  if (w.length < 4) return false;
  return w.filter(x => /^[A-Z0-9“"(]/.test(x)).length / w.length >= 0.6;
};
// bersihkan noise setelah blok terbentuk
function rdPruneNoise(blocks, title) {
  const wire = rdWireTitles(), me = String(title || '').toLowerCase().replace(/\W+/g, ' ').trim();
  const nrm = t => t.toLowerCase().replace(/\W+/g, ' ').trim();
  let out = [];
  for (const b of blocks) {
    if (b.k !== 'p') { out.push(b); continue; }
    if (RD_END.test(b.t) && out.filter(x => x.k === 'p').length >= 2) break;
    if (RD_BOILER.test(b.t) && b.t.length < 260) continue;
    if (rdCaptionish(b.t) || rdGarbage(b.t)) continue;
    const n = nrm(b.t);
    if (me.length > 25 && n.includes(me) && n.length < me.length + 40) continue;   // judul/breadcrumb
    if (n !== me && n.length > 25) { let hit = false; for (const w of wire) { if (n === w || (n.includes(w) && n.length < w.length + 25)) { hit = true; break; } } if (hit) continue; }
    out.push(b);
  }
  // pull-quote terpotong yang kemudian muncul utuh = duplikat
  { const ps = out.filter(x => x.k === 'p').map(x => x.t);
    out = out.filter(b => { if (b.k !== 'p' || !/(?:…|\.\.\.)$/.test(b.t)) return true; const head = b.t.replace(/(?:…|\.\.\.)$/, '').trim().toLowerCase(); return !(head.length > 20 && ps.some(o => o !== b.t && o.toLowerCase().includes(head))); }); }
  // run >=2 paragraf berformat judul berurutan = daftar related
  const keep = new Array(out.length).fill(true);
  for (let i = 0; i < out.length;) {
    if (out[i].k === 'p' && rdHeadlineish(out[i].t)) {
      let j = i; while (j < out.length && (out[j].k !== 'p' || rdHeadlineish(out[j].t))) j++;
      const run = out.slice(i, j).filter(x => x.k === 'p').length;
      if (run >= 2) for (let q = i; q < j; q++) if (out[q].k === 'p') keep[q] = false;
      i = j;
    } else i++;
  }
  return out.filter((_, i) => keep[i]);
}
// blok terurut: paragraf + slot video pada posisi aslinya di artikel.
// menangani <p> maupun artikel div+<br> (mis. sindonews) — bukan cuma tag <p>.
function rdBlocks(html, finalURL) {
  const blocks = [], paras = [], vids = [], vseen = new Set(), pseen = new Set();
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|form|nav|header|footer|aside|button|select|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // elemen khusus screen-reader/a11y (teks modal, instruksi tombol) — tak terlihat user, jangan jadi paragraf
    .replace(/<(div|span|p|section)\b[^>]*(?:class|id)=["'][^"']*(?:sr-only|visually-?hidden|screen-?reader|a11y|assistive)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(div|span|p|section)\b[^>]*\shidden(?=[\s=>])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // halaman galeri/listing punya banyak <article> saudara (satu per foto/berita terkait) — buang semua kecuali yang pertama
  let artSeen = false;
  s = s.replace(/<article\b[^>]*>[\s\S]*?<\/article\s*>/gi, m => artSeen ? ' ' : (artSeen = true, m));
  s = rdStripJunkContainers(s);   // sidebar/related/widget dibuang dulu, supaya video & gambar mereka tak ikut
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, m => {
    if (vids.length >= 4) return ' ';
    const v = rdVideoEl(m, finalURL);
    if (!v) return ' ';
    const k = v.url.split('?')[0];
    if (vseen.has(k)) return ' ';
    vseen.add(k); vids.push(v);
    return '\n@@RDV' + (vids.length - 1) + '@@\n';
  });
  // buang container reaksi/author-box/related-widget sebelum scan gambar — isinya bukan konten artikel
  s = rdStripJunkContainers(s);
  s = rdStripCardLinks(s, finalURL);
  s = rdStripLinkBlocks(s);
  // gambar dalam badan artikel: simpan di posisi aslinya (figure+figcaption atau <img> lepas)
  const imgs = [], iseen = new Set();
  const pickImg = tag => {
    const attr = n => (tag.match(new RegExp('\\b' + n + '=["\']([^"\']+)', 'i')) || [])[1] || '';
    const cls = (attr('class') + ' ' + attr('id')).toLowerCase();
    if (/emoji|emoticon|reaction|rating|like|dislike|vote|poll|icon|avatar|logo|badge|smile|frown|thumb|share|social|author|byline/.test(cls)) return null;   // img-widget, bukan foto berita
    let u = attr('data-src') || attr('data-lazy-src') || attr('data-original') || attr('data-lazy') || '';
    if (!u) { const ss = attr('data-srcset') || attr('srcset'); if (ss) u = ss.split(',').map(x => x.trim().split(/\s+/)).sort((a, b) => parseInt(b[1] || 0) - parseInt(a[1] || 0))[0][0]; }
    if (!u) u = attr('src');
    u = rdAbs(u, finalURL);
    if (!u || /^data:/i.test(u)) return null;
    if (u.split('?')[0] === String(finalURL).split('?')[0]) return null;   // lazy-load placeholder = URL artikel itu sendiri
    if (RD_IMG_JUNK.test(u) || rdJunkUrl(u) || rdSmallHint(u) || /\.(svg|gif|ico|cur)(\?|#|$)/i.test(u)) return null;
    const sm = u.match(/(?:^|[\/=_.-])(\d{2,4})[x\/](\d{2,4})(?=[\/_?.&#]|$)/);   // render-size di URL: 300/169, 350x233, w=100
    if (sm && +sm[1] < 600) return null;   // thumbnail related/preview, bukan foto artikel
    if (/(\/|_)(banner|promo|iklan|widget|sidebar|stripbanner|avatar|logo|emoji|emoticon|reaction|rating|vote|poll|tracking|pixel|spacer|blank|1x1)(\/|[-_.]|$)/i.test(u.split('?')[0])) return null;
    const w = parseInt(attr('width')) || 0, h = parseInt(attr('height')) || 0;
    if ((w && w < 280) || (h && h < 160)) return null;
    const alt = rdInline(attr('alt'));
    if (/^(like|dislike|vote|rate|bagus|jelek|setuju|tidak setuju|share|comment|komentar|emoji)/i.test(alt)) return null;   // alt reaksi, bukan foto
    return { url: u, alt };
  };
  const addImg = (tag, cap) => {
    const im = pickImg(tag); if (!im) return ' ';
    const key = rdImgKey(im.url);
    if (iseen.has(key) || imgs.length >= 6) return ' ';
    iseen.add(key);
    let c = rdInline(cap || '');
    if (!c && im.alt.length >= 20) c = im.alt;
    imgs.push({ url: im.url, cap: c.slice(0, 220) });
    return '\n@@RDI' + (imgs.length - 1) + '@@\n';
  };
  s = s.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure\s*>/gi, (m, inner) => {
    const t = inner.match(/<img\b[^>]*>/i);
    if (!t) return ' ';
    const cap = (inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || '';
    return addImg(t[0], cap.replace(/<[^>]+>/g, ' '));
  });
  s = s.replace(/<img\b[^>]*>/gi, m => addImg(m, ''));
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, t) => '\u0001' + t.replace(/<[^>]+>/g, ' ') + '\u0002');   // tandai teks link
  for (let seg of rdClean(s).split('\n')) {
    if (seg.indexOf('\u0001') >= 0) {      // segmen yang hampir seluruhnya link = judul berita lain / CTA / kartu related.
      // marker @@RD ikut dihitung sebagai "plain" — buang dulu supaya kartu <a><img>judul</a> tidak lolos
      let linked = 0; for (const lm of seg.matchAll(/\u0001([^\u0001\u0002]*)\u0002/g)) linked += lm[1].replace(/@@RD[VI]\d+@@/g, ' ').trim().length;
      const plain = seg.replace(/@@RD[VI]\d+@@/g, ' ').replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
      if (plain && plain.length <= 600 && linked / plain.length >= 0.8) continue;   // seluruh segmen dibuang — judul DAN medianya (kartu related)
    }
    seg = seg.replace(/[\u0001\u0002]/g, '');
    const parts = seg.split(/@@RD([VI])(\d+)@@/);
    for (let i = 0; i < parts.length; i++) {
      const mod = i % 3;
      if (mod === 1) { const kind = parts[i], n = +parts[i + 1]; i++; blocks.push(kind === 'V' ? { k: 'v', v: vids[n] } : { k: 'i', img: imgs[n] }); continue; }
      if (mod === 2) continue;
      const t = parts[i].replace(/\s+/g, ' ').trim();
      if (t.length < 50 || t.length > 1600 || RD_SKIP.test(t) || (t.length < 120 && RD_CREDIT.test(t))) continue;
      if (/^(copyright|©|all rights reserved)/i.test(t)) continue;
      const k = t.toLowerCase().replace(/\W+/g, ' ').slice(0, 140);
      if (pseen.has(k)) continue;
      pseen.add(k); paras.push(t); blocks.push({ k: 'p', t });
      if (paras.length >= 45) break;
    }
    if (paras.length >= 45) break;
  }
  return { blocks, paras, videos: vids };
}
function rdVideos(html, finalURL, dom = true, title = '') {
  const out = [], seen = new Set();
  const abs = (u) => rdAbs(u, finalURL);
  const add = (u, kind, poster) => {
    u = abs(u || ''); if (!u) return;
    const yt = rdYT(u);
    if (yt) { u = yt; kind = 'iframe'; }
    const k = u.split('?')[0] + '|' + kind;
    if (seen.has(k)) return; seen.add(k);
    out.push({ url: u, kind, poster: abs(poster || '') });
  };
  const meta = rdMeta(html);
  // iframe HANYA untuk player video yang dikenal — URL halaman biasa dilarang (utak-atik iframe webpage)
  const mediaKind = u => VID_FILE.test(u) || /videoplayback|googlevideo|\.m3u8/i.test(u) ? 'video' : (VID_IFRAME.test(u) && !/\/(berita|news|article|read)\//i.test(u) ? 'iframe' : 'probe');
  for (const k of ['og:video', 'og:video:url', 'og:video:secure_url', 'og:video:mp4', 'twitter:player:stream']) {
    const u = abs(meta[k] || '');
    if (u) add(u, mediaKind(u), '');
  }
  const tplayer = abs(meta['twitter:player'] || '');
  if (tplayer && VID_IFRAME.test(tplayer)) add(tplayer, 'iframe');
  for (const m of (dom ? html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi) : [])) {
    const tag = m[0];
    const src = (tag.match(/\bsrc=["']([^"']+)/i) || [])[1]
      || (m[1].match(/<source\b[^>]*\bsrc=["']([^"']+)/i) || [])[1];
    const poster = (tag.match(/\bposter=["']([^"']+)/i) || [])[1];
    add(src, 'video', poster);
  }
  for (const m of (dom ? html.matchAll(/<iframe\b[^>]*src=["']([^"']+)["']/gi) : [])) {
    const u = abs(m[1]);
    const yt = u.match(/(?:youtube\.com\/(?:embed|shorts)\/|youtu\.be\/|youtube-nocookie\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{6,15})/i);
    if (yt) { add('https://www.youtube.com/embed/' + yt[1], 'iframe'); continue; }
    if (VID_IFRAME.test(u) && !VID_FILE.test(u)) add(u, 'iframe');
  }
  for (const n of rdLd(html)) {
    if (!/video/i.test(String(n['@type'] || ''))) continue;
    for (const v of (Array.isArray(n) ? n : [n])) {
      if (title && (v.name || v.description) && !rdOnTopic(title, '', [String(v.name || '') + ' ' + String(v.description || '')])) continue;   // video milik artikel lain
      const u = abs(v.contentUrl || v.embedUrl || '');
      if (u) add(u, mediaKind(u), v.thumbnailUrl);
    }
  }
  return out.slice(0, 4);
}
// probe: og:video yang berupa halaman embed → fetch sekali, scrape video asli di dalamnya (bukan iframe webpage)
async function rdHydrateVideos(d, article) {
  const probes = (d.videos || []).filter(v => v.kind === 'probe').slice(0, 2);
  if (!probes.length) return d;
  const resolved = await Promise.all(probes.map(async p => {
    try {
      const r = await get(p.url, { headers: { referer: article } }, 10000);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\//i.test(ct)) return { url: p.url, kind: VID_FILE.test(p.url) ? 'video' : 'probe', poster: p.poster };
      const innerHtml = await r.text();
      const im = rdMeta(innerHtml), iTitle = rdInline(im['og:title'] || im.title || '');
      const inner = rdVideos(innerHtml, p.url, true, d.title || '');
      let good = inner.find(v => v.kind === 'video') || inner.find(v => v.kind === 'iframe');
      // halaman embed milik video lain: og:title-nya tidak nyambung judul artikel → buang
      if (good && d.title && iTitle.length > 8 && !rdOnTopic(d.title, '', [iTitle])) good = null;
      return good || null;
    } catch (e) { return null; }
  }));
  const rest = (d.videos || []).filter(v => v.kind !== 'probe');
  d.videos = [...resolved.filter(Boolean), ...rest].slice(0, 4);
  return d;
}
// container body artikel: <article> atau elemen ber-class/id khas konten,
// dengan pencocokan tag seimbang (bukan regex non-greedy yang terpotong nested div)
const RD_CONT_RE = /<(article|div|section|main)\b[^>]*(?:class|id)=["'][^"']*(?:detail-desc|article-content|article-body|content-detail|detail-content|post-content|entry-content|berita-content|field-name-body|txt-berita|detail_body|news-content|content-body|post-body|article__body|detail__body-text|itp_bodycontent|detail__body|txt-article|side-article|detail-text|article-content-body|max-card__image)[^"']*["'][^>]*>/i;
// kandidat container body artikel, urut prioritas: class/id spesifik → <article> → full page.
// class/id dulu karena <article> bisa membungkus "berita terkait" di luar body.
function rdArticleCandidates(html) {
  const out = [];
  const cm = html.match(RD_CONT_RE);
  if (cm) {
    const tag = cm[0].match(/^<(\w+)/)[1].toLowerCase();
    const re = new RegExp('<(\\/?)' + tag + '\\b[^>]*>', 'gi');
    re.lastIndex = cm.index;
    let depth = 0;
    for (;;) {
      const t = re.exec(html);
      if (!t) break;
      depth += t[1] ? -1 : 1;
      if (depth === 0) { out.push(html.slice(cm.index + cm[0].length, t.index)); break; }
    }
  }
  const am = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (am) out.push(am[1]);
  out.push(html);
  return out;
}
function rdExtract(html, finalURL) {
  const meta = rdMeta(html), ld = rdLd(html);
  const art = ld.find(n => /article|posting|news/i.test(String(n['@type'] || ''))) || {};
  const vid = ld.find(n => /video/i.test(String(n['@type'] || ''))) || {};   // halaman video: body sering di VideoObject.description
  const site = meta['og:site_name'] || rdHost(finalURL);
  let title = rdClean(meta['og:title'] || meta['twitter:title'] || rdName(art.headline) ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const sep = title.match(/\s*[|–—]\s*([^|–—]{2,45})\s*$/) || title.match(/\s+-\s+([^-]{2,45})\s*$/);
  if (sep && site) {
    const tail = sep[1].trim().toLowerCase(), s = site.toLowerCase();
    if (tail === s || tail.includes(s) || s.includes(tail)) title = title.slice(0, sep.index).trim();
  }
  const desc = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  let img = meta['og:image'] || meta['og:image:secure_url'] || meta['twitter:image'] || '';
  if (img) { try { img = new URL(img, finalURL).href; } catch (e) { img = ''; } }
  if (!/^https?:/i.test(img) || rdJunkUrl(img) || /(logo|favicon|sprite|placeholder|default[-_]|no[-_]?image|avatar|icon)[^/]*\.(png|jpe?g|webp|ico|svg)$/i.test(img.split('?')[0]) || /\.(svg|gif|ico)(\?|$)/i.test(img)) img = '';
  const byline = meta.author || meta['article:author'] || rdName(art.author) || '';
  const time = meta['article:published_time'] || meta['datepublished'] || art.datePublished || '';
  let blk = null;
  for (const cand of rdArticleCandidates(html)) {
    const b = rdBlocks(cand, finalURL);
    if (!blk || b.paras.length > blk.paras.length) blk = b;
    if (b.paras.length >= 3) break;                    // kandidat pertama yang cukup kaya menang
  }
  if (!blk) blk = rdBlocks(html, finalURL);
  blk.blocks = rdPruneNoise(blk.blocks, title);
  blk.paras = blk.blocks.filter(b => b.k === 'p').map(b => b.t);
  let paras = blk.paras;
  if (paras.length < 2) {
    // articleBody dulu, lalu deskripsi NewsArticle/VideoObject — halaman video
    // (20detik/antaranews/detik) menyimpan caption artikel di sana, bukan di body.
    for (const body of [art.articleBody, art.description, vid.description]) {
      if (typeof body !== 'string' || !body.trim()) continue;
      const ps = body.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map(rdInline).filter(t => t.length >= 50).slice(0, 45);
      if (ps.length) { paras = ps; blk = { blocks: ps.map(t => ({ k: 'p', t })), paras: ps, videos: [] }; break; }
    }
  }
  if (!paras.length && desc) {
    paras = [rdInline(desc)];
    blk = { blocks: paras.map(t => ({ k: 'p', t })), paras, videos: [] };
  }
  // fallback articleBody/desc dibuat SETELAH prune — bersihkan ulang (URL mentah, related, CTA)
  blk.blocks = rdPruneNoise(blk.blocks, title);
  blk.paras = blk.blocks.filter(b => b.k === 'p').map(b => b.t);
  paras = blk.paras;
  // judul yang kebetulan jadi "paragraf" pertama → buang dari blok & paras
  const tnorm = rdInline(title).toLowerCase();
  if (tnorm) {
    for (let i = blk.blocks.length - 1; i >= 0; i--) {
      const b = blk.blocks[i];
      if (b.k === 'p' && b.t.toLowerCase() === tnorm) {
        blk.blocks.splice(i, 1);
        const pi = blk.paras.indexOf(b.t); if (pi >= 0) blk.paras.splice(pi, 1);
        const ji = paras.indexOf(b.t); if (ji >= 0) paras.splice(ji, 1);
      }
    }
  }
  const joined = [];
  let total = 0;
  for (const p of paras) {
    if (total + p.length > 18000) break;
    joined.push(p); total += p.length;
  }
  // blok dengan cap total sama; slot video selalu ikut
  const finBlocks = [];
  let btotal = 0;
  for (const b of blk.blocks) {
    if (b.k === 'p') { if (btotal + b.t.length > 18000) continue; btotal += b.t.length; }
    finBlocks.push(b);
  }
  const allV = rdVideos(html, finalURL, false, title);
  const vkey = v => String(v.url).split('?')[0];
  const pkeys = new Set(blk.videos.map(vkey));
  const videos = [...blk.videos, ...allV.filter(v => !pkeys.has(vkey(v)))].slice(0, 4);
  return {
    ok: true, url: finalURL, final: finalURL,
    title: title || rdHost(finalURL) || 'Tanpa judul',
    site, byline, time: time ? String(time) : '', img, desc: rdInline(desc),
    paras: joined, thin: joined.length < 2, videos, blocks: finBlocks
  };
}
const RD_PROXIES = [
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  u => 'https://proxy.corsfix.com/?' + encodeURIComponent(u)
];
// Jina reader mengembalikan markdown; ubah jadi bentuk yang kompatibel rdExtract.
function rdJinaMd(text, url) {
  const paras = [], seen = new Set();
  let title = '';
  for (const raw of String(text).split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^markdown content:/i.test(t)) continue;
    const tm = t.match(/^title:\s*(.+)/i);
    if (tm) { if (!title) title = tm[1].trim(); continue; }
    if (/^url source:/i.test(t)) continue;
    if (t.startsWith('#')) {
      const hd = t.replace(/^#+\s*/, '').trim();
      if (!title) title = hd;
      else if (paras.length >= 2 && /terpopuler|terkait|baca juga|rekomendasi|berita lain|terbaru|trending|populer|lainnya|related|more (?:news|stories)|latest|you may|komentar|comments?/i.test(hd)) break;   // semua setelah heading ini = widget/footer
      continue;
    }
    if (/^\[!\[/.test(t) || /^\[\s*\]\(/.test(t)) continue;   // kartu gambar+link
    if (/^!\[/.test(t) || /^```/.test(t) || /^>/.test(t) || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) continue;
    const noImg = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    let linkLen = 0; for (const lm of noImg.matchAll(/\[([^\]]*)\]\([^)]*\)/g)) linkLen += lm[1].length;
    if (linkLen / Math.max(1, noImg.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').length) >= 0.7) continue;   // baris isinya link doang
    const clean = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|`|~~)/g, '')
      .replace(/\s+/g, ' ').trim();
    if (clean.length < 60 || clean.length > 1600) continue;
    if (RD_SKIP.test(clean)) continue;
    const k = clean.toLowerCase().replace(/\W+/g, ' ').slice(0, 140);
    if (seen.has(k)) continue;
    seen.add(k); paras.push(clean);
    if (paras.length >= 45) break;
  }
  { const kept = rdPruneNoise(paras.map(t => ({ k: 'p', t })), title).map(b => b.t); paras.length = 0; paras.push(...kept); }
  return { ok: true, url, final: url, title: title || rdHost(url) || 'Tanpa judul',
    site: rdHost(url), byline: '', time: '', img: '', desc: '', paras, thin: paras.length < 2, via: 'reader' };
}
// video tanpa posisi (og:video/JSON-LD/Jina) → sebar merata di antara paragraf,
// bukan numpuk di bawah hero image
const rdDirKey = u => { const seg = String(u).split('?')[0].split('#')[0].split('/').filter(Boolean); return seg.length > 1 ? seg[seg.length - 2] : ''; };
function rdAssembleBlocks(d) {
  if (!d) return d;
  const paras = d.paras || [];
  let blocks = (Array.isArray(d.blocks) && d.blocks.length) ? d.blocks.slice() : paras.map(t => ({ k: 'p', t }));
  const heroKey = d.img ? rdImgKey(d.img) : '';
  const heroDir = d.img ? rdDirKey(d.img) : '';
  const heroDirUniq = heroDir.length >= 6 && /\d/.test(heroDir);   // folder id artikel (mis. Metro /K5nC1Drn/)
  // media dengan posisi asli: k = jumlah paragraf sebelum media itu
  const media = [], seenM = new Set();
  const mkey = b => b.k === 'v' ? 'v|' + String(b.v.url).split('?')[0] : 'i|' + rdImgKey(b.img.url);
  let pCount = 0, firstImg = true;
  for (const b of blocks) {
    if (b.k === 'p') { pCount++; continue; }
    if (b.k === 'v' && (!b.v || b.v.kind === 'probe')) continue;
    if (b.k === 'i') {
      const wasFirst = firstImg; firstImg = false;
      if (!b.img || rdImgKey(b.img.url) === heroKey) continue;
      // gambar pertama di body yang share folder-id dengan hero = foto lead yang sama
      // (CMS seperti Metro simpan og:image dan gambar artikel di folder sama, nama file beda)
      if (wasFirst && heroDirUniq && rdDirKey(b.img.url) === heroDir) continue;
    }
    const key = mkey(b); if (seenM.has(key)) continue; seenM.add(key);
    media.push({ b, k: pCount });
  }
  // video tanpa posisi (og:video/JSON-LD/Jina)
  for (const v of (d.videos || [])) {
    if (!v || v.kind === 'probe') continue;
    const b = { k: 'v', v }, key = mkey(b);
    if (seenM.has(key)) continue; seenM.add(key);
    media.push({ b, k: -1 });
  }
  const capKey = t => t.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 80);
  const capSet = new Set(media.filter(x => x.b.k === 'i' && x.b.img.cap).map(x => capKey(x.b.img.cap)));
  const ps = blocks.filter(b => b.k === 'p' && !capSet.has(capKey(b.t)));
  const n = ps.length, m = media.length;
  if (!m) { d.blocks = ps; return d; }
  if (n === 0) { d.blocks = media.filter(x => x.b.k === 'v').map(x => x.b); return d; }   // gambar tanpa teks = sampah (thumbnail/related), video tetap
  // posisi akhir: di antara paragraf (minimal setelah paragraf 1, maksimal sebelum paragraf terakhir), satu media per celah
  const lo = n >= 2 ? 1 : 1, hi = n >= 2 ? n - 1 : 1;
  const slots = hi - lo + 1;
  let ks = media.map((x, i) => x.k < 0 ? Math.round(n * (i + 1) / (m + 1)) : x.k);
  ks = ks.map(k => Math.min(hi, Math.max(lo, k)));
  let ok = true;
  for (let i = 1; i < ks.length; i++) { if (ks[i] <= ks[i - 1]) ks[i] = ks[i - 1] + 1; if (ks[i] > hi) ok = false; }
  if (!ok && m <= slots) ks = media.map((_, i) => lo + Math.floor(i * slots / m));
  else if (!ok) ks = media.map((_, i) => Math.min(hi, lo + Math.floor(i * slots / m)));
  const out = [];
  let pi = 0, mi = 0;
  const flush = () => { while (mi < m && ks[mi] <= pi) out.push(media[mi++].b); };
  for (const p of ps) { out.push(p); pi++; flush(); }
  while (mi < m) out.push(media[mi++].b);
  d.blocks = out;
  return d;
}
async function rdFinish(d, url, html, via) {
  // hydrate video probes dan resolusi hero thumb jalan PARALEL — keduanya network
  // dan tidak saling depend (thumb baca html, hydrate baca d.videos).
  const hydP = rdHydrateVideos(d, url);
  // hero disamakan dengan pipeline thumb() news wire — og:image mentah sering logo/aset situs.
  // html sudah di-fetch rdRead → pakai thumbFromHtml (zero fetch tambahan). Tanpa html → thumb() fallback.
  // Hasil ikut di-cache supaya wire lead tidak fetch ulang. Hero harus final SEBELUM rdAssembleBlocks (dedupe hero vs body).
  let thumbImg = '';
  // html null = pemenang non-HTML (Jina/meta). Jina (via 'race') tetap boleh thumb() —
  // thumbCache membuatnya murah kalau wire sudah fetch, dan Jina sering menang race
  // padahal direct sebenarnya sanggup. 'meta' = semua fetch gagal → skip, jangan buang waktu.
  if ((html !== null || via !== 'meta') && !/youtube\.com|youtu\.be/i.test(url)) {
    try {
      const t = html ? await thumbFromHtml(html, url) : await thumb(url);
      if (t && t.img) {
        thumbImg = t.img;
        thumbCache.set(url, { v: t, at: Date.now() });
        if (thumbCache.size > 200) thumbCache.delete(thumbCache.keys().next().value);
      }
    } catch (e) {}
  }
  await hydP;
  if (thumbImg) d.img = thumbImg;
  if (!d.img) { const wi = rdWireImg(url) || (d.url && rdWireImg(d.url)); if (wi) d.img = wi; }   // gambar RSS ikut gerbang yang sama (ukuran, ikon, duplikat)
  try { d = await rdFinalGate(d, url); } catch (e) {}
  try { d = await rdVideoGate(d); } catch (e) {}
  if (!d.img) { const fi = (d.blocks || []).find(b => b.k === 'i' && b.img); if (fi) { d.img = fi.img.url; d.blocks = d.blocks.filter(b => b !== fi); } }   // tanpa og:image → foto badan pertama
  d = rdAssembleBlocks(d);
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
async function rdRead(raw) {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
  const yid = ytIdOf(raw);
  if (yid) return memo('yt:' + yid, 600000, () => rdReadYouTube(yid, raw));
  let target = raw;
  if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) target = await decodeGNews(raw);
  return memo('read:' + target, 600000, async () => {
    const t0 = Date.now();
    const left = () => Math.max(5000, 40000 - (Date.now() - t0));   // frontend timeout 45s
    let lastErr = null, metaD = null;
    const BLOCKED_RE = /just a moment|attention required|access denied|verify you are|are you a robot|cf-chl|challenge-platform|enable javascript and cookies|request blocked|pardon our interruption/i;
    const metaScore = d => ((d.videos || []).length * 2) + (d.img ? 1 : 0) + (d.desc ? 0.5 : 0);
    const tryHtml = (html, url) => {
      const d = rdExtract(html, url);
      const blocked = BLOCKED_RE.test(d.title + ' ' + (d.desc || '') + ' ' + html.slice(0, 30000));
      if (!blocked && !rdOnTopic(d.title, d.desc, d.paras)) { lastErr = new Error('isi tidak nyambung dengan judul'); return null; }
      // halaman JS-rendered: teks tipis tapi meta (og:image/og:video) tetap bernilai → simpan untuk fallback & merge
      if (!blocked && metaScore(d) > (metaD ? metaScore(metaD) : -1)) metaD = d;
      return (d.paras.length < 2 || blocked) ? null : d;
    };
    // timing per tahap — terlihat di response (.t) dan log Railway, jadi optimasi
    // berikutnya pakai data bukan feeling
    let fetchMs = 0;
    const fin = async (d, url, html, via) => {
      const m0 = Date.now();
      const r = await rdFinish(d, url, html, via);
      // halaman video: konten utamanya video, bukan artikel — tandai supaya UI
      // tidak salah-baca thin sebagai "login/JS". Video playable = file/iframe,
      // bukan 'probe' yang belum teresolve.
      const playable = (r.videos || []).some(v => v.kind !== 'probe') || (r.blocks || []).some(b => b.k === 'v' && b.v && b.v.kind !== 'probe');
      if (r.thin && playable) r.videoPage = true;
      r.t = { ms: Date.now() - t0, fetch: fetchMs, media: Date.now() - m0, via };
      console.log('[read]', via, r.t.ms + 'ms', 'fetch:' + fetchMs, 'media:' + r.t.media);
      return r;
    };
    // first-valid-wins: semua extractor jalan paralel, yang pertama hasilkan
    // artikel valid menang. Dulu tangga serial (direct→Jina→proxy) — situs yang
    // rewel makan 10-20s per anak tangga. Firecrawl tetap jalur terakhir
    // (mahal, render browser) sebelum fallback meta.
    const jobs = [];
    // direct + redirect manual
    jobs.push((async () => {
      const { r, url } = await rdSafeGet(target, Math.min(12000, left()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan halaman HTML');
      const len = Number(r.headers.get('content-length') || 0);
      if (len > 3e6) throw new Error('halaman terlalu besar');
      let html = await r.text();
      if (html.length > 3e6) html = html.slice(0, 3e6);
      const d = tryHtml(html, url);
      if (!d) throw new Error('halaman challenge/block');
      return { d, html, url };
    })());
    // Jina reader — markdown, bukan html → thumb() fallback di rdFinish
    jobs.push((async () => {
      const r = await get('https://r.jina.ai/' + target, { headers: { accept: 'text/plain' } }, Math.min(10000, left()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      if (!txt || txt.length <= 200) throw new Error('jina kosong');
      const d = rdJinaMd(txt, target);
      if (!(d.paras.length >= 2 && !BLOCKED_RE.test(d.title + ' ' + txt.slice(0, 3000)) && rdOnTopic(d.title, '', d.paras))) throw new Error('jina tidak valid');
      if (metaD) {                                   // timpa field kosong dengan meta dari fetch langsung
        if (!d.img && metaD.img) d.img = metaD.img;
        if (!d.videos || !d.videos.length) d.videos = metaD.videos || [];
        if (!d.time && metaD.time) d.time = metaD.time;
      }
      return { d, html: null, url: target };
    })());
    for (const px of RD_PROXIES) jobs.push((async () => {
      const r = await get(px(target), {}, Math.min(12000, left()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan html');
      let html = await r.text();
      if (html.length > 3e6) html = html.slice(0, 3e6);
      const d = tryHtml(html, target);
      if (!d) throw new Error('proxy tidak valid');
      return { d, html, url: target };
    })());
    const win = await new Promise(res => {
      let n = jobs.length, settled = false;
      const done = v => { if (!settled) { settled = true; res(v); } };
      for (const j of jobs) j.then(v => done(v), () => {}).finally(() => { if (--n === 0) done(null); });
    });
    if (win) { fetchMs = Date.now() - t0; return await fin(win.d, win.url, win.html, 'race'); }
    // 2.5) Firecrawl — render browser asli, tembus Cloudflare/challenge yang memukul direct+Jina+proxy
    const FC_KEY = process.env.FIRECRAWL_API_KEY || CFG.firecrawl_key || '';
    if (FC_KEY && Date.now() - t0 < 30000) {
      try {
        const r = await get('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
          body: JSON.stringify({ url: target, formats: ['html'], onlyMainContent: false, timeout: 25000 })
        }, Math.min(30000, left()));
        if (r.ok) {
          const j = await r.json();
          const html = j && j.data && j.data.html;
          if (html && String(html).length > 500) {
            const d = tryHtml(String(html).slice(0, 3e6), target);
            if (d) {
              const md = j.data.metadata || {};
              if (!d.title || /^(undefined|null)$/i.test(d.title) || d.title === rdHost(target)) d.title = md.title || md.ogTitle || d.title;
              if (!d.img && md.ogImage) d.img = md.ogImage;
              if (!d.desc && (md.ogDescription || md['og:description'])) d.desc = md.ogDescription || md['og:description'];
              if (!d.byline && md.author) d.byline = md.author;
              if (!d.time && md['article:published_time']) d.time = md['article:published_time'];
              fetchMs = Date.now() - t0;
              return await fin(d, target, String(html), 'firecrawl');
            }
          }
        }
      } catch (e) { lastErr = e; }
    }
    // semua jalur gagal → tetap sajikan meta (judul/gambar/video/deskripsi) daripada error kosong
    if (metaD) {
      const paras = metaD.paras.length ? metaD.paras : (metaD.desc ? [metaD.desc] : []);
      const d = { ...metaD, paras, thin: paras.length < 2, via: 'meta' };
      d.blocks = (metaD.blocks && metaD.blocks.length ? metaD.blocks : paras.map(t => ({ k: 'p', t })))
        .filter(b => b.k !== 'p' || paras.includes(b.t));
      fetchMs = Date.now() - t0;
      return await fin(d, target, null, 'meta');   // semua fetch gagal — thumb() juga akan gagal, jangan buang waktu
    }
    throw lastErr || new Error('fetch failed');
  });
}

/* ---------- TomTom Traffic + Routing (proxy server-side agar key tidak bocor ke klien) ---------- */
const ttHas = () => !!TOMTOM_KEY;
const haversine = (a, b) => {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
async function ttFetch(url) {
  const r = await get(url, { headers: { accept: 'application/json' } }, 12000);
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt.slice(0, 400) }; }
  if (!r.ok) { const err = new Error('TomTom ' + r.status + ' ' + (data.detailedError?.message || data.error || txt.slice(0, 120))); err.status = r.status; err.data = data; throw err; }
  return data;
}
const ttFlow = (lat, lon, zoom = 10) => memo('tt:flow:' + lat.toFixed(4) + ',' + lon.toFixed(4) + ',' + zoom, 30000, async () => {
  if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
  const url = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/' + Math.round(zoom) + '/json?key=' + encodeURIComponent(TOMTOM_KEY) + '&point=' + lat + ',' + lon + '&unit=kmph&thickness=10';
  const d = await ttFetch(url);
  const f = d.flowSegmentData || {};
  return { ok: true, point: { lat, lon }, zoom: Math.round(zoom), frc: f.frc || '', exists: !!f.coordinate || !!f.frc,
    coordinates: f.coordinates?.coordinate || [],
    currentSpeed: f.currentSpeed ?? null, freeFlowSpeed: f.freeFlowSpeed ?? null,
    currentTravelTime: f.currentTravelTime ?? null, freeFlowTravelTime: f.freeFlowTravelTime ?? null,
    confidence: f.confidence ?? null, roadClosure: !!f.roadClosure, openlr: f.openlr || '', at: Date.now() };
}, e => ({ ok: false, err: String(e.message || e).slice(0, 220) }));

const ttIncidents = (bbox, language = 'id-ID') => memo('tt:inc:' + bbox, 30000, async () => {
  if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
  const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}';
  const url = 'https://api.tomtom.com/traffic/services/5/incidentDetails?key=' + encodeURIComponent(TOMTOM_KEY) +
    '&bbox=' + encodeURIComponent(bbox) + '&fields=' + encodeURIComponent(fields) +
    '&language=' + encodeURIComponent(language) + '&timeValidityFilter=present';
  const d = await ttFetch(url);
  const rows = (d.incidents || []).filter(Boolean).map(inc => {
    const p = inc.properties || {};
    const coords = inc.geometry?.coordinates;
    let lat = null, lon = null;
    if (inc.geometry?.type === 'Point' && Array.isArray(coords)) { lon = coords[0]; lat = coords[1]; }
    else if (inc.geometry?.type === 'LineString' && Array.isArray(coords) && coords[0]) { lon = coords[0][0]; lat = coords[0][1]; }
    return { id: p.id || '', iconCategory: p.iconCategory ?? 0, magnitude: p.magnitudeOfDelay ?? 0,
      desc: (p.events?.[0]?.description || p.events?.map(e=>e.description).join('; ') || 'Insiden lalu lintas'),
      from: p.from || '', to: p.to || '', length: p.length ?? null, delay: p.delay ?? null,
      startTime: p.startTime || '', endTime: p.endTime || '', timeValidity: p.timeValidity || '',
      probability: p.probabilityOfOccurrence || '', reports: p.numberOfReports ?? null, lastReport: p.lastReportTime || '',
      geometry: inc.geometry || null, lat, lon };
  });
  return { ok: true, bbox, count: rows.length, incidents: rows, at: Date.now() };
}, e => ({ ok: false, bbox, err: String(e.message || e).slice(0, 260) }));

const ttRoute = (from, to, mode = 'driving') => memo('tt:route:' + from.lat.toFixed(4) + ',' + from.lon.toFixed(4) + '>' + to.lat.toFixed(4) + ',' + to.lon.toFixed(4) + ':' + mode, 30000, async () => {
  if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
  const iso = [mode, 'truck', 'bus', 'taxi', 'motorcycle', 'bicycle', 'pedestrian'].includes(mode) ? mode : 'driving';
  const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + from.lat + ',' + from.lon + ':' + to.lat + ',' + to.lon +
    '/json?key=' + encodeURIComponent(TOMTOM_KEY) +
    '&traffic=true&routeRepresentation=polyline';
  const d = await ttFetch(url);
  const route = d.routes?.[0];
  if (!route) throw new Error('Rute tidak ditemukan');
  const s = route.summary || {};
  const pts = (route.legs || []).flatMap(l => l.points || []);
  const poly = pts.map(p => ({ lat: p.latitude, lon: p.longitude }));
  return { ok: true, mode: iso,
    from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon },
    straightKm: +haversine(from, to).toFixed(3),
    distanceKm: s.lengthInMeters ? +(s.lengthInMeters / 1000).toFixed(3) : null,
    travelTimeSec: s.travelTimeInSeconds ?? null,
    trafficTimeSec: (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) > 0 ? (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) : (s.travelTimeInSeconds ?? null),
    trafficDelaySec: s.trafficDelayInSeconds ?? null,
    departureTime: s.departureTime || '', arrivalTime: s.arrivalTime || '',
    congestion: s.trafficCongestion || '', legs: (route.legs || []).map(l => ({
      summary: l.summary || {}, points: (l.points || []).length })),
    polyline: poly, at: Date.now() };
}, e => ({ ok: false, err: String(e.message || e).slice(0, 280) }));

async function ttTile(kind, z, x, y, res) {
  if (!ttHas()) { res.writeHead(503, { 'access-control-allow-origin': '*' }); return res.end('TomTom key belum dikonfigurasi'); }
  const paths = {
    basic: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    base: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    flow: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    incidents: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
    incident: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
    hybrid: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png'
  };
  const p = paths[kind] || paths.flow;
  const host = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 4)] + '.api.tomtom.com';
  const url = 'https://' + host + p + '?key=' + encodeURIComponent(TOMTOM_KEY);
  const r = await get(url, {}, 12000);
  res.writeHead(r.status, { 'access-control-allow-origin': '*', 'content-type': r.headers.get('content-type') || 'image/png', 'cache-control': 'public, max-age=300' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'access-control-allow-origin': '*' };
  const json = (o, c = 200) => { res.writeHead(c, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(HTML)); }
    if (u.pathname === '/idn.geo.json' || u.pathname === '/idn-context.geo.json' || u.pathname === '/idn-prov.geo.json' || u.pathname === '/world110.geo.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', u.pathname.slice(1)))); }
    if (u.pathname === '/signals.js' || u.pathname === '/wxicons.js' || u.pathname === '/wire-core.js') { res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', u.pathname.slice(1)))); }
    if (u.pathname === '/api/ping') return json({ ok: true, x: xHas(), classifierVersion: SOC.CLASSIFIER_VERSION });
    if (u.pathname === '/api/news') {
      const srcs = await news();
      { // gambar yang sama dipakai >1 headline berbeda = aset situs/placeholder → kosongkan semua
        const cnt = new Map();
        for (const s of srcs) for (const i of s.items) if (i.img) { const k = rdImgKey(i.img); if (!cnt.has(k)) cnt.set(k, new Set()); cnt.get(k).add(i.url); }
        for (const s of srcs) for (const i of s.items) if (i.img && cnt.get(rdImgKey(i.img)).size > 1) i.img = '';
      }
      return json({ classifierVersion: SOC.CLASSIFIER_VERSION, sources: srcs.map(s => ({ ...s, items: s.items.map(i => {
        const cat = catOf(i.title);
        return { ...i, cat, feedTopic: feedCatOf(s.id), assessment: assessNews(i.title), label: cat ? catMeta(cat).label : '' };
      }) })), at: Date.now() });
    }
    if (u.pathname === '/api/breaking') {
      const c = cache.get('breaking');
      if (c && c.v) {
        if (!c.p && Date.now() - c.at > 25000) breaking().catch(() => {});
        return json(c.v);                      // stale-while-revalidate: marquee tidak nunggu feed
      }
      return json(await breaking());
    }
    if (u.pathname === '/api/x') return json(socialResponse(await xposts(), xHist, SOC.socKeepX));
    if (u.pathname === '/api/xdiag') {   // bandingkan bentuk query: mana yang dapat hasil basi di host ini
      const SQ = require('./social.js').socQueries('x', []); const tests = u.searchParams.get('all') ? SQ.map(e => e.q) : ['kebakaran', 'kebakaran lang:id', 'kebakaran -filter:replies', 'kebakaran lang:id -filter:replies', '(kebakaran OR damkar) lang:id -filter:replies', 'kebakaran since_time:' + Math.floor((Date.now() - 46 * 3600e3) / 1000)];
      const out = [];
      for (const q of tests) {
        try { const sv = Date.now; const r = await xSearch(q.replace(/ since_time:\d+/, '')); const n = r.posts.reduce((m, p) => Math.max(m, p.ts), 0);
          out.push({ q, n: r.posts.length, newest: n ? new Date(n).toISOString() : '-', ageH: n ? +((Date.now() - n) / 3600e3).toFixed(1) : null }); }
        catch (e) { out.push({ q, err: String(e.message).slice(0, 120) }); }
      }
      return json({ host: process.env.RAILWAY_ENVIRONMENT ? 'railway' : 'local', qid: X.query_id || 'auto', out });
    }
    if (u.pathname === '/api/xq') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ ok: false, err: 'query kosong' });
      try { await xqLazy(q); return json(socialResponse({ ok: true }, xHist, SOC.socKeepX)); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 200) }); }
    }
    if (u.pathname === '/api/thq') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ ok: false, err: 'query kosong' });
      try { await thqLazy(q); return json(socialResponse({ ok: true }, tHist, SOC.socKeepTh)); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 200) }); }
    }
    if (u.pathname === '/api/thread') {
      try { return json(await threadOf(u.searchParams.get('u') || '')); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 220) }); }
    }
    if (u.pathname === '/api/threads') {
      const c = cache.get('threads');
      if (c && c.v) {
        if (!c.p && Date.now() - c.at > 90000) threads().catch(() => {});
        return json(socialResponse(c.v, tHist, SOC.socKeepTh));
      }
      return json(socialResponse(await threads(), tHist, SOC.socKeepTh));
    }
    if (u.pathname === '/api/incidents') return json(await incidents());
    if (u.pathname === '/api/situation') return json(await situation());
    if (u.pathname === '/api/market') return json(await market());
    if (u.pathname === '/api/closes') return json(await closes((u.searchParams.get('list') || '').split(',')));
    if (u.pathname === '/api/flights') return json({ ok: true, items: await flights(), at: Date.now() });
    if (u.pathname === '/api/ships') return json({ ok: true, items: await ships(), n: shipMap.size, live: !!(wsSock && !wsSock.destroyed), at: Date.now() });
    if (u.pathname === '/api/transit') return json({ ok: true, items: await transit(), at: Date.now() });
    if (u.pathname === '/api/disaster') return json(await disaster());
    if (u.pathname === '/api/weather') return json(await weather());
    if (u.pathname === '/api/wind') return json(await windGrid());
    if (u.pathname === '/api/fires') return json(await fires());
    if (u.pathname === '/api/sipongi') return json(await sipongi());
    if (u.pathname === '/api/satellite') return json(await satelliteProducts());
    if (u.pathname === '/api/bmkg-modelrun') return json(await bmkgModelRun());
    if (u.pathname === '/api/alerts') return json(await alerts());
    if (u.pathname === '/api/radar') return json(await radar());
    if (u.pathname === '/api/cams') return json(await alive());
    if (u.pathname === '/api/cctv') return json(await cctvCatalog());
    if (u.pathname === '/api/cctv/report' && req.method === 'POST') {
      try {
        let raw = '';
        for await (const ch of req) { raw += ch; if (raw.length > 4000) break; }
        const b = JSON.parse(raw || '{}');
        camReport(String(b.u || ''), !!b.ok);
        return json({ ok: true });
      } catch (e) { return json({ ok: false }, 400); }
    }
    if (u.pathname === '/api/tomtom/status') return json({ ok: true, keyConfigured: ttHas(), source: process.env.TOMTOM_API_KEY ? 'env' : (CFG.tomtom ? 'config' : 'none'), at: Date.now() });
    if (u.pathname === '/api/tomtom/flow') {
      const lat = parseFloat(u.searchParams.get('lat')), lon = parseFloat(u.searchParams.get('lon')), zoom = parseFloat(u.searchParams.get('zoom') || '10');
      if (isFinite(lat) && isFinite(lon)) return json(await ttFlow(lat, lon, isFinite(zoom) ? zoom : 10));
      return json({ ok: false, err: 'lat/lon wajib' }, 400);
    }
    if (u.pathname === '/api/tomtom/incidents') {
      let bbox = u.searchParams.get('bbox');
      if (!bbox && u.searchParams.get('lat') && u.searchParams.get('lon')) {
        const lat = parseFloat(u.searchParams.get('lat')), lon = parseFloat(u.searchParams.get('lon')), d = parseFloat(u.searchParams.get('d') || '0.25');
        const dd = Math.min(2.5, Math.max(0.05, isFinite(d) ? d : 0.25));
        bbox = (lon - dd) + ',' + (lat - dd) + ',' + (lon + dd) + ',' + (lat + dd);
      }
      if (bbox && /^[-0-9.,\s]+$/.test(bbox)) return json(await ttIncidents(bbox, u.searchParams.get('lang') || 'id-ID'));
      return json({ ok: false, err: 'bbox wajib (minLon,minLat,maxLon,maxLat) atau lat+lon' }, 400);
    }
    if (u.pathname === '/api/tomtom/route') {
      const a = u.searchParams.get('from'), b = u.searchParams.get('to');
      const pa = a && a.split(',').map(Number), pb = b && b.split(',').map(Number);
      if (pa && pb && pa.length === 2 && pb.length === 2 && pa.every(isFinite) && pb.every(isFinite))
        return json(await ttRoute({ lat: pa[0], lon: pa[1] }, { lat: pb[0], lon: pb[1] }, u.searchParams.get('mode') || 'driving'));
      return json({ ok: false, err: 'from=lat,lon dan to=lat,lon wajib' }, 400);
    }
    if (u.pathname.startsWith('/tomtom/tile/')) {
      const m = u.pathname.match(/^\/tomtom\/tile\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\.png$/i);
      if (!m) { res.writeHead(404); return res.end(); }
      return await ttTile(m[1].toLowerCase(), m[2], m[3], m[4], res);
    }
    if (u.pathname === '/hls') return await hls(u.searchParams.get('u') || '', res);
    if (u.pathname === '/vhs') return await vhs(u.searchParams.get('u') || '', res);
    if (u.pathname === '/img') return await img(u.searchParams.get('u') || '', res);
    if (u.pathname === '/api/read') {
      try { return json(await rdRead(u.searchParams.get('u') || '')); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 220) }); }
    }
    if (u.pathname === '/api/thumb') {
      try { return json({ ok: true, ...(await thumb(u.searchParams.get('u') || '')) }); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 160) }); }
    }
    res.writeHead(404); res.end();
  } catch (e) { if (!res.headersSent) json({ ok: false, err: String(e.message || e) }, 502); else res.end(); }
}).listen(PORT, () => {
  console.log('SITREP jalan di http://localhost:' + PORT + (xHas() ? '' : '  (X: cookie belum diisi)'));
  threads().then(r => console.log('Threads warm: ' + r.posts.length + ' post')).catch(e => console.log('Threads warm gagal: ' + e.message));
  incidents().then(r => console.log('Peta warm: ' + r.items.length + ' titik')).catch(() => {});
  situation().then(r => console.log('Situasi warm: ' + r.total + ' insiden')).catch(() => {});
  news().then(rs => console.log('News warm: ' + rs.filter(s => s.ok).length + '/' + rs.length + ' feed')).catch(() => {});
  xposts().then(r => console.log('X warm: ' + r.posts.length + ' post' + (r.err ? ' | err: ' + String(r.err).slice(0, 160) : ''))).catch(e => console.log('X warm gagal: ' + e.message));
  setTimeout(() => warmCctv().catch(() => {}), 20000);
  setInterval(() => { warmCctv().catch(() => {}); }, 1800000);
});
