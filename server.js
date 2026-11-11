// node server.js  (Node 18+, tanpa dependency)
const SOC = require('./social');
const HISTORY = require('./social-history');
const ASSESS = require('./assessment');
const NLP_ADAPTER = require('./nlp-adapter');
const nlpAdapter = NLP_ADAPTER.createNlpAdapter();
const FEEDTEXT = require('./feedtext');
const EXTRACT = require('./article-extract');
const MEDIA = require('./article-media');
const PIPELINE_VERSION = MEDIA.PIPELINE_VERSION;
const assetReuse = new MEDIA.AssetReuseTracker();
const XPOOL = require('./xpool');
const http = require('http'), fs = require('fs'), path = require('path'), dns = require('dns').promises, crypto = require('crypto'), zlib = require('zlib');
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
const SEC = require('./security');
const TRUSTED_ROOTS = SEC.loadTrustedRoots([
  ...String(process.env.SITREP_EXTRA_CA || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean),
  ...(Array.isArray(CFG.trusted_ca) ? CFG.trusted_ca : (CFG.trusted_ca ? [CFG.trusted_ca] : []))
]);
if (process.env.SITREP_INSECURE_TLS === '1') {
  console.warn('[SECURITY WARNING] SITREP_INSECURE_TLS=1 diabaikan — verifikasi TLS selalu aktif; gunakan SITREP_EXTRA_CA atau AIA chain repair.');
}
const explicitApiToken = Boolean(process.env.SITREP_TOKEN);
const API_TOKEN = process.env.SITREP_TOKEN || crypto.randomBytes(16).toString('hex');
const TRUST_PROXY = process.env.SITREP_TRUST_PROXY === '1' || process.env.TRUST_PROXY === '1' || Boolean(process.env.RAILWAY_ENVIRONMENT);
const TRUST_CF = process.env.SITREP_TRUST_CF === '1';
// Cloudflare Tunnel: cloudflared connect ke origin dari 127.0.0.1. Bind ke loopback
// supaya port 8787 tidak bisa ditembak langsung (yang akan mem-bypass CF + rate limit).
const BIND_HOST = process.env.SITREP_HOST || process.env.BIND_HOST || '0.0.0.0';
const isPublicDeploy = process.env.SITREP_PUBLIC === '0' ? false : Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME ||
  process.env.VERCEL || process.env.HEROKU_APP_NAME || process.env.K_SERVICE ||
  process.env.SITREP_PUBLIC === '1'
);
const AUTH = SEC.createAuthManager({
  apiToken: API_TOKEN,
  explicitToken: explicitApiToken,
  usersSpec: process.env.SITREP_USERS || '',
  authSecret: process.env.SITREP_AUTH_SECRET || '',
  tokenRole: process.env.SITREP_TOKEN_ROLE || 'admin',
  trustProxy: TRUST_PROXY,
  publicDeploy: isPublicDeploy
});
const LIMITER = SEC.createRateLimiter();
// Diagnostik boot: salah setelan proxy = seluruh dunia dihitung satu IP, dan
// gejalanya cuma "429 misterius" belakangan. Lebih baik teriak di startup.
{
  const proxyish = Boolean(process.env.CF_TUNNEL_TOKEN || process.env.TUNNEL_TOKEN || process.env.TUNNEL_ID);
  if (!TRUST_PROXY && proxyish) {
    console.warn('[SECURITY WARNING] Tunnel/proxy terdeteksi (env tunnel) tapi SITREP_TRUST_PROXY!=1 — semua pengunjung akan dihitung sebagai IP proxy dan kena rate limit bersama. Set SITREP_TRUST_PROXY=1.');
  }
  if (TRUST_PROXY && !TRUST_CF && process.env.SITREP_TRUST_CF !== '0') {
    console.log('[AUTH] IP klien: XFF (trusted hops=' + (process.env.SITREP_TRUSTED_HOPS || 1) + '). Di belakang Cloudflare, set SITREP_TRUST_CF=1 agar CF-Connecting-IP dipakai.');
  }
}
if (AUTH.publicMode) {
  console.log('[AUTH] Mode OSINT publik aktif (tanpa login, akses pengunjung role=viewer, API token tidak di-inject ke HTML).');
} else if (isPublicDeploy && !AUTH.userMode) {
  console.warn('[SECURITY WARNING] SITREP berjalan di lingkungan publik tanpa SITREP_USERS — token API di-inject ke index.html.');
}
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
  ['BBC INDONESIA', 'https://feeds.bbci.co.uk/indonesia/rss.xml'],
  ['DW INDONESIA', 'https://rss.dw.com/rdf/rss-ind-all'],
  // ABC Australia tidak punya edisi Bahasa Indonesia — feed /indonesian/feed/51120
  // ternyata "Just In" Inggris (en-AU), 25 item Inggris masuk wire.
  // CNA Indonesia: ?category=3321 membeku di Jun 2025; endpoint utama ?_format=xml aktif & terbaru.
  ['CNA INDONESIA', 'https://www.cna.id/api/v1/rss-outbound-feed?_format=xml'],
  ['TRIBUN', 'https://www.tribunnews.com/rss'],
  ['CNBC ID', 'https://www.cnbcindonesia.com/news/rss'],
  // JPNN di balik Cloudflare challenge — direct fetch mustahil, tapi RSS publik
  // dan tiap item bawa <enclosure> foto → thumbnail wire langsung terisi.
  ['JPNN', 'https://www.jpnn.com/rss'],
  // Regional direct feeds: tembus dari IP datacenter, pengganti volume GNEWS
  ['DETIK JABAR', 'https://www.detik.com/jabar/rss'],
  ['DETIK JATENG', 'https://www.detik.com/jateng/rss'],
  ['DETIK JATIM', 'https://www.detik.com/jatim/rss'],
  ['DETIK JOGJA', 'https://www.detik.com/jogja/rss'],
  ['DETIK SUMUT', 'https://www.detik.com/sumut/rss'],
  ['DETIK SULSEL', 'https://www.detik.com/sulsel/rss'],
  ['DETIK BALI', 'https://www.detik.com/bali/rss'],
  ['ANTARA JABAR', 'https://jabar.antaranews.com/rss/terkini.xml'],
  ['ANTARA JATENG', 'https://jateng.antaranews.com/rss/terkini.xml'],
  ['ANTARA JATIM', 'https://jatim.antaranews.com/rss/terkini.xml'],
  ['ANTARA BALI', 'https://bali.antaranews.com/rss/terkini.xml'],
  ['ANTARA SUMUT', 'https://sumut.antaranews.com/rss/terkini.xml'],
  ['ANTARA MAKASSAR', 'https://makassar.antaranews.com/rss/terkini.xml'],
  ['ANTARA PAPUA', 'https://papua.antaranews.com/rss/terkini.xml'],
  ['ANTARA KALTIM', 'https://kaltim.antaranews.com/rss/terkini.xml'],
  ['ANTARA ACEH', 'https://aceh.antaranews.com/rss/terkini.xml'],
  ['TRIBUN JABAR', 'https://jabar.tribunnews.com/rss'],
  ['TRIBUN JATENG', 'https://jateng.tribunnews.com/rss'],
  ['TRIBUN JATIM', 'https://jatim.tribunnews.com/rss'],
  ['TRIBUN JOGJA', 'https://jogja.tribunnews.com/rss'],
  ['TRIBUN MEDAN', 'https://medan.tribunnews.com/rss'],
  ['TRIBUN MAKASSAR', 'https://makassar.tribunnews.com/rss'],
  ['TRIBUN BALI', 'https://bali.tribunnews.com/rss'],
  ['TRIBUN PAPUA', 'https://papua.tribunnews.com/rss'],
  ['RRI', 'https://rri.co.id/rss'],
  ['GNEWS · DEMO', gn('demo OR "unjuk rasa" OR "aksi massa"')],
  ['GNEWS · KEBAKARAN', gn('kebakaran OR karhutla OR "kebakaran hutan"')],
  ['GNEWS · BANJIR', gn('banjir OR longsor OR "tanah longsor" OR "banjir bandang" OR "cuaca ekstrem"')],
  ['GNEWS · BENCANA', gn('gempa OR tsunami OR erupsi OR letusan OR "gunung meletus" OR "puting beliung" OR "siklon tropis" OR "angin kencang" OR badai OR "hujan abu" OR "awan panas"')],
  ['GNEWS · INSIDEN', gn('kecelakaan OR ledakan OR ambruk')],
  ['GNEWS · KRIMINAL', gn('penembakan OR pembunuhan OR penangkapan OR terorisme')],
  ['GNEWS · KESEHATAN', gn('wabah OR DBD OR "demam berdarah" OR campak OR rabies OR kolera OR mpox OR polio OR TBC OR KLB OR keracunan OR "miras oplosan" OR stunting')],
  ['GNEWS · KERACUNAN', gn('keracunan OR "keracunan massal" OR "keracunan makanan" OR "keracunan MBG" OR "makanan basi" OR "miras oplosan" OR intoksikasi')],
  ['GNEWS · EKONOMI', gn('phk OR rupiah OR bbm OR "listrik padam"')],
  ['GNEWS · POLITIK', gn('pemilu OR pilkada OR pilpres OR kpu OR perang OR konflik OR "gencatan senjata" OR ultimatum OR kudeta OR invasi OR "partai politik" OR DPR')],
  ['GNEWS · SIBER', gn('ransomware OR "serangan siber" OR phishing OR "bocor data" OR BSSN OR "akun dibajak" OR "dompet kripto" OR exploit OR "zero day" OR deepfake OR "data breach" OR "peretasan"')],
  ['GNEWS · LINGKUNGAN', gn('karhutla OR deforestasi OR "sungai tercemar" OR "sampah plastik" OR longsor OR "tambang ilegal"')],
].concat(Array.isArray(CFG.news_extra) ? CFG.news_extra.filter(x => x && typeof x.id === 'string' && typeof x.url === 'string' && x.id && x.url).map(x => [x.id, x.url]) : []);

const cache = new Map();
/* ---------- history buffer sosial: post lama tetap ada antar-sync & restart ---------- */
const HIST_DIR = process.env.SITREP_DATA_DIR || path.join(__dirname, 'data');
const xHist = new Map(), tHist = new Map();
const histKey = HISTORY.keyOf, histTs = HISTORY.tsOf;
const HIST_MAX = { x: 1500, th: 1200 }, HIST_AGE = 48 * 3600e3;
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
const AUTH_ACCOUNTS = new Set(['infobmkg', 'bnpb_indonesia', 'basarnas', 'damkardki', 'tmcpoldametro', 'halo_polisi', 'divhumas_polri', 'puspentni', 'kemkesri']);
function histAstroturf(map) {
  const eligible = p => {
    const t = String(p.text || '');
    if (t.length < 50 || /^\s*(rt\s+)?@/i.test(t)) return false;
    const u = String(histUser(p) || '').toLowerCase().replace(/^@/, '');
    if (AUTH_ACCOUNTS.has(u)) return false;
    return true;
  };
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
    const u = String(histUser(p) || '').toLowerCase().replace(/^@/, '');
    if (AUTH_ACCOUNTS.has(u) || p.assessment?.signalEligible) continue;
    if (!eligible(p)) continue;
    const byFull = cand.get(SOC.astroturfSig(p.text));
    const users = byFull && byFull.get(astroturfFull(p.text));
    if (users && users.size >= 3) map.delete(k);
  }
}
async function maybeDisambiguateBorderline(posts) {
  if (!nlpAdapter.isAvailable() || !Array.isArray(posts)) return;
  const borderline = posts.filter(p => p && p.assessment && p.assessment.feedLane === 'discovery_candidates').slice(0, 3);
  for (const p of borderline) {
    await nlpAdapter.disambiguate(p.text, p.assessment);
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
function histRetag(map, keep, recordDiagnostics = false) { HISTORY.retag(map, keep, ADHOC, Date.now(), { recordDiagnostics }); }
const histSaveAt = {};
const histSaveInflight = new Set();
const histDirty = new Map();   // file -> {map, max}: ada update yang belum tentu tersimpan
function buildHistPayload(map, max) {
  const posts = [...map.values()].sort((a, b) => histTs(b) - histTs(a)).slice(0, max);
  return JSON.stringify({ classifierVersion: SOC.CLASSIFIER_VERSION, posts });
}
function histSave(file, map, max, force) {
  const now = Date.now();
  if (!force && (now - (histSaveAt[file] || 0) < 60000 || histSaveInflight.has(file))) return;
  histSaveAt[file] = now;
  if (force) {
    try {
      fs.mkdirSync(HIST_DIR, { recursive: true });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, buildHistPayload(map, max));
      fs.renameSync(tmp, file);
      histDirty.delete(file);
    } catch (e) { console.error('[hist] gagal simpan ' + file + ': ' + (e.message || e)); }
    return;
  }
  histSaveInflight.add(file);
  histDirty.delete(file);
  const payload = buildHistPayload(map, max);
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 7) + '.tmp';
  fs.promises.mkdir(HIST_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, payload))
    .then(() => fs.promises.rename(tmp, file))
    .catch(e => {
      histDirty.set(file, { map, max });
      try { fs.unlinkSync(tmp); } catch {}
      console.error('[hist] gagal simpan async ' + file + ': ' + (e.message || e));
    })
    .finally(() => histSaveInflight.delete(file));
}
function histMarkDirty(file, map, max) { histDirty.set(file, { map, max }); histSave(file, map, max); }
const NEWS_HIST_FILE = path.join(HIST_DIR, 'news-history.json');
const NEWS_FEED_CAP = 200;
const NEWS_DISK_MAX = 4500;
const newsHistByFeed = new Map();
let newsHistDirty = false, newsHistSaveAt = 0, newsHistInflight = false;
function newsHistPayload() {
  const all = [], now = Date.now();
  for (const m of newsHistByFeed.values()) {
    for (const it of m.values()) {
      if (it && it.ts > 0 && it.ts <= now + 5 * 60e3 && now - it.ts <= 24 * 3600e3) all.push(it);
    }
  }
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return JSON.stringify({ classifierVersion: SOC.CLASSIFIER_VERSION, posts: all.slice(0, NEWS_DISK_MAX) });
}
function saveNewsHist(force) {
  if (!newsHistDirty && !force) return;
  const now = Date.now();
  if (!force && (now - newsHistSaveAt < 60000 || newsHistInflight)) return;
  newsHistSaveAt = now;
  newsHistDirty = false;
  if (force) {
    try {
      fs.mkdirSync(HIST_DIR, { recursive: true });
      const tmp = NEWS_HIST_FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, newsHistPayload());
      fs.renameSync(tmp, NEWS_HIST_FILE);
    } catch (e) { console.error('[hist] gagal simpan ' + NEWS_HIST_FILE + ': ' + (e.message || e)); }
    return;
  }
  newsHistInflight = true;
  const payload = newsHistPayload();
  const tmp = NEWS_HIST_FILE + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 7) + '.tmp';
  fs.promises.mkdir(HIST_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, payload))
    .then(() => fs.promises.rename(tmp, NEWS_HIST_FILE))
    .catch(e => {
      newsHistDirty = true;
      try { fs.unlinkSync(tmp); } catch {}
      console.error('[hist] gagal simpan async ' + NEWS_HIST_FILE + ': ' + (e.message || e));
    })
    .finally(() => { newsHistInflight = false; });
}
const histFlushAll = () => {
  for (const [f, m] of histDirty) histSave(f, m.map, m.max, true);
  if (newsHistDirty) saveNewsHist(true);
  if (typeof saveMktCloses === 'function') saveMktCloses(true);
};
// flush berkala diisolasi agar gagal I/O sesaat tidak mematikan event loop
const histFlushTimer = setInterval(() => {
  SEC.runIsolated('histFlush', () => {
    for (const [f, m] of histDirty) histSave(f, m.map, m.max, false);
    saveNewsHist(false);
  });
}, 30000);
if (histFlushTimer.unref) histFlushTimer.unref();
let isDraining = false;
function stopBackgroundInfra() {
  isDraining = true;
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  if (wsSock) { try { wsSock.destroy(); } catch {} wsSock = null; }
  try { SEC.closeAllAgents && SEC.closeAllAgents(); } catch {}
}
const FATAL = SEC.createFatalGuard({
  onFlush: () => { stopBackgroundInfra(); histFlushAll(); },
  onClose: cb => {
    const sv = global.__sitrepServer;
    if (!sv) return cb();
    try { sv.close(cb); sv.closeIdleConnections && sv.closeIdleConnections(); } catch { cb(); }
  },
  timeoutMs: 8000
});
const shutdownClean = () => {
  if (isDraining) return;
  stopBackgroundInfra();
  histFlushAll();
  const sv = global.__sitrepServer;
  if (!sv) return process.exit(0);
  try {
    sv.close(() => process.exit(0));
    sv.closeIdleConnections && sv.closeIdleConnections();
  } catch (e) { process.exit(0); }
  setTimeout(() => {
    try { sv.closeAllConnections && sv.closeAllConnections(); } catch {}
    process.exit(0);
  }, 5000).unref();
};
if (require.main === module) {
  process.on('SIGINT', shutdownClean);
  process.on('SIGTERM', shutdownClean);
  // Error tak terisolasi menandakan state berisiko korup — flush, stop terima koneksi, exit(1) agar supervisor restart bersih.
  FATAL.install(process);
}
function histLoad(file, map) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of j.posts || []) { const k = histKey(p); if (k) map.set(k, p); }
  } catch (e) {}
}
// Dockerfile menjalankan `node server.js` langsung (lewati start.sh `mkdir -p data`),
// jadi folder data bisa belum ada. Buat dulu sebelum histLoad supaya baca/tulis
// history runtime nggak gagal; recursive:true aman & idempoten kalau sudah ada.
fs.mkdirSync(HIST_DIR, { recursive: true });
histLoad(path.join(HIST_DIR, 'x-history.json'), xHist);
histLoad(path.join(HIST_DIR, 'threads-history.json'), tHist);
histRetag(xHist, SOC.socKeepX, true); histRetag(tHist, SOC.socKeepTh, true);
histAstroturf(xHist); histAstroturf(tHist);
// byte cache untuk json() — key -> {at, plain:Buffer, gz:Buffer|null, br:Buffer|null}
const bodyCache = new Map(), BODY_CAP = 100, BODY_MAX_BYTES = 48 << 20;
const bodyCacheBytes = () => {
  let bytes = 0;
  for (const e of bodyCache.values()) {
    if (e && e.plain) bytes += e.plain.length + (e.gz ? e.gz.length : 0) + (e.br ? e.br.length : 0);
  }
  return bytes;
};
const putBodyCache = (key, entry) => {
  bodyCache.delete(key);
  bodyCache.set(key, entry);
  while (bodyCache.size > BODY_CAP || (bodyCache.size > 1 && bodyCacheBytes() > BODY_MAX_BYTES)) {
    bodyCache.delete(bodyCache.keys().next().value);
  }
};
const etagOf = buf => 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 16) + '"';
// ETag stabil: payload dengan `at` build-time selalu berubah tiap recompute walau
// isinya identik, jadi klien tidak pernah dapat 304 dan selalu menarik 600 KB.
// Semua pasangan `"at":<angka>` dinormalisasi sebelum di-hash; latin1 dipakai
// supaya roundtrip byte-identik untuk JSON UTF-8.
const etagStable = buf => {
  if (buf.length > 12 << 20) return etagOf(buf);
  const norm = buf.toString('latin1').replace(/,"at":\d+/g, ',"at":0');
  return etagOf(Buffer.from(norm, 'latin1'));
};
const yieldTick = () => new Promise(r => setImmediate(r));
function prewarmJson(cacheKey, obj, opts = {}) {
  if (!cacheKey || obj == null) return;
  try {
    const plain = Buffer.from(JSON.stringify(obj));
    const entry = {
      at: Date.now(), plain, gz: null, br: null, gzPromise: null, brPromise: null,
      etag: opts.stableAt ? etagStable(plain) : etagOf(plain),
    };
    putBodyCache(cacheKey, entry);
    if (plain.length > 8192 && !entry.brPromise) {
      entry.brPromise = new Promise(resolve => {
        zlib.brotliCompress(plain, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: plain.length,
          }
        }, (e, b) => {
          entry.br = (!e && b) ? b : null;
          entry.brPromise = null;
          resolve(entry.br);
        });
      });
    }
  } catch {}
}
const memoRetry = new Map();   // k -> jumlah retry gagal beruntun
// cache & memoRetry diisi key dari input user (read:, xq:, thq:, tt:*, yt:*, dst)
// — tanpa batas bisa membengkak. Map menjaga insertion order → evict tertua.
const MEMO_CAP = 800;
const lruCap = (m, cap) => { while (m.size > cap) m.delete(m.keys().next().value); };
// read:* entries berisi full article blocks (~20-100KB) — burst reader unik bisa
// meng-evict feed n:* yang panas. Batasi jatah read: secara eksplisit.
const READ_CAP = 500;
const pruneReads = () => {
  const ks = [];
  for (const k of cache.keys()) if (k.startsWith('read:')) ks.push(k);
  for (let i = 0; i < ks.length - READ_CAP; i++) cache.delete(ks[i]);
};
const userQueryCache = new Map();
const USER_QUERY_CAP = 400;
const isUserQueryKey = k => /^(?:tt:|xq:|thq:|xth:|thth:|yt:)/.test(k);
const cacheStoreFor = k => isUserQueryKey(k) ? userQueryCache : cache;
const cacheCapFor = k => isUserQueryKey(k) ? USER_QUERY_CAP : MEMO_CAP;
// good(v): predikat "payload ini layak jadi data". Hasil fetch yang resolve tapi
// gagal (mis. {ok:false}) TIDAK boleh menghapus last-good — diperlakukan seperti throw.
const memo = (k, ttl, fn, good) => {
  const isGood = good || (v => true);
  const store = cacheStoreFor(k);
  const cap = cacheCapFor(k);
  const kick = () => {   // refresh background + auto-retry backoff bila gagal (self-heal tanpa nunggu request)
    const cur = store.get(k);
    if (!cur || cur.p) return;
    cur.p = fn().then(v => accept(v), () => fail());
  };
  const fail = () => {
    const cur = store.get(k), now = Date.now();
    store.set(k, { at: now - ttl + 15000, v: cur && cur.v }); lruCap(store, cap);
    const n = (memoRetry.get(k) || 0) + 1;
    memoRetry.set(k, n); lruCap(memoRetry, MEMO_CAP);
    if (n <= 5) setTimeout(kick, Math.min(90000, 15000 * n)).unref();
  };
  const accept = v => {
    const cur = store.get(k);
    if (cur && cur.v !== undefined && isGood(cur.v) && !isGood(v)) return fail();
    // nilai buruk tanpa last-good: simpan tapi mundurkan `at` + jadwalkan retry —
    // dulu ok:false menempel TTL penuh (~55dtk) dan kartu "sumber gagal" tampak nyangkut
    const bad = !isGood(v);
    store.set(k, { at: bad ? Date.now() - ttl + 20000 : Date.now(), v }); lruCap(store, cap);
    if (bad) {
      const n = (memoRetry.get(k) || 0) + 1;
      memoRetry.set(k, n); lruCap(memoRetry, MEMO_CAP);
      if (n <= 5) setTimeout(kick, Math.min(90000, 15000 * n)).unref();
    } else memoRetry.delete(k);
    if (k.startsWith('read:')) pruneReads();
    return v;
  };
  const c = store.get(k);
  if (c && c.v !== undefined) {
    store.delete(k); store.set(k, c);   // true-LRU: feed panas tidak ter-evict burst read
    if (Date.now() - c.at < ttl) return Promise.resolve(c.v);
    kick();
    return Promise.resolve(c.v);
  }
  if (c && c.p) { store.delete(k); store.set(k, c); return c.p; }
  const p = fn().then(v => accept(v),
    e => { store.delete(k); memoRetry.delete(k); throw e; });
  store.set(k, { at: 0, v: undefined, p }); lruCap(store, cap);
  if (k.startsWith('read:')) pruneReads();
  return p;
};
// semaphore kecil: batasi konkurensi ke upstream yang sama (X GraphQL, worker Threads).
// Lazy fetch antre di slot yang sama dengan sweep utama — lebih baik menunggu daripada kena 429.
const makeSem = (max, maxQueue = 160) => {
  let n = 0; const q = [];
  const pump = () => {
    while (n < max && q.length) {
      let i = q.findIndex(j => j.prio);
      if (i < 0) i = 0;
      const job = q.splice(i, 1)[0];
      n++;
      Promise.resolve().then(job.fn).then(job.res, job.rej).finally(() => { n--; pump(); });
    }
  };
  // fn(fn, prio): job prioritas (reader yang ditunggu user) mendahului antrean
  // bulk (desc/thumb/CCTV), tapi tetap tunduk max konkurensi & cap antrean yang sama.
  return (fn, prio) => {
    if (q.length >= maxQueue) {
      const err = new Error('antrean server penuh, coba lagi sebentar');
      err.status = 503;
      err.transient = true;
      return Promise.reject(err);
    }
    return new Promise((res, rej) => {
      q.push({ fn, res, rej, prio: !!prio });
      pump();
    });
  };
};
// last-good untuk cache manual: payload gagal tidak menghapus data valid.
// `at` dimundurkan supaya request berikutnya retry cepat, data lama tetap tersaji.
function cacheFail(cache, ttl, data) {
  const bad = !data || data.ok === false;
  if (bad && cache.data && cache.data.ok) {
    cache.at = Date.now() - ttl + 30000;
    return cache.data;
  }
  // Cold failure: retry in 30s instead of locking out for full 5-15m TTL
  cache.at = bad ? (Date.now() - ttl + 30000) : Date.now();
  cache.data = data;
  return data;
}
function singleFlight(cacheObj, ttl, fn) {
  const hasVal = cacheObj.data ? true : (Array.isArray(cacheObj.items) && cacheObj.items.length > 0);
  if (hasVal) {
    if (Date.now() - cacheObj.at >= ttl && !cacheObj._p) {
      cacheObj._p = Promise.resolve().then(fn).catch(() => {
        cacheObj.at = Date.now() - ttl + 20000;
        return null;
      }).finally(() => { cacheObj._p = null; });
    }
    return Promise.resolve(cacheObj.data || cacheObj.items);
  }
  if (cacheObj._p) return cacheObj._p;
  cacheObj._p = Promise.resolve().then(fn).finally(() => { cacheObj._p = null; });
  return cacheObj._p;
}
/* Klien HTTP/HTTPS outbound memakai security.safeFetch:
   - Pin IP publik tervalidasi langsung ke socket TCP/TLS (menutup DNS rebinding / TOCTOU).
   - Verifikasi sertifikat TLS selalu aktif (tanpa getNoVerify / rejectUnauthorized:false).
   - Bila server (.go.id/.ac.id) mengirim leaf cert tanpa intermediate, AIA chain repair
     mengambil intermediate lalu memverifikasi rantai kriptografis hingga root CA tepercaya. */
async function get(url, opt = {}, ms = 10000) {
  return await SEC.safeFetch(url, { ...opt, trustedRoots: TRUSTED_ROOTS }, ms);
}
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
  .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
