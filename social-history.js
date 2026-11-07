'use strict';
const SOC = require('./social');
// AGE (24 jam) adalah batas KESEGARAN TAG saat retag. Window ingest di server.js
// (48h/72h) sengaja LEBIH PANJANG: post yang lebih tua dari AGE tetap disimpan
// tapi tidak ikut feed sampai ada konteks baru — jangan "perbaiki" jadi sama.
const AGE = 24 * 3600e3;
const keyOf = p => {
  if (p.url || p.code) return p.url || p.code;
  const text = p.text || '';
  if (!text) return '';
  // Teks tanpa url/code: dua post berbeda bisa berisi kalimat identik — hash
  // created_at+author supaya tidak saling menimpa di map.
  const h = String(p.created_at || '') + '|' + String(p.author || p.username || p.user || '');
  let x = 5381;
  for (let i = 0; i < h.length; i++) x = ((x << 5) + x + h.charCodeAt(i)) >>> 0;
  return text + '#' + x.toString(36);
};
const tsOf = p => Number(p.ts) || Date.parse(p.created_at || '') || 0;
// Huruf efektif setelah bersih-bersih: nolak post isi-minim seperti "#banjir".
const bodyLen = s => String(s).replace(/https?:\/\/\S+/g, ' ').replace(/[#@]\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').length;
function tag(p, extra = [], now = Date.now()) {
  const ts = tsOf(p);
  if (!Number.isFinite(ts) || ts <= 0 || ts > now || now - ts > AGE) return false;
  const text = String(p.text || '');
  // prioritas ID + EN: aksara non-Latin/Vietnam-diakritik dominan = spam luar negeri;
  // hashtag-stuffing = kampanye/crypto, bukan konten kejadian
  if (SOC.socNonLatin(text) || SOC.socVi(text) || SOC.socHashJunk(text) || SOC.socForeignLang(text)) return false;
  p.ts = ts;
  p.assessment = SOC.socAssess(p.text, extra);
  // denied/historical/educational = bukan materi liputan feed
  if (['denied', 'historical', 'educational'].includes(p.assessment.reportType)) return false;
  if (bodyLen(p.text) < 10) return false;
  // feedEligible = ada finding scope Indonesia, atau reported/warning walau scope unknown.
  // Tanpa ini, obrolan topik tanpa lokasi & tanpa kejadian (commentary+unknown) membanjiri feed.
  if (!p.assessment.feedEligible) return false;
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
