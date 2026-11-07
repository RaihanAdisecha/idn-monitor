'use strict';
// Conservative, auditable rules. Topic relevance is not incident confirmation.
const GEO = require('./geocode');
const VERSION = '2026-11-07.2';
const CATEGORY = { demo:'demo', kebakaran:'fire', karhutla:'fire', banjir:'flood', gempa:'disaster', kecelakaan:'insiden', penembakan:'kriminal', pencurian:'kriminal', penangkapan:'kriminal', phk:'ekonomi', rupiah:'ekonomi', ihsg:'ekonomi', 'listrik padam':'ekonomi', wabah:'kesehatan', pemilu:'politik', politik:'politik', konflik:'politik', ransomware:'siber', 'serangan siber':'siber', 'akun dibajak':'siber', insiden:'insiden', kriminal:'kriminal', kesehatan:'kesehatan' };
const FOREIGN = /\b(jepang|japan|nepal|london|oyo|osun|nigeria|amerika|united states|texas|california|new york|brasil|brazil|filipina|philippines|thailand|malaysia|korea|china|tiongkok|inggris|britain|prancis|perancis|paris|france|eiffel|jerman|germany|australia|india|pakistan|iran|israel|palestina|palestine|ukraina|ukraine|rusia|russia|gaza|turki|turkey|meksiko|mexico|kanada|canada|vietnam|chile|argentina|spanyol|portugal|italia|belanda|swiss|swedia|norwegia|denmark|yunani|eropa|finCEN)\b/i;
const LOCAL_ORG = /\b(bmkg|bnpb|bpbd|bssn|pdn|polri|pln|kpu|bawaslu|komdigi|kominfo|bank indonesia|bursa efek indonesia|ihsg|kemenkes|kemensos|kemdikbud|kemendikdasmen|kemenhub|kejaksaan|kemenkumham|kementerian|pemkot|pemkab|pemprov|dishub|damkar|bpjs|taspen|bri|bni|mandiri)\b/i;
const CYBER_TARGET = /\b(server|sistem|jaringan|komputer|perangkat|database|situs|website|layanan|akun|data|berkas|file|rumah sakit|hospital|network|device|files|computers?)\b/i;
const CYBER_ACTION = /\b(diserang|diretas|dibobol|terinfeksi|terenkripsi|dienkripsi|dicuri|bocor|lumpuh|terganggu|dikunci|dijual|menyerang|menginfeksi|serangan|attack(?:ed)?|infect(?:ed)?|encrypt(?:ed)?|breach(?:ed)?|leak(?:ed)?|locked|stolen|hack(?:er|ed|ing|s)?|dihack\w*|dijebol|dieksploitasi|phish\w*|scam\w*|deepfake|spyware|backdoor|defac\w*|cryptojack\w*|skimming|carding|exfiltrat\w*|vishing|smishing|sextortion)\b/i;
const DENIED = /\b(tidak|tak|nggak|gak|ga|bukan|belum|no|not|never)\s+(?:ada\s+|terjadi\s+|mengalami\s+|a\s+|an\s+)?(?:gempa|tsunami|erupsi|kebakaran|banjir|longsor|kecelakaan|penembakan|serangan|kebocoran|peretasan|wabah|keracunan|phk|pemadaman|ransomware|malware|attack|breach)|\b(?:gempa|tsunami|erupsi|kebakaran|banjir|kebocoran data|peretasan|serangan siber)\b[^.!?]{0,30}\b(?:tidak terjadi|tidak benar|hoaks|hoax|palsu|dibantah)|\b(?:hoaks|hoax|video lama|kabar palsu|dibantah|denies|false claim)\b/i;
// Label penyangkalan eksplisit di level seluruh teks — sengaja TIDAK pakai DENIED
// penuh: "bukan video lama" / "gempa terjadi, bukan banjir" bukan berarti hoaks.
const DENIED_ANY = /\b(?:hoaks?|kabar palsu|false claim|misinformation|berita palsu|isu hoax)\b/i;
const EDUCATION = /\b(apa itu|pengertian|tutorial|cara (?:mencegah|mengatasi|menghapus|menghindari)|tips|edukasi|simulasi|latihan|mitigasi|kesiapsiagaan|tas bencana|go[- ]?bag|potensi|risiko|rawan|prediksi|diprediksi|andaikan|seandainya|bagaimana jika|what is|how to|exercise|simulation)\b/i;
const AID = /\b(salurkan|menyalurkan|penyaluran|donasi|rekonstruksi|rehabilitasi|kirim bantuan|pusdalops|rakor|seminar|webinar)\b/i;
const HISTORICAL = /\b(dulu|sejarah|mengenang|kilas balik|tahun lalu|bulan lalu|pekan lalu|kemarin|last (?:year|month|week)|historical|anniversary)\b|\b(?:tahun|pada)\s+(?:19\d{2}|20[012]\d)\b/i;
const QUESTION = /\b(apakah|apa benar|benarkah|katanya|rumornya|rumour|rumor|is it true)\b/i;
const WARNING = /\b(peringatan(?: dini)?|warning|status (?:awas|siaga)|waspada tsunami)\b/i;
const EVENT_ACTION = /\b(ambruk|runtuh|tenggelam|hanyut|pohon tumbang|tergelincir|dikeroyok|dibunuh|dirampok|begal|terjadi|melanda|menerjang|menghantam|merendam|menggenangi|jebol|meluap|mengguncang|diguncang|guncang|bergetar|terasa|erupsi|meletus|terbakar|dilalap|tenggelam|karam|terguling|tabrak|tabrakan|anjlok|jatuh|ditembak|tertembak|dirampok|kemalingan|ditangkap|diamankan|mengalami|terdampak|dilaporkan|laporkan|reported|hits?|struck)\b/i;
const METAPHOR = /(?:blue|blauwe)\s+tsunami|tsunami\s+(?:biru|politik|protes|suara|pemilu|dukungan|saham|cuan)|\b(?:opposition|elections?|political|politik|pemilu)\b[^.!?]{0,200}\btsunami\b|\b(?:humans?|people|manusia|jiwa|otak|hati)\b[^.!?]{0,80}\b(?:malware|virus)\b|\bwabah\s+(?:kebencian|cinta|rindu)|\bblackout\s+(?:party|music|festival|concert)/i;
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
function clauses(text) {
  return String(text || '').normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').split(/\n+|[!?;]+|\.(?=\s+[A-Za-zÀ-ɏ])/).map(s => s.trim()).filter(Boolean);
}
function classifyScope(span, target) {
  const location = GEO.locate(span);
  const foreign = FOREIGN.test(span);
  // Multiple countries in one clause are ambiguous, not a free local override.
  if (foreign) return { scope: location || LOCAL_ORG.test(span) ? 'unknown' : 'foreign', location: null };
  const local = location || LOCAL_ORG.test(span) || /\b(?:di|in|wilayah)\s+indonesia\b/i.test(span);
  return { scope: local ? 'Indonesia' : 'unknown', location: location ? { name: location.name, prov: location.prov, prec: location.prec, la: location.la, lo: location.lo } : null };
}
function concreteTarget(span, category) {
  if (category !== 'siber' && category !== 'ekonomi' && category !== 'politik') return null;
  const known = span.match(LOCAL_ORG);
  if (known) return known[0].toUpperCase();
  // Named target after an asset noun. Generic asset words alone aren't identity.
  const m = span.match(/\b(?:server|jaringan|sistem|situs|website|layanan|akun|pabrik|perusahaan|rumah sakit)\s+((?:[A-Z][\w.-]*)(?:\s+[A-Z][\w.-]*){0,3})\b/);
  return m ? m[1] : null;
}
function eventType(topic, span) {
  if (topic === 'insiden') return /tenggelam|karam/i.test(span) ? 'maritime_accident' : /ambruk|runtuh/i.test(span) ? 'collapse' : /pohon tumbang/i.test(span) ? 'tree_fall' : 'accident';
  if (topic === 'kriminal') return /narkoba/i.test(span) ? 'narcotics' : /pembunuhan|dibunuh/i.test(span) ? 'homicide' : 'violent_crime';
  if (topic === 'kesehatan') return 'health_incident';
  if (topic === 'gempa') return /tsunami/i.test(span) ? 'tsunami' : /erupsi|letusan|meletus/i.test(span) ? 'eruption' : 'earthquake';
  if (topic === 'banjir') return /longsor/i.test(span) ? 'landslide' : 'flood';
  if (topic === 'ransomware') return /ransomware/i.test(span) ? 'ransomware' : 'malware';
  if (topic === 'serangan siber') return /ransomware/i.test(span) ? 'ransomware' : /ddos/i.test(span) ? 'ddos' : /bocor|kebocoran|breach/i.test(span) ? 'data_breach' : 'intrusion';
  return topic;
}
function isReport(topic, span, location, target) {
  const identity = !!(location || target);
  switch (topic) {
    case 'kriminal': return identity && EVENT_ACTION.test(span);
    case 'kesehatan': return identity && /kasus|pasien|terjangkit|keracunan|wabah|\bklb\b|kejadian luar biasa|meninggal|dirawat|terinfeksi/i.test(span);
    case 'insiden': return identity && EVENT_ACTION.test(span);
    case 'ransomware': return CYBER_TARGET.test(span) && CYBER_ACTION.test(span) && identity;
    case 'serangan siber': case 'akun dibajak': return CYBER_ACTION.test(span) && identity;
    case 'gempa': return ((identity || EVENT_ACTION.test(span)) && /gempa|magnitudo|erupsi|letusan/i.test(span)) || (/tsunami/i.test(span) && (EVENT_ACTION.test(span) || WARNING.test(span))); 
    case 'kebakaran': case 'karhutla': case 'banjir': case 'kecelakaan': case 'penembakan': case 'pencurian': return (EVENT_ACTION.test(span) || /\b(?:kebakaran|banjir|longsor|kecelakaan|penembakan|pencurian|karhutla)(?:\s+(?:rumah|gedung|pabrik|pasar|hutan|lahan))?\s+(?:di|melanda|merendam)/i.test(span));
    case 'penangkapan': return identity && /ditangkap|diamankan|penangkapan|\bott\b/i.test(span);
    case 'demo': return identity && /unjuk rasa|aksi massa|demonstran|\bdemo\b|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia/i.test(span) && /berlangsung|turun ke jalan|berkumpul|menggelar|ricuh|bentrok|tuntut|menuntut|menolak|tolak|orasi|march|aksi/i.test(span);
    case 'wabah': return identity && /kasus|pasien|terjangkit|keracunan|wabah (?:dbd|campak|kolera|difteri)|kejadian luar biasa/i.test(span);
    case 'listrik padam': return identity && /listrik padam|mati listrik|pemadaman listrik|padam listrik|pln[^.!?]{0,40}blackout/i.test(span);
    case 'phk': return identity && /melakukan|terkena|mengalami|memutus|dirumahkan|pabrik tutup|phk[^.!?]{0,30}\d+/i.test(span);
    case 'ihsg': return /trading halt|dihentikan|anjlok|merosot|turun\s+\d/i.test(span) && !!target;
    case 'rupiah': return /melemah|menguat|anjlok/i.test(span) && /\d/.test(span) && !!target;
    case 'pemilu': return identity && /ricuh|bentrok|ditunda|dibatalkan|pemungutan suara ulang/i.test(span);
    case 'politik': return identity && /dilantik|ditetapkan|dipecat|mundur|mengundurkan|dipilih|mencalonkan|deklarasi|konvensi|divonis|kalah|menang|reshuffle|impeachment/i.test(span);
    case 'konflik': return identity && /perang|serangan|gencatan|ultimatum|invasi|kudeta|pemberontakan|tewas|meninggal|korban|menyerah|ditangkap|menolak|menyetujui|gagal|berhasil|mundur|meluas|memanas|menewaskan/i.test(span);
    default: return false; // ad-hoc relevance is never event evidence by itself.
  }
}
function assess(text, registry, options = {}) {
  const raw = String(text || '');
  const spans = clauses(raw), findings = [], topics = new Set(), reasons = new Set();
  const spam = options.spam && options.spam.test(raw);
  // Penanda bantahan ("hoaks", "video lama") sering di klausa terpisah dari topiknya.
  const deniedAny = DENIED_ANY.test(raw);
  for (const tp of registry) {
    for (const span of spans) {
      if (!tp.pos.test(span)) continue;
      const metaphor = METAPHOR.test(span) || (options.noise && options.noise.test(span)) || (tp.neg && tp.neg.test(span));
      if (metaphor) { reasons.add('metaphor_or_nonincident_usage'); continue; }
      // Ambiguous words need context even for topic membership, not the same keyword repeated.
      if (tp.ctx && !(tp.strong && tp.strong.test(span)) && !tp.ctx.test(span)) { reasons.add('insufficient_topic_context'); continue; }
      topics.add(tp.id);
      const category = CATEGORY[tp.id];
      const target = concreteTarget(span, category);
      const { scope, location } = classifyScope(span, target);
      let reportType = deniedAny || DENIED.test(span) ? 'denied' : HISTORICAL.test(span) ? 'historical' : WARNING.test(span) ? 'warning' : EDUCATION.test(span) ? 'educational' : AID.test(span) ? 'response' : QUESTION.test(span) ? 'unverified_question' : 'commentary';
      const report = isReport(tp.id, span, location, target);
      if (reportType === 'commentary' && report) reportType = 'reported';
      const eligible = !spam && scope === 'Indonesia' && !!(location || target) && report && (reportType === 'reported' || reportType === 'warning');
      if (scope !== 'Indonesia') reasons.add(scope === 'foreign' ? 'foreign_scope' : 'scope_not_established');
      if (!report) reasons.add('no_concrete_event');
      if (!eligible) reasons.add(reportType);
      findings.push({ topic: tp.id, category: category || null, type: eventType(tp.id, span), location, target, scope, reportType, signalEligible: eligible, evidence: span, severity: reportType === 'warning' ? 'warning' : 'unknown' });
    }
  }
  if (spam) reasons.add('spam');
  const events = findings.filter(f => f.signalEligible);
  const eligible = events.length > 0;
  const scope = eligible ? 'Indonesia' : findings.some(f => f.scope === 'Indonesia') ? 'Indonesia' : findings.length && findings.every(f => f.scope === 'foreign') ? 'foreign' : 'unknown';
  const reportType = eligible ? (events.every(f => f.reportType === 'warning') ? 'warning' : 'reported') : findings[0]?.reportType || 'irrelevant';
  const feedEligible = !spam && topics.size > 0 && findings.some(f => f.scope === 'Indonesia' || (f.scope === 'unknown' && ['reported', 'warning'].includes(f.reportType)));
  return { version: VERSION, topics: spam ? [] : [...topics], scope, reportType, feedEligible, signalEligible: eligible, events, findings, reasons: [...reasons], severity: eligible && events.some(f => f.severity === 'warning') ? 'warning' : 'unknown' };
}
module.exports = { VERSION, CATEGORY, assess, norm, clauses, classifyScope };