const tag = (b, n) => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? dec(m[1]) : ''; };
const tagRaw = (b, n) => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1] : ''; };
function feedImage(b, baseUrl = 'https://localhost/') {
  return MEDIA.feedImage(b, baseUrl);
}
const descOf = (b, title) => FEEDTEXT.descFrom({
  description: tagRaw(b, 'description'),
  contentEncoded: tagRaw(b, 'content:encoded'),
  summary: tagRaw(b, 'summary') || tagRaw(b, 'dc:description') || tagRaw(b, 'itunes:summary'),
  mediaDescription: tagRaw(b, 'media:description'),
}, title || '');
// <source> Google News kadang berisi URL (https://www.situs.id/) bukan nama media → jadikan hostname rapi
const cleanPub = v => {
  v = String(v || '').trim();
  if (/^(https?:)?\/\//i.test(v) || /^www\./i.test(v)) { try { return new URL(/^www\./i.test(v) ? 'https://' + v : v).hostname.replace(/^www\./i, ''); } catch (e) { return ''; } }
  return v;
};
// domain/sumber yang dilarang — item langsung dibuang dari semua feed.
// kompasiana = platform opini/blog; koran/majalah/plus tempo = edisi berbayar/langganan.
const BANNED_SRC = /infopublik\.id|infopublik|kompasiana|koran\.tempo\.co|majalah\.tempo\.co|plus\.tempo\.co|tempo\.co\/(?:plus|langganan|subscribe)\b|mozaik\.inilah\.com|mediacenter\.palangkaraya\.go\.id|viva\.co\.id\/foto|nokenlive|polreskedirikota|korankaltim|pelakita|cilegon\.go\.id|twaslnews|kilangbara\.com|klikmu\.co/i;
function parseFeed(xml, feedUrl = 'https://localhost/') {
  const out = [];
  for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const b = m[1], title = tag(b, 'title');
    const rawLink = tag(b, 'link') || tag(b, 'guid');
    const url = MEDIA.resolveUrl(rawLink, feedUrl);
    const d = tag(b, 'pubDate') || tag(b, 'dc:date');   // dc:date = RSS 1.0/RDF (DW)
    const isGN = /^https?:\/\/news\.google\.com\//i.test(url);
    const srcUrl = (b.match(/<source[^>]*url="([^"]+)"/i) || [])[1] || '';   // GN bungkus domain asli di atribut source url — tanpa ini BANNED_SRC buta
    const bid = title + ' ' + url + ' ' + tag(b, 'source') + ' ' + srcUrl;
    if (title && url && !BANNED_SRC.test(bid)) {
      const rssImgs = MEDIA.extractFeedImageCandidates(b, url || feedUrl);
      out.push({
        title, url, ts: d ? Date.parse(d) || 0 : 0,
        img: '', rssImg: rssImgs[0] || '', rssImgs,
        pub: cleanPub(tag(b, 'source')), desc: isGN ? '' : descOf(b, title)
      });
    }
  }
  for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
    const b = m[1], l = b.match(/<link[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*>([^<]+)<\/link>/i), d = tag(b, 'updated') || tag(b, 'published');
    const t = tag(b, 'title');
    const rawLink = (l && (l[1] || '').trim()) || '';
    const url = MEDIA.resolveUrl(rawLink, feedUrl);
    const isGN2 = /^https?:\/\/news\.google\.com\//i.test(url);
    const bid = t + ' ' + url;
    if (url && t && !BANNED_SRC.test(bid)) {
      const rssImgs = MEDIA.extractFeedImageCandidates(b, url || feedUrl);
      out.push({
        title: t, url, ts: Date.parse(d) || 0,
        img: '', rssImg: rssImgs[0] || '', rssImgs,
        desc: isGN2 ? '' : descOf(b, t)
      });
    }
  }
  // Deteksi aset situs/logo yang berulang di >=3 item berbeda dalam satu feed RSS
  // (2 item berurutan sering membagi foto arsip tokoh/event yang sah)
  const imgFreq = new Map();
  for (const it of out) {
    if (!it.rssImg) continue;
    const k = MEDIA.imageKey(it.rssImg);
    if (!imgFreq.has(k)) imgFreq.set(k, new Set());
    imgFreq.get(k).add(MEDIA.canonicalArticleUrl(it.url) || it.url);
  }
  for (const it of out) {
    if (!it.rssImg) continue;
    const k = MEDIA.imageKey(it.rssImg);
    if ((imgFreq.get(k)?.size || 0) >= 3) {
      assetReuse.markFeedReused(it.rssImg);
      it.rssImg = '';
      it.rssImgs = [];
    }
  }
  return out;
}
/* ---------- bersihkan suffix "- Sumber" dari headline, bersumber dari feedtext.js ---------- */
const { cleanTitle } = FEEDTEXT;
const feedSigMap = new Map();
// Sidik isi feed: hash semua url+ts, bukan cuma item pertama. Perubahan di
// tengah daftar (item lama naik peringkat, judul diganti) tetap memicu
// invalidasi; biayanya ~2 ms per siklus 55 detik untuk 51 feed.
const feedSig = items => {
  let h = 5381;
  for (const it of items) {
    const s = (it.ts || 0) + '|' + (it.url || '');
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  }
  return items.length + ':' + (h >>> 0);
};
// Revisi konten feed: naik hanya saat isi salah satu feed benar-benar berubah.
// Dipakai untuk memo klasifikasi topik — tanpa ini, 2.800 judul diklasifikasi
// ulang (≈730 ms socAssess) tiap kali /api/news, /api/incidents, atau
// /api/situation recompute, yaitu 3x per menit di event loop yang sama.
let NEWS_REV = 0;
let newsHeatRev = 0;
const newsHistKey = it => {
  const u = String(it && it.url || '');
  if (/news\.google\.com/i.test(u)) {
    const k = breakNorm(cleanTitle(it.title || '', it.pub || ''));
    if (k && k.length >= 12) return 'gn:' + k;
  }
  return MEDIA.canonicalArticleUrl(u) || u;
};
function loadNewsHist() {
  try {
    const j = JSON.parse(fs.readFileSync(NEWS_HIST_FILE, 'utf8'));
    const now = Date.now();
    for (const it of (j.posts || [])) {
      if (!it || !it.src || !it.url || !it.title) continue;
      const ts = Number(it.ts) || 0;
      if (ts <= 0 || ts > now + 5 * 60e3 || now - ts > 24 * 3600e3) continue;
      if (BANNED_SRC.test((it.title || '') + ' ' + it.url + ' ' + (it.pub || ''))) continue;
      if (FEEDTEXT.newsEnglish(it.title, it.desc)) continue;
      let m = newsHistByFeed.get(it.src);
      if (!m) { m = new Map(); newsHistByFeed.set(it.src, m); }
      const k = newsHistKey(it);
      if (k) m.set(k, it);
    }
    for (const [fid, m] of newsHistByFeed) {
      const sorted = [...m.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, NEWS_FEED_CAP);
      const next = new Map();
      for (const it of sorted) next.set(newsHistKey(it), it);
      newsHistByFeed.set(fid, next);
    }
  } catch (e) {}
}
loadNewsHist();
function mergeNewsHist(id, liveItems, now, opts = {}) {
  let m = newsHistByFeed.get(id);
  if (!m) { m = new Map(); newsHistByFeed.set(id, m); }
  for (const [k, prev] of m) {
    if (!prev || !prev.ts || prev.ts <= 0 || prev.ts > now + 5 * 60e3 || now - prev.ts > 24 * 3600e3 || BANNED_SRC.test((prev.title || '') + ' ' + (prev.url || '') + ' ' + (prev.pub || ''))) {
      m.delete(k);
    }
  }
  for (const it of liveItems) {
    const cleanIt = { ...it, title: cleanTitle(it.title, it.pub), src: id };
    const ts = Number(cleanIt.ts) || 0;
    if (ts <= 0 || ts > now + 5 * 60e3 || now - ts > 24 * 3600e3) continue;
    if (BANNED_SRC.test(cleanIt.title + ' ' + cleanIt.url + ' ' + (cleanIt.pub || ''))) continue;
    if (FEEDTEXT.newsEnglish(cleanIt.title, cleanIt.desc)) continue;
    const k = newsHistKey(cleanIt);
    if (!k) continue;
    const old = m.get(k);
    if (old) {
      const betterDesc = (cleanIt.desc || '').length >= (old.desc || '').length ? cleanIt.desc : old.desc;
      const betterRssImgs = (cleanIt.rssImgs && cleanIt.rssImgs.length) ? cleanIt.rssImgs : (old.rssImgs || []);
      m.set(k, { ...old, ...cleanIt, desc: betterDesc || '', rssImg: (betterRssImgs[0] || cleanIt.rssImg || old.rssImg || ''), rssImgs: betterRssImgs, ts: Math.max(old.ts || 0, ts) });
    } else {
      m.set(k, cleanIt);
    }
  }
  const merged = [...m.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, NEWS_FEED_CAP);
  const nextMap = new Map();
  for (const it of merged) {
    nextMap.set(newsHistKey(it), it);
    if (it && it.url) registerNewsUrl(it.url);
  }
  newsHistByFeed.set(id, nextMap);
  if (liveItems.length && opts.persist !== false) { newsHistDirty = true; saveNewsHist(false); }
  return merged;
}
function invalidateDerivedFromNews() {
  NEWS_REV++;
  newsHeatRev++;
  cache.delete('situation');
  cache.delete('incidents');
  cache.delete('breaking');
  cache.delete('newsresp:v' + PIPELINE_VERSION);
  cache.delete('newsheat');
  cache.delete('newskw');
  bodyCache.delete('situation');
  bodyCache.delete('incidents:all');
  bodyCache.delete('incidents:nonodes');
  bodyCache.delete('breaking');
  bodyCache.delete('newsresp:v' + PIPELINE_VERSION);
  bodyCache.delete('x');
  bodyCache.delete('threads');
  assessedRev = -1;
  assessedCacheMap = null;
  assessedInflight = null;
}
async function fetchFeedEntry(id, url) {
  const customProxy = process.env.CUSTOM_PROXY_URL || process.env.PROXY_URL || CFG.custom_proxy;
  const attempts = [
    url,
    ...(customProxy ? [(customProxy.endsWith('/') ? customProxy : customProxy + '/') + encodeURIComponent(url)] : []),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    'https://test.cors.workers.dev/?' + encodeURIComponent(url)
  ];
  let lastErr = '';
  const t0 = Date.now();
  // rss.tempo.co = edisi INGGRIS (bukan untuk wire ID) dan tempo.co utama di-blokir
  // Cloudflare; exclude edisi berbayar koran/majalah/plus & Inggris agar wire tetap bersih.
  if (id === 'TEMPO') attempts.unshift('https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent('site:tempo.co -site:koran.tempo.co -site:majalah.tempo.co -site:plus.tempo.co -site:en.tempo.co when:2d'));
  // voi.id/rss dibalik Cloudflare 403 — siapkan Google News site:voi.id sebelum proxy CORS lambat/timeout.
  if (id === 'VOI') attempts.splice(customProxy ? 2 : 1, 0, 'https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent('site:voi.id when:2d'));
  outer: for (const u of attempts) {
    for (let i = 0; i < 2; i++) {
      if (Date.now() - t0 > 26000) break outer;   // deadline per feed: jangan biarkan satu feed macetkan semua
      try {
        const isDirectPub = !/^https?:\/\/(?:news\.google\.com|r\.jina\.ai|corsproxy\.|api\.allorigins\.|api\.codetabs\.)/i.test(u);
        const initHdrs = id === 'JPNN'
          ? { headers: { 'user-agent': 'Wget/1.21' } }
          : (isDirectPub ? { headers: { 'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7' } } : {});
        let r = await get(u, initHdrs, 12000);
        if (!r.ok && isDirectPub && (r.status === 403 || r.status === 406 || r.status === 429)) {
          try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
          r = await get(u, {
            headers: {
              'user-agent': 'WhatsApp/2.23.20.0 A',
              accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
            }
          }, 12000);
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const items = parseFeed(await r.text(), url);
        if (!items.length) throw new Error('feed kosong');
        const now = Date.now();
        const fresh = items.filter(it => !it.ts || (it.ts <= now + 5 * 60e3 && now - it.ts <= 24 * 3600e3));
        const newest = Math.max(0, ...fresh.map(i => i.ts || 0));
        const outItems = mergeNewsHist(id, fresh, now);
        // Tangkap item tanpa timestamp XML sebagai live fallback bila masih ada
        if (!outItems.length && fresh.length) {
          for (const it of fresh.slice(0, NEWS_FEED_CAP)) outItems.push({ ...it, title: cleanTitle(it.title, it.pub), src: id });
        }
        const sig = feedSig(outItems);
        const prevSig = feedSigMap.get(id);
        if (prevSig && prevSig !== sig) invalidateDerivedFromNews();
        feedSigMap.set(id, sig);
        const stale = !fresh.length || !!(newest && now - newest > 3 * 3600e3);
        return { id, ok: true, stale, items: outItems, at: now };
      } catch (e) {
        lastErr = String(e.message || e);
        if (/^HTTP (?:403|404|410)\b/.test(lastErr)) break;
        if (i === 0) await new Promise(res => setTimeout(res, 350));
      }
    }
  }
  return { id, ok: false, err: ('gagal direct + proxy: ' + lastErr).slice(0, 140), items: [] };
}
let lastManualNewsBustAt = 0, manualNewsBustInflight = null;
async function refreshNewsNow() {
  if (manualNewsBustInflight) return manualNewsBustInflight;
  const now = Date.now();
  if (now - lastManualNewsBustAt < 10000) return news();
  lastManualNewsBustAt = now;
  manualNewsBustInflight = (async () => {
    try {
      const prevMap = new Map(NEWS.map(([id]) => [id, cache.get('n:' + id)?.v]));
      const next = await Promise.all(NEWS.map(([id, url]) => fetchFeedEntry(id, url).then(v => {
        if (v && v.ok) {
          cache.set('n:' + id, { at: Date.now(), v });
          return v;
        }
        const prev = prevMap.get(id);
        return (prev && prev.ok) ? prev : v;
      }, () => prevMap.get(id) || { id, ok: false, err: 'fetch gagal', items: [] })));
      invalidateDerivedFromNews();
      return next;
    } finally {
      manualNewsBustInflight = null;
    }
  })();
  return manualNewsBustInflight;
}
const news = () => manualNewsBustInflight || Promise.all(NEWS.map(([id, url]) => memo('n:' + id, 55000, () => fetchFeedEntry(id, url), v => v.ok === true)));

/* ---------- taksonomi: insiden fisik (geo) + topik sosial ---------- */
// Daftar penyakit/wabah — satu sumber untuk CATS (News Wire) & HEALTH_EVENT_RE
// (gate plotOk peta/globe). Sumber istilah: daftar infeksi emerging Kemenkes +
// pola judul kesehatan media RI (TBC, DBD, influenza, HFMD, leptospirosis, dst).
const HEALTH_DZ = String.raw`wabah|\bklb\b|kejadian luar biasa|dbd|\bdhf\b|demam berdarah|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|typhoid|kolera|rabies|gila anjing|anjing gila|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|intoksikasi|rotavirus|flu burung|h1n1|malaria|salmonella|e\.?\s*coli|bakteri pangan`;
// istilah insiden layanan/kondisi kesehatan (bukan nama penyakit) — ikut ke
// HEALTH_EVENT_RE supaya plotOk tidak membuang item yang CATS sudah terima
const HEALTH_EVT = String.raw`gagal ginjal|gizi buruk|busung lapar|malnutrisi|donor darah|bank darah|transfusi darah|stok darah|obat palsu|talasemia|hemofilia|keracunan (?:massal|makanan|mbg|pangan|nasi|katering|gas|miras|hidrogen sulfida|karbon monoksida)?|miras oplosan|alkohol oplosan|oplosan maut|makanan (?:basi|beracun|kedaluwarsa|kadaluwarsa)|mual|muntah|dilarikan ke (?:rs|puskesmas|rumah sakit)|gejala keracunan|etilen glikol|dietilen glikol|cemaran obat|sirup beracun|obat sirup`;
const CATS = [
  { id:'demo', label:'Demo', sev:0.82, geo:true, re:/(\bdemo\b(?!\s*(aplikasi|game|produk|sistem|fitur|cara|tutorial|masak|memasak|kuliner|spesial|special))(?<!cooking demo|cooking\s+demo)|unjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|long march|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day)/i },
  { id:'fire', label:'Kebakaran', sev:0.96, geo:true, re:/(?:\b(?:kebakaran|karhutla|kebakaran hutan|kebakaran lahan|terbakar|kobaran api|asap tebal)\b)(?!\s+(?:jenggot|harga|promo|diskon|api amarah|api cemburu|api asmara|semangat))/i },
  { id:'flood', label:'Banjir', sev:0.86, geo:true, re:/(?:\bbanjir\b(?!\s*(?:serangan|siber|cyber|orderan|hadiah|promo|diskon|bonus|cuan|kritik|hujatan|komentar|aduan|laporan|pujian|ucapan|impor|produk|pemudik|turis|wisatawan|penonton|pelamar|pendaftar|peserta|air mata|gol))\b|banjir bandang|banjir rob|banjir lahar|banjir lumpur|banjir kiriman|terendam banjir|merendam pemukiman|genangan air|air meluap|tanggul jebol|tanah longsor|\blongsor\b(?!\s*(?:saham|suara|harga|ihsg|rupiah|kurs))\b|cuaca ekstrem|hujan deras|\brob\b|\bkebanjiran\b(?!\s*(?:orderan|hadiah|promo|diskon|bonus|cuan|kritik|hujatan|komentar|aduan|laporan|pujian|ucapan|impor|produk|pesan|chat|dm|keluhan|tamu|serangan|siber))\b)/i },
  { id:'disaster', label:'Bencana', sev:1, geo:true, re:/(?:\b(?:gempa|tsunami|erupsi|letusan|gunung meletus|gunung api|awan panas|hujan abu|lahar dingin|lahar hujan|badai|siklon|puting beliung|angin kencang|angin ribut|badai petir|gelombang tinggi|gelombang pasang|bibit siklon|bencana|evakuasi|korban jiwa|ambruk|tenggelam|hanyut|likuefaksi)\b)(?!\s+(?:politik|jagat|dunia|maya|netizen|pasar|bursa|phk|impor|suara|protes|regulasi|vonis|kasus))/i },
  { id:'insiden', label:'Insiden', sev:0.62, geo:true, re:/(?:\b(?:kecelakaan|ledakan|pohon tumbang|runtuh|tabrakan|tabrak lari|kapal karam|pesawat jatuh|tergelincir|terjun)\b)(?!\s+(?:penduduk|kasus|inflasi|harga|daya beli|ihsg|rupiah|saham|kurs|suara))/i },
  { id:'siber', label:'Siber', sev:0.55, geo:false, re:/(peretasan|peretas|hacker|ransomware|phishing|malware|ddos|botnet|zero[- ]day|n[- ]?day|\bcve[- ]?\d{4}|exploit|dieksploitasi|kerentanan|vulnerabilit|backdoor|spyware|skimming|carding|cryptojack|deepfake|deface|defacement|vishing|smishing|sextortion|kebocoran data|bocor data|data breach|pencurian data|akun dibajak|akun palsu|scam|penipuan online|pinjol ilegal|investasi bodong|bssn|badan siber|serangan siber|serangan cyber|insiden keamanan|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|layanan lumpuh|situs lumpuh|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|infrastruktur kritis|apt\d{1,2}\b|command and control|leak site|akun (media sosial|instagram|facebook|whatsapp|telegram|x|tiktok) (dibajak|diretas|dibobol))/i },
  { id:'kriminal', label:'Kriminal', sev:0.78, geo:true, re:/(penembakan|pembunuhan|pengeroyokan|begal|curat|pencurian|perampokan|penangkapan|ditangkap|tersangka|kabur dari lapas|napi kabur|terorisme|radikalisasi|suap|gratifikasi|penipuan|narkoba|psikotropika|penculikan|perkosaan|rudapaksa)/i },
  { id:'kesehatan', label:'Kesehatan', sev:0.65, geo:true, re:new RegExp('(?:' + HEALTH_DZ + '|' + HEALTH_EVT + '|stunting|obesitas|vaksin|vaksinasi|imunisasi|kemenkes|bpom|faskes|puskesmas|kanker|keracunan mbg|korban mbg|sppg|badan gizi nasional)', 'i') },
  { id:'ekonomi', label:'Ekonomi', sev:0.5, geo:false, re:/(phk|rupiah|kurs dollar|inflasi|defisit|apbn|apbd|ihsg|bursa efek|saham|emiten|dividen|stock split|buyback|right issue|utang negara|subsidi|\bbbmm?\b|pertamax|solar(?!\s*panel)|listrik padam|padam listrik|pemadaman listrik|pertamina|\bpln\b|ojk|bank indonesia|umk\b|ump\b|thr\b|belanja negara|bea cukai|ekspor|impor|suku bunga|bappebti|kripto|bitcoin|pinjol|fintech|paylater|harga (cabai|beras|daging|minyak|emas))/i },
  { id:'politik', label:'Politik', sev:0.55, geo:false, re:/(pilpres|pilkada|pilgub|pilbup|pilgici|pemilu|\bkpu\b|kpud|bawaslu|capres|cawapres|partai politik|caleg|capil|\bdpr\b|\bdprd\b|parlemen|fraksi|koalisi|oposisi|pelantikan|menteri|wakil presiden|\bistana\b|senayan|bansos|rapat paripurna|mahkamah konstitusi|impeachment|majelis kehormatan|reshuffle|menko|kadin|\bperang\b|\bkonflik\b|\binvasi\b|aneksasi|pendudukan|gencatan senjata|ultimatum|kudeta|pemberontakan|separatis|genosida|blokade|embargo|sandera|pertempuran|peluru kendali|\brudal\b|\bdron\b|serangan udara|perjanjian damai|perundingan damai|program mbg|makan bergizi)/i }
];
// SKIP_JUNK = konten non-insiden (mitigasi/imbau/hiburan/olahraga) — veto universal.
// Nama negara/kota SENGAJA tidak ikut: filter letak geografis crude dan membunuh
// berita relevan ("WNI dievakuasi dari Tokyo"). Berita luar boleh tampil di wire;
// pencegahan pin tetap structural via gazetteer Indonesia-only + scope foreign.
const SKIP_JUNK = /(pascabencana|pascagempa|pascabanjir|mitigasi|kesiapsiagaan(?!\s*(?:pengamanan|aparat|pasukan|personel|polri|tni|demo|unjuk rasa|aksi))|potensi bencana|rawan bencana|risiko bencana|kajian risiko|simulasi|edukasi|sosialisasi|pelatihan|antisipasi(?!\s*(?:demo|unjuk rasa|aksi|massa|kerusuhan|bentrok|keamanan|pengamanan))|siaga bencana|hadapi bencana|menghadapi bencana|asuransi|operasi patuh|ranperda|perda|godok|dana bencana|tas bencana|go[- ]?bag|pusdalops|kebutuhan darurat|peralatan bencana|salurkan bantuan|menyalurkan|penyaluran|modus|ruu|boikot dirinya|perang harga|perang dagang|joget|\bolahraga\b|timnas|atletik|sea games|olimpiade|asiad|liga|top skor|voli|sepak bola|badminton|bulu tangkis|piala|kualifikasi|gaun|mahalini|fashion|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|penghargaan|jasa raharja|warisan|turun-temurun|sepanjang 20\d\d|berdampak ke ekonomi|\bjanda\b|\bduda\b|\bbispak\b|\bbokep\b|\bsange\b|\bcolmek\b|\bpacar\b|\bgebetan\b|\bskincare\b|\bkpop\b|\bdrakor\b|\banime\b)/i;
// SKIP_RE = junk + geo — hanya untuk jalur sosial/tren yang memang mau fokus Indonesia.
const SKIP_FOREIGN = /(brasil|brazil|amerika serikat|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|perancis|paris|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza|poland|polandia|polonia|krakow|warsaw|warszawa|lublin|czechia|ceko|prague|austria|wina|vienna|finland|finlandia|singapura|singapore|suriah|syria|irak|iraq|mesir|egypt|libya|libia|maroko|morocco|aljazair|algeria|tunisia|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|hungaria|hungary|rumania|romania|bulgaria|serbia|kroasia|croatia|slowakia|slovakia|slovenia|belgia|belgium|irlandia|ireland|estonia|latvia|lithuania|belarus|mongolia|maladewa|maldives|timor leste|selandia baru|new zealand|kuba|cuba|jamaika|jamaica|haiti|nikaragua|kosta rika|costa rica|kolombia|colombia|venezuela|bolivia|ekuador|ecuador|peru|paraguay|uruguay|congo|rwanda|uganda|tanzania|zambia|zimbabwe|mozambique|angola|namibia|botswana|lesotho|madagascar|mauritius|somalia|eritrea|djibouti|afghanistan|bhutan|brunei|albania|armenia|azerbaijan|cyprus|iceland|kosovo|luxembourg|malta|moldova|montenegro|san marino|vatikan|vatican|monako|monaco|georgia|jordan|panama|senegal|cameroon|gambia|guinea|sierra leone|liberia|mauritania|burkina faso|tokyo|seoul|beijing|shanghai|hong kong|taipei|bangkok|hanoi|manila|kualalumpur|kathmandu|moskwa|moscow|berlin|rome|roma|madrid|amsterdam|brussels|zurich|stockholm|oslo|copenhagen|helsinki|dublin|budapest|bucharest|sofia|belgrade|zagreb|vilnius|riga|tallinn|minsk|kiev|kyiv|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|nairobi|kampala|kigali|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|bangui|yaounde|conakry|lome|cotonou|abidjan|nouakchott|maseru|mbabane|gaborone|windhoek|maputo|antananarivo|moroni|port louis|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|port-au-prince|nassau|bridgetown|castries|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|sucre|guayaquil)/i;
const SKIP_RE = new RegExp('(?:' + SKIP_JUNK.source.slice(1, -1) + ')|(?:' + SKIP_FOREIGN.source.slice(1, -1) + ')', 'i');
const catMeta = id => CATS.find(c => c.id === id) || { id:'', label:'Insiden', sev:0.5, geo:true };
// Cache per-judul: socAssess ~0,27 ms/panggilan dan judul yang sama dipakai
// lintas siklus (news, incidents, situation, heat, tren). 2.690 judul unik =
// 734 ms CPU per pass; dengan memo ini pass berikutnya tinggal Map lookup.
// Aman di-cache karena socAssess(t) di sini tidak menerima `extra` (topik adhoc).
function memoByText(fn, cap = 12000) {
  const m = new Map();
  return t => {
    let v = m.get(t);
    if (v !== undefined) { m.delete(t); m.set(t, v); return v; }
    v = fn(t);
    m.set(t, v);
    if (m.size > cap) m.delete(m.keys().next().value);
    return v;
  };
}
const assessNews = memoByText(t => SOC.socAssess(t), 12000);
// assessNews (socAssess) mahal dan dipanggil 2-3x per judul yang sama (kategori,
// cek scope, field assessment). assessCycle() = memo lokal per satu siklus fetch:
// judul sama → hasil sama, Map dibuang setelah fungsi caller selesai.
const assessCycle = () => {
  const m = new Map();
  return t => {
    let a = m.get(t);
    if (!a) { a = assessNews(t); if (m.size > 8000) m.delete(m.keys().next().value); m.set(t, a); }
    return a;
  };
};
const projectAssessment = a => {
  if (!a || typeof a !== 'object') return a;
  const out = {
    version: a.version,
    topics: a.topics,
    scope: a.scope,
    reportType: a.reportType,
    feedEligible: a.feedEligible,
    signalEligible: a.signalEligible,
    feedLane: a.feedLane,
    intent: a.intent,
    events: a.events,
    severity: a.severity,
    findings: Array.isArray(a.findings) && a.findings.length
      ? a.findings.map(f => ({ topic: f.topic, scope: f.scope, ...(f.feedOnly ? { feedOnly: true } : {}) }))
      : [],
  };
  if (a.geographicContext && a.geographicContext.name) {
    out.geographicContext = { role: a.geographicContext.role, name: a.geographicContext.name };
  }
  if (a.provenance && a.provenance.sourceType) {
    out.provenance = { sourceType: a.provenance.sourceType };
  }
  return out;
};
const projectNewsAssessment = a => {
  if (!a || typeof a !== 'object') return a;
  const out = { version: a.version, scope: a.scope };
  if (Array.isArray(a.events) && a.events.length) out.events = a.events;
  if (Array.isArray(a.topics) && a.topics.length) out.topics = a.topics;
  if (Array.isArray(a.findings) && a.findings.length) {
    out.findings = a.findings.map(f => ({ topic: f.topic, scope: f.scope, ...(f.feedOnly ? { feedOnly: true } : {}) }));
  }
  if (a.signalEligible) out.signalEligible = true;
  if (a.feedEligible) out.feedEligible = true;
  return out;
};
// Cache hasil klasifikasi per siklus feed dengan single-flight + yield periodik agar event loop tidak stall.
let assessedRev = -1, assessedItemCount = -1, assessedCacheMap = null, assessedInflight = null;
async function assessedNewsFor(srcs) {
  let total = 0;
  for (const s of srcs) total += (s && Array.isArray(s.items)) ? s.items.length : 0;
  if (assessedCacheMap && assessedRev === NEWS_REV && assessedItemCount === total) return assessedCacheMap;
  if (assessedInflight && assessedInflight.rev === NEWS_REV && assessedInflight.total === total) {
    return assessedInflight.promise;
  }
  const startRev = NEWS_REV;
  const run = (async () => {
    const aOf = assessCycle();
    const bySource = new Map();
    let batch = 0;
    for (const s of srcs) {
      if (!s || !Array.isArray(s.items)) continue;
      const rows = new Array(s.items.length);
      for (let i = 0; i < s.items.length; i++) {
        const it = s.items[i];
        const a = aOf(it.title);
        const cat = catOf(it.title, a);
        const fr = foreignOf(it.title, a);
        const pl = cat ? placeOf(it.title) : null;
        rows[i] = { a, cat, fr, pl };
        if (++batch >= 250) { batch = 0; await yieldTick(); }
      }
      bySource.set(s.id, rows);
    }
    if (assessedRev === -1 || startRev === NEWS_REV) {
      assessedRev = startRev;
      assessedItemCount = total;
      assessedCacheMap = bySource;
    }
    return bySource;
  })().finally(() => {
    if (assessedInflight && assessedInflight.rev === startRev) assessedInflight = null;
  });
  assessedInflight = { rev: startRev, total, promise: run };
  return run;
}
// Scope foreign yang andal untuk display/agregat: findings ada → ada finding
// foreign dan tidak ada yang Indonesia (mixed_scope = bukan foreign murni);
// findings kosong → classifyScope langsung dari judul.
const foreignOf = (t, a) => {
  const fs = (a && a.findings) || [];
  if (fs.length) return fs.some(f => f.scope === 'foreign') && !fs.some(f => f.scope === 'Indonesia');
  return ASSESS.classifyScope(t, null).scope === 'foreign';
};
/* ---------- Disambiguasi Semantik: Domain Spesifik vs Bencana Fisik ---------- */
const DOMAIN_CATS = ['siber', 'kesehatan', 'ekonomi', 'politik', 'kriminal'];

const PHYSICAL_ACT = {
  flood: /(?:terendam|merendam|menggenang|menggenangi|tergenang|ketinggian\s+\d+|air\s+meluap|tanggul\s+jebol|banjir\s+bandang|banjir\s+rob|hujan\s+deras|luapan\s+air)/i,
  insiden: /(?:kecelakaan|tabrakan|tertabrak|menabrak|terguling|anjlok|pesawat\s+jatuh|kapal\s+(?:karam|tenggelam)|pohon\s+tumbang|jembatan\s+(?:ambruk|putus)|gedung\s+ambruk|atap\s+roboh|meledak\s+di|ledakan\s+tabung|ledakan\s+bom)/i,
  disaster: /(?:gempa\b|magnitudo\b|m\s*[\d,.]+|kedalaman\s+\d+|skala\s+richter|erupsi|gunung\s+meletus|awan\s+panas|lahar|siklon|puting\s+beliung|angin\s+kencang|gelombang\s+tinggi)/i,
  fire: /(?:kebakaran|karhutla|terbakar|kobaran\s+api|ludes\s+dilalap|asap\s+tebal|damkar)/i
};

const METAPHOR_DISASTER = {
  flood: /(?:dibanjiri|membanjiri)|(?:banjir|kebanjiran)\s+(?:serangan|siber|cyber|orderan|hadiah|promo|diskon|bonus|cuan|kritik|hujatan|komentar|aduan|laporan|pujian|ucapan|impor|produk|pemudik|turis|wisatawan|penonton|pelamar|pendaftar|peserta|air mata|gol|darah)/i,
  disaster: /tsunami\s+(?:politik|protes|suara|pemilu|dukungan|saham|cuan|phk|vonis|anggaran|impor)|badai\s+(?:phk|ekonomi|krisis|politik|pemilu|kritik|inflasi|suara|cuan|rezeki|impor|kehidupan|hidup|rumah\s+tangga|ujian|cobaan)/i,
  insiden: /ledakan\s+(?:kasus|pasien|penderita|penduduk|order|penjualan|harga|promo|suara)|tabrakan\s+(?:kepentingan|argumen|opini|jadwal)|(?:ihsg|saham|rupiah|kurs|harga|suara|koalisi|rezim|pemerintah)\s+(?:ambruk|runtuh)/i,
  fire: /kebakaran\s+(?:jenggot|harga|promo|diskon)/i
};

const DOMAIN_ACTIVE_ACT = {
  siber: /(?:peretasan|peretas|diretas|dibajak|dibobol|hacker|ransomware|ddos|data\s+breach|kebocoran\s+data|bocor\s+data|serangan\s+siber|serangan\s+cyber|exploit|dieksploitasi|phishing|malware|vulnerabilit)/i,
  ekonomi: /(?:phk|rupiah\s+(?:melemah|anjlok)|ihsg\s+(?:anjlok|turun|terkoreksi)|inflasi|suku\s+bunga|kebijakan\s+tarif)/i,
  kesehatan: /(?:terjangkit|terinfeksi|tertular|positif|pasien|korban\s+keracunan|gejala|dilarikan\s+ke\s+rs)/i,
  politik: /(?:pilpres|pilkada|pelantikan|pemilu|sidang|reshuffle|perang|invasi|gencatan\s+senjata)/i,
  kriminal: /(?:ditembak|dibunuh|ditangkap|membunuh|merampok|tersangka|terorisme)/i
};

const CAT_PRECEDENCE = ['demo', 'fire', 'flood', 'disaster', 'siber', 'kesehatan', 'kriminal', 'ekonomi', 'politik', 'insiden'];

function resolveCategory(ids, title) {
  const candidates = new Set(ids);
  for (const c of candidates) {
    if (METAPHOR_DISASTER[c] && METAPHOR_DISASTER[c].test(title)) candidates.delete(c);
  }
  const hasDomain = DOMAIN_CATS.some(d => candidates.has(d));
  if (hasDomain) {
    for (const d of ['flood', 'disaster', 'insiden']) {
      if (candidates.has(d)) {
        const hasPhys = PHYSICAL_ACT[d] && PHYSICAL_ACT[d].test(title);
        if (!hasPhys) candidates.delete(d);
      }
    }
  }
  const physWinners = ['fire', 'flood', 'disaster'].filter(c => candidates.has(c) && PHYSICAL_ACT[c] && PHYSICAL_ACT[c].test(title));
  if (physWinners.length > 0) {
    for (const d of DOMAIN_CATS) {
      if (candidates.has(d)) {
        const hasActiveDomain = DOMAIN_ACTIVE_ACT[d] && DOMAIN_ACTIVE_ACT[d].test(title);
        if (!hasActiveDomain) candidates.delete(d);
      }
    }
  }
  for (const p of CAT_PRECEDENCE) {
    if (candidates.has(p)) return p;
  }
  return candidates.values().next().value || '';
}

const catOf = (t, a) => {
  a = a || assessNews(t);
  // Feed categorization = topic relevance, BUKAN signal eligibility.
  // events[] hanya untuk alarm/klaster; headline berita jarang punya EVENT_ACTION
  // jadi events kosong untuk sebagian besar judul legit.
  if (!a.topics.length) return '';
  if (SKIP_JUNK.test(t)) {
    const isCrisisOrDemo = /(?:demo|unjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|tsunami|gempa|erupsi|kebakaran|banjir|pengamanan|siagakan|siapkan)/i.test(t);
    if (!isCrisisOrDemo) return '';
  }
  // Scope foreign TIDAK membuang kategori: berita luar boleh berlabel (badge +
  // flag 'foreign' → UI tandai Global). Pencegahan geo tetap structural di
  // incidents()/situation()/breaking() via foreignOf — bukan di sini.
  // NON_NEWS_TOPICS: transport/pendidikan tidak punya kategori berita insiden
  // Topik ekonomi seperti bbm/pangan/bansos dan mbg (kesehatan) tetap diberi
  // kategori agar wire ekonomi & kesehatan tidak steril.
  const NON_NEWS_TOPICS = new Set(['pendidikan', 'transport']);
  const ids = new Set(a.topics.filter(tp => !NON_NEWS_TOPICS.has(tp)).map(tp => ASSESS.CATEGORY[tp]).filter(Boolean));
  if (!ids.size) return '';
  return resolveCategory(ids, t);
};
const INCIDENT_RE = new RegExp(CATS.map(c => c.re.source).join('|'), 'i');
// feed topik menjamin tabnya tidak kosong: item GNEWS·SIBER yang lolos SKIP_RE tapi
// tidak kena regex tetap masuk kategori feed-nya
const FEED_CAT = { demo:'demo', kebakaran:'fire', banjir:'flood', bencana:'disaster', insiden:'insiden', kriminal:'kriminal', kesehatan:'kesehatan', keracunan:'kesehatan', ekonomi:'ekonomi', politik:'politik', siber:'siber', lingkungan:'disaster' };
const feedCatOf = id => FEED_CAT[String(id || '').toLowerCase().split('·').pop().trim()] || '';

/* ---------- breaking wire: subset panas, dipakai marquee (fetch 45s) ---------- */
const breakNorm = t => String(t).toLowerCase().replace(/\s+-\s+[^-]{2,45}$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const breaking = () => memo('breaking', 25000, async () => {
  const srcs = await news(), seen = new Set(), items = [];
  const now = Date.now(), assessed = await assessedNewsFor(srcs);
  let matched = 0;
  for (const s of srcs) {
    if (!s.ok) continue;
    const rows = assessed.get(s.id) || [];
    for (let idx = 0; idx < s.items.length; idx++) {
      const it = s.items[idx], ev = rows[idx];
      const a = ev.a;
      const cat = ev.cat;
      if (!cat || catMeta(cat).geo === false) continue;
      // Berita luar boleh masuk breaking hanya untuk kategori sev tinggi
      // (gempa/letusan/kebakaran besar) — sisanya cukup di news wire.
      const fr = ev.fr;
      if (fr && catMeta(cat).sev < 0.9) continue;
      const k = breakNorm(it.title).slice(0, 48);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      matched++;
      const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > 24 * 3600e3) continue;
      const recency = Math.max(0.12, Math.exp(-age / (16 * 3600e3)));
      const meta = catMeta(cat);
      items.push({ ...it, assessment: projectAssessment(a), src: s.id, cat, label: meta.label, score: +(meta.sev * recency).toFixed(3), foreign: fr || undefined });
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
const xPool = XPOOL.createXPool(XPOOL.buildXAccounts(process.env, X));
const xHas = () => xPool.has();
async function xQueryId() {
  if (X.query_id) return X.query_id;
  return memo('xqid', 6 * 3600e3, async () => {
    const acc = xPool.pick() || xPool.all()[0];
    const hdr = acc ? { cookie: `auth_token=${acc.auth_token}; ct0=${acc.ct0}`, 'x-csrf-token': acc.ct0 } : {};
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
  const isTweetNode = !!(o.legacy && o.legacy.full_text && o.rest_id);
  if (isTweetNode) {
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
    const rawMedia = (o.legacy.extended_entities && Array.isArray(o.legacy.extended_entities.media) && o.legacy.extended_entities.media)
      || (o.legacy.entities && Array.isArray(o.legacy.entities.media) && o.legacy.entities.media) || [];
    const media = [];
    for (const m of rawMedia) {
      const mu = m && (m.media_url_https || m.media_url);
      if (mu && !media.some(x => x.url === mu)) media.push({ type: 'image', url: mu });
    }
    out.set(o.rest_id, {
      id: o.rest_id,
      handle: h ? '@' + h : '',
      name: uc.name || lg.name || h,
      avatar: String((u && u.avatar && u.avatar.image_url) || lg.profile_image_url_https || '').replace(/_normal(\.\w+)$/, '_bigger$1'),
      text: FEEDTEXT.decodeEntities((nt && nt.text) || o.legacy.full_text),
      urls: extractedUrls,
      media,
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
  for (const k in o) {
    if (isTweetNode && (k === 'quoted_status_result' || k === 'retweeted_status_result')) continue;
    collect(o[k], out);
  }
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
const xCooling = () => xPool.allCooling();
async function xSearchGo(q, cursor, winH) {
  if (!xHas()) throw new Error('auth_token / ct0 belum diisi');
  if (xCooling()) { const until = xPool.earliestReset(); const e = new Error('X rate-limit cooldown'); e.cooldown = true; e.retryAt = until; throw e; }
  const id = await xQueryId();
  // winH: jendela since_time dalam jam; <=0 = tanpa filter waktu (dipakai conversation_id)
  const win = winH == null ? 46 : winH;
  const vars = { rawQuery: q + (win > 0 ? ' since_time:' + Math.floor((Date.now() - win * 3600e3) / 1000) : ''), count: 20, querySource: 'typed_query', product: 'Latest' };
  if (cursor) vars.cursor = cursor;   // halaman berikut: rawQuery wajib tetap ada, kalau tidak 422
  const url = `https://api.x.com/graphql/${id}/SearchTimeline`;
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < Math.max(1, xPool.size()); attempt++) {
    const acc = xPool.pick(Date.now(), tried);
    if (!acc) break;
    tried.add(acc);
    const r = await get(url, { method: 'POST', headers: { 'content-type': 'application/json',
      authorization: 'Bearer ' + (X.bearer || BEARER), cookie: `auth_token=${acc.auth_token}; ct0=${acc.ct0}`,
      'x-csrf-token': acc.ct0, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'id', referer: 'https://x.com/search?q=' + encodeURIComponent(q) + '&f=live' },
      body: JSON.stringify({ variables: vars, features: X.features || FEATURES }) }, 20000);
    if (!r.ok) {
      const textSnippet = (await r.text()).slice(0, 160);
      const err = new Error('X HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' (cookie kadaluarsa?)' : '') + ' ' + textSnippet);
      err.status = r.status;
      const resetHdr = r.headers.get('x-rate-limit-reset');
      err.resetTime = resetHdr ? parseInt(resetHdr, 10) * 1000 : 0;
      if (r.status === 429) {
        // cooldown per-akun agar langsung failover ke akun sehat lain di pool
        xPool.markRateLimit(acc, err.resetTime);
        lastErr = err;
        continue;
      }
      if (r.status === 401 || r.status === 403) {
        xPool.markAuthError(acc);
        lastErr = err;
        continue;
      }
      throw err;
    }
    const j = await r.json(), out = new Map(); collect(j, out);
    if (!out.size && !cursor) {   // 200 tapi nol tweet: jangan diam, tampilkan bentuk respons biar kelihatan (IP datacenter / sesi diflag / query kosong)
      if (q.startsWith('conversation_id:')) return { posts: [], cursor: '' };
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
      const raw = JSON.stringify(j);
      throw new Error('X HTTP 200 tapi 0 tweet (' + raw.length + 'B): ' + raw.slice(0, 180));
    }
    if (j.errors && j.errors.length && !out.size) {
      if (q.startsWith('conversation_id:')) return { posts: [], cursor: '' };
      throw new Error(JSON.stringify(j.errors).slice(0, 200));
    }
    return { posts: [...out.values()].map(p => ({ ...p, q })), cursor: bottomCursor(j) };
  }
  if (lastErr) throw lastErr;
  const until = xPool.earliestReset();
  const e = new Error('X rate-limit cooldown'); e.cooldown = true; e.retryAt = until; throw e;
}
const xSearch = (q, cursor, winH) => xSem(() => xSearchGo(q, cursor, winH));
// GetTrends v1.1 (tren Indonesia, WOEID 234): app-only bearer cukup untuk
// endpoint ini. Gagal/401 → [] — tidak ada fallback auth, memo 10 menit.
const xTrends = () => memo('xtrend', 10 * 60e3, async () => {
  try {
    const r = await get('https://api.twitter.com/1.1/trends/place.json?id=234&exclude=hashtags',
      { headers: { authorization: 'Bearer ' + (X.bearer || BEARER) } }, 12000);
    if (!r.ok) return [];
    const j = await r.json(), out = [];
    for (const tr of (j[0] && j[0].trends) || []) {
      const n = String(tr && tr.name || '').replace(/^#/, '').trim();
      if (n.length < 3 || n.length > 30 || out.includes(n)) continue;
      if (SKIP_RE.test(n) || SOC.SOC_FOREIGN_RE.test(n)) continue;
      out.push(n);
      if (out.length >= 5) break;
    }
    return out;
  } catch (e) { return []; }
});
/* ---------- query adaptif: frasa yang sedang naik dari headline ---------- */
const TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu minggu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri').split(' '));
const TBLK = new Set(('detik cnn tempo liputan6 republika tribun cnbc antara jawapos okezone kumparan suara merdeka sindonews jpnn tvri inews media news kompas viva metrotvnews rmol infopublik jabarprov korankaltim tvone merahputih poskota beritasatu gridoto wowkeren bola bolaoverza mediaindonesia faktualnews berita foto video gallery wawancara investigasi khusus daerah nasional internasional ekonomi hiburan selebriti olahraga dishub cumplik').split(' '));
const GEO_INC_RE = new RegExp(CATS.filter(c => c.geo).map(c => c.re.source).join('|'), 'i');
function collectNews24h(srcs, now = Date.now()) {
  const byFeed = new Map();
  for (const s of srcs || []) {
    if (s && s.ok && Array.isArray(s.items) && s.items.length) byFeed.set(s.id, s.items);
  }
  for (const [fid, m] of newsHistByFeed) {
    if (!byFeed.has(fid) && m && m.size) byFeed.set(fid, [...m.values()]);
  }
  const all = [];
  for (const items of byFeed.values()) {
    for (const it of items) {
      if (!it || !Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now + 5 * 60e3 || now - it.ts > 24 * 3600e3) continue;
      all.push(it);
    }
  }
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return all;
}
function newsCacheReady() {
  for (const [id] of NEWS) {
    const c = cache.get('n:' + id);
    if (c && c.v && c.v.ok && Array.isArray(c.v.items) && c.v.items.length) return true;
  }
  return false;
}
async function newsSourcesOrDisk() {
  if (newsCacheReady() || !newsHistByFeed.size) return await news().catch(() => []);
  return [...newsHistByFeed.entries()].map(([id, m]) => ({ id, ok: true, items: [...m.values()] }));
}
const trendingQueries = () => memo('trending', 10 * 60e3, async () => {
  try {
    const now = Date.now(), srcs = await newsSourcesOrDisk();
    const all24 = collectNews24h(srcs, now);
    const titles = [], seenT = new Set();
    for (const it of all24) {
      const k = String(it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (k.length > 10 && !seenT.has(k)) { seenT.add(k); titles.push(it.title); }
      if (titles.length >= 1600) break;
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
        if (words.some(w => w.length < 3 || TSTOP.has(w) || TBLK.has(w) || NEWS_KW_STOP.has(w))) continue;
        // Skip phrases already mapped cleanly into canonical SOC_TOPICS (e.g. 'longsor' -> 'banjir')
        if (SOC.socTopics(ph).length > 0) continue;
        const e = score.get(ph) || [0, 0];
        e[0]++; e[1] += inc; score.set(ph, e);
      }
    }
    const out = [];
    for (const [ph, [n, ctx]] of [...score.entries()].sort((a, b) => (b[1][0] + 2 * b[1][1]) - (a[1][0] + 2 * a[1][1]))) {
      const single = !ph.includes(' ');
      const need = single ? 5 : 3;
      if (n < need) continue;
      if (single && ctx < 2) continue;   // kata tunggal wajib muncul di konteks insiden >=2 judul
      out.push(ph);
      if (out.length >= 8) break;
    }
    return out;
  } catch (e) { return []; }
});
/* ---------- X + Threads: pipeline berbasis topic registry (social.js) ---------- */
const adhocSig = () => ADHOC.map(a => a.id).sort().join(',');
const adhocRefresh = async () => {
  try {
    const tr = (await trendingQueries()).filter(ph => ph.length <= 30 && !SKIP_RE.test(ph) && !SOC.SOC_FOREIGN_RE.test(ph)
      && !SOC.isGenericLocationPhrase(ph)
      && !SOC.SOC_TOPICS.some(t => t.id === ph.toLowerCase())
      && !SOC.socTopics(ph).length);
    ADHOC = SOC.socAdhoc(tr);
  } catch (e) { ADHOC = []; }
  return ADHOC;
};
const topicOf = q => SOC.SOC_TOPICS.concat(ADHOC).find(t => t.id === String(q).toLowerCase());
const tagX = (p, extra, meta = {}) => HISTORY.tag(p, extra || ADHOC, Date.now(), { platform: 'x', recordDiagnostics: true, ...meta }) && SOC.socKeepX(p);
const tagTh = (p, extra, meta = {}) => HISTORY.tag(p, extra || ADHOC, Date.now(), { platform: 'threads', recordDiagnostics: true, ...meta }) && SOC.socKeepTh(p);
const socPosts = () => [
  ...[...xHist.values()].map(p => ({ topics: p.topics, platform: 'x', user: p.handle, ts: histTs(p) })),
  ...[...tHist.values()].map(p => ({ topics: p.topics, platform: 'th', user: p.username, ts: histTs(p) }))];
/* ---------- intel: sinyal trending lintas sumber ---------- */
// post mentah (dengan text) untuk socPhraseScan/socKeywordMine — socPosts()
// sengaja tanpa text karena socHot cuma butuh topics/platform/user.
const richPosts = () => memo('richposts', 60000, async () => [
  ...[...xHist.values()].map(p => ({ text: p.text, ts: histTs(p), topics: p.topics, platform: 'x', user: histUser(p) })),
  ...[...tHist.values()].map(p => ({ text: p.text, ts: histTs(p), topics: p.topics, platform: 'th', user: histUser(p) }))
]);
// topik yang lagi spike di BERITA (cakupan penuh 24 jam across all feeds, time decay).
// Klasifikasi pakai registry yang sama dengan post sosial; ADHOC ikut supaya nama
// kasus baru yang lagi naik juga kehitung. Bobot: <=6h (1.0), 6-12h (0.6), 12-24h (0.3).
const newsTopicHeat = () => memo('newsheat', 300000, async () => {
  try {
    const srcs = await newsSourcesOrDisk(), now = Date.now(), cnt = new Map(), seen = new Set();
    const items = collectNews24h(srcs, now);
    let n = 0;
    for (const it of items) {
      if (n >= 3000) break;
      const t = String(it.title || '');
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now + 5 * 60e3 || now - it.ts > 24 * 3600e3) continue;
      const k = breakNorm(t);
      if (!k || seen.has(k)) continue;
      seen.add(k); n++;
      const ageH = Math.max(0, (now - it.ts) / 3600e3);
      const w = ageH <= 6 ? 1.0 : ageH <= 12 ? 0.6 : 0.3;
      for (const tp of SOC.socTopics(t, ADHOC)) cnt.set(tp, (cnt.get(tp) || 0) + w);
    }
    newsHeatRev++;
    return [...cnt.entries()]
      .filter(([, c]) => c >= 2.0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t, score]) => ({ id: t, score: +score.toFixed(1) }));
  } catch (e) { return []; }
});
// bridge berita→sosial: token yang lagi sering muncul di judul+desc 24 jam.
// news() memang sudah ter-filter ≤24 jam per feed, tapi item GNEWS desc-nya
// kosong — judul saja tetap dihitung. Catatan cakupan: news() hanya memegang
// item fetch terakhir, jadi cakupan efektif = apa yang feed bawa saat ini.
// SOC_KW_RE/SOC_TSTOP tidak diekspor social.js → regex & stopword direplikasi
// di sini. TSTOP+TBLK lokal tidak cukup: kata fungsi umum (dalam/atas/belum/
// saja/dst) dan SEMUA nama tempat (jakarta/jawa/dst) ikut lolos — nama tempat
// dibuang terpisah lewat GEO.locate di bawah, bukan stopword.
const NEWS_KW_RE = /[a-z][a-z'-]{3,}/g;
// kata fungsi/adverbia Indonesia yang tidak ada di TSTOP/TBLK — tanpa ini
// token paling sering = kata pengisi, bukan keyword yang berguna untuk query.
const NEWS_KW_STOP = new Set(('dalam atas bawah antara belum saja hanya lagi harus masih namun tetapi nanti kemarin lusa dekat jauh setiap semua banyak sedikit sedang pernah bukan yaitu yakni bila agar supaya tersebut kaum kaumnya atau rumah warga orang anak pria wanita ibu bapak mobil motor gedung kantor tanah lahan desa kota jalan hari bulan tahun waktu tempat kerja loker jasa harga biaya uang pasar toko produk barang sekolah kampus kuliah teman keluarga makan minum hidup mati kabar cerita kisah acara kegiatan program situasi kondisi proses sistem bentuk bagian nomor nama sosok').split(' '));
const newsKeywords = () => memo('newskw', 600000, async () => {
  try {
    const srcs = await news(), now = Date.now(), pairs = new Map(); let n = 0;
    for (const s of srcs) {
      if (!s.ok) continue;
      for (const it of s.items) {
        if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || now - it.ts > 24 * 3600e3) continue;
        const title = String(it.title || '');
        if (!GEO_INC_RE.test(title)) continue;   // keyword berita HANYA ditambang dari berita insiden/krisis
        n++;
        const actMatch = title.match(GEO_INC_RE);
        const action = actMatch ? actMatch[0].toLowerCase().trim() : '';
        if (!action || action.length < 3 || TSTOP.has(action) || NEWS_KW_STOP.has(action)) continue;
        let locName = '';
        try {
          const loc = GEO.locate(title);
          if (loc && loc.name) locName = loc.name.toLowerCase().trim();
        } catch (_) {}
        if (!locName) {
          const capMatch = title.match(/[A-Z][A-Za-z'-]{3,}(?:\s+[A-Z][A-Za-z'-]{3,})?/g);
          if (capMatch) {
            for (const cm of capMatch) {
              const cml = cm.toLowerCase().trim();
              if (!TSTOP.has(cml) && !TBLK.has(cml) && !NEWS_KW_STOP.has(cml) && !SOC.SOC_FOREIGN_RE.test(cml) && cml !== action) {
                locName = cml;
                break;
              }
            }
          }
        }
        if (!locName || locName === action) continue;
        const compound = `${action} ${locName}`.trim();
        pairs.set(compound, (pairs.get(compound) || 0) + 1);
      }
    }
    if (!n) return [];
    return [...pairs.entries()]
      .filter(([, df]) => df >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([term, df]) => ({ term, df }));
  } catch (e) { return []; }
});
// frasa yang lagi naik DI SOSIAL — beda dengan trendingQueries (dari judul berita).
// Guard export: social.js versi lama belum punya socPhraseScan/socKeywordMine.
const socialPhrases = () => memo('socphrase', 600000, async () => {
  if (typeof SOC.socPhraseScan !== 'function') return [];
  try {
    const posts = await richPosts();
    const exclude = new Set(SOC.SOC_TOPICS.map(t => t.id).concat(ADHOC.map(a => a.id)));
    return (await SOC.socPhraseScan(posts, { now: Date.now(), windowMs: 6 * 3600e3, minUsers: 2, exclude, max: 6 })) || [];
  } catch (e) { return []; }
});
// saran keyword baru untuk topik yang lagi panas — jadi query tambahan
// ('kw:<topik>'), bukan menggantikan query registry.
const socKw = () => memo('sockw', 300000, async () => {
  if (typeof SOC.socKeywordMine !== 'function') return [];
  try {
    const posts = await richPosts(), out = [];
    for (const t of socMeta().trending.slice(0, 2)) {
      const r = await SOC.socKeywordMine(posts, t, { now: Date.now(), maxTerms: 4 }) || [];
      const terms = r.map(x => (x && x.term) || x).filter(x => typeof x === 'string' && x.trim()).slice(0, 4);
      if (terms.length) out.push({ t: 'kw:' + t, terms });
    }
    return out;
  } catch (e) { return []; }
});
// baca hasil memo async secara sync — socMeta() dipanggil di banyak tempat tanpa
// await; nilai terakhir yang sukses tetap ter-serve walau TTL-nya sudah lewat.
const memoVal = k => { const c = cache.get(k); return c && c.v !== undefined ? c.v : []; };
// Skala skor gabungan (cukup buat sorting desc, bukan probabilitas):
//   social = socHot score (users/(1+baseRate), ~0-30+)
//   news    = 3  (top-2 topik spike berita 3 jam)
//   adhoc   = 1.5 (topik dinamis ADHOC)
//   x       = 1..0.6 sesuai urutan GetTrends (5 tren)
// social biasanya menang; sumber lain jadi sinyal awal & tie-breaker.
function buildTrends(hot, stats) {
  const m = new Map();
  const volOf = id => (stats && stats[id] ? (stats[id].x || 0) + (stats[id].th || 0) : 0);
  const add = (id, src, score) => {
    id = String(id || '').toLowerCase().trim();
    if (!id || !(score > 0)) return;
    if (id === 'olahraga' || TBLK.has(id) || SKIP_RE.test(id) || SOC.SOC_FOREIGN_RE.test(id)) return;
    // Never emit 0 0 zero-post topics in social trending
    if (volOf(id) <= 0) return;
    const e = m.get(id) || { id, src: [], scores: Object.create(null), score: 0 };
    if (e.src.indexOf(src) < 0) e.src.push(src);
    e.scores[src] = Math.max(e.scores[src] || 0, score);
    const vals = Object.values(e.scores);
    const best = Math.max(...vals);
    const hasNews = !!e.scores.news;
    const hasSocial = !!e.scores.social;
    // Multi-source corroboration applied once (never cumulative per call): +4.5 for 24h news+social, +3.0 otherwise
    e.score = +(best + (hasNews && hasSocial ? 4.5 : (e.src.length > 1 ? 3.0 : 0))).toFixed(2);
    m.set(id, e);
  };
  for (const it of memoVal('newsheat')) {
    const tid = typeof it === 'string' ? it : (it && it.id);
    const sc = typeof it === 'object' && it.score ? Math.min(25, it.score * 0.25 + 6) : 3;
    if (tid) add(tid, 'news', sc);
  }
  for (const h of hot || []) add(h.id, 'social', Math.min(30, +h.score || 0));
  if (stats) {
    for (const [tid, cnts] of Object.entries(stats)) {
      const vol = (cnts.x || 0) + (cnts.th || 0);
      if (vol >= 5) add(tid, 'social', Math.min(10, Math.log2(vol + 1) * 1.25));
    }
  }
  (memoVal('xtrend') || []).forEach((n, i) => add(n, 'x', Math.max(0.5, 1 - i * 0.1)));
  for (const a of ADHOC) add(a.id, 'adhoc', 1.5);
  const list = [...m.values()].sort((a, b) => b.score - a.score || volOf(b.id) - volOf(a.id)).slice(0, 10);
  return list.map(({ scores: _s, ...item }, idx) => {
    const rank = idx + 1;
    const pct = Math.min(450, Math.round(item.score * 20 + 50));
    return { ...item, rank, pct: '+' + pct + '%' };
  });
}
// chip + trending + statistik lintas platform, terpadu antara berita 24 jam dan sinyal sosial (zero-post topics excluded)
const socMeta = () => {
  const { stats, hot } = SOC.socHot(socPosts());
  const trends = buildTrends(hot, stats);
  const trendIds = trends.map(t => t.id);
  const volOf = q => ((stats[q] && stats[q].x) || 0) + ((stats[q] && stats[q].th) || 0);
  const activeQueries = Object.keys(stats)
    .filter(q => volOf(q) > 0)
    .sort((a, b) => volOf(b) - volOf(a));
  const queries = [...new Set([...trendIds, ...activeQueries])];
  return {
    queries,
    trending: trendIds,
    both: hot.filter(h => h.both).map(h => h.id),
    hot,
    stats,
    trends,
    newsTrending: memoVal('newsheat')
  };
};
// sintesis query dinamis per siklus: varian adhoc + tren X + frasa sosial +
// keyword mining + keyword dari berita. Hasilnya masuk byTopic sebagai topik
// sintetis ('adhoc2:'/'xtrend:'/'socphrase:'/'kw:'/'newskw:') yang di-forced —
// tetap makan budget N, tidak ada jalur bypass. Jatah per kategori per
// platform per siklus: adhoc+xtrend maks 4 (shared), frasa sosial maks 3,
// keyword maks 2, keyword berita maks 3.
function synthQueries(kind, adhoc, trends, base, phrases, kw, newsKw) {
  const out = [], seen = new Set();
  const mk = cap => { let n = 0; return (t, q) => {
    if (!q || n >= cap || seen.has(t + '|' + q) || (base && base.has(q))) return;
    seen.add(t + '|' + q); n++; out.push({ t, q });
  }; };
  const add = mk(4), addP = mk(3), addK = mk(2), addN = mk(3);
  // varian adhoc: x tanpa kutip (longgar, catch lebih banyak), th hashtag —
  // hanya frasa satu kata; '#dua kata' dirapatkan jadi tag yang tak pernah ada
  for (const a of adhoc || []) {
    const id = String(a.id);
    if (kind === 'x') add('adhoc2:' + id, id + ' -dijual -kpr -rumah -sewa -filter:replies');
    else if (!/\s/.test(id)) add('adhoc2:' + id, '#' + id);
  }
  // tren X: nama tren jadi query exact-phrase ala adhoc ('"' distrip biar query nggak patah)
  for (const n of trends || []) {
    const nm = String(n).replace(/"/g, '');
    add('xtrend:' + nm.toLowerCase(), '"' + nm + '" -dijual -kpr -rumah -sewa -filter:replies');
  }
  // frasa sosial native: x exact-phrase, th teks polos (+hashtag untuk kata
  // tunggal — beda dengan varian adhoc yang cuma hashtag)
  for (const p of phrases || []) {
    const ph = String((p && (p.ph || p.id)) || '').replace(/"/g, '').trim().toLowerCase();
    if (ph.length < 3 || ph.length > 42) continue;
    const id = 'socphrase:' + ph.replace(/\s+/g, '-');
    if (kind === 'x') addP(id, '"' + ph + '" -dijual -kpr -rumah -sewa -filter:replies');
    else { addP(id, ph); if (!/\s/.test(ph)) addP(id, '#' + ph); }
  }
  // keyword mining: term = query polos untuk th; x ikut gaya registry —
  // kutip exact-phrase kalau multi-kata, selalu -filter:replies
  for (const k of kw || []) for (const term of (k.terms || []).slice(0, 4)) {
    const tm = String(term || '').replace(/"/g, '').trim();
    if (tm.length < 3 || tm.length > 42) continue;
    addK(k.t, kind === 'x' ? (/\s/.test(tm) ? '"' + tm + '" -dijual -kpr -rumah -sewa -filter:replies' : tm + ' -dijual -kpr -rumah -sewa -filter:replies') : tm);
  }
  // keyword berita 24 jam: compound anchor [Action] + [Entity/Location]
  (newsKw || []).forEach((k, i) => {
    const tm = String((k && k.term) || '').replace(/"/g, '').trim().toLowerCase();
    if (tm.length < 4) return;
    const id = 'newskw:' + i;
    if (kind === 'x') {
      const qText = tm.includes(' ') ? `"${tm}"` : tm;
      addN(id, `${qText} -dijual -kpr -rumah -sewa -properti -cluster -filter:replies`);
    } else {
      addN(id, tm);
      if (!tm.includes(' ') && tm.length >= 5) addN(id, '#' + tm);
    }
  });
  return out;
}
// catat yield per topik: fetches naik untuk tiap topik riil yang benar-benar
// ke-fetch siklus ini (id sintetis 'x:y' diskip), lalu newPosts untuk post BARU —
// key belum ada di history sebelum merge dan belum pernah dihitung di batch ini —
// tapi hanya untuk topik yang irisan dengan fetchedT. Post dari profil / topik
// sekunder yang tidak ikut fetch tidak boleh menggelembungkan yield.
function yieldNote(map, batch, preKeys, fetchedT) {
  const real = new Set();
  for (const t of fetchedT) if (!String(t).includes(':')) real.add(t);
  const stat = t => {
    let s = map.get(t);
    if (!s) { s = { fetches: 0, newPosts: 0 }; map.set(t, s); }
    return s;
  };
  for (const t of real) {
    const s = stat(t); s.fetches++;
    if (s.fetches > 20) { s.fetches >>= 1; s.newPosts >>= 1; }   // decay: riwayat lama nggak mendominasi
  }
  const seen = new Set();
  for (const p of batch) {
    const k = histKey(p);
    if (!k || preKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    for (const t of (p.topics || [])) {
      if (!real.has(t)) continue;
      stat(t).newPosts++;
    }
  }
}
// faktor yield untuk pri(): rerata post-baru per fetch diskalakan (cap 4 → maks 2x),
// topik >=3 fetch tanpa satu post baru didiskon 0.4x — panas masih bisa hidup lagi.
function yieldAdj(map, t) {
  const s = map.get(t);
  if (!s || !s.fetches) return 1;
  let f = 1 + Math.min(s.newPosts / s.fetches, 4) / 4;
  if (s.fetches >= 3 && s.newPosts === 0) f *= 0.4;
  return f;
}
const xSeen = new Map(), xYield = new Map();   // topik -> ts fetch terakhir & statistik yield
let xTick = 0;
const xposts = () => memo('x', 300000, async () => {
  await adhocRefresh();
  const meta0 = socMeta();
  if (!xHas()) return { ok: false, err: 'auth_token / ct0 belum diisi di config.json', posts: [], ...meta0 };
  if (xCooling()) {   // semua akun cooldown — sajikan history basi, jangan bakar request sia-sia
    const posts = [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
    return { ok: false, err: 'X rate-limit — reset ~' + XPOOL.formatWibTime(xPool.earliestReset()) + ' WIB', posts, ...socMeta(), at: Date.now(), cooldown: true };
  }
  // rotasi sadar-panas: topik yang lama nggak disapu & lagi ramai didahulukan; ad-hoc + 2 terpanas selalu masuk
  const all = SOC.socQueries('x', ADHOC), first = xTick === 0, now = Date.now();
  xTick++;
  const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
  const heat = t => { const s = stats[t]; return s ? (s.x || 0) + (s.th || 0) : 0; };
  // query sintetis (varian adhoc + tren X + frasa sosial + keyword mining)
  // antri di budget N yang sama lewat topik 'adhoc2:'/'xtrend:'/'socphrase:'/'kw:'/'newskw:'
  const synth = synthQueries('x', ADHOC, await xTrends(), new Set(all.map(e => e.q)),
    await socialPhrases(), await socKw(), await newsKeywords());
  all.push(...synth);
  const byTopic = new Map();
  for (const e of all) { const a = byTopic.get(e.t); if (a) a.push(e); else byTopic.set(e.t, [e]); }
  // newsHotTop: topik yang lagi spike di berita ikut antri di forced — prioritas,
  // bukan bypass; query-nya tetap makan budget N seperti topik lain.
  const newsHotTop = await newsTopicHeat();
  const newsHotIds = (newsHotTop || []).map(x => typeof x === 'string' ? x : (x && x.id)).filter(Boolean);
  // forcedOrd = prioritas berurutan: topik riil panas dulu (hot sosial, spike
  // berita, adhoc), baru id sintetis. Semua tunduk budget N — yang kelebihan
  // antri siklus depan, jadi total fetch per siklus tidak pernah lewat N.
  const synthSet = new Set(synth.map(e => e.t));
  const forcedOrd = hotTop.concat(newsHotIds, ADHOC.map(a => a.id), synth.map(e => e.t));
  const forced = new Set(forcedOrd);
  const chosen = new Set();
  if (first) { for (const t of byTopic.keys()) chosen.add(t); }
  else {
    const N = 14, SYNTH_MAX = 4, pri = t => ((now - (xSeen.get(t) || 0)) / 60000) * (1 + Math.min(heat(t), 60) / 15) * yieldAdj(xYield, t);
    const rest = [...byTopic.keys()].filter(t => !forced.has(t)).sort((a, b) => pri(b) - pri(a));
    let used = 0, synthUsed = 0;
    // forcedOrd bisa berisi id topik tanpa query (trending basi / ad-hoc yang
    // sudah keluar registry) — byTopic.get(t) undefined di situ, jangan TypeError.
    // id dobel (hotTop ≈ adhoc ≈ synth) ke-skip oleh chosen.has.
    // Query sintetis dibatasi SYNTH_MAX agar topik inti di rest tidak pernah kelaparan.
    for (const t of forcedOrd) {
      if (chosen.has(t) || !byTopic.has(t)) continue;
      const n = byTopic.get(t).length;
      if (synthSet.has(t) && synthUsed + n > SYNTH_MAX) continue;
      if (used + n > N) continue;
      chosen.add(t); used += n;
      if (synthSet.has(t)) synthUsed += n;
    }
    for (const t of rest) { const n = (byTopic.get(t) || []).length; if (used + n > N) continue; chosen.add(t); used += n; }
  }
  const sel = new Map();
  // tick pertama: satu query per topik saja — sweep semua query sekaligus = burst 429.
  if (first) { for (const t of chosen) { const l = byTopic.get(t) || []; if (l[0]) sel.set(l[0].q, l[0]); } }
  else for (const t of chosen) for (const e of byTopic.get(t) || []) sel.set(e.q, e);
  for (const t of chosen) xSeen.set(t, now);
  // query -> [topik]: string query bisa dimiliki >1 topik — satu fetch sukses
  // memberi kredit ke semua pemiliknya (id sintetis 'x:y' diskip di yieldNote)
  const qT = new Map();
  for (const t of chosen) for (const e of byTopic.get(t) || []) { const a = qT.get(e.q); if (a) a.push(e.t); else qT.set(e.q, [e.t]); }
  const queries = [...sel.values()], errs = [], batch = [], failedT = new Set(), okQ = new Set();
  let page2 = [];
  let rawN = 0, dropTs = 0, dropTag = 0, dropSample = null, newest = 0;
  const ingest = (e, list) => {
    const disc = String(e.t || '').startsWith('adhoc') || String(e.t || '').includes(':') ? 'adhoc' : 'permanent';
    SOC.diagnostics.recordRetrieved('x', disc, (list || []).length);
    for (const p of list) {
      rawN++; if (p.ts > newest) newest = p.ts;
      if (!p.ts || now - p.ts > 48 * 3600e3) { dropTs++; if (!dropSample) dropSample = { ts: p.ts, ca: p.created_at, txt: String(p.text || '').slice(0, 60) }; continue; }
      if (!tagX(p, undefined, { discoverySource: disc })) { dropTag++; continue; }
      p.q = e.t; p.qs = p.topics.slice();
      batch.push(p);
    }
  };
  for (let i = 0; i < queries.length; i += 5) {
    if (xCooling()) break;   // 429 di tengah sweep → stop, sisa query menunggu reset berikutnya
    const chunk = queries.slice(i, i + 5);
    const rs = await Promise.allSettled(chunk.map(e => xSearch(e.q)));
    rs.forEach((r, j) => {
      const e = chunk[j];
      if (r.status === 'rejected') { errs.push(e.t + ': ' + String(r.reason && r.reason.message || r.reason)); if (r.reason && r.reason.status === 429) failedT.add(e.t); return; }
      okQ.add(e.q);   // query sukses → semua topik pemiliknya dihitung ter-fetch
      ingest(e, r.value.posts);
      if (r.value.cursor && r.value.posts.length >= 15) page2.push({ e, cursor: r.value.cursor, n: r.value.posts.length });
    });
    if (i + 5 < queries.length && !xCooling()) await sleep(350 + Math.random() * 350);   // jitter antar-chunk — burst beruntun = pemicu 429
  }
  // halaman 2 cuma untuk topik yang beneran ramai/hangat — tiap page = 1 request, maks 4 per siklus;
  // topik yang kena 429 di page-1 tidak usah buang request page-2
  page2 = page2.filter(x => !failedT.has(x.e.t));
  page2.sort((a, b) => (forced.has(b.e.t) ? 1 : 0) - (forced.has(a.e.t) ? 1 : 0) || b.n - a.n);
  for (let i = 0; i < Math.min(4, page2.length); i += 4) {
    const chunk = page2.slice(i, i + 4);
    const rs = await Promise.allSettled(chunk.map(x => xSearch(x.e.q, x.cursor)));
    rs.forEach((r, j) => {
      const x = chunk[j];
      if (r.status === 'rejected') { errs.push(x.e.t + '/p2: ' + String(r.reason && r.reason.message || r.reason)); return; }
      okQ.add(x.e.q);
      ingest(x.e, r.value.posts);
    });
  }
  const preKeys = new Set(xHist.keys());   // snapshot sebelum merge: bedakan post baru vs lama
  await maybeDisambiguateBorderline(batch);
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  const xFetched = new Set();   // query yang sukses -> semua topik pemiliknya
  for (const q of okQ) for (const t of qT.get(q) || []) xFetched.add(t);
  yieldNote(xYield, batch, preKeys, xFetched);
  const posts = [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
  let err = errs.join(' | ');
  if (!posts.length && !err) err = '0 post lolos filter: ' + rawN + ' tweet dari ' + queries.length + ' query (drop ts:' + dropTs + ' topik:' + dropTag + ', tweet terbaru=' + (newest ? new Date(newest).toISOString() : '-') + ', qid=' + (X.query_id ? 'env/config:' + X.query_id : 'auto') + ')' + (dropSample ? ' | contoh ts=' + dropSample.ts + ' created_at="' + dropSample.ca + '" "' + dropSample.txt + '"' : '');
  return { ok: errs.length < queries.length, err, posts, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
}, v => (v.posts || []).length > 0);
/* ---------- X lazy: satu topik on-demand (klik chip yang masih kosong) ---------- */
const xqLazy = q => memo('xq:' + String(q).toLowerCase(), 600000, async () => {
  if (!xHas()) throw new Error('auth_token / ct0 belum diisi');
  const tp = topicOf(q), extra = ADHOC;
  const qs = tp ? tp.x : ['"' + q + '" -filter:replies'];
  const rs = await Promise.allSettled(qs.map(x => xSearch(x)));
  const now = Date.now(), batch = [];
  for (const r of rs) if (r.status === 'fulfilled') {
    SOC.diagnostics.recordRetrieved('x', 'lazy', (r.value.posts || []).length);
    for (const p of r.value.posts) {
      if (!p.ts || now - p.ts > 48 * 3600e3 || !tagX(p, extra, { discoverySource: 'lazy' })) continue;
      p.q = String(q).toLowerCase(); p.qs = p.topics.slice(); batch.push(p);
    }
  }
  if (!batch.length && rs.every(r => r.status === 'rejected')) throw rs[0].reason;
  histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
  return [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
});

/* ---------- Threads: toolzerhub/threads-scraper (MIT) lewat worker Python ---------- */
const { execFile } = require('child_process');
const TH = CFG.threads || {};
// Auth opsional untuk worker Threads: cookie sesi dari env (JANGAN taruh di
// config.json — file itu ikut ter-commit). Isi lalu restart:
//   TH_SESSIONID, TH_CSRFTOKEN, TH_DS_USER_ID, TH_MID, TH_RUR
// Kosong = mode logged-out seperti sekarang (hybrid: search tetap jalan,
// profil & pagination dapat jatah lebih banyak saat session valid).
const TH_AUTH = (() => {
  const env = { sessionid: 'TH_SESSIONID', csrftoken: 'TH_CSRFTOKEN', ds_user_id: 'TH_DS_USER_ID', mid: 'TH_MID', rur: 'TH_RUR' };
  const ck = {};
  for (const [k, v] of Object.entries(env)) { const val = process.env[v]; if (val) ck[k] = val; }
  for (const [k, v] of Object.entries(TH.cookies || {})) if (v && !ck[k]) ck[k] = String(v);
  return ck.sessionid ? ck : null;
})();
const PY_BIN = [
  TH.python,
  path.join(__dirname, '.venv', 'bin', 'python'),
  path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
  'python3'
].filter(Boolean).find(p => p === 'python3' || fs.existsSync(p));
// spec bisa array query (kompat lama) atau {searches:[...], profiles:[...]}
const thSem = makeSem(3);   // maks 3 worker Threads paralel — lazy thq antre di slot yang sama
function execFileBounded(bin, args, opts, cb) {
  const child = execFile(bin, args, opts, (err, stdout, stderr) => {
    clearTimeout(killT);
    cb(err, stdout, stderr);
  });
  let killT = null;
  if (opts && opts.timeout > 0) {
    killT = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref();
    }, opts.timeout + 200);
    if (killT.unref) killT.unref();
  }
  return child;
}
const runThRaw = (spec, timeout) => new Promise((resolve, reject) => {
  execFileBounded(PY_BIN, [path.join(__dirname, 'vendor', 'threads_worker.py'), JSON.stringify(spec)],
    { timeout, maxBuffer: 12 << 20 },
    (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).replace(/\s+/g, ' ').slice(0, 240)));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('worker bukan JSON valid')); }
    });
});
const runTh = (spec, timeout, prio) => thSem(() => runThRaw(spec, timeout), prio);
function thCollect(rs, extra, discoverySourceOverride) {
  const now = Date.now(), batch = [], errs = [];
  let nOld = 0, nTag = 0;
  for (const r of rs) {
    if (r.status === 'rejected') { errs.push({ q: '*', err: String(r.reason && r.reason.message || r.reason) }); continue; }
    for (const e of r.value.errs || []) errs.push(e);
    const list = r.value.posts || [];
    for (const p of list) {
      if (!p || !p.code || !p.text) continue;
      const disc = discoverySourceOverride || (String(p.q || '').startsWith('@') ? 'profile' : 'permanent');
      SOC.diagnostics.recordRetrieved('threads', disc, 1);
      if (p.created_at && now - Date.parse(p.created_at) > 72 * 3600e3) { nOld++; continue; }
      if (!tagTh(p, extra, { discoverySource: disc })) { nTag++; continue; }
      p.qs = p.topics.slice();
      batch.push(p);
    }
  }
  return { batch, errs, dropped: { old: nOld, tag: nTag } };
}
// Watchlist profil Threads: akun dari config (threads.watch) + seed media/OSINT
// Indonesia + penulis yang post-nya sudah lolos klasifier di history — dinamis,
// bukan tebakan handle. Profile posts dipakai karena search logged-out cuma
// dapat ~20 hasil tanpa halaman 2.
const DEFAULT_TH_WATCH = ['infobmkg'];
const TH_MEDIA_BLACKLIST = new Set([
  'hariankompas', 'tribunnews', 'liputan6', 'tempodotco', 'suarasurabayamedia',
  'indonesiaraya_kita.id', 'detikcom', 'kompascom', 'cnnindonesia', 'cnbcindonesia',
  'kumparancom', 'republikaonline', 'merdekadotcom', 'sindonews', 'okezonecom',
  'jawapos', 'inewsdotid', 'antaranews', 'tvonenews', 'metrotv'
]);
const TH_WATCH = ((Array.isArray(TH.watch) && TH.watch.length) ? TH.watch : DEFAULT_TH_WATCH)
  .map(s => String(s).replace(/^@/, '').trim())
  .filter(u => u && !TH_MEDIA_BLACKLIST.has(u));
const thBadProfiles = new Map(); // handle -> retryAfterMs for missing/private Threads profiles
const dynWatch = (now) => {
  const uc = Object.create(null);
  const nonAnon = new Set();
  for (const p of tHist.values()) {
    if (String(p.q || '').startsWith('@')) continue; // Must be discovered via topic query search
    if (!p.assessment || p.assessment.signalEligible !== true) continue; // Verified crisis signal only
    const u = String(p.username || '').toLowerCase().replace(/^@/, '');
    if (!u || TH_MEDIA_BLACKLIST.has(u) || TH_WATCH.includes(u) || (thBadProfiles.get(u) || 0) > now) continue;
    if (histTs(p) > now - 24 * 3600e3) {
      uc[u] = (uc[u] || 0) + 1;
      if (p.assessment.provenance && p.assessment.provenance.sourceType !== 'anonymous') nonAnon.add(u);
    }
  }
  return Object.entries(uc)
    .filter(([u, c]) => c >= 2 || nonAnon.has(u))
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u]) => u);
};
const thSeen = new Map(), thYield = new Map(), thTopicOff = new Map();   // topik -> ts fetch terakhir, yield, & offset rotasi query
let thTick = 0;
const threads = () => memo('threads', 240000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan. Jalankan: python3 -m venv .venv && .venv/bin/pip install curl_cffi');
  await adhocRefresh();
  const meta0 = socMeta(), now = Date.now();
  thTick++;
  // Dulu semua ~29 query tiap 4 menit = ~430 request/jam logged-out → kena 429 terus.
  // Sekarang rotasi sadar-panas + window query per topik (maks 3 query/topik/siklus)
  // supaya topik besar (kesehatan 22 query, konflik 19, siber 17) tidak memonopoli
  // atau permanen ter-skip karena melebihi sisa budget N=24.
  const entries = SOC.socQueries('th', ADHOC);
  const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
  const heat = t => { const s = stats[t]; return s ? (s.th || 0) + (s.x || 0) : 0; };
  // sama seperti X: query sintetis (varian adhoc + frasa sosial + keyword
  // mining + keyword berita) antri di budget N lewat topik
  // 'adhoc2:'/'socphrase:'/'kw:'/'newskw:'
  const synth = synthQueries('th', ADHOC, null, new Set(entries.map(e => e.q)),
    await socialPhrases(), await socKw(), await newsKeywords());
  for (const e of synth) entries.push(e);
  const byTopic = new Map();
  for (const e of entries) { const a = byTopic.get(e.t); if (a) a.push(e.q); else byTopic.set(e.t, [e.q]); }
  // newsHotTop: topik spike berita — prioritas di forced, tetap makan budget N
  const newsHotTop = await newsTopicHeat();
  const newsHotIds = (newsHotTop || []).map(x => typeof x === 'string' ? x : (x && x.id)).filter(Boolean);
  const synthSet = new Set(synth.map(e => e.t));
  // sama seperti X: forcedOrd berurutan prioritas (topik riil dulu, sintetis
  // belakangan) dan semua tunduk budget N — tidak ada bypass, total ≤ N.
  const forcedOrd = hotTop.concat(newsHotIds, ADHOC.map(a => a.id), synth.map(e => e.t));
  const forced = new Set(forcedOrd);
  const chosen = new Set(), chosenQueries = new Map();
  // throttle sejak siklus pertama: burst ~30 request langsung memicu 429 Threads
  const N = 24, SYNTH_MAX = 5, TOPIC_Q_CAP = 3;
  const pri = t => {
    const starved = ((stats[t]?.th || 0) === 0 && (stats[t]?.x || 0) > 0) ? 3.5 : 1;
    return ((now - (thSeen.get(t) || 0)) / 60000) * (1 + Math.min(heat(t), 60) / 15) * yieldAdj(thYield, t) * starved;
  };
  const rest = [...byTopic.keys()].filter(t => !forced.has(t)).sort((a, b) => pri(b) - pri(a));
  const sliceTopic = (t, maxQ) => {
    const allQ = byTopic.get(t) || [];
    if (!allQ.length || maxQ <= 0) return [];
    if (allQ.length <= maxQ) return allQ.slice();
    const off = thTopicOff.get(t) || 0;
    const out = Array.from({ length: maxQ }, (_, i) => allQ[(off + i) % allQ.length]);
    thTopicOff.set(t, (off + maxQ) % allQ.length);
    return out;
  };
  let used = 0, synthUsed = 0;
  // Pass 1 (fairness): reserve at least REST_MIN slots so starved topics (phk/ihsg/siber/wabah/dll)
  // always get sampled alongside forced 24h news + social hot topics.
  const restReserve = Math.min(8, rest.length);
  const forcedPass1Cap = Math.max(4, N - restReserve);
  const takeTopic = (t, count) => {
    if (count <= 0 || used >= N) return 0;
    const prev = chosenQueries.get(t) || [];
    const need = Math.min(count, TOPIC_Q_CAP - prev.length, N - used);
    if (need <= 0) return 0;
    const allQ = byTopic.get(t) || [];
    const qs = prev.length ? allQ.filter(q => !prev.includes(q)).slice(0, need) : sliceTopic(t, need);
    if (!qs.length) return 0;
    chosen.add(t);
    chosenQueries.set(t, prev.concat(qs));
    used += qs.length;
    return qs.length;
  };
  for (const t of forcedOrd) {
    if (chosen.has(t) || !byTopic.has(t) || used >= forcedPass1Cap) continue;
    const isSynth = synthSet.has(t);
    if (isSynth && synthUsed >= SYNTH_MAX) continue;
    const got = takeTopic(t, 1);
    if (got && isSynth) synthUsed += got;
  }
  for (const t of rest) {
    if (used >= N) break;
    takeTopic(t, 1);
  }
  // Pass 2: deepen high-priority active/hot topics up to TOPIC_Q_CAP if slots remain
  for (const t of forcedOrd) {
    if (used >= N || !byTopic.has(t)) continue;
    const isSynth = synthSet.has(t);
    if (isSynth && synthUsed >= SYNTH_MAX) continue;
    const extraCap = isSynth ? Math.max(0, Math.min(2, SYNTH_MAX - synthUsed)) : (TOPIC_Q_CAP - 1);
    const got = takeTopic(t, extraCap);
    if (got && isSynth) synthUsed += got;
  }
  for (const t of rest) {
    if (used >= N) break;
    takeTopic(t, TOPIC_Q_CAP - 1);
  }
  for (const t of chosen) thSeen.set(t, now);
  const searches = [...new Set([...chosen].flatMap(t => chosenQueries.get(t) || []))];
  // query -> [topik]: string query bisa dipakai >1 topik (mis. 'pemilu' di
  // pemilu & politik) — searches di-dedupe jadi satu fetch, semua topik dapat kredit
  const qT = new Map();
  for (const t of chosen) for (const q of chosenQueries.get(t) || []) { const a = qT.get(q); if (a) a.push(t); else qT.set(q, [t]); }
  const watch = [...new Set(TH_WATCH.concat(dynWatch(now)))]
    .filter(u => !((thBadProfiles.get(String(u).toLowerCase()) || 0) > now));
  // profil watchlist: rotasi window per siklus, bukan semua tiap saat —
  // dynWatch self-reinforcing bikin akun yang sama selalu paling fresh &
  // mendominasi feed; window geser pN tiap tick supaya semua akun tercover bergantian
  const pN = Math.min(8, watch.length), wOff = watch.length ? ((thTick - 1) * pN) % watch.length : 0;
  const profiles = watch.length <= pN ? watch.slice() :
    Array.from({ length: pN }, (_, i) => watch[(wOff + i) % watch.length]);
  const chunks = [{ s: [], p: [] }, { s: [], p: [] }, { s: [], p: [] }];
  searches.forEach((q, i) => chunks[i % 3].s.push(q));
  profiles.forEach((u, i) => chunks[i % 3].p.push(u));
  const runChunks = chunks.filter(c => c.s.length || c.p.length);
  const rs = await Promise.allSettled(runChunks.map(c => runTh({ searches: c.s, profiles: c.p, auth: TH_AUTH }, 150000)));
  if (rs.every(r => r.status === 'rejected')) throw rs[0].reason;
  const { batch, errs: rawErrs, dropped } = thCollect(rs);
  const errs = [];
  for (const e of rawErrs) {
    const q = String((e && e.q) || '');
    const msg = String((e && e.err) || '');
    if (q.startsWith('@') && /not found|private or have no posts|no posts on the page/i.test(msg)) {
      const handle = q.slice(1).toLowerCase();
      thBadProfiles.set(handle, now + 12 * 3600e3);
      if (!TH_WATCH.includes(handle)) continue; // Demote broken dynamic profile silently instead of spamming errors
    }
    errs.push(e);
  }
  // yield: topik dihitung ter-fetch hanya kalau >=1 query-nya ada di chunk yang
  // fulfilled dan tidak tercatat errs — chunk/query gagal tidak dapat kredit fetch
  const failedQ = new Set(), thFetched = new Set();
  rs.forEach((r, i) => {
    if (r.status === 'rejected') { for (const q of runChunks[i].s) failedQ.add(q); return; }
    const es = r.value.errs || [];
    // errs {"q":"*"} = fatal worker: seluruh chunk (search + profil) anggap gagal
    if (es.some(e => e && e.q === '*')) {
      for (const q of runChunks[i].s) failedQ.add(q);
      for (const u of runChunks[i].p) failedQ.add('@' + u);
    }
    for (const e of es) if (e && e.q) failedQ.add(e.q);
  });
  rs.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const q of runChunks[i].s) if (!failedQ.has(q)) for (const t of qT.get(q) || []) thFetched.add(t);
  });
  const preKeys = new Set(tHist.keys());   // snapshot sebelum merge: bedakan post baru vs lama
  await maybeDisambiguateBorderline(batch);
  histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
  yieldNote(thYield, batch, preKeys, thFetched);
  const posts = [...tHist.values()].sort((a, b) => histTs(b) - histTs(a));
  const newestTs = posts.length ? histTs(posts[0]) : 0;
  return { ok: rs.some(r => r.status === 'fulfilled' && (r.value.posts?.length > 0 || !r.value.errs?.length)), posts, errs, ingested: batch.length, newestTs, dropped, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
}, v => (v.posts || []).length > 0);
/* ---------- Threads lazy: topik on-demand (sebelumnya nggak ada, makanya chip kosong) ---------- */
const thqLazy = q => memo('thq:' + String(q).toLowerCase(), 600000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan');
  const tp = topicOf(q), extra = ADHOC;
  const spec0 = tp ? tp.th : [String(q)];
  const spec = (spec0 && typeof spec0 === 'object' && !Array.isArray(spec0))
    ? { ...spec0, auth: TH_AUTH } : { searches: spec0, auth: TH_AUTH };
  const r = await Promise.allSettled([runTh(spec, 90000, true)]);
  if (r[0].status === 'rejected') throw r[0].reason;
  const { batch } = thCollect(r, extra, 'lazy');
  histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
  return [...tHist.values()].sort((a, b) => histTs(b) - histTs(a));
});

let socialSnapshotAt = 0;
// histRetag = socAssess per post (~2300) + sort snapshot + socMeta — dulu
// dihitung ULANG tiap request /api/x|threads (~0.5s flat walau memo hit).
// Hasil hanya berubah saat history berubah → cache per fingerprint
// (size + ts terbaru + ADHOC + bucket jam untuk aging). Max-ts scan O(n)
// tetap jauh lebih murah daripada assess regex per post.
const socialRespCache = new Map();   // map -> {fp, posts}
let socialMetaFp = '', socialMetaVal = null;
function socialResponse(result, map, keep) {
  const now = Date.now();
  let mx = 0;
  for (const p of map.values()) { const t = HISTORY.tsOf(p); if (t > mx) mx = t; }
  const fp = SOC.CLASSIFIER_VERSION + '|' + map.size + '|' + mx + '|' + adhocSig() + '|' + Math.floor(now / 3600e3);
  let c = socialRespCache.get(map);
  if (!c || c.fp !== fp) {
    histRetag(map, keep);
    // Universal author diversity cap: tidak ada satu akun yang bisa mendominasi feed,
    // baik dari search query maupun profil (X & Threads), kecuali kanal otoritas (@infobmkg).
    const authorHourly = Object.create(null);
    const authorTotal = Object.create(null);
    c = { fp, posts: HISTORY.snapshot(map, now).posts.filter(p => {
      const u = String(p.handle || p.username || p.user || '').toLowerCase().replace(/^@/, '');
      if (!u) return true;
      if (u === 'infobmkg' || u === 'bnpb_indonesia') return true;
      const isSig = !!(p.assessment && p.assessment.signalEligible);
      const ts = histTs(p) || now;
      const hourBucket = Math.floor(ts / 3600e3);
      const hKey = `${u}|${hourBucket}`;
      const maxPerHour = isSig ? 3 : 2;
      const maxTotal = isSig ? 6 : 4;
      const currentH = authorHourly[hKey] || 0;
      const currentTot = authorTotal[u] || 0;
      if (currentH >= maxPerHour || currentTot >= maxTotal) return false;
      authorHourly[hKey] = currentH + 1;
      authorTotal[u] = currentTot + 1;
      return true;
    }).map(p => (p && p.assessment) ? { ...p, assessment: projectAssessment(p.assessment) } : p) };
    socialRespCache.set(map, c);
  }
  // bucket 10 menit (bukan cuma jam): field trends/hot dari socMeta berubah
  // mengikuti memo 5-10 mnt — socMeta sendiri murah, memo di bawahnya yang berat.
  const mfp = xHist.size + '|' + tHist.size + '|' + newsHeatRev + '|' + NEWS_REV + '|' + adhocSig() + '|' + Math.floor(now / 120e3);
  if (socialMetaFp !== mfp) { socialMetaVal = socMeta(); socialMetaFp = mfp; }
  socialSnapshotAt = Math.max(now, socialSnapshotAt + 1);
  const diagSnap = SOC.diagnostics.snapshot();
  return { ...result, ok: true, snapshot: true, classifierVersion: SOC.CLASSIFIER_VERSION,
    snapshotAt: socialSnapshotAt, posts: c.posts, at: now, coverage: 'sampled',
    diagnostics: {
      retrieved: diagSnap.retrieved,
      classified: diagSnap.classified,
      incidentSignals: diagSnap.incidentSignals,
      contextualPosts: diagSnap.contextualPosts,
      rejected: diagSnap.rejected,
    },
    ...socialMetaVal, ok: result.ok === true, partial: !!result.partial };
}
// Memo dingin (habis restart / siklus gagal menghapus cache): xHist/tHist sudah
// load dari disk — sajikan snapshot seketika, jangan biarkan UI menunggu siklus
// koleksi penuh. Siklus tetap jalan background lewat memo kick.
const warmSocial = (k, run, map) => {
  const c = cache.get(k);
  if (c && c.v !== undefined) return run();
  if (!c || !c.p) run().catch(() => {});
  const posts = [...map.values()].sort((a, b) => histTs(b) - histTs(a));
  return Promise.resolve({ ok: posts.length > 0, err: '', warming: true, posts,
    newestTs: posts.length ? histTs(posts[0]) : 0, at: Date.now(), ingested: 0, errs: [], dropped: {} });
};

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
    text: FEEDTEXT.decodeEntities(j.text || ''),
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
  for (const p of xHist.values()) {
    if (p && (p.id === id || tweetId(p.url) === id)) {
      post = { ...p };
      break;
    }
  }
  if (!post) {
    try { post = await synTweet(id); } catch (e) { err = e.message; }
  } else {
    try {
      const syn = await synTweet(id);
      if (syn) post = { ...post, ...syn };
    } catch (_) {}
  }
  let flat = [], cursor = '', pages = 0;
  try {   // conversation_id: paginate sampai 3 halaman / 60 post, jendela 7 hari
    for (;;) {
      const r = await xSearch('conversation_id:' + id, cursor, 0);   // tanpa since_time: rawQuery stabil antar-halaman + balasan tua ikut
      flat.push(...r.posts); cursor = r.cursor; pages++;
      if (!cursor || pages >= 3 || flat.length >= 60) break;
    }
  } catch (e) {
    const msg = String(e && e.message || e);
    if (!/0 tweet|search_by_raw_query/i.test(msg)) {
      err = err || msg;
    }
  }
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
  const cleanErr = (err && !/0 tweet|search_by_raw_query/i.test(err)) ? err : '';
  const count = (post && typeof post.replies === 'number') ? post.replies : flat.length;
  return { ok: true, kind: 'x', post, replies, count, err: cleanErr };
});
const thThread = (url) => memo('thth:' + url, 300000, async () => {
  if (!PY_BIN) throw new Error('Python tidak ditemukan');
  const raw = await thSem(() => new Promise((resolve, reject) => {
    execFileBounded(PY_BIN, [path.join(__dirname, 'vendor', 'threads_thread.py'), JSON.stringify({ url, auth: TH_AUTH })],
      { timeout: 45000, maxBuffer: 12 << 20 },
      (e, out, err2) => {
        if (e) return reject(new Error(String(err2 || e.message).replace(/\s+/g, ' ').slice(0, 240)));
        try { resolve(JSON.parse(out)); } catch (e2) { reject(new Error('worker bukan JSON valid')); }
      });
  }), true);
  if (!raw.ok) throw new Error(raw.err || 'gagal membaca thread');
  const replies = Array.isArray(raw.replies) ? raw.replies : (Array.isArray(raw.post && raw.post.replies) ? raw.post.replies : []);
  const count = typeof raw.count === 'number' ? raw.count : (raw.post && typeof raw.post.reply_count === 'number' ? raw.post.reply_count : replies.length);
  return { ...raw, replies, count };
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
const plotOk = (title, cat) => {
  if (cat === 'demo') return !/\b(reses|apresiasi|penghargaan|webinar|seminar|rakor|kunjungan kerja|kunker|opini|analisis|kolom)\b/i.test(title);
  return !NOT_EVENT_RE.test(title) && (cat !== 'kesehatan' || HEALTH_EVENT_RE.test(title));
};
const GEO_WINDOW = 24 * 3600e3;
let lastIncidentPins = [];
const buildIncidentNodes = (now = Date.now()) => GEO.NODES.map(p => ({
  name: p.name, la: p.la, lo: p.lo, prov: p.prov, prec: 'kab', kind: 'node', label: 'Node',
  title: 'Node pemantauan · ' + p.name, src: 'NODE', url: '', ts: now, weight: 0.16, fixed: true
}));
const incidents = () => memo('incidents', 55000, async () => {
  const srcs = await news(), now = Date.now(), out = [], seen = new Set(), assessed = await assessedNewsFor(srcs);
  for (const s of srcs) {
    if (!s.ok) continue;
    const rows = assessed.get(s.id) || [];
    for (let idx = 0; idx < s.items.length; idx++) {
      const it = s.items[idx], ev = rows[idx];
      const a = ev.a;
      const cat = ev.cat;
      if (!cat) continue;
      // pin hanya untuk kejadian berscope Indonesia — catOf sudah membuang
      // finding 'foreign', tapi 'unknown' + tempat lemah (desa/poi) masih bisa
      // lolos (mis. "penembakan di Alun-alun Krakow Polandia" → desa Alun-Alun).
      const sc = a;
      if (sc.findings.length && sc.findings.every(f => f.scope !== 'Indonesia')) continue;
      // findings kosong (topik tanpa laporan): scope belum dievaluasi — cek
      // langsung supaya berita luar tetap tidak bisa pin lewat nama tempat
      // yang kebetulan cocok gazetteer Indonesia.
      if (!sc.findings.length && ev.fr) continue;
      // semua topik feed-only (olahraga/hukum/pendidikan/dst = kurasi feed,
      // BUKAN laporan insiden): nama kabupaten yang kebetulan disebut dalam
      // konteks non-insiden bukan lokasi kejadian → jangan di-pin.
      if (a.topics.length && a.topics.every(t => ASSESS.FEED_ONLY.has(t))) continue;
      // catatan scope: guard di atas hanya menolak saat SEMUA finding non-
      // Indonesia; judul mixed-scope (klausa Indonesia + klausa asing) tetap
      // bisa lolos karena placeOf memindai seluruh judul. Risiko residu ini
      // diterima — analisis per-klausa sengaja di luar scope perubahan ini.
      const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > GEO_WINDOW) continue;                       // jendela sama dengan /api/situation → angka sinkron
      const k = breakNorm(it.title).slice(0, 56);
      if (!k || seen.has(k)) continue;
      if (!plotOk(it.title, cat)) continue;
      const meta = catMeta(cat), dd = String(it.desc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // geo:false (siber/ekonomi/politik): judul memang tidak dipakai untuk pin,
      // tapi DESKRIPSI bisa menyebut wilayah — hanya presisi kab/prov/region
      // (desa/kelurahan/poi terlalu lemah untuk teks panjang) dan ditandai
      // approx + bobot separuh karena lokasi disimpulkan, bukan pernyataan.
      // Item GNEWS desc kosong → tidak akan pernah pin; keterbatasan diterima.
      let place = null, approx = false;
      if (meta.geo !== false) place = ev.pl;
      else if (dd) {
        const dp = GEO.locate(dd.slice(0, 2000));
        if (dp && /^(kab|prov|region)$/.test(dp.prec || '')) { place = dp; approx = true; }
      }
      if (!place) continue;
      seen.add(k);
      const recency = Math.max(0.16, Math.exp(-age / (20 * 3600e3)));
      const heat = meta.sev * recency;
      // judul dengan beberapa tempat sederajat ("banjir di Aceh dan Sumut") → satu titik per tempat, bobot dibagi
      const places = place.all && place.all.length > 1 ? place.all : [place];
      const pa = projectAssessment(a);
      for (const pl of places)
        out.push({ name: pl.name, la: pl.la, lo: pl.lo, prec: pl.prec, prov: pl.prov, kind: cat,
          label: meta.label, title: cleanTitle(it.title, it.pub), multi: places.length > 1 || undefined,
          desc: dd.length > 400 ? dd.slice(0, 397).replace(/\s+\S*$/, '') + '…' : (dd || undefined),
          assessment: pa, src: s.id, url: it.url, ts: it.ts, pub: it.pub || undefined,
          weight: +(heat / (approx ? 2 : 1) / Math.sqrt(places.length)).toFixed(3), approx: approx || undefined });
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  /* Event-level merge ada di evmerge.js (unit-tested): peristiwa sama
     (kategori + tempat + token langka / jendela hazard) → satu pin,
     eid stabil lintas refresh lewat rt, rep dipilih dari kualitas laporan. */
  const prevPins = ((((cache.get('incidents') || {}).v) || {}).items) || lastIncidentPins;
  const merged = EVM.mergeEvents(out, prevPins, { normPlace: s => GEO.norm(s) });
  merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const items = merged.slice(0, 800);
  lastIncidentPins = items.slice();
  const nodes = buildIncidentNodes(now);
  for (const nd of nodes) items.push(nd);
  // stale = insiden non-node terbaru lebih tua dari 3 jam — payload memo
  // last-good bisa berisi data beku; client pakai flag ini untuk indikator
  const newest = items.find(i => !i.fixed);
  const stale = !!newest && now - (newest.ts || 0) > 3 * 3600e3;
  return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, items, total: merged.length, raw: out.length, places: GEO.NODES.length, at: now, newest: newest ? newest.ts : 0, stale };
});

/* ---------- Situasi: agregat kategori + wilayah buat panel dossier ---------- */
const situation = () => memo('situation', 45000, async () => {
  const [srcs, inc] = await Promise.all([news(), incidents()]);
  const now = Date.now(), items = [], seen = new Set(), assessed = await assessedNewsFor(srcs);
  const stats = {}; for (const c of CATS) stats[c.id] = 0;
  const regions = new Map();
  let foreignN = 0;
  for (const s of srcs) {
    if (!s.ok) continue;
    const rows = assessed.get(s.id) || [];
    for (let idx = 0; idx < s.items.length; idx++) {
      const it = s.items[idx], ev = rows[idx];
      const a = ev.a;
      const cat = ev.cat;
      if (!cat) continue;
      const age = it.ts ? now - it.ts : 12 * 3600e3;
      if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > GEO_WINDOW) continue;
      const k = breakNorm(it.title).slice(0, 56);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const place = ev.pl;
      const recency = Math.max(0.12, Math.exp(-age / (24 * 3600e3)));
      const meta = catMeta(cat);
      // stats = situasi lokal/domestik: item terkonfirmasi foreign tetap masuk
      // daftar items (dengan flag) tapi tidak menghitung chip kategori.
      const fr = ev.fr;
      if (fr) foreignN++;
      items.push({ title: cleanTitle(it.title, it.pub), url: it.url, src: s.id, ts: it.ts, assessment: projectAssessment(a),
        cat, label: meta.label, place: place ? place.name : '', foreign: fr || undefined, pub: it.pub || undefined,
        weight: +(meta.sev * recency).toFixed(3) });
      if (!fr) stats[cat]++;
    }
  }
  // Sinkronkan jumlah insiden berlokasi (#sit-total) dan peringkat wilayah
  // dengan peristiwa ter-merge dari incidents() agar 01 Globe selalu konsisten.
  for (const p of (inc && inc.items) || []) {
    if (p && !p.fixed && !p.approx && p.name) {
      regions.set(p.name, (regions.get(p.name) || 0) + 1);
    }
  }
  const located = inc && typeof inc.total === 'number' ? inc.total : 0;
  items.sort((a, b) => b.weight - a.weight || (b.ts || 0) - (a.ts || 0));
  const regionRows = [...regions.entries()].map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n).slice(0, 20);
  return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, stats, total: items.length, located, items: items.slice(0, 60), regions: regionRows, foreign: foreignN,
    sources: srcs.map(s => ({ id: s.id, ok: s.ok, n: s.items.length, err: s.err || '', at: s.at || 0 })), at: now };
});

/* ---------- MARKET: tape realtime via TradingView scanner (tanpa key) ----------
   Quotes: scanner.tradingview.com — IDX stock, IHSG (IDX:COMPOSITE), forex, world indices.
   Sparkline closes: CNBC Harmony charts primary (tanpa key, tanpa rate-limit ketat),
   Binance klines (crypto), Yahoo Finance (fallback dengan backoff 429), & persistent disk cache. */
let mktFetch = get;
function setMarketFetch(fn) { mktFetch = typeof fn === 'function' ? fn : get; }

const STOCK_BLUE = new Set(['BBCA', 'TLKM', 'GOTO', 'BMRI', 'ASII', 'UNVR', 'KLBF']);
const FOREX_PAIRS = [['USDIDR', 'USD/IDR']];
const FX_NAME = Object.fromEntries(FOREX_PAIRS);
// komoditas: [sym TradingView, label, market scan, sym Yahoo, sym CNBC]
const COMMODITIES = [
  ['COMEX:GC1!', 'Gold', 'futures', 'GC=F', '@GC.1'],
  ['COMEX:SI1!', 'Silver', 'futures', 'SI=F', '@SI.1'],
  ['NYMEX:CL1!', 'WTI Oil', 'futures', 'CL=F', '@CL.1'],
  ['NYMEX:NG1!', 'Nat Gas', 'futures', 'NG=F', '@NG.1'],
  ['COMEX:HG1!', 'Copper', 'futures', 'HG=F', '@HG.1'],
  ['COMEX:ALI1!', 'Aluminum', 'futures', 'ALI=F', '@AL.1'],
  ['NYMEX:HO1!', 'Heat Oil', 'futures', 'HO=F', '@HO.1'],
  ['CBOT:ZR1!', 'Rice', 'futures', 'ZR=F', '@RR.1'],
  ['CBOT:ZW1!', 'Wheat', 'futures', 'ZW=F', '@W.1'],
  ['CBOT:ZC1!', 'Corn', 'futures', 'ZC=F', '@C.1'],
  ['CBOT:ZS1!', 'Soybean', 'futures', 'ZS=F', '@S.1'],
  ['CME:DC1!', 'Milk', 'futures', 'DC=F', '@DA.1'],
  ['ICEUS:KC1!', 'Coffee', 'futures', 'KC=F', '@KC.1'],
  ['ICEUS:SB1!', 'Sugar', 'futures', 'SB=F', '@SB.1'],
  ['ICEUS:CC1!', 'Cocoa', 'futures', 'CC=F', '@CC.1'],
  ['BINANCE:BTCUSDT', 'Bitcoin', 'crypto', 'BTC-USD', 'BTC.CM=']
];
const CMD_YH = Object.fromEntries(COMMODITIES.map(c => [c[0], c[3]]));
const CMD_CNBC = Object.fromEntries(COMMODITIES.map(c => [c[0], c[4]]));
const YH_FX = t => t === 'USDIDR' ? 'IDR=X' : t + '=X';   // USDIDR di Yahoo = IDR=X
async function tvScan(market, body) {
  const r = await mktFetch(`https://scanner.tradingview.com/${market}/scan`, {
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
const FXHIST_F = process.env.SITREP_DATA_DIR ? path.join(HIST_DIR, 'fxhist.json') : path.join(__dirname, 'fxhist.json');
let fxhist = [];
try { fxhist = JSON.parse(fs.readFileSync(FXHIST_F, 'utf8')); } catch (e) {}
const saveFx = () => { try { fs.writeFileSync(FXHIST_F, JSON.stringify(fxhist.slice(-400))); } catch (e) {} };
async function usdidr() {   // floatrates — fixing USD/IDR harian, lebih fresh dari Yahoo/TV yang stale
  try {
    const r = await mktFetch('https://www.floatrates.com/daily/usd.json', {}, 10000);
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
          const r = await mktFetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`, {}, 10000);
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
/* indeks global untuk ticker tape: [sym Yahoo/key, label, sym CNBC, sym TradingView] */
const WORLD_IDX = [
  ['^GSPC', 'S&P 500', '.SPX', 'SP:SPX'], ['^NDX', 'NASDAQ 100', '.NDX', 'NASDAQ:NDX'],
  ['^DJI', 'DOW', '.DJI', 'DJ:DJI'], ['^RUT', 'RUSSELL', '.RUT', 'TVC:RUT'],
  ['^N225', 'NIKKEI', '.N225', 'TVC:NI225'], ['^KS11', 'KOSPI', '.KS11', 'KRX:KOSPI'],
  ['^HSI', 'HANG SENG', '.HSI', 'HSI:HSI'], ['^TWII', 'TAIEX', '.TWII', 'TWSE:TAIEX'],
  ['^GDAXI', 'DAX', '.GDAXI', 'XETR:DAX'], ['^FTSE', 'FTSE 100', '.FTSE', 'FTSE:UKX'],
  ['^FCHI', 'CAC 40', '.FCHI', 'EURONEXT:PX1'], ['^SSMI', 'SMI', '.SSMI', 'SIX:SMI'],
  ['^AXJO', 'ASX 200', '.AXJO', 'ASX:XJO'], ['^BSESN', 'SENSEX', '.BSESN', 'BSE:SENSEX'],
  ['^NSEI', 'NIFTY', '.NSEI', 'NSE:NIFTY'], ['^STI', 'STI', '.STI', 'TVC:STI'],
  ['000001.SS', 'SSE', '.SSEC', 'SSE:000001'], ['^BVSP', 'IBOVESPA', '.BVSP', 'BMFBOVESPA:IBOV']
];
const WORLD_CNBC = Object.fromEntries(WORLD_IDX.map(w => [w[0], w[2]]));

function downsampleCloses(arr, maxPoints = 90) {
  const clean = (arr || []).map(Number).filter(v => Number.isFinite(v) && v > 0);
  if (clean.length <= maxPoints) return clean;
  const out = [];
  const step = (clean.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) out.push(clean[Math.round(i * step)]);
  out.push(clean[clean.length - 1]);
  return out;
}

function cnbcSymbolFor(k) {
  if (!k) return '';
  if (k === 'IDX:COMPOSITE' || k === '^JKSE') return '.JKSE';
  if (k.startsWith('IDX:')) return k.slice(4) + '-ID';
  if (k === 'FX_IDC:USDIDR' || k === 'IDR=X') return 'IDR=';
  if (CMD_CNBC[k]) return CMD_CNBC[k];
  if (WORLD_CNBC[k]) return WORLD_CNBC[k];
  return k;
}

const MKT_CLOSES_F = path.join(HIST_DIR, 'market-closes.json');
const closeMemo = new Map();
let mktClosesDirty = false;
let mktClosesSaveAt = 0;
try {
  const saved = JSON.parse(fs.readFileSync(MKT_CLOSES_F, 'utf8'));
  const nowLoad = Date.now();
  for (const [k, e] of Object.entries((saved && saved.items) || {})) {
    if (e && Array.isArray(e.closes) && e.closes.length >= 2 && Number.isFinite(e.at) && nowLoad - e.at < 24 * 3600e3) {
      closeMemo.set(k, { at: e.at, closes: e.closes });
    }
  }
} catch (e) {}

let mktClosesSaving = false;
function saveMktCloses(force = false) {
  const now = Date.now();
  if (!mktClosesDirty && !force) return;
  if (!force && (now - mktClosesSaveAt < 60000 || mktClosesSaving)) return;
  mktClosesSaveAt = now;
  mktClosesDirty = false;
  const items = {};
  for (const [k, v] of closeMemo) {
    if (v && Array.isArray(v.closes) && v.closes.length >= 2) {
      items[k] = { at: v.at, closes: v.closes.slice(-90) };
    }
  }
  const payload = JSON.stringify({ at: now, items });
  const tmp = MKT_CLOSES_F + '.' + process.pid + '.tmp';
  if (force) {
    try {
      fs.mkdirSync(HIST_DIR, { recursive: true });
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, MKT_CLOSES_F);
    } catch (e) {}
    return;
  }
  mktClosesSaving = true;
  fs.promises.mkdir(HIST_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, payload))
    .then(() => fs.promises.rename(tmp, MKT_CLOSES_F))
    .catch(() => {})
    .finally(() => { mktClosesSaving = false; });
}

let yahooBlockedUntil = 0;

async function cnbcCloses(cnbcSym, tf = '5D', maxPts = 90) {
  if (!cnbcSym) return [];
  try {
    const r = await mktFetch(
      `https://ts-api.cnbc.com/harmony/app/charts/${tf}.json?symbol=${encodeURIComponent(cnbcSym)}`,
      { headers: { 'user-agent': UA, accept: 'application/json' } },
      8500
    );
    if (!r.ok) return [];
    const j = await r.json();
    const bars = (j && j.barData && j.barData.priceBars) || [];
    const raw = bars.map(b => Number(b && b.close)).filter(v => Number.isFinite(v) && v > 0);
    if (raw.length < 2) return [];
    return tf === '1M' ? raw.slice(-40) : downsampleCloses(raw, maxPts);
  } catch (e) { return []; }
}

async function binanceCloses(symbol = 'BTCUSDT') {
  try {
    const r = await mktFetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=48`, {}, 7000);
    if (!r.ok) return [];
    const rows = await r.json();
    if (!Array.isArray(rows)) return [];
    return rows.map(rowItem => Number(rowItem && rowItem[4])).filter(v => Number.isFinite(v) && v > 0);
  } catch (e) { return []; }
}

async function googleFinanceCompositeCloses() {
  try {
    const r = await mktFetch('https://www.google.com/finance/quote/COMPOSITE:IDX?hl=en', { headers: { 'user-agent': UA } }, 8500);
    if (!r.ok) return [];
    const html = await r.text();
    const vals = [];
    for (const m of html.matchAll(/\[\[\d{4},\d{1,2},\d{1,2},[^\]]+\],\s*\[([0-9]+(?:\.[0-9]+)?),/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 500) vals.push(n);
    }
    return downsampleCloses(vals, 60);
  } catch (e) { return []; }
}

async function yahooCloses(sym, q = 'interval=1m&range=1d') {
  if (!sym || Date.now() < yahooBlockedUntil) return [];
  let closesArr = [];
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await mktFetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?${q}`, { headers: { 'user-agent': UA } }, 9000);
      if (r.status === 429 || r.status === 403) {
        yahooBlockedUntil = Date.now() + 15 * 60000;
        break;
      }
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.chart && d.chart.result && d.chart.result[0];
      const qq = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      closesArr = ((qq && qq.close) || []).filter(v => Number.isFinite(v) && v > 0);
      if (closesArr.length >= 2) return downsampleCloses(closesArr, 90);
    } catch (e) { /* host berikutnya */ }
  }
  return closesArr;
}

const closeInflight = new Map();
async function fetchSymbolCloses(k) {
  if (!k) return [];
  const mem = closeMemo.get(k);
  const now = Date.now();
  // Never serve cached empty forever; valid cache TTL = 10 min, empty retry backoff = 30s
  if (mem && mem.closes && mem.closes.length >= 2 && now - mem.at < 10 * 60000) return mem.closes;
  if (mem && (!mem.closes || mem.closes.length < 2) && mem.failAt && now - mem.failAt < 30000) return [];
  if (closeInflight.has(k)) return closeInflight.get(k);

  const task = (async () => {
    let series = [];
    const cnbcSym = cnbcSymbolFor(k);

    if (k === 'FX_IDC:USDIDR') {
      if (fxhist.length >= 2) series = fxhist.slice(-60).map(h => h.v);
      if (series.length < 2) series = await cnbcCloses('IDR=', '5D', 60);
      if (series.length < 2) series = await yahooCloses('IDR=X', 'interval=15m&range=5d');
    } else if (k === 'IDX:COMPOSITE') {
      series = await cnbcCloses('.JKSE', '1D', 90);
      if (series.length < 12) series = await cnbcCloses('.JKSE', '5D', 90);
      if (series.length < 2) series = await cnbcCloses('.JKSE', '1M', 45);
      if (series.length < 2) series = await yahooCloses('^JKSE', 'interval=1m&range=1d');
      if (series.length < 2) series = await yahooCloses('^JKSE', 'interval=1d&range=1mo');
      if (series.length < 2) series = await googleFinanceCompositeCloses();
    } else if (k.startsWith('IDX:')) {
      const yh = k.slice(4) + '.JK';
      series = await cnbcCloses(cnbcSym, '1M', 40);
      if (series.length < 2) series = await yahooCloses(yh, 'interval=1d&range=1mo');
    } else if (k === 'BINANCE:BTCUSDT') {
      series = await cnbcCloses('BTC.CM=', '5D', 90);
      if (series.length < 2) series = await binanceCloses('BTCUSDT');
      if (series.length < 2) series = await yahooCloses('BTC-USD', 'interval=1m&range=1d');
    } else {
      series = await cnbcCloses(cnbcSym, '5D', 90);
      if (series.length < 2) series = await cnbcCloses(cnbcSym, '1M', 45);
      if (series.length < 2) {
        const yh = CMD_YH[k] || k;
        series = await yahooCloses(yh, 'interval=1m&range=1d');
        if (series.length < 2) series = await yahooCloses(yh, 'interval=1d&range=1mo');
      }
    }

    if (series && series.length >= 2) {
      closeMemo.set(k, { at: Date.now(), closes: series });
      if (closeMemo.size > 500) closeMemo.delete(closeMemo.keys().next().value);
      mktClosesDirty = true;
      saveMktCloses(false);
      return series;
    }

    // Upstream transiently unavailable: keep any stale valid closes (<24h), otherwise short 30s backoff
    if (mem && mem.closes && mem.closes.length >= 2) {
      mem.failAt = Date.now();
      return mem.closes;
    }
    closeMemo.set(k, { at: 0, failAt: Date.now(), closes: [] });
    return [];
  })().finally(() => closeInflight.delete(k));

  closeInflight.set(k, task);
  return task;
}

const worldIndex = () => memo('worldidx', 60000, async () => {
  const tvMap = new Map();
  try {
    const tvRows = await tvScan('global', {
      columns: COLS.slice(0, 4),
      symbols: { query: { types: [] }, tickers: WORLD_IDX.map(w => w[3]).filter(Boolean) }
    });
    for (const s of tvRows) tvMap.set(s.s, row('WORLD', s));
  } catch (e) {}

  const out = [];
  for (let i = 0; i < WORLD_IDX.length; i += 6) {
    await Promise.all(WORLD_IDX.slice(i, i + 6).map(async ([sym, name, , tvSym]) => {
      const tv = tvSym ? tvMap.get(tvSym) : null;
      const cl = await fetchSymbolCloses(sym);
      const price = tv && isFinite(tv.price) ? tv.price : (cl.length ? cl[cl.length - 1] : null);
      if (!isFinite(price)) return;
      const prev = cl.length > 1 ? cl[cl.length - 2] : null;
      const chg = tv && isFinite(tv.chg) ? tv.chg : (prev ? price - prev : 0);
      const pct = tv && isFinite(tv.pct) ? tv.pct : (prev ? chg / prev * 100 : 0);
      out.push({ sym, ticker: name, name, price, prev, chg, pct, closes: cl.slice(-45) });
    }));
  }
  return out;
});
const knownMarketSyms = new Set([
  'IDX:COMPOSITE', 'FX_IDC:USDIDR', 'BINANCE:BTCUSDT', '^JKSE', 'IDR=X',
  ...WORLD_IDX.map(w => w[0]),
  ...COMMODITIES.map(c => c[0]),
]);
// 45 dtk, jangan diturunkan ke 15 lagi: TTL 15 dtk melipatgandakan request ke
// upstream TradingView/CNBC (rawan rate-limit/429 tanpa manfaat data segar).
const market = () => memo('market', 45000, async () => {
  const cmdTick = m => COMMODITIES.filter(c => c[2] === m).map(c => c[0]);
  const [idx, fx, cmdF, cmdC, ihsgR, idrQ, world, ihsgCloses] = await Promise.all([
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
    worldIndex().catch(() => []),
    fetchSymbolCloses('IDX:COMPOSITE').catch(() => [])
  ]);
  const stocks = idx.map(s => {
    const it = row('IDX', s);
    it.blue = STOCK_BLUE.has(it.ticker);
    const cached = closeMemo.get(it.sym);
    if (cached && cached.closes && cached.closes.length >= 2) it.closes = cached.closes;
    return it;
  }).filter(x => isFinite(x.price) && x.price > 0);
  if (!stocks.length) throw new Error('market kosong');
  const ihsg = ihsgR.length ? { ...row('IDX', ihsgR[0]), name: 'IHSG', ticker: 'IHSG' } : null;
  if (ihsg && ihsgCloses && ihsgCloses.length >= 2) ihsg.closes = ihsgCloses;
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
    const cached = closeMemo.get(sym);
    if (cached && cached.closes && cached.closes.length >= 2) it.closes = cached.closes;
    if (isFinite(it.price)) forex.push(it);
  }
  const idr = forex.find(x => x.ticker === 'USDIDR');
  if (idr && idrQ) Object.assign(idr, { price: idrQ.price, chg: idrQ.chg, pct: idrQ.pct, closes: idrQ.closes });   // feed TV USDIDR stale — pakai floatrates + history harian
  for (const s of stocks) if (s && s.sym) knownMarketSyms.add(s.sym);
  for (const f of forex) if (f && f.sym) knownMarketSyms.add(f.sym);
  return { ok: true, ihsg, stocks: { ok: true, items: stocks }, forex: { ok: true, items: forex }, world, at: Date.now() };
});
async function closes(list) {
  const out = {};
  const keys = [...new Set((list || []).filter(Boolean))].slice(0, 60);
  for (let i = 0; i < keys.length; i += 6) {
    await Promise.all(keys.slice(i, i + 6).map(async k => {
      out[k] = await fetchSymbolCloses(k);
    }));
  }
  return { ok: true, closes: out };
}

/* ---------- PENERBANGAN: adsb.lol (ADS-B REST, tanpa key) — multi-titik cover Indonesia ---------- */
const FL_PTS = [[3.6, 98.7, 250], [-6.2, 106.8, 250], [-3, 114.6, 250], [-2, 120.5, 250],
  [-8.6, 115.3, 250], [-2.5, 140.7, 250]];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let flCache = { at: 0, items: [] };
const flights = () => singleFlight(flCache, 20000, async () => {
  const seen = new Map();
  let anyOk = false;
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
      if (r.ok) { anyOk = true; const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
      else throw new Error('fi ' + r.status);
    } catch (e) {
      try {
        const r = await get(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {}, 15000);
        if (r.ok) { anyOk = true; const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
      } catch (e2) {}
    }
    await sleep(1050); // rate limit adsb.fi 1 req/s
  }
  if (anyOk || !flCache.items.length) {
    flCache.items = [...seen.values()].slice(0, 1500);
    flCache.at = anyOk ? Date.now() : (Date.now() - 20000 + 8000);
  } else {
    flCache.at = Date.now() - 20000 + 8000;
  }
  return flCache.items;
});

/* ---------- BENCANA: BMKG gempa + MAGMA gunung api + Open-Meteo cuaca + RainViewer radar ---------- */
const disCache = { at: 0, data: null };
const VOLCANO_COORDS = {
  'Anak Krakatau':[-6.10,105.42],'Merapi':[-7.54,110.44],'Semeru':[-8.11,112.92],'Ibu':[-1.49,127.63],
  'Dukono':[1.69,127.88],'Sangeang Api':[-8.20,119.07],'Bromo':[-7.94,112.95],'Agung':[-8.34,115.51],
  'Sinabung':[3.17,98.39],'Kerinci':[-1.70,101.26],'Dempo':[-4.02,103.13],'Papandayan':[-7.32,107.73],
  'Guntur':[-7.25,107.85],'Batu Tara':[-7.79,123.58],'Karangetang':[2.78,125.41],'Lokon':[1.37,124.83],
  'Kelimutu':[-8.77,122.80],'Egon':[-8.68,122.45],'Lewotobi':[-8.54,122.77],
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
const disaster = () => singleFlight(disCache, 120000, async () => {
  const now = Date.now();
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
  // Sumber gagal ≠ tidak ada data: BMKG down + MAGMA up dulu menghapus semua pin
  // gempa (guard client butuh KEDUA array kosong). Pertahankan irisan terakhir
  // per-sumber dan tandai stale — payload kosong dari sumber yang fulfilled
  // tetap membersihkan pin seperti biasa.
  const gempaOk = auto.status === 'fulfilled' || hist.status === 'fulfilled';
  const magmaOk = magma.status === 'fulfilled';
  const prev = disCache.data;
  const gempaOut = gempaOk ? dedup : (prev ? prev.gempa : []);
  const gunungOut = magmaOk ? gunung : (prev ? prev.gunung : []);
  const stale = !!prev && (!gempaOk || !magmaOk);
  disCache.at = now; disCache.data = { ok: true, gempa: gempaOut, gunung: gunungOut, at: now, stale, srcErr: { gempa: !gempaOk, gunung: !magmaOk } };
  return disCache.data;
});
const WX_PTS = [[95.3,5.5],[99.5,0.5],[105.8,-6.2],[110.4,-7.5],[114.5,-3],[119.4,-0.5],[117.0,-5.1],[113.6,-7.3],[120.9,0.5],[119.9,-4.5],[123.0,-1.5],[124.8,0.9],[127.4,0.9],[130.8,-1.5],[131.3,-3],[136.1,-4.5],[137.8,-3],[140.5,-3.7],[113.9,0.5],[95.3,3.6]];
const wxCache = { at: 0, data: null };
const weather = () => singleFlight(wxCache, 600000, async () => {
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
});
const radarCache = { at: 0, data: null };
const radar = () => singleFlight(radarCache, 300000, async () => {
  try {
    const r = await get('https://api.rainviewer.com/public/weather-maps.json', {}, 15000);
    const d = await r.json();
    const past = (d.radar && d.radar.past) || [];
    radarCache.at = Date.now();
    radarCache.data = { ok: true, generated: Number(d.generated) || Date.now() / 1000,
      host: String(d.host || 'https://tilecache.rainviewer.com'),
      frames: past.map(f => ({ time: Number(f.time), path: String(f.path || '') })), at: Date.now() };
    return radarCache.data;
  } catch(e) { return cacheFail(radarCache, 300000, { ok: false, err: String(e.message||e).slice(0,150), frames: [] }); }
});

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
const fires = () => singleFlight(fireCache, 600000, async () => {
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
  return cacheFail(fireCache, 600000, { ok: sourceStatus.some(s => s.ok), items: out.slice(0, 3000), sources: sourceStatus, at: Date.now() });
});

/* ---------- SIPONGI+ Kemenhut: hotspot karhutla + stasiun kualitas udara ---------- */
const sipongiCache = { at: 0, data: null };
const SIPONGI = 'https://opsroom.sipongidata.my.id';
// Endpoint internal yang dipakai frontend resmi sipongi.gakkum.kehutanan.go.id/peta
const SIPONGI_HOTSPOT_URL = SIPONGI + '/api/opsroom/indoHotspot?wilayah=IN&filterperiode=false&from=&to=&late=24' +
  '&satelit%5B%5D=NASA-MODIS&satelit%5B%5D=NASA-SNPP&satelit%5B%5D=NASA-NOAA20&satelit%5B%5D=NASA-NOAA21' +
  '&satelit%5B%5D=LPN-MODIS&satelit%5B%5D=LPN-NPP&satelit%5B%5D=LPN-NOAA20&satelit%5B%5D=LPN-LANDSAT8' +
  '&confidence%5B%5D=low&confidence%5B%5D=medium&confidence%5B%5D=high&provinsi=&kabkota=';
const sipongi = () => singleFlight(sipongiCache, 600000, async () => {
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
});

const modelRunCache = { at: 0, data: null };
const bmkgModelRun = () => singleFlight(modelRunCache, 300000, async () => {
  try {
    const r = await get('https://satellite.bmkg.go.id/api22/modelrun', {}, 15000);
    const d = await r.json();
    return cacheFail(modelRunCache, 300000, { ok: true, himawari9: d.himawari9 || [], at: Date.now() });
  } catch(e) { return cacheFail(modelRunCache, 300000, { ok: false, err: String(e.message || e).slice(0,150), himawari9: [] }); }
});

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
const satelliteProducts = () => singleFlight(satelliteCache, 600000, async () => {
  const products = await Promise.all(SAT_PRODUCTS.map(async p => {
    try {
      const r = await get(p.url, { method: 'HEAD' }, 15000);
      return { ...p, lastModified: r.headers.get('last-modified') || null, contentLength: Number(r.headers.get('content-length')) || null, status: r.status, error: null };
    } catch(e) {
      return { ...p, lastModified: null, contentLength: null, status: 0, error: String(e.message || e).slice(0,150) };
    }
  }));
  // cacheFail: semua probe gagal (ok:false) tidak menimpa data bagus terakhir —
  // mencegah fetch storm ke BMKG saat upstream down.
  return cacheFail(satelliteCache, 600000, { ok: products.some(p => p.status === 200), products, attribution: 'BMKG · Himawari-9', at: Date.now() });
});

/* ---------- WIND GRID: Open-Meteo untuk leaflet-velocity (format grib2json) ---------- */
const WIND_LATS_DESC = [6,4,2,0,-2,-4,-6,-8,-10];   // utara → selatan
const WIND_LONS = [95,98,101,104,107,110,113,116,119,122,125,128,131,134,137,140];   // tetap, rapat n cukup buat Indonesia
const WIND_GRID = [];
for (const la of WIND_LATS_DESC) for (const lo of WIND_LONS) WIND_GRID.push([la, lo]);
const windCache = { at: 0, data: null };
const windGrid = () => singleFlight(windCache, 900000, async () => {
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
});

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
const alerts = () => singleFlight(alertCache, 300000, async () => {
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
          // link CAP dari feed BMKG — pihak ketiga, assert publik per hop redirect.
          const { r: rr } = await mediaGet(d.link, 15000);
          const cx = await mediaText(rr, 1 << 20);   // CAP XML — cap 1MB
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
});

/* ---------- KAPAL: AISStream.io websocket publik (tanpa key, bbox Indonesia) ---------- */
const shipMap = new Map();
let wsSock = null, wsBuf = Buffer.alloc(0), wsRetry = 0, wsTimer = null;
function wsSchedule(ms) {
  if (isDraining || wsTimer) return;
  wsTimer = setTimeout(() => { wsTimer = null; if (!isDraining && require.main === module) {
  SEC.runIsolated('ais', () => aisConnect());
} }, ms);
  if (wsTimer.unref) wsTimer.unref();
}
function wsSend(text){
  if (!wsSock || wsSock.destroyed) return;
  const p = Buffer.from(text), mask = crypto.randomBytes(4);
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
    if (!Number.isFinite(len) || len < 0 || len > 2097152) {
      console.error('[ais] frame size tidak valid:', len);
      try { wsSock && wsSock.destroy(); } catch {}
      wsSock = null; wsBuf = Buffer.alloc(0);
      return;
    }
    if (wsBuf.length < off + len) return;
    const pl = wsBuf.slice(off, off + len); wsBuf = wsBuf.slice(off + len);
    if (op === 9) { // ping -> pong
      const mask = crypto.randomBytes(4), pl2 = Buffer.from(pl);
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
  if (isDraining || (wsSock && !wsSock.destroyed)) return;
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  const key = crypto.randomBytes(16).toString('base64');
  const req = require('https').request({
    host:'stream.aisstream.io', path:'/v0/stream', method:'GET', rejectUnauthorized: true, ca: TRUSTED_ROOTS.pems, timeout: 20000,
    headers:{ Connection:'Upgrade', Upgrade:'websocket', 'Sec-WebSocket-Key':key, 'Sec-WebSocket-Version':'13', 'User-Agent':UA }
  });
  req.on('upgrade', (res, socket) => {
    wsSock = socket; wsBuf = Buffer.alloc(0); wsRetry = 0;
    socket.on('data', c => {
      if (socket !== wsSock) return;
      if (wsBuf.length + c.length > 2097152) {
        console.error('[ais] buffer overflow, putus koneksi');
        wsBuf = Buffer.alloc(0);
        try { socket.destroy(); } catch {}
        return;
      }
      wsBuf = Buffer.concat([wsBuf, c]);
      wsFrames();
    });
    socket.on('close', () => { if (socket === wsSock) wsSock = null; if (!isDraining) wsSchedule(15000); });
    socket.on('error', () => { if (socket === wsSock) wsSock = null; });
    wsSend(JSON.stringify({ APIKey: process.env.AISSTREAM_API_KEY || (CFG.aisstream && CFG.aisstream.api_key) || '',
      BoundingBoxes:[[[-11,95],[6.5,141]]],
      FilterMessageTypes:['PositionReport'], FiltersShipMMSI:[] }));
  });
  req.on('timeout', () => { try { req.destroy(new Error('AIS handshake timeout')); } catch {} });
  req.on('response', (res) => { console.log('[ais] rejected', res.statusCode); req.destroy(); wsSchedule(Math.min(120000, 15000 * ++wsRetry)); });
  req.on('error', (e) => { console.log('[ais]', e.message); wsSchedule(Math.min(120000, 15000 * ++wsRetry)); });
  req.on('upgrade', () => console.log('[ais] connected'));
  req.end();
}
if (require.main === module) {
  SEC.runIsolated('ais', () => aisConnect());
}
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
const transit = () => singleFlight(busCache, 25000, async () => {
  try {
    const tok = await tjAuth();
    const r = await get(TJ_API + '/v1/bus?latitude=-6.1754&longitude=106.8272&radius=20',
      { headers: { ...TJ_H, Authorization: 'Bearer ' + tok } }, 25000);
    const d = await r.json();
    const arr = Array.isArray(d.data) ? d.data : (d.data && d.data.buses) || [];
    const items = arr.filter(b => b.latitude != null && b.longitude != null).map(b => ({
      id: b.bus_body_no || b.trip_id || '?', route: b.route_code || '', name: b.route_name || b.route_long_name || '',
      dest: b.trip_headsign || b.direction || '', speed: b.speed != null ? b.speed : null,
      bearing: b.bearing != null ? Math.round(b.bearing) : null, lat: b.latitude, lon: b.longitude })).slice(0, 2500);
    if (items.length) { busCache.at = Date.now(); busCache.items = items; }
    else busCache.at = Date.now(); // jangan spam retry tiap request
  } catch(e) { busCache.at = Date.now(); }
  return busCache.items;
});
if (require.main === module) transit();
/* ---------- CANONICAL MEDIA RESOLVER & GOOGLE NEWS DECODER ---------- */
const thumbCache = new Map();       // 'v<N>:<canonUrl>' -> { v: mediaResult, at }
const urlToCanon = new Map();       // rawUrl -> canonicalUrl
const gnCache = new Map();          // gn:<id> -> { url, at }

const { PRIVATE_HOST, publicURL } = SEC;

const upgradeImage = u => MEDIA.upgradeImage(u);
const imageSize = buf => MEDIA.imageSize(buf);
const regDomain = u => MEDIA.regDomain(u);
const rdImgKey = u => MEDIA.imageKey(u);
const rdDirKey = u => MEDIA.dirKey(u);
const rdJunkUrl = u => MEDIA.rdJunkUrl(u);
const rdSmallHint = u => MEDIA.rdSmallHint(u);
const RD_IMG_JUNK = MEDIA.RD_IMG_JUNK;
const RD_JUNK_URL = MEDIA.RD_JUNK_URL;
const RD_JUNK_BASE = MEDIA.RD_JUNK_BASE;
const BOT_CHALLENGE_RE = EXTRACT.BOT_CHALLENGE_RE;

const probeCache = new Map();   // 'v<N>:<url>' -> { res, at }
async function probeImageDirect(u, referer) {
  const ck = 'v' + PIPELINE_VERSION + ':' + u;
  const hit = probeCache.get(ck);
  if (hit) {
    const ttl = hit.res.ok ? 900000 : (hit.res.transient ? 15000 : 600000);
    if (Date.now() - hit.at < ttl) return hit.res;
  }
  let res;
  try {
    // URL gambar berasal dari HTML artikel pihak ketiga — wajib assert publik per hop redirect (mediaGet).
    const { r, url: finalUrl } = await mediaGet(u, 4500, {
      accept: 'image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.8',
      ...(referer ? { referer } : {})
    });
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
  probeCache.set(ck, { res, at: Date.now() });
  lruCap(probeCache, 600);
  return res;
}

async function probeImage(u, referer) {
  const direct = await probeImageDirect(u, referer);
  if (direct.ok || !direct.transient || process.env.SITREP_NO_WESERV === '1') return direct;
  // Hanya jika probe langsung terkena block WAF/403/timeout transien, coba verifikasi via weserv
  const w = 'https://images.weserv.nl/?url=' + encodeURIComponent(String(u).replace(/^https?:\/\//, ''));
  const viaWeserv = await probeImageDirect(w, referer);
  if (viaWeserv.ok) {
    return { ...viaWeserv, finalUrl: u };
  }
  return direct;
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
  // Fallback meta-refresh / direct anchor off news.google.com
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

// Crawler UA yang sering di-whitelist Cloudflare/WAF situs berita Indonesia (link preview & search bot)
const RD_BOT_UAS = [
  'WhatsApp/2.23.20.0 A',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'TelegramBot (like TwitterBot)',
  'Wget/1.21',
  'curl/8.7.1',
];
const CF_WAF_HOST_RE = /(?:^|\.)(?:tempo\.co|cnnindonesia\.com|cnbcindonesia\.com|jpnn\.com|pikiran-rakyat\.com|mediaindonesia\.com|tribunnews\.com|bisnis\.com|kontan\.co\.id|kompasiana\.com|suara\.com|sindonews\.com|okezone\.com|inews\.id)$/i;

// r.jina.ai free tier ~20 RPM — semua call site (thumb fallback + read race)
// diserialkan dengan jarak minimum supaya burst read+thumb tidak 429/402 massal.
let jinaChain = Promise.resolve(), jinaLast = 0, jinaPending = 0, jinaSkipUntil = 0;
const jinaQP = [], jinaQN = [];   // antrian prioritas (reader) vs biasa (thumb/desc)
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
const JINA_KEY = process.env.JINA_API_KEY || CFG.jina_key || '';
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

// in-flight dedup: /api/thumb + rdFinish share canonical media resolution
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
  return {
    img: (mediaRes.hero && mediaRes.hero.url) || '',
    w: (mediaRes.hero && mediaRes.hero.width) || 0,
    h: (mediaRes.hero && mediaRes.hero.height) || 0,
    src: mediaRes.canonicalUrl || mediaRes.requestedUrl || '',
    canonicalUrl: mediaRes.canonicalUrl || '',
    source: (mediaRes.hero && mediaRes.hero.source) || 'none',
    method: (mediaRes.hero && mediaRes.hero.method) || 'none',
    aspectRatio: (mediaRes.hero && mediaRes.hero.aspectRatio) || 0,
    mime: (mediaRes.hero && mediaRes.hero.mime) || '',
    bytes: (mediaRes.hero && mediaRes.hero.bytes) || 0,
    verified: Boolean(mediaRes.hero && mediaRes.hero.verified),
    status: (mediaRes.hero && mediaRes.hero.status) || 'no_candidates',
    transient: Boolean(mediaRes.transientFailure),
    videos: Array.isArray(mediaRes.videos) ? mediaRes.videos : [],
    schemaVersion: PIPELINE_VERSION,
    diagnostics: mediaRes.diagnostics || null,
  };
}

async function thumbRun(u) {
  const x = publicURL(u);
  if (!x) throw new Error('url tidak valid');
  const preHit = mediaCacheGet(u);
  if (preHit) return formatThumbResponse(preHit);

  let article = u;
  if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) {
    article = await decodeGNews(u);
    if (article === u) throw new Error('gagal resolve google news');
  }
  const canon = MEDIA.canonicalArticleUrl(article) || article;
  const hitA = mediaCacheGet(u, canon);
  if (hitA) return formatThumbResponse(hitA);

  // Reuse readCache jika artikel sudah pernah diekstrak
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
  let artHost = '';
  try { artHost = new URL(article).hostname; } catch (e) {}
  const isWafHost = CF_WAF_HOST_RE.test(artHost);
  const directP = (isWafHost
    ? sleep(250).then(() => tryDocFetch(article, 6000, {}, false, 'direct'))
    : tryDocFetch(article, 7000, {}, false, 'direct'));
  const fastBotP = tryDocFetch(article, 6000, { 'user-agent': RD_BOT_UAS[0] }, false, 'bot');
  // Prevent unhandledRejection when early fast-path resolves before loser settles
  directP.catch(() => {});
  fastBotP.catch(() => {});
  let fast = await Promise.race([
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
    for (const av of rdAmpVariants(article).slice(0, 1)) {
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
      const { r } = await jinaGet('https://r.jina.ai/' + article, 12000, { accept: 'text/plain' });
      if (r.ok) {
        const txt = await mediaText(r, 2 << 20);
        if (txt && !BOT_CHALLENGE_RE.test(txt.slice(0, 5000))) jinaMd = txt;
      }
    } catch (e) {}
  }

  if (!doc && !jinaMd) upstreamStatus = 'upstream_blocked_or_failed';
  const targetFinal = (doc && doc.finalUrl) || article;
  const finalCanon = MEDIA.canonicalArticleUrl(targetFinal) || canon;
  const rssImgs = wireIt ? (wireIt.rssImgs || (wireIt.rssImg ? [wireIt.rssImg] : [])) : [];

  const mediaRes = await MEDIA.resolveArticleMedia({
    requestedUrl: u,
    canonicalUrl: finalCanon,
    html: doc ? doc.html : null,
    jinaMarkdown: jinaMd,
    rssImgs,
    mode: 'hero',
    method: doc ? doc.via : (jinaMd ? 'jina' : (rssImgs.length ? 'rss' : 'none')),
    wireTitle: (wireIt && wireIt.title) || '',
    probeFn: probeImage,
    reuseTracker: assetReuse,
    upstreamStatus,
  });
  if (!doc && !jinaMd && !mediaRes.hero.verified) {
    mediaRes.transientFailure = true;
    mediaRes.hero.status = 'upstream_blocked';
  }
  mediaRes.videos = await resolvePlayableVideos(doc ? doc.html : '', targetFinal, (wireIt && wireIt.title) || '');
  mediaCacheSet([u, article, canon, finalCanon], mediaRes);
  return formatThumbResponse(mediaRes);
}

/* ---------- PUBLIC SNAPSHOT ALLOWLISTS & RUNTIME METRICS ---------- */
const openCors = () => !AUTH.userMode && !AUTH.publicMode;
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
  if (knownNewsUrls.has(raw) || urlToCanon.has(raw) || descGet(raw) !== undefined) return true;
  const canon = MEDIA.canonicalArticleUrl(raw) || raw;
  if (knownNewsUrls.has(canon) || getReadCache(canon, raw)) return true;
  return Boolean(rdWireFind(raw));
}
function isKnownThreadUrl(raw) {
  const x = publicURL(raw);
  if (!x) return false;
  const id = tweetId(x.href);
  if (id && /(^|\.)(x|twitter)\.com$/i.test(x.hostname)) {
    if (cache.has('xth:' + id)) return true;
    for (const p of xHist.values()) {
      if (p && (p.id === id || tweetId(p.url) === id)) return true;
    }
    return false;
  }
  if (/(^|\.)threads\.(com|net)$/i.test(x.hostname) && /\/post\//.test(x.pathname)) {
    if (cache.has('thth:' + x.href)) return true;
    const normPath = x.pathname.replace(/\/+$/, '').toLowerCase();
    for (const p of tHist.values()) {
      if (!p || !p.url) continue;
      try {
        const pu = new URL(p.url);
        if (pu.pathname.replace(/\/+$/, '').toLowerCase() === normPath) return true;
      } catch {}
    }
  }
  return false;
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
for (const m of newsHistByFeed.values()) {
  for (const it of m.values()) if (it && it.url) registerNewsUrl(it.url);
}
const METRICS = {
  startedAt: Date.now(),
  reqTotal: 0,
  rejected429: 0,
  rejected403: 0,
  rejected503: 0,
  outboundBlocked: 0,
  proxyWarning: false,
  cacheHits: 0,
  routes: new Map(),
};
function metricInc(route, status) {
  METRICS.reqTotal++;
  if (status === 429) METRICS.rejected429++;
  else if (status === 403) METRICS.rejected403++;
  else if (status === 503) METRICS.rejected503++;
  if (route) {
    let r = METRICS.routes.get(route);
    if (!r) {
      r = { count: 0, err: 0 };
      if (METRICS.routes.size < 120) METRICS.routes.set(route, r);
    }
    if (r) { r.count++; if (status >= 400) r.err++; }
  }
}

/* ---------- IMG: proxy avatar CDN (Instagram kirim CORP same-origin, hotlink diblokir browser) ---------- */
const IMG_HOSTS = ['fbcdn.net', 'cdninstagram.com', 'unavatar.io', 'googleusercontent.com', 'ggpht.com'];
const imgOK = u => { try { const h = new URL(u); return h.protocol === 'https:' && IMG_HOSTS.some(d => h.hostname === d || h.hostname.endsWith('.' + d)); } catch (e) { return false; } };
async function img(u, res) {
  if (!u || !imgOK(u)) { res.writeHead(403); return res.end('host tidak diizinkan'); }
  // mediaGet: redirect manual + rdAssertPublic/imgOK divalidasi ulang tiap hop —
  // redirect ke IP privat tidak bisa lagi bypass allowlist hostname.
  let r;
  try { ({ r } = await mediaGet(u, 12000, {}, imgOK)); }
  catch (e) { res.writeHead(502); return res.end(); }
  if (!r.ok) { res.writeHead(r.status); return res.end(); }
  const ct = r.headers.get('content-type') || '';
  const ctLow = ct.split(';')[0].trim().toLowerCase();
  if (!/^image\//i.test(ctLow) || /^image\/svg\+xml\b/i.test(ctLow)) { res.writeHead(415); return res.end('bukan gambar'); }
  let buf;
  try { buf = await mediaBody(r, 2 << 20); }
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

/* ---------- CCTV: proxy HLS (CORS/hotlink/mixed-content aman) + cek hidup ---------- */
const cctvHostList = () => (CFG.cctv_hosts || ['balitower.co.id', 'jakarta.go.id', 'molecool.id', 'pantaucctv.com']).concat(CFG.tv_hosts || []);
// host dari katalog tepercaya (BPJT/pemda/molecool) ikut diizinkan: tanpa ini ~19% kamera
// 403 di jalur proxy. Tetap lewat rdAssertPublic (anti-SSRF) + rate limit gateway.
const catalogHosts = new Set();
const hostOK = u => { try { const h = new URL(u).hostname; return catalogHosts.has(h) || cctvHostList().some(d => h === d || h.endsWith('.' + d)); } catch (e) { return false; } };
const isTvHost = u => { try { const h = new URL(u).hostname; return (CFG.tv_hosts || []).some(d => h === d || h.endsWith('.' + d)); } catch (e) { return false; } };
// token disisipkan ke URL rewrite supaya segmen/URI turunan tetap lolos gate
// (/hls /vhs digate — request sudah terauth saat playlist dibuat, aman disebar).
const px = u => (AUTH.userMode || AUTH.publicMode)
  ? ('/hls?u=' + encodeURIComponent(u))
  : ('/hls?u=' + encodeURIComponent(u) + '&token=' + encodeURIComponent(API_TOKEN));
// Header upstream per provider: sesuaikan origin agar lolos anti-hotlink & bot filter
function cctvHeaders(u) {
  const mh = (() => { try { return new URL(u).hostname; } catch (e) { return ''; } })();
  if (isTvHost(u)) return { 'user-agent': UA };
  if (/(^|\.)molecool\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://molecool.id/', origin: 'https://molecool.id' };
  if (/(^|\.)pantaucctv\.com$/i.test(mh)) return { 'user-agent': UA, referer: 'https://pantaucctv.com/', origin: 'https://pantaucctv.com' };
  if (/(^|\.)jogjakota\.go\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://cctv.jogjakota.go.id/' };
  if (/(^|\.)bpjt\.pu\.go\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://bpjt.pu.go.id/' };
  if (/(^|\.)jakarta\.go\.id$|(^|\.)balitower\.co\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://smartcity.jakarta.go.id/', origin: 'https://smartcity.jakarta.go.id' };
  return { 'user-agent': UA };
}
// Molecool: token preview ~1 jam — resolve ulang per slug supaya playlist &
// segmen turunan selalu pakai token segar (moleFresh memo per slug).
async function cctvRewrite(u) {
  try {
    const hu = new URL(u);
    if (/^cctv\.molecool\.id$/i.test(hu.hostname)) {
      const slug = hu.pathname.split('/').filter(Boolean)[0];
      const tok = slug && await moleFresh(slug);
      if (tok) { hu.searchParams.set('token', tok); return hu.href; }
    }
  } catch (e) {}
  return u;
}
const cctvKnown = new Set();   // url kamera yang sah (katalog + inline): validasi /api/cctv/report
const GW = require('./cctv-gateway').createGateway({
  getRaw: mediaGetRaw, hostAllowed: hostOK, headersFor: cctvHeaders, rewriteUrl: cctvRewrite, px,
  trustProxy: Boolean(TRUST_PROXY),
  allowCors: openCors(),
  allowPublicCache: Boolean(AUTH.publicMode),
  getClientIp: (req, tp) => SEC.getClientIp(req, tp),
  rateKey: SEC.rateKey,
  isKnownHost: h => hostOK('https://' + h + '/'),
  isKnown: u => cctvKnown.has(u)
});
const hls = (u, req, res) => GW.hls(u, req, res);
// proxy video untuk instant reader: CDN berita (vod.detik dll) menolak Referer localhost → 403.
// Server fetch tanpa referer; playlist m3u8 ditulis ulang rekursif lewat endpoint yang sama.
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
  // Dulu ini full SSRF: sembarang http(s) + redirect diikuti buta. Sekarang
  // rdAssertPublic per hop (DNS → tolak IP privat/loopback) + cap ukuran body.
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
      try { txt = await mediaText(r, 2 << 20); }   // playlist — cap 2MB
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
    try { buf = await mediaBody(r, 20 << 20); }   // mp4/segmen — cap 20MB
    catch (e) { res.writeHead(/terlalu besar/.test(e.message) ? 413 : 502, base); return res.end(); }
    res.writeHead(200, { ...base, 'content-type': ctLow || 'video/mp4' }); res.end(buf);
  } finally {
    if (req && onClose) req.off('close', onClose);
  }
}
let camListC = { m: 0, v: [] };
const camList = () => { try { const m = fs.statSync(HTML).mtimeMs; if (m !== camListC.m) camListC = { m, v: JSON.parse(fs.readFileSync(HTML, 'utf8').match(/id="cam-data">([\s\S]*?)<\/script>/)[1]) }; return camListC.v; } catch (e) { return camListC.v; } };
function seedStaticCctvAllowlist() {
  for (const c of camList()) {
    cctvKnown.add(c.s);
    (Array.isArray(c.fb) ? c.fb : c.fb ? [c.fb] : []).forEach(f => cctvKnown.add(f));
    try { catalogHosts.add(new URL(c.s).hostname); } catch (e) {}
  }
}
seedStaticCctvAllowlist();
const alive = () => memo('alive', 150000, async () => {
  const cams = camList(), res = new Array(cams.length).fill(false); let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => { while (i < cams.length) { const k = i++;
    if (/(jakcctv\.jakarta\.go\.id|pantaucctv\.com|molecool\.id)/i.test(cams[k].s)) { res[k] = true; continue; }   // geo-block DC IP — client playback direct
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
  ['Cilacap',-7.73,109.05],['Pekalongan',-6.89,109.68],['Salatiga',-7.31,110.5],
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
  // url berasal dari sumber eksternal (halaman pemda) — cek publik dulu; kalau
  // DNS sedang gagal, attempt direct tetap throw sendiri dan proxy masih dicoba.
  try { await rdAssertPublic(url); } catch (e) {}
  const customProxy = process.env.CUSTOM_PROXY_URL || process.env.PROXY_URL || CFG.custom_proxy;
  const attempts = [url,
    ...(customProxy ? [(customProxy.endsWith('/') ? customProxy : customProxy + '/') + encodeURIComponent(url)] : []),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url)];
  let lastErr = '';
  for (const u of attempts) {
    try {
      // header hanya untuk attempt direct — proxy publik tidak meneruskan header custom
      const { r } = await mediaGet(u, ms, u === url && headers ? headers : {});
      if (r.ok) return await mediaText(r, 3 << 20);   // halaman CCTV ~1MB — cap 3MB
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
/* Molecool — web tidak expose stream; tiap cam punya preview.jpg?token=... yang
   ditukar jadi index.m3u8. Sumber: kartu trending di /live-cctv + stub /cctv/<code>
   (link share di artikel /updates). Token ~1 jam (epoch ada di token) → proxy
   me-resolve ulang per slug di hls() supaya playback tidak putus. */
const MOLE_UA = { 'user-agent': UA, referer: 'https://molecool.id/' };
const MOLE_SEEDS = ['3DIoRg7','4bsalqw','6Ty5BM3','6oxwbjQ','8JD739Y','AIpWgQ6','CDOd8lH','Ds39keN','FscOWio','GOQqdkB','Gj9Db3K','Jc0KvBZ','Og41dpx','PwQ1zRN','amhRiVY','fKJ9W4y','g7iu58b','lIXKVas','lKOitqX','lqAw39p','mtPwzYo','ucKlag3','wLeQ437'];
const moleReg = new Map();   // slug -> path halaman sumber ('/cctv/X' | '/live-cctv/ID')
const moleTok = new Map();   // slug -> { token, exp }
const moleExp = t => { const m = /-(\d{10})-(\d{10})$/.exec(t || ''); return m ? Math.max(+m[1], +m[2]) * 1000 : 0; };
const molePage = async path => { try { return await cctvFetch('https://molecool.id' + path, 15000, MOLE_UA); } catch (e) { return ''; } };
const moleScan = html => {
  const out = [];
  for (const m of String(html).matchAll(/cctv\.molecool\.id\/([A-Za-z0-9._-]+)\/preview\.jpg\?token=([A-Za-z0-9._-]+)/g))
    out.push({ slug: m[1], token: m[2] });
  return out;
};
const moleInflight = new Map();
async function moleFresh(slug){
  const ent = moleReg.get(slug); if (!ent) return null;
  const tk = moleTok.get(slug);
  if (tk && tk.exp - Date.now() > 5 * 60000) return tk.token;
  if (moleInflight.has(slug)) return moleInflight.get(slug);
  const p = (async () => {
    const html = await molePage(ent.path);
    let found = null;
    for (const s of moleScan(html)) {
      moleTok.set(s.slug, { token: s.token, exp: moleExp(s.token) });
      if (s.slug === slug) found = s.token;
    }
    return found || (moleTok.get(slug) || {}).token || null;
  })().finally(() => moleInflight.delete(slug));
  moleInflight.set(slug, p);
  return p;
}
const cctvMolecool = () => memo('molecool', 2400000, async () => {
  const out = [], seen = new Set();
  const cityCase = s => String(s || '').trim().replace(/\b[a-z]/g, c => c.toUpperCase()) || 'Jakarta';
  const push = (name, city, slug, token, path) => {
    if (!slug || !token || seen.has(slug)) return;
    seen.add(slug);
    moleReg.set(slug, { path });
    moleTok.set(slug, { token, exp: moleExp(token) });
    out.push({ n: name || slug, s: `https://cctv.molecool.id/${slug}/index.m3u8?token=${token}`,
      e: 'https://molecool.id' + path, la: null, lo: null, c: cityCase(city), src: 'molecool' });
  };
  // kartu trending — index memuat 5 cam dengan nama/kota/aslinya
  const idx = await molePage('/live-cctv');
  for (const blk of String(idx).split('wire:key="cctv-').slice(1)) {
    const id = blk.slice(0, blk.indexOf('"'));
    const pv = /cctv\.molecool\.id\/([A-Za-z0-9._-]+)\/preview\.jpg\?token=([A-Za-z0-9._-]+)/.exec(blk);
    const nm = /cctv__name">\s*([^<]+?)\s*<\/a>/.exec(blk);
    const ct = /text-card-city-name[\s\S]*?<\/i>\s*([^<]+?)\s*<\/p>/.exec(blk);
    if (pv && /^\d+$/.test(id)) push(nm && nm[1], ct && ct[1], pv[1], pv[2], '/live-cctv/' + id);
  }
  // stub share — og:title nama cam, og:description alamat + kota
  await Promise.all(MOLE_SEEDS.map(async code => {
    const h = await molePage('/cctv/' + code); if (!h) return;
    const im = /cctv\.molecool\.id\/([A-Za-z0-9._-]+)\/preview\.jpg\?token=([A-Za-z0-9._-]+)/.exec(h);
    const nm = /og:title" content="([^"]*)/.exec(h);
    const ds = /og:description" content="([^"]*)/.exec(h);
    const city = ds ? (/((?:jakarta|kota bekasi)[a-z ]*)$/i.exec(ds[1]) || [null, ''])[1] : '';
    if (im) push(nm && nm[1], city, im[1], im[2], '/cctv/' + code);
  }));
  return out;
});
/* probe 3 level: master playlist → variant/media playlist → segmen .ts pertama.
   cam hanya "hidup" kalau segmen beneran ke-load — playlist 200 doang tidak cukup. */
const cctvProbe = { alive: new Set(), done: new Set(), running: false, last: 0 };
const hostCors = new Map();   // host -> true/false (ada Access-Control-Allow-Origin saat dites dgn Origin asing)
const probeLane = require('./cctv-gateway').makeLane(8, 2);   // sweep TIDAK boleh makan semaphore media user
const probeGet = (url, ms, h) => probeLane.run(new URL(url).host, () => mediaGetRaw(url, ms, h, null));
const HLS_UA = { 'user-agent': UA, referer: 'https://bpjt.pu.go.id/', origin: 'https://probe.invalid' };
function hlsLines(t){ return t.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')); }
async function probeHls(url, depth){
  if (depth > 3) return false;
  try {
    // URL cam berasal dari data halaman pihak ketiga — assert publik per hop.
    const { r, url: furl } = await probeGet(url, 7000, HLS_UA);
    if (!r.ok) return false;
    if (depth === 0) { try { hostCors.set(new URL(url).host, !!r.headers.get('access-control-allow-origin')); } catch (e) {} }
    const t = await mediaText(r, 1 << 20);   // playlist — cap 1MB
    if (!t.includes('#EXTM3U')) return false;
    const lines = hlsLines(t);
    if (!lines.length) return false;
    const first = lines[0];
    if (/\.ts(\?|$)/i.test(first) || first.startsWith('http') && /\.(ts|m4s)(\?|$)/i.test(first)) {
      // ini media playlist — cek segmen pertama bisa di-fetch (Range 4KB, bukan full segmen)
      try {
        const seg = new URL(first, furl).href;
        const { r: sr } = await probeGet(seg, 8000, { ...HLS_UA, range: 'bytes=0-4096' });
        if (!sr.ok && sr.status !== 206) return false;
        const buf = await mediaBody(sr, 1 << 20);   // range 4KB — cap 1MB jaga-jaga
        return buf.byteLength > 500;
      } catch (e) { return false; }
    }
    // master playlist → recurse ke variant pertama
    return await probeHls(new URL(first, furl).href, depth + 1);
  } catch (e) { return false; }
}
async function warmCctv(){
  if (isDraining || cctvProbe.running || Date.now() - cctvProbe.last < 1500000) return;
  cctvProbe.running = true; cctvProbe.last = Date.now();
  const next = { alive: new Set(), done: new Set() };
  try {
    let cams = await cctvBpjt().catch(() => []);
    if (!cams.length) { await new Promise(s => setTimeout(s, 30000)); cams = await cctvBpjt().catch(() => []); }   // fetch gagal → retry sekali
    if (!cams.length) { console.log('[cctv] bpjt fetch kosong, skip sweep'); cctvProbe.running = false; return; }
    const jogja = await cctvJogja().catch(() => []);
    // Interleave kamera round-robin per host agar satu pemda lambat tidak memblokir seluruh worker pool
    const byHost = new Map();
    for (const c of cams.concat(jogja)) {
      let h = '_';
      try { h = new URL(c.s).hostname || '_'; } catch (e) {}
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h).push(c);
    }
    const buckets = [...byHost.values()], interleaved = [];
    let pushed = true;
    while (pushed) {
      pushed = false;
      for (const b of buckets) { if (b.length) { interleaved.push(b.shift()); pushed = true; } }
    }
    cams = interleaved;
    let i = 0, completed = 0;
    await Promise.all(Array.from({ length: 12 }, async () => { while (i < cams.length && !isDraining) { const c = cams[i++];
      const ok = await probeHls(c.s, 0);
      next.done.add(c.s);
      cctvProbe.done.add(c.s);
      if (ok) { next.alive.add(c.s); cctvProbe.alive.add(c.s); }
      if (++completed % 30 === 0) cache.delete('cctvcat');
    } }));
    cctvProbe.alive = next.alive; cctvProbe.done = next.done;
    cache.delete('cctvcat');   // paksa katalog refresh — cam playable langsung muncul
    console.log('[cctv] probe selesai:', next.alive.size, '/', cams.length, 'cam playable');
  } catch (e) {} finally { cctvProbe.running = false; }
}
/* laporan playback real dari client — cam yang gagal di browser langsung turun,
   tidak perlu nunggu sweep probe 25 menit */
const CCTVCORE = require('./public/cctv-core');
const cctvReportedDead = s => GW.reportedDead(s);   // butuh >=2 pelapor berbeda (lihat cctv-gateway.js)
const cctvCatalog = () => memo('cctvcat', 300000, async () => {
  const rs = await Promise.allSettled([cctvBpjt(), cctvBekasi(), cctvJogja(), cctvMolecool()]);
  const bpjt = [], jogja = [], other = [];
  for (const r of rs) if (r.status === 'fulfilled') for (const c of r.value)
    (c.src === 'bpjt' ? bpjt : c.src === 'jogja' ? jogja : other).push(c);
  // BPJT + Jogja: hanya yang probe-confirmed playable + tidak dilaporkan mati client.
  // Sebelum probe selesai → kosong (konsisten dengan jalur BPJT).
  const probeable = cctvProbe.done.size ? [...bpjt, ...jogja].filter(c => cctvProbe.alive.has(c.s)) : [];
  const verified = probeable.filter(c => !cctvReportedDead(c.s));
  // host katalog → boleh lewat proxy; url katalog → sah untuk /api/cctv/report
  for (const c of [...bpjt, ...jogja, ...other]) { try { catalogHosts.add(new URL(c.s).hostname); cctvKnown.add(c.s); } catch (e) {} }
  for (const c of camList()) { cctvKnown.add(c.s); (Array.isArray(c.fb) ? c.fb : c.fb ? [c.fb] : []).forEach(f => cctvKnown.add(f)); try { catalogHosts.add(new URL(c.s).hostname); } catch (e) {} }
  // dedupe stream fisik yang sama + tandai host tanpa CORS (d:0 → client langsung proxy, tidak buang 45 dtk)
  const cams = CCTVCORE.dedupe([...other.filter(c => !cctvReportedDead(c.s)), ...verified]).map(c => {
    try { if (hostCors.get(new URL(c.s).host) === false) return { ...c, d: 0 }; } catch (e) {}
    return c;
  });
  return { ok: true, cams, bpjt_alive: cctvProbe.alive.size, bpjt_total: bpjt.length, probing: cctvProbe.running, snap: await GW.detectFfmpeg(), at: Date.now() };
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

// Helper SSRF/IP & DNS-pinning dari security.js (rdAssertPublic memvalidasi host
// dan PIN alamat IP publik ke socket melalui safeFetch/get).
const { rdIPv4Bytes, rdPrivateBytes, rdPrivateIP, rdAssertPublic } = SEC;
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
// Fetch aman untuk endpoint proxy media (/img /hls /vhs /tomtom/tile dsb):
// rdAssertPublic + safeFetch memvalidasi DNS dan PIN IP ke socket tiap hop,
// serta hostOK (bila diberikan) ikut dicek per hop. Redirect manual, maks 5 hop.
// semaphore global untuk fetch media/upstream — tanpa ini N reader unik =
// ~10N socket concurrent (race 6 job + ~20 image probe) di satu proses.
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
let rdActive = 0;   // kompatibilitas penghitung reader aktif; prioritas diatur eksplisit per-call lewat `prio`
const mediaGet = (raw, ms, headers, hostOK, prio, signal) => mediaSem(() => mediaGetRaw(raw, ms, headers, hostOK, signal), Boolean(prio));
// Baca body dengan cap byte: tolak cepat lewat content-length, lalu batalkan
// stream begitu melewati batas (early-abort, tidak buffer penuh dulu).
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
const rdMeta = html => EXTRACT.rdMeta(html);
const rdLd = html => EXTRACT.rdLd(html);
const rdName = v => EXTRACT.rdName(v);
const rdAbs = (u, base) => EXTRACT.rdAbs(u, base);
const rdOnTopic = (title, desc, paras) => EXTRACT.rdOnTopic(title, desc, paras);
const rdVideos = (html, finalURL, dom = true, title = '') => EXTRACT.rdVideos(html, finalURL, dom, title);
const rdExtract = (html, finalURL, opts = {}) => EXTRACT.rdExtract(html, finalURL, opts);
const rdJinaMd = (txt, url, opts = {}) => EXTRACT.rdJinaMd(txt, url, opts);
const RD_STOP = new Set('yang dan untuk dengan dari pada dalam akan atau juga tidak ini itu oleh para telah sudah bisa saat usai jadi lebih hingga serta kata kini ada sebagai antara bagi agar kembali ungkap soal terkait'.split(' '));
const VID_IFRAME = /(?:youtube\.com\/(?:embed|shorts)\/|youtube-nocookie\.com\/(?:embed|shorts)\/|youtu\.be\/|player\.vimeo\.com\/|facebook\.com\/plugins\/video|\/embed\/|\/player\/|\/video-embed\/)/i;
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
// probe: og:video yang berupa halaman embed → fetch sekali, scrape video asli di dalamnya (bukan iframe webpage)
async function rdHydrateVideos(d, article) {
  const probes = (d.videos || []).filter(v => v.kind === 'probe').slice(0, 2);
  if (!probes.length) return d;
  const resolved = await Promise.all(probes.map(async p => {
    try {
      // p.url = og:video/embed pihak ketiga — assert publik per hop redirect.
      const { r } = await mediaGet(p.url, 10000, { referer: article });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (!/text\/html|application\//i.test(ct)) return { url: p.url, kind: VID_FILE.test(p.url) ? 'video' : 'probe', poster: p.poster };
      const innerHtml = await mediaText(r, 2 << 20);   // halaman embed — cap 2MB
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
const CUSTOM_PROXY = process.env.CUSTOM_PROXY_URL || process.env.PROXY_URL || CFG.custom_proxy || '';
const RD_PROXIES = [
  ...(CUSTOM_PROXY ? [u => CUSTOM_PROXY.includes('%s') ? CUSTOM_PROXY.replace('%s', encodeURIComponent(u)) : (CUSTOM_PROXY.endsWith('=') || CUSTOM_PROXY.endsWith('?') || CUSTOM_PROXY.endsWith('/') ? CUSTOM_PROXY + encodeURIComponent(u) : CUSTOM_PROXY + '?url=' + encodeURIComponent(u))] : []),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
];
const readCache = new Map();   // 'v<N>:<canon>' -> { v, at, ttl, schemaVersion }
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

// Perakitan blok akhir pembaca: pertahankan struktur semantik (h/p/q/li), gambar body terverifikasi sesuai posisi & urutan asli, dan video.
function rdAssembleBlocks(d, mediaRes) {
  if (!d) return d;
  const origBlocks = (Array.isArray(d.blocks) && d.blocks.length)
    ? d.blocks.slice()
    : (d.paras || []).map(t => ({ k: 'p', t }));

  // Petakan posisi paragraf/blok teks asli & caption dari kandidat gambar HTML/Jina
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
  // Artikel tanpa teks berita valid tidak boleh diisi galeri gambar yatim
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

  const mediaP = !/youtube\.com|youtu\.be/i.test(url)
    ? MEDIA.resolveArticleMedia({
        requestedUrl: url,
        canonicalUrl: canonUrl || MEDIA.canonicalArticleUrl(url) || url,
        html: html || null,
        jinaMarkdown: jinaMd || null,
        rssImgs,
        mode: 'full',
        method: via === 'wire-fallback' ? 'rss' : via,
        wireTitle: (wireIt && wireIt.title) || d.title || '',
        probeFn: probeImage,
        reuseTracker: assetReuse,
        upstreamStatus,
      })
    : Promise.resolve(null);

  const [, mediaRes] = await Promise.all([hydP, mediaP]);

  if (mediaRes) {
    d.img = (mediaRes.hero && mediaRes.hero.url) || '';
    d.imgVerified = Boolean(mediaRes.hero && mediaRes.hero.verified);
    d.imgStatus = (mediaRes.hero && mediaRes.hero.status) || 'no_candidates';
    d.canonicalUrl = mediaRes.canonicalUrl || canonUrl || url;
    d.media = {
      schemaVersion: mediaRes.schemaVersion,
      canonicalUrl: mediaRes.canonicalUrl,
      hero: mediaRes.hero,
      bodyImages: mediaRes.bodyImages,
      diagnostics: mediaRes.diagnostics,
    };
    mediaCacheSet([url, canonUrl, d.url, d.final].filter(Boolean), mediaRes);
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
// Negative-cache read gagal: retry/hover tidak mengulang ladder ~40s penuh, dibedakan transient vs permanen.
const readFail = new Map();   // key -> { at, ttl, err, transient }
const READ_FAIL_TTL = 15000;
const readBusy = new Map();   // canonUrl -> Promise

// Varian AMP — banyak publisher ID menyajikan /amp atau .amp tanpa Cloudflare
// challenge. Cuma dipakai sebagai fallback pasca-race (bukan job paralel) supaya
// tidak menambah request konkuren ke host yang sama dan memicu rate-limit.
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
// Snapshot Wayback mentah (id_ = HTML asli tanpa toolbar archive.org).
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
// Anggaran global scrape upstream uncached (/api/read + /api/desc) untuk pemanggil publik:
// hasil cache tetap gratis/instan, tapi burst URL mentah ke portal berita dibatasi
// agar VPS tidak diblokir dan CPU ekstraksi HTML tidak memblok event loop.
const outboundScrapeRl = SEC.createRateLimiter({ outbound: { limit: 180, windowMs: 60000 } });
async function rdRead(raw, bg, forceFresh = false) {
  const x = publicURL(raw);
  if (!x) throw new Error('URL tidak valid');
  const yid = ytIdOf(raw);
  if (yid) return memo('yt:' + yid, 600000, () => rdReadYouTube(yid, raw));

  const fastHit = getReadCache(MEDIA.canonicalArticleUrl(raw), raw);
  if (fastHit && !(forceFresh && (fastHit.wireFallback || fastHit.upstreamBlocked || fastHit.isFallback))) return fastHit;

  let target = raw;
  if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) target = await decodeGNews(raw);
  if (BANNED_SRC.test(target)) {
    const eb = new Error('Sumber berbayar atau dikecualikan (' + (rdHost(target) || 'diblokir') + ')');
    eb.transient = false;
    throw eb;
  }
  await rdAssertPublic(target);

  const canon = MEDIA.canonicalArticleUrl(target) || target;
  const cacheHit = getReadCache(canon, raw);
  if (cacheHit && !(forceFresh && (cacheHit.wireFallback || cacheHit.upstreamBlocked || cacheHit.isFallback))) return cacheHit;

  // Deduplikasi in-flight untuk artikel kanonik yang sama
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

    const FC_KEY = process.env.FIRECRAWL_API_KEY || CFG.firecrawl_key || '';
    if (FC_KEY && left() > 16000) {
      try {
        const r = await get('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + FC_KEY },
          body: JSON.stringify({ url: target, formats: ['html'], onlyMainContent: false, timeout: 15000 })
        }, Math.min(15000, left() - 5000));
        if (r.ok) {
          const j = await r.json();
          const html = j && j.data && j.data.html;
          if (html && String(html).length > 500) {
            const d = evaluateHtml(String(html).slice(0, 3e6), target);
            const md = j.data.metadata || {};
            if (!d.title || /^(undefined|null)$/i.test(d.title) || d.title === rdHost(target)) d.title = md.title || md.ogTitle || d.title;
            if (!d.desc && (md.ogDescription || md['og:description'])) d.desc = md.ogDescription || md['og:description'];
            if (!d.byline && md.author) d.byline = md.author;
            if (!d.time && md['article:published_time']) d.time = md['article:published_time'];
            fetchMs = Date.now() - t0;
            return await fin(d, target, String(html), null, 'firecrawl');
          }
        }
      } catch (e) { lastErr = e; attempts.push({ via: 'firecrawl', err: String(e && e.message || e).slice(0, 90) }); }
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

/* ---------- TomTom Traffic + Routing (proxy server-side agar key tidak bocor ke klien) ---------- */
const ttHas = () => !!TOMTOM_KEY;
const haversine = (a, b) => {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};
// host TomTom tetap (api + subdomain shuffle a-d) — redirect dibatasi ke domain
// yang sama dan body JSON di-cap 2MB.
const ttHostOK = u => { try { const h = new URL(u).hostname; return h === 'api.tomtom.com' || h.endsWith('.api.tomtom.com'); } catch (e) { return false; } };
async function ttFetch(url) {
  const { r } = await mediaGet(url, 12000, { accept: 'application/json' }, ttHostOK);
  const txt = await mediaText(r, 2 << 20);
  let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt.slice(0, 400) }; }
  if (!r.ok) { const err = new Error('TomTom ' + r.status + ' ' + (data.detailedError?.message || data.error || txt.slice(0, 120))); err.status = r.status; err.data = data; throw err; }
  return data;
}
const roundGrid = (v, step) => Math.round(Number(v) / step) * step;
const roundGridStr = (v, step, d = 2) => roundGrid(v, step).toFixed(d);
const ttFlow = (lat, lon, zoom = 10) => {
  const gLat = roundGrid(lat, 0.01);
  const gLon = roundGrid(lon, 0.01);
  const z = Math.max(0, Math.min(22, Math.round(zoom)));
  return memo('tt:flow:' + roundGridStr(gLat, 0.01) + ',' + roundGridStr(gLon, 0.01) + ',' + z, 30000, async () => {
    try {
      if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
      const url = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/' + z + '/json?key=' + encodeURIComponent(TOMTOM_KEY) + '&point=' + gLat.toFixed(4) + ',' + gLon.toFixed(4) + '&unit=kmph&thickness=10';
      const d = await ttFetch(url);
      const f = d.flowSegmentData || {};
      return { ok: true, point: { lat: gLat, lon: gLon }, zoom: z, frc: f.frc || '', exists: !!f.coordinate || !!f.frc,
        coordinates: f.coordinates?.coordinate || [],
        currentSpeed: f.currentSpeed ?? null, freeFlowSpeed: f.freeFlowSpeed ?? null,
        currentTravelTime: f.currentTravelTime ?? null, freeFlowTravelTime: f.freeFlowTravelTime ?? null,
        confidence: f.confidence ?? null, roadClosure: !!f.roadClosure, openlr: f.openlr || '', at: Date.now() };
    } catch (e) {
      return { ok: false, err: String(e.message || e).slice(0, 220) };
    }
  }, v => !!(v && v.ok));
};

const ttIncidents = (bbox, language = 'id-ID') => {
  const parts = String(bbox || '').split(',').map(Number);
  const normBbox = (parts.length === 4 && parts.every(Number.isFinite))
    ? parts.map(v => roundGridStr(v, 0.05, 2)).join(',')
    : String(bbox || '');
  return memo('tt:inc:' + normBbox + ':' + String(language || 'id-ID').slice(0, 12), 30000, async () => {
    try {
      if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
      const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}';
      const url = 'https://api.tomtom.com/traffic/services/5/incidentDetails?key=' + encodeURIComponent(TOMTOM_KEY) +
        '&bbox=' + encodeURIComponent(normBbox) + '&fields=' + encodeURIComponent(fields) +
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
      return { ok: true, bbox: normBbox, count: rows.length, incidents: rows, at: Date.now() };
    } catch (e) {
      return { ok: false, bbox: normBbox, err: String(e.message || e).slice(0, 260) };
    }
  }, v => !!(v && v.ok));
};

const ttRoute = (from, to, mode = 'driving') => {
  const fLat = roundGrid(from.lat, 0.01), fLon = roundGrid(from.lon, 0.01);
  const tLat = roundGrid(to.lat, 0.01), tLon = roundGrid(to.lon, 0.01);
  return memo('tt:route:' + fLat.toFixed(2) + ',' + fLon.toFixed(2) + '>' + tLat.toFixed(2) + ',' + tLon.toFixed(2) + ':' + mode, 30000, async () => {
    try {
      if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
      const iso = ['driving', 'truck', 'bus', 'taxi', 'motorcycle', 'bicycle', 'pedestrian'].includes(mode) ? mode : 'driving';
      const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + fLat.toFixed(4) + ',' + fLon.toFixed(4) + ':' + tLat.toFixed(4) + ',' + tLon.toFixed(4) +
        '/json?key=' + encodeURIComponent(TOMTOM_KEY) +
        '&traffic=true&routeRepresentation=polyline';
      const d = await ttFetch(url);
      const route = d.routes?.[0];
      if (!route) throw new Error('Rute tidak ditemukan');
      const s = route.summary || {};
      const pts = (route.legs || []).flatMap(l => l.points || []);
      const poly = pts.map(p => ({ lat: p.latitude, lon: p.longitude }));
      return { ok: true, mode: iso,
        from: { lat: fLat, lon: fLon }, to: { lat: tLat, lon: tLon },
        straightKm: +haversine(from, to).toFixed(3),
        distanceKm: s.lengthInMeters ? +(s.lengthInMeters / 1000).toFixed(3) : null,
        travelTimeSec: s.travelTimeInSeconds ?? null,
        trafficTimeSec: (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) > 0 ? (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) : (s.travelTimeInSeconds ?? null),
        trafficDelaySec: s.trafficDelayInSeconds ?? null,
        departureTime: s.departureTime || '', arrivalTime: s.arrivalTime || '',
        congestion: s.trafficCongestion || '', legs: (route.legs || []).map(l => ({
          summary: l.summary || {}, points: (l.points || []).length })),
        polyline: poly, at: Date.now() };
    } catch (e) {
      return { ok: false, err: String(e.message || e).slice(0, 280) };
    }
  }, v => !!(v && v.ok));
};

const ttTileCache = new Map(); // key -> { buf, ct, status, etag, at }
const TT_TILE_TTL = 120000, TT_TILE_CAP = 300, TT_TILE_MAX_BYTES = 16 << 20;
const ttTileBusy = new Map();
const ttTileBytes = () => { let n = 0; for (const e of ttTileCache.values()) n += e.buf.length; return n; };
function ttTileSet(key, entry) {
  ttTileCache.delete(key);
  ttTileCache.set(key, entry);
  while (ttTileCache.size > TT_TILE_CAP || (ttTileCache.size > 1 && ttTileBytes() > TT_TILE_MAX_BYTES)) {
    ttTileCache.delete(ttTileCache.keys().next().value);
  }
}
async function ttTile(kind, zRaw, xRaw, yRaw, res, req) {
  const cors = openCors() ? { 'access-control-allow-origin': '*' } : {};
  const z = Number(zRaw), x = Number(xRaw), y = Number(yRaw);
  const maxTile = (1 << Math.max(0, Math.min(18, z | 0))) - 1;
  if (!Number.isInteger(z) || z < 0 || z > 18 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > maxTile || y > maxTile) {
    res.writeHead(400, { ...cors, 'x-content-type-options': 'nosniff' });
    return res.end('koordinat tile tidak valid');
  }
  if (!ttHas()) { res.writeHead(503, cors); return res.end('TomTom key belum dikonfigurasi'); }
  const paths = {
    basic: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    base: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    flow: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
    incidents: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
    incident: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
    hybrid: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png'
  };
  const normKind = paths[kind] ? kind : 'flow';
  const cacheKey = normKind + '/' + z + '/' + x + '/' + y;
  const cc = AUTH.userMode ? 'private, no-store' : 'public, max-age=300, s-maxage=120, stale-while-revalidate=300';
  const sendTile = entry => {
    const hdrs = { ...cors, 'x-content-type-options': 'nosniff', 'content-type': entry.ct, 'cache-control': cc, etag: entry.etag };
    if (req && req.headers && req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, hdrs);
      return res.end();
    }
    res.writeHead(entry.status, { ...hdrs, 'content-length': entry.buf.length });
    res.end(entry.buf);
  };
  const hit = ttTileCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TT_TILE_TTL) {
    ttTileCache.delete(cacheKey); ttTileCache.set(cacheKey, hit);
    METRICS.cacheHits++;
    return sendTile(hit);
  }
  const p = paths[normKind];
  let inflight = ttTileBusy.get(cacheKey);
  if (!inflight) {
    inflight = (async () => {
      const host = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 4)] + '.api.tomtom.com';
      const url = 'https://' + host + p + '?key=' + encodeURIComponent(TOMTOM_KEY);
      const { r } = await mediaGet(url, 12000, {}, ttHostOK);
      const buf = await mediaBody(r, 2 << 20);
      const entry = {
        status: r.status,
        ct: r.headers.get('content-type') || 'image/png',
        buf,
        etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 14) + '"',
        at: Date.now()
      };
      if (r.ok && buf.length > 0) ttTileSet(cacheKey, entry);
      return entry;
    })().finally(() => ttTileBusy.delete(cacheKey));
    ttTileBusy.set(cacheKey, inflight);
  }
  try {
    const entry = await inflight;
    return sendTile(entry);
  } catch (e) {
    res.writeHead(/terlalu besar/.test(e && e.message) ? 413 : 502, cors);
    return res.end();
  }
}

/* ---------- /api/desc: meta description untuk kartu feed yang desc RSS-nya kosong (mayoritas link redirect Google News) ----------
   Client memanggil lazy hanya untuk kartu yang terlihat — endpoint ini TIDAK dipanggil dari
   news(), jadi tidak ada burst fetch ratusan halaman per siklus. */
const DESC_TTL = 6 * 3600e3;             // desc valid 6 jam
const DESC_NEG_TTL = 10 * 60000;         // artikel tanpa desc permanen: 10 mnt
const DESC_TRANSIENT_NEG_TTL = 45000;    // kegagalan upstream transien: hanya 45 dtk
const DESC_CAP = 800;                    // cap entri cache; LRU-ish: entri yang diakses di-refresh posisinya
const DESC_MAX_PER_CALL = 8;             // hard cap fetch per request
const DESC_FETCH_GAP = 250;              // jeda antar fetch (serial, concurrency 1)
const DESC_HOST_GAP = 400;              // jeda minimal antar fetch ke hostname yang sama (politeness)
const descCache = new Map();             // 'v<N>:<canonOrUrl>' -> { desc, at, ttl }
// Gerbang konkurensi jaringan desc (lihat descForUrl). Per-host sudah antre,
// ini batas global lintas host supaya lonjakan pengunjung tidak membuka
// ratusan koneksi keluar sekaligus.
const descNetSem = makeSem(12, 120);
const descHostAt = new Map();            // hostname -> ts fetch terakhir
const descHostChain = new Map();         // hostname -> Promise tail — antrian slot per host
const descNormKey = u => 'v' + PIPELINE_VERSION + ':' + (urlToCanon.get(u) || MEDIA.canonicalArticleUrl(u) || u);
const descGetEntry = u => {
  const k = descNormKey(u);
  const hit = descCache.get(k);
  if (!hit) return undefined;
  descCache.delete(k); descCache.set(k, hit);
  const ttl = hit.ttl || (hit.desc ? DESC_TTL : DESC_NEG_TTL);
  return Date.now() - hit.at < ttl ? { desc: hit.desc, transient: Boolean(hit.transient) } : undefined;
};
const descGet = u => {
  const e = descGetEntry(u);
  return e !== undefined ? e.desc : undefined;
};
const descRemember = (keys, desc, transient = false) => {
  const now = Date.now();
  const ttl = desc ? DESC_TTL : (transient ? DESC_TRANSIENT_NEG_TTL : DESC_NEG_TTL);
  const normKeys = new Set();
  for (const k of keys) {
    if (!k) continue;
    normKeys.add(descNormKey(k));
    normKeys.add('v' + PIPELINE_VERSION + ':' + k);
  }
  for (const k of normKeys) { descCache.delete(k); descCache.set(k, { desc, transient: !desc && transient, at: now, ttl }); }
  while (descCache.size > DESC_CAP) descCache.delete(descCache.keys().next().value);
};
// Baca stream untuk /api/desc: jika </head> punya meta description >=30 char berhenti cepat;
// jika tidak (og:desc == judul atau meta ditaruh di akhir body), terus baca sampai </article> / beberapa </p> / 512KB.
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
// Baca body stream hanya sampai </head> atau cap byte — meta og:/description semua ada di head,
// halaman artikel bisa 1MB+. Early-abort: stream dibatalkan begitu cukup, tidak buffer penuh.
async function mediaHead(r, max) {
  const reader = r.body && r.body.getReader ? r.body.getReader() : null;
  if (!reader) {
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error('halaman terlalu besar');
    return b.toString('utf8');
  }
  const chunks = [];
  let total = 0, tail = '', eof = false;
  while (!eof && total <= max) {
    const rd = await reader.read();
    eof = rd.done;
    if (!rd.value) continue;
    const chunk = Buffer.from(rd.value);
    chunks.push(chunk);
    total += chunk.length;
    tail = (tail + chunk.toString('utf8')).slice(-256);   // tangkap </head> yang terpotong antar-chunk
    if (total > max || /<\/head\s*>/i.test(tail)) break;
  }
  if (!eof) { try { await reader.cancel(); } catch (e) {} }
  const html = Buffer.concat(chunks).toString('utf8');
  const hi = html.search(/<\/head\s*>/i);
  return hi >= 0 ? html.slice(0, hi) : html;
}
async function descForUrl(reqUrl) {
  const cached = descGet(reqUrl);
  if (cached !== undefined) return cached;
  const x = publicURL(reqUrl);
  if (!x) return '';
  let target = reqUrl;
  if (/(^|\.)news\.google\.com$/i.test(x.hostname) && GN_PATH.test(x.pathname)) {
    try { target = await decodeGNews(reqUrl); } catch (e) { descRemember([reqUrl], '', true); return ''; }
    if (/(^|\.)news\.google\.com$/i.test(new URL(target).hostname)) { descRemember([reqUrl], '', true); return ''; }
    if (BANNED_SRC.test(target)) { descRemember([reqUrl, target], '', false); return ''; }
    const viaTarget = descGet(target);
    if (viaTarget !== undefined) { descRemember([reqUrl], viaTarget); return viaTarget; }
  }
  if (BANNED_SRC.test(target)) { descRemember([reqUrl, target], '', false); return ''; }
  const canon = MEDIA.canonicalArticleUrl(target) || target;
  // 1. Cek apakah artikel ini sudah ada di readCache (instan tanpa request jaringan)
  const rHit = getReadCache(canon, reqUrl);
  if (rHit && !rHit.wireFallback && (rHit.desc || (rHit.paras && rHit.paras[0]))) {
    const ds = rHit.desc || rHit.paras[0];
    if (ds && ds.length >= 26 && !BOT_CHALLENGE_RE.test(ds)) {
      descRemember([reqUrl, target, canon], ds);
      return ds;
    }
  }
  // 2. Cek apakah ada di feed Newswire RSS memori
  for (const testU of [target, canon, reqUrl]) {
    const wireIt = rdWireFind(testU);
    if (wireIt && wireIt.desc && wireIt.desc.length >= 26 && !BOT_CHALLENGE_RE.test(wireIt.desc)) {
      descRemember([reqUrl, target, canon], wireIt.desc);
      return wireIt.desc;
    }
  }
  const host = new URL(target).hostname;
  // Semua jalur jaringan di bawah satu gerbang global: ribuan pengunjung yang
  // membuka kartu berbeda = ribuan fetch keluar. 24 konkuren cukup untuk
  // mengisi bandwidth origin tanpa membuat situs sumber memblokir kita;
  // sisanya antre (cap 800) dan 503 transient kalau benar-benar banjir.
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
                descRemember([reqUrl, target, canon], d);
                return d;
              }
            }
          }
        }
      } catch (e) { sawTransient = true; }
      descRemember([reqUrl, target, canon], '', sawTransient);
      return '';
    }
    if (!html) {
      descRemember([reqUrl, target, canon], '', sawTransient);
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
  descRemember([reqUrl, target, canon], out, !out && sawTransient);
  return out;
}

/* ---------- static: cache di memori, ETag/304, brotli/gzip sekali per versi file ----------
   Dulu: readFileSync + regex inject tiap request, index 578KB tanpa kompresi. */
const STATIC_FILES = {
  '/signals.js': ['signals.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/wxicons.js': ['wxicons.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/wire-core.js': ['wire-core.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/cctv-core.js': ['cctv-core.js', 'application/javascript; charset=utf-8', 'no-cache'],
  '/idn.geo.json': ['idn.geo.json', 'application/json', 'public, max-age=3600'],
  '/idn-context.geo.json': ['idn-context.geo.json', 'application/json', 'public, max-age=3600'],
  '/idn-prov.geo.json': ['idn-prov.geo.json', 'application/json', 'public, max-age=3600'],
  '/world110.geo.json': ['world110.geo.json', 'application/json', 'public, max-age=3600'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache']
};
const staticCache = new Map();
function readIndexRaw() {
  const file = path.join(__dirname, 'public', 'index.html');
  const st = fs.statSync(file);
  const key = 'raw:' + file;
  let e = staticCache.get(key);
  if (e && e.mtime === st.mtimeMs && e.size === st.size) return e.html;
  const html = fs.readFileSync(file, 'utf8');
  staticCache.set(key, { mtime: st.mtimeMs, size: st.size, html });
  return html;
}
function staticEntry(pathname) {
  const def = STATIC_FILES[pathname]; if (!def) return null;
  if (def[0] === 'index.html' && AUTH.userMode) return null;
  const file = path.join(__dirname, 'public', def[0]);
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  let e = staticCache.get(file);
  if (e && e.mtime === st.mtimeMs && e.size === st.size) return e;
  let buf = fs.readFileSync(file);
  if (def[0] === 'index.html') {   // local mode: inject boot/env token agar frontend bisa membacanya
    buf = Buffer.from(AUTH.injectHtmlMeta(buf.toString('utf8'), null));
  }
  const big = buf.length > 1024 && !/svg|png|jpe?g/.test(def[1]) || def[1] === 'image/svg+xml' && buf.length > 1024;
  e = { mtime: st.mtimeMs, size: st.size, buf, type: def[1], cc: def[2],
    etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 16) + '"',
    br: big ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : null,
    gz: big ? zlib.gzipSync(buf, { level: 6 }) : null };
  staticCache.set(file, e);
  return e;
}
function serveStatic(pathname, req, res) {
  const e = staticEntry(pathname); if (!e) return false;
  const h = {
    'content-type': e.type,
    'cache-control': e.cc,
    'x-content-type-options': 'nosniff',
    etag: e.etag,
    vary: 'accept-encoding'
  };
  if (pathname.endsWith('.json') && openCors()) h['access-control-allow-origin'] = '*';
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); res.end(); return true; }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = e.buf;
  if (e.br && /\bbr\b/.test(ae)) { body = e.br; h['content-encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; h['content-encoding'] = 'gzip'; }
  h['content-length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
function serveAuthenticatedHtml(req, res, principal) {
  const head = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': principal ? 'SAMEORIGIN' : 'DENY',
    vary: 'cookie, accept-encoding'
  };
  const html = principal ? AUTH.injectHtmlMeta(readIndexRaw(), principal) : AUTH.renderLoginHtml();
  const rawBuf = Buffer.from(html, 'utf8');
  if (rawBuf.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    return zlib.gzip(rawBuf, (err, gz) => {
      if (err || !gz) {
        head['content-length'] = rawBuf.length;
        res.writeHead(200, head);
        return res.end(req.method === 'HEAD' ? undefined : rawBuf);
      }
      head['content-encoding'] = 'gzip';
      head['content-length'] = gz.length;
      res.writeHead(200, head);
      res.end(req.method === 'HEAD' ? undefined : gz);
    });
  }
  head['content-length'] = rawBuf.length;
  res.writeHead(200, head);
  res.end(req.method === 'HEAD' ? undefined : rawBuf);
}
async function readJsonBody(req, maxBytes = 8192) {
  const chunks = [];
  let total = 0;
  for await (const ch of req) {
    total += ch.length;
    if (total > maxBytes) throw new Error('body terlalu besar');
    chunks.push(ch);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
const newsRevSnapshots = new Map(); // rev -> Map(sourceId, sig)
function recordNewsRevSnapshot(rev, srcs) {
  const m = new Map();
  for (const s of srcs || []) m.set(s.id, feedSig(s.items || []));
  newsRevSnapshots.delete(rev);
  newsRevSnapshots.set(rev, m);
  while (newsRevSnapshots.size > 16) newsRevSnapshots.delete(newsRevSnapshots.keys().next().value);
}
async function buildNewsPayload() {
  const nrKey = 'newsresp:v' + PIPELINE_VERSION;
  return memo(nrKey, 25000, async () => {
    const rev = NEWS_REV;
    const srcs = await news(), assessed = await assessedNewsFor(srcs);
    const cnt = new Map();
    const resolvedMap = new Map();
    for (const s of srcs) {
      for (const i of s.items) {
        const canon = urlToCanon.get(i.url) || MEDIA.canonicalArticleUrl(i.url) || i.url;
        const mHit = mediaCacheGet(i.url, canon);
        resolvedMap.set(i.url, { canon, mHit });
        const heroUrl = (mHit && mHit.hero && mHit.hero.verified && mHit.hero.url) ? mHit.hero.url : '';
        if (heroUrl) {
          const k = rdImgKey(heroUrl);
          if (!cnt.has(k)) cnt.set(k, new Set());
          cnt.get(k).add(canon);
        }
      }
    }
    const dupImgs = new Set();
    for (const [k, urls] of cnt) if (urls.size > 1) dupImgs.add(k);

    const sources = [];
    for (const s of srcs) {
      const rows = assessed.get(s.id) || [];
      const outItems = [];
      for (let idx = 0; idx < s.items.length; idx++) {
        const i = s.items[idx];
        if (FEEDTEXT.newsEnglish(i.title, i.desc)) continue;
        const ev = rows[idx];
        const a = ev.a;
        const cat = ev.cat;
        const pl = ev.pl;
        const info = resolvedMap.get(i.url);
        const mHit = info && info.mHit;
        const heroUrl = (mHit && mHit.hero && mHit.hero.verified && mHit.hero.url && !dupImgs.has(rdImgKey(mHit.hero.url))) ? mHit.hero.url : '';
        const imgVerified = Boolean(heroUrl);
        const imgRejected = Boolean(mHit && !mHit.transientFailure && !imgVerified);
        const { rssImg: _ri, rssImgs: _ris, ...pubItem } = i;
        outItems.push({
          ...pubItem,
          img: heroUrl,
          imgVerified,
          imgRejected,
          videos: (mHit && Array.isArray(mHit.videos) && mHit.videos.length) ? mHit.videos : undefined,
          canonicalUrl: (mHit && mHit.canonicalUrl) || (info && info.canon) || i.url,
          cat,
          place: pl ? pl.name : '',
          feedTopic: feedCatOf(s.id),
          assessment: projectNewsAssessment(a),
          label: cat ? catMeta(cat).label : '',
          foreign: ev.fr || undefined,
        });
      }
      sources.push({ ...s, items: outItems });
      await yieldTick();
    }
    recordNewsRevSnapshot(rev, sources);
    return { classifierVersion: SOC.CLASSIFIER_VERSION, pipelineVersion: PIPELINE_VERSION, rev, sources, at: Date.now() };
  });
}
const CACHE_ROUTE_KEY = {
  '/api/news': () => 'newsresp:v' + PIPELINE_VERSION,
  '/api/x': () => 'x',
  '/api/threads': () => 'threads',
  '/api/incidents': u => (u.searchParams.get('nodes') === '0' ? 'incidents:nonodes' : 'incidents:all'),
  '/api/situation': () => 'situation',
  '/api/market': () => 'market',
  '/api/disaster': () => 'disaster',
  '/api/breaking': () => 'breaking',
  '/api/nodes': () => 'nodes',
  '/api/cams': () => 'cams',
  '/api/cctv': () => 'cctv',
};
let runtimeProxyWarned = false;
const SITREP_SERVER = http.createServer(async (req, res) => {
  const cors = openCors() ? { 'access-control-allow-origin': '*' } : {};
  const secHdr = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
  const pubCC = (sMax, swr = sMax * 2, maxAge = Math.min(15, Math.floor(sMax / 2))) =>
    AUTH.userMode ? 'private, no-store' : `public, max-age=${maxAge}, s-maxage=${sMax}, stale-while-revalidate=${swr}`;
  let routeTag = '';
  const sendHit = (hit, c, cacheHdr = 'no-store') => {
    const ae = String(req.headers['accept-encoding'] || '');
    const wantBr = /\bbr\b/.test(ae);
    const wantGz = /\bgzip\b/.test(ae);
    const head = { ...cors, ...secHdr, 'content-type': 'application/json', 'cache-control': cacheHdr };
    if (hit.etag) {
      head.etag = hit.etag;
      if (req.method === 'GET' && req.headers['if-none-match'] === hit.etag) {
        res.writeHead(304, head);
        return res.end();
      }
    }
    if ((!wantBr && !wantGz) || hit.plain.length <= 8192) {
      res.writeHead(c, { ...head, 'content-length': hit.plain.length });
      return res.end(req.method === 'HEAD' ? undefined : hit.plain);
    }
    // brotli ~25-30% lebih kecil dari gzip untuk JSON feed. q4 = titik seimbang
    // buat payload yang di-generate ulang tiap 25 detik (q11 terlalu mahal di CPU).
    const enc = wantBr ? 'br' : 'gz';
    const ready = wantBr ? hit.br : hit.gz;
    if (ready) {
      res.writeHead(c, { ...head, 'content-encoding': wantBr ? 'br' : 'gzip', vary: 'accept-encoding', 'content-length': ready.length });
      return res.end(req.method === 'HEAD' ? undefined : ready);
    }
    const inflightKey = enc + 'Promise';
    if (!hit[inflightKey]) {
      hit[inflightKey] = new Promise(resolve => {
        const done = (e, b) => { hit[enc] = (!e && b) ? b : null; hit[inflightKey] = null; resolve(hit[enc]); };
        if (wantBr) {
          zlib.brotliCompress(hit.plain, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: hit.plain.length,
            }
          }, done);
        } else {
          zlib.gzip(hit.plain, done);
        }
      });
    }
    hit[inflightKey].then(body => {
      if (res.writableEnded || res.destroyed) return;
      if (body) {
        res.writeHead(c, { ...head, 'content-encoding': wantBr ? 'br' : 'gzip', vary: 'accept-encoding', 'content-length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else {
        res.writeHead(c, { ...head, 'content-length': hit.plain.length });
        res.end(req.method === 'HEAD' ? undefined : hit.plain);
      }
    });
  };
  const sendCached = (cacheKey, cacheTtl, c = 200, cacheHdr = 'no-store') => {
    if (!cacheKey || !cacheTtl) return false;
    const hit = bodyCache.get(cacheKey);
    if (!hit || Date.now() - hit.at >= cacheTtl) return false;
    METRICS.cacheHits++;
    metricInc(routeTag, c);
    sendHit(hit, c, cacheHdr);
    return true;
  };
  const json = (o, c = 200, cacheKey = '', cacheTtl = 0, cacheHdr = 'no-store', opts = {}) => {
    if (cacheKey && cacheTtl && c === 200 && sendCached(cacheKey, cacheTtl, c, cacheHdr)) return;
    metricInc(routeTag, c);
    const plain = Buffer.from(JSON.stringify(o));
    const cacheable = Boolean(cacheKey && cacheTtl && c === 200);
    const entry = {
      at: Date.now(), plain, gz: null, br: null, gzPromise: null, brPromise: null,
      etag: cacheable ? (opts.stableAt ? etagStable(plain) : etagOf(plain)) : ''
    };
    if (cacheable) putBodyCache(cacheKey, entry);
    sendHit(entry, c, cacheHdr);
  };
  const setRlHeaders = rl => {
    res.setHeader('x-ratelimit-limit', String(rl.limit));
    res.setHeader('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) res.setHeader('retry-after', String(rl.resetSec));
  };
  try {
    if (FATAL.isShuttingDown() || isDraining) {
      return json({ ok: false, err: 'server sedang restart', shuttingDown: true }, 503);
    }
    let u;
    try { u = new URL(req.url, 'http://x'); }
    catch { return json({ ok: false, err: 'request URL tidak valid' }, 400); }
    routeTag = u.pathname;
    if (req.method === 'OPTIONS') {
      const optHdrs = openCors()
        ? {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'x-sitrep-token, content-type',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-max-age': '86400'
        }
        : { ...secHdr };
      res.writeHead(204, optHdrs);
      return res.end();
    }
    if (u.pathname === '/api/ping') return json({ ok: true, x: xHas(), mode: AUTH.userMode ? 'session' : (AUTH.publicMode ? 'public' : 'token'), classifierVersion: SOC.CLASSIFIER_VERSION });

    if (!TRUST_PROXY && req.headers &&
        (req.headers['cf-ray'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) {
      METRICS.proxyWarning = true;
      if (!runtimeProxyWarned) {
        runtimeProxyWarned = true;
        console.warn('[SECURITY WARNING] Request dengan header proxy/Cloudflare masuk, tetapi SITREP_TRUST_PROXY!=1 — semua pengunjung berisiko dihitung sebagai satu IP. Set SITREP_TRUST_PROXY=1 SITREP_TRUST_CF=1.');
      }
    }
    const clientIp = SEC.getClientIp(req, TRUST_PROXY);
    if (u.pathname === '/api/auth/login' && req.method === 'POST') {
      const rl = LIMITER.check('login', clientIp);
      setRlHeaders(rl);
      if (!rl.allowed) return json({ ok: false, err: 'terlalu banyak percobaan login, coba lagi nanti' }, 429);
      if (!AUTH.userMode) return json({ ok: false, err: 'autentikasi multi-user belum diaktifkan' }, 400);
      let body;
      try { body = await readJsonBody(req, 4096); } catch { return json({ ok: false, err: 'payload JSON tidak valid' }, 400); }
      const user = await AUTH.verifyPassword(body && body.username, body && body.password);
      if (!user) return json({ ok: false, err: 'username atau password salah' }, 401);
      const { token } = AUTH.signSession(user.username, user.role);
      res.setHeader('set-cookie', AUTH.sessionCookieHeader(req, token, 43200));
      return json({ ok: true, user });
    }
    if (u.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (!AUTH.isSameOriginPost(req, TRUST_PROXY)) return json({ ok: false, err: 'origin tidak valid' }, 403);
      const cookies = AUTH.parseCookies(req);
      if (cookies.sitrep_sess) AUTH.revokeToken(cookies.sitrep_sess);
      res.setHeader('set-cookie', AUTH.sessionCookieHeader(req, '', 0));
      return json({ ok: true });
    }
    const principal = AUTH.authenticate(req, u);
    if (u.pathname === '/api/auth/me') {
      return json({
        ok: true,
        mode: AUTH.userMode ? 'session' : (AUTH.publicMode ? 'public' : 'token'),
        user: principal ? { username: principal.username, role: principal.role, via: principal.via } : null
      });
    }

    if ((u.pathname === '/' || u.pathname === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (AUTH.userMode) return serveAuthenticatedHtml(req, res, principal);
      if (serveStatic(u.pathname, req, res)) return;
    }

    const gated = (u.pathname.startsWith('/api/') && u.pathname !== '/api/ping' && !u.pathname.startsWith('/api/auth/')) ||
      u.pathname === '/img' || u.pathname === '/hls' || u.pathname === '/vhs' ||
      u.pathname.startsWith('/tomtom/tile/');
    if (gated) {
      if (!principal) {
        return json({ ok: false, err: AUTH.userMode ? 'autentikasi diperlukan' : 'token tidak valid' }, AUTH.userMode ? 401 : 403);
      }
      const isHeavy = u.pathname === '/img' || u.pathname === '/hls' || u.pathname === '/vhs' ||
        u.pathname === '/api/thumb' || u.pathname === '/api/read' || Boolean(u.searchParams.get('fresh'));
      const cacheKeyFn = !isHeavy && (req.method === 'GET' || req.method === 'HEAD') ? CACHE_ROUTE_KEY[u.pathname] : null;
      const warmHit = cacheKeyFn ? bodyCache.get(cacheKeyFn(u)) : null;
      const warmCacheRule = (warmHit && Date.now() - warmHit.at < 30000) ? { limit: 3600, windowMs: 60000 } : undefined;
      // Operator/admin tidak ikut kuota pengunjung; cache-hit JSON dari RAM diberi kuota lebih longgar agar CGNAT massal tidak 429.
      const rl = LIMITER.check(isHeavy ? 'heavy' : 'api', clientIp, {
        exempt: AUTH.hasRole(principal, 'operator'),
        rule: warmCacheRule
      });
      setRlHeaders(rl);
      if (!rl.allowed) {
        return json({ ok: false, err: 'terlalu banyak request, coba lagi sebentar' }, 429);
      }
      if (principal.via === 'session' && req.method !== 'GET' && req.method !== 'HEAD' && !AUTH.isSameOriginPost(req, TRUST_PROXY)) {
        return json({ ok: false, err: 'origin tidak valid (CSRF)' }, 403);
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') { if (serveStatic(u.pathname, req, res)) return; }
    if (u.pathname === '/api/metrics') {
      if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      const mem = process.memoryUsage();
      return json({
        ok: true,
        mode: AUTH.userMode ? 'session' : (AUTH.publicMode ? 'public' : 'token'),
        uptimeSec: Math.round((Date.now() - METRICS.startedAt) / 1000),
        reqTotal: METRICS.reqTotal,
        cacheHits: METRICS.cacheHits,
        proxy: { trustProxy: TRUST_PROXY, trustCf: TRUST_CF, proxyWarning: METRICS.proxyWarning },
        rejected: { r403: METRICS.rejected403, r429: METRICS.rejected429, r503: METRICS.rejected503, outboundBlocked: METRICS.outboundBlocked },
        gateway: GW.stats(),
        caches: {
          memo: cache.size,
          userQuery: userQueryCache.size,
          bodyCount: bodyCache.size,
          bodyBytes: bodyCacheBytes(),
          readCache: readCache.size,
          thumbCache: thumbCache.size,
          descCache: descCache.size,
          ttTiles: ttTileCache.size,
          ttTileBytes: ttTileBytes(),
          knownNews: knownNewsUrls.size,
          knownVhs: knownVhsUrls.size,
        },
        memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
        routes: Object.fromEntries(METRICS.routes),
      });
    }
    if (u.pathname === '/api/news') {
      const nrKey = 'newsresp:v' + PIPELINE_VERSION;
      const newsCC = pubCC(25, 60, 10);
      if (u.searchParams.get('fresh')) {
        if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
        await refreshNewsNow();
        cache.delete(nrKey);
        bodyCache.delete(nrKey);
      } else if (u.searchParams.has('rev')) {
        const revRaw = u.searchParams.get('rev');
        const reqRev = /^\d+$/.test(String(revRaw || '')) ? Number(revRaw) : -1;
        if (reqRev >= 0 && (reqRev === NEWS_REV || newsRevSnapshots.has(reqRev))) {
          const dKey = 'newsdelta:v' + PIPELINE_VERSION + ':' + NEWS_REV + ':' + reqRev;
          if (sendCached(dKey, 25000, 200, newsCC)) return;
          if (reqRev === NEWS_REV) {
            return json({
              ok: true, delta: true, unchanged: true, rev: NEWS_REV,
              classifierVersion: SOC.CLASSIFIER_VERSION, pipelineVersion: PIPELINE_VERSION,
              at: Date.now()
            }, 200, dKey, 25000, newsCC, { stableAt: true });
          }
          const full = await buildNewsPayload();
          if (reqRev === full.rev) {
            const cKey = 'newsdelta:v' + PIPELINE_VERSION + ':' + full.rev + ':' + reqRev;
            return json({
              ok: true, delta: true, unchanged: true, rev: full.rev,
              classifierVersion: full.classifierVersion, pipelineVersion: full.pipelineVersion,
              at: Date.now()
            }, 200, cKey, 25000, newsCC, { stableAt: true });
          }
          const prevSigs = newsRevSnapshots.get(reqRev);
          if (prevSigs) {
            const changedSources = full.sources.filter(s => feedSig(s.items || []) !== prevSigs.get(s.id));
            const cKey = 'newsdelta:v' + PIPELINE_VERSION + ':' + full.rev + ':' + reqRev;
            return json({
              ok: true, delta: true, unchanged: changedSources.length === 0, rev: full.rev,
              classifierVersion: full.classifierVersion, pipelineVersion: full.pipelineVersion,
              sourceOrder: full.sources.map(s => s.id),
              changedSources,
              at: Date.now()
            }, 200, cKey, 25000, newsCC, { stableAt: true });
          }
        }
      }
      if (sendCached(nrKey, 25000, 200, newsCC)) return;
      const payload = await buildNewsPayload();
      return json(payload, 200, nrKey, 25000, newsCC, { stableAt: true });
    }
    if (u.pathname === '/api/breaking') {
      const cc = pubCC(15, 30, 5);
      const c = cache.get('breaking');
      if (c && c.v) {
        if (!c.p && Date.now() - c.at > 25000) breaking().catch(() => {});
        return json(c.v, 200, 'breaking', 12000, cc);  // stale-while-revalidate: marquee tidak nunggu feed
      }
      return json(await breaking(), 200, 'breaking', 12000, cc);
    }
    if (u.pathname === '/api/x') {
      const cc = pubCC(25, 60, 10);
      if (sendCached('x', 12000, 200, cc)) return;
      return json(socialResponse(await warmSocial('x', xposts, xHist), xHist, SOC.socKeepX), 200, 'x', 12000, cc, { stableAt: true });
    }
    if (u.pathname === '/api/xdiag') {   // bandingkan bentuk query: mana yang dapat hasil basi di host ini
      if (!AUTH.hasRole(principal, 'admin')) return json({ ok: false, err: 'akses ditolak (butuh role admin)' }, 403);
      const SQ = require('./social.js').socQueries('x', []); const tests = u.searchParams.get('all') ? SQ.map(e => e.q) : ['kebakaran', 'kebakaran lang:id', 'kebakaran -filter:replies', 'kebakaran lang:id -filter:replies', '(kebakaran OR damkar) lang:id -filter:replies', 'kebakaran since_time:' + Math.floor((Date.now() - 46 * 3600e3) / 1000)];
      const out = [];
      for (const q of tests) {
        try { const sv = Date.now; const r = await xSearch(q.replace(/ since_time:\d+/, '')); const n = r.posts.reduce((m, p) => Math.max(m, p.ts), 0);
          out.push({ q, n: r.posts.length, newest: n ? new Date(n).toISOString() : '-', ageH: n ? +((Date.now() - n) / 3600e3).toFixed(1) : null }); }
        catch (e) { out.push({ q, err: String(e.message).slice(0, 120) }); }
      }
      return json({ host: process.env.RAILWAY_ENVIRONMENT ? 'railway' : 'local', qid: X.query_id || 'auto', xAccounts: xPool.status(), out });
    }
    if (u.pathname === '/api/xq') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 60);
      if (AUTH.userMode ? !AUTH.hasRole(principal, 'operator') : ((!q || !topicOf(q)) && !AUTH.hasRole(principal, 'operator'))) {
        return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      }
      if (!q) return json({ ok: false, err: 'query kosong' });
      try { await xqLazy(q); bodyCache.delete('x'); return json(socialResponse({ ok: true }, xHist, SOC.socKeepX), 200, '', 0, pubCC(30, 60, 10)); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 200) }); }
    }
    if (u.pathname === '/api/thq') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 60);
      if (AUTH.userMode ? !AUTH.hasRole(principal, 'operator') : ((!q || !topicOf(q)) && !AUTH.hasRole(principal, 'operator'))) {
        return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      }
      if (!q) return json({ ok: false, err: 'query kosong' });
      try { await thqLazy(q); bodyCache.delete('threads'); return json(socialResponse({ ok: true }, tHist, SOC.socKeepTh), 200, '', 0, pubCC(30, 60, 10)); }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 200) }); }
    }
    if (u.pathname === '/api/thread') {
      const rawU = u.searchParams.get('u') || '';
      if (!AUTH.hasRole(principal, 'operator') && !isKnownThreadUrl(rawU)) {
        return json({ ok: false, err: 'thread tidak ada dalam feed aktif' }, 403);
      }
      try {
        const resTh = await threadOf(rawU);
        return json(resTh, 200, '', 0, resTh && resTh.ok ? pubCC(120, 240, 30) : 'no-store');
      }
      catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 220) }); }
    }
    if (u.pathname === '/api/threads') {
      const cc = pubCC(25, 60, 10);
      if (sendCached('threads', 12000, 200, cc)) return;
      return json(socialResponse(await warmSocial('threads', threads, tHist), tHist, SOC.socKeepTh), 200, 'threads', 12000, cc, { stableAt: true });
    }
    if (u.pathname === '/api/social/diagnostics') {
      const cc = pubCC(20, 40, 10);
      if (sendCached('socdiag', 15000, 200, cc)) return;
      const diagPayload = await memo('socdiag', 15000, async () => {
        const combined = [...xHist.values()].map(p => ({ ...p, from: 'X' })).concat([...tHist.values()].map(p => ({ ...p, from: 'Threads' })));
        return {
          ok: true,
          classifierVersion: SOC.CLASSIFIER_VERSION,
          diagnostics: SOC.diagnostics.snapshot(),
          dropStats: HISTORY.DROP_STATS,
          nlpAdapter: nlpAdapter.getStats(),
          clustersCount: SOC.clusterIncidents(combined).length,
          adhocTopics: ADHOC.map(a => a.id),
        };
      });
      return json(diagPayload, 200, 'socdiag', 15000, cc);
    }
    if (u.pathname === '/api/social/explain') {
      if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      let txt = u.searchParams.get('text') || '';
      if (req.method === 'POST') {
        try { const b = await readJsonBody(req, 8192); txt = String(b && b.text || txt); }
        catch (e) { return json({ ok: false, err: e.message === 'body terlalu besar' ? 'payload terlalu besar' : 'payload JSON tidak valid' }, e.message === 'body terlalu besar' ? 413 : 400); }
      }
      txt = String(txt).slice(0, 1500);
      if (!txt.trim()) return json({ ok: false, err: 'text wajib diisi' }, 400);
      return json({ ok: true, explanation: SOC.explainPost(txt, ADHOC) });
    }
    if (u.pathname === '/api/nodes') {
      if (sendCached('nodes', 86400e3, 200, 'public, max-age=86400')) return;
      return json({ ok: true, items: buildIncidentNodes(Date.now()), places: GEO.NODES.length }, 200, 'nodes', 86400e3, 'public, max-age=86400');
    }
    if (u.pathname === '/api/incidents') {
      const incCC = pubCC(15, 45, 5);
      if (u.searchParams.get('fresh')) {
        if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
        await refreshNewsNow();
        cache.delete('incidents');
        bodyCache.delete('incidents:all');
        bodyCache.delete('incidents:nonodes');
      }
      const noNodes = u.searchParams.get('nodes') === '0';
      const bKey = noNodes ? 'incidents:nonodes' : 'incidents:all';
      if (sendCached(bKey, 12000, 200, incCC)) return;
      const data = await incidents();
      if (noNodes) return json({ ...data, items: data.items.filter(i => !i.fixed), nodesOmitted: true }, 200, bKey, 12000, incCC);
      return json(data, 200, bKey, 12000, incCC);
    }
    if (u.pathname === '/api/situation') {
      const sitCC = pubCC(15, 45, 5);
      if (u.searchParams.get('fresh')) {
        if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
        await refreshNewsNow();
        cache.delete('situation');
        bodyCache.delete('situation');
      }
      if (sendCached('situation', 12000, 200, sitCC)) return;
      return json(await situation(), 200, 'situation', 12000, sitCC);
    }
    if (u.pathname === '/api/market') {
      const mktCC = pubCC(15, 45, 5);
      if (sendCached('market', 12000, 200, mktCC)) return;
      return json(await market(), 200, 'market', 12000, mktCC);
    }
    if (u.pathname === '/api/closes') {
      let list = (u.searchParams.get('list') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!AUTH.hasRole(principal, 'operator')) {
        list = list.filter(s => knownMarketSyms.has(s));
      }
      return json(await closes(list), 200, '', 0, pubCC(60, 180, 15));
    }
    if (u.pathname === '/api/flights') {
      const cc = pubCC(12, 30, 5);
      if (sendCached('flights', 10000, 200, cc)) return;
      return json({ ok: true, items: await flights(), at: Date.now() }, 200, 'flights', 10000, cc);
    }
    if (u.pathname === '/api/ships') {
      const cc = pubCC(12, 30, 5);
      if (sendCached('ships', 10000, 200, cc)) return;
      return json({ ok: true, items: await ships(), n: shipMap.size, live: !!(wsSock && !wsSock.destroyed), at: Date.now() }, 200, 'ships', 10000, cc);
    }
    if (u.pathname === '/api/transit') {
      const cc = pubCC(12, 30, 5);
      if (sendCached('transit', 12000, 200, cc)) return;
      return json({ ok: true, items: await transit(), at: Date.now() }, 200, 'transit', 12000, cc);
    }
    if (u.pathname === '/api/disaster') {
      const disCC = pubCC(60, 120, 15);
      if (u.searchParams.get('fresh')) {
        if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
        disCache.at = 0;
        bodyCache.delete('disaster');
      }
      if (sendCached('disaster', 30000, 200, disCC)) return;
      return json(await disaster(), 200, 'disaster', 30000, disCC);
    }
    if (u.pathname === '/api/weather') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('weather', 60000, 200, cc)) return;
      return json(await weather(), 200, 'weather', 60000, cc);
    }
    if (u.pathname === '/api/wind') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('wind', 60000, 200, cc)) return;
      return json(await windGrid(), 200, 'wind', 60000, cc);
    }
    if (u.pathname === '/api/fires') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('fires', 60000, 200, cc)) return;
      return json(await fires(), 200, 'fires', 60000, cc);
    }
    if (u.pathname === '/api/sipongi') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('sipongi', 60000, 200, cc)) return;
      return json(await sipongi(), 200, 'sipongi', 60000, cc);
    }
    if (u.pathname === '/api/satellite') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('satellite', 60000, 200, cc)) return;
      return json(await satelliteProducts(), 200, 'satellite', 60000, cc);
    }
    if (u.pathname === '/api/bmkg-modelrun') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('bmkgmr', 60000, 200, cc)) return;
      return json(await bmkgModelRun(), 200, 'bmkgmr', 60000, cc);
    }
    if (u.pathname === '/api/alerts') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('alerts', 60000, 200, cc)) return;
      return json(await alerts(), 200, 'alerts', 60000, cc);
    }
    if (u.pathname === '/api/radar') {
      const cc = pubCC(120, 300, 30);
      if (sendCached('radar', 60000, 200, cc)) return;
      return json(await radar(), 200, 'radar', 60000, cc);
    }
    if (u.pathname === '/api/cams') {
      const cc = pubCC(60, 120, 15);
      if (sendCached('cams', 30000, 200, cc)) return;
      return json(await alive(), 200, 'cams', 30000, cc);
    }
    if (u.pathname === '/api/cctv') {
      const cc = pubCC(60, 120, 15);
      if (sendCached('cctv', 30000, 200, cc)) return;
      return json(await cctvCatalog(), 200, 'cctv', 30000, cc);
    }
    if (u.pathname === '/api/cctv/stats') return json({ ok: true, gateway: GW.stats(), hosts: GW.rumStats(), cors: Object.fromEntries(hostCors), at: Date.now() }, 200, '', 0, pubCC(15, 30, 5));
    if (u.pathname === '/api/cctv/snap') return await GW.snap(u.searchParams.get('u') || '', req, res);
    if (u.pathname === '/api/cctv/rum' && req.method === 'POST') {
      try {
        const b = await readJsonBody(req, 20480);
        return json({ ok: true, n: GW.rumIngest(b, clientIp) });
      } catch (e) {
        return json({ ok: false, err: e.message === 'body terlalu besar' ? 'payload terlalu besar' : 'payload tidak valid' }, e.message === 'body terlalu besar' ? 413 : 400);
      }
    }
    if (u.pathname === '/api/cctv/report' && req.method === 'POST') {
      if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      try {
        const b = await readJsonBody(req, 4096);
        return json({ ok: GW.report(String((b && b.u) || ''), !!(b && b.ok), clientIp) });
      } catch (e) {
        return json({ ok: false, err: e.message === 'body terlalu besar' ? 'payload terlalu besar' : 'payload tidak valid' }, e.message === 'body terlalu besar' ? 413 : 400);
      }
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
      return await ttTile(m[1].toLowerCase(), m[2], m[3], m[4], res, req);
    }
    if (u.pathname === '/hls') return await hls(u.searchParams.get('u') || '', req, res);
    if (u.pathname === '/vhs') {
      const vUrl = u.searchParams.get('u') || '';
      if (!AUTH.hasRole(principal, 'operator') && !isKnownVhsUrl(vUrl)) {
        res.writeHead(403, { ...cors, 'x-content-type-options': 'nosniff' });
        return res.end('media tidak ada di feed aktif');
      }
      return await vhs(vUrl, req, res);
    }
    if (u.pathname === '/img') return await img(u.searchParams.get('u') || '', res);
    if (u.pathname === '/api/read') {
      const raw = u.searchParams.get('u') || '';
      // bg=1: panggilan background (lead image fallback, prefetch) — tidak
      // menaikkan rdActive (tanpa prioritas media), Jina antrean normal, dan
      // kegagalan TIDAK menulis neg-cache supaya tidak meracuni klik user.
      const bg = u.searchParams.get('bg') === '1';
      if (u.searchParams.get('fresh') && !AUTH.hasRole(principal, 'operator')) {
        return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      }
      if (!AUTH.hasRole(principal, 'operator') && !isKnownNewsUrl(raw)) {
        return json({ ok: false, err: 'artikel tidak ada dalam feed aktif', transient: false }, 403);
      }
      const fresh = !bg && u.searchParams.get('fresh') === '1';
      const canonFail = MEDIA.canonicalArticleUrl(raw) || raw;
      const fh = !fresh && (readFail.get(canonFail) || readFail.get(raw));
      if (fh && Date.now() - fh.at < (fh.ttl || READ_FAIL_TTL))
        return json({ ok: false, err: fh.err, transient: Boolean(fh.transient), cached: true });
      const cachedRead = !fresh && (getReadCache(canonFail, raw) || getReadCache(MEDIA.canonicalArticleUrl(raw), raw));
      if (!cachedRead && !AUTH.hasRole(principal, 'operator') && !outboundScrapeRl.check('outbound', 'global').allowed) {
        METRICS.outboundBlocked++;
        return json({ ok: false, err: 'antrean scrape penuh sementara — buka sumber langsung', transient: true }, 503);
      }
      if (!bg) rdActive++;
      try {
        const d = await rdRead(raw, bg, fresh);
        readFail.delete(raw);
        if (canonFail !== raw) readFail.delete(canonFail);
        const cc = (d && d.ok && !d.thin && !d.isFallback && !d.wireFallback) ? pubCC(300, 600, 30) : 'no-store';
        return json(d, 200, '', 0, cc);
      } catch (e) {
        if (e && e.status === 503) return json({ ok: false, err: e.message, transient: true }, 503);
        const msg = String(e.message || e).slice(0, 400);
        const transient = !(e && e.transient === false);
        const ttl = transient ? READ_FAIL_TRANSIENT_TTL : READ_FAIL_PERM_TTL;
        let h = ''; try { h = new URL(raw).hostname; } catch (_) {}
        console.log('[read]' + (bg ? ' bg' : '') + ' FAIL', h || '-', msg.slice(0, 160));
        if (!bg) {
          const entry = { at: Date.now(), ttl, err: msg, transient };
          readFail.set(raw, entry);
          if (canonFail !== raw) readFail.set(canonFail, entry);
          lruCap(readFail, 300);
        }
        const out = { ok: false, err: msg, transient };
        if (e && e.attempts) out.attempts = e.attempts;
        return json(out);
      } finally { if (!bg) rdActive--; }
    }
    if (u.pathname === '/api/thumb') {
      const tUrl = u.searchParams.get('u') || '';
      if (!AUTH.hasRole(principal, 'operator') && !isKnownNewsUrl(tUrl)) {
        return json({ ok: false, err: 'artikel tidak ada dalam feed aktif', transient: false, schemaVersion: PIPELINE_VERSION }, 403);
      }
      rdActive++;
      try {
        const resThumb = await thumb(tUrl);
        return json({ ok: true, ...resThumb }, 200, '', 0, resThumb.verified ? pubCC(300, 600, 30) : 'no-store');
      }
      catch (e) {
        if (e && e.status === 503) return json({ ok: false, err: e.message, transient: true, schemaVersion: PIPELINE_VERSION }, 503);
        const msg = String(e.message || e).slice(0, 160);
        return json({ ok: false, err: msg, transient: !/url tidak valid/i.test(msg), schemaVersion: PIPELINE_VERSION });
      }
      finally { rdActive--; }
    }
    if (u.pathname === '/api/desc') {
      // desc untuk kartu feed yang desc RSS-nya kosong — dipanggil client lazy per kartu terlihat.
      // GET ?url=<satu> ; POST {urls:[...]} maks 8.
      try {
        let urls = [];
        if (req.method === 'POST') {
          let b = {};
          try { b = await readJsonBody(req, 8192); }
          catch (e) {
            if (e && e.message === 'body terlalu besar') return json({ ok: false, err: 'payload terlalu besar' }, 413);
            b = {};
          }
          urls = (b && b.urls) || [];
        } else {
          const single = u.searchParams.get('url');
          if (single) urls = [single];
        }
        const isOp = AUTH.hasRole(principal, 'operator');
        urls = (Array.isArray(urls) ? urls : [])
          .map(v => String(v || '').trim())
          .filter(v => /^https?:\/\//i.test(v) && (isOp || isKnownNewsUrl(v)))
          .slice(0, DESC_MAX_PER_CALL);
        const descs = {};
        const retryable = {};
        const queue = [];
        for (const url of urls) {
          const hit = descGet(url);
          if (hit !== undefined) {
            descs[url] = hit;
            if (!hit) {
              const ent = descGetEntry(url);
              if (!ent || ent.transient) retryable[url] = true;
            }
          } else {
            queue.push(url);
          }
        }
        if (queue.length && !isOp && !outboundScrapeRl.check('outbound', 'global').allowed) {
          METRICS.outboundBlocked++;
          for (const url of queue) { descs[url] = ''; retryable[url] = true; }
          return json({ ok: true, descs, retryable, throttled: true });
        }
        // 4 worker paralel — descForUrl sudah mengantre per-host (gap host),
        // jadi URL sehost tetap sopan sementara host berbeda jalan bersamaan
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length) {
            const url = queue.shift();
            try {
              const d = await descForUrl(url);
              descs[url] = d;
              if (!d) {
                const ent = descGetEntry(url);
                if (!ent || ent.transient) retryable[url] = true;
              }
            } catch (e) {
              descs[url] = '';
              retryable[url] = true;
            }
          }
        }));
        return json({ ok: true, descs, retryable });
      } catch (e) { return json({ ok: true, descs: {}, retryable: {} }); }
    }
    res.writeHead(404); res.end();
  } catch (e) { if (!res.headersSent) json({ ok: false, err: String(e.message || e) }, 502); else res.end(); }
});
// Di belakang proxy Railway/LB: keep-alive Node (5s) lebih pendek dari idle proxy → 502 sporadis.
SITREP_SERVER.keepAliveTimeout = 65000; SITREP_SERVER.headersTimeout = 66000;
SITREP_SERVER.requestTimeout = 90000; SITREP_SERVER.maxRequestsPerSocket = 1000;
global.__sitrepServer = SITREP_SERVER;
// listen gagal (EADDRINUSE/EACCES) keluar dengan kode 78 agar supervisor tidak spin loop
SITREP_SERVER.on('error', e => {
  console.error('[fatal] server error:', e && e.message);
  try { histFlushAll(); } catch {}
  process.exit(e && (e.code === 'EADDRINUSE' || e.code === 'EACCES') ? 78 : 1);
});
async function warmNewsSnapshots() {
  await yieldTick();
  const rs = await news();
  await yieldTick();
  const [incData, sitData, brData, newsData] = await Promise.all([
    incidents().catch(() => null),
    situation().catch(() => null),
    breaking().catch(() => null),
    buildNewsPayload().catch(() => null),
  ]);
  await yieldTick();
  if (newsData) prewarmJson('newsresp:v' + PIPELINE_VERSION, newsData, { stableAt: true });
  await yieldTick();
  if (incData) prewarmJson('incidents:all', incData);
  await yieldTick();
  if (sitData) prewarmJson('situation', sitData);
  if (brData) prewarmJson('breaking', brData);
  cache.delete('newsheat');
  cache.delete('trending');
  await Promise.allSettled([newsTopicHeat(), adhocRefresh()]);
  return { rs, incData, sitData };
}
if (require.main === module) {
  SITREP_SERVER.listen({ port: Number(PORT) || 8787, backlog: 1024 }, () => {
    const modeLbl = AUTH.userMode ? ' [session-auth]' : (AUTH.publicMode ? ' [public-osint]' : ' [local-token]');
    console.log('SITREP jalan di http://localhost:' + PORT + modeLbl + (xHas() ? ' (X pool: ' + xPool.size() + ' akun)' : '  (X: cookie belum diisi)'));
    const diskIntelBoot = Promise.allSettled([newsTopicHeat(), adhocRefresh()]);
    SEC.runIsolated('threadsWarm', async () => {
      await diskIntelBoot;
      const r = await threads();
      if (r) prewarmJson('threads', socialResponse(r, tHist, SOC.socKeepTh), { stableAt: true });
      console.log('Threads warm: ' + r.posts.length + ' post');
    });
    SEC.runIsolated('newsWarm', async () => {
      const { rs, incData, sitData } = await warmNewsSnapshots();
      console.log('News warm: ' + rs.filter(s => s.ok).length + '/' + rs.length + ' feed' +
        (incData ? ' · peta ' + incData.items.length + ' titik' : '') +
        (sitData ? ' · situasi ' + sitData.total : ''));
    });
    SEC.runIsolated('xpostsWarm', async () => {
      await diskIntelBoot;
      const r = await xposts();
      if (r) prewarmJson('x', socialResponse(r, xHist, SOC.socKeepX), { stableAt: true });
      console.log('X warm: ' + r.posts.length + ' post' + (r.err ? ' | err: ' + String(r.err).slice(0, 160) : ''));
    });
    SEC.runIsolated('disasterWarm', async () => { const r = await disaster(); if (r) prewarmJson('disaster', r); });
    SEC.runIsolated('marketWarm', async () => { const r = await market(); if (r) prewarmJson('market', r); });
    // Clock-driven collector sweep: snapshot & Brotli dihangatkan di background tanpa stall request pengunjung
    setInterval(() => SEC.runIsolated('newsCollect', warmNewsSnapshots), 50000).unref();
    setInterval(() => SEC.runIsolated('marketCollect', async () => { const r = await market(); if (r) prewarmJson('market', r); }), 45000).unref();
    setInterval(() => SEC.runIsolated('socialCollect', async () => {
      const [xr, tr] = await Promise.allSettled([xposts(), threads()]);
      if (xr.status === 'fulfilled' && xr.value) prewarmJson('x', socialResponse(xr.value, xHist, SOC.socKeepX), { stableAt: true });
      if (tr.status === 'fulfilled' && tr.value) prewarmJson('threads', socialResponse(tr.value, tHist, SOC.socKeepTh), { stableAt: true });
    }), 240000).unref();
    setInterval(() => SEC.runIsolated('disasterCollect', async () => { const r = await disaster(); if (r) prewarmJson('disaster', r); }), 120000).unref();
    setTimeout(() => SEC.runIsolated('warmCctvInit', () => warmCctv()), 20000).unref();
    setInterval(() => SEC.runIsolated('warmCctvTick', () => warmCctv()), 1800000).unref();
  });
}

module.exports = {
  SITREP_SERVER,
  AUTH,
  NEWS,
  PIPELINE_VERSION,
  parseFeed,
  news,
  refreshNewsNow,
  incidents,
  situation,
  mergeNewsHist,
  loadNewsHist,
  newsHistByFeed,
  invalidateDerivedFromNews,
  rdRead,
  thumb,
  descForUrl,
  decodeGNews,
  mediaCacheGet,
  mediaCacheSet,
  getReadCache,
  setReadCache,
  assetReuse,
  readCache,
  readFail,
  thumbCache,
  probeCache,
  descCache,
  cache,
  bodyCache,
  gnCache,
  urlToCanon,
  rdWireFind,
  rdWireImg,
  rdWireRssImgs,
  rdAssembleBlocks,
  rdFinish,
  WORLD_IDX,
  COMMODITIES,
  downsampleCloses,
  cnbcSymbolFor,
  fetchSymbolCloses,
  closes,
  market,
  worldIndex,
  closeMemo,
  setMarketFetch,
  sanitizeHopHeaders,
  projectAssessment,
  makeSem,
  singleFlight,
  METRICS,
  ttTileCache,
  knownNewsUrls,
  knownVhsUrls,
};
