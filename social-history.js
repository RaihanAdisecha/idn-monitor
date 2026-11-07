'use strict';
const SOC = require('./social');
const AGE = 24 * 3600e3;
const keyOf = p => p.url || p.code || p.text || '';
const tsOf = p => Number(p.ts) || Date.parse(p.created_at || '') || 0;
function tag(p, extra = [], now = Date.now()) {
  const ts = tsOf(p);
  if (!Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > AGE) return false;
  const text = String(p.text || '');
  // prioritas ID + EN: aksara non-Latin/Vietnam-diakritik dominan = spam luar negeri;
  // hashtag-stuffing = kampanye/crypto, bukan konten kejadian
  if (SOC.socNonLatin(text) || SOC.socVi(text) || SOC.socHashJunk(text) || SOC.socForeignLang(text)) return false;
  p.ts = ts;
  p.assessment = SOC.socAssess(p.text, extra);
  p.topics = p.assessment.topics.slice();
  p.qs = p.topics.slice(); // compatibility only, never query provenance
  p.adhocPhrases = extra.filter(t => t.adhoc && p.topics.includes(t.id)).map(t => t.id);
  return p.topics.length > 0;
}
function retag(map, keep, extra = [], now = Date.now()) {
  for (const [key, p] of map) {
    // Restore the bounded literal ad-hoc registry from saved phrases, never trust saved tags.
    const stored = SOC.socAdhoc((p.adhocPhrases || []).filter(s => typeof s === 'string' && s.length <= 60));
    const defs = [...new Map(extra.concat(stored).map(t => [t.id, t])).values()];
    if (!tag(p, defs, now) || !keep(p)) map.delete(key);
  }
}
function snapshot(map, now = Date.now()) {
  return { ok: true, snapshot: true, classifierVersion: SOC.CLASSIFIER_VERSION, snapshotAt: now,
    posts: [...map.values()].sort((a, b) => tsOf(b) - tsOf(a)), at: now, coverage: 'sampled' };
}
module.exports = { AGE, keyOf, tsOf, tag, retag, snapshot };
