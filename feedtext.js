'use strict';
// feedtext.js — pure text utilities for cleaning RSS/Atom description fields.
// No I/O, no requires. Exports: { decodeEntities, htmlToText, descFrom }.

// ---- Named entity table ---------------------------------------------------

// Case-sensitive map. Unknown &name; stays literal.
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•',
  middot: '·', copy: '©', reg: '®', trade: '™', euro: '€',
  times: '×', divide: '÷', minus: '−', deg: '°', plusmn: '±',
  micro: 'µ', para: '¶', sect: '§',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³',
  // lowercase accented Latin
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  atilde: 'ã', otilde: 'õ', ntilde: 'ñ',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü',
  ccedil: 'ç', aring: 'å', oslash: 'ø', aelig: 'æ', szlig: 'ß',
  oelig: 'œ', thorn: 'þ', eth: 'ð', yacute: 'ý',
};
// Uppercase counterparts
Object.assign(ENT, {
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  Acirc: 'Â', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  Atilde: 'Ã', Otilde: 'Õ', Ntilde: 'Ñ',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü',
  Ccedil: 'Ç', Aring: 'Å', Oslash: 'Ø', AElig: 'Æ', THORN: 'Þ',
  ETH: 'Ð', Yacute: 'Ý', OElig: 'Œ',
});

// ---- decodeEntities -------------------------------------------------------

function decodeEntities(s) {
  if (typeof s !== 'string' || s.indexOf('&') === -1) return s || '';
  // numeric refs first: &#123; or &#x1F;
  let out = s.replace(/&#(x[0-9a-fA-F]+|\d+);?/g, function (m, num) {
    const cp = num[0].toLowerCase() === 'x'
      ? parseInt(num.slice(1), 16)
      : parseInt(num, 10);
    if (!Number.isFinite(cp)) return '';
    if (cp < 0 || cp > 0x10FFFF) return '';
    if (cp >= 0xD800 && cp <= 0xDFFF) return ''; // lone surrogate
    if (cp === 0) return '';
    try {
      return String.fromCodePoint(cp);
    } catch (e) {
      return '';
    }
  });
  // named refs — all except amp (require trailing semicolon so URL query params like &reg=1 stay intact)
  out = out.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, function (m, name) {
    if (name === 'amp' || name === 'AMP') return m; // decoded last
    const v = ENT[name];
    return v === undefined ? m : v;
  });
  // amp LAST so "&amp;mdash;" does not double-decode
  out = out.replace(/&amp;/gi, '&');
  return out;
}

// ---- htmlToText -----------------------------------------------------------

