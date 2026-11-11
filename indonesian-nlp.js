'use strict';

const crypto = require('crypto');
const GEO = require('./geocode');

let francModule = null;
try {
  const f = require('franc');
  francModule = f.franc || f;
} catch (_) {}

const INTENTS = Object.freeze([
  'incident_report',
  'official_warning',
  'official_update',
  'eyewitness_report',
  'personal_experience',
  'discussion',
  'opinion',
  'personal_vent',
  'question',
  'commercial_listing',
  'advertisement',
  'spam',
  'educational',
  'historical',
  'satire',
  'rumor',
  'denial_or_debunk',
  'unrelated',
  'unknown',
]);

const FEED_LANES = Object.freeze({
  INCIDENT_SIGNALS: 'incident_signals',
  SITUATIONAL_CONTEXT: 'situational_context',
  DISCOVERY_CANDIDATES: 'discovery_candidates',
  REJECTED: 'rejected',
});

const GEO_ROLES = Object.freeze({
  EVENT_LOCATION: 'event_location',
  AUTHOR_CURRENT_LOCATION: 'author_current_location',
  AUTHOR_HOMETOWN: 'author_hometown',
  READER_LOCATION: 'reader_location',
  MENTIONED_IN_PASSING: 'mentioned_in_passing',
  NEWS_SOURCE_LOCATION: 'news_source_location',
  HISTORICAL_LOCATION: 'historical_location',
  AMBIGUOUS_ENTITY: 'ambiguous_entity',
  UNKNOWN: 'unknown',
});

const REJECT_REASONS = Object.freeze({
  COMMERCIAL_LISTING: 'commercial_listing',
  ADVERTISEMENT: 'advertisement',
  PERSONAL_VENT: 'personal_vent',
  GENERIC_LOCATION_MENTION: 'generic_location_mention',
  NO_CONCRETE_EVENT: 'no_concrete_event',
  LOCATION_NOT_EVENT_LOCATION: 'location_not_event_location',
  HISTORICAL_REFERENCE: 'historical_reference',
  METAPHORICAL_LANGUAGE: 'metaphorical_language',
  QUESTION_WITHOUT_EVENT_EVIDENCE: 'question_without_event_evidence',
  SPAM_OR_ENGAGEMENT_BAIT: 'spam_or_engagement_bait',
  LOW_CONFIDENCE: 'low_confidence',
  UNRELATED_TOPIC: 'unrelated_topic',
  NEGATED_INCIDENT: 'negated_incident',
  DENIAL_OR_DEBUNK: 'denial_or_debunk',
  FOREIGN_SCOPE: 'foreign_scope',
  EDUCATIONAL_CONTENT: 'educational_content',
  OPINION_OR_COMMENTARY: 'opinion_or_commentary',
});

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&#(x[0-9a-fA-F]+|\d+);?/g, (_, n) => {
      const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)
        ? String.fromCodePoint(cp)
        : '';
    })
    .replace(/&(lt|gt|quot|apos|nbsp|mdash|ndash|hellip);/gi, (_, k) => ({
      lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…',
    }[k.toLowerCase()] || _))
    .replace(/&amp;/gi, '&');
}

const SLANG_MAP = Object.freeze({

  ngga: 'tidak', nggak: 'tidak', engga: 'tidak', enggak: 'tidak',
  gak: 'tidak', ga: 'tidak', gk: 'tidak', kaga: 'tidak', kagak: 'tidak',
  ndak: 'tidak', ora: 'tidak', teu: 'tidak', tdk: 'tidak', tak: 'tidak',
  blm: 'belum', acan: 'belum', durung: 'belum',
  bkn: 'bukan',

  gw: 'saya', gue: 'saya', gua: 'saya', aku: 'saya', aq: 'saya', sy: 'saya',
  lu: 'kamu', lo: 'kamu', loe: 'kamu', elu: 'kamu',
  org: 'orang', wrg: 'warga', rmh: 'rumah', omah: 'rumah', imah: 'rumah',
  dln: 'jalan', dalan: 'jalan', jln: 'jalan',

  udh: 'sudah', udah: 'sudah', sdh: 'sudah', wis: 'sudah', geus: 'sudah',
  skrg: 'sekarang', skg: 'sekarang', saiki: 'sekarang', ayeuna: 'sekarang',
  kmrn: 'kemarin', kmaren: 'kemarin', wingi: 'kemarin', kamari: 'kemarin',
  biyen: 'dulu', baheula: 'dulu',
  td: 'tadi', mlm: 'malam',

  yg: 'yang', dgn: 'dengan', dlm: 'dalam', utk: 'untuk', u: 'untuk',
  krn: 'karena', karna: 'karena', bgt: 'banget', bngt: 'banget',
  cuma: 'hanya', cuman: 'hanya', cm: 'hanya', cmn: 'hanya',
  bener: 'benar', beneran: 'benar', emg: 'memang', emang: 'memang',
  jd: 'jadi', jgn: 'jangan', msh: 'masih', bbrp: 'beberapa',
  gmn: 'bagaimana', gimana: 'bagaimana', knp: 'kenapa',
  dmn: 'dimana', kpn: 'kapan', brp: 'berapa',
  sblm: 'sebelum', stlh: 'setelah', bnyk: 'banyak', sm: 'sama', dr: 'dari',
  klo: 'kalau', kl: 'kalau', klw: 'kalau',

  ujan: 'hujan', udan: 'hujan',
  kebakar: 'terbakar', kobongan: 'kebakaran', kahuruan: 'kebakaran',
  kejebak: 'terjebak', kerasa: 'terasa', keseret: 'terseret',
  lindhu: 'gempa',
  caah: 'banjir',
  banyu: 'air', cai: 'air', caina: 'airnya',
  ambrol: 'ambruk', mlebu: 'masuk', asup: 'masuk', munggah: 'naik',
  cepet: 'cepat', cepet2: 'cepat',

  flooding: 'banjir', flooded: 'terendam banjir',
  earthquake: 'gempa', landslide: 'longsor', wildfire: 'karhutla',
  collapsed: 'ambruk', collapse: 'ambruk',
  evacuation: 'evakuasi', evacuated: 'dievakuasi',
  explosion: 'ledakan', exploded: 'meledak',
  shooting: 'penembakan', robbery: 'perampokan',
  blackout: 'listrik padam',
});

const GEO_ABBR_MAP = Object.freeze({
  jkt: 'jakarta',
  jaksel: 'jakarta selatan',
  jaktim: 'jakarta timur',
  jakbar: 'jakarta barat',
  jakut: 'jakarta utara',
  jakpus: 'jakarta pusat',
  bdg: 'bandung',
  sby: 'surabaya',
  smg: 'semarang',
  bks: 'bekasi',
  bgr: 'bogor',
  tgr: 'tangerang',
  tangsel: 'tangerang selatan',
  mks: 'makassar',
  mdn: 'medan',
  dps: 'denpasar',
  plg: 'palembang',
  jogja: 'yogyakarta',
  yogya: 'yogyakarta',
});

const HASHTAG_LEXICON = [
  'jakarta selatan', 'jakarta timur', 'jakarta barat', 'jakarta utara', 'jakarta pusat',
  'tangerang selatan', 'bandung', 'surabaya', 'semarang', 'makassar', 'yogyakarta',
  'palembang', 'denpasar', 'balikpapan', 'banjarmasin', 'pontianak', 'pekanbaru',
  'samarinda', 'manado', 'jayapura', 'mataram', 'kupang', 'kendari', 'palu',
  'jakarta', 'bekasi', 'depok', 'bogor', 'tangerang', 'medan', 'aceh', 'bali',
  'jatim', 'jateng', 'jabar', 'sumut', 'sumbar', 'sumsel', 'kaltim', 'kalbar',
  'kalsel', 'sulsel', 'papua', 'garut', 'cianjur', 'sukabumi', 'cirebon', 'malang',
  'kebumen', 'lampung', 'riau', 'jambi', 'banten', 'solo', 'jogja', 'ntb', 'ntt',
  'kebakaranhutan', 'banjirbandang', 'putingbeliung', 'tangguljebol', 'unjukrasa',
  'aksimassa', 'anginkencang', 'serangansiber', 'kebocorandata', 'keracunanmassal',
  'kebakaran', 'karhutla', 'banjir', 'longsor', 'gempa', 'tsunami', 'erupsi',
  'kecelakaan', 'tabrakan', 'ledakan', 'ambruk', 'penembakan', 'pencurian',
  'perampokan', 'begal', 'demo', 'ricuh', 'bentrok', 'wabah', 'keracunan',
  'listrik', 'padam', 'ransomware', 'peretasan', 'phishing', 'loker', 'dijual',
  'disewa', 'promo', 'diskon', 'info', 'update', 'berita', 'waspada', 'siaga',
  'darurat', 'hujan', 'badai', 'cuaca', 'bmkg', 'bpbd', 'bnpb', 'damkar',
  'timur', 'barat', 'selatan', 'utara', 'pusat', 'hari', 'ini', 'terkini',
  'indonesia', 'kota', 'rumah', 'warga',
].sort((a, b) => b.length - a.length);

