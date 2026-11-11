'use strict';
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
const COPERNICUS = require('./copernicus');
const XPOOL = require('./xpool');
const GEO = require('./geocode');
const EVM = require('./evmerge');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

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

try {
  const secretHits = [];
  const scan = (o, p) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const key = (p ? p + '.' : '') + k;
      if (/token|secret|key|cookie|auth|session|ct0|csrftoken|ds_user|password/i.test(k) && typeof v === 'string' && v) secretHits.push(key);
      else if (v && typeof v === 'object') scan(v, key);
    }
  };
  scan(CFG, '');
  if (secretHits.length) {
    console.error('[SECURITY WARNING] config.json berisi field yang menyerupai credential: ' + secretHits.join(', ') + '. File ini tracked di git — pindahkan nilainya ke env/.env lalu kosongkan field tersebut.');
  }
} catch (e) {}

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
const isLoopbackHost = h => /^(127(?:\.\d{1,3}){3}|::1|localhost)$/i.test(String(h || '').trim());
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
  tokenRole: process.env.SITREP_TOKEN_ROLE || (isPublicDeploy ? 'operator' : 'admin'),
  trustProxy: TRUST_PROXY,
  publicDeploy: isPublicDeploy
});

const BIND_HOST = process.env.SITREP_HOST || process.env.BIND_HOST || ((AUTH.publicMode || AUTH.userMode) ? '0.0.0.0' : '127.0.0.1');
const LIMITER = SEC.createRateLimiter();

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
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HTML = path.join(__dirname, 'public', 'index.html');
const HIST_DIR = process.env.SITREP_DATA_DIR || path.join(__dirname, 'data');

const cache = new Map();
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
const etagStable = buf => {
  if (buf.length > 12 << 20) return etagOf(buf);
  const norm = buf.toString('latin1').replace(/,"at":\d+/g, ',"at":0');
  return etagOf(Buffer.from(norm, 'latin1'));
};
const yieldTick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

const memoRetry = new Map();
const MEMO_CAP = 800;
const lruCap = (m, cap) => { while (m.size > cap) m.delete(m.keys().next().value); };
const userQueryCache = new Map();
const USER_QUERY_CAP = 400;
const isUserQueryKey = k => /^(?:tt:|xq:|thq:|xth:|thth:|yt:)/.test(k);
const cacheStoreFor = k => isUserQueryKey(k) ? userQueryCache : cache;
const cacheCapFor = k => isUserQueryKey(k) ? USER_QUERY_CAP : MEMO_CAP;

const memo = (k, ttl, fn, good) => {
  const isGood = good || (() => true);
  const store = cacheStoreFor(k);
  const cap = cacheCapFor(k);
  const kick = () => {
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
    const bad = !isGood(v);
    store.set(k, { at: bad ? Date.now() - ttl + 20000 : Date.now(), v }); lruCap(store, cap);
    if (bad) {
      const n = (memoRetry.get(k) || 0) + 1;
      memoRetry.set(k, n); lruCap(memoRetry, MEMO_CAP);
      if (n <= 5) setTimeout(kick, Math.min(90000, 15000 * n)).unref();
    } else memoRetry.delete(k);
    return v;
  };
  const c = store.get(k);
  if (c && c.v !== undefined) {
    store.delete(k); store.set(k, c);
    if (Date.now() - c.at < ttl) return Promise.resolve(c.v);
    kick();
    return Promise.resolve(c.v);
  }
  if (c && c.p) { store.delete(k); store.set(k, c); return c.p; }
  const p = fn().then(v => accept(v),
    e => { store.delete(k); memoRetry.delete(k); throw e; });
  store.set(k, { at: 0, v: undefined, p }); lruCap(store, cap);
  return p;
};

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