// Blocks removed entirely — figure/figcaption dropped whole so photo
// captions ("(pexels)", "(IST)") never merge into the lede text.
const DROP_RE = /<(script|style|noscript|template|svg|iframe|object|form|button|select|nav|footer|header|figure|figcaption)\b[\s\S]*?<\/\1\s*>/gi;
// Closing block boundaries → space.
const BLOCK_RE = /<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|dd|dt)\s*>|<br\s*\/?>/gi;
// Tolerant tag regex: <...> where quoted attr values may contain '>'.
const TAG_RE = /<[^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;
const UNCLOSED_TAG_RE = /<\/?[a-zA-Z][^>]*$/g;
// CDATA wrapper unwrap — tagRaw feeds may still carry it.
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  let t = html;
  t = t.replace(CDATA_RE, '$1');
  t = t.replace(DROP_RE, ' ');
  t = t.replace(BLOCK_RE, ' ');
  t = t.replace(TAG_RE, ' ');
  t = t.replace(UNCLOSED_TAG_RE, ' ');
  t = decodeEntities(t);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ---- cleanDescText (internal) ---------------------------------------------

// Outlet / domain alternation for tail-only stripping.
const OUTLETS = [
  'kompas com', 'kompas', 'detikfinance', 'detikinet', 'detikhot',
  'detikcom', 'detik', 'tempo co', 'tempo', 'liputan6 com', 'liputan6',
  'tribunnews', 'tribun \\w+', 'republika', 'cnbc indonesia',
  'cnbcindonesia', 'cnbc', 'antara news', 'antaranews', 'antara',
  'voi id', 'voi', 'sindonews', 'sindo', 'okezone', 'jawapos',
  'merdeka', 'bisnis com', 'bisnis', 'kontan', 'inews', 'suara',
  'merahputih', 'katadata', 'markeyeers', 'metrotvnews', 'metrotv',
  'tvonenews', 'grid id', 'grid', 'wowkeren', 'hotliputan6', 'wolipop',
  'cewekbanget', 'female daily', 'poskota', 'bali post', 'balipost',
  'jabar', 'jogja', 'espos', 'radar \\w+', 'malang post',
  'suara merdeka', 'pikiran-rakyat', 'bola com', 'bola',
  'jalantikus', 'kumparan', 'beritasatu', 'rmol', 'hops id',
  'mediaindonesia', 'media indonesia', 'rri', 'tagar',
  'cnn indonesia', 'cnnindonesia', 'viva', 'money', 'finance detik',
  'finance', 'tv one', 'tvone', 'tvri', 'jakartaglobe', 'jakarta globe',
  'the jakarta post', 'waspada', 'suaramerdeka',
].sort((a, b) => b.length - a.length);

const DOMAIN_TAIL = '\\S*\\.(?:com|co|co\\.id|co\\.uk|or\\.id|go\\.id|ac\\.id|sch\\.id|net|org|tv|info|media|news|id)\\b';
const OUTLET_RE_SRC = '(?:' + OUTLETS.join('|') + '|' + DOMAIN_TAIL + ')';
const OUTLET_TAIL_RE = new RegExp(
  '[-–—|•·\\s]*' + OUTLET_RE_SRC + '\\s*$', 'i'
);
const OUTLET_HEAD_RE = new RegExp(
  '^\\s*' + OUTLET_RE_SRC + '\\s*[-:–—.]\\s+', 'i'
);

// Read-more / CTA markers — cut text at first occurrence.
const CTA_RE = /\b(?:baca selengkapnya|selengkapnya di|baca berita|baca juga|kunjungi (?:kami|situs|website|fanpage|aplikasi)|ikuti (?:kami|akun|di)|simak selengkapnya|download aplikasi|klik di sini|baca:)\b/i;
// Phone/WA CTA — og:desc mobile publishers append contact numbers.
const PHONE_RE = /\b(?:wa|whatsapp|telp|telepon|hubungi|sms)\s*[:：.]?\s*(?:\+?62|0)8\d{2}[\d\s().-]{6,}\d\b|\b08\d{2}[-\s]?\d{3,4}[-\s]?\d{3,4}\b/gi;

// Inline credit patterns.
// "sumber" is a common noun ("sumber daya/energi") — credit form requires an
// explicit separator (:, –, —, -) or it eats real prose.
const SUMBER_RE = /sumber\s*(?:[:：]|[-–—]{1,2})\s*[^.,;!)\]\-–—]{0,60}/gi;
// Credit content: requires explicit separator (:, -, –) so prose like "video amatir..." stays intact.
// Case-sensitive (no /i) so (?!\s+[A-Z][a-z]) stops before a Capitalized sentence word while allowing ALL-CAPS outlet names.
const MEDIA_CREDIT_RE = /(?:[Ff]oto|FOTO|[Ii]ll?ustrasi|ILUSTRASI|[Gg]ambar|GAMBAR|[Vv]ideo|VIDEO|[Dd]okumen(?:tasi)?|DOKUMEN(?:TASI)?|[Dd]ok\.|DOK\.)\s*(?:[:：]|[-–—]{1,2})\s*(?:[Oo]leh\s+)?[^\s.,;)\]]+(?:(?!\s+[A-Z][a-z])[^.,;)\]]){0,89}/g;
const PAREN_CREDIT_RE = /\([^)]{1,90}(?:foto|dok|sumber|istimewa|illustrasi|dokumen|istock|shutterstock|getty|antaranews|pexels|pixabay|unsplash|freepik|alamy|dreamstime|123rf)[^)]*\)/gi;
const AGENCY_PAREN_RE = /\((?:antaranews|antara news|reuters|afp|getty images?|istimewa|dokumen|ilustrasi|pexels|pixabay|unsplash|freepik|alamy|dreamstime|123rf)\)/gi;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDescText(t) {
  if (typeof t !== 'string' || !t) return '';
  t = t.replace(/\s+/g, ' ').trim();

  // 1. Leading dateline: "KOTA, --", "KOTA –", "JAKARTA, SUMBER --" etc.
  //    Also bare leading "SUMBER -- X" remnants.
  let prev;
  do {
    prev = t;
    // Comma dateline: "KOTA, --", "SUMBER, KOTA --", "REPUBLIKA.CO.ID, JAKARTA --"
    // Segments must be ALL-CAPS (no /i) — lowercase sentence text before an
    // em-dash ("...kebijakan baru — tempo.co") is a publisher tail, not a
    // dateline, and must survive to the tail-strip step.
    t = t.replace(
      /^[A-Z][A-Z0-9 .,&'()\-]{0,90}\s*(?:--|–|—)\s+/,
      ''
    );
    // ALL-CAPS dateline without comma: "YOGYAKARTA - Jerawatan...", "JAKARTA -- Aktris..."
    t = t.replace(/^[A-Z][A-Z0-9 .&'()\-]{1,40}?\s+[-–—]{1,2}\s+(?=[A-Z])/, '');
    t = t.replace(/^(?:sumber\s*(?:--|–|—|-\s))+/i, '');
  } while (t !== prev && t.length);

  // 2. Inline credits.
  t = t.replace(SUMBER_RE, ' ');
  t = t.replace(MEDIA_CREDIT_RE, ' ');
  t = t.replace(PAREN_CREDIT_RE, ' ');
  t = t.replace(AGENCY_PAREN_RE, ' ');
  // leading outlet dateline "ANTARA - " / "Tempo.co: "
  t = t.replace(OUTLET_HEAD_RE, '');

  // 3. Read-more / CTA tail cut.
  const m = t.match(CTA_RE);
  if (m && m.index !== undefined) t = t.slice(0, m.index);

  // 4. URLs + phone/WA CTAs.
  t = t.replace(URL_RE, ' ').replace(PHONE_RE, ' ');

  // 5. Tail-only publisher/source stripping (repeated).
  let guard = 0;
  while (guard++ < 8) {
    const next = t.replace(OUTLET_TAIL_RE, '').replace(/\s+$/, '');
    if (next === t) break;
    t = next;
  }

  // 6. Trailing ellipses from source feeds.
  t = t.replace(/(?:\s*(?:\.{3}|…))+\s*$/, '');

  // 7. Whitespace / punctuation normalization.
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/^[:;,\.\-–—|•·\s]+/, '');
  t = t.replace(/\s+[-–—|]\s*$/, '');
  t = t.replace(/\s+[:;]\s*$/, '');
  t = t.replace(/\(\s*\)/g, '');
  t = t.replace(/\[\s*\]/g, '');
  t = t.replace(/[ \t]+([,.;:!?])/g, '$1');
  t = t.replace(/\.\s*\./g, '.');
  t = t.replace(/\s+,/g, ',');
  t = t.replace(/\s+;/g, ';');
  t = t.replace(/\s+:/g, ':');
  // collapse dash runs left by credit strips ("-- --" → "—")
  t = t.replace(/(?:\s+[-–—]+){2,}\s*/g, ' — ');
  // Trailing dangling function words = source teaser cut mid-phrase ("...GP Brasil 2026 yang")
  // NOTE: 'antara' deliberately excluded — "di antara" is a valid ending.
  for (let i = 0; i < 3; i++) {
    const d = t.replace(/\s+(?:yang|dan|di|ke|dari|untuk|dengan|pada|oleh|sebagai|dalam|atas|bagi|agar|supaya|karena|hingga|sampai|sejak|setelah|sebelum|tentang|terhadap|lewat|melalui|tanpa|adalah|ialah|yaitu|yakni|atau|juga|masih|sudah|telah|akan|bisa|dapat|harus|perlu|ingin|mau|boleh)\s*$/i, '');
    if (d === t) break;
    t = d;
  }
  t = t.trim();

  // 8. Paren balance: drop unmatched ')' and unclosed trailing '('.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) { t = t.slice(0, i) + t.slice(i + 1); i--; continue; }
      depth--;
    }
  }
  if (depth > 0) {
    // drop from last unmatched '('
    depth = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      const c = t[i];
      if (c === ')') depth++;
      else if (c === '(') {
        if (depth === 0) { cut = i; break; }
        depth--;
      }
    }
    if (cut !== -1) t = t.slice(0, cut);
  }
  t = t.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').replace(/\s+/g, ' ').trim();

  // 10. Cap at 520 code points → first 517 + word-boundary trim + '…'
  const pts = Array.from(t);
  if (pts.length > 520) {
    let keep = pts.slice(0, 517).join('');
    const ws = keep.search(/\s+\S*$/); // last whitespace position
    if (ws > 0) keep = keep.slice(0, ws);
    keep = keep.replace(/[\s,.;:!?\-–—|•·]+$/, '');
    t = keep + '…';
  }
  if (BOT_CHALLENGE_RE.test(t)) return '';
  return t;
}

