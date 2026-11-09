'use strict';
// Conservative, auditable rules. Topic relevance is not incident confirmation.
const GEO = require('./geocode');
const VERSION = '2026-11-08.2';
const CATEGORY = { demo:'demo', kebakaran:'fire', karhutla:'fire', banjir:'flood', gempa:'disaster', kecelakaan:'insiden', penembakan:'kriminal', pencurian:'kriminal', penangkapan:'kriminal', phk:'ekonomi', rupiah:'ekonomi', ihsg:'ekonomi', 'listrik padam':'ekonomi', wabah:'kesehatan', pemilu:'politik', politik:'politik', konflik:'politik', ransomware:'siber', 'serangan siber':'siber', 'akun dibajak':'siber', insiden:'insiden', kriminal:'kriminal', kesehatan:'kesehatan',
  // topik feed-only: punya kategori supaya finding tidak null, tapi TIDAK PERNAH
  // signalEligible — lihat FEED_ONLY di bawah.
  mbg:'kesehatan', bbm:'ekonomi', pangan:'ekonomi', bansos:'ekonomi', hukum:'kriminal', olahraga:'insiden', transport:'insiden', pendidikan:'insiden' };
// Feed-only: cukup untuk kurasi feed sosial, bukan bukti insiden. isReport default
// sudah false untuk topik ini; flag ini pertahanan eksplisit supaya tak ada yang
// "tidak sengaja" membuatnya signal-eligible di masa depan.
// FEED_ONLY = topik untuk kurasi feed sosial, bukan bukti insiden → tak boleh jadi sinyal.
const FEED_ONLY = new Set(['mbg','bbm','pangan','bansos','hukum','olahraga','transport','pendidikan']);
const FOREIGN = /\b(jepang|japan|nepal|london|oyo|osun|nigeria|amerika|united states|texas|california|new york|brasil|brazil|filipina|philippines|thailand|malaysia|kelantan|pulau pinang|sabah|sarawak|terengganu|pahang|kedah|perak|selangor|putrajaya|negeri sembilan|melaka|astro awani|awani|jbpm|pdrm|korea|china|tiongkok|inggris|britain|prancis|perancis|paris|france|eiffel|jerman|germany|australia|india|pakistan|iran|israel|palestina|palestine|ukraina|ukraine|rusia|russia|gaza|turki|turkey|meksiko|mexico|kanada|canada|vietnam|chile|argentina|spanyol|spain|portugal|italia|italy|belanda|netherlands|swiss|swedia|sweden|norwegia|norway|denmark|yunani|greece|eropa|europe|finCEN|poland|polandia|polonia|krakow|warsaw|warszawa|warschau|lublin|gdansk|wroclaw|poznan|szczecin|czechia|czech|ceko|prague|praha|brno|ostrava|austria|vienna|wina|salzburg|innsbruck|finland|finlandia|helsinki|singapura|singapore|hong kong|taipei|tokyo|kyoto|osaka|seoul|pyongyang|beijing|shanghai|guangzhou|shenzhen|manila|bangkok|chiang mai|hanoi|haiphong|vientiane|phnom penh|kualalumpur|kuala lumpur|penang|johor|kathmandu|colombo|islamabad|karachi|lahore|mumbai|delhi|new delhi|chennai|kolkata|dhaka|chittagong|yangon|mandalay|ulaanbaatar|timor leste|papua new guinea|port moresby|brunei|darussalam|afghanistan|kabul|herat|kazakhstan|almaty|astana|uzbekistan|tashkent|kyrgyzstan|bishkek|tajikistan|dushanbe|turkmenistan|ashgabat|mongolia|bhutan|thimphu|maladewa|maldives|srilanka|sri lanka|bangladesh|myanmar|kamboja|cambodia|laos|suriah|syria|damascus|aleppo|irak|iraq|basra|lebanon|beirut|yordania|jordan|amman|yaman|yemen|sanaa|oman|muscat|qatar|doha|uea|uni emirat arab|arab saudi|saudi arabia|riyadh|jeddah|libya|libia|tripoli|benghazi|tunisia|tunis|sousse|aljazair|algeria|algiers|oranais|maroko|morocco|rabat|casablanca|marrakech|sudan|khartoum|ethiopia|addis ababa|eritrea|asmara|djibouti|somalia|mogadishu|kenya|nairobi|mombasa|uganda|kampala|rwanda|kigali|burundi|bujumbura|tanzania|dar es salaam|dodoma|zanzibar|zambia|lusaka|zimbabwe|harare|mozambique|maputo|angola|luanda|namibia|windhoek|botswana|gaborone|lesotho|maseru|eswatini|swaziland|madagascar|antananarivo|mauritius|port louis|seychelles|comoros|moroni|cameroon|yaounde|chad|ndjamena|niger|niamey|mali|bamako|senegal|dakar|gambia|banjul|guinea|conakry|sierra leone|freetown|liberia|monrovia|ivory coast|cote d'ivoire|abidjan|ghana|accra|togo|lome|benin|porto-novo|congo|kinshasa|brazzaville|gabon|libreville|equatorial guinea|malabo|sao tome|mauritania|nouakchott|western sahara|burkina faso|ouagadougou|egypt|mesir|cairo|giza|alexandria|sinai|south africa|afrika selatan|pretoria|cape town|johannesburg|durban|cuba|kuba|havana|jamaica|jamaika|kingston|haiti|port-au-prince|dominican republic|puerto rico|trinidad|tobago|barbados|bahamas|nassau|belize|guatemala|guatemala city|honduras|tegucigalpa|el salvador|san salvador|nicaragua|managua|costa rica|kosta rika|san jose|panama|panama city|ecuador|ekuador|quito|guayaquil|peru|arequipa|cusco|bolivia|la paz|sucre|santa cruz|paraguay|asuncion|uruguay|montevideo|colombia|kolombia|bogota|medellin|cali|venezuela|caracas|maracaibo|suriname|paramaribo|guyana|georgetown|french guiana|aruba|curacao|greenland|iceland|reykjavik|malta|valletta|cyprus|nicosia|monaco|monako|vatican|vatikan|san marino|andorra|liechtenstein|luxembourg|montenegro|podgorica|albania|tirana|north macedonia|skopje|bosnia|sarajevo|herzegovina|kosovo|pristina|moldova|chisinau|belarus|minsk|estonia|tallinn|latvia|riga|lithuania|vilnius|serbia|belgrade|croatia|zagreb|slovenia|ljubljana|slovakia|bratislava|hungary|budapest|romania|bucharest|bulgaria|sofia|athens|athena|rome|roma|madrid|barcelona|lisbon|amsterdam|brussels|zurich|geneva|stockholm|oslo|copenhagen|dublin|moscow|moskwa|kiev|kyiv|minsk|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|addis ababa|nairobi|kampala|kigali|dar es salaam|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|bangui|yaounde|conakry|freedown|bissau|praia|monrovia|freetown|banjul|ouagadougou|niamey|ndjamena|lome|cotonou|porto-novo|yamoussoukro|abidjan|nouakchott|sao tome|malabo|libreville|maseru|mbabane|gaborone|windhoek|maputo|antananarivo|moroni|victoria|port louis|asmara|djibouti|johannesburg|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|port-au-prince|nassau|bridgetown|castries|saint john|kingstown|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|tijuana|monterrey|sucre|guayaquil|maracaibo|cusco|arequipa|santa cruz|georgia|panama)\b/i;
const LOCAL_ORG = /\b(bmkg|bnpb|bpbd|bssn|pdn|polri|pln|kpu|bawaslu|komdigi|kominfo|bank indonesia|bursa efek indonesia|ihsg|kemenkes|kemensos|kemdikbud|kemendikdasmen|kemenhub|kejaksaan|kemenkumham|kementerian|pemkot|pemkab|pemprov|dishub|damkar|bpjs|taspen|bri|bni|mandiri|basarnas|knkt|kpk|polres|polda|polsek|kodim)\b/i;
const LOCAL_MACRO = /\b(?:(?:di|in|wilayah|pulau|kawasan)\s+indonesia|jabodetabek|sumatera|sumatra|kalimantan|sulawesi|nusa\s+tenggara|kepulauan\s+riau|bangka\s+belitung|pantura|\bwni\b)\b/i;
const CYBER_TARGET = /\b(server|sistem|jaringan|komputer|perangkat|database|situs|website|layanan|akun|data|berkas|file|rumah sakit|hospital|network|device|files|computers?)\b/i;
const CYBER_ACTION = /\b(diserang|diretas|dibobol|terinfeksi|terenkripsi|dienkripsi|dicuri|bocor|lumpuh|terganggu|dikunci|dijual|menyerang|menginfeksi|serangan|attack(?:ed)?|infect(?:ed)?|encrypt(?:ed)?|breach(?:ed)?|leak(?:ed)?|locked|stolen|hack(?:er|ed|ing|s)?|dihack\w*|dijebol|dieksploitasi|phish\w*|scam\w*|deepfake|spyware|backdoor|defac\w*|cryptojack\w*|skimming|carding|exfiltrat\w*|vishing|smishing|sextortion)\b/i;
const DENIED = /\b(tidak|tak|nggak|gak|ga|bukan|belum|no|not|never)\s+(?:ada\s+|terjadi\s+|mengalami\s+|a\s+|an\s+)?(?:gempa|tsunami|erupsi|kebakaran|banjir|longsor|kecelakaan|penembakan|serangan|kebocoran|peretasan|wabah|keracunan|phk|pemadaman|ransomware|malware|attack|breach)|\b(?:gempa|tsunami|erupsi|kebakaran|banjir|kebocoran data|peretasan|serangan siber)\b[^.!?]{0,30}\b(?:tidak terjadi|tidak benar|hoaks|hoax|palsu|dibantah)|\b(?:hoaks|hoax|video lama|kabar palsu|dibantah|denies|false claim)\b/i;
// Label penyangkalan eksplisit di level seluruh teks — sengaja TIDAK pakai DENIED
// penuh: "bukan video lama" / "gempa terjadi, bukan banjir" bukan berarti hoaks.
const DENIED_ANY = /\b(?:hoaks?|kabar palsu|false claim|misinformation|berita palsu|isu hoax)\b/i;
const EDUCATION = /\b(apa itu|pengertian|tutorial|cara (?:mencegah|mengatasi|menghapus|menghindari)|tips|edukasi|simulasi|latihan|mitigasi|kesiapsiagaan|tas bencana|go[- ]?bag|potensi|risiko|rawan|prediksi|diprediksi|andaikan|seandainya|bagaimana jika|what is|how to|exercise|simulation)\b/i;
const AID = /\b(salurkan|menyalurkan|penyaluran|donasi|rekonstruksi|rehabilitasi|kirim bantuan|pusdalops|rakor|seminar|webinar)\b/i;
const HISTORICAL = /\b(dulu|sejarah|mengenang|kilas balik|tahun lalu|bulan lalu|pekan lalu|kemarin|last (?:year|month|week)|historical|anniversary|orde baru|orba|soeharto|suharto|perang dunia|world war|penjajahan|kolonial)\b/i;
// Referensi tahun eksplisit hanya historis bila tahun SUDAH lewat —
// "APBN tahun 2026" / "pada 2030" bukan peristiwa lama.
const HISTORICAL_YEAR = /\b(?:tahun|pada)\s+((?:19|20)\d{2})\b/i;
// year bisa di-inject supaya klasifier deterministik (tes tak flaky di tahun depan);
// default tetap tahun berjalan, jadi assess() hari ini identik byte-for-byte.
function isHistorical(span, year = new Date().getFullYear()) {
  if (HISTORICAL.test(span)) return true;
  const m = HISTORICAL_YEAR.exec(span);
  return !!m && Number(m[1]) < year;
}
const QUESTION = /\b(apakah|apa benar|benarkah|katanya|rumornya|rumour|rumor|is it true)\b/i;
const WARNING = /\b(peringatan(?: dini)?|warning|status (?:awas|siaga)|waspada tsunami)\b/i;
const CRITICAL_IMPACT = /\b(?:\d+\s+(?:orang\s+|warga\s+|korban\s+|jiwa\s+)?(?:tewas|meninggal|wafat|gugur|hilang)|(?:tewas|meninggal)\s+\d+\s+orang|tanggul\s+jebol|bendungan\s+jebol|status\s+awas|peringatan\s+(?:dini\s+)?tsunami|lumpuh\s+total|trading\s+halt|darurat\s+militer|baku\s+tembak)\b/i;
const EVENT_ACTION = /\b(ambruk|runtuh|roboh|tenggelam|hanyut|pohon tumbang|tergelincir|dikeroyok|dibunuh|dirampok|begal|terjadi|melanda|menerjang|menghantam|merendam|terendam|menggenangi|jebol|meluap|mengguncang|diguncang|guncang|bergetar|terasa|erupsi|meletus|terbakar|dilalap|hangus|karam|terguling|tabrak|tabrakan|bertabrakan|menabrak|ditabrak|anjlok|jatuh|ditembak|tertembak|kemalingan|ditangkap|diamankan|mengalami|terdampak|dilaporkan|laporkan|meninggal|tewas|tewaskan|luka|dievakuasi|terjebak|meledak|ledakan|padam|putus|reported|hits?|struck)\b/i;
const METAPHOR = /(?:blue|blauwe)\s+tsunami|tsunami\s+(?:biru|politik|protes|suara|pemilu|dukungan|saham|cuan)|\b(?:opposition|elections?|political|politik|pemilu)\b[^.!?]{0,200}\btsunami\b|\b(?:humans?|people|manusia|jiwa|otak|hati)\b[^.!?]{0,80}\b(?:malware|virus)\b|\bwabah\s+(?:kebencian|cinta|rindu)|\bblackout\s+(?:party|music|festival|concert)|\bkampung\s+durian\s+runtuh\b|\bteori\s+perang\s+sun\s+tzu\b/i;
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
const ABBR_DOT_RE = /\b(PT|CV|UD|Tb|Tbk|Jl|Jln|Dr|Prof|Ir|H|Hj|Bp|Bpk|Sdr|Ny|Tn|Jend|Letjen|Mayjen|Brigjen|Kol|Letkol|Mayor|Kapt|Lettu|Letda|Kombes|AKBP|Kompol|AKP|Iptu|Ipda|Bripka|Brigadir|Briptu|Bripda|Pol|TNI|Kec|Kab|Prov|Kel|Ds|RT|RW|KM|Km|No|Rp|St|Mt)\.(?=\s+)/gi;
function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&#(x[0-9a-fA-F]+|\d+);?/g, (_, n) => {
      const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF && (cp < 0xD800 || cp > 0xDFFF) ? String.fromCodePoint(cp) : '';
    })
    .replace(/&(lt|gt|quot|apos|nbsp|mdash|ndash|hellip);/gi, (_, k) => ({ lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', mdash:'—', ndash:'–', hellip:'…' }[k.toLowerCase()] || _))
    .replace(/&amp;/gi, '&');
}
function clauses(text) {
  const clean = decodeBasicEntities(text).normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(ABBR_DOT_RE, '$1\u0000');
  return clean.split(/\n+|[!?;]+|\.(?=\s+[A-Za-zÀ-ɏ])/).map(s => s.replace(/\u0000/g, '.').trim()).filter(Boolean);
}
function classifyScope(span, target) {
  const location = GEO.locate(span);
  // buang diakritik dulu: "kraków" — \b setelah 'ó' tak pernah match karena ó non-word.
  const foreign = FOREIGN.test(span.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  // Multiple countries in one clause are ambiguous, not a free local override.
  // Lokasi desa/kelurahan/POI terlalu lemah untuk menetralkan penanda asing:
  // "penembakan di Alun-alun Krakow Polandia" match desa "Alun-Alun" (Jatim)
  // secara kebetulan — itulah cara berita Krakow dulu ter-pin ke Indonesia.
  if (foreign) {
    const weak = location && /^(desa|kelurahan|poi)$/.test(location.prec || '');
    return { scope: (location && !weak) || LOCAL_ORG.test(span) ? 'unknown' : 'foreign', location: null };
  }
  const local = location || LOCAL_ORG.test(span) || LOCAL_MACRO.test(span);
  return { scope: local ? 'Indonesia' : 'unknown', location: location ? { name: location.name, prov: location.prov, prec: location.prec, la: location.la, lo: location.lo, ...(location.provCode ? { provCode: location.provCode } : {}), ...(location.kabCode ? { kabCode: location.kabCode } : {}), ...(location.kecCode ? { kecCode: location.kecCode } : {}), ...(location.code ? { code: location.code } : {}) } : null };
}
function concreteTarget(span, category) {
  if (category !== 'siber' && category !== 'ekonomi' && category !== 'politik') return null;
  const known = span.match(LOCAL_ORG);
  if (known) return known[0].toUpperCase();
  // Named target after an asset noun. Generic asset words alone aren't identity.
  const m = span.match(/\b(?:[Ss]erver|[Jj]aringan|[Ss]istem|[Ss]itus|[Ww]ebsite|[Ll]ayanan|[Aa]kun|[Pp]abrik|[Pp]erusahaan|[Rr]umah\s+[Ss]akit)\s+((?:[A-Z][\w.-]*)(?:\s+[A-Z][\w.-]*){0,3})\b/);
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
    case 'demo': return identity && /unjuk rasa|aksi massa|demonstran|\bdemo\b|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia/i.test(span) && /berlangsung|turun ke jalan|berkumpul|menggelar|ricuh|bentrok|tuntut|menuntut|menolak|tolak|\borasi\b|\bmarch\b|\baksi\b/i.test(span);
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
const READER_LOC_RE = /\b(?:saya|aku|gue|gw|kami|kita)\s+(?:baca|membaca|membacanya|lihat|melihat|nonton|dengar|mendengar|pantau)\b/i;
function assess(text, registry, options = {}) {
  const raw = decodeBasicEntities(String(text || ''));
  const spans = clauses(raw), findings = [], topics = new Set(), reasons = new Set();
  const spam = options.spam && options.spam.test(raw);
  // Listing properti/jual-beli: topik feed-only (transport, hukum, dst) adalah
  // kurasi topik, bukan insiden — iklan rumah yang menyebut "akses KRL/TransJakarta"
  // bukan konten transport. Topik non-feed-only tetap dinilai normal.
  const listing = !!options.listing;
  // Pre-compute per-clause scope so multi-line social posts ("Meninggal kecelakaan\nDi Semarang")
  // can inherit location from an immediately adjacent non-foreign clause when safe.
  const spanScopes = spans.map(s => classifyScope(s, null));
  const anyForeignClause = spanScopes.some(sc => sc.scope === 'foreign');
  const docHist = /\b(?:baca(?:in)?|belajar|buku|artikel|kisah|cerita)\s+sejarah\b/i.test(raw);
  for (const tp of registry) {
    if (listing && FEED_ONLY.has(tp.id)) continue;
    for (let idx = 0; idx < spans.length; idx++) {
      const span = spans[idx];
      if (!tp.pos.test(span)) continue;
      const metaphor = METAPHOR.test(span) || (options.noise && options.noise.test(span)) || (tp.neg && tp.neg.test(span));
      if (metaphor) { reasons.add('metaphor_or_nonincident_usage'); continue; }
      // Ambiguous words need context even for topic membership, not the same keyword repeated.
      if (tp.ctx && !(tp.strong && tp.strong.test(span)) && !tp.ctx.test(span)) { reasons.add('insufficient_topic_context'); continue; }
      topics.add(tp.id);
      const category = CATEGORY[tp.id];
      const feedOnly = FEED_ONLY.has(tp.id);
      const target = concreteTarget(span, category);
      let { scope, location } = spanScopes[idx];
      // Adjacent-clause location inheritance: if this clause has no location and scope is 'unknown'
      // (never 'foreign'), and no clause in the post is 'foreign', inherit location from idx-1 or idx+1
      // unless that neighbor is a reader-location statement ("Saya membacanya dari Jakarta") or denied/historical.
      if (!location && scope === 'unknown' && !anyForeignClause) {
        for (const adj of [idx - 1, idx + 1]) {
          if (adj < 0 || adj >= spans.length) continue;
          const adjSpan = spans[adj], adjSc = spanScopes[adj];
          if (adjSc.scope === 'Indonesia' && adjSc.location && !READER_LOC_RE.test(adjSpan) &&
              !DENIED_ANY.test(adjSpan) && !DENIED.test(adjSpan) && !isHistorical(adjSpan)) {
            scope = 'Indonesia';
            location = adjSc.location;
            break;
          }
        }
      }
      // Penanda bantahan ("hoaks", "kabar palsu") hanya sah bila ada di KLAUSA yang
      // sama dengan topiknya — span sudah klausa dari clauses(); tanpa scoping ini
      // satu kata "hoaks" di kalimat lain menandai SEMUA finding 'denied'.
      let reportType = (DENIED_ANY.test(span) || DENIED.test(span)) ? 'denied' : (docHist || isHistorical(span)) ? 'historical' : WARNING.test(span) ? 'warning' : EDUCATION.test(span) ? 'educational' : AID.test(span) ? 'response' : QUESTION.test(span) ? 'unverified_question' : 'commentary';
      const report = isReport(tp.id, span, location, target);
      if (reportType === 'commentary' && report) reportType = 'reported';
      const eligible = !spam && !feedOnly && scope === 'Indonesia' && !!(location || target) && report && (reportType === 'reported' || reportType === 'warning');
      if (scope !== 'Indonesia') reasons.add(scope === 'foreign' ? 'foreign_scope' : 'scope_not_established');
      if (!report) reasons.add('no_concrete_event');
      if (!eligible) reasons.add(reportType);
      findings.push({ topic: tp.id, category: category || null, type: eventType(tp.id, span), location, target, scope, reportType, signalEligible: eligible, ...(feedOnly ? { feedOnly: true } : {}), evidence: span, severity: reportType === 'warning' ? 'warning' : 'unknown' });
    }
  }
  if (spam) reasons.add('spam');
  const events = findings.filter(f => f.signalEligible);
  const eligible = events.length > 0;
  const scope = eligible ? 'Indonesia' : findings.some(f => f.scope === 'Indonesia') ? 'Indonesia' : findings.length && findings.every(f => f.scope === 'foreign') ? 'foreign' : 'unknown';
  const reportType = eligible ? (events.every(f => f.reportType === 'warning') ? 'warning' : 'reported') : findings[0]?.reportType || 'irrelevant';
  const feedEligible = !spam && topics.size > 0 && findings.some(f => f.scope === 'Indonesia' || (!anyForeignClause && f.scope === 'unknown' && ['reported', 'warning'].includes(f.reportType)));
  return { version: VERSION, topics: spam ? [] : [...topics], scope, reportType, feedEligible, signalEligible: eligible, events, findings, reasons: [...reasons], severity: eligible && events.some(f => f.severity === 'warning') ? 'warning' : 'unknown' };
}
module.exports = { VERSION, CATEGORY, FEED_ONLY, assess, isHistorical, norm, clauses, classifyScope };