function segmentHashtag(tag) {
  const clean = String(tag || '').replace(/^#+/, '').trim();
  if (!clean) return '';

  const spaced = clean
    .replace(/_+/g, ' ')
    .replace(/([a-z\p{Ll}])([A-Z\p{Lu}])/gu, '$1 $2')
    .replace(/([A-Za-z\p{L}])(\d)/gu, '$1 $2')
    .replace(/(\d)([A-Za-z\p{L}])/gu, '$1 $2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const parts = [];
  for (const seg of spaced.split(' ')) {
    if (seg.length <= 6) {
      parts.push(seg);
      continue;
    }

    let rest = seg;
    const out = [];
    let guard = 0;
    while (rest.length > 0 && guard++ < 12) {
      const hit = HASHTAG_LEXICON.find(w => rest.startsWith(w));
      if (hit) {
        out.push(hit);
        rest = rest.slice(hit.length);
      } else {

        let splitAt = -1;
        for (let i = 3; i < rest.length - 2; i++) {
          const tail = rest.slice(i);
          if (HASHTAG_LEXICON.some(w => tail === w || tail.startsWith(w))) {
            splitAt = i;
            break;
          }
        }
        if (splitAt > 0) {
          out.push(rest.slice(0, splitAt));
          rest = rest.slice(splitAt);
        } else {
          out.push(rest);
          rest = '';
        }
      }
    }
    parts.push(...out);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const EMOJI_CUES = Object.freeze({
  alert: /[🚨⚠️🆘📢❗‼️🔴🟠]/u,
  flood: /[🌊🌧️⛈️☔]/u,
  fire: /[🔥🚒]/u,
  mockery: /[😂🤣🤡🙄😜😏]/u,
  commercial: /[🛒💰💵💸🏷️✅📦🏠🔑🏡]/u,
  emotional: /[😭💔😞😔😩😫🥺😢]/u,
  fandom: /[💜❤️💕💖✨🎤🎟️]/u,
});

function extractEmojiSignals(text) {
  const s = String(text || '');
  const signals = {};
  for (const [k, re] of Object.entries(EMOJI_CUES)) {
    if (re.test(s)) signals[k] = true;
  }
  return signals;
}

const COLLAPSE_REPEAT_RE = /([\p{L}])\1{2,}/gu;
const REDUPL_LEISURE_RE = /\b(jalan-jalan|makan-makan|senyum-senyum|foto-foto|nonton-nonton|main-main|bohong-bohongan|pura-pura|tiba-tiba|hati-hati|kira-kira|masing-masing|oleh-oleh|gara-gara|sia-sia|sama-sama|lama-lama|diam-diam)\b/gi;
const REDUPL_COLLECTIVE_RE = /\b(?:(rumah|warga|gedung|ruko|kendaraan|mobil|motor|pohon|korban|bangunan|kios|toko|tiang|atap|dinding)-\1|(berjatuhan|berserakan|berhamburan|beterbangan|bertumbangan))\b/gi;

function collapseElongation(tok) {

  return tok.replace(COLLAPSE_REPEAT_RE, '$1');
}

function normalizePhraseText(text, expandGeoAbbr = false) {
  const s = String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.]+/g, ' ');

  const safeLeisure = s.replace(/\bjalan-jalan\b/g, 'jalan_jalan_leisure');

  return safeLeisure
    .replace(/[\p{L}\p{N}_'-]+/gu, word => {
      if (word === 'jalan_jalan_leisure') return 'wisata jalan_jalan';

      if (word.includes('-') && !/^cve-/i.test(word)) {
        const subs = word.split('-').filter(Boolean);
        if (subs.length === 2 && subs[0] === subs[1]) {
          const base = collapseElongation(subs[0]);
          const mapped = SLANG_MAP[base] || base;
          return mapped + ' ' + mapped;
        }
      }
      const collapsed = collapseElongation(word);
      if (expandGeoAbbr && Object.prototype.hasOwnProperty.call(GEO_ABBR_MAP, collapsed)) {
        return GEO_ABBR_MAP[collapsed];
      }
      if (Object.prototype.hasOwnProperty.call(SLANG_MAP, collapsed)) {
        return SLANG_MAP[collapsed];
      }
      return collapsed;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBR_DOT_RE = /\b(PT|CV|UD|Tb|Tbk|Jl|Jln|Dr|Prof|Ir|H|Hj|Bp|Bpk|Sdr|Ny|Tn|Jend|Letjen|Mayjen|Brigjen|Kol|Letkol|Mayor|Kapt|Lettu|Letda|Kombes|AKBP|Kompol|AKP|Iptu|Ipda|Bripka|Brigadir|Briptu|Bripda|Pol|TNI|Kec|Kab|Prov|Kel|Ds|RT|RW|KM|Km|No|Rp|St|Mt)\.(?=\s+)/gi;

function splitClauses(rawText) {
  const decoded = decodeBasicEntities(rawText).normalize('NFKC');
  const clean = decoded
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(ABBR_DOT_RE, '$1\u0000');
  return clean
    .split(/\n+|(?<=[!?;])\s+|(?<=\.)\s+(?=[A-Za-zÀ-ɏ0-9])|,\s+(?=(?:tapi|tetapi|namun|melainkan)\b)/i)
    .map(s => s.replace(/\u0000/g, '.').trim())
    .filter(Boolean);
}

function normalizeIndonesian(rawText) {
  const raw = String(rawText || '');
  const decoded = decodeBasicEntities(raw).normalize('NFKC');
  const urls = decoded.match(/https?:\/\/\S+/g) || [];
  const mentions = decoded.match(/@[\w.]+/g) || [];
  const rawHashtags = decoded.match(/#[\p{L}\p{N}_]+/gu) || [];
  const hashtagsSegmented = rawHashtags.map(segmentHashtag).filter(Boolean);
  const emojiSignals = extractEmojiSignals(decoded);

  const proseWithoutTags = decoded.replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const normalizedProse = normalizePhraseText(proseWithoutTags, false);
  const normalizedGeoProse = normalizePhraseText(proseWithoutTags, true);

  const normalized = [normalizedProse, ...hashtagsSegmented]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normalizedGeo = [normalizedGeoProse, ...hashtagsSegmented]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const collectiveRedup = [...proseWithoutTags.matchAll(REDUPL_COLLECTIVE_RE)].map(m => m[0].toLowerCase());
  const leisureRedup = [...proseWithoutTags.matchAll(REDUPL_LEISURE_RE)].map(m => m[0].toLowerCase());

  const contentHash = crypto
    .createHash('sha1')
    .update(normalizedProse || normalized)
    .digest('hex')
    .slice(0, 16);

  const rawClauses = splitClauses(raw);
  const clauses = rawClauses.map((rc, idx) => {
    const rcNoTags = rc.replace(/#[\p{L}\p{N}_]+/gu, ' ');
    const rcTags = (rc.match(/#[\p{L}\p{N}_]+/gu) || []).map(segmentHashtag).filter(Boolean);
    const normProse = normalizePhraseText(rcNoTags, false);
    const normGeo = normalizePhraseText(rcNoTags, true);
    return {
      index: idx,
      raw: rc,
      rawNoTags: rcNoTags.trim(),
      normProse,
      normGeo,
      normFull: [normProse, ...rcTags].filter(Boolean).join(' ').trim(),
      hashtags: rcTags,
      hasQuestionMark: /\?(?![a-z0-9_]+=)/i.test(rcNoTags.replace(/\b(?:https?|hxxps?|ftp):\/\/\S+|\b[\w.-]+\[\.\][a-z]{2,}\S*/gi, ' ')),
    };
  });

  return {
    raw,
    decoded,
    normalized,
    normalizedProse,
    normalizedGeo,
    urls,
    mentions,
    hashtags: rawHashtags,
    hashtagsSegmented,
    emojiSignals,
    reduplication: {
      collective: collectiveRedup,
      leisure: leisureRedup,
    },
    contentHash,
    clauses,
  };
}

const NEG_WORDS = '(?:tidak|bukan|belum|tanpa|nihil|nol|anti|bebas)';
const NEG_PREFIX_RE = /\b(?:tidak|bukan|belum|tanpa|nihil|nol)\s+(?:ada\s+|lagi\s+|pernah\s+|terjadi\s+|mengalami\s+|akan\s+|bakal\s+)?([a-z0-9_]+(?:\s+[a-z0-9_]+)?)/gi;
const NEG_POST_RE = /\b(gempa|tsunami|erupsi|kebakaran|banjir|kebanjiran|longsor|kecelakaan|ledakan|penembakan|peretasan|kebocoran|serangan|wabah|keracunan|korban|demo|bentrok)\b[^.!?\n]{0,36}\b(?:tidak terjadi|tidak benar|tidak ada|belum ada|nihil|aman terkendali|sudah surut|hoaks|hoax|palsu|dibantah|bohong|bukan)\b/gi;
const FREE_OF_DISASTER_RE = /\b(?:bebas|anti|aman|tanpa|jauh dari)\s+(?:banjir|kebanjiran|macet|kebakaran|gempa|longsor|badai)\b/gi;
const CORRECTION_RE = /\bbukan\s+([^,;.\n]+?)\s*,\s*(?:tapi|tetapi|melainkan|cuma|hanya)\s+([^.!?\n]+)/i;

const DENIAL_ANY_RE = /\b(?:hoaks?|kabar palsu|berita palsu|false claim|misinformation|disinformasi|isu hoax|video lama|foto lama|dibantah)\b/i;
const HISTORICAL_RE = /\b(?:dulu|jaman dulu|zaman dulu|tempo dulu|sejarah|mengenang|kilas balik|nostalgia|ingat waktu|tahun lalu|bulan lalu|pekan lalu|minggu lalu|last year|last month|last week|historical|anniversary|orde baru|orba|soeharto|suharto|perang dunia|world war|penjajahan|kolonial|beberapa tahun silam|(?:jaman|zaman|waktu|pas|saat|era|awal)\s+(?:covid(?:-?19)?|pandemi|lockdown|korona|corona)|(?:2019|2020|2021|2022)\b[^.!?\n]{0,40}\b(?:covid|pandemi|lockdown))\b/i;
const HISTORICAL_YEAR_RE = /\b(?:tahun|pada|sejak|era)\s+((?:19|20)\d{2})\b/i;

function isHistoricalClause(text, year = new Date().getFullYear()) {
  const cleaned = String(text || '').replace(/\b(?:dibangun|didirikan|diresmikan|dibuka|dibeli|dijual|berdiri|lulus|menikah)\s+(?:pada\s+)?(?:tahun\s+(?:19|20)\d{2}|(?:19|20)\d{2}|tahun\s+lalu|bulan\s+lalu|dulu)\b/gi, ' ');
  if (HISTORICAL_RE.test(cleaned)) return true;
  const m = HISTORICAL_YEAR_RE.exec(cleaned);
  return !!m && Number(m[1]) < year;
}

const QUESTION_RE = /\?|^\s*(?:apakah|apa benar|benarkah|beneran|adakah|ada yang tahu|ada yang tau|ada yang dengar|ada yang lihat|ada info|ada kabar|info dong|tanya dong|spill|gimana|bagaimana|berapa|dimana|di mana|kapan|siapa|anyone know|is it true|is there)\b|\b(?:tidak sih|nggak sih|nggak ya|beneran nggak|valid nggak|hoaks nggak|banjir nggak|aman nggak|macet nggak)\b/i;
const HEARSAY_RE = /\b(?:katanya|kabarnya|katanye|rumornya|rumor|rumour|denger-denger|dengar-dengar|isu beredar|konon|katanya sih)\b/i;
const CONDITIONAL_RE = /\b(?:andaikan|seandainya|bagaimana jika|misalkan|kalau nanti|jika nanti|bakal|akan terjadi jika)\b/i;

const SATIRE_IRONY_RE = /\b(?:bebas banjir,?\s*katanya|mantap,\s*(?:jakarta|kota|negara)[^.!?\n]{0,40}(?:tenggelam|banjir|macet|rusak)\s+lagi|prestasi\s+(?:banjir|macet)|selamat menikmati\s+(?:banjir|macet)|macetnya bikin [^.!?\n]{0,20}mati berdiri)\b/i;
const EDUCATION_RE = /\b(?:apa itu|pengertian|tutorial|cara (?:mencegah|mengatasi|menghapus|menghindari|menyelamatkan)|tips|edukasi|simulasi|latihan|mitigasi|kesiapsiagaan|tas bencana|go[- ]?bag|sosialisasi|webinar|seminar|workshop|rakor|what is|how to|exercise|simulation)\b/i;
const CEREMONY_RE = /\b(?:upacara\s+(?:peringatan|tabur bunga|hari|bendera|hut|penghormatan)|tabur bunga|hari pahlawan|dirgahayu|hut\s+(?:tni|ri|bhayangkara)|ziarah\s+(?:nasional|makam)|penghargaan|apresiasi|kunjungan kerja|kunker|launching|peresmian|resmikan|museum\s+militer|lomba|parade|wisuda|silaturahmi)\b/i;

const OFFICIAL_AGENCY_RE = /\b(?:bmkg|bnpb|bpbd|pvmbg|basarnas|bssn|kemenkes|kemkes|polri|polda|polres|polsek|tmc\s*polda|damkar|pln|kpu|bawaslu|komdigi|kominfo|pemprov|pemkot|pemkab|knkt|kpk|dishub)\b/i;
const OFFICIAL_WARNING_RE = /\b(?:peringatan\s+(?:dini|cuaca|tsunami|banjir|longsor|erupsi|gelombang|angin|bmkg)|(?:keluarkan|mengeluarkan|rilis|merilis|terbitkan|menerbitkan)\s+peringatan|warning|early warning|(?:naikkan|tingkatkan|tetapkan)\s+status[^.!?\n]{0,35}\b(?:awas|siaga|waspada)|status\s+(?:awas|siaga)|diminta\s+(?:untuk\s+)?evakuasi|waspada\s+(?:tsunami|banjir|longsor|cuaca|erupsi|gelombang|angin|hujan)|potensi\s+(?:hujan\s+(?:ekstrem|lebat)|banjir|tsunami|angin\s+kencang|gelombang\s+tinggi)|hujan\s+ekstrem|siaga\s+[123]|siapkan\s+pengamanan|menyiapkan\s+pengamanan|(?:di)?siagakan|(?:di)?kerahkan|antisipasi\s+(?:demo|unjuk rasa|aksi|banjir))\b/i;
const OFFICIAL_UPDATE_RE = /\b(?:melaporkan|mencatat|mengungkap|menyatakan|mengonfirmasi|konfirmasi|berdasarkan laporan|update\s+(?:terkini|resmi)|data\s+sementara|tim\s+gabungan)\b/i;

const EYEWITNESS_FRAMING_RE = /\b(?:rumah saya|depan rumah|belakang rumah|samping rumah|kosan saya|kamar saya|kantor saya|jalanan depan|gang saya|kampung saya|wilayah saya|daerah saya|lingkungan saya|air(?:\s+selokan|\s+kali|\s+hujan)?\s+(?:sudah|mulai)\s+(?:naik\s+)?masuk|air masuk|terasa banget|terasa kencang|kerasa banget|bergoyang|bergetar|barusan|baru saja|saat ini|sekarang lagi|tolong|kejebak|terjebak|lihat langsung|dengar suara|asap tebal|listrik mati|mati lampu)\b/i;

const COMMERCIAL_LISTING_RE = /\b(?:dijual|mau\s+jual|jual\s+(?:cepat|mobil|motor|honda|toyota|civic|brio|avanza|innova|xpander|ertiga|vario|nmax)|disewakan|disewa|over\s*kredit|for\s*sale|for\s*rent|open\s*rent|looking\s*to\s*rent|\bwts\b|\bwtb\b|\bwtt\b|loker|lowongan\s+kerja|membutuhkan\s+(?:karyawan|staff|cook|barista|admin|driver|kurir)|kirim\s+cv|lamaran|kpr|dp\s*(?:0|nol)|cicilan|booking\s*fee|nego|siap\s+(?:huni|pakai)|pajak\s+hidup|surat\s+lengkap|lt\s*\d+|lb\s*\d+|shm|hgb|tahun\s+pembelian|transmisi\s*:?\s*(?:matic|manual)|stnk|\bkm\s*\:?\s*\d|showroom|ready\s*stock|open\s*order|pre[- ]?order|jastip|jasa\s+titip|war\s+tiket|sewa\s+(?:raket|kamera|iphone|samsung|kost|kosan|kontrakan|apartemen|ruko|armybomb|army\s*bomb|lightstick)|rekomendasi\s+(?:kost|kosan|kontrakan|cafe|kafe|kuliner|makanan|cakes?|salon|dokter|klinik|tempat|bengkel|laundry|hotel|villa)|recommendation\s+(?:for\s+)?(?:cakes?|food|cafe|kost|hotel|place))\b/i;
const ADVERTISEMENT_RE = /\b(?:promo|diskon|cashback|flash\s*sale|gratis\s+ongkir|bagi[- ]?bagi\s+(?:gratis|kopi|americano|minuman|makanan|voucher|hadiah)|gratis\s+(?:buat|untuk)\s+(?:warga|mahasiswa|kalian)|link\s+(?:ada\s+)?di\s+bio|cek\s+(?:link\s+)?di\s+bio|order\s+(?:via|di)\s+(?:wa|whatsapp|dm|bio)|dm\s+(?:untuk|for)\s+(?:order|harga|price|rent|booking)|s\.shopee\.co\.id|shp\.ee|tokopedia\.link|(?:diskusiin|konsultasi)\s+project\s+kamu|(?:via\s+)?(?:dm|whatsapp|wa)\s+(?:atau\s+(?:whatsapp|wa|dm)\s+)?di\s+bio|grand\s+opening|fanmeeting\s+tour|world\s+tour|asia\s+tour|beli\s+tiket|tiket\s+(?:konser|nonton|film|bioskop))\b/i;
const PERSONAL_VENT_RE = /\b(?:capek\s+banget|lelah\s+banget|pengen\s+resign|mau\s+resign|ingin\s+resign|muak\s+sama|stres\s+(?:kerja|banget|hidup)|ga\s+kuat\s+(?:lagi|di|hidup)|tidak\s+kuat\s+(?:lagi|di|hidup)|pindah\s+(?:aja|saja)\s+ke|capek\s+kerja|gaji\s+kecil|macetnya\s+bikin|bikin\s+(?:emosi|stres|gila|mati\s+berdiri)|badan\s+lemas|mager|gabut|galau|patah\s+hati|curhat|butuh\s+temen\s+cuddle|temen\s+cuddle)\b/i;
const OPINION_PRAISE_RE = /\b(?:selalu\s+punya\s+tempat\s+di\s+hati|kota\s+(?:terindah|terbaik|favorit|kenangan)|i\s+love\s+|cinta\s+banget\s+sama|kangen\s+banget\s+sama|rindu\s+(?:kota|suasana|jakarta|bandung|jogja|surabaya)|menurut\s+(?:saya|pribadi)|pendapat\s+(?:saya|pribadi)|mengkhianati\s+demokrasi|wacana\s+(?:pemilihan|pilkada|kebijakan))\b/i;
const SPAM_SCAM_RE = /\b(?:follow\s+[\w.@-]+\s*[+.&]?\s*follow|like\s*(?:dan|&|\+)\s*(?:follow|rt)|rt\s*(?:dan|&|\+)\s*follow|boost\s+followers?|giveaway|klaim\s+(?:hadiah|reward|bonus)|airdrop|seed\s+phrase|private\s+key|robot\s+trading|binary\s+option|joki\s+(?:tugas|skripsi|makalah|ujian)|cari\s+(?:jodoh|pasangan|pacar|suami|istri)|cv\s+taaruf|biodata\s+taaruf|kriteria\s*:\s*1\.|jilmek|open\s*bo|vcs|bispak|janda\b[^.\n]{0,30}\b(?:jakarta|bo|vcs|open|michat)|michat|bokep|sange|colmek|crowcaster\.com|slot\s+gacor|togel|judol|gestun\s+pinjol)\b|\bR[1-9]\s+#\d+\b[^.\n]{0,60}\$\d+\.\d+/i;
const READER_ACTION_RE = /\b(?:saya|aku|gue|gw|kami|kita)\s+(?:(?:lagi|sedang|posisi|masih)\s+(?:di|dari)\s+[^,.!?\n]{2,30}[,\s]+)?(?:baca|membaca|membacanya|nonton|menonton|lihat\s+(?:berita|kabar|postingan)|melihat\s+(?:berita|kabar)|dengar\s+(?:berita|kabar)|mendengar\s+(?:berita|kabar)|pantau|memantau|scroll|liat|nemu)\b/i;

const METAPHOR_FRAMES = [
  { id: 'metaphor_banjir', re: /\b(?:dibanjiri|membanjiri)\b|\b(?:banjir|kebanjiran)\s+(?:order|orderan|cuan|rezeki|berkah|hadiah|bonus|promo|diskon|ucapan|pujian|penghargaan|kritik|kecaman|hujatan|komentar|aduan|laporan|air\s*mata|gol|darah|impor|produk|turis|wisatawan|penonton|pelamar|pendaftar|peserta|serangan\s+siber|serangan\s+cyber|pesan|chat|dm|email|notif|konten|content|update|jadwal|kerjaan|tugas)\b/i },
  { id: 'metaphor_ledakan', re: /\b(?:harga|tarif|biaya|ongkos|sewa|tiket(?:\s+pesawat|\s+kereta|\s+konser)?|rumah|properti|penduduk|populasi|kasus|pasien|penderita|order|orderan|penjualan|omzet|saham|profit|bisnis|cuan|inflasi|utang|kemiskinan|emosi|amarah|tawa|tangis|popularitas|traffic|trafik|subscribers?|followers?|viewers?|komentar)\b[^.!?\n]{0,55}\b(?:meledak|ledakan)\b|\b(?:ledakan|meledak)\b[^.!?\n]{0,40}\b(?:harga|tarif|tiket|penduduk|populasi|kasus|pasien|order|orderan|penjualan|omzet|bisnis|popularitas|tawa|tangis|emosi|amarah|di\s+pasaran)\b/i },
  { id: 'metaphor_panas', re: /\b(?:politik|suasana|debat|opini|diskusi|persaingan|laga|pertandingan|derby|hati|kepala|makanan|kopi|teh|soto|bakso|cuaca)\b[^.!?\n]{0,20}\b(?:panas|memanas)\b|\b(?:panas|memanas)\b[^.!?\n]{0,20}\b(?:politik|persaingan|debat|hati|asam|lambung)\b/i },
  { id: 'metaphor_jatuh', re: /\b(?:harga|saham|ihsg|rupiah|kurs|nilai|poin|peringkat|klasemen|mental|wibawa|reputasi|cinta|hati|tempo|miskin)\b[^.!?\n]{0,20}\b(?:jatuh|ambruk|anjlok|runtuh)\b|\b(?:jatuh|ambruk|anjlok|runtuh)\b[^.!?\n]{0,20}\b(?:cinta|tempo|miskin|hati|jiwa|perasaan|logika|kurs|saham|ihsg|rupiah|harga|rezim|koalisi|suara)\b/i },
  { id: 'metaphor_bakar', re: /\b(?:kebakaran\s+jenggot|kebakaran\s+(?:harga|promo|diskon|obral)|(?:ihsg|saham|portofolio|porto|market|bursa|kripto|crypto)\s+kebakaran|terbakar\s+(?:api\s+)?(?:amarah|cemburu|emosi|semangat|rindu|asmara)|membakar\s+(?:semangat|duit|uang|kalori|lemak)|panggung\s+terbakar)\b|\b(?:ayam|nasi|ikan|sate|roti|steak|jagung|bakso|kuliner|masak|resep|wajan)\b[^.!?\n]{0,20}\b(?:bakar|terbakar)\b/i },
  { id: 'metaphor_tenggelam', re: /\b(?:tenggelam|hanyut)\s+(?:dalam|oleh)\s+(?:kenangan|lamunan|duka|kesedihan|nostalgia|alunan|suasana|musik|lagu|emosi|perasaan|senyuman|tatapan|cinta|pesona|dosa)\b|\btenggelam\s+di\s+dasar\s+klasemen\b/i },
  { id: 'metaphor_bencana_politik', re: /\b(?:tsunami|gempa|badai|longsor)\s+(?:biru|politik|kabinet|protes|suara|pemilu|dukungan|saham|cuan|phk|vonis|kritik|kecaman|hujatan|asmara|cinta|kehidupan|hidup|cedera|pasti\s+berlalu)\b|\b(?:guncangan|mengguncang)\s+(?:politik|kabinet|ekonomi|jiwa|batin|jagat|dunia\s+maya|netizen|medsos|publik|parlemen|panggung)\b/i },
  { id: 'metaphor_crime', re: /\b(?:pencuri|maling|rampok|begal)\b[^.!?\n]{0,18}\b(?:hati|cinta|perhatian|senyum|pandangan|poin|start|rekening|saldo|data|partai|konstitusi)\b|\b(?:dibunuh|membunuh)\b[^.!?\n]{0,18}\b(?:rasa|rindu|sepi|waktu|kebosanan|karakter|mimpi|harapan|cinta)\b|\b(?:ditembak|menembak)\b[^.!?\n]{0,25}\b(?:gebetan|doi|crush|pacar|pacaran|hati|cinta|mati\s+rasa|wifi|sim|gawang)\b/i },
  { id: 'metaphor_siber_or_wabah', re: /\b(?:humans?|manusia|jiwa|otak|hati)\b[^.!?\n]{0,30}\b(?:malware|virus)\b|\bwabah\s+(?:judi|judol|korupsi|kebencian|cinta|rindu|hoaks|fitnah|drakor|k-?pop|tiktok)\b|\bracun\s+(?:tiktok|shopee|ig|belanja|skincare|cinta|asmara)\b/i },
  { id: 'metaphor_diamankan_noncrime', re: /\b(?:data|akun|aset|uang|dokumen|file|arsip|berkas|tiket|kursi|juara|poin|kemenangan|medali)\b[^.!?\n]{0,18}\b(?:diamankan)\b/i },
  { id: 'metaphor_bocor_nonincident', re: /\b(?:atap|genteng|ban|ember|pipa\s+air|rahasia|soal\s+ujian|kunci\s+jawaban|skor|bocoran\s+film)\b[^.!?\n]{0,15}\b(?:bocor|kebocoran)\b|\b(?:bocor)\s+(?:halus|alusan)\b/i },
  { id: 'nonincident_sport_entertainment', re: /\b(?:dead\s+by\s+daylight|main\s+dbd|play\s+dbd|grand\s+prix|formula\s+1|safety\s+car|sinopsis\s+film|review\s+film|trailer\s+film|cdrama|drachin|jdrama|boboiboy|baby\s+gempa|baju\s+gempa|kaos\s+gempa|goyang\s+gempa|joget\s+gempa|sid\s+bukan\s+pahlawan|bermahkotakan\s+duri|emyu|munyuk|bobotoh\s+persib|mantan\s+rp|pacar\s+rl)\b/i },
];

const METAPHOR_TOPIC_SCOPE = {
  metaphor_banjir: new Set(['banjir']),
  metaphor_ledakan: 'all',
  metaphor_panas: new Set(['badai', 'kebakaran', 'karhutla', 'gempa', 'politik', 'konflik', 'transport']),
  metaphor_jatuh: new Set(['kecelakaan', 'insiden', 'banjir', 'gempa']),
  metaphor_bakar: new Set(['kebakaran', 'karhutla']),
  metaphor_tenggelam: new Set(['banjir', 'insiden', 'kecelakaan']),
  metaphor_bencana_politik: new Set(['gempa', 'badai', 'banjir', 'insiden', 'phk']),
  metaphor_crime: new Set(['pencurian', 'penembakan', 'kriminal', 'penangkapan']),
  metaphor_siber_or_wabah: new Set(['ransomware', 'serangan siber', 'wabah', 'kesehatan']),
  metaphor_diamankan_noncrime: new Set(['penangkapan', 'kriminal', 'pencurian']),
  metaphor_bocor_nonincident: new Set(['serangan siber', 'ransomware']),
  nonincident_sport_entertainment: 'all',
};

function metaphorBlocksTopic(metaphorIds, topicId) {
  for (const id of (metaphorIds || [])) {
    const scope = METAPHOR_TOPIC_SCOPE[id];
    if (scope === 'all') return true;
    if (scope && scope.has(topicId)) return true;
  }
  return false;
}

const EVENT_FRAMES = [
  {
    topic: 'banjir',
    category: 'flood',
    eventType: 'flood',
    detect: c => {
      const t = c.normGeo;
      if (/\bbanjir\s+bandang\b|\bbanjir\s+rob\b|\bbanjir\s+lahar\b|\bbanjir\s+lumpur\b/.test(t)) return { action: 'flooded', strong: true, type: 'flood' };
      if (/\btanah\s+longsor\b|\blongsor\b/.test(t) && !/\blongsor\s+(?:suara|kursi|saham)\b/.test(t)) {
        const hasAction = /\b(?:terjadi|melanda|menutup|menimbun|menerjang|rusak|ambruk|terputus|korban|evakuasi|warga|rumah|jalan|tebing|di\s+[a-z])\b/.test(t);
        return { action: 'landslide', strong: hasAction, type: 'landslide' };
      }

      if (/\b(?:air(?:nya)?(?:\s+(?:hujan|kali|sungai|selokan|got))?)\s+(?:(?:sudah|mulai|lagi|terus|makin)\s+){0,3}(?:naik\s+(?:masuk|ke)|masuk|naik|merendam|menggenang|mengalir\s+deras)\b[^.!?\n]{0,40}\b(?:rumah|kamar|teras|halaman|kosan|kontrakan|ruko|toko|gang|jalan|pemukiman|warga)\b/.test(t)
        || /\b(?:air|banjir)\s+(?:sudah\s+|mulai\s+|masih\s+)?se(?:mata\s+kaki|betis|lutut|pinggang|dada|leher)\b/.test(t)) {
        if (/\b(?:keran|kran|pipa|toren|galon|ember|ac\s+netes|bocor\s+atap)\b/.test(t)) return null;
        return { action: 'inundated', strong: true, type: 'flood', eyewitnessCue: true };
      }
      if (/\b(?:banjir|kebanjiran|terendam|merendam|menggenangi|air\s+meluap|sungai\s+meluap|kali\s+meluap|tanggul\s+jebol|air\s+bah)\b/.test(t)) {
        const strong = /\b(?:merendam|terendam|menggenangi|tanggul\s+jebol|air\s+meluap|sungai\s+meluap|kali\s+meluap|air\s+bah|mengungsi|evakuasi|ketinggian\s+air|setinggi|se(?:mata\s+kaki|betis|lutut|pinggang|dada)|rumah\s+warga|pemukiman|jalan\s+raya|warga\s+terdampak|bpbd|bnpb|damkar|banjir\s+(?:parah|besar)|melanda|menerjang|mengepung|kebanjiran)\b|\bcaah\s+gede\b/.test(c.raw || t) || /\b(?:banjir\s+(?:parah|besar))\b/.test(t);
        return { action: 'inundated', strong, type: 'flood' };
      }
      if (/\bgenangan\b/.test(t)) {
        return { action: 'waterlogging', strong: false, type: 'waterlogging', minorWaterlogging: true };
      }
      return null;
    },
  },
  {
    topic: 'kebakaran',
    category: 'fire',
    eventType: 'fire',
    detect: c => {
      const t = c.normGeo;
      if (/\b(?:film|bioskop|cfd|car\s+free\s+day|kolaborasi|strategi\s+film|edukasi|sosialisasi|simulasi|lomba)\b/.test(t)
        && !/\b(?:api\s+melalap|ludes|hangus|terbakar\s+hebat|kebakaran\s+(?:rumah|ruko|gudang|pabrik|pasar|gedung))\b/.test(t)) return null;
      if (!/\b(?:kebakaran|terbakar|kobaran\s+api|si\s+jago\s+merah|dilalap\s+api|ludes\s+dilalap|asap\s+tebal|damkar)\b/.test(t)) return null;
      if (/\b(?:kebakaran\s+(?:hutan|lahan)|karhutla)\b/.test(t)) return null;
      const hasFireAction = /\b(?:kebakaran|terbakar|kobaran\s+api|si\s+jago\s+merah|dilalap|ludes|hangus|padamkan|dipadamkan|memadamkan|asap\s+tebal)\b/.test(t);
      const strong = hasFireAction && /\b(?:rumah|ruko|gedung|bangunan|pabrik|gudang|pasar|toko|kios|warung|sekolah|kampus|kantor|kosan|kontrakan|hotel|mall|bioskop|stasiun|mobil|motor|bus|truk|kapal|gardu|trafo|kabel|lahan|api|asap|ludes|hangus|padamkan|dipadamkan|evakuasi|korban|luka|tewas|meninggal|damkar|pemadam|di\s+[a-z])\b/.test(t);
      return { action: 'burning', strong, type: 'fire' };
    },
  },
  {
    topic: 'karhutla',
    category: 'fire',
    eventType: 'wildfire',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:karhutla|kebakaran\s+(?:hutan|lahan)|kabut\s+asap|titik\s+panas|hotspot)\b/.test(t)) return null;
      if (/\b(?:wifi|wi-fi|tethering|phone|fone|hp|ponsel|kuota|paket\s+data|download|gta|game|connect|password)\b/i.test(t)) return null;
      if (/\bhotspot\b/.test(t) && !/\b(?:karhutla|hutan|lahan|gambut|kabut\s+asap|titik\s+panas|kebakaran|terpantau|satelit|bmkg|bnpb|bpbd|sipongi|riau|kalimantan|sumatera|jambi|sumsel)\b/.test(t)) return null;
      const strong = /\b(?:meluas|terjadi|membakar|terpantau|hanguskan|padamkan|pemadaman|kabut\s+asap|lahan\s+gambut|sipongi|manggala\s+agni|bpbd|bnpb)\b/.test(t);
      return { action: 'wildfire_burning', strong, type: 'wildfire' };
    },
  },
  {
    topic: 'gempa',
    category: 'disaster',
    eventType: 'earthquake',
    detect: c => {
      const t = c.normGeo;
      if (/\btsunami\b/.test(t)) {
        if (/\b(?:surf(?:ing)?|ocean\s+tsunami|crowcaster)\b|\bR[1-9]\s+#\d+\b|\$\d+\.\d+/i.test(t)) return null;
        const strong = /\b(?:peringatan(?:\s+dini)?|warning|waspada|siaga|awas|terjadi|menerjang|hantam|gelombang|air\s+laut\s+surut|bmkg|evakuasi)\b/.test(t);
        return { action: 'tsunami_alert', strong, type: 'tsunami' };
      }
      if (/\b(?:erupsi|gunung\s+meletus|letusan|awan\s+panas|hujan\s+abu|guguran\s+lava|lahar\s+(?:dingin|hujan))\b/.test(t)
        || /\b(?:gunung|g\.)\s+[a-z]+\b[^.!?\n]{0,35}\bstatus[^.!?\n]{0,20}\b(?:awas|siaga|waspada)\b/.test(t)) {
        const strong = /\b(?:gunung|merapi|semeru|marapi|lewotobi|sinabung|bromo|kelud|krakatau|raung|dukono|ibu|karo|agam|flores|semburkan|melontarkan|terjadi|status[^.!?\n]{0,20}\b(?:awas|siaga|waspada)|pvmbg|vona|hujan\s+abu|awan\s+panas|evakuasi)\b/.test(t);
        return { action: 'erupted', strong, type: 'eruption' };
      }
      if (/\b(?:gempa|guncangan|getaran|magnitudo|\bm\s*\d+(?:[.,]\d+)?\b|\bmag\s*[:=]?\s*\d)/i.test(t)) {
        const hasQuakeNoun = /\b(?:gempa(?:\s+bumi|\s+tektonik|\s+vulkanik|\s+susulan)?|magnitudo|\bmag\s*[:=]?\s*\d|skala\s+richter|episentrum|pusat\s+gempa|bmkg)\b/.test(t);
        if (!hasQuakeNoun) return null;
        const strong = /\b(?:mengguncang|diguncang|guncang|guncangan|getaran|terasa|dirasakan|merasakan|bergetar|bergoyang|panik|berhamburan|keluar\s+rumah|retak|roboh|ambruk|rusak|kedalaman|kedlmn|\bm\s*\d+(?:[.,]\d+)?\b|\bmag(?:nitudo)?\s*[:=]?\s*\d+(?:[.,]\d+)?\b|\d+(?:[.,]\d+)?\s*(?:sr|skala\s+richter|mag|magnitudo)|episentrum|bmkg)\b/.test(t);
        return { action: 'shook', strong, type: 'earthquake' };
      }
      return null;
    },
  },
  {
    topic: 'badai',
    category: 'disaster',
    eventType: 'storm',
    detect: c => {
      const t = c.normGeo;
      const hasWeatherHazard = /\b(?:puting\s+beliung|siklon(?:\s+tropis)?|bibit\s+siklon|badai(?:\s+petir)?|angin\s+kencang|angin\s+ribut|gelombang\s+pasang|hujan\s+ekstrem|cuaca\s+ekstrem)\b/.test(t);
      if (!hasWeatherHazard) return null;
      if (/\bputing\s+beliung\b/.test(t)) return { action: 'struck', strong: /\b(?:terjang|menerjang|hantam|menghantam|rusak|merusak|atap|pohon|tumbang|beterbangan|rumah|warga|porak|di\s+[a-z]|peringatan|waspada|bmkg)\b/.test(t), type: 'tornado' };
      if (/\bsiklon\b/.test(t)) return { action: 'cyclone', strong: /\b(?:peringatan|waspada|siaga|bmkg|bnpb|bpbd|terjadi|memicu|gelombang|badai|hujan|di\s+[a-z])\b/.test(t), type: 'cyclone' };
      const strong = /\b(?:terjang|menerjang|hantam|menghantam|rusak|merusak|roboh|tumbang|beterbangan|peringatan(?:\s+dini)?|keluarkan\s+peringatan|waspada|siaga|bmkg|bnpb|bpbd|kecepatan|knot|km\/h|gelombang\s+pasang|hujan\s+ekstrem)\b/.test(t);
      return { action: 'severe_weather', strong, type: 'storm' };
    },
  },
  {
    topic: 'kecelakaan',
    category: 'insiden',
    eventType: 'accident',
    detect: c => {
      const t = c.normGeo;
      if (/\b(?:ledakan|meledak|dentuman)\b/.test(t)) {
        const physObj = /\b(?:tabung\s+gas|elpiji|lpg|kompor|trafo|gardu|tangki|kilang|gudang|pabrik|ruko|rumah|gedung|bom|petasan|granat|baterai|mobil|motor|truk|bus|kapal|kaca\s+pecah|asap|api|korban|luka|tewas|meninggal|evakuasi|polisi|damkar|suara\s+ledakan|dengar\s+ledakan)\b/.test(t);
        if (!physObj) return null;
        return { action: 'exploded', strong: true, type: 'explosion' };
      }
      if (/\b(?:kecelakaan|tabrakan|tabrak\s+lari|ditabrak|menabrak|bertabrakan|bus\s+terguling|truk\s+terguling|kereta\s+anjlok|pesawat\s+jatuh|kapal\s+(?:tenggelam|karam))\b/.test(t)) {
        const isMaritime = /\b(?:kapal|perahu|feri|ferry|speedboat|tongkang)\b[^.!?\n]{0,25}\b(?:tenggelam|karam|terbalik)\b/.test(t);
        const strong = /\b(?:terjadi|tewas|meninggal|luka|korban|dievakuasi|terguling|anjlok|karam|tenggelam|beruntun|parah|tabrak\s+lari|tol|jalan|persimpangan|di\s+[a-z])\b/.test(t);
        return { action: 'crashed', strong, type: isMaritime ? 'maritime_accident' : 'accident' };
      }
      return null;
    },
  },
  {
    topic: 'insiden',
    category: 'insiden',
    eventType: 'collapse',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:ambruk|runtuh|roboh|pohon\s+tumbang|tenggelam|hanyut|tergelincir|jembatan\s+putus|atap\s+jatuh|bangunan\s+roboh)\b/.test(t)) return null;
      const phys = /\b(?:jembatan|gedung|bangunan|atap|plafon|rumah|dinding|konstruksi|tembok|jalan|tebing|tower|tiang|kapal|perahu|sampan|tongkang|speedboat|dermaga|pohon|orang|bocah|anak|korban|warga|penumpang|kendaraan|mobil|motor|truk)\b/.test(t);
      if (!phys) return null;
      if (/\bpohon\s+tumbang\b/.test(t)) return { action: 'fallen', strong: true, type: 'tree_fall' };
      if (/\b(?:tenggelam|hanyut|karam)\b/.test(t)) {
        const sea = /\b(?:kapal|laut|selat|ombak|nelayan|feri|perahu|sungai|perairan|dermaga)\b/.test(t);
        return { action: 'sank', strong: true, type: sea ? 'maritime_accident' : 'accident' };
      }
      return { action: 'collapsed', strong: true, type: 'collapse' };
    },
  },
  {
    topic: 'demo',
    category: 'demo',
    eventType: 'demo',
    detect: c => {
      const t = c.normGeo;
      const hasDemo = /\b(?:unjuk\s+rasa|aksi\s+massa|demonstrasi|demonstran|pengunjuk\s+rasa|(?:ber|men|di)?demo|protes|mogok|kerusuhan|bentrok|pemogokan|long\s+march|women'?s\s+march|hari\s+buruh|may\s+day|[a-z]+\s+memanggil|kampus\s+dikepung|logistik\s+dihalangi|kawan\s+diculik|(?:ga|gak|tidak|kurang)\s+kondusif|menyuarakan\s+keadilan|memperjuangkan\s+kebenaran)\b|\b(?:gelar|menggelar|melakukan)\s+aksi\b|\baksi\s+(?:tolak|menolak|tuntut|menuntut|mahasiswa|buruh|damai|bela|massa|bem)\b|\bmahasiswa\s+(?:turun|bergerak|melawan|dikepung|diculik)\b/.test(t);
      if (!hasDemo) return null;
      if (/\b(?:demo\s+(?:lagu|musik|app|aplikasi|produk|game|masak|cooking|vokal|versi|website)|free\s+demo|live\s+demo|cooking\s+demo|happy\s+labor\s+day)\b/.test(t)) return null;
      const strong = /\b(?:berlangsung|turun\s+ke\s+jalan|turun\s+ke\s+aspal|berkumpul|gelar|menggelar|melakukan\s+aksi|aksi\s+(?:tolak|menolak|tuntut|menuntut)|ricuh|bentrok|tuntut|menuntut|menolak|tolak|orasi|aksi|siapkan\s+pengamanan|menyiapkan\s+pengamanan|siagakan|disiagakan|kerahkan|dikerahkan|antisipasi|kawal\s+demo|amankan\s+demo|pengamanan|tiba\s+di\s+depan|gerbang|blokade|gas\s+air\s+mata|water\s+cannon|barikade|mahasiswa|buruh|ojol|dpr|dprd|istana|patung\s+kuda|polisi|aparat|kampus\s+dikepung|kawan\s+diculik|tidak\s+kondusif|ga\s+kondusif|memanggil)\b/.test(t);
      return { action: 'protesting', strong, type: 'demo' };
    },
  },
  {
    topic: 'penembakan',
    category: 'kriminal',
    eventType: 'violent_crime',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:penembakan|ditembak|tertembak|baku\s+tembak|terkena\s+tembakan|berondong\s+tembakan)\b/.test(t)) return null;
      const strong = /\b(?:polisi|polres|polda|polsek|tni|aparat|senjata|senpi|peluru|pelaku|korban|tewas|meninggal|luka|kritis|darah|otk|kkb|begal|rampok|timah\s+panas|tkp|baku\s+tembak|penembakan)\b/.test(t);
      if (!strong) return null;
      return { action: 'shot', strong: true, type: 'violent_crime' };
    },
  },
  {
    topic: 'pencurian',
    category: 'kriminal',
    eventType: 'violent_crime',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:pencurian|curanmor|begal|perampokan|jambret|dirampok|kemalingan|maling|pencuri|dicuri|mencuri)\b/.test(t)) return null;
      const strong = /\b(?:motor|mobil|hp|ponsel|uang|duit|emas|perhiasan|laptop|sepeda|toko|rumah|warung|brankas|korban|pelaku|tertangkap|ditangkap|diamankan|dihakimi|terekam|cctv|polres|polsek|polda|tkp|beraksi|dirampok|kemalingan|curanmor|dibegal)\b/.test(t);
      return { action: 'stolen', strong, type: 'violent_crime' };
    },
  },
  {
    topic: 'penangkapan',
    category: 'kriminal',
    eventType: 'violent_crime',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:penangkapan|ditangkap|diamankan|ott|operasi\s+tangkap\s+tangan|razia|penahanan|tersangka)\b/.test(t)) return null;
      const crimeCtx = /\b(?:polisi|polres|polda|polsek|kpk|kejaksaan|bnn|densus|aparat|pelaku|tersangka|buron|maling|begal|rampok|pembunuh|bandar|narkoba|koruptor|suap|penipu|preman|senpi)\b/.test(t);
      if (!crimeCtx) return null;
      return { action: 'arrested', strong: /\b(?:ditangkap|diamankan|penangkapan|ott|ditahan)\b/.test(t), type: 'violent_crime' };
    },
  },
  {
    topic: 'kriminal',
    category: 'kriminal',
    eventType: 'violent_crime',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:pembunuhan|dibunuh|pengeroyokan|dikeroyok|perampokan|dirampok|penculikan|diculik|perkosaan|rudapaksa|terorisme|bom\s+bunuh\s+diri|narkoba|kdrt)\b/.test(t)) return null;
      const isHomicide = /\b(?:pembunuhan|dibunuh)\b/.test(t);
      const isNarc = /\bnarkoba\b/.test(t);
      const strong = /\b(?:terjadi|tewas|meninggal|luka|korban|pelaku|tersangka|ditangkap|diamankan|polisi|polres|polda|ditemukan|warga|di\s+[a-z])\b/.test(t);
      return { action: isHomicide ? 'homicide' : 'crime', strong, type: isNarc ? 'narcotics' : isHomicide ? 'homicide' : 'violent_crime' };
    },
  },
  {
    topic: 'kesehatan',
    category: 'kesehatan',
    eventType: 'health_incident',
    detect: c => {
      const t = c.normGeo;
      const hasHealth = /\b(?:keracunan|intoksikasi|wabah|klb|kejadian\s+luar\s+biasa|dbd|demam\s+berdarah|campak|difteri|kolera|rabies|polio|mpox|leptospirosis|tifus|malaria|serangan\s+jantung|stroke|gagal\s+ginjal|miras\s+oplosan|oplosan\s+maut|muntah|mual|diare)\b/.test(t);
      if (!hasHealth) return null;
      const strong = /\b(?:kasus|pasien|terjangkit|keracunan\s+(?:massal|makanan|mbg|pangan|nasi|katering)|korban|meninggal|tewas|dirawat|dilarikan\s+ke|puskesmas|rumah\s+sakit|rsud|rsup|klb|wabah|intoksikasi|oplosan)\b/.test(t)
        || (/\b(?:mual|muntah)\b/.test(t) && /\b(?:massal|keracunan|makanan|mbg|santri|siswa|murid|warga|rumah\s+sakit|puskesmas|dilarikan)\b/.test(t));
      return { action: 'health_case', strong, type: 'health_incident' };
    },
  },
  {
    topic: 'listrik padam',
    category: 'ekonomi',
    eventType: 'listrik padam',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:listrik\s+padam|padam\s+listrik|pemadaman\s+listrik|mati\s+listrik|mati\s+lampu|byarpet|blackout)\b/.test(t)) return null;
      if (/\bblackout\b/.test(t) && !/\b(?:listrik|pln|gardu|trafo|area|wilayah|padam|mati\s+lampu)\b/.test(t)) return null;
      const strong = /\b(?:pemadaman|padam|mati\s+listrik|mati\s+lampu|listrik\s+padam|pln|gardu|trafo|area|wilayah|kecamatan|kabupaten|kota|sebagian|jam|sejak)\b/.test(t);
      return { action: 'power_outage', strong, type: 'listrik padam' };
    },
  },
  {
    topic: 'serangan siber',
    category: 'siber',
    eventType: 'intrusion',
    detect: c => {
      const t = c.normGeo;
      const hasCyberAction = /\b(?:ransomware|malware|diserang|diretas|dibobol|dibajak|terenkripsi|dienkripsi|dicuri|bocor|kebocoran\s+data|data\s+breach|ddos|defacement|deface|phishing|dieksploitasi|lumpuh)\b/.test(t);
      const hasCyberTarget = /\b(?:server|sistem|jaringan|database|situs|website|layanan|akun|data|pdn|bssn|bank|rumah\s+sakit|pemerintah|kementerian|aplikasi)\b/.test(t);
      if (!hasCyberAction) return null;
      const type = /\b(?:ransomware|lockbit|blackcat)\b/.test(t) ? 'ransomware'
        : /\bddos\b/.test(t) ? 'ddos'
        : /\b(?:bocor|kebocoran|breach)\b/.test(t) ? 'data_breach'
        : 'intrusion';
      return { action: 'cyber_attack', strong: hasCyberTarget, type };
    },
  },
  {
    topic: 'konflik',
    category: 'politik',
    eventType: 'konflik',
    detect: c => {
      const t = c.normGeo;
      if (CEREMONY_RE.test(t)) return null;
      const activeCombat = /\b(?:baku\s+tembak|kontak\s+senjata|serangan\s+udara|serangan\s+rudal|serangan\s+bom|invasi|kudeta|gencatan\s+senjata|darurat\s+militer|pertempuran\s+(?:sengit|bersenjata)|operasi\s+militer|penyanderaan|kkb\s+papua|separatis\s+menyerang)\b/.test(t);
      if (!activeCombat) return null;
      return { action: 'armed_conflict', strong: true, type: 'konflik' };
    },
  },
  {
    topic: 'politik',
    category: 'politik',
    eventType: 'politik',
    detect: c => {
      const t = c.normGeo;

      const act = /\b(?:resmi\s+dilantik|dilantik|mengundurkan\s+diri|dipecat|diberhentikan|reshuffle\s+kabinet|divonis|dimakzulkan|impeachment)\b/.test(t);
      if (!act) return null;
      if (/\b(?:usul|wacana|menurut|komentar|opini|mengkhianati|katanya|andai|jika)\b/.test(t)) return null;
      return { action: 'institutional_event', strong: true, type: 'politik' };
    },
  },
  {
    topic: 'phk',
    category: 'ekonomi',
    eventType: 'phk',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:phk|pemutusan\s+hubungan\s+kerja|dirumahkan|pabrik\s+tutup)\b/.test(t)) return null;
      const strong = /\b(?:melakukan|lakukan|terkena|mengalami|memutus|merumahkan|pabrik\s+tutup|tutup\s+dan\s+lakukan\s+phk|(?:puluhan|ratusan|ribuan|\d+)\s+(?:buruh|karyawan|pekerja))\b/.test(t);
      return { action: 'layoffs', strong, type: 'phk' };
    },
  },
  {
    topic: 'ihsg',
    category: 'ekonomi',
    eventType: 'ihsg',
    detect: c => {
      const t = c.normGeo;
      if (!/\b(?:trading\s+halt|bursa\s+efek\s+indonesia|\bihsg\b)\b/.test(t)) return null;
      const strong = /\b(?:trading\s+halt|suspensi\s+perdagangan|dihentikan\s+sementara)\b/.test(t);
      if (!strong) return null;
      return { action: 'market_halt', strong: true, type: 'ihsg' };
    },
  },
];