// ---- lede extraction --------------------------------------------------------

// Chrome fragments that survive htmlToText at the head of flattened articles:
// bylines, tag lists, share CTAs, related-links promos. A real lede is prose,
// so these are skipped when picking the opening of a full-article field.
const CHROME_SEG_RE = /^(?:tag\s*:|tags?\s*:|penulis\s*:|red\s*:|reporter\s*:|wartawan\s*:|kontributor\s*:|oleh\s*:|di\s+olah\s+oleh|baca\s+(?:juga|selengkapnya|berita|lainnya|dulu)|bacalah|ikuti\s+(?:kami|akun|channel)|ikuti\s+\S|bagikan|share\s+(?:ke|di|melalui)|jangan\s+lewatkan|lihat\s+juga|berita\s+terkait|topik\s*:|iklan\b|advertisement\b|advertorial\b|sumber\s*:|credit\s*:|foto\s*:)/i;
// Same markers when they land at the very start of a cleaned candidate —
// reject the candidate outright rather than emit page chrome.
const CHROME_HEAD_RE = new RegExp('^(?:' +
  'tag\\s*:|tags?\\s*:|penulis\\s*:|red\\s*:|reporter\\s*:|wartawan\\s*:|kontributor\\s*:|' +
  'oleh\\s*:|di\\s+olah\\s+oleh|baca\\s+(?:juga|selengkapnya|berita|lainnya|dulu)|bacalah|' +
  'ikuti\\s|bagikan|share\\s|jangan\\s+lewatkan|lihat\\s+juga|berita\\s+terkait|topik\\s*:|' +
  'iklan\\b|advertisement\\b|advertorial\\b|sumber\\s*:|credit\\s*:|foto\\s*:)', 'i');

