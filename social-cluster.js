'use strict';

const OFFICIAL_HANDLES = new Set([
  'infobmkg', 'bnpb_indonesia', 'basarnas', 'damkardki', 'tmcpoldametro',
  'halo_polisi', 'divhumas_polri', 'puspentni', 'kemkesri', 'bssn_ri',
  'pvmbg_', 'pvmbg', 'bpbd_dki', 'bpbdjabar', 'bpbdjatim', 'bpbdjateng',
  'pln_123', 'infobps', 'kemenhub151', 'komdigi_id', 'kemenkominfo',
]);

const OFFICIAL_HANDLE_RE = /^(?:info)?(?:bmkg|bnpb|bpbd|basarnas|pvmbg|bssn|damkar|polres|polda|polsek|tmcpolda|divhumas|puspen|kemkes|kemenkes|kemenhub|komdigi|pemprov|pemkot|pemkab)(?:[._-]|$)/i;

const NEWS_OUTLET_HANDLES = new Set([
  'detikcom', 'kompascom', 'kompastv', 'cnnindonesia', 'cnbcindonesia',
  'antaranews', 'liputan6', 'tempodotco', 'tribunnews', 'tribunjogja',
  'republikaonline', 'merdekadotcom', 'sindonews', 'okezonecom', 'jawapos',
  'inewsdotid', 'tvonenews', 'metrotv', 'elshinta', 'elshinta90fm',
  'suarasurabayamedia', 'kumparancom', 'vivanews', 'bisniscom', 'kontannews',
  'rri_co_id', 'beritasatu', 'idntimes', 'tirtoid', 'vice_id',
]);

const NEWS_HANDLE_RE = /(?:detik|kompas|cnnind|cnbcind|antara|liputan6|tempo|tribun|republika|merdeka|sindo|okezone|jawapos|inews|tvone|metrotv|elshinta|suarasurabaya|kumparan|beritasatu|rri)(?:com|tv|id|news|dotco|fm|media)?$/i;

const PROVENANCE_WEIGHTS = Object.freeze({
  official_agency: 1.0,
  news_outlet: 0.85,
  eyewitness: 0.72,
  anonymous: 0.35,
});

const STOP_WORDS = new Set((
  'yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat ' +
  'para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika ' +
  'hari minggu senin selasa rabu kamis jumat sabtu kini tadi barusan sekarang baru saja info update berita ' +
  'kabar terkini viral breaking news via oleh rt'
).split(' '));

function cleanHandle(post) {
  return String((post && (post.handle || post.username || post.user)) || '')
    .toLowerCase()
    .replace(/^@/, '')
    .trim();
}

function classifySourceProvenance(post, assessment) {
  const handle = cleanHandle(post);
  const a = assessment || (post && post.assessment) || null;
  const text = String((post && post.text) || '');

  let sourceType = 'anonymous';
  let reason = 'unverified_social_account';

  if (handle && (OFFICIAL_HANDLES.has(handle) || OFFICIAL_HANDLE_RE.test(handle))) {
    sourceType = 'official_agency';
    reason = 'verified_official_handle';
  } else if (handle && (NEWS_OUTLET_HANDLES.has(handle) || NEWS_HANDLE_RE.test(handle))) {
    sourceType = 'news_outlet';
    reason = 'recognized_news_handle';
  } else if (a && a.intent === 'eyewitness_report' && !/^\s*RT\s+@/i.test(text)) {
    sourceType = 'eyewitness';
    reason = 'firsthand_eyewitness_markers';
  } else if (a && a.event && a.event.sourceType === 'eyewitness' && !/^\s*RT\s+@/i.test(text)) {
    sourceType = 'eyewitness';
    reason = 'eyewitness_event_framing';
  }

  return {
    sourceType,
    authorityWeight: PROVENANCE_WEIGHTS[sourceType] || 0.35,
    handle: handle ? '@' + handle : '',
    reason,
    engagementExcludedFromCredibility: true,
  };
}