function extractImpact(rawOrNorm) {
  const s = String(rawOrNorm || '');
  const impact = { fatalities: null, injuries: null, displacement: null, propertyDamage: null };

  let m = s.match(/\b(\d+)\s+(?:orang\s+|warga\s+|korban\s+|jiwa\s+|penumpang\s+|siswa\s+)?(?:tewas|meninggal(?:\s+dunia)?|wafat|gugur)\b/i)
    || s.match(/\b(?:tewas|meninggal(?:\s+dunia)?)\s+(?:sebanyak\s+)?(\d+)\s+(?:orang|warga|jiwa)\b/i);
  if (m) impact.fatalities = Number(m[1]);
  else if (/\b(?:tidak|belum|nihil|nol)\s+ada\s+(?:laporan\s+)?korban\s+(?:jiwa|meninggal|tewas)\b/i.test(s)) impact.fatalities = 0;
  else if (/\b(?:dua|2)\s+(?:orang\s+|warga\s+)?(?:tewas|meninggal)\b/i.test(s)) impact.fatalities = 2;
  else if (/\b(?:satu|seorang)\s+(?:orang\s+|warga\s+|pria|wanita|siswa|anak|korban)?\s*(?:tewas|meninggal)\b/i.test(s)) impact.fatalities = 1;
  else if (/\b(?:tiga)\s+(?:orang\s+|warga\s+)?(?:tewas|meninggal)\b/i.test(s)) impact.fatalities = 3;

  m = s.match(/\b(\d+)\s+(?:orang\s+|warga\s+|korban\s+|petugas\s+)?(?:luka(?:-luka|\s+berat|\s+ringan)?|terluka|cedera)\b/i);
  if (m) impact.injuries = Number(m[1]);

  m = s.match(/\b(\d+|puluhan|ratusan|ribuan)\s+(?:orang\s+|warga\s+|kk\s+|keluarga\s+)?(?:mengungsi|dievakuasi|terdampak)\b/i);
  if (m) impact.displacement = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1].toLowerCase();

  m = s.match(/\b(\d+|puluhan|ratusan|ribuan|sejumlah|banyak)\s+(?:rumah|ruko|kios|warung|bangunan|gedung|atap\s+rumah|mobil|kendaraan|motor|kapal)\s+(?:terendam|rusak|hangus|ludes|terbakar|hancur|ambruk|tertimbun|tenggelam)\b/i);
  if (m) impact.propertyDamage = m[0].toLowerCase();

  return impact;
}