// Bot challenge / CAPTCHA boilerplate — buang kandidat teks yang memuat teks proteksi bot/Cloudflare
const BOT_CHALLENGE_RE = /captcha|recaptcha|lsrecaptcha|cf-chl|challenge-platform|just a moment|attention required|access denied|verify you are|are you a robot|enable javascript and cookies|bot verification|ddos-guard|pardon our interruption|security check|situs ini mungkin memblokir|requiring captcha/i;

// First 1-3 sentence-ish segments of prose, skipping leading chrome.
// Returns '' when nothing usable; callers fall back to the full text.
const ABBR_END_RE = /\b(?:Dr|Prof|Ir|H|Hj|Bp|Bpk|Sdr|Ny|Tn|Jend|Letjen|Mayjen|Brigjen|Kol|Letkol|Mayor|Kapt|Lettu|Letda|Kombes|AKBP|Kompol|AKP|Iptu|Ipda|Bripka|Brigadir|Briptu|Bripda|Pol|TNI|PT|CV|UD|Tb|Tbk|Jl|Jln|No|Rp|Kec|Kab|Prov|Kel|Ds|RT|RW|KM|Km|St|Mt)\.\s*$/i;
function ledeText(t) {
  t = (t || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const rawSegs = t.split(/(?<=[.!?…])\s+/);
  const segs = [];
  for (const s of rawSegs) {
    if (segs.length && ABBR_END_RE.test(segs[segs.length - 1])) {
      segs[segs.length - 1] += ' ' + s;
    } else {
      segs.push(s);
    }
  }
  let i = 0;
  while (i < segs.length) {
    const s = segs[i].trim();
    // chrome head, dangling label ("Tag:", "Baca juga:"), or bare ALL-CAPS kicker
    if (CHROME_SEG_RE.test(s)) { i++; continue; }
    if (s.length < 45 && /[:：]\s*$/.test(s)) { i++; continue; }
    if (/^[A-Z0-9 .&'()\-]{1,60}$/.test(s) && s.length < 45) { i++; continue; }
    break;
  }
  let out = '';
  let n = 0;
  for (let j = i; j < segs.length && n < 3; j++) {
    const s = segs[j].trim();
    if (!s) continue;
    out += (out ? ' ' : '') + s;
    n++;
    if (Array.from(out).length >= 200) break;
  }
  // Thin lede → caller should use the whole cleaned text instead.
  if (Array.from(out).length < 120) return '';
  return out;
}

// ---- descFrom -------------------------------------------------------------

const PUBLISHER_ONLY_RE = new RegExp(
  '^\\s*' + OUTLET_RE_SRC + '\\s*$', 'i'
);

function descFrom(fields, title) {
  const f = fields || {};
  const titleNorm = norm(title);
  // contentEncoded is usually the FULL article — take a proper lede instead of
  // the first ~520 chars of flattened page chrome.
  const cands = [
    { v: f.description, lede: false },
    { v: f.contentEncoded, lede: true },
    { v: f.summary, lede: false },
    { v: f.mediaDescription, lede: false },
  ];
  const cleaned = [];
  for (const c of cands) {
    let s = '';
    if (typeof c.v === 'string' && c.v.trim()) {
      let plain = htmlToText(c.v);
      if (c.lede) {
        const lede = ledeText(plain);
        if (lede) plain = lede;
      }
      s = cleanDescText(plain);
    }
    // Floor matches client display gate (desc shown only when >25 chars).
    if (!s || Array.from(s).length < 26) { cleaned.push(''); continue; }
    if (titleNorm && norm(s) === titleNorm) { cleaned.push(''); continue; }
    if (PUBLISHER_ONLY_RE.test(s) || CHROME_HEAD_RE.test(s) || BOT_CHALLENGE_RE.test(s)) { cleaned.push(''); continue; }
    cleaned.push(s);
  }
  // A thin description teaser (<80) loses to a substantially richer
  // contentEncoded — unless the encoded text is just more of the same teaser.
  if (cleaned[0] && cleaned[1]
      && Array.from(cleaned[0]).length < 80
      && Array.from(cleaned[1]).length > Array.from(cleaned[0]).length + 60) {
    return cleaned[1];
  }
  for (const s of cleaned) if (s) return s;
  return '';
}

// ---- English-news detector -------------------------------------------------
// Wire SITREP hanya memuat bahasa Indonesia. Item Inggris murni (feed salah
// edisi, GN yang menyeret halaman EN) dibuang dari payload — beda dengan flag
// `foreign` (berita Indonesia tentang luar negeri, tetap tampil bertanda
// Global). Stopword dua arah, skor harus menang telak supaya judul Indonesia
// berembedding istilah Inggris (loanword) tidak ikut terbuang.
const EN_NEWS_STOP = new Set(('the and for are was were will would can could has have had not but they them their this that with from about after before between during into over under again then once here there when where why how all any both each more most other some such only own same than too very just also now says said new its our your his her we you he she it is in on at by or an be as to of').split(' '));
const ID_NEWS_STOP = new Set(('yang dan di ke dari untuk dengan tidak ini itu pada akan sudah juga atau dalam adalah telah bisa ada seperti bagi kepada oleh mereka kami kita hingga serta tapi namun jadi hanya masih bahkan yaitu yakni saat setelah sebelum ketika antara atas bawah luar').split(' '));
function newsEnglish(title, desc) {
  const txt = String(title || '') + ' ' + String(desc || '').slice(0, 240);
  const toks = txt.toLowerCase().match(/[a-z]{2,}/g) || [];
  let en = 0, id = 0;
  for (const w of toks) { if (EN_NEWS_STOP.has(w)) en++; else if (ID_NEWS_STOP.has(w)) id++; }
  return en >= 3 && en >= id + 3;
}

// ---- Clean Title -----------------------------------------------------------
const TITLE_SRC_TAIL = /(kompas|antara|detik|cnn|tempo|liputan6|republika|tribun|cnbc|jpnn|okezone|jawapos|viva|kumparan|suara|radar|inilah|merdeka|indosport|youtube|news|kabar|berita|radio|bmkg|bnpb|bpbd|kemendagri|kapolri|tni|voice|akurat|acehinfo|polda|polres|polsek|polresta|tribrata|tribatanews|tribratanews|times|update|harian|pos|post|media|koran|portal|suarakalbar|suarasurabaya|conversation|\btv\b)/i;
const TITLE_DOMAIN_TAIL = /\.(?:com|id|net|org|co|asia|info|tv|xyz|online|site|biz|tech|me|app|pro|co\.[a-z]{2}|go\.[a-z]{2}|or\.[a-z]{2}|ac\.[a-z]{2}|sch\.[a-z]{2}|my\.id|web\.id|biz\.id)(?:\:[0-9]+)?$/i;

function cleanTitle(t, pub) {
  let s0 = String(t || '').trim();
  const pp = s0.indexOf(' | ');
  if (pp > 15) s0 = s0.slice(0, pp).trim();   // "Judul | NamaSitus" — pipe selalu suffix publisher
  const pcm = s0.match(/\s*::\s*\S/);
  if (pcm && pcm.index > 15) s0 = s0.slice(0, pcm.index).trim();   // "Judul :: NamaSitus" — pola feed lokal

  // Strip prefix redaksional: "Berita Video - ", "Breaking News - ", "Video - "
  s0 = s0.replace(/^(?:(?:breaking\s+news|berita\s+video|video|foto|live|eksklusif|update|terkini)\s*[-–—:]\s*)+/i, '').trim();

  // Strip explicit publisher dari Google News <source> kalau cocok persis di ekor
  if (pub) {
    const pk = String(pub).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (pk.length >= 3) {
      s0 = s0.replace(new RegExp('(?:\\s+[-–—]\\s*|\\s*[-–—|•·]\\s*)' + pk + '\\s*$', 'i'), '').trim();
    }
  }

  let s = s0.replace(/\s+[-–—]\s*(?:https?:\/\/|www\.)\S+$/i, '').trim();
  for (let i = 0; i < 4; i++) {
    // Delimiter wajib ada spasi sebelumnya untuk tanda hubung/strip agar tidak memotong kata ulang (luka-luka, dll.)
    const m = s.match(/^(.{8,}?)(?:\s+[-–—]\s*|\s*[|•·]\s*)([A-Za-z0-9][A-Za-z0-9.&'®™()_\-\s]{1,70})$/);
    if (!m) break;
    const tail = m[2].trim();
    const words = tail.split(/\s+/).map(w => w.replace(/[®™]/g, '')).filter(Boolean);
    if (words.length > 6) break;                    // kelanjutan kalimat panjang, bukan label sumber

    const isDomain = TITLE_DOMAIN_TAIL.test(tail) || /\.[a-z]{2,8}$/i.test(tail);
    const isKnown = TITLE_SRC_TAIL.test(tail);
    const isTitleCase = words.length <= 5 && words.every(w => /^[A-Z0-9]/.test(w));
    const isGovPub = /^(?:pemerintah|pemkab|pemkot|polresta|polres|polsek|polda|diskominfo|humas)\b/i.test(tail);
    const isShortSlug = words.length <= 3 && tail.length <= 30 && !/[,;?!]/.test(tail);

    const isPub = isDomain || isKnown || isTitleCase || isGovPub || (isShortSlug && words.every(w => /^[a-z0-9]/.test(w)));
    if (!isPub) break;
    s = m[1].trim();
  }
  return s;
}

module.exports = { decodeEntities, htmlToText, descFrom, newsEnglish, cleanTitle };