function cacheFail(cObj, ttl, data) {
  const bad = !data || data.ok === false;
  if (bad && cObj.data && cObj.data.ok) {
    cObj.at = Date.now() - ttl + 30000;
    return cObj.data;
  }
  cObj.at = bad ? (Date.now() - ttl + 30000) : Date.now();
  cObj.data = data;
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

async function get(url, opt = {}, ms = 10000) {
  return await SEC.safeFetch(url, { ...opt, trustedRoots: TRUSTED_ROOTS }, ms);
}

const openCors = () => !AUTH.userMode && !AUTH.publicMode;

const {
  LAT_BUCKETS,
  eventLoopDelay,
  quantileFromHist,
  METRICS,
  originBytesPerSec,
  metricInc,
  recordRequestMetric,
  recordUpstream,
} = require('./src/metrics').createMetricsService();

let newsSvc = null;
const readerSvc = require('./src/reader-service').createReaderService({
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
  isBannedHostUrl: u => newsSvc ? newsSvc.isBannedHostUrl(u) : false,
});

const {
  thumbCache,
  urlToCanon,
  gnCache,
  probeCache,
  verifiedProxyImgs,
  knownNewsUrls,
  knownVhsUrls,
  registerNewsUrl,
  isKnownNewsUrl,
  isKnownVhsUrl,
  probeImage,
  decodeGNews,
  docCache,
  DOC_CACHE_MAX_BYTES,
  docCacheGet,
  docCacheSet,
  getDocCacheBytes,
  fcBlocked,
  fcFailMark,
  mediaCacheGet,
  mediaCacheSet,
  thumb,
  img,
  vhs,
  cctvFirecrawl,
  sanitizeHopHeaders,
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
} = readerSvc;

newsSvc = require('./src/news-service').createNewsService({
  fs,
  path,
  HIST_DIR,
  CFG,
  SOC,
  ASSESS,
  FEEDTEXT,
  MEDIA,
  GEO,
  EVM,
  PIPELINE_VERSION,
  assetReuse,
  cache,
  bodyCache,
  memo,
  makeSem,
  get,
  sleep,
  yieldTick,
  registerNewsUrl,
  recordUpstream,
  urlToCanon,
  mediaCacheGet,
});

const {
  NEWS,
  isBannedHostUrl,
  isBannedNewsItem,
  parseFeed,
  feedSig,
  loadNewsHist,
  mergeNewsHist,
  newsHistByFeed,
  saveNewsHist,
  invalidateDerivedFromNews,
  rssSem,
  getFeedHealthSummary,
  refreshNewsNow,
  news,
  CATS,
  SKIP_RE,
  projectAssessment,
  resolveCategory,
  breakNorm,
  breaking,
  buildIncidentNodes,
  incidents,
  situation,
  buildNewsPayload,
  newsRevSnapshots,
  getNewsRev,
  getNewsHeatRev,
  incNewsHeatRev,
} = newsSvc;

const socialSvc = require('./src/social-service').createSocialService({
  fs,
  path,
  rootDir: __dirname,
  HIST_DIR,
  CFG,
  SOC,
  HISTORY,
  FEEDTEXT,
  GEO,
  XPOOL,
  nlpAdapter,
  cache,
  userQueryCache,
  memo,
  makeSem,
  get,
  sleep,
  publicURL: SEC.publicURL,
  news,
  NEWS,
  newsHistByFeed,
  CATS,
  SKIP_RE,
  breakNorm,
  projectAssessment,
  getNewsRev,
  getNewsHeatRev,
  incNewsHeatRev,
});

const {
  xHist,
  tHist,
  flushSocialHist,
  X,
  xPool,
  xHas,
  xSearch,
  adhocRefresh,
  getAdhoc,
  topicOf,
  newsTopicHeat,
  xposts,
  xqLazy,
  threads,
  thqLazy,
  socialResponse,
  warmSocial,
  threadOf,
  isKnownThreadUrl,
} = socialSvc;

const {
  setMarketFetch,
  WORLD_IDX,
  COMMODITIES,
  downsampleCloses,
  cnbcSymbolFor,
  fetchSymbolCloses,
  closes,
  market,
  worldIndex,
  closeMemo,
  saveMktCloses,
  knownMarketSyms,
} = require('./src/market').createMarketService({
  fs,
  path,
  HIST_DIR,
  UA,
  get,
  memo,
});

let isDraining = false;
let stopAis = null;
const {
  flights,
  disaster,
  disCache,
  weather,
  radar,
  tmaPintuAir,
  fires,
  sipongi,
  bmkgModelRun,
  satelliteProducts,
  windGrid,
  alerts,
  ships,
  shipMap,
  stopAis: _stopAis,
  isAisLive,
  transit,
} = require('./src/geo-sensors').createGeoSensors({
  crypto,
  UA,
  SEC,
  TRUSTED_ROOTS,
  get,
  mediaGet,
  mediaText,
  singleFlight,
  cacheFail,
  sleep,
  isDraining: () => isDraining,
  isMain: require.main === module,
});
stopAis = _stopAis;

const histFlushAll = () => {
  flushSocialHist(true);
  saveNewsHist(true);
  if (typeof saveMktCloses === 'function') saveMktCloses(true);
};

const histFlushTimer = setInterval(() => {
  SEC.runIsolated('histFlush', () => {
    flushSocialHist(false);
    saveNewsHist(false);
  });
}, 30000);
if (histFlushTimer.unref) histFlushTimer.unref();

function stopBackgroundInfra() {
  isDraining = true;
  if (typeof stopAis === 'function') stopAis();
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
  FATAL.install(process);
}

const cctvHostList = () => (CFG.cctv_hosts || ['balitower.co.id', 'jakarta.go.id', 'molecool.id', 'pantaucctv.com', 'ptbtu.com', 'dpuprkotang.info']).concat(CFG.tv_hosts || []);
const SHARED_CDN_SUFFIX = /^(?:cloudfront\.net|akamaized\.net|edgesuite\.net|edgespeed\.net|cloudflarestream\.com|tenbytecdn\.com|bytecdn\.cn|hwcdn\.net|cdngslb\.com|llnwd\.net|edgesuite\.net)$/i;
const catalogHosts = new Set();
const catalogHostAdd = h => {
  if (!h || catalogHosts.has(h)) return;
  catalogHosts.add(h);
  if (catalogHosts.size > 800) catalogHosts.delete(catalogHosts.values().next().value);
};
const hostOK = u => {
  try {
    const h = new URL(u).hostname;
    if (catalogHosts.has(h)) return true;
    return cctvHostList().some(d => h === d || (!SHARED_CDN_SUFFIX.test(d) && h.endsWith('.' + d)));
  } catch (e) { return false; }
};
const isTvHost = u => { try { const h = new URL(u).hostname; return (CFG.tv_hosts || []).some(d => h === d || h.endsWith('.' + d)); } catch (e) { return false; } };

const px = u => {
  try { catalogHostAdd(new URL(u).hostname); } catch (e) {}
  return (AUTH.userMode || AUTH.publicMode)
    ? ('/hls?u=' + encodeURIComponent(u))
    : ('/hls?u=' + encodeURIComponent(u) + '&token=' + encodeURIComponent(API_TOKEN));
};

function cctvHeaders(u) {
  const mh = (() => { try { return new URL(u).hostname; } catch (e) { return ''; } })();
  if (isTvHost(u)) return { 'user-agent': UA };
  if (/(^|\.)molecool\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://molecool.id/', origin: 'https://molecool.id' };
  if (/(^|\.)pantaucctv\.com$/i.test(mh)) return { 'user-agent': UA, referer: 'https://pantaucctv.com/', origin: 'https://pantaucctv.com' };
  if (/(^|\.)jogjakota\.go\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://cctv.jogjakota.go.id/' };
  if (/(^|\.)bpjt\.pu\.go\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://bpjt.pu.go.id/' };
  if (/(^|\.)jakarta\.go\.id$|(^|\.)balitower\.co\.id$/i.test(mh)) return { 'user-agent': UA, referer: 'https://smartcity.jakarta.go.id/', origin: 'https://smartcity.jakarta.go.id' };
  if (/(^|\.)dpuprkotang\.info$/i.test(mh)) return { 'user-agent': UA, referer: 'https://cctv.dpuprkotang.info/' };
  return { 'user-agent': UA };
}

let moleFreshFn = null;
async function cctvRewrite(u) {
  try {
    const hu = new URL(u);
    if (/^cctv\.molecool\.id$/i.test(hu.hostname)) {
      const slug = hu.pathname.split('/').filter(Boolean)[0];
      const tok = slug && moleFreshFn && await moleFreshFn(slug);
      if (tok) { hu.searchParams.set('token', tok); return hu.href; }
    }
  } catch (e) {}
  return u;
}
const cctvKnown = new Set();
const isMacGwProfile = process.env.SITREP_MAC_PROFILE === '1' || (AUTH.publicMode && process.platform === 'darwin');
const envPosInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const GW_OPTIONS = {
  maxActive: envPosInt('SITREP_HLS_MAX_ACTIVE', isMacGwProfile ? 10 : 48),
  perHost: envPosInt('SITREP_HLS_PER_HOST', isMacGwProfile ? 3 : 8),
  maxQueue: envPosInt('SITREP_HLS_MAX_QUEUE', 64),
  snapActive: envPosInt('SITREP_HLS_SNAP_ACTIVE', 2),
  snapMaxQueue: envPosInt('SITREP_HLS_SNAP_QUEUE', 16),
  globalByteRate: envPosInt('SITREP_HLS_GLOBAL_BPS', (isMacGwProfile ? 6 : 45) << 20),
  globalByteBurst: envPosInt('SITREP_HLS_GLOBAL_BURST', (isMacGwProfile ? 20 : 180) << 20),
  segCacheBytes: envPosInt('SITREP_HLS_CACHE_BYTES', (isMacGwProfile ? 32 : 64) << 20),
};
const GW = require('./cctv-gateway').createGateway({
  getRaw: mediaGetRaw, hostAllowed: hostOK, headersFor: cctvHeaders, rewriteUrl: cctvRewrite, px,
  trustProxy: Boolean(TRUST_PROXY),
  allowCors: openCors(),
  allowPublicCache: Boolean(AUTH.publicMode),
  getClientIp: (req, tp) => SEC.getClientIp(req, tp),
  rateKey: SEC.rateKey,
  isKnownHost: h => hostOK('https://' + h + '/'),
  isKnown: u => cctvKnown.has(u),
  options: GW_OPTIONS
});

try {
  const htmlSrc = fs.readFileSync(HTML, 'utf8');
  const tvBlock = (htmlSrc.match(/const TV_CH = \[([\s\S]*?)\];/) || [])[1] || '';
  for (const m of tvBlock.matchAll(/s:'(https?:\/\/[^']+)'/g)) {
    try { catalogHostAdd(new URL(m[1]).hostname); } catch (e) {}
  }
} catch (e) {}
const hls = (u, req, res) => GW.hls(u, req, res);

let camListC = { m: 0, v: [] };
const camList = () => { try { const m = fs.statSync(HTML).mtimeMs; if (m !== camListC.m) camListC = { m, v: JSON.parse(fs.readFileSync(HTML, 'utf8').match(/id="cam-data">([\s\S]*?)<\/script>/)[1]) }; return camListC.v; } catch (e) { return camListC.v; } };
function seedStaticCctvAllowlist() {
  for (const c of camList()) {
    cctvKnown.add(c.s);
    if (c.snap) cctvKnown.add(c.snap);
    (Array.isArray(c.fb) ? c.fb : c.fb ? [c.fb] : []).forEach(f => cctvKnown.add(f));
    try { catalogHostAdd(new URL(c.s).hostname); } catch (e) {}
  }
}
seedStaticCctvAllowlist();
const alive = () => memo('alive', 150000, async () => {
  const cams = camList(), res = new Array(cams.length).fill(false); let i = 0;
  await Promise.all(Array.from({ length: 12 }, async () => { while (i < cams.length) { const k = i++;
    if (/(jakcctv\.jakarta\.go\.id|pantaucctv\.com|molecool\.id|dpuprkotang\.info|\.mp4(\?|$))/i.test(cams[k].s)) { res[k] = true; continue; }
    try { const r = await get(cams[k].s, { headers: { referer: 'https://smartcity.jakarta.go.id/' } }, 6000);
      res[k] = r.ok && (await r.text()).includes('#EXTM3U'); } catch (e) {} } }));
  return { alive: res, at: Date.now() };
});

const {
  moleFresh,
  cctvCatalog,
  warmCctv,
  hostCors,
} = require('./src/cctv-catalog').createCctvCatalog({
  UA,
  CFG,
  GW,
  cache,
  bodyCache,
  memo,
  mediaGet,
  mediaGetRaw,
  mediaText,
  mediaBody,
  rdAssertPublic: SEC.rdAssertPublic,
  cctvFirecrawl,
  camList,
  cctvKnown,
  catalogHostAdd,
  isDraining: () => isDraining,
});
moleFreshFn = moleFresh;

const {
  ttHas,
  ttFlow,
  ttIncidents,
  ttRoute,
  ttTileCache,
  ttTileBytes,
  ttTile,
} = require('./src/tomtom').createTomTomService({
  crypto,
  TOMTOM_KEY,
  AUTH,
  METRICS,
  memo,
  mediaGet,
  mediaText,
  mediaBody,
  recordUpstream,
  openCors,
});

const copernicus = COPERNICUS.createCopernicusProxy({
  dataDir: HIST_DIR,
  clientId: process.env.CDSE_CLIENT_ID || process.env.COPERNICUS_CLIENT_ID || '',
  clientSecret: process.env.CDSE_CLIENT_SECRET || process.env.COPERNICUS_CLIENT_SECRET || '',
  dailyCap: process.env.CDSE_DAILY_CAP,
  monthCap: process.env.CDSE_MONTH_CAP,
  cacheTtlMs: process.env.CDSE_CACHE_TTL_MS,
  maxCacheBytes: process.env.CDSE_CACHE_MAX_BYTES,
  lookbackDays: process.env.CDSE_LOOKBACK_DAYS,
  fetchFn: get,
});

const VERSIONED_JS_FILES = ['signals.js', 'wxicons.js', 'wire-core.js', 'cctv-core.js'];
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
function getAssetVersionMap() {
  const sigParts = [];
  const entries = [];
  for (const name of VERSIONED_JS_FILES) {
    const f = path.join(__dirname, 'public', name);
    try {
      const st = fs.statSync(f);
      sigParts.push(name + ':' + st.mtimeMs + ':' + st.size);
      entries.push([name, f, st]);
    } catch {}
  }
  const sig = sigParts.join('|');
  const cached = staticCache.get('vermap');
  if (cached && cached.sig === sig) return cached.map;
  const map = new Map();
  for (const [name, f] of entries) {
    const buf = fs.readFileSync(f);
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    map.set(name, { hash, versioned: name.replace(/\.js$/, '.' + hash + '.js') });
  }
  staticCache.set('vermap', { sig, map });
  return map;
}
function rewriteHtmlAssetRefs(html) {
  const map = getAssetVersionMap();
  let out = html;
  for (const [name, info] of map) {
    out = out.replace(new RegExp('<script src="' + name.replace(/\./g, '\\.') + '"><\\/script>', 'g'),
      `<script src="${info.versioned}"></script>`);
  }
  return out;
}
function readIndexRaw() {
  const file = path.join(__dirname, 'public', 'index.html');
  const st = fs.statSync(file);
  const vMap = getAssetVersionMap();
  const verSig = [...vMap.values()].map(v => v.hash).join(':');
  const key = 'raw:' + file;
  let e = staticCache.get(key);
  if (e && e.mtime === st.mtimeMs && e.size === st.size && e.verSig === verSig) return e.html;
  const html = rewriteHtmlAssetRefs(fs.readFileSync(file, 'utf8'));
  staticCache.set(key, { mtime: st.mtimeMs, size: st.size, verSig, html });
  return html;
}
function staticEntry(pathname) {
  let def = STATIC_FILES[pathname] || null;
  let immutableHash = '';
  if (!def) {
    const vm = String(pathname || '').match(/^\/(signals|wxicons|wire-core|cctv-core)\.([a-f0-9]{8})\.js$/);
    if (vm) {
      const baseName = vm[1] + '.js';
      const info = getAssetVersionMap().get(baseName);
      if (info && info.hash === vm[2]) {
        def = [baseName, 'application/javascript; charset=utf-8', 'public, max-age=31536000, immutable'];
        immutableHash = info.hash;
      }
    }
  }
  if (!def) return null;
  if (def[0] === 'index.html' && AUTH.userMode) return null;
  const file = path.join(__dirname, 'public', def[0]);
  let st; try { st = fs.statSync(file); } catch (e) { return null; }
  const htmlPublicCC = (def[0] === 'index.html' && AUTH.publicMode)
    ? 'public, max-age=30, stale-while-revalidate=300'
    : def[2];
  const vSig = def[0] === 'index.html' ? [...getAssetVersionMap().values()].map(v => v.hash).join(':') : '';
  const cacheKey = immutableHash ? (file + '#immutable:' + immutableHash) : (file + ':' + htmlPublicCC + ':' + vSig);
  let e = staticCache.get(cacheKey);
  if (e && e.mtime === st.mtimeMs && e.size === st.size) return e;
  let buf = fs.readFileSync(file);
  if (def[0] === 'index.html') {
    buf = Buffer.from(AUTH.injectHtmlMeta(rewriteHtmlAssetRefs(buf.toString('utf8')), null));
  }
  const big = buf.length > 1024 && !/svg|png|jpe?g/.test(def[1]) || def[1] === 'image/svg+xml' && buf.length > 1024;
  e = { mtime: st.mtimeMs, size: st.size, buf, type: def[1], cc: htmlPublicCC,
    etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 16) + '"',
    br: big ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : null,
    gz: big ? zlib.gzipSync(buf, { level: 6 }) : null };
  staticCache.set(cacheKey, e);
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
  if (req.headers['if-none-match'] === e.etag) {
    METRICS.cacheHits++;
    metricInc(pathname, 304);
    res.writeHead(304, h); res.end(); return true;
  }
  const ae = String(req.headers['accept-encoding'] || '');
  let body = e.buf;
  if (e.br && /\bbr\b/.test(ae)) { body = e.br; h['content-encoding'] = 'br'; }
  else if (e.gz && /\bgzip\b/.test(ae)) { body = e.gz; h['content-encoding'] = 'gzip'; }
  h['content-length'] = body.length;
  METRICS.cacheHits++;
  metricInc(pathname, 200);
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
  '/api/tma': () => 'tma_pintu_air',
  '/api/pintu-air': () => 'tma_pintu_air',
};
let runtimeProxyWarned = false;
let rdActive = 0;

const SITREP_SERVER = http.createServer(async (req, res) => {
  const reqStartNs = process.hrtime.bigint();
  let reqBytesOut = 0;
  let routeWasCacheHit = false;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk) reqBytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return origWrite(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk && typeof chunk !== 'function') reqBytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return origEnd(chunk, ...rest);
  };
  const cors = openCors() ? { 'access-control-allow-origin': '*' } : {};
  const secHdr = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };

  const pubCC = (sMax, swr = sMax * 2, maxAge = Math.min(15, Math.floor(sMax / 2))) =>
    AUTH.userMode ? 'private, no-store' : `public, max-age=${maxAge}, stale-while-revalidate=${swr}`;
  let routeTag = '';
  res.once('finish', () => {
    const ms = Number(process.hrtime.bigint() - reqStartNs) / 1e6;
    recordRequestMetric(routeTag || 'unknown', res.statusCode || 200, ms, routeWasCacheHit, reqBytesOut);
  });
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
    routeWasCacheHit = true;
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
      if (serveStatic(u.pathname, req, res)) { routeWasCacheHit = true; return; }
    }

    const gated = (u.pathname.startsWith('/api/') && u.pathname !== '/api/ping' && !u.pathname.startsWith('/api/auth/')) ||
      u.pathname === '/img' || u.pathname === '/hls' || u.pathname === '/vhs' ||
      u.pathname.startsWith('/tomtom/tile/');
    if (gated) {
      if (!principal) {
        return json({ ok: false, err: AUTH.userMode ? 'autentikasi diperlukan' : 'token tidak valid' }, AUTH.userMode ? 401 : 403);
      }
      const isHeavy = u.pathname === '/img' || u.pathname === '/hls' || u.pathname === '/vhs' ||
        u.pathname === '/api/thumb' || u.pathname === '/api/read' || u.pathname.startsWith('/api/copernicus/tile/') || Boolean(u.searchParams.get('fresh'));
      const cacheKeyFn = !isHeavy && (req.method === 'GET' || req.method === 'HEAD') ? CACHE_ROUTE_KEY[u.pathname] : null;
      const warmHit = cacheKeyFn ? bodyCache.get(cacheKeyFn(u)) : null;
      const warmCacheRule = (warmHit && Date.now() - warmHit.at < 30000) ? { limit: 3600, windowMs: 60000 } : undefined;

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
    if (req.method === 'GET' || req.method === 'HEAD') { if (serveStatic(u.pathname, req, res)) { routeWasCacheHit = true; return; } }
    if (u.pathname === '/api/metrics') {
      if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
      const mem = process.memoryUsage();
      const bps = originBytesPerSec();
      const routesOut = {};
      for (const [rk, rv] of METRICS.routes) {
        routesOut[rk] = {
          count: rv.count,
          err: rv.err,
          cacheHits: rv.cacheHits,
          hitRatio: rv.count ? +(rv.cacheHits / rv.count).toFixed(3) : 0,
          bytesOut: rv.bytesOut,
          p50Ms: quantileFromHist(rv.lat, 0.5),
          p95Ms: quantileFromHist(rv.lat, 0.95),
          p99Ms: quantileFromHist(rv.lat, 0.99),
        };
      }
      const upstreamOut = {};
      for (const [uk, uv] of METRICS.upstream) {
        upstreamOut[uk] = {
          count: uv.count,
          err: uv.err,
          p50Ms: quantileFromHist(uv.lat, 0.5),
          p95Ms: quantileFromHist(uv.lat, 0.95),
        };
      }
      const feedSumm = getFeedHealthSummary();
      const degradedFeeds = feedSumm.sources
        .filter(f => f.consecutiveFailures > 0 || (f.ageMs !== null && f.ageMs > 300000))
        .slice(0, 20)
        .map(f => ({ id: f.id, consecutiveFailures: f.consecutiveFailures, ageMs: f.ageMs }));
      const toMs = ns => Number.isFinite(ns) && ns > 0 ? +(ns / 1e6).toFixed(2) : 0;
      return json({
        ok: true,
        mode: AUTH.userMode ? 'session' : (AUTH.publicMode ? 'public' : 'token'),
        uptimeSec: Math.round((Date.now() - METRICS.startedAt) / 1000),
        reqTotal: METRICS.reqTotal,
        cacheHits: METRICS.cacheHits,
        proxy: { trustProxy: TRUST_PROXY, trustCf: TRUST_CF, proxyWarning: METRICS.proxyWarning },
        rejected: { r403: METRICS.rejected403, r429: METRICS.rejected429, r503: METRICS.rejected503, outboundBlocked: METRICS.outboundBlocked },
        gateway: GW.stats(),
        latencyMs: {
          count: METRICS.latency.count,
          p50: quantileFromHist(METRICS.latency, 0.5),
          p95: quantileFromHist(METRICS.latency, 0.95),
          p99: quantileFromHist(METRICS.latency, 0.99),
          bucketsMs: LAT_BUCKETS,
        },
        eventLoopLagMs: {
          min: toMs(eventLoopDelay.min),
          mean: toMs(eventLoopDelay.mean),
          p50: toMs(eventLoopDelay.percentile(50)),
          p95: toMs(eventLoopDelay.percentile(95)),
          p99: toMs(eventLoopDelay.percentile(99)),
          max: toMs(eventLoopDelay.max),
        },
        egress: {
          totalBytes: METRICS.bytesOut,
          originBytesPerSec: bps,
          originMbps: +((bps * 8) / 1e6).toFixed(3),
        },
        feeds: {
          total: feedSumm.total,
          healthy: feedSumm.healthy,
          failing: feedSumm.failing,
          maxAgeMs: feedSumm.maxAgeMs,
          degraded: degradedFeeds,
        },
        upstream: upstreamOut,
        caches: {
          memo: cache.size,
          userQuery: userQueryCache.size,
          bodyCount: bodyCache.size,
          bodyBytes: bodyCacheBytes(),
          docCount: docCache.size,
          docBytes: getDocCacheBytes(),
          readCache: readCache.size,
          thumbCache: thumbCache.size,
          descCache: descCache.size,
          ttTiles: ttTileCache.size,
          ttTileBytes: ttTileBytes(),
          knownNews: knownNewsUrls.size,
          knownVhs: knownVhsUrls.size,
        },
        memoryMb: {
          rss: Math.round(mem.rss / 1048576),
          heapUsed: Math.round(mem.heapUsed / 1048576),
          heapTotal: Math.round(mem.heapTotal / 1048576),
          external: Math.round((mem.external || 0) / 1048576),
          arrayBuffers: Math.round((mem.arrayBuffers || 0) / 1048576),
        },
        routes: routesOut,
      });
    }
    if (u.pathname === '/api/news') {
      const nrKey = 'newsresp:v' + PIPELINE_VERSION;
      const newsCC = pubCC(25, 60, 10);
      const curRev = getNewsRev();
      if (u.searchParams.get('fresh')) {
        if (!AUTH.hasRole(principal, 'operator')) return json({ ok: false, err: 'akses ditolak (butuh role operator)' }, 403);
        await refreshNewsNow();
        cache.delete(nrKey);
        bodyCache.delete(nrKey);
      } else if (u.searchParams.has('rev')) {
        const revRaw = u.searchParams.get('rev');
        const reqRev = /^\d+$/.test(String(revRaw || '')) ? Number(revRaw) : -1;
        if (reqRev >= 0 && (reqRev === curRev || newsRevSnapshots.has(reqRev))) {
          const dKey = 'newsdelta:v' + PIPELINE_VERSION + ':' + curRev + ':' + reqRev;
          if (sendCached(dKey, 25000, 200, newsCC)) return;
          if (reqRev === curRev) {
            return json({
              ok: true, delta: true, unchanged: true, rev: curRev,
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
        return json(c.v, 200, 'breaking', 12000, cc);
      }
      return json(await breaking(), 200, 'breaking', 12000, cc);
    }
    if (u.pathname === '/api/x') {
      const cc = pubCC(25, 60, 10);
      if (sendCached('x', 12000, 200, cc)) return;
      return json(socialResponse(await warmSocial('x', xposts, xHist), xHist, SOC.socKeepX), 200, 'x', 12000, cc, { stableAt: true });
    }
    if (u.pathname === '/api/xdiag') {
      if (!AUTH.hasRole(principal, 'admin')) return json({ ok: false, err: 'akses ditolak (butuh role admin)' }, 403);
      const SQ = require('./social.js').socQueries('x', []);
      const tests = u.searchParams.get('all') ? SQ.map(e => e.q) : ['kebakaran', 'kebakaran lang:id', 'kebakaran -filter:replies', 'kebakaran lang:id -filter:replies', '(kebakaran OR damkar) lang:id -filter:replies', 'kebakaran since_time:' + Math.floor((Date.now() - 46 * 3600e3) / 1000)];
      const out = [];
      for (const q of tests) {
        try {
          const r = await xSearch(q.replace(/ since_time:\d+/, ''));
          const n = r.posts.reduce((m, p) => Math.max(m, p.ts), 0);
          out.push({ q, n: r.posts.length, newest: n ? new Date(n).toISOString() : '-', ageH: n ? +((Date.now() - n) / 3600e3).toFixed(1) : null });
        } catch (e) { out.push({ q, err: String(e.message).slice(0, 120) }); }
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
      } catch (e) { return json({ ok: false, err: String(e.message || e).slice(0, 220) }); }
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
          adhocTopics: getAdhoc().map(a => a.id),
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
      return json({ ok: true, explanation: SOC.explainPost(txt, getAdhoc()) });
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
      return json({ ok: true, items: await ships(), n: shipMap.size, live: isAisLive(), at: Date.now() }, 200, 'ships', 10000, cc);
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
    if (u.pathname === '/api/tma' || u.pathname === '/api/pintu-air') {
      const cc = pubCC(60, 180, 20);
      if (sendCached('tma_pintu_air', 45000, 200, cc)) return;
      return json(await tmaPintuAir(), 200, 'tma_pintu_air', 45000, cc);
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
    if (u.pathname === '/api/tomtom/status') return json({ ok: true, keyConfigured: ttHas(), source: process.env.TOMTOM_API_KEY || process.env.TOMTOM_KEY ? 'env' : 'none', at: Date.now() });
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
    if (u.pathname === '/api/copernicus/status') {
      return json(copernicus.getStatus(), 200, '', 0, pubCC(30, 60, 15));
    }
    if (u.pathname.startsWith('/api/copernicus/tile/')) {
      const m = u.pathname.match(/^\/api\/copernicus\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/i);
      if (!m) { res.writeHead(404, secHdr); return res.end(); }
      const r = await copernicus.getTile(m[1], m[2], m[3]);
      if (r.cacheState === 'HIT-MEM' || r.cacheState === 'HIT-DISK') {
        METRICS.cacheHits++;
        routeWasCacheHit = true;
      }
      const cc = AUTH.userMode
        ? 'private, no-store'
        : (r.status === 200
            ? (r.stale ? 'public, max-age=3600, stale-while-revalidate=3600' : 'public, max-age=86400, stale-while-revalidate=86400')
            : 'no-store');
      const hdrs = {
        ...cors,
        ...secHdr,
        'content-type': r.ct || 'image/png',
        'cache-control': cc,
        'x-s2-cache': r.cacheState || 'UNKNOWN',
      };
      if (r.etag) hdrs.etag = r.etag;
      if (r.status === 200 && r.etag && req.headers['if-none-match'] === r.etag) {
        res.writeHead(304, hdrs);
        return res.end();
      }
      if (r.buf && r.buf.length > 0) hdrs['content-length'] = r.buf.length;
      res.writeHead(r.status, hdrs);
      return res.end(r.buf && r.buf.length ? r.buf : undefined);
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
      } catch (e) {
        if (e && e.status === 503) return json({ ok: false, err: e.message, transient: true, schemaVersion: PIPELINE_VERSION }, 503);
        const msg = String(e.message || e).slice(0, 160);
        return json({ ok: false, err: msg, transient: !/url tidak valid/i.test(msg), schemaVersion: PIPELINE_VERSION });
      } finally { rdActive--; }
    }
    if (u.pathname === '/api/desc') {
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

        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length) {
            const url = queue.shift();
            try {
              const d = await descForUrl(url);
              descDemote([url]);
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

SITREP_SERVER.keepAliveTimeout = 65000; SITREP_SERVER.headersTimeout = 66000;
SITREP_SERVER.requestTimeout = 90000; SITREP_SERVER.maxRequestsPerSocket = 1000;
global.__sitrepServer = SITREP_SERVER;

SITREP_SERVER.on('error', e => {
  console.error('[fatal] server error:', e && e.message);
  try { histFlushAll(); } catch {}
  process.exit(e && (e.code === 'EADDRINUSE' || e.code === 'EACCES') ? 78 : 1);
});

let newsCollectInflight = null;
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
function runNewsCollectOnce() {
  if (newsCollectInflight) return null;
  newsCollectInflight = warmNewsSnapshots().finally(() => { newsCollectInflight = null; });
  return newsCollectInflight;
}

if (require.main === module) {
  if (!AUTH.publicMode && !AUTH.userMode && !isLoopbackHost(BIND_HOST) && process.env.SITREP_ALLOW_LAN_TOKEN !== '1') {
    console.error('[FATAL] Menolak bind ke host non-loopback (' + BIND_HOST + ') dalam mode token lokal karena GET / menyisipkan token admin ke HTML. Gunakan 127.0.0.1 untuk lokal, atau set SITREP_PUBLIC=1 (publik read-only) / SITREP_USERS + SITREP_AUTH_SECRET (sesi RBAC).');
    process.exit(78);
  }
  SITREP_SERVER.listen({ host: BIND_HOST, port: Number(PORT) || 8787, backlog: 1024 }, () => {
    const modeLbl = AUTH.userMode ? ' [session-auth]' : (AUTH.publicMode ? ' [public-osint]' : ' [local-token]');
    const hostLbl = BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST;
    console.log('SITREP jalan di http://' + hostLbl + ':' + PORT + modeLbl + (xHas() ? ' (X pool: ' + xPool.size() + ' akun)' : '  (X: cookie belum diisi)'));
    const diskIntelBoot = Promise.allSettled([newsTopicHeat(), adhocRefresh()]);
    SEC.runIsolated('threadsWarm', async () => {
      await diskIntelBoot;
      const r = await threads();
      if (r) prewarmJson('threads', socialResponse(r, tHist, SOC.socKeepTh), { stableAt: true });
      console.log('Threads warm: ' + r.posts.length + ' post');
    });
    SEC.runIsolated('newsWarm', async () => {
      const p = runNewsCollectOnce();
      const res = p ? await p : null;
      if (!res) return;
      const { rs, incData, sitData } = res;
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

    setInterval(() => SEC.runIsolated('newsCollect', () => runNewsCollectOnce()), 50000).unref();
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
  isBannedHostUrl,
  isBannedNewsItem,
  probeImage,
  verifiedProxyImgs,
  rdRead,
  thumb,
  descForUrl,
  decodeGNews,
  mediaCacheGet,
  mediaCacheSet,
  docCache,
  docCacheGet,
  docCacheSet,
  getDocCacheBytes,
  DOC_CACHE_MAX_BYTES,
  rssSem,
  getFeedHealthSummary,
  runNewsCollectOnce,
  GW_OPTIONS,
  staticEntry,
  getAssetVersionMap,
  recordUpstream,
  fcBlocked,
  fcFailMark,
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