function extractAffectedEntity(text) {
  const s = String(text || '');
  if (/\b(?:rumah\s+warga|permukiman|pemukiman|perumahan|rumah\s+saya|kosan|kontrakan|rumah|warga)\b/i.test(s)) return 'residential_area';
  if (/\b(?:ruko|toko|kios|warung|pasar|mall|pusat\s+perbelanjaan|hotel)\b/i.test(s)) return 'commercial_building';
  if (/\b(?:pabrik|gudang|kilang|industri|kawasan\s+industri)\b/i.test(s)) return 'industrial_facility';
  if (/\b(?:sekolah|sdn|smp|sma|smk|madrasah|pesantren|kampus|universitas|siswa|murid|mahasiswa|santri)\b/i.test(s)) return 'school';
  if (/\b(?:rumah\s+sakit|rsud|rsup|puskesmas|klinik|pasien)\b/i.test(s)) return 'hospital';
  if (/\b(?:jembatan|jalan\s+tol|jalan\s+raya|jalan|tol|ruas\s+jalan|kendaraan|mobil|truk|bus|motor|kereta|krl|mrt|lrt)\b/i.test(s)) return 'road_infrastructure';
  if (/\b(?:kapal|perahu|feri|ferry|tongkang|speedboat|dermaga|pelabuhan)\b/i.test(s)) return 'vessel';
  if (/\b(?:listrik|gardu|trafo|pln|jaringan\s+listrik)\b/i.test(s)) return 'power_grid';
  if (/\b(?:server|database|situs|website|pdn|peretasan|diretas|diserang|ransomware|kebocoran\s+data)\b/i.test(s)) return 'digital_system';
  if (/\b(?:hutan|lahan|gambut|gunung|tebing)\b/i.test(s)) return 'natural_environment';
  return null;
}

