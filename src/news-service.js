'use strict';

function createNewsService({
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
}) {
  const { cleanTitle } = FEEDTEXT;
  const rdImgKey = u => MEDIA.imageKey(u);
  const placeOf = t => GEO.locate(t);

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
    ['CNA INDONESIA', 'https://www.cna.id/api/v1/rss-outbound-feed?_format=xml'],
    ['TRIBUN', 'https://www.tribunnews.com/rss'],
    ['CNBC ID', 'https://www.cnbcindonesia.com/news/rss'],
    ['JPNN', 'https://www.jpnn.com/rss'],
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

  const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  const tag = (b, n) => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? dec(m[1]) : ''; };
  const tagRaw = (b, n) => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1] : ''; };
  const descOf = (b, title) => FEEDTEXT.descFrom({
    description: tagRaw(b, 'description'),
    contentEncoded: tagRaw(b, 'content:encoded'),
    summary: tagRaw(b, 'summary') || tagRaw(b, 'dc:description') || tagRaw(b, 'itunes:summary'),
    mediaDescription: tagRaw(b, 'media:description'),
  }, title || '');

  const cleanPub = v => {
    v = String(v || '').trim();
    if (/^(https?:)?\/\//i.test(v) || /^www\./i.test(v)) { try { return new URL(/^www\./i.test(v) ? 'https://' + v : v).hostname.replace(/^www\./i, ''); } catch (e) { return ''; } }
    return v;
  };

  const BANNED_SRC = /infopublik\.id|infopublik|kompasiana|koran\.tempo\.co|majalah\.tempo\.co|plus\.tempo\.co|tempo\.co\/(?:plus|langganan|subscribe)\b|mozaik\.inilah\.com|mediacenter\.palangkaraya\.go\.id|viva\.co\.id\/foto|nokenlive|polreskedirikota|korankaltim|pelakita|cilegon\.go\.id|twaslnews|kilangbara\.com|klikmu\.co/i;
  const BANNED_SOCIAL_HOST_RE = /(?:^|\.)(?:instagram\.com|instagr\.am|tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com|facebook\.com|fb\.com|fb\.watch|threads\.net|threads\.com|x\.com|twitter\.com)$/i;
  const BANNED_SOCIAL_PUB_RE = /^(?:instagram|tiktok|facebook|threads|x|twitter)$/i;

  function isBannedHostUrl(u) {
    if (!u) return false;
    const s = String(u);
    if (BANNED_SRC.test(s)) return true;
    try {
      const h = new URL(s).hostname.replace(/^www\./i, '');
      if (BANNED_SOCIAL_HOST_RE.test(h)) return true;
    } catch (e) {}
    return false;
  }
  function isBannedNewsItem(it) {
    if (!it) return false;
    const pub = String(it.pub || '').trim();
    if (pub && BANNED_SOCIAL_PUB_RE.test(pub)) return true;
    if (isBannedHostUrl(it.url) || isBannedHostUrl(it.srcUrl) || isBannedHostUrl(it.final)) return true;
    const bid = (it.title || '') + ' ' + (it.url || '') + ' ' + pub + ' ' + (it.srcUrl || '');
    return BANNED_SRC.test(bid);
  }
  function parseFeed(xml, feedUrl = 'https://localhost/') {
    const out = [];
    for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
      const b = m[1], title = tag(b, 'title');
      const rawLink = tag(b, 'link') || tag(b, 'guid');
      const url = MEDIA.resolveUrl(rawLink, feedUrl);
      const d = tag(b, 'pubDate') || tag(b, 'dc:date');
      const isGN = /^https?:\/\/news\.google\.com\//i.test(url);
      const srcUrl = (b.match(/<source[^>]*url="([^"]+)"/i) || [])[1] || '';
      const pub = cleanPub(tag(b, 'source'));
      if (title && url && !isBannedNewsItem({ title, url, pub, srcUrl })) {
        const rssImgs = MEDIA.extractFeedImageCandidates(b, url || feedUrl);
        out.push({
          title, url, ts: d ? Date.parse(d) || 0 : 0,
          img: '', rssImg: rssImgs[0] || '', rssImgs,
          pub, desc: isGN ? '' : descOf(b, title)
        });
      }
    }
    for (const m of xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)) {
      const b = m[1], l = b.match(/<link[^>]*href="([^"]+)"/i) || b.match(/<link[^>]*>([^<]+)<\/link>/i), d = tag(b, 'updated') || tag(b, 'published');
      const t = tag(b, 'title');
      const rawLink = (l && (l[1] || '').trim()) || '';
      const url = MEDIA.resolveUrl(rawLink, feedUrl);
      const isGN2 = /^https?:\/\/news\.google\.com\//i.test(url);
      if (url && t && !isBannedNewsItem({ title: t, url })) {
        const rssImgs = MEDIA.extractFeedImageCandidates(b, url || feedUrl);
        out.push({
          title: t, url, ts: Date.parse(d) || 0,
          img: '', rssImg: rssImgs[0] || '', rssImgs,
          desc: isGN2 ? '' : descOf(b, t)
        });
      }
    }

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

  const breakNorm = t => String(t).toLowerCase().replace(/\s+-\s+[^-]{2,45}$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const feedSigMap = new Map();
  const feedSig = items => {
    let h = 5381;
    for (const it of items) {
      const s = (it.ts || 0) + '|' + (it.url || '');
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
    }
    return items.length + ':' + (h >>> 0);
  };

  let NEWS_REV = 0;
  let newsHeatRev = 0;
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
        if (isBannedNewsItem(it)) continue;
        if (FEEDTEXT.newsEnglish(it.title, it.desc)) continue;
        let m = newsHistByFeed.get(it.src);
        if (!m) { m = new Map(); newsHistByFeed.set(it.src, m); }
        const k = newsHistKey(it);
        if (k) m.set(k, it);
      }
      for (const [fid, m] of newsHistByFeed) {
        const sorted = [...m.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, NEWS_FEED_CAP);
        const next = new Map();
        for (const it of sorted) {
          next.set(newsHistKey(it), it);
          if (it && it.url) registerNewsUrl(it.url);
        }
        newsHistByFeed.set(fid, next);
      }
    } catch (e) {}
  }
  loadNewsHist();

  function mergeNewsHist(id, liveItems, now, opts = {}) {
    let m = newsHistByFeed.get(id);
    if (!m) { m = new Map(); newsHistByFeed.set(id, m); }
    for (const [k, prev] of m) {
      if (!prev || !prev.ts || prev.ts <= 0 || prev.ts > now + 5 * 60e3 || now - prev.ts > 24 * 3600e3 || isBannedNewsItem(prev)) {
        m.delete(k);
      }
    }
    for (const it of liveItems) {
      const cleanIt = { ...it, title: cleanTitle(it.title, it.pub), src: id };
      const ts = Number(cleanIt.ts) || 0;
      if (ts <= 0 || ts > now + 5 * 60e3 || now - ts > 24 * 3600e3) continue;
      if (isBannedNewsItem(cleanIt)) continue;
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

  let assessedRev = -1, assessedItemCount = -1, assessedCacheMap = null, assessedInflight = null;
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

  const RSS_CONCURRENCY = Math.max(1, Number(process.env.SITREP_RSS_CONCURRENCY) || 8);
  const RSS_JITTER_MS = Math.max(0, Number(process.env.SITREP_RSS_JITTER_MS ?? 250));
  const rssSem = makeSem(RSS_CONCURRENCY, 160);
  const feedHealth = new Map();
  function recordFeedHealth(id, ok, err, okCount = 0) {
    const now = Date.now();
    const prev = feedHealth.get(id) || { id, lastAttempt: 0, lastSuccess: 0, consecutiveFailures: 0, lastError: '', lastOkCount: 0 };
    prev.lastAttempt = now;
    if (ok) {
      prev.lastSuccess = now;
      prev.consecutiveFailures = 0;
      prev.lastError = '';
      prev.lastOkCount = okCount;
    } else {
      prev.consecutiveFailures++;
      prev.lastError = String(err || 'gagal').slice(0, 120);
    }
    feedHealth.set(id, prev);
  }
  function getFeedHealthSummary() {
    const now = Date.now();
    const sources = [];
    let healthy = 0, failing = 0, maxAgeMs = 0;
    for (const [id] of NEWS) {
      const h = feedHealth.get(id) || { id, lastAttempt: 0, lastSuccess: 0, consecutiveFailures: 0, lastError: '', lastOkCount: 0 };
      const ageMs = h.lastSuccess ? Math.max(0, now - h.lastSuccess) : null;
      if (ageMs !== null && ageMs > maxAgeMs) maxAgeMs = ageMs;
      if (h.consecutiveFailures > 0) failing++;
      else if (h.lastSuccess > 0) healthy++;
      sources.push({ id, lastAttempt: h.lastAttempt, lastSuccess: h.lastSuccess, ageMs, consecutiveFailures: h.consecutiveFailures, lastOkCount: h.lastOkCount });
    }
    return { total: NEWS.length, healthy, failing, maxAgeMs, sources };
  }
  function fetchFeedEntry(id, url) {
    return rssSem(async () => {
      const prevAttempt = (feedHealth.get(id) || {}).lastAttempt || 0;
      if (RSS_JITTER_MS > 0 && prevAttempt > 0) {
        await sleep(Math.floor(Math.random() * RSS_JITTER_MS));
      }
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

      if (id === 'TEMPO') attempts.unshift('https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent('site:tempo.co -site:koran.tempo.co -site:majalah.tempo.co -site:plus.tempo.co -site:en.tempo.co when:2d'));
      if (id === 'VOI') attempts.splice(customProxy ? 2 : 1, 0, 'https://news.google.com/rss/search?hl=id&gl=ID&ceid=ID:id&q=' + encodeURIComponent('site:voi.id when:2d'));
      outer: for (const u of attempts) {
        for (let i = 0; i < 2; i++) {
          if (Date.now() - t0 > 26000) break outer;
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

            if (!outItems.length && fresh.length) {
              for (const it of fresh.slice(0, NEWS_FEED_CAP)) outItems.push({ ...it, title: cleanTitle(it.title, it.pub), src: id });
            }
            const sig = feedSig(outItems);
            const prevSig = feedSigMap.get(id);
            if (prevSig && prevSig !== sig) invalidateDerivedFromNews();
            feedSigMap.set(id, sig);
            const stale = !fresh.length || !!(newest && now - newest > 3 * 3600e3);
            recordFeedHealth(id, true, '', outItems.length);
            recordUpstream('rss', true, Date.now() - t0);
            return { id, ok: true, stale, items: outItems, at: now };
          } catch (e) {
            lastErr = String(e.message || e);
            if (/^HTTP (?:403|404|410)\b/.test(lastErr)) break;
            if (i === 0) await new Promise(res => setTimeout(res, 350));
          }
        }
      }
      const errMsg = ('gagal direct + proxy: ' + lastErr).slice(0, 140);
      recordFeedHealth(id, false, errMsg, 0);
      recordUpstream('rss', false, Date.now() - t0);
      return { id, ok: false, err: errMsg, items: [] };
    });
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

  const HEALTH_DZ = String.raw`wabah|\bklb\b|kejadian luar biasa|dbd|\bdhf\b|demam berdarah|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|typhoid|kolera|rabies|gila anjing|anjing gila|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|intoksikasi|rotavirus|flu burung|h1n1|malaria|salmonella|e\.?\s*coli|bakteri pangan`;
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

  const SKIP_JUNK = /(pascabencana|pascagempa|pascabanjir|mitigasi|kesiapsiagaan(?!\s*(?:pengamanan|aparat|pasukan|personel|polri|tni|demo|unjuk rasa|aksi))|potensi bencana|rawan bencana|risiko bencana|kajian risiko|simulasi|edukasi|sosialisasi|pelatihan|antisipasi(?!\s*(?:demo|unjuk rasa|aksi|massa|kerusuhan|bentrok|keamanan|pengamanan))|siaga bencana|hadapi bencana|menghadapi bencana|asuransi|operasi patuh|ranperda|perda|godok|dana bencana|tas bencana|go[- ]?bag|pusdalops|kebutuhan darurat|peralatan bencana|salurkan bantuan|menyalurkan|penyaluran|modus|ruu|boikot dirinya|perang harga|perang dagang|joget|\bolahraga\b|timnas|atletik|sea games|olimpiade|asiad|liga|top skor|voli|sepak bola|badminton|bulu tangkis|piala|kualifikasi|gaun|mahalini|fashion|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|penghargaan|jasa raharja|warisan|turun-temurun|sepanjang 20\d\d|berdampak ke ekonomi|\bjanda\b|\bduda\b|\bbispak\b|\bbokep\b|\bsange\b|\bcolmek\b|\bpacar\b|\bgebetan\b|\bskincare\b|\bkpop\b|\bdrakor\b|\banime\b)/i;
  const SKIP_FOREIGN = /(brasil|brazil|amerika serikat|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|perancis|paris|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza|poland|polandia|polonia|krakow|warsaw|warszawa|lublin|czechia|ceko|prague|austria|wina|vienna|finland|finlandia|singapura|singapore|suriah|syria|irak|iraq|mesir|egypt|libya|libia|maroko|morocco|aljazair|algeria|tunisia|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|hungaria|hungary|rumania|romania|bulgaria|serbia|kroasia|croatia|slowakia|slovakia|slovenia|belgia|belgium|irlandia|ireland|estonia|latvia|lithuania|belarus|mongolia|maladewa|maldives|timor leste|selandia baru|new zealand|kuba|cuba|jamaika|jamaica|haiti|nikaragua|kosta rika|costa rica|kolombia|colombia|venezuela|bolivia|ekuador|ecuador|peru|paraguay|uruguay|congo|rwanda|uganda|tanzania|zambia|zimbabwe|mozambique|angola|namibia|botswana|lesotho|madagascar|mauritius|somalia|eritrea|djibouti|afghanistan|bhutan|brunei|albania|armenia|azerbaijan|cyprus|iceland|kosovo|luxembourg|malta|moldova|montenegro|san marino|vatikan|vatican|monako|monaco|georgia|jordan|panama|senegal|cameroon|gambia|guinea|sierra leone|liberia|mauritania|burkina faso|tokyo|seoul|beijing|shanghai|hong kong|taipei|bangkok|hanoi|manila|kualalumpur|kathmandu|moskwa|moscow|berlin|rome|roma|madrid|amsterdam|brussels|zurich|stockholm|oslo|copenhagen|helsinki|dublin|budapest|bucharest|sofia|belgrade|zagreb|vilnius|riga|tallinn|minsk|kiev|kyiv|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|nairobi|kampala|kigali|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|bangui|yaounde|conakry|lome|cotonou|abidjan|nouakchott|maseru|mbabane|gaborone|windhoek|maputo|antananarivo|moroni|port louis|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|port-au-prince|nassau|bridgetown|castries|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|sucre|guayaquil)/i;
  const SKIP_RE = new RegExp('(?:' + SKIP_JUNK.source.slice(1, -1) + ')|(?:' + SKIP_FOREIGN.source.slice(1, -1) + ')', 'i');
  const catMeta = id => CATS.find(c => c.id === id) || { id:'', label:'Insiden', sev:0.5, geo:true };

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

  const foreignOf = (t, a) => {
    const fsList = (a && a.findings) || [];
    if (fsList.length) return fsList.some(f => f.scope === 'foreign') && !fsList.some(f => f.scope === 'Indonesia');
    return ASSESS.classifyScope(t, null).scope === 'foreign';
  };

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
    if (!a.topics.length) return '';
    if (SKIP_JUNK.test(t)) {
      const isCrisisOrDemo = /(?:demo|unjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|tsunami|gempa|erupsi|kebakaran|banjir|pengamanan|siagakan|siapkan)/i.test(t);
      if (!isCrisisOrDemo) return '';
    }
    const NON_NEWS_TOPICS = new Set(['pendidikan', 'transport']);
    const ids = new Set(a.topics.filter(tp => !NON_NEWS_TOPICS.has(tp)).map(tp => ASSESS.CATEGORY[tp]).filter(Boolean));
    if (!ids.size) return '';
    return resolveCategory(ids, t);
  };

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

  const FEED_CAT = { demo:'demo', kebakaran:'fire', banjir:'flood', bencana:'disaster', insiden:'insiden', kriminal:'kriminal', kesehatan:'kesehatan', keracunan:'kesehatan', ekonomi:'ekonomi', politik:'politik', siber:'siber', lingkungan:'disaster' };
  const feedCatOf = id => FEED_CAT[String(id || '').toLowerCase().split('·').pop().trim()] || '';

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
    ranked.sort((a, b) => (ord[a.cat] ?? 9) - (ord[b.cat] ?? 9) || (b.ts || 0) - (a.ts || 0));
    const prev = cache.get('breaking');
    if (!ranked.length && prev && prev.v && prev.v.items && prev.v.items.length) return { ...prev.v, at: Date.now(), stale: true };
    return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, items: ranked, total: matched, at: Date.now(), cycle: 45 };
  });

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
        const sc = a;
        if (sc.findings.length && sc.findings.every(f => f.scope !== 'Indonesia')) continue;
        if (!sc.findings.length && ev.fr) continue;
        if (a.topics.length && a.topics.every(t => ASSESS.FEED_ONLY.has(t))) continue;

        const age = it.ts ? Math.max(0, now - it.ts) : 12 * 3600e3;
        if (!Number.isFinite(it.ts) || it.ts <= 0 || it.ts > now || age > GEO_WINDOW) continue;
        const k = breakNorm(it.title).slice(0, 56);
        if (!k || seen.has(k)) continue;
        if (!plotOk(it.title, cat)) continue;
        const meta = catMeta(cat), dd = String(it.desc || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

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

    const prevPins = ((((cache.get('incidents') || {}).v) || {}).items) || lastIncidentPins;
    const merged = EVM.mergeEvents(out, prevPins, { normPlace: s => GEO.norm(s) });
    merged.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const items = merged.slice(0, 800);
    lastIncidentPins = items.slice();
    const nodes = buildIncidentNodes(now);
    for (const nd of nodes) items.push(nd);

    const newest = items.find(i => !i.fixed);
    const stale = !!newest && now - (newest.ts || 0) > 3 * 3600e3;
    return { ok: true, classifierVersion: SOC.CLASSIFIER_VERSION, items, total: merged.length, raw: out.length, places: GEO.NODES.length, at: now, newest: newest ? newest.ts : 0, stale };
  });

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
        const fr = ev.fr;
        if (fr) foreignN++;
        items.push({ title: cleanTitle(it.title, it.pub), url: it.url, src: s.id, ts: it.ts, assessment: projectAssessment(a),
          cat, label: meta.label, place: place ? place.name : '', foreign: fr || undefined, pub: it.pub || undefined,
          weight: +(meta.sev * recency).toFixed(3) });
        if (!fr) stats[cat]++;
      }
    }
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

  const newsRevSnapshots = new Map();
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
          const primaryHero = (mHit && mHit.hero && mHit.hero.verified && mHit.hero.url && !dupImgs.has(rdImgKey(mHit.hero.url))) ? mHit.hero.url : '';
          const bodyHero = (!primaryHero && mHit && Array.isArray(mHit.bodyImages))
            ? ((mHit.bodyImages.find(b => b && b.verified && b.url && b.width >= 360 && !dupImgs.has(rdImgKey(b.url))) || {}).url || '')
            : '';
          const heroUrl = primaryHero || bodyHero;
          const imgVerified = Boolean(heroUrl);
          const heroRejected = Boolean(mHit && !mHit.transientFailure && !imgVerified && mHit.hero && mHit.hero.status === 'rejected');
          const imgRejected = heroRejected;
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

  return {
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
    getNewsRev: () => NEWS_REV,
    getNewsHeatRev: () => newsHeatRev,
    incNewsHeatRev: () => ++newsHeatRev,
  };
}

module.exports = { createNewsService };
