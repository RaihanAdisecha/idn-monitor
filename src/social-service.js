'use strict';
const { execFile } = require('child_process');

function createSocialService({
  fs,
  path,
  rootDir,
  HIST_DIR,
  CFG,
  SOC,
  HISTORY,
  FEEDTEXT,
  GEO,
  XPOOL,
  nlpAdapter,
  cache,
  memo,
  makeSem,
  get,
  sleep,
  publicURL,
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
}) {
  const xHist = new Map(), tHist = new Map();
  const histKey = HISTORY.keyOf, histTs = HISTORY.tsOf;
  const HIST_MAX = { x: 1500, th: 1200 }, HIST_AGE = 48 * 3600e3;
  let ADHOC = [];
  const histUser = p => String(p.handle || p.username || '').toLowerCase();

  const astroturfFull = t => String(t || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w]+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  const AUTH_ACCOUNTS = new Set(['infobmkg', 'bnpb_indonesia', 'basarnas', 'damkardki', 'tmcpoldametro', 'halo_polisi', 'divhumas_polri', 'puspentni', 'kemkesri']);
  function histAstroturf(map) {
    const eligible = p => {
      const t = String(p.text || '');
      if (t.length < 50 || /^\s*(rt\s+)?@/i.test(t)) return false;
      const u = String(histUser(p) || '').toLowerCase().replace(/^@/, '');
      if (AUTH_ACCOUNTS.has(u)) return false;
      return true;
    };
    const cand = new Map();
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
  function histRetag(map, keep, recordDiagnostics = false) {
    HISTORY.retag(map, keep, ADHOC, Date.now(), { recordDiagnostics });
  }
  const histSaveAt = {};
  const histSaveInflight = new Set();
  const histDirty = new Map();
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
  function histMarkDirty(file, map, max) {
    histDirty.set(file, { map, max });
    histSave(file, map, max);
  }
  function flushSocialHist(force) {
    for (const [f, m] of histDirty) histSave(f, m.map, m.max, Boolean(force));
  }
  function histMerge(map, posts, max, file) {
    for (const p of posts) { const k = histKey(p); if (k) map.set(k, p); }
    const now = Date.now();
    histRetag(map, map === xHist ? SOC.socKeepX : SOC.socKeepTh);
    histAstroturf(map);
    const arr = [...map.values()].filter(p => histTs(p) > 0 && histTs(p) <= now && now - histTs(p) <= HIST_AGE).sort((a, b) => histTs(b) - histTs(a));
    const kept = SOC.socBalance(arr, max, histUser);

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
  function histLoad(file, map) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const p of j.posts || []) { const k = histKey(p); if (k) map.set(k, p); }
    } catch (e) {}
  }

  fs.mkdirSync(HIST_DIR, { recursive: true });
  histLoad(path.join(HIST_DIR, 'x-history.json'), xHist);
  histLoad(path.join(HIST_DIR, 'threads-history.json'), tHist);
  histRetag(xHist, SOC.socKeepX, true);
  histRetag(tHist, SOC.socKeepTh, true);
  histAstroturf(xHist);
  histAstroturf(tHist);

  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const FEATURES = {
    rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true,
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
    responsive_web_enhance_cards_enabled: false,
  };

  const X = { ...(CFG.x || {}) };
  delete X.auth_token; delete X.ct0; delete X.accounts;
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
      const urls = [...new Set([...html.matchAll(/https:\/\/abs\.twimg\.com\/[^"'\s]*?\.js/g)].map(m => m[0]))];
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

  const xSem = makeSem(4);
  const xCooling = () => xPool.allCooling();
  async function xSearchGo(q, cursor, winH) {
    if (!xHas()) throw new Error('auth_token / ct0 belum diisi');
    if (xCooling()) { const until = xPool.earliestReset(); const e = new Error('X rate-limit cooldown'); e.cooldown = true; e.retryAt = until; throw e; }
    const id = await xQueryId();
    const win = winH == null ? 46 : winH;
    const vars = { rawQuery: q + (win > 0 ? ' since_time:' + Math.floor((Date.now() - win * 3600e3) / 1000) : ''), count: 20, querySource: 'typed_query', product: 'Latest' };
    if (cursor) vars.cursor = cursor;
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
      if (!out.size && !cursor) {
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

  const TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu minggu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri').split(' '));
  const TBLK = new Set(('detik cnn tempo liputan6 republika tribun cnbc antara jawapos okezone kumparan suara merdeka sindonews jpnn tvri inews media news kompas viva metrotvnews rmol infopublik jabarprov korankaltim tvone merahputih poskota beritasatu gridoto wowkeren bola bolaoverza mediaindonesia faktualnews berita foto video gallery wawancara investigasi khusus daerah nasional internasional ekonomi hiburan selebriti olahraga dishub cumplik').split(' '));
  const GEO_INC_RE = new RegExp(CATS.filter(c => c.geo).map(c => c.re.source).join('|'), 'i');
  const NEWS_KW_RE = /[a-z][a-z'-]{3,}/g;
  const NEWS_KW_STOP = new Set(('dalam atas bawah antara belum saja hanya lagi harus masih namun tetapi nanti kemarin lusa dekat jauh setiap semua banyak sedikit sedang pernah bukan yaitu yakni bila agar supaya tersebut kaum kaumnya atau rumah warga orang anak pria wanita ibu bapak mobil motor gedung kantor tanah lahan desa kota jalan hari bulan tahun waktu tempat kerja loker jasa harga biaya uang pasar toko produk barang sekolah kampus kuliah teman keluarga makan minum hidup mati kabar cerita kisah acara kegiatan program situasi kondisi proses sistem bentuk bagian nomor nama sosok').split(' '));

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
        if (single && ctx < 2) continue;
        out.push(ph);
        if (out.length >= 8) break;
      }
      return out;
    } catch (e) { return []; }
  });

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

  const richPosts = () => memo('richposts', 60000, async () => [
    ...[...xHist.values()].map(p => ({ text: p.text, ts: histTs(p), topics: p.topics, platform: 'x', user: histUser(p) })),
    ...[...tHist.values()].map(p => ({ text: p.text, ts: histTs(p), topics: p.topics, platform: 'th', user: histUser(p) }))
  ]);

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
      incNewsHeatRev();
      return [...cnt.entries()]
        .filter(([, c]) => c >= 2.0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([t, score]) => ({ id: t, score: +score.toFixed(1) }));
    } catch (e) { return []; }
  });

  const newsKeywords = () => memo('newskw', 600000, async () => {
    try {
      const srcs = await news(), now = Date.now(), pairs = new Map(); let n = 0;
      for (const s of srcs) {
        if (!s.ok) continue;
        for (const it of s.items) {
          if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || now - it.ts > 24 * 3600e3) continue;
          const title = String(it.title || '');
          if (!GEO_INC_RE.test(title)) continue;
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

  const socialPhrases = () => memo('socphrase', 600000, async () => {
    if (typeof SOC.socPhraseScan !== 'function') return [];
    try {
      const posts = await richPosts();
      const exclude = new Set(SOC.SOC_TOPICS.map(t => t.id).concat(ADHOC.map(a => a.id)));
      return (await SOC.socPhraseScan(posts, { now: Date.now(), windowMs: 6 * 3600e3, minUsers: 2, exclude, max: 6 })) || [];
    } catch (e) { return []; }
  });

  const memoVal = k => { const c = cache.get(k); return c && c.v !== undefined ? c.v : []; };

  function buildTrends(hot, stats) {
    const m = new Map();
    const volOf = id => (stats && stats[id] ? (stats[id].x || 0) + (stats[id].th || 0) : 0);
    const add = (id, src, score) => {
      id = String(id || '').toLowerCase().trim();
      if (!id || !(score > 0)) return;
      if (id === 'olahraga' || TBLK.has(id) || SKIP_RE.test(id) || SOC.SOC_FOREIGN_RE.test(id)) return;
      if (volOf(id) <= 0) return;
      const e = m.get(id) || { id, src: [], scores: Object.create(null), score: 0 };
      if (e.src.indexOf(src) < 0) e.src.push(src);
      e.scores[src] = Math.max(e.scores[src] || 0, score);
      const vals = Object.values(e.scores);
      const best = Math.max(...vals);
      const hasNews = !!e.scores.news;
      const hasSocial = !!e.scores.social;
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

  function synthQueries(kind, adhoc, trends, base, phrases, kw, newsKw) {
    const out = [], seen = new Set();
    const mk = cap => { let n = 0; return (t, q) => {
      if (!q || n >= cap || seen.has(t + '|' + q) || (base && base.has(q))) return;
      seen.add(t + '|' + q); n++; out.push({ t, q });
    }; };
    const add = mk(4), addP = mk(3), addK = mk(2), addN = mk(3);

    for (const a of adhoc || []) {
      const id = String(a.id);
      if (kind === 'x') add('adhoc2:' + id, id + ' -dijual -kpr -rumah -sewa -filter:replies');
      else if (!/\s/.test(id)) add('adhoc2:' + id, '#' + id);
    }
    for (const n of trends || []) {
      const nm = String(n).replace(/"/g, '');
      add('xtrend:' + nm.toLowerCase(), '"' + nm + '" -dijual -kpr -rumah -sewa -filter:replies');
    }
    for (const p of phrases || []) {
      const ph = String((p && (p.ph || p.id)) || '').replace(/"/g, '').trim().toLowerCase();
      if (ph.length < 3 || ph.length > 42) continue;
      const id = 'socphrase:' + ph.replace(/\s+/g, '-');
      if (kind === 'x') addP(id, '"' + ph + '" -dijual -kpr -rumah -sewa -filter:replies');
      else { addP(id, ph); if (!/\s/.test(ph)) addP(id, '#' + ph); }
    }
    for (const k of kw || []) for (const term of (k.terms || []).slice(0, 4)) {
      const tm = String(term || '').replace(/"/g, '').trim();
      if (tm.length < 3 || tm.length > 42) continue;
      addK(k.t, kind === 'x' ? (/\s/.test(tm) ? '"' + tm + '" -dijual -kpr -rumah -sewa -filter:replies' : tm + ' -dijual -kpr -rumah -sewa -filter:replies') : tm);
    }
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
      if (s.fetches > 20) { s.fetches >>= 1; s.newPosts >>= 1; }
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

  function yieldAdj(map, t) {
    const s = map.get(t);
    if (!s || !s.fetches) return 1;
    let f = 1 + Math.min(s.newPosts / s.fetches, 4) / 4;
    if (s.fetches >= 3 && s.newPosts === 0) f *= 0.4;
    return f;
  }

  const xSeen = new Map(), xYield = new Map();
  let xTick = 0;
  const xposts = () => memo('x', 300000, async () => {
    await adhocRefresh();
    const meta0 = socMeta();
    if (!xHas()) return { ok: false, err: 'auth_token / ct0 belum diisi di config.json', posts: [], ...meta0 };
    if (xCooling()) {
      const posts = [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
      return { ok: false, err: 'X rate-limit — reset ~' + XPOOL.formatWibTime(xPool.earliestReset()) + ' WIB', posts, ...socMeta(), at: Date.now(), cooldown: true };
    }

    const all = SOC.socQueries('x', ADHOC), first = xTick === 0, now = Date.now();
    xTick++;
    const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
    const heat = t => { const s = stats[t]; return s ? (s.x || 0) + (s.th || 0) : 0; };

    const synth = synthQueries('x', ADHOC, await xTrends(), new Set(all.map(e => e.q)),
      await socialPhrases(), await socKw(), await newsKeywords());
    all.push(...synth);
    const byTopic = new Map();
    for (const e of all) { const a = byTopic.get(e.t); if (a) a.push(e); else byTopic.set(e.t, [e]); }

    const newsHotTop = await newsTopicHeat();
    const newsHotIds = (newsHotTop || []).map(x => typeof x === 'string' ? x : (x && x.id)).filter(Boolean);

    const synthSet = new Set(synth.map(e => e.t));
    const forcedOrd = hotTop.concat(newsHotIds, ADHOC.map(a => a.id), synth.map(e => e.t));
    const forced = new Set(forcedOrd);
    const chosen = new Set();
    if (first) { for (const t of byTopic.keys()) chosen.add(t); }
    else {
      const N = 14, SYNTH_MAX = 4, pri = t => ((now - (xSeen.get(t) || 0)) / 60000) * (1 + Math.min(heat(t), 60) / 15) * yieldAdj(xYield, t);
      const rest = [...byTopic.keys()].filter(t => !forced.has(t)).sort((a, b) => pri(b) - pri(a));
      let used = 0, synthUsed = 0;

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
    if (first) { for (const t of chosen) { const l = byTopic.get(t) || []; if (l[0]) sel.set(l[0].q, l[0]); } }
    else for (const t of chosen) for (const e of byTopic.get(t) || []) sel.set(e.q, e);
    for (const t of chosen) xSeen.set(t, now);

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
      if (xCooling()) break;
      const chunk = queries.slice(i, i + 5);
      const rs = await Promise.allSettled(chunk.map(e => xSearch(e.q)));
      rs.forEach((r, j) => {
        const e = chunk[j];
        if (r.status === 'rejected') { errs.push(e.t + ': ' + String(r.reason && r.reason.message || r.reason)); if (r.reason && r.reason.status === 429) failedT.add(e.t); return; }
        okQ.add(e.q);
        ingest(e, r.value.posts);
        if (r.value.cursor && r.value.posts.length >= 15) page2.push({ e, cursor: r.value.cursor, n: r.value.posts.length });
      });
      if (i + 5 < queries.length && !xCooling()) await sleep(350 + Math.random() * 350);
    }

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
    const preKeys = new Set(xHist.keys());
    await maybeDisambiguateBorderline(batch);
    histMerge(xHist, batch, HIST_MAX.x, path.join(HIST_DIR, 'x-history.json'));
    const xFetched = new Set();
    for (const q of okQ) for (const t of qT.get(q) || []) xFetched.add(t);
    yieldNote(xYield, batch, preKeys, xFetched);
    const posts = [...xHist.values()].sort((a, b) => histTs(b) - histTs(a));
    let err = errs.join(' | ');
    if (!posts.length && !err) err = '0 post lolos filter: ' + rawN + ' tweet dari ' + queries.length + ' query (drop ts:' + dropTs + ' topik:' + dropTag + ', tweet terbaru=' + (newest ? new Date(newest).toISOString() : '-') + ', qid=' + (X.query_id ? 'env/config:' + X.query_id : 'auto') + ')' + (dropSample ? ' | contoh ts=' + dropSample.ts + ' created_at="' + dropSample.ca + '" "' + dropSample.txt + '"' : '');
    return { ok: errs.length < queries.length, err, posts, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
  }, v => (v.posts || []).length > 0);

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

  const TH = CFG.threads || {};
  const TH_AUTH = (() => {
    const env = { sessionid: 'TH_SESSIONID', csrftoken: 'TH_CSRFTOKEN', ds_user_id: 'TH_DS_USER_ID', mid: 'TH_MID', rur: 'TH_RUR' };
    const ck = {};
    for (const [k, v] of Object.entries(env)) { const val = process.env[v]; if (val) ck[k] = val; }
    return ck.sessionid ? ck : null;
  })();
  const PY_BIN = [
    TH.python,
    path.join(rootDir, '.venv', 'bin', 'python'),
    path.join(rootDir, '.venv', 'Scripts', 'python.exe'),
    'python3'
  ].filter(Boolean).find(p => p === 'python3' || fs.existsSync(p));

  const thSem = makeSem(3);
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
    execFileBounded(PY_BIN, [path.join(rootDir, 'vendor', 'threads_worker.py'), JSON.stringify(spec)],
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
  const thBadProfiles = new Map();
  const dynWatch = (now) => {
    const uc = Object.create(null);
    const nonAnon = new Set();
    for (const p of tHist.values()) {
      if (String(p.q || '').startsWith('@')) continue;
      if (!p.assessment || p.assessment.signalEligible !== true) continue;
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
  const thSeen = new Map(), thYield = new Map(), thTopicOff = new Map();
  let thTick = 0;
  const threads = () => memo('threads', 240000, async () => {
    if (!PY_BIN) throw new Error('Python tidak ditemukan. Jalankan: python3 -m venv .venv && .venv/bin/pip install curl_cffi');
    await adhocRefresh();
    const meta0 = socMeta(), now = Date.now();
    thTick++;

    const entries = SOC.socQueries('th', ADHOC);
    const hotTop = meta0.trending.slice(0, 2), stats = meta0.stats || {};
    const heat = t => { const s = stats[t]; return s ? (s.th || 0) + (s.x || 0) : 0; };

    const synth = synthQueries('th', ADHOC, null, new Set(entries.map(e => e.q)),
      await socialPhrases(), await socKw(), await newsKeywords());
    for (const e of synth) entries.push(e);
    const byTopic = new Map();
    for (const e of entries) { const a = byTopic.get(e.t); if (a) a.push(e.q); else byTopic.set(e.t, [e.q]); }

    const newsHotTop = await newsTopicHeat();
    const newsHotIds = (newsHotTop || []).map(x => typeof x === 'string' ? x : (x && x.id)).filter(Boolean);
    const synthSet = new Set(synth.map(e => e.t));

    const forcedOrd = hotTop.concat(newsHotIds, ADHOC.map(a => a.id), synth.map(e => e.t));
    const forced = new Set(forcedOrd);
    const chosen = new Set(), chosenQueries = new Map();

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

    const qT = new Map();
    for (const t of chosen) for (const q of chosenQueries.get(t) || []) { const a = qT.get(q); if (a) a.push(t); else qT.set(q, [t]); }
    const watch = [...new Set(TH_WATCH.concat(dynWatch(now)))]
      .filter(u => !((thBadProfiles.get(String(u).toLowerCase()) || 0) > now));

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
        if (!TH_WATCH.includes(handle)) continue;
      }
      errs.push(e);
    }

    const failedQ = new Set(), thFetched = new Set();
    rs.forEach((r, i) => {
      if (r.status === 'rejected') { for (const q of runChunks[i].s) failedQ.add(q); return; }
      const es = r.value.errs || [];
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
    const preKeys = new Set(tHist.keys());
    await maybeDisambiguateBorderline(batch);
    histMerge(tHist, batch, HIST_MAX.th, path.join(HIST_DIR, 'threads-history.json'));
    yieldNote(thYield, batch, preKeys, thFetched);
    const posts = [...tHist.values()].sort((a, b) => histTs(b) - histTs(a));
    const newestTs = posts.length ? histTs(posts[0]) : 0;
    return { ok: rs.some(r => r.status === 'fulfilled' && (r.value.posts?.length > 0 || !r.value.errs?.length)), posts, errs, ingested: batch.length, newestTs, dropped, ...socMeta(), at: Date.now(), partial: errs.length > 0 };
  }, v => (v.posts || []).length > 0);

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
  const socialRespCache = new Map();
  let socialMetaFp = '', socialMetaVal = null;
  function socialResponse(result, map, keep) {
    const now = Date.now();
    let mx = 0;
    for (const p of map.values()) { const t = HISTORY.tsOf(p); if (t > mx) mx = t; }
    const fp = SOC.CLASSIFIER_VERSION + '|' + map.size + '|' + mx + '|' + adhocSig() + '|' + Math.floor(now / 3600e3);
    let c = socialRespCache.get(map);
    if (!c || c.fp !== fp) {
      histRetag(map, keep);
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

    const newsHeatRev = getNewsHeatRev(), NEWS_REV = getNewsRev();
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

  const warmSocial = (k, run, map) => {
    const c = cache.get(k);
    if (c && c.v !== undefined) return run();
    if (!c || !c.p) run().catch(() => {});
    const posts = [...map.values()].sort((a, b) => histTs(b) - histTs(a));
    return Promise.resolve({ ok: posts.length > 0, err: '', warming: true, posts,
      newestTs: posts.length ? histTs(posts[0]) : 0, at: Date.now(), ingested: 0, errs: [], dropped: {} });
  };

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
    try {
      for (;;) {
        const r = await xSearch('conversation_id:' + id, cursor, 0);
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
      execFileBounded(PY_BIN, [path.join(rootDir, 'vendor', 'threads_thread.py'), JSON.stringify({ url, auth: TH_AUTH })],
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

  return {
    xHist,
    tHist,
    flushSocialHist,
    X,
    xPool,
    xHas,
    xSearch,
    adhocRefresh,
    getAdhoc: () => ADHOC,
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
  };
}

module.exports = { createSocialService };