function extractEventTime(text, isHistorical) {
  const s = String(text || '');
  if (isHistorical) {
    const m = s.match(/\b(?:tahun|pada|sejak|era)\s+((?:19|20)\d{2})\b|\b(?:dulu|jaman\s+dulu|tahun\s+lalu|bulan\s+lalu|pekan\s+lalu|kemarin)\b/i);
    return { value: m ? m[0].toLowerCase() : null, type: 'historical' };
  }
  if (/\b(?:peringatan\s+(?:dini|cuaca|tsunami|banjir)|berpotensi|potensi|waspada|siaga|awas|hingga\s+(?:sore|malam|besok))\b/i.test(s)) {
    const m = s.match(/\bhingga\s+(?:sore|malam|besok|pukul\s+\d{1,2}[:.]\d{2}\s*wib)\b/i);
    return { value: m ? m[0].toLowerCase() : null, type: 'warning_forecast' };
  }
  const exact = s.match(/\b(?:pukul\s+\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:wib|wita|wit)?|\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\s*(?:wib|wita|wit)|barusan|baru\s+saja|saat\s+ini|hari\s+ini|pagi\s+ini|siang\s+ini|sore\s+ini|malam\s+ini|tadi\s+(?:pagi|siang|sore|malam)|semalam)\b/i);
  if (exact) {
    return { value: exact[0].toLowerCase(), type: /\b(?:barusan|baru\s+saja|saat\s+ini)\b/i.test(exact[0]) ? 'current' : 'recent' };
  }
  return { value: null, type: 'unknown' };
}

