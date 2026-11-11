'use strict';
const SOC = require('./social');

const AGE = 24 * 3600e3;
const DROP_STATS = {
  total: 0,
  age: 0,
  handle: 0,
  lang: 0,
  foreign: 0,
  reportType: 0,
  bodyLen: 0,
  feedEligible: 0,
  noTopic: 0,
  lanes: { incident_signals: 0, situational_context: 0, discovery_candidates: 0, rejected: 0 },
};

const keyOf = p => {
  if (p.url || p.code) return p.url || p.code;
  const text = p.text || '';
  if (!text) return '';
  const h = String(p.created_at || '') + '|' + String(p.author || p.username || p.user || '');
  let x = 5381;
  for (let i = 0; i < h.length; i++) x = ((x << 5) + x + h.charCodeAt(i)) >>> 0;
  return text + '#' + x.toString(36);
};

const tsOf = p => Number(p.ts) || Date.parse(p.created_at || '') || 0;
const bodyLen = s => String(s).replace(/https?:\/\/\S+/g, ' ').replace(/[#@]\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').length;
const tagSigOf = (extra = []) => {
  const ids = (Array.isArray(extra) ? extra : []).map(t => (t && t.id) || '').filter(Boolean).sort();
  return String(SOC.CLASSIFIER_VERSION || '') + '|' + ids.join(',');
};

function tag(p, extra = [], now = Date.now(), meta = {}) {
  DROP_STATS.total++;
  const ts = tsOf(p);
  if (!Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > AGE) { DROP_STATS.age++; return false; }
  if (typeof p.text === 'string' && p.text.includes('&')) {
    p.text = p.text.replace(/&amp;?/gi, '&').replace(/&lt;?/gi, '<').replace(/&gt;?/gi, '>').replace(/&quot;?/gi, '"').replace(/&#0*39;?|&apos;?/gi, "'");
  }
  const text = String(p.text || '');
  const handle = String(p.handle || p.username || p.user || '').toLowerCase().replace(/^@/, '');
  if (/^(501awani|bernamadotcom|beritartm|astroawani|utusanonline|sinarharian|bharianmy|hmetromy|malaysiakini|thesiakapkeli|siakapkeli|ohbulanofficial|mstaronline|kosmo_online)$/i.test(handle)) { DROP_STATS.handle++; return false; }
  if (SOC.socNonLatin(text) || SOC.socVi(text) || SOC.socHashJunk(text) || SOC.socForeignLang(text)) { DROP_STATS.lang++; return false; }
  if (SOC.SOC_FOREIGN_RE.test(text) && !SOC.SOC_LOCAL_RE.test(text)) { DROP_STATS.foreign++; return false; }
  p.ts = ts;

  const isAdhocQuery = Boolean(p.q && String(p.q).startsWith('adhoc'));
  const discoverySource = meta.discoverySource || (p.q && String(p.q).startsWith('@') ? 'profile' : isAdhocQuery ? 'adhoc' : 'permanent');
  const assessCtx = {
    platform: meta.platform || (p.code ? 'threads' : 'x'),
    discoverySource,
    handle: p.handle || p.username || p.user || '',
    username: p.username || '',
    user: p.user || '',
    recordDiagnostics: !!meta.recordDiagnostics,
  };

  p.assessment = SOC.socAssess(p.text, extra, assessCtx);
  const lane = p.assessment.feedLane || (p.assessment.signalEligible ? 'incident_signals' : p.assessment.feedEligible ? 'situational_context' : 'rejected');
  if (Object.prototype.hasOwnProperty.call(DROP_STATS.lanes, lane)) {
    DROP_STATS.lanes[lane]++;
  }

  if (['denied', 'historical', 'educational'].includes(p.assessment.reportType)) { DROP_STATS.reportType++; return false; }
  const hasMedia = (Array.isArray(p.media) && p.media.length > 0) || (Array.isArray(p.images) && p.images.length > 0) || !!p.has_media;
  if (bodyLen(p.text) < 10 && !hasMedia) { DROP_STATS.bodyLen++; return false; }
  if (!p.assessment.feedEligible) { DROP_STATS.feedEligible++; return false; }

  p.topics = p.assessment.topics.slice();
  p.qs = p.topics.slice();
  p.adhocPhrases = extra.filter(t => t.adhoc && p.topics.includes(t.id) && !SOC.isGenericLocationPhrase(t.id)).map(t => t.id);
  if (!p.topics.length) { DROP_STATS.noTopic++; return false; }
  p._tagSig = tagSigOf(extra);
  return true;
}

function retag(map, keep, extra = [], now = Date.now(), opts = {}) {
  const recordDiagnostics = !!(opts && opts.recordDiagnostics);
  const curSig = tagSigOf(extra);
  const defs = Array.isArray(extra) ? extra : [];
  const activeAdhoc = new Set(defs.filter(t => t && t.adhoc && t.id).map(t => t.id));
  for (const [key, p] of map) {
    if (!p) { map.delete(key); continue; }
    const ts = tsOf(p);
    if (!Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > AGE) {
      map.delete(key);
      continue;
    }
    const savedAdhoc = (p.adhocPhrases || []).filter(s => typeof s === 'string' && s.length <= 60 && !SOC.isGenericLocationPhrase(s));
    const hasStaleAdhoc = savedAdhoc.some(s => !activeAdhoc.has(String(s).toLowerCase()));
    if (!recordDiagnostics && !hasStaleAdhoc && p._tagSig === curSig && p.assessment && p.assessment.version) {
      if (['denied', 'historical', 'educational'].includes(p.assessment.reportType) ||
          !p.assessment.feedEligible || !Array.isArray(p.topics) || !p.topics.length || !keep(p)) {
        map.delete(key);
      }
      continue;
    }

    if (!tag(p, defs, now, { recordDiagnostics }) || !keep(p)) map.delete(key);
  }
}

function snapshot(map, now = Date.now()) {
  return {
    ok: true,
    snapshot: true,
    classifierVersion: SOC.CLASSIFIER_VERSION,
    snapshotAt: now,
    posts: [...map.values()].sort((a, b) => tsOf(b) - tsOf(a)),
    at: now,
    coverage: 'sampled',
  };
}

module.exports = { AGE, DROP_STATS, keyOf, tsOf, tag, retag, snapshot };
