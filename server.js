// node server.js  (Node 18+, tanpa dependency)
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
  ['GNEWS · BENCANA', gn('gempa OR tsunami OR erupsi OR bencana')],
  ['GNEWS · INSIDEN', gn('kecelakaan OR ledakan OR ambruk')],
  ['GNEWS · KRIMINAL', gn('penembakan OR pembunuhan OR penangkapan OR terorisme')],
  ['GNEWS · KESEHATAN', gn('wabah OR dbd OR "flu burung" OR "stunting"')],
  ['GNEWS · EKONOMI', gn('phk OR rupiah OR bbm OR "listrik padam"')],
  ['GNEWS · POLITIK', gn('pemilu OR pilkada OR pilpres OR kpu')],
  ['GNEWS · SIBER', gn('ransomware OR "serangan siber" OR phishing OR "bocor data" OR BSSN OR "akun dibajak" OR "dompet kripto"')],
  ['GNEWS · LINGKUNGAN', gn('karhutla OR deforestasi OR "sungai tercemar" OR "sampah plastik" OR longsor OR "tambang ilegal"')],
].concat((CFG.news_extra || []).map(x => [x.id, x.url]));

const cache = new Map();
/* ---------- history buffer sosial: post lama tetap ada antar-sync & restart ---------- */
const HIST_DIR = path.join(__dirname, 'data');
const xHist = new Map(), tHist = new Map();
const histKey = p => p.url || p.text || p.code || '';
const histTs = p => p.ts || Date.parse(p.created_at || '') || 0;
const HIST_MAX = { x: 400, th: 200 }, HIST_AGE = 12 * 3600e3;
function histMerge(map, posts, max, file) {
  for (const p of posts) { const k = histKey(p); if (k) map.set(k, p); }
  const arr = [...map.entries()].map(([k, p]) => [k, histTs(p)]).sort((a, b) => b[1] - a[1]);
  const now = Date.now(), keep = new Set();
  for (const [k, ts] of arr) {
    if (keep.size >= max || now - ts > HIST_AGE) map.delete(k); else keep.add(k);
  }
  histSave(file, map, max);
}
const histSaveAt = {};
function histSave(file, map, max) {
  const now = Date.now();
  if (now - (histSaveAt[file] || 0) < 60000) return;
  histSaveAt[file] = now;
  try {
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const posts = [...map.values()].sort((a, b) => histTs(b) - histTs(a)).slice(0, max);
    fs.writeFileSync(file, JSON.stringify({ posts }));
  } catch (e) {}
}
function histLoad(file, map) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of j.posts || []) { const k = histKey(p); if (k) map.set(k, p); }
  } catch (e) {}
}
histLoad(path.join(HIST_DIR, 'x-history.json'), xHist);
histLoad(path.join(HIST_DIR, 'threads-history.json'), tHist);
const memoRetry = new Map();   // k -> jumlah retry gagal beruntun
const memo = (k, ttl, fn) => {
  const kick = () => {   // refresh background + auto-retry backoff bila gagal (self-heal tanpa nunggu request)
    const cur = cache.get(k);
    if (!cur || cur.p) return;
    cur.p = fn().then(v => { cache.set(k, { at: Date.now(), v }); memoRetry.delete(k); },
      () => {
        const now = cache.get(k);
        cache.set(k, { at: Date.now() - ttl + 15000, v: now && now.v });
        const n = (memoRetry.get(k) || 0) + 1;
        memoRetry.set(k, n);
        if (n <= 5) setTimeout(kick, Math.min(90000, 15000 * n)).unref();
      });
  };
  const c = cache.get(k);
  if (c && c.v !== undefined) {
    if (Date.now() - c.at < ttl) return Promise.resolve(c.v);
    kick();
    return Promise.resolve(c.v);
  }
  if (c && c.p) return c.p;
  const p = fn().then(v => { cache.set(k, { at: Date.now(), v }); memoRetry.delete(k); return v; },
    e => { cache.delete(k); memoRetry.delete(k); throw e; });
  cache.set(k, { at: 0, v: undefined, p }); return p;
};
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
function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const b = m[1], title = tag(b, 'title'), url = tag(b, 'link') || tag(b, 'guid'), d = tag(b, 'pubDate');
    if (title && url) out.push({ title, url, ts: d ? Date.parse(d) || 0 : 0, img: feedImage(b), pub: tag(b, 'source') || '', desc: descOf(b) });
  }
  for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
    const b = m[1], l = b.match(/<link[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*>([^<]+)<\/link>/i), d = tag(b, 'updated') || tag(b, 'published');
    if (l) out.push({ title: tag(b, 'title'), url: (l[1] || '').trim(), ts: Date.parse(d) || 0 });
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
  outer: for (const u of attempts) {
    for (let i = 0; i < 2; i++) {
      if (Date.now() - t0 > 26000) break outer;   // deadline per feed: jangan biarkan satu feed macetkan semua
      try {
        const r = await get(u, {}, 12000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const items = parseFeed(await r.text());
        if (!items.length) throw new Error('feed kosong');
        const fresh = items.filter(it => !it.ts || Date.now() - it.ts <= 36 * 3600e3);
        const newest = Math.max(0, ...fresh.map(i => i.ts || 0));
        return { id, ok: true, stale: !!(newest && Date.now() - newest > 3 * 3600e3), items: fresh.slice(0, 100).map(it => ({ ...it, title: cleanTitle(it.title), src: id })), at: Date.now() };
      } catch (e) {
        lastErr = String(e.message || e);
        if (i === 0) await new Promise(res => setTimeout(res, 350));
      }
    }
  }
  return { id, ok: false, err: ('gagal direct + proxy: ' + lastErr).slice(0, 140), items: [] };
})));