const FOREIGN_MARKER_RE = /\b(chiba|odesa|kharkiv|tel aviv|abu dhabi|dubai|jepang|japan|nepal|london|oyo|osun|nigeria|amerika|united states|\busa\b|americans?|american|british|canadian|australian|japanese|chinese|korean|french|german|russian|indian|ukrainian|israeli|palestinian|malaysian|singaporean|filipino|vietnamese|brazilian|mexican|european|texas|california|new york|michigan|florida|ohio|illinois|pennsylvania|virginia|washington|boston|chicago|los angeles|brasil|brazil|filipina|philippines|thailand|malaysia|m'sia|msia|lebuhraya|sejuk beku|bekalan makanan|plusline|llmtrafik|korang|macam ni|banjir tak|banjir ke|kesiannya|memandu|tanpa halangan banjir|terowong smart|berbaki|penyokong|rombak kabinet|bubarkan parlimen|bubar parlimen|parlimen|timbalan perdana menteri|pakatan harapan|perikatan nasional|barisan nasional|umno|menteri besar|ketua menteri|dewan rakyat|dewan negara|kerajaan perpaduan|kerajaan madani|malaysia madani|varian baharu|baharu|dikesan|sejauh mana bahayanya|siakap keli|thesiakapkeli|banjir kilat|jabatan bomba|polis diraja|kawasan terjejas|hospital kerajaan|kementerian kesihatan|kelantan|pulau pinang|sabah|sarawak|terengganu|pahang|kedah|perak|selangor|putrajaya|negeri sembilan|melaka|kota kinabalu|kuching|ipoh|seremban|alor setar|kuantan|kuala terengganu|kota bharu|astro awani|awani|jbpm|pdrm|korea|china|tiongkok|inggris|britain|prancis|perancis|paris|france|eiffel|jerman|germany|australia|india|pakistan|iran|israel|palestina|palestine|ukraina|ukraine|rusia|russia|gaza|turki|turkey|meksiko|mexico|kanada|canada|vietnam|chile|argentina|spanyol|spain|portugal|italia|italy|belanda|netherlands|den haag|s-gravenhage|tweede kamer|eerste kamer|vvd|cda|d66|pvv|fvd|nsc|gl-pvda|groenlinks|pvda|nederland|nederlands|holland|amsterdam|rotterdam|utrecht|eindhoven|groningen|kabinet rutte|kabinet schoof|dick schoof|geert wilders|swiss|swedia|sweden|norwegia|norway|denmark|yunani|greece|eropa|europe|fincen|poland|polandia|polonia|krakow|warsaw|warszawa|warschau|lublin|gdansk|wroclaw|poznan|szczecin|czechia|czech|ceko|prague|praha|brno|ostrava|austria|vienna|wina|salzburg|innsbruck|finland|finlandia|helsinki|singapura|singapore|hong kong|taipei|tokyo|kyoto|osaka|seoul|pyongyang|beijing|shanghai|guangzhou|shenzhen|manila|bangkok|chiang mai|hanoi|haiphong|vientiane|phnom penh|kualalumpur|kuala lumpur|penang|johor|kathmandu|colombo|islamabad|karachi|lahore|mumbai|delhi|new delhi|chennai|kolkata|dhaka|chittagong|yangon|mandalay|ulaanbaatar|timor leste|papua new guinea|port moresby|brunei|darussalam|afghanistan|kabul|herat|suriah|syria|irak|iraq|mesir|egypt|cairo|giza|libya|libia|maroko|morocco|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|georgia|panama|san francisco)\b|\btpm\b(?=\s+(?:pula|kata|malaysia|dato|datuk|zahid|fadillah))/i;
const LOCAL_ORG_RE = /\b(bmkg|bnpb|bpbd|bssn|pdn|polri|pln|kpu|bawaslu|komdigi|kominfo|bank indonesia|bursa efek indonesia|ihsg|kemenkes|kemensos|kemdikbud|kemendikdasmen|kemenhub|kejaksaan|kemenkumham|kementerian|pemkot|pemkab|pemprov|dishub|damkar|bpjs|taspen|bri|bni|mandiri|basarnas|knkt|kpk|polres|polda|polsek|kodim)\b/i;
const LOCAL_MACRO_RE = /\b(?:(?:di|in|wilayah|pulau|kawasan)\s+indonesia|jabodetabek|sumatera|sumatra|kalimantan|sulawesi|nusa\s+tenggara|kepulauan\s+riau|bangka\s+belitung|pantura|\bwni\b|tol\s+(?:cipularang|jagorawi|cikampek|cipali|palikanci|pejagan|cisumdawu|mbz|japek|trans\s+jawa|bali\s+mandara)|jembatan\s+suramadu|sungai\s+ciliwung|kali\s+bekasi|gunung\s+(?:semeru|merapi|marapi|bromo|sinabung|lewotobi|rinjani|agung))\b/i;

function formatLoc(loc) {
  if (!loc) return null;
  return {
    name: loc.name,
    prov: loc.prov,
    prec: loc.prec,
    la: loc.la,
    lo: loc.lo,
    ...(loc.provCode ? { provCode: loc.provCode } : {}),
    ...(loc.kabCode ? { kabCode: loc.kabCode } : {}),
    ...(loc.kecCode ? { kecCode: loc.kecCode } : {}),
    ...(loc.code ? { code: loc.code } : {}),
  };
}

const READER_SEG_RE = /\b(?:saya|kami|kita)\s+(?:lagi\s+|sedang\s+|posisi\s+)?(?:(?:di|dari)\s+([a-z][a-z\s]{2,26}?)(?:\s*,\s*|\s+)(?:baca|membaca|membacanya|nonton|menonton|lihat|melihat|dengar|mendengar|pantau)|(?:baca|membaca|membacanya|nonton|menonton|lihat|melihat|dengar|mendengar|pantau)[^.!?\n]{0,60}?\bdari\s+([a-z][a-z\s]{2,26}?)(?=[,.;!?]|$))/i;
const AUTHOR_CUR_SEG_RE = /\b(?:kerja|bekerja|tinggal|kuliah|ngekos|ngekost|kost|kos|domisili|menetap|pindah(?:\s+kerja|\s+tugas)?|cari\s+(?:kost|kosan|kontrakan|kerja|loker)|berangkat|based(?:\s+in)?)\s+(?:di|ke|area|daerah|wilayah|in)?\s*([a-z][a-z\s]{2,26}?)(?=[,.;!?]|$|\s+(?:pengen|mau|udah|sudah|karena|harga|yang|dan|atau))/i;
const AUTHOR_HOME_SEG_RE = /\b(?:asli|orang|pulang\s+kampung\s+ke|mudik\s+ke|asal)\s+([a-z][a-z\s]{2,26}?)(?=[,.;!?]|$|\s+(?:yang|di|dan|tapi))/i;
const DATELINE_SEG_RE = /^(?:[A-Z][A-Z\s]{2,24})\s*[—–-]\s+/;

function locateBest(clauseRaw, clauseNormGeo) {
  const l1 = GEO.locate(clauseRaw);
  const l2 = clauseNormGeo && clauseNormGeo !== clauseRaw ? GEO.locate(clauseNormGeo) : null;
  if (l1 && l2) {

    const rank = p => ({ poi: 4, desa: 4, kelurahan: 4, kec: 3, kab: 2, region: 1, prov: 1 }[p] || 0);
    return rank(l2.prec) > rank(l1.prec) ? l2 : l1;
  }
  return l1 || l2;
}

function resolveClauseGeo(clause, clauseIntentHints) {
  const raw = clause.rawNoTags || clause.raw || '';
  const norm = clause.normGeo || '';
  const nfd = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const foreignHit = FOREIGN_MARKER_RE.test(nfd);

  const mentions = [];
  let strippedForEventRaw = raw;
  let strippedForEventNorm = norm;

  const rm = READER_SEG_RE.exec(norm) || READER_SEG_RE.exec(raw);
  if (rm) {
    const locTxt = (rm[1] || rm[2] || '').trim();
    const rLoc = locTxt ? locateBest(locTxt, locTxt) : null;
    if (rLoc) {
      mentions.push({ ...formatLoc(rLoc), role: GEO_ROLES.READER_LOCATION, confidence: 0.88, span: rm[0].trim() });
      strippedForEventNorm = strippedForEventNorm.replace(rm[0], ' ');
      strippedForEventRaw = strippedForEventRaw.replace(new RegExp(locTxt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    }
  }

  const am = AUTHOR_CUR_SEG_RE.exec(norm) || AUTHOR_CUR_SEG_RE.exec(raw);
  if (am) {
    const locTxt = (am[1] || '').trim();
    const aLoc = locTxt ? locateBest(locTxt, locTxt) : null;
    if (aLoc && !/\b(?:kebanjiran|terbakar|banjir|gempa|longsor|ambruk|meledak|terendam)\b/i.test(norm)) {
      mentions.push({ ...formatLoc(aLoc), role: GEO_ROLES.AUTHOR_CURRENT_LOCATION, confidence: 0.85, span: am[0].trim() });
    }
  }

  const hm = AUTHOR_HOME_SEG_RE.exec(norm) || AUTHOR_HOME_SEG_RE.exec(raw);
  if (hm) {
    const locTxt = (hm[1] || '').trim();
    const hLoc = locTxt ? locateBest(locTxt, locTxt) : null;
    if (hLoc) {
      mentions.push({ ...formatLoc(hLoc), role: GEO_ROLES.AUTHOR_HOMETOWN, confidence: 0.82, span: hm[0].trim() });
    }
  }

  const dm = DATELINE_SEG_RE.exec(raw);
  let datelineLoc = null;
  if (dm) {
    datelineLoc = GEO.locate(dm[0]);
    if (datelineLoc) {
      mentions.push({ ...formatLoc(datelineLoc), role: GEO_ROLES.NEWS_SOURCE_LOCATION, confidence: 0.78, span: dm[0].trim() });
      strippedForEventRaw = strippedForEventRaw.slice(dm[0].length);
    }
  }

  const loc = locateBest(strippedForEventRaw, strippedForEventNorm);
  if (foreignHit) {
    const weak = loc && /^(desa|kelurahan|poi)$/.test(loc.prec || '');
    const hasLocalOverride = (loc && !weak) || LOCAL_ORG_RE.test(raw);
    return {
      scope: hasLocalOverride ? 'unknown' : 'foreign',
      location: null,
      primaryRole: foreignHit && !hasLocalOverride ? GEO_ROLES.AMBIGUOUS_ENTITY : GEO_ROLES.UNKNOWN,
      mentions,
    };
  }

  const localOrgOrMacro = LOCAL_ORG_RE.test(raw) || LOCAL_MACRO_RE.test(raw);
  const formatted = formatLoc(loc);

  let role = GEO_ROLES.UNKNOWN;
  let confidence = 0;

  if (formatted) {
    const matchedAuthorMention = mentions.find(m => m.name === formatted.name && (m.role === GEO_ROLES.AUTHOR_CURRENT_LOCATION || m.role === GEO_ROLES.AUTHOR_HOMETOWN || m.role === GEO_ROLES.READER_LOCATION));
    if (clauseIntentHints.isHistorical) {
      role = GEO_ROLES.HISTORICAL_LOCATION;
      confidence = 0.84;
    } else if (matchedAuthorMention && !clauseIntentHints.hasEventEvidence && !clauseIntentHints.hasHazardCue) {
      role = matchedAuthorMention.role;
      confidence = matchedAuthorMention.confidence;
    } else if (clauseIntentHints.isNonEventChatter) {
      role = matchedAuthorMention ? matchedAuthorMention.role : GEO_ROLES.MENTIONED_IN_PASSING;
      confidence = 0.75;
    } else if (clauseIntentHints.hasEventEvidence || clauseIntentHints.isWarning || clauseIntentHints.hasHazardQuestion || clauseIntentHints.hasHazardCue) {

      const hasPrep = new RegExp(`\\b(?:di|ke|wilayah|daerah|kawasan|sekitar|untuk|area|kota|kabupaten|provinsi)\\s+${formatted.name.split(',')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(norm);
      role = GEO_ROLES.EVENT_LOCATION;
      confidence = formatted.prec === 'poi' || formatted.prec === 'kec' || formatted.prec === 'desa' || formatted.prec === 'kelurahan'
        ? (hasPrep ? 0.94 : 0.88)
        : formatted.prec === 'kab'
          ? (hasPrep ? 0.92 : 0.84)
          : (hasPrep ? 0.80 : 0.72);
    } else if (datelineLoc && datelineLoc.name === formatted.name) {
      role = GEO_ROLES.NEWS_SOURCE_LOCATION;
      confidence = 0.76;
    } else {
      role = matchedAuthorMention ? matchedAuthorMention.role : GEO_ROLES.MENTIONED_IN_PASSING;
      confidence = 0.65;
    }

    if (!mentions.some(m => m.name === formatted.name && m.role === role)) {
      mentions.unshift({ ...formatted, role, confidence });
    }
  }

  return {
    scope: (formatted || localOrgOrMacro) ? 'Indonesia' : 'unknown',
    location: formatted,
    primaryRole: role,
    confidence,
    mentions,
  };
}

const GENERIC_GEO_TOKENS = new Set([
  'indonesia', 'ri', 'nkri', 'nusantara', 'nasional', 'daerah', 'wilayah', 'provinsi',
  'kabupaten', 'kota', 'kecamatan', 'desa', 'kelurahan', 'pulau', 'jawa', 'sumatera',
  'sumatra', 'kalimantan', 'sulawesi', 'papua', 'maluku', 'nusa tenggara', 'jabodetabek',
  'jabar', 'jateng', 'jatim', 'dkijakarta', 'dki jakarta', 'jogja', 'yogya',
  'jkt', 'jaksel', 'jaktim', 'jakbar', 'jakut', 'jakpus', 'bdg', 'sby', 'smg', 'bks', 'bgr', 'tgr', 'tangsel', 'dps', 'mks', 'mdn',
]);

function isGenericLocationPhrase(phrase) {
  const clean = String(phrase || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  if (GENERIC_GEO_TOKENS.has(clean)) return true;
  const expanded = GEO_ABBR_MAP[clean] || clean;
  const titled = expanded.replace(/\b[a-z]/g, ch => ch.toUpperCase());
  const loc = GEO.locate(expanded) || GEO.locate(titled) || GEO.locate('di ' + titled) || GEO.locate('Kota ' + titled);
  if (!loc) return false;
  const locNorm = GEO.norm(loc.name).replace(/^(kab|kota|kecamatan|desa|kelurahan)\s+/i, '');
  const provNorm = GEO.norm(loc.prov || '');
  const cleanNorm = GEO.norm(expanded).replace(/^(kab|kabupaten|kota|kecamatan|kec|provinsi|prov|desa|kelurahan|wilayah|daerah)\s+/i, '');
  if (!cleanNorm) return true;
  if (cleanNorm === locNorm || (provNorm && cleanNorm === provNorm)) return true;

  if (locNorm.includes(cleanNorm) && cleanNorm.length >= 4) return true;

  if (/^(jakarta|bandung|surabaya|semarang|medan|makassar|tangerang|bekasi|bogor|depok|yogyakarta)\s+(utara|selatan|timur|barat|pusat|kota|raya)$/i.test(cleanNorm)) return true;
  return false;
}

const EUROPEAN_WORDS_RE = /\b(?:het|een|van|dat|die|voor|naar|niet|zijn|wordt|werd|worden|hebben|heeft|hadden|maar|door|over|deze|onze|jullie|tegen|zich|geen|nieuwe|moeten|mogen|toch|misschien|weer|alleen|wanneer|hoezo|waarom|vanavond|morgen|tussenformeren|verkiezingen|uitslag|regerende|regering|partij|partijen|kandidaat|coalitie|coalitieleden|meerderheid|minderheid|kiezer|stemt|stemmen|stemming|linksaf|rechtsaf|haag|den\s+haag|vvd|cda|d66|pvv|fvd|nsc|tweede\s+kamer|eerste\s+kamer|nederland|nederlands|holland|der|die|das|und|nicht|kabinett|bundestag|scholz|habeck|merz|bundeskanzler|wahl|stimmen|le|la|les|des|dans|pour|avec|macron|gouvernement|ministre|assemblee|el|los|las|del|por|para|con|gobierno|elecciones|partido|muito|voce|você|nao|não|entao|então|governo|eleicoes)\b/gi;

const ID_UNAMBIGUOUS_CORE_RE = /\b(?:yang|yg|untuk|utk|dengan|dgn|sudah|udah|udh|belum|blm|tidak|nggak|ngga|gak|ga|enggak|engga|kagak|kaga|bukan|gue|gw|gua|aku|kami|kita|warga|banget|bgt|dong|deh|kok|sih|jir|anjir|njir|bjir|wkwk\w*|kalo|kalau|karena|krn|karna|terus|trs|masih|msh|bisa|pengen|pingin|bikin|pake|pakai|kemarin|kmrn|barusan|sekarang|skrg|kenapa|knp|gimana|gmn|bagaimana|siapa|apakah|adakah|dimana|dmn|kemana|terjadi|melanda|merendam|mengungsi|tewas|korban|polisi|aparat|rusak|ambruk|roboh|jebol|padam|hujan|kebakaran|banjir|gempa|longsor|terbakar|kecelakaan|tabrakan|penembakan|pencurian|begal|prabowo|gibran|jokowi|dpr\s+ri|jakarta|bandung|surabaya|semarang|medan|makassar|bekasi|depok|tangerang|bogor|pim|pln|kemang|jaksel)\b/gi;

function detectLanguageProfile(rawText) {
  const raw = String(rawText || '');
  const clean = raw.replace(/https?:\/\/\S+|[@#]\S+/g, ' ').trim();
  const idHits = (clean.match(ID_UNAMBIGUOUS_CORE_RE) || []).length;
  const euroHits = (clean.match(EUROPEAN_WORDS_RE) || []).length;
  if (idHits >= 2) {
    return { isForeign: false, lang: 'ind', euroHits, idHits };
  }
  const lang = francModule ? francModule(clean) : 'und';
  const foreignLangDetected = ['nld', 'deu', 'fra', 'spa', 'por', 'ita', 'rus', 'pol', 'dan', 'swe', 'nor'].includes(lang);
  const candidateForeign = (euroHits >= 2 && idHits === 0) || (foreignLangDetected && idHits < 2) || (euroHits >= 4 && idHits < 2);
  if (!candidateForeign) {
    return { isForeign: false, lang, euroHits, idHits };
  }
  let hasLocal = LOCAL_ORG_RE.test(clean) || LOCAL_MACRO_RE.test(clean);
  if (!hasLocal) {
    const loc = GEO.locate(clean);
    hasLocal = Boolean(loc && !/^(desa|kelurahan|poi)$/.test(loc.prec || ''));
  }
  return {
    isForeign: !hasLocal,
    lang,
    euroHits,
    idHits,
  };
}

function analyzePost(rawText, options = {}) {
  const year = Number.isFinite(options.year) ? options.year : new Date().getFullYear();
  const normDoc = normalizeIndonesian(rawText);
  const fullNorm = normDoc.normalizedGeo;
  const proseNorm = normalizePhraseText(normDoc.decoded.replace(/#[\p{L}\p{N}_]+/gu, ' '), true);

  const langProfile = detectLanguageProfile(rawText);
  if (langProfile.isForeign) {
    const scores = Object.fromEntries(INTENTS.map(i => [i, 0]));
    scores.unrelated = 0.95;
    return {
      normDoc,
      clauses: normDoc.clauses.map(c => ({
        clause: c,
        geo: { scope: 'foreign', location: null, primaryRole: GEO_ROLES.UNKNOWN, confidence: 0, mentions: [] },
        events: [],
        flags: {
          isDenial: false, isHist: false, isQuest: false, isHearsay: false, isCond: false,
          isEdu: false, isCeremony: false, isOfficialAgency: false, isWarning: false,
          isOfficialUpdate: false, isEyewitness: false, isCommercial: false, isAd: false,
          isVent: false, isOpinion: false, isSpam: false, isReader: false, isCommentaryMeta: false,
          hasHazardCue: false, hasSituationalSupplyCue: false, hasHazardQuestion: false,
          hasEventEvidence: false, metaphors: [], negatedTokens: [],
        },
      })),
      intent: 'unrelated',
      intentScores: scores,
      confidence: 0.95,
      geographicContext: { name: null, prov: null, prec: null, role: GEO_ROLES.UNKNOWN, confidence: 0, mentions: [] },
      event: null,
      extractedEvents: [],
      negatedEvents: [],
      metaphorHits: [],
      flags: {
        anyForeign: true,
        anyOfficialWarning: false,
        anyOfficialUpdate: false,
        anyEyewitness: false,
        anyDenial: false,
        anyHistorical: false,
        anyQuestion: false,
        anyHearsay: false,
        anyEducational: false,
        anyCommercial: false,
        anyAd: false,
        anyVent: false,
        anyOpinion: false,
        anySpam: false,
        anyMetaphor: false,
        anyReaderAction: false,
        anyMinorWaterlogging: false,
        hasActionableEvent: false,
      },
      layerTrace: {
        isForeignLanguage: true,
        detectedLang: langProfile.lang,
        normalization: {
          clauses: normDoc.clauses.length,
          hashtagsSegmented: normDoc.hashtagsSegmented,
          reduplication: normDoc.reduplication,
        },
        intentScoresTop3: [['unrelated', 0.95]],
        geoRole: GEO_ROLES.UNKNOWN,
        negatedEvents: [],
        metaphors: [],
      },
    };
  }

  const clauseResults = [];
  const allMentions = [];
  const negatedEvents = new Set();
  let anyForeign = false;
  let anyOfficialWarning = false;
  let anyOfficialUpdate = false;
  let anyEyewitness = false;
  let anyDenial = false;
  let anyHistorical = false;
  let anyQuestion = false;
  let anyHearsay = false;
  let anySatire = false;
  let anyEducational = false;
  let anyCommercial = false;
  let anyAd = false;
  let anyVent = false;
  let anyOpinion = false;
  let anySpam = false;
  let anyMetaphor = false;
  let anyReaderAction = false;
  let anyMinorWaterlogging = false;

  const detectedEvents = [];
  const metaphorHits = [];

  for (const c of normDoc.clauses) {
    const t = c.normGeo;
    const rawC = c.rawNoTags || c.raw;

    const negatedTokens = new Set();
    for (const m of t.matchAll(NEG_PREFIX_RE)) {
      negatedTokens.add(m[1].trim());
    }
    for (const m of t.matchAll(NEG_POST_RE)) {
      negatedTokens.add(m[1].toLowerCase());
    }
    for (const m of t.matchAll(FREE_OF_DISASTER_RE)) {
      negatedTokens.add(m[0].toLowerCase());
    }

    const corrMatch = CORRECTION_RE.exec(t);
    let activeTextForEvent = t;
    let negatedClausePart = '';
    if (corrMatch) {
      negatedClausePart = corrMatch[1];
      activeTextForEvent = corrMatch[2];
      for (const kw of ['banjir', 'gempa', 'kebakaran', 'longsor', 'kecelakaan', 'ledakan', 'tsunami']) {
        if (negatedClausePart.includes(kw)) {
          negatedTokens.add(kw);
          negatedEvents.add(kw);
        }
      }
    }

    const isDenial = DENIAL_ANY_RE.test(rawC) || DENIAL_ANY_RE.test(t) || NEG_POST_RE.test(t);
    const isHist = isHistoricalClause(rawC, year) || isHistoricalClause(t, year);
    const isQuest = c.hasQuestionMark || QUESTION_RE.test(t) || QUESTION_RE.test(rawC);
    const hasMainClauseBeforeComma = /^[^,]{8,},\s+(?:ruko|rumah|gedung|bangunan|toko|pabrik|kantor|lahan|mobil)\s+(?:itu|tersebut|ini)\b/i.test(rawC);
    const isHearsay = !hasMainClauseBeforeComma && HEARSAY_RE.test(t);
    const isCond = CONDITIONAL_RE.test(t);
    const isEdu = EDUCATION_RE.test(t) || EDUCATION_RE.test(rawC);
    const isCeremony = CEREMONY_RE.test(t) || CEREMONY_RE.test(rawC);
    const isOfficialAgency = OFFICIAL_AGENCY_RE.test(rawC) || OFFICIAL_AGENCY_RE.test(t) || OFFICIAL_AGENCY_RE.test(normDoc.decoded);
    const isWarning = !isCeremony && (OFFICIAL_WARNING_RE.test(t) || OFFICIAL_WARNING_RE.test(rawC));
    const isOfficialUpdate = isOfficialAgency && OFFICIAL_UPDATE_RE.test(t) && !isWarning && !isCeremony;
    const isEyewitness = EYEWITNESS_FRAMING_RE.test(t) || EYEWITNESS_FRAMING_RE.test(rawC);
    const isCommercial = COMMERCIAL_LISTING_RE.test(rawC) || COMMERCIAL_LISTING_RE.test(t);
    const strongListingDeal = /\b(?:over\s*kredit|for\s*sale|for\s*rent|open\s*rent|looking\s*to\s*rent|\bwts\b|\bwtb\b|\bwtt\b|loker|lowongan\s+kerja|kirim\s+cv|kpr|dp\s*(?:0|nol)|cicilan|booking\s*fee|nego|siap\s+huni|lt\s*\d+|lb\s*\d+|shm|hgb|tahun\s+pembelian|transmisi|stnk|\bkm\s*:?\s*\d|showroom|ready\s*stock|open\s*order|pre[- ]?order|jastip|war\s+tiket|sewa\s+(?:raket|kamera|iphone|samsung|kost|kosan|kontrakan|apartemen|ruko|armybomb|army\s*bomb|lightstick)|rekomendasi\s+(?:kost|kosan|kontrakan|cafe|kafe|kuliner|makanan|cakes?|salon|dokter|klinik|tempat|bengkel|laundry|hotel|villa)|recommendation)\b/i.test(rawC);
    const hasCyberIncidentCue = /\b(?:database|data\s+pasien|kebocoran\s+data|data\s+breach|diretas|dibobol|hacker|ransomware|malware)\b/i.test(t);
    const hasPhysicalDisasterCue = /\b(?:kebakaran|terbakar|banjir\s+merendam|banjir\s+bandang|gempa|erupsi|longsor\s+menutup|puting\s+beliung|kecelakaan|tabrakan|tertembak|pembunuhan)\b/i.test(t);
    const isAd = ADVERTISEMENT_RE.test(rawC) || ADVERTISEMENT_RE.test(t);
    const isVent = PERSONAL_VENT_RE.test(rawC) || PERSONAL_VENT_RE.test(t);
    const isOpinion = OPINION_PRAISE_RE.test(rawC) || OPINION_PRAISE_RE.test(t);
    const isSpam = SPAM_SCAM_RE.test(rawC) || SPAM_SCAM_RE.test(t);
    const isReader = READER_ACTION_RE.test(t);
    const isCommentaryMeta = /\b(?:ramai\s+dibahas|jadi\s+perbincangan|netizen\s+(?:bahas|soroti)|dampak\s+(?:kebijakan|ekonomi)\s+terhadap|menuai\s+(?:pro\s+dan\s+kontra|kritik|kecaman|pujian)|polemik\s+soal|pengamat\s+menilai)\b/i.test(t);

    const isSatire = SATIRE_IRONY_RE.test(t)
      || (FREE_OF_DISASTER_RE.test(t) && (isHearsay || normDoc.emojiSignals.mockery))
      || (normDoc.emojiSignals.mockery && /\b(?:banjir|gempa|kebakaran|macet|demo|tenggelam)\b/.test(t));

    const clauseMetaphors = [];
    for (const mf of METAPHOR_FRAMES) {
      if (mf.id === 'metaphor_jatuh' && /\b(?:trading\s+halt|bursa\s+efek)\b/i.test(t)) continue;
      if (mf.re.test(t) || mf.re.test(rawC)) clauseMetaphors.push(mf.id);
    }
    if (clauseMetaphors.length) metaphorHits.push(...clauseMetaphors);

    const evalClause = { ...c, normGeo: activeTextForEvent };
    const clauseEvents = [];
    const effectiveCommercial = isCommercial && !hasCyberIncidentCue && (strongListingDeal || !hasPhysicalDisasterCue);
    const skipForEvents = isEdu || isCeremony || effectiveCommercial || isAd || isVent || isSpam || isSatire || isCond;

    if (!skipForEvents) {
      for (const frame of EVENT_FRAMES) {
        if (metaphorBlocksTopic(clauseMetaphors, frame.topic)) continue;
        const det = frame.detect(evalClause);
        if (!det) continue;

        const isTopicNegated = det.minorWaterlogging
          ? (negatedTokens.has('genangan') || negatedTokens.has('waterlogging') || new RegExp(`\\b${NEG_WORDS}\\s+(?:ada\\s+)?genangan\\b`, 'i').test(activeTextForEvent))
          : (negatedTokens.has(frame.topic) || negatedTokens.has(det.type)
            || new RegExp(`\\b${NEG_WORDS}\\s+(?:ada\\s+|terjadi\\s+|mengalami\\s+)?(?:${frame.topic}|${det.type})\\b`, 'i').test(activeTextForEvent)
            || FREE_OF_DISASTER_RE.test(activeTextForEvent));
        if (isTopicNegated) {
          negatedEvents.add(det.minorWaterlogging ? 'genangan' : frame.topic);
          continue;
        }
        clauseEvents.push({ ...det, topic: frame.topic, category: frame.category });
      }
    }

    const hasPriceWord = /\b(?:harga|tarif|biaya|ongkos|tiket|penduduk|order|penjualan|omzet)\b/.test(t);
    const hasHazardCue = (/\b(?:banjir|kebanjiran|gempa|tsunami|erupsi|kebakaran|terbakar|longsor|kecelakaan|tabrakan|penembakan|begal|(?:ber|men|di)?demo|unjuk\s+rasa|aksi\s+massa|kampus\s+dikepung|kawan\s+diculik|gas\s+air\s+mata|water\s+cannon|bentrok|ricuh|(?:ga|gak|tidak|kurang)\s+kondusif|keracunan|listrik\s+padam|mati\s+lampu|puting\s+beliung|angin\s+kencang|phk|pemutusan\s+hubungan\s+kerja|pabrik\s+tutup|trading\s+halt)\b|\btanggul\b[^.!?\n]{0,20}\bjebol\b|\b(?:gunung|g\.)\s+[a-z]+\b[^.!?\n]{0,30}\bstatus\b[^.!?\n]{0,20}\b(?:awas|siaga)\b|\b(?:gelar|menggelar|melakukan)\s+aksi\b|\baksi\s+(?:tolak|menolak|mahasiswa|buruh|massa)\b|\b(?:air(?:\s+(?:hujan|kali|sungai|selokan|got))?)\s+(?:(?:sudah|mulai|lagi|terus)\s+){0,3}(?:naik|masuk)/.test(t)
      || (!hasPriceWord && /\b(?:ledakan|meledak)\b/.test(t)))
      && !effectiveCommercial && !isAd && !isVent && clauseMetaphors.length === 0;
    const hasSituationalSupplyCue = /\b(?:antrean\s+(?:bbm|spbu|pertalite|pertamax|solar)|kelangkaan\s+(?:bbm|elpiji|beras)|harga\s+(?:beras|telur|minyak\s+goreng|cabai|gula|sembako|bbm)[^.!?\n]{0,55}\b(?:naik|melonjak|merangkak|mahal|turun|melambung)|operasi\s+pasar|antrean\s+panjang\s+di\s+spbu|(?:bansos|bantuan\s+(?:sosial|langsung\s+tunai)|pkh|bpnt|blt)\b[^.!?\n]{0,40}\b(?:cair|pencairan|disalurkan|penerima|kemensos))\b/.test(t)
      && !effectiveCommercial && !isAd && !isVent && !isSpam && clauseMetaphors.length === 0;
    const hasHazardQuestion = isQuest && hasHazardCue && !/\brekomendasi\b/.test(t);

    const hasEventEvidence = clauseEvents.some(e => e.strong) || (isWarning && (hasHazardCue || /\b(?:hujan\s+ekstrem|hujan\s+lebat|cuaca\s+ekstrem|gelombang\s+tinggi|angin\s+kencang|evakuasi)\b/.test(t)));
    if (clauseEvents.some(e => e.minorWaterlogging)) anyMinorWaterlogging = true;

    const geo = resolveClauseGeo(c, {
      isHistorical: isHist,
      hasEventEvidence,
      isWarning,
      hasHazardCue: hasHazardCue && !isDenial,
      hasHazardQuestion,
      isNonEventChatter: isDenial || isCommercial || isAd || isVent || isOpinion || isSpam || isEdu || clauseMetaphors.length > 0,
    });

    if (geo.scope === 'foreign') anyForeign = true;
    allMentions.push(...geo.mentions);

    anyOfficialWarning = anyOfficialWarning || isWarning;
    anyOfficialUpdate = anyOfficialUpdate || isOfficialUpdate;
    anyEyewitness = anyEyewitness || isEyewitness || clauseEvents.some(e => e.eyewitnessCue);
    anyDenial = anyDenial || isDenial || (negatedEvents.size > 0 && clauseEvents.length === 0);
    anyHistorical = anyHistorical || isHist;
    anyQuestion = anyQuestion || isQuest;
    anyHearsay = anyHearsay || isHearsay;
    anySatire = anySatire || isSatire;
    anyEducational = anyEducational || isEdu;
    anyCommercial = anyCommercial || effectiveCommercial;
    anyAd = anyAd || isAd;
    anyVent = anyVent || isVent;
    anyOpinion = anyOpinion || isOpinion;
    anySpam = anySpam || isSpam;
    anyMetaphor = anyMetaphor || clauseMetaphors.length > 0;
    anyReaderAction = anyReaderAction || isReader;

    clauseResults.push({
      clause: c,
      geo,
      events: clauseEvents,
      flags: {
        isDenial, isHist, isQuest, isHearsay, isCond, isEdu, isCeremony,
        isOfficialAgency, isWarning, isOfficialUpdate, isEyewitness,
        isCommercial, isAd, isVent, isOpinion, isSpam, isReader, isSatire, isCommentaryMeta,
        hasHazardCue, hasSituationalSupplyCue, hasHazardQuestion, hasEventEvidence,
        metaphors: clauseMetaphors,
        negatedTokens: [...negatedTokens],
      },
    });
  }

  for (let i = 0; i < clauseResults.length; i++) {
    const cr = clauseResults[i];
    if (!cr.geo.location && cr.geo.scope === 'unknown' && !anyForeign && (cr.events.length > 0 || cr.flags.isWarning)) {
      for (const adj of [i - 1, i + 1]) {
        const nb = clauseResults[adj];
        if (!nb) continue;
        const badRole = nb.geo.primaryRole === GEO_ROLES.READER_LOCATION ||
          nb.geo.primaryRole === GEO_ROLES.AUTHOR_CURRENT_LOCATION ||
          nb.geo.primaryRole === GEO_ROLES.AUTHOR_HOMETOWN ||
          nb.geo.primaryRole === GEO_ROLES.HISTORICAL_LOCATION;
        if (nb.geo.scope === 'Indonesia' && nb.geo.location && !badRole &&
            !nb.flags.isDenial && !nb.flags.isHist && !nb.flags.isReader && !nb.flags.isHearsay &&
            !nb.flags.isCommercial && !nb.flags.isAd && !nb.flags.isVent && !nb.flags.isOpinion && !nb.flags.isSpam) {
          cr.geo.scope = 'Indonesia';
          cr.geo.location = nb.geo.location;
          cr.geo.primaryRole = GEO_ROLES.EVENT_LOCATION;
          cr.geo.confidence = Math.max(0.76, (nb.geo.confidence || 0.8) - 0.06);
          allMentions.unshift({ ...nb.geo.location, role: GEO_ROLES.EVENT_LOCATION, confidence: cr.geo.confidence });
          break;
        }
      }
    }
  }

  const impact = extractImpact(proseNorm);
  const affectedEntity = extractAffectedEntity(proseNorm);
  const globalEventTime = extractEventTime(proseNorm, anyHistorical && !clauseResults.some(c => c.events.length > 0 && !c.flags.isHist));

  for (const cr of clauseResults) {
    for (const ev of cr.events) {
      if (cr.flags.isDenial || cr.flags.isHist) continue;

      const sourceType = cr.flags.isOfficialAgency || cr.flags.isWarning
        ? 'official_agency'
        : (cr.flags.isEyewitness || ev.eyewitnessCue) ? 'eyewitness' : 'anonymous';
      detectedEvents.push({
        topic: ev.topic,
        category: ev.category,
        eventType: ev.type,
        eventAction: ev.action,
        affectedEntity: extractAffectedEntity(cr.clause.normProse) || affectedEntity,
        location: cr.geo.location ? {
          name: cr.geo.location.name,
          prov: cr.geo.location.prov,
          prec: cr.geo.location.prec,
          role: cr.geo.primaryRole === GEO_ROLES.UNKNOWN ? GEO_ROLES.EVENT_LOCATION : cr.geo.primaryRole,
          confidence: +(cr.geo.confidence || 0.85).toFixed(2),
        } : null,
        eventTime: extractEventTime(cr.clause.normProse, cr.flags.isHist),
        impact,
        sourceType,
        evidence: [cr.clause.rawNoTags || cr.clause.raw],
        strong: !!ev.strong,
        minorWaterlogging: !!ev.minorWaterlogging,
        clauseFlags: cr.flags,
        scope: cr.geo.scope,
      });
    }
  }

  if (anyOfficialWarning && detectedEvents.length === 0) {
    const warnClause = clauseResults.find(cr => cr.flags.isWarning && cr.geo.scope !== 'foreign');
    if (warnClause) {
      const t = warnClause.clause.normGeo;
      const isTsunami = /\btsunami\b/.test(t);
      const isFloodWarn = /\b(?:banjir|rob|longsor|luapan)\b/.test(t);
      const isWeatherWarn = /\b(?:hujan\s+ekstrem|hujan\s+lebat|cuaca\s+ekstrem|angin\s+kencang|gelombang|badai|siklon|puting\s+beliung)\b/.test(t);
      const topic = isTsunami ? 'gempa' : isFloodWarn ? 'banjir' : isWeatherWarn ? 'badai' : 'insiden';
      const evType = isTsunami ? 'tsunami' : isFloodWarn ? 'flood' : isWeatherWarn ? 'extreme_weather' : 'warning';
      detectedEvents.push({
        topic,
        category: isTsunami || isWeatherWarn ? 'disaster' : isFloodWarn ? 'flood' : 'insiden',
        eventType: evType,
        eventAction: 'warning_issued',
        affectedEntity: extractAffectedEntity(t) || 'public_area',
        location: warnClause.geo.location ? {
          name: warnClause.geo.location.name,
          prov: warnClause.geo.location.prov,
          prec: warnClause.geo.location.prec,
          role: GEO_ROLES.EVENT_LOCATION,
          confidence: +(warnClause.geo.confidence || 0.9).toFixed(2),
        } : null,
        eventTime: extractEventTime(t, false),
        impact,
        sourceType: 'official_agency',
        evidence: [warnClause.clause.rawNoTags || warnClause.clause.raw],
        strong: true,
        minorWaterlogging: false,
        clauseFlags: warnClause.flags,
        scope: warnClause.geo.scope,
      });
    }
  }

  let geographicContext = { name: null, prov: null, prec: null, role: GEO_ROLES.UNKNOWN, confidence: 0, mentions: allMentions };
  const primaryEvLoc = detectedEvents.find(e => e.strong && e.scope === 'Indonesia' && e.location)?.location || null;
  const bestEventMention = (primaryEvLoc && allMentions.find(m => m.name === primaryEvLoc.name && m.role === GEO_ROLES.EVENT_LOCATION))
    || allMentions.find(m => m.role === GEO_ROLES.EVENT_LOCATION);
  const bestAnyMention = bestEventMention || allMentions[0] || null;
  if (bestAnyMention) {
    geographicContext = {
      name: bestAnyMention.name,
      prov: bestAnyMention.prov || null,
      prec: bestAnyMention.prec || null,
      la: bestAnyMention.la,
      lo: bestAnyMention.lo,
      role: bestAnyMention.role,
      confidence: +(bestAnyMention.confidence || 0.7).toFixed(2),
      mentions: allMentions,
    };
  }

  const scores = Object.fromEntries(INTENTS.map(i => [i, 0]));
  const hasActionableEvent = detectedEvents.some(e => e.strong && e.scope !== 'foreign' && !e.minorWaterlogging && !e.clauseFlags.isQuest && !e.clauseFlags.isHearsay && !e.clauseFlags.isReader && !e.clauseFlags.isCond && !e.clauseFlags.isCommentaryMeta);
  const hasAnyEvent = detectedEvents.length > 0;
  const hasActiveIndonesiaScope = clauseResults.some(cr => cr.geo.scope === 'Indonesia' && !cr.flags.isReader && !cr.flags.isHist);
  const anyCommentaryMeta = clauseResults.some(cr => cr.flags.isCommentaryMeta);

  if (anySpam) scores.spam += 0.92;
  if (anyCommercial && !hasActionableEvent) scores.commercial_listing += 0.91;
  if (anyAd && !hasActionableEvent) scores.advertisement += 0.88;
  if (anyVent && !hasActionableEvent) scores.personal_vent += 0.88;
  if (anyEducational && !hasActionableEvent) scores.educational += 0.86;
  if (anyHistorical && !hasActionableEvent) scores.historical += 0.86;
  if (anySatire && !hasActionableEvent) scores.satire += 0.82;
  if ((anyDenial || (negatedEvents.size > 0 && !hasAnyEvent)) && !hasActionableEvent) {
    scores.denial_or_debunk += (DENIAL_ANY_RE.test(normDoc.decoded) || negatedEvents.size > 0) ? 0.89 : 0.75;
  }
  if (anyQuestion && !anyCommercial && !anySpam) {
    scores.question += clauseResults.some(c => c.flags.hasHazardQuestion) ? 0.84 : 0.78;
  }
  if (anyHearsay && !anyOfficialWarning && !anyEyewitness && !anySatire) {
    scores.rumor += 0.78;
  }
  if (anyOfficialWarning && !anyDenial && !anySatire) {
    scores.official_warning += 0.94;
  }
  if (anyOfficialUpdate && hasActionableEvent) {
    scores.official_update += 0.85;
  }
  if (hasActionableEvent && anyEyewitness && !anyReaderAction && !anyQuestion && !anyHearsay) {
    scores.eyewitness_report += 0.90;
  }
  if (hasActionableEvent && !anyReaderAction && !anyQuestion && !anyHearsay && !anyOfficialWarning) {
    scores.incident_report += 0.89;
  }
  if (anyReaderAction && hasAnyEvent) {
    scores.personal_experience += 0.78;
    scores.discussion += 0.74;
  }
  if (anyCommentaryMeta && !hasActionableEvent) {
    scores.discussion += 0.78;
  }
  if (anyMinorWaterlogging && !hasActionableEvent) {

    scores.eyewitness_report = Math.max(scores.eyewitness_report, 0.78);
    scores.denial_or_debunk = 0;
  }
  if (anyOpinion && !hasActionableEvent) {
    scores.opinion += 0.84;
  }
  if (anyMetaphor && !hasActionableEvent) {
    scores.unrelated += 0.80;
  }

  if (Math.max(...Object.values(scores)) < 0.45) {
    const hasSupplyCue = clauseResults.some(c => c.flags.hasSituationalSupplyCue);
    if ((clauseResults.some(c => c.flags.hasHazardCue) || hasSupplyCue || hasAnyEvent) &&
        (hasActiveIndonesiaScope || LOCAL_ORG_RE.test(normDoc.decoded)) &&
        !anyCommercial && !anyAd && !anyVent && !anyOpinion && !anySpam && !anyMetaphor && !anyDenial && !anyHistorical && !anyEducational) {
      scores.discussion = hasSupplyCue ? 0.64 : 0.62;
    } else if (normDoc.normalizedProse.length < 12) {
      scores.unknown = 0.55;
    } else {
      scores.unrelated = 0.68;
    }
  }

  const PRIORITY_ORDER = [
    'spam', 'commercial_listing', 'advertisement', 'personal_vent', 'educational',
    'historical', 'satire', 'denial_or_debunk', 'official_warning', 'question',
    'rumor', 'eyewitness_report', 'incident_report', 'official_update',
    'personal_experience', 'discussion', 'opinion', 'unrelated', 'unknown',
  ];
  let bestIntent = 'unknown';
  let bestScore = -1;
  for (const intent of PRIORITY_ORDER) {
    if (scores[intent] > bestScore + 0.01) {
      bestScore = scores[intent];
      bestIntent = intent;
    }
  }

  const primaryEv = detectedEvents[0] || null;
  const event = primaryEv ? {
    eventType: primaryEv.eventType,
    eventAction: primaryEv.eventAction,
    affectedEntity: primaryEv.affectedEntity,
    location: primaryEv.location,
    eventTime: primaryEv.eventTime || globalEventTime,
    impact: primaryEv.impact,
    sourceType: primaryEv.sourceType,
    evidence: primaryEv.evidence,
    ...(negatedEvents.size ? { negatedEvents: [...negatedEvents] } : {}),
  } : null;

  return {
    normDoc,
    clauses: clauseResults,
    intent: bestIntent,
    intentScores: scores,
    confidence: +Math.min(0.99, Math.max(0.15, bestScore)).toFixed(2),
    geographicContext,
    event,
    extractedEvents: detectedEvents,
    negatedEvents: [...negatedEvents],
    metaphorHits: [...new Set(metaphorHits)],
    flags: {
      anyForeign,
      anyOfficialWarning,
      anyOfficialUpdate,
      anyEyewitness,
      anyDenial,
      anyHistorical,
      anyQuestion,
      anyHearsay,
      anySatire,
      anyEducational,
      anyCommercial,
      anyAd,
      anyVent,
      anyOpinion,
      anySpam,
      anyMetaphor,
      anyReaderAction,
      anyMinorWaterlogging,
      hasActionableEvent,
    },
  };
}

module.exports = {
  INTENTS,
  FEED_LANES,
  GEO_ROLES,
  REJECT_REASONS,
  decodeBasicEntities,
  normalizeIndonesian,
  normalizePhraseText,
  segmentHashtag,
  isHistoricalClause,
  isGenericLocationPhrase,
  analyzePost,
  extractImpact,
  extractAffectedEntity,
  extractEventTime,
  METAPHOR_FRAMES,
  METAPHOR_TOPIC_SCOPE,
  metaphorBlocksTopic,
  EVENT_FRAMES,
  FOREIGN_MARKER_RE,
  LOCAL_ORG_RE,
  LOCAL_MACRO_RE,
  COMMERCIAL_LISTING_RE,
  ADVERTISEMENT_RE,
  PERSONAL_VENT_RE,
  OPINION_PRAISE_RE,
  SPAM_SCAM_RE,
  READER_ACTION_RE,
};