function stripBoilerplateForSimilarity(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(?:rt|repost)\s+@[\w.]+:?\s*/i, '')
    .replace(/\b(?:via|sumber|source|credit|cc)\s*[:@]?\s*@?[\w.]+\b/gi, ' ')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityTokens(text) {
  const clean = stripBoilerplateForSimilarity(text);
  return [...new Set(clean.split(' ').filter(w => w.length >= 3 && !STOP_WORDS.has(w)))];
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = tokensA instanceof Set ? tokensA : new Set(tokensA);
  const setB = tokensB instanceof Set ? tokensB : new Set(tokensB);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

function isNearDuplicate(textA, textB, threshold = 0.78) {
  const normA = stripBoilerplateForSimilarity(textA);
  const normB = stripBoilerplateForSimilarity(textB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const tokA = similarityTokens(normA);
  const tokB = similarityTokens(normB);
  if (tokA.length < 3 || tokB.length < 3) return false;
  return jaccardSimilarity(tokA, tokB) >= threshold;
}

function canonicalUrlKey(post) {
  const u = String((post && post.url) || '').trim().toLowerCase().replace(/\?.*$/, '').replace(/\/+$/, '');
  return u || String((post && post.code) || '').trim();
}

function deduplicatePosts(posts) {
  const sorted = (posts || []).slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  const unique = [];
  const seenUrls = new Set();
  const seenExact = new Map();

  for (const p of sorted) {
    if (!p || !p.text) continue;
    const uKey = canonicalUrlKey(p);
    const plat = String(p.from || p.platform || (p.code ? 'threads' : 'x')).toLowerCase();
    if (uKey && seenUrls.has(plat + '|' + uKey)) continue;
    if (uKey) seenUrls.add(plat + '|' + uKey);

    const norm = stripBoilerplateForSimilarity(p.text);
    if (!norm) continue;

    if (seenExact.has(norm)) {
      const parent = seenExact.get(norm);
      parent.duplicateCount++;
      parent.repostVariants.push({ platform: plat, handle: cleanHandle(p), url: p.url || '' });
      continue;
    }

    const pToks = new Set(similarityTokens(norm));
    let matched = null;
    const startIdx = Math.max(0, unique.length - 200);
    for (let i = startIdx; i < unique.length; i++) {
      const cand = unique[i];
      if (pToks.size >= 4 && cand._toks.size >= 4 && jaccardSimilarity(pToks, cand._toks) >= 0.78) {
        matched = cand;
        break;
      }
    }
    if (matched) {
      matched.duplicateCount++;
      matched.repostVariants.push({ platform: plat, handle: cleanHandle(p), url: p.url || '' });
      continue;
    }

    const entry = {
      post: p,
      norm,
      _toks: pToks,
      duplicateCount: 1,
      repostVariants: [{ platform: plat, handle: cleanHandle(p), url: p.url || '' }],
    };
    seenExact.set(norm, entry);
    unique.push(entry);
  }

  return unique.map(({ _toks, ...rest }) => rest);
}

const GENERIC_EVENT_TOKENS = new Set([
  'banjir', 'gempa', 'kebakaran', 'kecelakaan', 'longsor', 'demo', 'unjuk', 'rasa',
  'warga', 'rumah', 'jalan', 'kota', 'kabupaten', 'provinsi', 'indonesia', 'jakarta',
  'bandung', 'surabaya', 'bekasi', 'depok', 'bogor', 'tangerang', 'semarang',
  'terjadi', 'melanda', 'merendam', 'terbakar', 'ambruk', 'korban', 'evakuasi',
  'luka', 'tewas', 'meninggal', 'polisi', 'bpbd', 'bmkg', 'damkar', 'bnpb',
]);

function eventSpecificTokens(evText, placeName) {
  const placeSet = new Set(String(placeName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return new Set(
    similarityTokens(evText).filter(t => t.length >= 4 && !GENERIC_EVENT_TOKENS.has(t) && !placeSet.has(t))
  );
}

const RARE_TYPES = new Set(['earthquake', 'tsunami', 'eruption', 'ransomware', 'data_breach', 'ddos', 'maritime_accident', 'wildfire']);

function canClusterEvents(evA, evB, timeWindowMs) {
  if (!evA || !evB) return false;
  if (Math.abs((evA.ts || 0) - (evB.ts || 0)) > timeWindowMs) return false;
  if (evA.category !== evB.category || evA.eventType !== evB.eventType) return false;

  const locA = String(evA.locationName || '').toLowerCase().trim();
  const locB = String(evB.locationName || '').toLowerCase().trim();
  if (locA && locB && locA !== locB) return false;
  if (!locA || !locB) {

    const tA = String(evA.target || '').toLowerCase().trim();
    const tB = String(evB.target || '').toLowerCase().trim();
    if (!tA || !tB || tA !== tB) return false;
  }

  const provA = String(evA.prov || '').toLowerCase().trim();
  const provB = String(evB.prov || '').toLowerCase().trim();
  if (provA && provB && provA !== provB) return false;

  let shared = 0;
  for (const t of evA.specTokens) if (evB.specTokens.has(t)) shared++;
  const union = evA.specTokens.size + evB.specTokens.size - shared;
  const jac = union ? shared / union : 0;

  if (RARE_TYPES.has(evA.eventType)) {
    return shared >= 1 && jac >= 0.12;
  }
  return shared >= 2 && jac >= 0.18;
}

function clusterIncidents(posts, opts = {}) {
  const timeWindowMs = opts.timeWindowMs || 90 * 60 * 1000;
  const eligible = (posts || []).filter(p => p && p.assessment && p.assessment.signalEligible === true && Array.isArray(p.assessment.events) && p.assessment.events.length > 0);
  const deduped = deduplicatePosts(eligible);

  const clusters = [];
  for (const item of deduped) {
    const p = item.post;
    const prov = p.assessment.provenance || classifySourceProvenance(p, p.assessment);
    const ev = p.assessment.events[0];
    const locName = (ev.location && ev.location.name) || '';
    const record = {
      post: p,
      duplicateCount: item.duplicateCount,
      repostVariants: item.repostVariants,
      provenance: prov,
      ts: Number(p.ts) || Date.parse(p.created_at || '') || 0,
      category: ev.category,
      eventType: ev.type,
      locationName: locName,
      prov: (ev.location && ev.location.prov) || '',
      target: ev.target || '',
      specTokens: eventSpecificTokens(ev.evidence || p.text, locName),
    };

    const match = clusters.find(cl => cl.records.every(r => canClusterEvents(r, record, timeWindowMs)));
    if (match) {
      match.records.push(record);
    } else {
      clusters.push({ records: [record] });
    }
  }

  return clusters.map(cl => {
    const independentAccounts = new Set();
    const platforms = new Set();
    const sourceTypes = new Set();
    let totalCopies = 0;
    let maxAuth = 0;
    let latestTs = 0;

    for (const r of cl.records) {
      totalCopies += r.duplicateCount;
      for (const v of r.repostVariants) platforms.add(v.platform);
      if (r.provenance.handle) independentAccounts.add(r.provenance.sourceType + ':' + r.provenance.handle);
      sourceTypes.add(r.provenance.sourceType);
      if (r.provenance.authorityWeight > maxAuth) maxAuth = r.provenance.authorityWeight;
      if (r.ts > latestTs) latestTs = r.ts;
    }

    const hasOfficial = sourceTypes.has('official_agency');
    const hasNews = sourceTypes.has('news_outlet');
    const hasEyewitness = sourceTypes.has('eyewitness');
    const independentClaims = cl.records.length;

    const corroborationLevel = hasOfficial
      ? 'official_confirmed'
      : (independentClaims >= 2 && (hasNews || hasEyewitness || independentAccounts.size >= 2))
        ? 'multi_source_corroborated'
        : hasEyewitness
          ? 'single_source_eyewitness'
          : 'uncorroborated';

    const sortedRecs = cl.records.slice().sort((a, b) => (b.provenance.authorityWeight - a.provenance.authorityWeight) || (b.ts - a.ts));
    const rep = sortedRecs[0];

    return {
      category: rep.category,
      eventType: rep.eventType,
      location: rep.locationName || rep.target || 'unknown',
      latestTs,
      independentClaims,
      independentAccounts: independentAccounts.size,
      totalCopiesWithDuplicates: totalCopies,
      platforms: [...platforms],
      corroborationLevel,
      hasOfficialSource: hasOfficial,
      hasNewsOutlet: hasNews,
      hasEyewitness,
      authorityScore: +maxAuth.toFixed(2),
      representative: rep.post,
      posts: sortedRecs.map(r => r.post),
    };
  }).sort((a, b) => (b.authorityScore - a.authorityScore) || (b.latestTs - a.latestTs));
}

module.exports = {
  OFFICIAL_HANDLES,
  NEWS_OUTLET_HANDLES,
  PROVENANCE_WEIGHTS,
  classifySourceProvenance,
  stripBoilerplateForSimilarity,
  similarityTokens,
  jaccardSimilarity,
  isNearDuplicate,
  deduplicatePosts,
  clusterIncidents,
};