/* ---------- taksonomi: insiden fisik (geo) + topik sosial ---------- */
// geo:true = kejadian fisik/lokal → boleh jadi pin peta, node globe, dan masuk marquee.
// geo:false = topik naratif (ekonomi, politik, siber) → hanya News Wire & statistik situasi.
const CATS = [
  { id:'demo', label:'Demo', sev:0.82, geo:true, re:/(\bdemo\b(?!\s*(aplikasi|game|produk|sistem|fitur|cara|tutorial))|unjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|\bmassa\b|long march|audiensi)/i },
  { id:'fire', label:'Kebakaran', sev:0.96, geo:true, re:/(kebakaran|karhutla|kebakaran hutan|kebakaran lahan|terbakar|kobaran api|asap tebal)/i },
  { id:'flood', label:'Banjir', sev:0.86, geo:true, re:/(banjir|genangan|longsor|tanah longsor|cuaca ekstrem|hujan deras|\brob\b)/i },
  { id:'disaster', label:'Bencana', sev:1, geo:true, re:/(gempa|tsunami|erupsi|letusan|bencana|evakuasi|korban jiwa|ambruk|tenggelam|hanyut|banjir bandang)/i },
  { id:'insiden', label:'Insiden', sev:0.62, geo:true, re:/(kecelakaan|ledakan|pohon tumbang|runtuh|tabrakan|tabrak lari|kapal karam|pesawat jatuh|tergelincir|terjun)/i },
  { id:'siber', label:'Siber', sev:0.55, geo:false, re:/(peretasan|peretas|hacker|ransomware|phishing|malware|ddos|botnet|zero[- ]day|kebocoran data|bocor data|data breach|pencurian data|akun dibajak|akun palsu|scam|penipuan online|pinjol ilegal|investasi bodong|bssn|badan siber|serangan siber|serangan cyber|insiden keamanan|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|layanan lumpuh|situs lumpuh|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|akun (media sosial|instagram|facebook|whatsapp|telegram|x) dibajak)/i },
  { id:'kriminal', label:'Kriminal', sev:0.78, geo:true, re:/(penembakan|pembunuhan|pengeroyokan|begal|curat|pencurian|perampokan|penangkapan|ditangkap|tersangka|kabur dari lapas|napi kabur|terorisme|radikalisasi|suap|gratifikasi|penipuan|narkoba|psikotropika|penculikan|perkosaan|rudapaksa)/i },
  { id:'kesehatan', label:'Kesehatan', sev:0.6, geo:true, re:/(wabah|dbd|demam berdarah|covid|korona|flu burung|h1n1|malaria|tuberkulosis|\btb\b|diare|keracunan|stunting|obesitas|vaksin|imunisasi|kemenkes|bpom|faskes|puskesmas|gagal ginjal|kanker)/i },
  { id:'ekonomi', label:'Ekonomi', sev:0.5, geo:false, re:/(phk|rupiah|kurs dollar|inflasi|defisit|apbn|apbd|ihsg|bursa efek|saham|emiten|dividen|stock split|buyback|right issue|utang negara|subsidi|bbm|pertamax|solar|listrik padam|padam listrik|pemadaman listrik|pertamina|\bpln\b|ojk|bank indonesia|umk\b|ump\b|thr\b|belanja negara|bea cukai|ekspor|impor|suku bunga|bappebti|kripto|bitcoin|pinjol|fintech|paylater|harga (cabai|beras|daging|minyak|emas))/i },
  { id:'politik', label:'Politik', sev:0.55, geo:false, re:/(pilpres|pilkada|pemilu|kpu\b|capres|cawapres|\bdpr\b|\bdprd\b|parlemen|pelantikan|menteri|wakil presiden|\bistana\b|bansos|rapat paripurna|mahkamah konstitusi|impeachment|program mbg|makan bergizi)/i }
];
const SKIP_RE = /(pascabencana|pascagempa|pascabanjir|mitigasi|kesiapsiagaan|potensi bencana|rawan bencana|risiko bencana|kajian risiko|simulasi|edukasi|sosialisasi|pelatihan|antisipasi|siaga bencana|hadapi bencana|menghadapi bencana|peringatan dini|early warning|asuransi|operasi patuh|imbau|himbau|ingatkan|waspada|waspadai|ranperda|perda|godok|korupsi|dana bencana|modus|ruu|boikot dirinya|joget|liga|top skor|voli|sepak bola|piala|kualifikasi|gaun|mahalini|fashion|penghargaan|jasa raharja|warisan|turun-temurun|sepanjang 20\d\d|berdampak ke ekonomi|brasil|brazil|amerika serikat|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza)/i;
const catMeta = id => CATS.find(c => c.id === id) || { id:'', label:'Insiden', sev:0.5, geo:true };
const catOf = t => SKIP_RE.test(t) ? '' : ((CATS.find(c => c.re.test(t)) || {}).id || '');
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
      if (age > 36 * 3600e3) continue;
      const recency = Math.max(0.12, Math.exp(-age / (16 * 3600e3)));
      const meta = catMeta(cat);
      items.push({ ...it, src: s.id, cat, label: meta.label, score: +(meta.sev * recency).toFixed(3) });
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
  return { ok: true, items: ranked, total: matched, at: Date.now(), cycle: 45 };
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
        if (m) return m[1];
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
async function xSearch(q) {
  const id = await xQueryId();
  const vars = { rawQuery: q, count: 20, querySource: 'typed_query', product: 'Latest' };
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
  if (!out.size && j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return [...out.values()].map(p => ({ ...p, q }));
}
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
const xposts = () => memo('x', 300000, async () => {
  const tr = (await trendingQueries()).slice(0, 4);
  const base = (X.queries || []).slice(0, 8);
  const queries = base.concat(tr.filter(t => !base.includes(String(t).toLowerCase()))).slice(0, 10);
  if (!xHas()) return { ok: false, err: 'auth_token / ct0 belum diisi di config.json', posts: [], queries, trending: tr };
  const all = new Map(), errs = [];
  // paralel per 5 query: sinkron tetap cepat, satu query gagal tidak menjatuhkan yang lain
  for (let i = 0; i < queries.length; i += 5) {
    const chunk = queries.slice(i, i + 5);
    const rs = await Promise.allSettled(chunk.map(q => xSearch(q)));
    rs.forEach((r, j) => {
      const q = chunk[j];
      if (r.status === 'rejected') { errs.push(q + ': ' + String(r.reason && r.reason.message || r.reason)); return; }
      for (const p of r.value) {
        const key = p.url || p.text;
        const ex = all.get(key);
        if (ex) { if (!ex.qs.includes(q)) ex.qs.push(q); }
        else all.set(key, { ...p, q, qs: [q] });
      }
    });
  }
  // tiap query dijamin punya wakil: 6 teratas per query, sisanya diisi yang terhangat
  const byQ = new Map();
  for (const p of all.values()) for (const q of p.qs || [p.q]) {
    if (!byQ.has(q)) byQ.set(q, []);
    byQ.get(q).push(p);
  }
  const picked = new Set(), pool = [];
  for (const arr of byQ.values()) {
    arr.sort((a, b) => b.ts - a.ts);
    for (const p of arr.slice(0, 6)) { picked.add(p); pool.push(p); }
  }
  const rest = [...all.values()].filter(p => !picked.has(p)).sort((a, b) => b.ts - a.ts);
  const batch = pool.concat(rest).sort((a, b) => b.ts - a.ts).slice(0, 160);
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  const posts = [...xHist.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, HIST_MAX.x);
  return { ok: posts.length > 0, err: errs.join(' | '), posts, queries, trending: tr, at: Date.now() };
});
/* ---------- X lazy: satu query trending on-demand, merge ke history ---------- */
const xqLazy = q => memo('xq:' + String(q).toLowerCase(), 600000, async () => {
  if (!xHas()) throw new Error('auth_token / ct0 belum diisi');
  const rs = await xSearch(q);
  const now = Date.now();
  const batch = rs.filter(p => p.ts && now - p.ts < 48 * 3600e3)
    .map(p => ({ ...p, q, qs: [q] })).slice(0, 20);
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  return [...xHist.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, HIST_MAX.x);
});

/* ---------- Threads: toolzerhub/threads-scraper (MIT) lewat worker Python ---------- */
const { execFile } = require('child_process');
const TH = CFG.threads || {};
const TH_QUERIES = TH.queries || ['demo indonesia', 'unjuk rasa', 'kebakaran', 'banjir', 'karhutla'];
const TH_RE = INCIDENT_RE;
const PY_BIN = [
  TH.python,
  path.join(__dirname, '.venv', 'bin', 'python'),
  path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
  'python3'
].filter(Boolean).find(p => p === 'python3' || fs.existsSync(p));
const threads = () => memo('threads', 240000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan. Jalankan: python3 -m venv .venv && .venv/bin/pip install curl_cffi');
  // Threads worker sequential per query (timeout 200s total) → jatah adaptif lebih kecil
  const tr = (await trendingQueries()).slice(0, 3);
  const baseT = TH_QUERIES.map(q => String(q).toLowerCase());
  const queries = TH_QUERIES.concat(tr.filter(t => !baseT.includes(String(t).toLowerCase())));
  const raw = await new Promise((resolve, reject) => {
    execFile(PY_BIN, [path.join(__dirname, 'vendor', 'threads_worker.py'), JSON.stringify(queries)],
      { timeout: 200000, maxBuffer: 12 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).replace(/\s+/g, ' ').slice(0, 240)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('worker bukan JSON valid')); }
      });
  });
  const now = Date.now();
  const batch = (raw.posts || [])
    .filter(p => p && p.code && p.text && TH_RE.test(p.text))
    .filter(p => !p.created_at || now - Date.parse(p.created_at) < 96 * 3600e3)
    .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
    .slice(0, 48);
  histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
  const posts = [...tHist.values()].sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, HIST_MAX.th);
  return { ok: posts.length > 0, posts, errs: raw.errs || [], queries, trending: tr, at: Date.now() };
});

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
  const trim = a => a.filter(x => { if (n++ > 40) return false; x.kids = trim(x.kids); return true; });
  return trim(roots);
}
const xThread = (id) => memo('xth:' + id, 300000, async () => {
  let post = null, err = '';
  try { post = await synTweet(id); } catch (e) { err = e.message; }
  let flat = [];
  try { flat = await xSearch('conversation_id:' + id); } catch (e) { err = err || e.message; }
  if (!post && !flat.length) throw new Error(err || 'post tidak ditemukan');
  if (!post && flat.length) {
    const f = flat.find(p => p.id === id) || flat[0];
    post = { ...f, replies: f.replies || flat.length };
  }
  // Nested replies point at parents the search page did not return. Pull those
  // few parents so the tree can actually nest instead of flattening everything.
  const known = new Set(flat.map(p => p.id));
  const missing = [...new Set(flat.map(p => p.parent).filter(pid => pid && pid !== id && !known.has(pid)))].slice(0, 8);
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
const PLACES = [
  // Jakarta & Jabodetabek
  { name: 'Istana Merdeka', la: -6.1702, lo: 106.8272, re: /\bistana\b|istana negara|istana merdeka/i },
  { name: 'DPR / MPR Senayan', la: -6.2185, lo: 106.8002, re: /\bdpr\b|\bmpr\b|senayan|parlemen|komisi iii/i },
  { name: 'Monas · Medan Merdeka', la: -6.1754, lo: 106.8272, re: /monas|medan merdeka|lapangan banteng|patung kuda|harmoni/i },
  { name: 'Jakarta', la: -6.2088, lo: 106.8456, re: /jakarta|dki|tanah abang|kemayoran|cilandak|kebayoran|polda metro|duri kepa|kebon jeruk|penjaringan|cakung|pasar minggu|kepulauan ?seribu|pulau ?seribu/i },
  { name: 'Bogor', la: -6.5971, lo: 106.8060, re: /bogor|sentul|cibinong|ciawi/i },
  { name: 'Depok', la: -6.4025, lo: 106.7942, re: /\bdepok\b/i },
  { name: 'Tangerang', la: -6.1781, lo: 106.6319, re: /tangerang|serpong|\bbsd\b|bintaro/i },
  { name: 'Bekasi', la: -6.2383, lo: 106.9756, re: /bekasi|cikarang|purwakarta/i },
  { name: 'Karawang', la: -6.3086, lo: 107.2997, re: /karawang|cikampek|jatisari|klari|tirtamulya/i },
  { name: 'Cilegon', la: -6.0192, lo: 106.0713, re: /\bcilegon\b/i },
  { name: 'Serang', la: -6.1201, lo: 106.1503, re: /\bserang\b/i },
  { name: 'Pandeglang', la: -6.4957, lo: 106.1919, re: /pandeglang|\blebak\b/i },
  // Jawa Barat — spesifik dulu, Bandung (dengan 'jawa barat') paling akhir
  { name: 'Sukabumi', la: -6.9276, lo: 106.9286, re: /\bsukabumi\b/i },
  { name: 'Ciamis', la: -7.3169, lo: 107.3506, re: /\bciamis\b/i },
  { name: 'Cirebon', la: -6.7329, lo: 108.5521, re: /\bcirebon\b|kraton cirebon/i },
  { name: 'Kuningan', la: -6.9806, lo: 108.4824, re: /\bkuningan\b/i },
  { name: 'Sumedang', la: -6.8483, lo: 107.9237, re: /\bsumedang\b/i },
  { name: 'Majalengka', la: -6.8369, lo: 108.2358, re: /majalengka|majalenka/i },
  { name: 'Subang', la: -6.5701, lo: 107.7596, re: /\bsubang\b/i },
  { name: 'Indramayu', la: -6.3520, lo: 108.3226, re: /\bindramayu\b/i },
  { name: 'Garut', la: -7.1507, lo: 107.9008, re: /\bgarut\b/i },
  { name: 'Tasikmalaya', la: -7.3271, lo: 108.2192, re: /tasikmalaya|\btasik\b/i },
  { name: 'Cianjur', la: -6.8167, lo: 107.1394, re: /\bcianjur\b/i },
  { name: 'Pangandaran', la: -7.6479, lo: 108.4874, re: /pangandaran|\bpangand\b/i },
  { name: 'Majalaya', la: -7.1370, lo: 107.3960, re: /majalaya|leuwimunding|cimanggu|cibodas|padamukti|mekargaluyu|wangunharja|taktajan|sirnagalih|cireundeu|sukawangi|tanjungsari/i },
  { name: 'Bandung', la: -6.9175, lo: 107.6191, re: /bandung|jawa ?barat|\bjabar\b|cimahi|lembang|cimenyan|ciburuy|pangalengan|rinanti|arcamanik|ciparay|cililin|cileunyi|cibiru|cidadap|sukahaji|supratman|isola|antapani|regol|dayeuhkolot|gileleang|pangantenan|sarijadi|sukamaju|cicalengka|cimaung|cingin/i },
  // Jawa Tengah & DIY — spesifik dulu, Semarang (dengan 'jawa tengah') terakhir
  { name: 'Solo', la: -7.5755, lo: 110.8243, re: /\bsolo\b|surakarta|jebres|laweyan|serengan|pasar kliwon|mojosongo|ketelan|nusukan/i },
  { name: 'Boyolali', la: -7.5361, lo: 110.6014, re: /boyolali|gladag|nogosari|tulung|wonosegoro|ceceran|sambi|genteng|klaret|srowo/i },
  { name: 'Yogyakarta', la: -7.7956, lo: 110.3695, re: /yogyakarta|jogja|\bdiy\b|sleman|bantul|kulon progo|gunung kidul|kalasan|ngaglik|ngawen|sedayu|sanden|piyungan|prambanan|wonosari|yogya/i },
  { name: 'Gunung Merapi', la: -7.5400, lo: 110.4420, re: /\bmerapi\b/i },
  { name: 'Klaten', la: -7.7014, lo: 110.6044, re: /klaten|ceper|gayam|banyudono|klirong|prambanan|kemusu|wedi|polanharjo|trucuk|delanggu|jrakah|klego/i },
  { name: 'Sukoharjo', la: -7.6590, lo: 110.8294, re: /sukoharjo|mojogedang|baki|tasikmadu|ketenger|weru|grogol|sambirejo|ngamplang|bendosari|nguter/i },
  { name: 'Sragen', la: -7.4326, lo: 111.0218, re: /sragen|gemolong|nonogan|tanjonan|mangunharjo|gesi|kaliaman|sumberlawang|kedawung|tanon/i },
  { name: 'Karanganyar', la: -7.5560, lo: 110.9778, re: /karanganyar|kartasura|nongkosawit|pringapus|jumapolo|jaten|kelir|poncogati|tawang|kemarang|mangunsari|plupuh|sabrang|delik|ngargoyoso|jumantoro/i },
  { name: 'Wonogiri', la: -7.8629, lo: 110.9298, re: /wonogiri|baturetno|tirtomoyo|giritontro|gudangan|manyaran|selotopo|padas|bayat|ngadirojo/i },
  { name: 'Grobogan', la: -7.0799, lo: 110.9289, re: /grobogan|ngasu|ngemplak|kedonglimpul|gondang|karangrowo|plamongan|tawangharjo|wirosari|gopuro|ngandong/i },
  { name: 'Rembang', la: -6.7198, lo: 111.3937, re: /rembang|sumberpucung|tambak|bulu|pamotan|lasem|sedan|kragan|klakar|suwal|pancur|ampel|rajeg|sumbergriyo|trangkil|wangun|glagahkulon|sumberom/i },
  { name: 'Jepara', la: -6.5971, lo: 110.6697, re: /jepara|mundu|keling|bangsri|donorojo|kroyo|keritang|kubangharjo|mulyoharjo|winongan|mayong|karimun ?jawa/i },
  { name: 'Kendal', la: -6.9600, lo: 110.1611, re: /kendal|boja|wlingi|kangkung|ngampel|brangsong|kranggan|sendang|ngalar|candisari|gemuh|manggoran|ngadirejo|paseh|joho|jogo|ngaliyan|nagan|purwo|yogo|trosono|kaliwungu/i },
  { name: 'Pekalongan', la: -6.8894, lo: 109.6752, re: /pekalongan|wirokuwo|ijjas|limbangan|kandri|buaran|kemangi|kelangan|warungpring|karangdadap|beji|pasirsari|siyono|notopuro|pejarakan|srengseng|tirto|paninggaran|trebulyo|jatibarang|penawangan/i },
  { name: 'Tegal', la: -6.8713, lo: 109.1402, re: /\btegal\b|slawi|matahari|rejotangan|dadeya|suradadi|balokang|jasinga|muaradani|talang|girus|kramat|sudira|pagu|cabong|bonang|sinapuk|sinaria|kerang|tarub|prajurit|bategede/i },
  { name: 'Brebes', la: -6.8571, lo: 109.0431, re: /brebes|klampok|jambu|bumiayu|sirampog|bantarkawung|kertasemaya|kasemen|sidomukti|kutabawa|susukan|randugunting|ketanggungan|tanah ampel|notogoro|boto|ciber|lumbung|karangsuwung|krembugan|kakutjapan/i },
  { name: 'Pemalang', la: -6.8912, lo: 109.3826, re: /pemalang|petarukan|mrandakan|pulosari|comal|kebondalem|randanan|sidorejo|pelawangan|petung|siwalan|wonokerto|grabag/i },
  { name: 'Cilacap', la: -7.6337, lo: 109.0156, re: /cilacap|binangun|jeruklegi|gimanja|padaherang|wanayasa|sidawangi|sidareja|adipala|baturraden|wangon|karangrejo|kawung|kudang|kutawinang|lumbungrejo|sidamulya|sokaraja|tunggal|donorejo/i },
  { name: 'Banjarnegara', la: -7.4027, lo: 109.6653, re: /banjarnegara|wanadadi|pesarean|purwanegara|tembung|medi|rawayan|klanggot|banjarwinangun|sorowajan|sidakan|banyunur|sukareja|randegan|kaliangkrik/i },
  { name: 'Purbalingga', la: -7.4409, lo: 109.3558, re: /purbalingga|kutasari|kalibawang|padakasih|madukara|sudimara|bantarsoka|karangmoncol|karangjaya|kawunganten|pengadingan|karangsari|rencana|gumbel|sragi|mrebet|kajatan|darangdan|karangdawa|gringsing|kwitang|widuran|karangkamulyan/i },
  { name: 'Kebumen', la: -7.6693, lo: 109.6659, re: /kebumen|prembun|bulusari|juginawan|puring|klambu|murtigading|gombong|sawer|wargon|mendo|kaduged|karet|penggung|selarong|kalijambe|patuk|wadaslimuluh|wonodadi|palirang|bendungan/i },
  { name: 'Purworejo', la: -7.7164, lo: 109.9223, re: /purworejo|kajoran|kledung|ngombol|bandungan|bandongan|kukar|kemantren|pakis|penggasin|sendangagung|setulu|tegalrejo|wangon|wirogrobo|payaman|ngelo|kledungan|gudur|kradenan/i },
  { name: 'Wonosobo', la: -7.3700, lo: 109.9040, re: /wonosobo|kaliwiro|batuuripiro|leksono|ngawen|plosorejo|selomerto|selosari|tingkir|sookoho|danasari|watukiskoro|kaliangserut|jepon|sindara|batur|wapeng|kalisowo|madukoro|mayang|mintaragen|ngadipiro|parakan|suwandono|taliwang/i },
  { name: 'Temanggung', la: -7.3167, lo: 110.2050, re: /temanggung|kranggan|ngatu|prono|tretep|wadeng|gubug|grogan|bansari|bekasan|brangsoko|grobogan|gumuk|jenggawah|kanjeng|kayumenyan|klipar|krasakan|lanang|mulyosari|ngitirejo|padas|pandansari|paras|parakan|penawangan|pijajar|randugunting|sandungan|sanijayan|selorejo|slogoh|sodo|sumberejo|tanggerang|tangen|temas|tenglengan|terban|tresnorejo|tunggul|wayoro|wonokarto|wonokromo|wonorejo|wora|wuryantoro/i },
  { name: 'Magelang', la: -7.4698, lo: 110.2187, re: /magelang|mungkid|secang|\bselo\b|ngadipuro|krajan|ngemudung|ngentang|padangroyo|plosorejo|pritigading|sumurjoyo|tuntang|windusari/i },
  { name: 'Kudus', la: -6.8067, lo: 110.8438, re: /\bkudus\b|dawe|geneng|jekulo|kalibenda|kangkung|kaliwungu|pantai|karangsampean|keling|menggar|ngareyan|palang|tambakromo|ungu|undaan|wangon|welahan|juni|bakal|krandekan|mejoho|ngaruh|pawon|ploso|temulus|diwek|judan|kandeman|wawar/i },
  { name: 'Demak', la: -6.8947, lo: 110.6409, re: /\bdemak\b|grogol|mijen|mojo|wonokerto|wonosari|febr|mojolaban|bendan|derap|gajah|gadingsari|sroi|sinartopo|sumur|wonorejo|wonomarto|wonopringgo|wonoyoso|keteleng/i },
  { name: 'Pati', la: -6.7581, lo: 111.0058, re: /\bpati\b|pekelong|sigaluh|tukul|jagalan|jaken|bugel|padureso|parengon|cabean|turem|kaduang|kemiri|angonan|negr|tamansari|wonokromo|wurorejo|tirem|mrebet/i },
  { name: 'Semarang', la: -6.9932, lo: 110.4203, re: /semarang|jawa tengah|\bjateng\b|salatiga|sinten|sintang|pringsijat|gunungpati|manyaran|\btugu\b|ngaliyan|palebon|pucangsawit|gajahmiring|tanahmas|karangturi|gondomulyo|glenmore|sugihwaras|tlogosari|tanjungmoro|banyumanik|gundih|wonoplumbon|sawojajar|gondangrejo|meteseh|pedurungan/i },
  // Jawa Timur — spesifik dulu, Surabaya (dengan 'jawa timur') terakhir
  { name: 'Malang', la: -7.9666, lo: 112.6326, re: /malang|kota batu|singosari|pakis|ngantang|puyo|wajak|dau|bululawang|turen/i },
  { name: 'Kediri', la: -7.8196, lo: 112.0187, re: /kediri|kandat|plosoklat|dandangan|katang|ngadiluwih|pabian|purwoasri|tarok|cepogo|jabung|klampukan/i },
  { name: 'Blitar', la: -8.0941, lo: 112.1680, re: /blitar|kanigoro|wonorejo|wonotirto|garum|sanankerto|kunduran|talun|selopadhar|kesamben|kalibabat|tegalombo|kunir|kademangan|winong/i },
  { name: 'Madiun', la: -7.6298, lo: 111.5233, re: /madiun|caruban|sawahan|klego|saradan|maospati|ballet|dongi|gingkas|ngebel|ngawe|panekan|ploso|tanjungsari|yuan|bobot|caringin|dungus|kati|srondol|tritunggal|wonorejo/i },
  { name: 'Jombang', la: -7.5516, lo: 112.2358, re: /jombang|mojokerto|trowulan|sumobito|peterongan|berbek|gudo|wonoasri|ploso|mentoro|\bkudu\b|tempel|dare|geluk|gosari|jerukwangi|gondang|puter|ceket/i },
  { name: 'Nganjuk', la: -7.6000, lo: 111.8780, re: /nganjuk|kertosono|wilangan|dodolak|prambon|bandrek|pacet|dempet|gadging|gajebang|geneng|gempol|rejoagung|wilmantoro|sukontoro|glagah|mantup|kentheng|sawahan|ngetos|setren|tawangharjo|tindih/i },
  { name: 'Pasuruan', la: -7.6516, lo: 112.9168, re: /pasuruan|prigen|pandaan|gempol|punggur|pasan|waru|watangsari|gramak|johar|kemang|bangil|sresmo|mororejo|binginwangi|klekok|donomulyo|mentung|ngasam|purwodadi|sawo|setunggal|sindang|sumberpasir|sumberrejo|tongas|tropodo|watesrejo|wonoasri/i },
  { name: 'Probolinggo', la: -7.7504, lo: 113.2117, re: /probolinggo|lumajang|kraksaan|srono|pasirian|pancur|sumbersari|tembayan|alen-alen|cliung|kedawung|kembangbahu|klakah|meru|poncosari|randuacir|ringintembok|senduro|sumberrejo|sumberwaru|tegalsari|kelud/i },
  { name: 'Jember', la: -8.1847, lo: 113.6709, re: /jember|situbondo|kalisat|tanggul|kencong|puger|ambulu|balung|sukowono|tempurejo|kali anyar|arjasa|gruyang|wuluhan|mumbulsari|tunjungan/i },
  { name: 'Banyuwangi', la: -8.2167, lo: 114.3708, re: /banyuwangi|bondowoso|silir agung|rahang kencong|glagah|kalibaru|kembirit|muncar|\btenggar\b|giri ayu|songgon|randuagung|wongsorejo/i },
  { name: 'Bojonegoro', la: -7.1530, lo: 111.8817, re: /bojonegoro|tuban|widodaren|babat|kebonsari|ngoro|mlati|dander|bengawan|kapas|plumpuhan|ngasem|sampuran|tarik|kanor|padangan|sepuluh|teluk|tembung|widang|wonotrik|bojong/i },
  { name: 'Ngawi', la: -7.1087, lo: 111.4523, re: /ngawi|magetan|ponorogo|maospati|geneng|wungu|pancung|kuniran|ngrandah|babadan|menjangan|paker|pulutan|sukorato/i },
  { name: 'Lamongan', la: -7.1245, lo: 112.4578, re: /lamongan|brondong|mlakah|sukolilo|sugihwaras|kedungtuban|sumberbening|kalibohwono|babakan|tanah merah|perbaungan|sukomoro|tedjo|karanggeneng|karangpilang|carikan|ngumbu|ngobo|plosowangi|plosopatik|sidokare|sidomulyo|panciran|panceng|pancuran|srondol|tanahbrojo|tirtoyudo|tulen|wotan|sambong/i },
  { name: 'Pacitan', la: -8.0369, lo: 111.0968, re: /pacitan|trenggalek|tulungagung|plered|pucuk|sampung|karangdowo|polosan|punakawan|besuki|gondang|jirak|kembangsore|kunen|ngadirojo|nglegok|plompong|puluran|sumberagung|sumberbening|\btugu\b|wadak|wapung|wonosari/i },
  { name: 'Gunung Bromo', la: -7.9425, lo: 112.9530, re: /\bbromo\b/i },
  { name: 'Gunung Semeru', la: -8.1080, lo: 112.9700, re: /\bsemeru\b/i },
  { name: 'Gunung Kelud', la: -7.9333, lo: 112.3000, re: /\bkelud\b/i },
  { name: 'Surabaya', la: -7.2575, lo: 112.7521, re: /surabaya|jawa timur|\bjatim\b|sidoarjo|gresik|bengawan|driyorejo|godong|gonagan|krian|mrandu|porong|sampean|sukodono|tanggulangin|wonoayu/i },
  // Sumatera
  { name: 'Medan', la: 3.5952, lo: 98.6722, re: /medan|sumatera ?utara|\bsumut\b|simalungun|deli ?serdang|\bkaro\b|binjai|tanjung ?balai|tebing ?tinggi|padang ?sidimpuan|padang ?lawas|tapanuli|labuhan ?batu|asahan|dairi|mandailing|langkat|panai|naras|sinaloan|dangir|marbau|secanggang|tanjung ?morawa|hamparan ?perak|beringin|delitua|namorambe|patumbak|sawit ?seberang|simanindo|sunggal|marlang|kisaran|rantau ?prapat|pematang ?siantar/i },
  { name: 'Bukittinggi', la: -0.3054, lo: 100.3708, re: /bukittinggi|payakumbuh|tanah dato|tanahdatar|\bagam\b|iv koto|parambahan|lubuk alung|sitiung|ampek/i },
  { name: 'Sawah Lunto', la: -0.6809, lo: 100.8214, re: /sawah lunto|sijunjung|darmasraya|silaut|lirik|caniago|gusn/i },
  { name: 'Solok', la: -0.8085, lo: 101.1447, re: /\bsolok\b|solok selatan|pantai cifor|lembah anai|painan|pasaman|pasaman barat|silok|jematan|luak|sumpur/i },
  { name: 'Padang', la: -0.9471, lo: 100.4172, re: /padang|sumatera ?barat|\bsumbar\b|pariaman|padang ?panjang|limapuluh ?kota|padang ?pariaman|koto ?baru|koto ?besi|sitiung|air ?bangis/i },
  { name: 'Batam', la: 1.1301, lo: 104.0529, re: /batam|kepulauan ?riau|kepri|tanjung ?pinang|bintan|karimun|natuna|lingga|tanjung ?limau|serasan|ranai|pangkil|sungailiat|mapur|barelang|subi/i },
  { name: 'Pekanbaru', la: 0.5071, lo: 101.4478, re: /pekanbaru|\briau\b|dumai|bengkalis|siak|kampar|rohil|rokan|batu ?hirang|indragiri|pelalawan|tapung|tembilahan|besitang/i },
  { name: 'Jambi', la: -1.6101, lo: 103.6131, re: /\bjambi\b|muaro jambi|tungkal|tanjung jabung|kerinci|sungaipenuh|merangin|batanghari|muara bulian|muara pemula|sengeti|singingi|tungkal ilir|tungkal ulu|bujang gadis|sungei gelam/i },
  { name: 'Bengkulu', la: -3.7904, lo: 102.2578, re: /bengkulu|kepahiang|rejang|mukomuko|seluma|kaironi|kota agung|manna|pino|pantai serut|tanjungduren/i },
  { name: 'Pangkal Pinang', la: -2.1314, lo: 106.1151, re: /pangkal pinang|\bbangka\b|\bbelitung\b|belitung|bangka|tanjungpandan|peken|pemali|tempelang|kura|sijuk|simangunsong|senggarang|kuala kampung|ujung genteng|air kolong|sicantik/i },
  { name: 'Palembang', la: -2.9761, lo: 104.7754, re: /palembang|sumatera selatan|\bsumsel\b|ogan ilir|prabumulih|lahat|muara enim|banyuasin|komering|penukal|empatlawan|pagaralam|gorang lebar|bagieng|sukaeri|tanahkago|tranum/i },
  { name: 'Bandar Lampung', la: -5.3971, lo: 105.2668, re: /lampung|tulang bawang|mesuji|pringsewu|tanggamus|pesawaran|way kanan|kalianda|jati agung|seputih|kerasaman|kemiling|ratu ambaling|raja basa|raja jogi|raja mas|raja puri|sukajadi|tegalsari|teluk betung|terbanggi|terbung|way jiwo|wiyono/i },
  { name: 'Banda Aceh', la: 5.5483, lo: 95.3238, re: /\baceh\b|banda aceh|langsa|pidie|lhokseumawe|aceh tengah|aceh utara|aceh timur|aceh selatan|aceh barat|aceh singkil|singkil|bener meriah|gayo lues|nagan raya|subulussalam|aceh jaya|aceh tamiang|calang|\bgayo\b|kuta alam|meulaboh|sabang|seulawah|beutong|bireuen|gegur|jantho|kuta cane|lhok ukur|lut|meureudu|muara dua|nagan|nomploh|peusangan|praya/i },
  // Kalimantan
  { name: 'Pontianak', la: -0.0263, lo: 109.3425, re: /pontianak|kalimantan barat|\bkalbar\b|sambas|ketapang|sanggau|sekadau|melawi|kapuas hulu|landak|sintang|singkawang|ngabang|putussibau|sejahtera|kentapang|kubing|menjalin|sepawak|simanggang|stambak|subah|entikong|badau|bengkung/i },
  { name: 'Palangka Raya', la: -2.2080, lo: 113.9165, re: /palangka raya|kalimantan tengah|\bkalteng\b|kotim|kotawaringin|mentaya|sampit|kapuas|katingan|barito|gunung mas|pulau pisau|murung raya|barito utara|barito selatan|sukamara|lamandau|seruyan|residen|laung|mendawai|menyawa|tanambul|tanjungsari|tartono|teweh/i },
  { name: 'Banjarmasin', la: -3.3186, lo: 114.5944, re: /banjarmasin|kalimantan selatan|\bkalsel\b|kabupaten banjar|martapura|hulu sungai|tanah laut|tabalong|balangan|tapin|banjarbaru|barabai|kotabaru|tanah bumbu|tanahbumbu|batulicin|ambawang|masinggaling|marabahan|satui/i },
  { name: 'Balikpapan', la: -1.2379, lo: 116.8529, re: /balikpapan|samarinda|kalimantan timur|\bkaltim\b|\bikn\b|ibu kota nusantara|berau|kutai|penajam|mahakam|tana tindung|paser|bontang|tanah gro|manggar|sepaku|sengatta|waropen/i },
  { name: 'Tarakan', la: 3.3274, lo: 117.5759, re: /tarakan|kalimantan utara|\bkaltara\b|bulungan|malinau|nunukan|krayan|kayan|sedalir|apau|kekayan|lubok|mayong|pangalungan|seko/i },
  // Sulawesi — Toraja & Gorontalo dulu (keyword 'bone bolango'/'toraja' jangan ketarik Makassar)
  { name: 'Toraja', la: -3.3231, lo: 119.8893, re: /tana toraja|\btoraja\b|rantepao|makale|barru|malangking|posi|sekesu|sanggala|tangke|rindingallo|sangalla|bastem|baruppu|balutu|londok|maddare|malangpong|nanggala/i },
  { name: 'Gorontalo', la: 0.5435, lo: 123.0568, re: /gorontalo|boalemo|bone bolango|tilamuta|pohuwato|nangala|mondulo|talumono|buntar|lakevo|duantolotolonga|sanoyan|tapa|tiagu|beo|pilombayan|monano|dulangio|randang|pasimbulaan/i },
  { name: 'Makassar', la: -5.1477, lo: 119.4327, re: /makassar|sulawesi selatan|\bsulsel\b|gowa|maros|bantaeng|jeneponto|sinjai|wajo|soppeng|pinrang|sidrap|luwu|enrekang|luwu timur|luwu utara|luwu selatan|palopo|sidenreng|bangkala|suppa|takerada|majang|baranti|diatalang|malangke|panca|ponco/i },
  { name: 'Manado', la: 1.4748, lo: 124.8421, re: /manado|sulawesi utara|\bsulut\b|bitung|minahasa|tomohon|tondano|kotamobagu|bolmut|sangihe|siau|talaud|tatab|moum|bahona|duluduo|kema|tabukan|kempatmaub|keke|pulutan|ratatotok|sinonsayang|talawakao|ungunen|woloan|biaro|buski|ewot|hatub|kowili|melalan|nani|pinet|sawangan|tibo|toraket|tobelo|taliabu|galela|morotai/i },
  { name: 'Palu', la: -0.8917, lo: 119.8707, re: /\bpalu\b|sulawesi ?tengah|\bsulteng\b|luwuk|banggai|\bposo\b|morowali|tojo una una|\bsigi\b|donggala|toli-toli|sigili|\bparigi\b(?!\s*moutong)|sabudaya|tabarpa|tobaku|\bdolo\b|alakia|sidokan|tana polo|tomarasa|tomudu|\bumbara\b|\btambul\b|subpe|\bturen\b|\bsambak\b|tanalili|wonodaa|wonopanggo/i },
  { name: 'Kendari', la: -3.9985, lo: 122.5130, re: /kendari|sulawesi tenggara|\bsultra\b|kolaka|bau-bau|baubau|buton|\bmuna\b|una-una|lahu|wangi-wangi|menui|bondoala|kuepi|takabe|tawaili|towuti|trawak|ulubulu|wasu|melolo|mowewe|latambaga|muni|pohuwato|parigi ?moutong|duruka|tiworo|lasusua/i },
  { name: 'Mamuju', la: -2.6748, lo: 118.8884, re: /mamuju|sulawesi barat|\bsulbar\b|polewali|mamasa|pasangkayu|mamuju tengah|budong|bubulan|daddolo|masameng|kayalu|talingo|taluma|mamuju utara|sagadung|padanglobak|tambun|tange|tomarasi|tumbocakti|kalumpang|bontotalli|dali|galesong|masapait|margabakti|masena|matano|mongalen/i },
  // Nusa Tenggara — Pelaga dulu sebelum Denpasar ('\bbali\b' menelan)
  { name: 'Pelaga', la: -8.3600, lo: 115.3500, re: /\bpelaga\b/i },
  { name: 'Denpasar', la: -8.6705, lo: 115.2126, re: /denpasar|\bbali\b|badung|kuta|gianyar|tabanan|buleleng|jembrana|bangli|karangasem|singaraja|amlapura|semarapura|tegalalang|ubud|sanur|nusa dua|mengwitani|datutan|klemben|kubutambahan|pekat|baturiti|tekuan|ukiran|sinde|trunyan|abian/i },
  { name: 'Mataram', la: -8.5833, lo: 116.1167, re: /mataram|lombok|nusa tenggara barat|\bntb\b|bima|dompu|sumbawa|senggigi|pujut|aikmel|suralaga|sikur|wongosari|rasa|bue|madakap|tola|jadid|donggo|sapit|talawao|katik|sampaga|sodi|tolotangga|madapang|sengkol|sodo|taloto|cisolok|buye|lalang|tiwuh/i },
  { name: 'Kupang', la: -10.1772, lo: 123.6070, re: /kupang|nusa tenggara timur|\bntt\b|atambua|oecusse|amfoi|koepang|sai ?lopo|sobala|ohin|takko|atonutu|aupay|sabu|raijua|sawu|malo|nusa tamban/i },
  { name: 'Flores', la: -8.8400, lo: 121.0300, re: /\bflores\b|maumere|\bende\b|\blabuan bajo\b|sikka|ngada|ruteng|boawae|lembata|kefa|flores selatan|kawalingga|gamel|boan|boa ruku|wolowaru|wololete|bomaki|lawitolemo|nangaroro|sano nggoang|wulanggere|wuatoba|paputungan|hameto|kedang|llanai|mbefus|nbiele|pago|paga|raijuku|santaana|sawuro|taikla/i },
  // Maluku — Ambon 'maluku' jangan telan 'maluku utara' (lookahead)
  { name: 'Ambon', la: -3.6954, lo: 128.1814, re: /ambon|maluku(?!\s*utara)|malteng|tual|namlea|masohi|dobo|seram|buru|lelitu|wana|taniwel|kaitetu|latale|lola|morela|nunu|puatap|saleman|saparua|saparuan|titawa|tulehu|wakasih|hatawano|elat|haruku/i },
  { name: 'Ternate', la: 0.7900, lo: 127.3840, re: /ternate|maluku utara|\bmalut\b|tidore|tobelo|galela|morotai|taliabu|sanana|gane|baham|pagu|pola-mole|obir|sula|maba|kayoa|wasile|salawu|lato|kobisi|golalu|wajil/i },
  { name: 'Gunung Ruang', la: 2.3000, lo: 125.3910, re: /gunung ruang|erupsi ruang|letusan ruang/i },
  // Papua — spesifik per kabupaten; 'papua' generik sengaja tidak dipakai
  { name: 'Sorong', la: -0.8787, lo: 131.2698, re: /sorong|papua barat|\bpapbar\b|maybrat|saifi|sele/i },
  { name: 'Manokwari', la: -0.8615, lo: 134.0620, re: /manokwari|wasior|ransi|sauce|sarar|beser|macakat|waigeo|arfak|iryan|aimasi|moki|sou|soulat|soubou|sukie/i },
  { name: 'Fakfak', la: -3.0331, lo: 132.3161, re: /fakfak|kaimana|matia|sekar|foniki|saka/i },
  { name: 'Jayapura', la: -2.5916, lo: 140.6690, re: /jayapura|nabire|sarmi|keem|kay|sentani|jumanto|asmat|aikima|asiki|ambelo|aseki|bega|bema|ibin|mamberam/i },
  { name: 'Merauke', la: -8.5657, lo: 140.4100, re: /merauke|boven digul|tanah merah|maro|okaba|yatabe|maripuni|yuliki|zanando|zanagi|bovon/i },
  { name: 'Timika', la: -4.5437, lo: 136.8798, re: /timika|mimika|freeport|tbo|tspo|kupu|itam|maele|nakoti|nim|sarea|tambatra|wanggar|wann/i },
  { name: 'Wamena', la: -4.1389, lo: 138.9511, re: /wamena|lani ?jaya|tolikara|yali|yapua|ilaga|paniai|mamberamo|hoyade|ngajum|dagai|dogiyai|deiyai|pegunungan ?bintang|maybrat|tambul|nduga|silimo/i },
  { name: 'Biak', la: -1.1869, lo: 136.1169, re: /biak|supiori|warsami|yapen|serui|kerom|numfor|pandai|irian jaya|irian|triton|airair|ambel|gorom|unurum guay/i }
];
const placeOf = t => PLACES.find(p => p.re.test(t)) || null;
const incidents = () => memo('incidents', 55000, async () => {
  const srcs = await news(), now = Date.now(), out = [], seen = new Set();
  for (const s of srcs) {
    if (!s.ok) continue;
    for (const it of s.items) {
      const cat = catOf(it.title);
      if (!cat || catMeta(cat).geo === false) continue;
      const place = placeOf(it.title);
      if (!place) continue;
      const key = place.name + '|' + String(it.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
      const recency = Math.max(0.16, Math.exp(-age / (20 * 3600e3)));
      const heat = catMeta(cat).sev * recency;
      out.push({ name: place.name, la: place.la, lo: place.lo, kind: cat,
        label: catMeta(cat).label, title: it.title,
        src: s.id, url: it.url, ts: it.ts || now, weight: +heat.toFixed(3) });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  const items = out.slice(0, 120);
  for (const p of PLACES) {
    if (items.some(i => i.name === p.name)) continue;
    items.push({ name: p.name, la: p.la, lo: p.lo, kind: 'node', label: 'Node',
      title: 'Node pemantauan · ' + p.name, src: 'NODE', url: '', ts: now, weight: 0.16, fixed: true });
  }
  return { ok: true, items, total: out.length, places: PLACES.length, at: now };
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
      if (age > 72 * 3600e3) continue;
      const k = breakNorm(it.title).slice(0, 56);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const place = placeOf(it.title);
      const recency = Math.max(0.12, Math.exp(-age / (24 * 3600e3)));
      const meta = catMeta(cat);
      items.push({ title: it.title, url: it.url, src: s.id, ts: it.ts || now,
        cat, label: meta.label, place: place ? place.name : '',
        weight: +(meta.sev * recency).toFixed(3) });
      stats[cat]++;
      if (place && meta.geo !== false) regions.set(place.name, (regions.get(place.name) || 0) + 1);
    }
  }
  items.sort((a, b) => b.weight - a.weight || (b.ts || 0) - (a.ts || 0));
  const regionRows = [...regions.entries()].map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n).slice(0, 20);
  return { ok: true, stats, total: items.length, items: items.slice(0, 60), regions: regionRows,
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
  } catch(e) { wxCache.at = Date.now(); wxCache.data = { ok: false, err: String(e.message||e).slice(0,150), items: [] }; }
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
  fireCache.at = Date.now();
  fireCache.data = { ok: sourceStatus.some(s => s.ok), items: out, sources: sourceStatus, at: Date.now() };
  return fireCache.data;
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
  } catch(e) { windCache.at = Date.now(); windCache.data = { ok: false, err: String(e.message||e).slice(0,150), data: null }; }
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
    alertCache.at = Date.now();
    alertCache.data = { ok: false, err: String(e.message||e).slice(0,150), items: [] };
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
        ldImages(n.image || n.thumbnailUrl || n.thumbnail, rows);
      }
      for (const u of rows) addCandidate(meta, u, base, 'ld');
    } catch (e) {}
  }
  const scan = bodyHtml || html;
  for (const m of scan.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (/logo|icon|avatar|badge|spacer|pixel|blank|sprite|watermark/i.test((a.class || '') + ' ' + (a.alt || ''))) continue;
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
  if (!/^image\//i.test(ct)) return null;
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
  let m = ogReuseMap.get(host);
  if (!m) { m = new Map(); ogReuseMap.set(host, m); if (ogReuseMap.size > 60) ogReuseMap.delete(ogReuseMap.keys().next().value); }
  let s = m.get(imgUrl);
  if (!s) { s = new Set(); m.set(imgUrl, s); if (m.size > 120) m.delete(m.keys().next().value); }
  const seen = s.size;
  s.add(article);
  return seen;
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
  if (!r || !r.ok) throw lastErr || new Error('fetch gagal');
  const html = (await r.text()).slice(0, 1800000);
  // body scan dibatasi ke container artikel (rdArticleCandidates[0] = paling presisi)
  // dan dipotong sebelum seksi "berita terkait" — menghilangkan thumbnail related/news lain
  let bodySrc = rdArticleCandidates(html)[0] || html;
  const relAt = bodySrc.search(/baca juga|berita terkait|artikel terkait|lihat juga|bacaan|recommended|baca selengkapnya/i);
  if (relAt > 1500) bodySrc = bodySrc.slice(0, relAt);
  const { meta, body } = sourceImages(html, article, bodySrc);
  const host = new URL(article).hostname;
  const probe = async (c) => {
    const img = upgradeImage(c.url);
    const dim = await probeImage(img, article).catch(() => null);
    return dim ? { img, w: dim.w, h: dim.h, src: article, score: imageScore(c, dim) } : null;
  };
  const passes = p => p && p.w >= 600 && ogReuse(host, p.img, article) < 2;
  // hero = urutan prioritas dokumen (ld+json → og → meta), bukan score tertinggi:
  // thumbnail harus konsisten dengan gambar yang sama yang dipakai reader
  const seenU = new Set();
  const dedupe = c => { if (seenU.has(c.url)) return false; seenU.add(c.url); return true; };
  const tiers = [meta.filter(c => c.kind === 'ld'), meta.filter(c => c.kind === 'og'), meta.filter(c => c.kind === 'meta')]
    .map(t => t.filter(dedupe));
  let best = null;
  for (const tier of tiers) {
    const rs = await Promise.all(tier.slice(0, 4).map(probe));
    for (let i = 0; i < rs.length; i++) {
      if (passes(rs[i])) { best = rs[i]; break; }
    }
    if (best) break;
  }
  if (!best) {
    const bs = await Promise.all(body.filter(c => !seenU.has(c.url)).slice(0, 8).map(probe));
    best = bs.filter(Boolean).sort((a, b) => b.score - a.score)
      .find(p => p.w >= 600 && ogReuse(host, p.img, article) < 2) || null;
  }
  const v = best ? { img: best.img, w: best.w, h: best.h, src: article } : { img: '', src: article };
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
async function cctvBpjt(){
  const r = await get('https://bpjt.pu.go.id/cctv/', {}, 25000);
  const h = await r.text();
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
      s, e: '', la, lo, c: idRegion(la, lo) });
  }
  return out;
}
async function cctvBekasi(){
  const r = await get('https://eofficev2.bekasikota.go.id/backupcctv/m3/list.json', {}, 15000);
  const d = await r.json();
  if (!Array.isArray(d)) return [];
  return d.filter(x => x && x.path).map(x => ({
    n: String(x.name || x.path).replace(/_/g, ' '),
    s: 'https://eofficev2.bekasikota.go.id/backupcctv/m3/' + x.path,
    e: '', la: null, lo: null, c: 'Kota Bekasi'
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
      // ini media playlist — cek segmen pertama bisa di-fetch
      try {
        const seg = new URL(first, url).href;
        const sr = await get(seg, { headers: HLS_UA, method: 'GET' }, 8000);
        if (!sr.ok) return false;
        const buf = await sr.arrayBuffer();
        return buf.byteLength > 1000;
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
    const cams = await cctvBpjt().catch(() => []);
    let i = 0;
    await Promise.all(Array.from({ length: 24 }, async () => { while (i < cams.length) { const c = cams[i++];
      const ok = await probeHls(c.s, 0);
      next.done.add(c.s);
      if (ok) next.alive.add(c.s);
    } }));
    cctvProbe.alive = next.alive; cctvProbe.done = next.done;
    console.log('[cctv] probe selesai:', next.alive.size, '/', cams.length, 'cam playable');
  } catch (e) {} finally { cctvProbe.running = false; }
}
const cctvCatalog = () => memo('cctvcat', 300000, async () => {
  const rs = await Promise.allSettled([cctvBpjt(), cctvBekasi()]);
  let cams = rs.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const bpjt = cams.filter(c => /jasamarga|hk-opt|jtd|mms-corp|kkdm|hutama|waskita/i.test(c.s));
  const other = cams.filter(c => !/jasamarga|hk-opt|jtd|mms-corp|kkdm|hutama|waskita/i.test(c.s));
  // BPJT: hanya yang probe-confirmed playable. Sebelum probe selesai → kosong (jujur, bukan asal pasang)
  const verified = cctvProbe.done.size ? bpjt.filter(c => cctvProbe.alive.has(c.s)) : [];
  return { ok: true, cams: [...other, ...verified], bpjt_alive: cctvProbe.alive.size, bpjt_total: bpjt.length, probing: cctvProbe.running, at: Date.now() };
});

/* ---------- READ: ekstrak teks halaman buat panel baca (bukan iframe) ---------- */
const ENT = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'…', mdash:'—', ndash:'–',
  lsquo:'‘', rsquo:'’', ldquo:'“', rdquo:'”', laquo:'«', raquo:'»', bull:'•', middot:'·', copy:'©', reg:'®',
  trade:'™', deg:'°', times:'×', divide:'÷', euro:'€', pound:'£', yen:'¥', sect:'§', para:'¶' };
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
async function rdAssertPublic(raw) {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
  if (x.username || x.password) throw new Error('URL berkredensial ditolak');
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) throw new Error('host lokal ditolak');
  const addrs = await dns.lookup(h, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('host tidak ditemukan');
  if (addrs.some(a => rdPrivateIP(a.address))) throw new Error('alamat privat ditolak');
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
// blok terurut: paragraf + slot video pada posisi aslinya di artikel.
// menangani <p> maupun artikel div+<br> (mis. sindonews) — bukan cuma tag <p>.
function rdBlocks(html, finalURL) {
  const blocks = [], paras = [], vids = [], vseen = new Set(), pseen = new Set();
  let s = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|form|nav|header|footer|aside|button|select|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, m => {
    if (vids.length >= 4) return ' ';
    const v = rdVideoEl(m, finalURL);
    if (!v) return ' ';
    const k = v.url.split('?')[0];
    if (vseen.has(k)) return ' ';
    vseen.add(k); vids.push(v);
    return '\n@@RDV' + (vids.length - 1) + '@@\n';
  });
  for (const seg of rdClean(s).split('\n')) {
    const parts = seg.split(/@@RDV(\d+)@@/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { blocks.push({ k: 'v', v: vids[+parts[i]] }); continue; }
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
function rdVideos(html, finalURL) {
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
  for (const m of html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\bsrc=["']([^"']+)/i) || [])[1]
      || (m[1].match(/<source\b[^>]*\bsrc=["']([^"']+)/i) || [])[1];
    const poster = (tag.match(/\bposter=["']([^"']+)/i) || [])[1];
    add(src, 'video', poster);
  }
  for (const m of html.matchAll(/<iframe\b[^>]*src=["']([^"']+)["']/gi)) {
    const u = abs(m[1]);
    const yt = u.match(/(?:youtube\.com\/(?:embed|shorts)\/|youtu\.be\/|youtube-nocookie\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{6,15})/i);
    if (yt) { add('https://www.youtube.com/embed/' + yt[1], 'iframe'); continue; }
    if (VID_IFRAME.test(u) && !VID_FILE.test(u)) add(u, 'iframe');
  }
  for (const n of rdLd(html)) {
    if (!/video/i.test(String(n['@type'] || ''))) continue;
    for (const v of (Array.isArray(n) ? n : [n])) {
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
  const resolved = [];
  for (const p of probes) {
    try {
      const r = await get(p.url, { headers: { referer: article } }, 10000);
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\//i.test(ct)) { resolved.push({ url: p.url, kind: VID_FILE.test(p.url) ? 'video' : 'probe', poster: p.poster }); continue; }
      const inner = rdVideos(await r.text(), p.url);
      const good = inner.find(v => v.kind === 'video') || inner.find(v => v.kind === 'iframe');
      if (good) resolved.push(good);
    } catch (e) {}
  }
  const rest = (d.videos || []).filter(v => v.kind !== 'probe');
  d.videos = [...resolved, ...rest].slice(0, 4);
  return d;
}
// container body artikel: <article> atau elemen ber-class/id khas konten,
// dengan pencocokan tag seimbang (bukan regex non-greedy yang terpotong nested div)
const RD_CONT_RE = /<(article|div|section|main)\b[^>]*(?:class|id)=["'][^"']*(?:detail-desc|article-content|article-body|content-detail|detail-content|post-content|entry-content|berita-content|field-name-body|txt-berita|detail_body|news-content|content-body|post-body|article__body)[^"']*["'][^>]*>/i;
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
  if (!/^https?:/i.test(img)) img = '';
  const byline = meta.author || meta['article:author'] || rdName(art.author) || '';
  const time = meta['article:published_time'] || meta['datepublished'] || art.datePublished || '';
  let blk = null;
  for (const cand of rdArticleCandidates(html)) {
    const b = rdBlocks(cand, finalURL);
    if (!blk || b.paras.length > blk.paras.length) blk = b;
    if (b.paras.length >= 3) break;                    // kandidat pertama yang cukup kaya menang
  }
  if (!blk) blk = rdBlocks(html, finalURL);
  let paras = blk.paras;
  if (paras.length < 2 && typeof art.articleBody === 'string') {
    paras = art.articleBody.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/).map(rdInline).filter(t => t.length >= 50).slice(0, 45);
    blk = { blocks: paras.map(t => ({ k: 'p', t })), paras, videos: [] };
  }
  if (!paras.length && desc) {
    paras = [rdInline(desc)];
    blk = { blocks: paras.map(t => ({ k: 'p', t })), paras, videos: [] };
  }
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
  const allV = rdVideos(html, finalURL);
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
    if (t.startsWith('#')) { if (!title) title = t.replace(/^#+\s*/, '').trim(); continue; }
    if (/^!\[/.test(t) || /^```/.test(t) || /^>/.test(t) || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) continue;
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
  return { ok: true, url, final: url, title: title || rdHost(url) || 'Tanpa judul',
    site: rdHost(url), byline: '', time: '', img: '', desc: '', paras, thin: paras.length < 2, via: 'reader' };
}
// video tanpa posisi (og:video/JSON-LD/Jina) → sebar merata di antara paragraf,
// bukan numpuk di bawah hero image
function rdAssembleBlocks(d) {
  if (!d) return d;
  const paras = d.paras || [];
  const blocks = (Array.isArray(d.blocks) && d.blocks.length)
    ? d.blocks
    : paras.map(t => ({ k: 'p', t }));
  const inside = new Set();
  for (const b of blocks) if (b.k === 'v' && b.v) inside.add(String(b.v.url).split('?')[0]);
  const extra = (d.videos || []).filter(v => v && v.kind !== 'probe' && !inside.has(String(v.url).split('?')[0]));
  const pIdx = [];
  blocks.forEach((b, i) => { if (b.k === 'p') pIdx.push(i); });
  if (extra.length && pIdx.length) {
    const ops = extra.map((v, j) => ({
      at: pIdx[Math.min(pIdx.length, Math.max(1, Math.round(pIdx.length * (j + 1) / (extra.length + 1)))) - 1] + 1,
      v
    })).sort((a, b) => b.at - a.at);
    for (const o of ops) blocks.splice(o.at, 0, { k: 'v', v: o.v });
  } else {
    for (const v of extra) blocks.push({ k: 'v', v });
  }
  d.blocks = blocks;
  return d;
}
async function rdFinish(d, url) {
  d = await rdHydrateVideos(d, url);
  return rdAssembleBlocks(d);
}
async function rdRead(raw) {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
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
      // halaman JS-rendered: teks tipis tapi meta (og:image/og:video) tetap bernilai → simpan untuk fallback & merge
      if (!blocked && metaScore(d) > (metaD ? metaScore(metaD) : -1)) metaD = d;
      return (d.paras.length < 2 || blocked) ? null : d;
    };
    // 1) direct + redirect manual
    try {
      const { r, url } = await rdSafeGet(target, Math.min(12000, left()));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(ct)) throw new Error('bukan halaman HTML');
      const len = Number(r.headers.get('content-length') || 0);
      if (len > 3e6) throw new Error('halaman terlalu besar');
      let html = await r.text();
      if (html.length > 3e6) html = html.slice(0, 3e6);
      const d = tryHtml(html, url);
      if (d) return await rdFinish(d, url);
      lastErr = new Error('halaman challenge/block');
    } catch (e) { lastErr = e; }
    // 2) Jina reader — paling andal, dicoba sebelum rantai proxy publik yang lambat
    try {
      const r = await get('https://r.jina.ai/' + target, { headers: { accept: 'text/plain' } }, Math.min(10000, left()));
      if (r.ok) {
        const txt = await r.text();
        if (txt && txt.length > 200) {
          const d = rdJinaMd(txt, target);
          if (d.paras.length >= 2 && !BLOCKED_RE.test(d.title + ' ' + txt.slice(0, 3000))) {
            if (metaD) {                                   // timpa field kosong dengan meta dari fetch langsung
              if (!d.img && metaD.img) d.img = metaD.img;
              if (!d.videos || !d.videos.length) d.videos = metaD.videos || [];
              if (!d.time && metaD.time) d.time = metaD.time;
            }
            return await rdFinish(d, target);
          }
        }
      }
    } catch (e) { lastErr = e; }
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
              return await rdFinish(d, target);
            }
          }
        }
      } catch (e) { lastErr = e; }
    }
    // 3) proxy chain — jalan terakhir sebelum fallback meta
    for (const px of RD_PROXIES) {
      if (Date.now() - t0 > 26000) break;
      try {
        const r = await get(px(target), {}, Math.min(12000, left()));
        if (!r.ok) continue;
        const ct = r.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml/i.test(ct)) continue;
        let html = await r.text();
        if (html.length > 3e6) html = html.slice(0, 3e6);
        const d = tryHtml(html, target);
        if (d) return await rdFinish(d, target);
      } catch (e) { lastErr = e; }
    }
    // semua jalur gagal → tetap sajikan meta (judul/gambar/video/deskripsi) daripada error kosong
    if (metaD) {
      const paras = metaD.paras.length ? metaD.paras : (metaD.desc ? [metaD.desc] : []);
      const d = { ...metaD, paras, thin: paras.length < 2, via: 'meta' };
      d.blocks = (metaD.blocks && metaD.blocks.length ? metaD.blocks : paras.map(t => ({ k: 'p', t })))
        .filter(b => b.k !== 'p' || paras.includes(b.t));
      return await rdFinish(d, target);
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
    if (u.pathname === '/api/ping') return json({ ok: true, x: xHas() });
    if (u.pathname === '/api/news') {
      const srcs = await news();
      return json({ sources: srcs.map(s => ({ ...s, items: s.items.map(i => {
        const cat = catOf(i.title) || feedCatOf(s.id);
        return { ...i, cat, label: cat ? catMeta(cat).label : '' };
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
    if (u.pathname === '/api/x') return json(await xposts());
    if (u.pathname === '/api/xq') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ ok: false, err: 'query kosong' });
      try { return json({ ok: true, posts: await xqLazy(q), at: Date.now() }); }
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
        return json(c.v);
      }
      return json(await threads());
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
    if (u.pathname === '/api/satellite') return json(await satelliteProducts());
    if (u.pathname === '/api/bmkg-modelrun') return json(await bmkgModelRun());
    if (u.pathname === '/api/alerts') return json(await alerts());
    if (u.pathname === '/api/radar') return json(await radar());
    if (u.pathname === '/api/cams') return json(await alive());
    if (u.pathname === '/api/cctv') return json(await cctvCatalog());
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
  xposts().then(r => console.log('X warm: ' + r.posts.length + ' post')).catch(e => console.log('X warm gagal: ' + e.message));
  setTimeout(() => warmCctv().catch(() => {}), 20000);
  setInterval(() => { warmCctv().catch(() => {}); }, 1800000);
});
