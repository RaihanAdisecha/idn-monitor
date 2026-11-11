'use strict';

const GEO = require('./geocode');
const NLP = require('./indonesian-nlp');

const VERSION = '2026-11-12.1';

const CATEGORY = {
  demo: 'demo',
  kebakaran: 'fire',
  karhutla: 'fire',
  banjir: 'flood',
  gempa: 'disaster',
  badai: 'disaster',
  kecelakaan: 'insiden',
  penembakan: 'kriminal',
  pencurian: 'kriminal',
  penangkapan: 'kriminal',
  phk: 'ekonomi',
  rupiah: 'ekonomi',
  ihsg: 'ekonomi',
  'listrik padam': 'ekonomi',
  wabah: 'kesehatan',
  pemilu: 'politik',
  politik: 'politik',
  konflik: 'politik',
  ransomware: 'siber',
  'serangan siber': 'siber',
  'akun dibajak': 'siber',
  insiden: 'insiden',
  kriminal: 'kriminal',
  kesehatan: 'kesehatan',

  mbg: 'kesehatan',
  bbm: 'ekonomi',
  pangan: 'ekonomi',
  bansos: 'ekonomi',
  hukum: 'kriminal',
  transport: 'insiden',
  pendidikan: 'insiden',
};

const FEED_ONLY = new Set(['mbg', 'bbm', 'pangan', 'bansos', 'hukum', 'transport', 'pendidikan']);

const FOREIGN = NLP.FOREIGN_MARKER_RE;
const LOCAL_ORG = NLP.LOCAL_ORG_RE;
const LOCAL_MACRO = NLP.LOCAL_MACRO_RE;
const CYBER_TARGET = /\b(server|sistem|jaringan|komputer|perangkat|database|situs|website|layanan|akun|data|berkas|file|rumah sakit|hospital|network|device|files|computers?)\b/i;
const CYBER_ACTION = /\b(diserang|diretas|dibobol|terinfeksi|terenkripsi|dienkripsi|dicuri|bocor|lumpuh|terganggu|dikunci|dijual|menyerang|menginfeksi|serangan|attack(?:ed)?|infect(?:ed)?|encrypt(?:ed)?|breach(?:ed)?|leak(?:ed)?|locked|stolen|hack(?:er|ed|ing|s)?|dihack\w*|dijebol|dieksploitasi|phish\w*|scam\w*|deepfake|spyware|backdoor|defac\w*|cryptojack\w*|skimming|carding|exfiltrat\w*|vishing|smishing|sextortion)\b/i;
const DENIED = /\b(tidak|tak|nggak|gak|ga|kagak|kaga|bukan|belum|no|not|never)\s+(?:ada\s+|terjadi\s+|mengalami\s+|a\s+|an\s+)?(?:gempa|tsunami|erupsi|kebakaran|banjir|longsor|kecelakaan|penembakan|serangan|kebocoran|peretasan|wabah|keracunan|phk|pemadaman|ransomware|malware|attack|breach)|\b(?:gempa|tsunami|erupsi|kebakaran|banjir|kebocoran data|peretasan|serangan siber)\b[^.!?]{0,30}\b(?:tidak terjadi|tidak benar|hoaks|hoax|palsu|dibantah)|\b(?:hoaks|hoax|video lama|kabar palsu|dibantah|denies|false claim)\b/i;
const DENIED_ANY = /\b(?:hoaks?|kabar palsu|false claim|misinformation|disinformasi|berita palsu|isu hoax)\b/i;
const EDUCATION = /\b(apa itu|pengertian|tutorial|cara (?:mencegah|mengatasi|menghapus|menghindari)|tips|edukasi|simulasi|latihan|mitigasi|kesiapsiagaan|tas bencana|go[- ]?bag|potensi|risiko|rawan|prediksi|diprediksi|andaikan|seandainya|bagaimana jika|what is|how to|exercise|simulation)\b/i;
const AID = /\b(salurkan|menyalurkan|penyaluran|donasi|rekonstruksi|rehabilitasi|kirim bantuan|pusdalops|rakor|seminar|webinar)\b/i;
const HISTORICAL = /\b(dulu|jaman dulu|zaman dulu|tempo dulu|sejarah|mengenang|kilas balik|tahun lalu|bulan lalu|pekan lalu|kemarin|last (?:year|month|week)|historical|anniversary|orde baru|orba|soeharto|suharto|perang dunia|world war|penjajahan|kolonial|(?:jaman|zaman|waktu|pas|saat|era|awal)\s+(?:covid(?:-?19)?|pandemi|lockdown|korona|corona)|(?:2019|2020|2021|2022)\b[^.!?\n]{0,40}\b(?:covid|pandemi|lockdown))\b/i;
const HISTORICAL_YEAR = /\b(?:tahun|pada|sejak|era)\s+((?:19|20)\d{2})\b/i;

function isHistorical(span, year = new Date().getFullYear()) {
  if (HISTORICAL.test(span)) return true;
  const m = HISTORICAL_YEAR.exec(span);
  return !!m && Number(m[1]) < year;
}

const QUESTION = /\?|\b(apakah|apa benar|benarkah|beneran|katanya|rumornya|rumour|rumor|is it true|ada yang dengar|ada yang tahu|nggak sih|tidak sih)\b/i;
const WARNING = /\b(peringatan\s+(?:dini|cuaca|tsunami|banjir|longsor|erupsi|gelombang|angin|bmkg)|(?:keluarkan|mengeluarkan|rilis|merilis)\s+peringatan|warning|early warning|status (?:awas|siaga)|waspada tsunami|hujan ekstrem)\b/i;
const EVENT_ACTION = /\b(ambruk|runtuh|roboh|tenggelam|hanyut|pohon tumbang|tergelincir|dikeroyok|dibunuh|dirampok|begal|terjadi|melanda|menerjang|menghantam|merendam|terendam|menggenangi|jebol|meluap|mengguncang|diguncang|guncang|bergetar|terasa|dirasakan|erupsi|meletus|terbakar|dilalap|hangus|karam|terguling|tabrak|tabrakan|bertabrakan|menabrak|ditabrak|anjlok|jatuh|ditembak|tertembak|kemalingan|ditangkap|diamankan|mengalami|terdampak|dilaporkan|laporkan|meninggal|tewas|tewaskan|luka|dievakuasi|terjebak|meledak|ledakan|padam|putus|reported|hits?|struck|porak[- ]poranda|berhamburan|beterbangan|sapu|menyapu|porakporandakan|memporakporandakan|hempas|menghempas|rusak|merusak|masuk rumah|menggenang)\b/i;
const METAPHOR = /(?:post[- ]?)?(?:blue|blauwe)[- ]?tsunami|ocean\s+tsunami|surfing\s+(?:a\s+)?tsunami|crowcaster\.com|\bR[1-9]\s+#\d+\b[^.!?\n]{0,60}\$\d+\.\d+|tsunami\s+(?:biru|politik|protes|suara|pemilu|dukungan|saham|cuan|vonis)|\b(?:opposition|elections?|political|politik|pemilu)\b[^.!?]{0,200}\btsunami\b|\b(?:humans?|people|manusia|jiwa|otak|hati)\b[^.!?]{0,80}\b(?:malware|virus)\b|\bwabah\s+(?:kebencian|cinta|rindu|judi|judol|korupsi|kemiskinan|hoaks|kebohongan|intoleransi|k-?pop|drakor|tiktok)|\bblackout\s+(?:party|music|festival|concert)|\bdpr\s+(?:ian|live|cream|artic|rem|regime)\b|\bdream\s+perfect\s+regime\b|\b(?:banjir|kebanjiran)\s+(?:pc|photocards?|merch|lightstick)\b|satu\s+album\s+banjir|\bbem\b[^.!?\n]{0,80}\b(?:kode|css|html|modifier|element|frontend|styling|component)\b|\bbebas\s+(?:laka\s+(?:ataupun|atau|dan)\s+)?banjir|(?:kyk|kaya|kayak|seperti|ibarat)\s+(?:nunggu|menunggu\s+)?(?:orang\s+hamil|pengumuman\s+snbt|snbt|sbmptn)|pembangkit\s+listrik\s+tenaga\s+kangen|\b(?:nadia\s+omara|ku\s+racuni|bujuran\s+keracunan)\b|(?:suruh|disuruh)\s+jadi\s+anjing\s+rabies|\bjam\s+aja\s+di\s*korupsi\b|\bkampung\s+durian\s+runtuh\b|\bteori\s+perang\s+sun\s+tzu\b|\b(?:bebas|anti|aman|tanpa)\s+(?:banjir|macet|kebakaran|gempa|longsor|badai)\b|\bbadai\s+(?:pasti\s+berlalu|asmara|cinta|kehidupan|hidup|rumah\s+tangga|ekonomi|cuan|rezeki|politik|pemilu|ujian|cobaan|cedera|kritik|protes|kecaman|hujatan|penolakan|isu|gosip|kontroversi|salju)\b|\b(?:cantik|rambut|kece|gaya|tampilan)\s+badai\b|\b(?:melewati|hadapi|menghadapi)\s+badai\s+(?:hidup|kehidupan)\b|\b(?:kebakaran\s+jenggot|kebakaran\s+(?:harga|promo|diskon)|terbakar\s+(?:api\s+)?(?:amarah|emosi|cemburu|asmara|rindu)|tersulut\s+api\s+(?:amarah|emosi)|membakar\s+semangat|panggung\s+terbakar|membakar\s+panggung|sayap(?:-sayap)?\s+(?:pupus\s+)?terbakar)\b|\b(?:gempa\s+(?:politik|lokal)|baby\s+gempa|boboiboy(?:\s+gempa)?|baju\s+gempa|kaos\s+gempa|goyang\s+gempa|joget\s+gempa|senam\s+gempa|guncangan\s+(?:politik|kabinet|ekonomi|jiwa|batin)|mengguncang\s+(?:jagat(?:\s+maya)?|dunia(?:\s+maya)?|publik|parlemen))\b|\b(?:banjir\s+(?:order|orderan|cuan|promo|diskon|hadiah|bonus|ucapan|pujian|penghargaan|bintang|rating|air\s*mata|gol\b))\b|\b(?:longsor\s+(?:suara|kurs|saham|suara\s+partai))\b|\b(?:ihsg|rupiah|saham|kurs)\s+(?:ambruk|anjlok)\b|\b(?:ditembak\s+duluan|ditembak\s+(?:sama\s+)?(?:gebetan|doi|crush|cewek|cowok|temen|teman|orang)|nembak\s+(?:gebetan|doi|crush|cewek|cowok)|ditembak\s+(?:hati|cinta|asmara|batin|panah|tatapan|mati\s+rasa)|mati\s+rasa\s+hatiku|(?:bikin\s+)?sim\s+nembak|nembak\s+(?:sim|nilai|wifi|sinyal|harga|jawaban|soal|gawang)|tembakan\s+ke\s+gawang|(?:ditembak|nembak|tertembak)[^.!?]{0,35}(?:pacaran|pacar|gebetan|doi|jadian|crush|confess|baper|pdkt|kencan|dating|tinder|bumble|dinner|makan malem|makan malam|nyatain|nyatakan)|(?:pacaran|pacar|gebetan|doi|jadian|crush|pdkt|kencan|dating)[^.!?]{0,35}(?:ditembak|nembak|tertembak))\b|\b(?:pencuri|maling|rampok|begal)[^.!?]{0,20}(?:hati|cinta|perhatian|senyum)\b|\b(?:curi\s+poin|mencuri\s+poin|mencuri\s+start|curi\s+start|begal\s+(?:rekening|saldo|pulsa|data|politik|partai|konstitusi)|pembegalan\s+(?:partai|konstitusi))\b|\b(?:dibunuh|membunuh)[^.!?]{0,20}(?:rasa|rindu|sepi|waktu|kebosanan|karakter|mimpi|harapan|cinta)\b|\bpembunuhan\s+karakter|membunuh\s+karakter\b|\b(?:ngedrama|drama|pura[- ]?pura|alasan|bohong|settingan)\s+(?:kecelakaan|tabrakan)\b|\b(?:kecelakaan|tabrakan)\s+(?:boongan|bohong[- ]bohongan|palsu|drama|settingan)\b|\b(?:tabrakan\s+(?:logika|ideologi|pendapat|argumen|prinsip|pemikiran|jadwal|acara|event|konser|libur|ujian|meeting|praktik|kepentingan)|(?:menabrak|tabrak)\s+(?:aturan|konstitusi|hukum|uu|norma|etika|logika))\b|\b(?:tergelincir\s+(?:lidah|dari\s+puncak|klasemen|ke\s+(?:lembah|jurang)\s+(?:dosa|maksiat)))\b|\b(?:durian\s+runtuh|jembatan\s+cinta)\b|\b(?:hanyut\s+dalam\s+(?:alunan|suasana|musik|emosi|perasaan|khayalan|lagu)|tenggelam\s+(?:dalam\s+(?:lamunan|duka|kesedihan|kenangan|nostalgia|dosa)|di\s+dasar\s+klasemen))\b|\b(?:racun\s+(?:tiktok|shopee|ig|belanja|skincare|ootd|cinta|asmara|dunia)|teracuni|keracunan\s+(?:cinta|asmara)|meracuni\s+(?:pikiran|otak|jiwa)|gila\s+anjing\s+(?:lu|lo|banget|deh))\b|\b(?:sid\s+bukan\s+pahlawan|pelacur\s+jalanan\s+bermahkotakan|bermahkotakan\s+duri|tutup\s+matamu\s+kawan\s+besarkan\s+hati|emyu(?:\s+baby)?|munyuk|bobotoh\s+persib)\b|\b[A-Za-z]+(?:\s+[A-Za-z]+){1,2}\s+of\s+(?:Doctor\s+X|Tigers\s+sniff)\b|\b(?:mantan\s+rp|anak\s+rp|pacar\s+rl|main\s+rp)\b/i;

const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
const ABBR_DOT_RE = /\b(PT|CV|UD|Tb|Tbk|Jl|Jln|Dr|Prof|Ir|H|Hj|Bp|Bpk|Sdr|Ny|Tn|Jend|Letjen|Mayjen|Brigjen|Kol|Letkol|Mayor|Kapt|Lettu|Letda|Kombes|AKBP|Kompol|AKP|Iptu|Ipda|Bripka|Brigadir|Briptu|Bripda|Pol|TNI|Kec|Kab|Prov|Kel|Ds|RT|RW|KM|Km|No|Rp|St|Mt)\.(?=\s+)/gi;

function decodeBasicEntities(s) {
  return NLP.decodeBasicEntities(s);
}

function clauses(text) {
  const clean = decodeBasicEntities(text).normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(ABBR_DOT_RE, '$1\u0000');
  return clean.split(/\n+|[!?;]+|\.(?=\s+[A-Za-zÀ-ɏ])/).map(s => s.replace(/\u0000/g, '.').trim()).filter(Boolean);
}

function classifyScope(span, target) {
  const location = GEO.locate(span);
  const foreign = FOREIGN.test(span.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  if (foreign) {
    const weak = location && /^(desa|kelurahan|poi)$/.test(location.prec || '');
    return { scope: (location && !weak) || LOCAL_ORG.test(span) ? 'unknown' : 'foreign', location: null };
  }
  const local = location || LOCAL_ORG.test(span) || LOCAL_MACRO.test(span);
  return {
    scope: local ? 'Indonesia' : 'unknown',
    location: location ? {
      name: location.name,
      prov: location.prov,
      prec: location.prec,
      la: location.la,
      lo: location.lo,
      ...(location.provCode ? { provCode: location.provCode } : {}),
      ...(location.kabCode ? { kabCode: location.kabCode } : {}),
      ...(location.kecCode ? { kecCode: location.kecCode } : {}),
      ...(location.code ? { code: location.code } : {}),
    } : null,
  };
}

function concreteTarget(span, category) {
  if (category !== 'siber' && category !== 'ekonomi' && category !== 'politik' && category !== 'kesehatan') return null;
  const known = span.match(LOCAL_ORG);
  if (known) return known[0].toUpperCase();
  const m = span.match(/\b(?:[Ss]erver|[Jj]aringan|[Ss]istem|[Ss]itus|[Ww]ebsite|[Ll]ayanan|[Aa]kun|[Pp]abrik|[Pp]erusahaan|[Rr]umah\s+[Ss]akit|[Rr][Ss][Uu]?[Dd]?|[Pp]uskesmas|[Kk]linik|[Ss][Pp][Pp][Gg]|[Bb]adan\s+[Gg]izi\s+[Nn]asional)\s+((?:[A-Z][\w.-]*)(?:\s+[A-Z][\w.-]*){0,3})\b/);
  return m ? m[1] : null;
}

function eventType(topic, span) {
  if (topic === 'insiden') return /tenggelam|karam/i.test(span) ? 'maritime_accident' : /ambruk|runtuh/i.test(span) ? 'collapse' : /pohon tumbang/i.test(span) ? 'tree_fall' : 'accident';
  if (topic === 'kriminal') return /narkoba/i.test(span) ? 'narcotics' : /pembunuhan|dibunuh/i.test(span) ? 'homicide' : 'violent_crime';
  if (topic === 'kesehatan' || topic === 'wabah') return 'health_incident';
  if (topic === 'gempa') return /tsunami/i.test(span) ? 'tsunami' : /erupsi|letusan|meletus|awan panas|lahar/i.test(span) ? 'eruption' : 'earthquake';
  if (topic === 'badai') return /puting beliung|tornado/i.test(span) ? 'tornado' : /siklon/i.test(span) ? 'cyclone' : 'storm';
  if (topic === 'banjir') return /longsor/i.test(span) ? 'landslide' : 'flood';
  if (topic === 'ransomware') return /ransomware/i.test(span) ? 'ransomware' : 'malware';
  if (topic === 'serangan siber') return /ransomware/i.test(span) ? 'ransomware' : /ddos/i.test(span) ? 'ddos' : /bocor|kebocoran|breach/i.test(span) ? 'data_breach' : 'intrusion';
  return topic;
}

function isReport(topic, span, location, target, nlpClause) {
  const identity = !!(location || target);
  if (nlpClause && (nlpClause.flags.isDenial || nlpClause.flags.isHist || nlpClause.flags.isEdu ||
    nlpClause.flags.isQuest || nlpClause.flags.isHearsay || nlpClause.flags.isCond ||
    nlpClause.flags.isReader || nlpClause.flags.isSatire || nlpClause.flags.isCommentaryMeta ||
    nlpClause.flags.isCommercial || nlpClause.flags.isAd || nlpClause.flags.isVent || nlpClause.flags.isSpam)) {
    return false;
  }
  const hasNlpStrong = nlpClause && nlpClause.events.some(e => e.topic === topic && e.strong && !e.minorWaterlogging);
  if (hasNlpStrong && identity) return true;

  switch (topic) {
    case 'kriminal': return identity && EVENT_ACTION.test(span);
    case 'kesehatan': return identity && (/kasus|pasien|terjangkit|keracunan|wabah|\bklb\b|kejadian luar biasa|meninggal|tewas|korban|dirawat|terinfeksi|dilarikan|intoksikasi/i.test(span) || (/(?:mual|muntah)/i.test(span) && /(?:massal|keracunan|makanan|mbg|dilarikan|rumah\s+sakit|\brs\b|puskesmas|korban|banyak\s+orang|warga)/i.test(span)));
    case 'insiden': return identity && EVENT_ACTION.test(span) && /(?:jembatan|gedung|bangunan|atap|plafon|rumah|dinding|konstruksi|tembok|jalan|tebing|tower|tiang|kapal|perahu|sampan|tongkang|speedboat|dermaga|pohon|orang|bocah|anak|korban|warga|penumpang)\b/i.test(span) && !/(?:hati|jiwa|perasaan|senyuman|cinta|asmara)\b/i.test(span);
    case 'ransomware': return CYBER_TARGET.test(span) && CYBER_ACTION.test(span) && identity;
    case 'serangan siber': case 'akun dibajak': return CYBER_ACTION.test(span) && identity;
    case 'gempa': {
      if (!identity) return false;
      const isTsunami = /tsunami/i.test(span);
      if (isTsunami) return EVENT_ACTION.test(span) || WARNING.test(span);
      const hasSeismicAction = EVENT_ACTION.test(span) ||
        /(?:guncangan|getaran|terasa|dirasakan|kerasa|bergoyang|bergetar|panik|berhamburan|retak|roboh|rusak|kedalaman|kedlmn|\bm\s*\d+(?:[.,]\d+)?\b|\bmag(?:nitudo)?\s*[:=]?\s*\d+(?:[.,]\d+)?\b|\d+(?:\.\d+)?\s*(?:sr|skala\s+richter|\bm\b)|episentrum|pusat\s+gempa|bmkg|pvmbg|vona)/i.test(span);
      const hasSeismicCue = /\b(?:gempa|guncangan)(?:\s+bumi)?\s+(?:terasa|dirasakan|berpusat)?\s*di\s+[A-Za-z]/i.test(span);
      const isQuakeOrVolcano = /(?:gempa|magnitudo|\bmag\s*[:=]?\s*\d|erupsi|letusan|meletus|awan\s+panas|hujan\s+abu|lahar)/i.test(span);
      return (hasSeismicAction || hasSeismicCue) && isQuakeOrVolcano;
    }
    case 'badai': return identity && (EVENT_ACTION.test(span) || WARNING.test(span) || /\b(?:kecepatan|knot|\bkm\/h\b|bmkg|bnpb|bpbd|waspada|siaga)\b/i.test(span)) && /badai|siklon|puting beliung|angin kencang|angin ribut|badai petir|gelombang pasang|bibit siklon|hujan ekstrem|cuaca ekstrem/i.test(span);
    case 'kebakaran': return identity && !/\b(?:film|bioskop|cfd|car\s+free\s+day|kolaborasi|strategi\s+film)\b/i.test(span) && /\b(?:kebakaran|terbakar|kobaran\s+api|si\s+jago\s+merah|dilalap|ludes|hangus|asap\s+tebal|padamkan)\b/i.test(span) && (EVENT_ACTION.test(span) || /\b(?:kebakaran|terbakar)(?:\s+(?:rumah|ruko|gedung|pabrik|pasar|hutan|lahan|gudang|kios))?\s+(?:di|melanda|hanguskan)/i.test(span));
    case 'kecelakaan': case 'penembakan': case 'pencurian': return identity && (EVENT_ACTION.test(span) || /\b(?:longsor|kecelakaan|penembakan|pencurian)(?:\s+(?:rumah|gedung|pabrik|pasar|hutan|lahan))?\s+(?:di|melanda|merendam)/i.test(span));
    case 'banjir': {
      if (!identity) return false;
      if (/\bgenangan\b/i.test(span) && !/\b(?:banjir\s+bandang|banjir\s+rob|tanggul\s+jebol|air\s+meluap|merendam|terendam|evakuasi|mengungsi)\b/i.test(span)) return false;
      return EVENT_ACTION.test(span) || /\b(?:banjir|longsor)(?:\s+(?:rumah|gedung|pabrik|pasar|warga|pemukiman))?\s+(?:di|melanda|merendam)/i.test(span);
    }
    case 'karhutla': return identity && (/(?:titik\s+panas|hotspot|kebakaran\s+(?:hutan|lahan)|karhutla)\s+(?:meluas|terjadi|membakar|terpantau|hanguskan|di)/i.test(span) && !/tolak|tuntutan|isu|demo|unjuk\s+rasa/i.test(span));
    case 'penangkapan': return identity && /ditangkap|diamankan|penangkapan|\bott\b/i.test(span) && !NLP.CEREMONY_RE?.test(span) && /\b(?:polisi|polres|polda|polsek|kpk|bnn|densus|kejaksaan|aparat|pelaku|tersangka|buron|maling|begal|rampok|koruptor|suap|penipu|narkoba)\b/i.test(span);
    case 'demo': return identity && /unjuk rasa|aksi massa|demonstrasi|demonstran|pengunjuk rasa|\bdemo\b|protes|mogok|kerusuhan|bentrok|pemogokan|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|kawal demo|gelar aksi|rencana aksi/i.test(span) && /berlangsung|turun ke jalan|berkumpul|(?:meng)?gelar|ricuh|bentrok|tuntut|menuntut|menolak|tolak|\borasi\b|\bmarch\b|\baksi\b|siapkan pengamanan|menyiapkan pengamanan|(?:di)?siagakan|rencana (?:aksi|demo|unjuk rasa)|(?:meng)?kawal (?:demo|aksi|massa)|(?:meng)?amankan (?:demo|aksi)|pengamanan (?:demo|aksi)|(?:di)?kerahkan|(?:di)?terjunkan|antisipasi/i.test(span);
    case 'wabah': return identity && /kasus|pasien|terjangkit|keracunan|wabah (?:dbd|campak|kolera|difteri)|kejadian luar biasa|intoksikasi/i.test(span);
    case 'listrik padam': return identity && /listrik padam|mati listrik|pemadaman listrik|padam listrik|mati lampu|pln[^.!?]{0,40}blackout/i.test(span);
    case 'phk': return identity && /melakukan|lakukan|terkena|mengalami|memutus|dirumahkan|pabrik tutup|tutup[^.!?]{0,25}phk|phk[^.!?]{0,30}(?:\d+|ratusan|ribuan)/i.test(span);
    case 'ihsg': return /trading halt|dihentikan|anjlok|merosot|turun\s+\d/i.test(span) && (!!target || LOCAL_ORG.test(span));
    case 'rupiah': return /melemah|menguat|anjlok/i.test(span) && /\d/.test(span) && (!!target || LOCAL_ORG.test(span));
    case 'pemilu': return identity && /ricuh|bentrok|ditunda|dibatalkan|pemungutan suara ulang/i.test(span);
    case 'politik': return identity && /\b(?:resmi\s+dilantik|dilantik|dipecat|mengundurkan\s+diri|divonis|reshuffle|impeachment|dimakzulkan)\b/i.test(span) && !/\b(?:usul|wacana|menurut|angkat\s+bicara|komentar|opini)\b/i.test(span);
    case 'konflik': return identity && !/\b(?:upacara|tabur\s+bunga|hari\s+pahlawan|dirgahayu|ziarah|hut\s+tni|museum\s+militer)\b/i.test(span) && !/perang\s+(?:antar\s+)?(?:fandom|fans?|warganet|netizen|cuitan|bocil)/i.test(span) && !/drone\s+(?:fpv|rakitan|mainan|kamera|balap)/i.test(span) && /\b(?:baku\s+tembak|kontak\s+senjata|serangan\s+udara|serangan\s+rudal|invasi|kudeta|gencatan\s+senjata|darurat\s+militer|pertempuran|penyanderaan|kkb\s+papua|separatis)\b/i.test(span);
    default: return false;
  }
}

const ASSESS_CACHE = new Map();
const ASSESS_CACHE_MAX = 3000;

function registryCacheKey(registry, options) {
  const ids = (registry || []).map(t => (t.adhoc ? '~' : '') + t.id).join(',');
  return ids + '|' + (options.listing ? '1' : '0') + '|' + (options.year || '');
}

function cloneAssessment(a) {
  return {
    ...a,
    topics: a.topics.slice(),
    events: a.events.map(e => ({ ...e, location: e.location ? { ...e.location } : null })),
    findings: a.findings.map(f => ({ ...f, location: f.location ? { ...f.location } : null })),
    reasons: a.reasons.slice(),
    rejectedReasons: a.rejectedReasons.slice(),
    classification: { ...a.classification },
    geographicContext: { ...a.geographicContext, mentions: (a.geographicContext.mentions || []).map(m => ({ ...m })) },
    event: a.event ? {
      ...a.event,
      location: a.event.location ? { ...a.event.location } : null,
      eventTime: a.event.eventTime ? { ...a.event.eventTime } : null,
      impact: a.event.impact ? { ...a.event.impact } : null,
      evidence: (a.event.evidence || []).slice(),
    } : null,
    extractedEvents: (a.extractedEvents || []).map(e => ({ ...e })),
    layerTrace: { ...a.layerTrace },
  };
}

function assess(text, registry, options = {}) {
  const raw = decodeBasicEntities(String(text || ''));
  const nlp = NLP.analyzePost(raw, { year: options.year });

  const reg = registry || [];
  const cacheKey = options.noCache ? '' : `${VERSION}|${nlp.normDoc.contentHash}|${registryCacheKey(reg, options)}`;
  if (cacheKey && ASSESS_CACHE.has(cacheKey)) {
    if (options.onCache) options.onCache(true, ASSESS_CACHE.size);
    return cloneAssessment(ASSESS_CACHE.get(cacheKey));
  }

  const findings = [];
  const topics = new Set();
  const reasons = new Set();
  const rejectedReasons = new Set();

  const spamFlag = (options.spam && options.spam.test(raw)) || nlp.intent === 'spam';
  const listingFlag = !!options.listing || nlp.intent === 'commercial_listing';
  const adFlag = nlp.intent === 'advertisement';
  const ventFlag = nlp.intent === 'personal_vent';
  const pureOpinionFlag = nlp.intent === 'opinion' && !nlp.flags.hasActionableEvent && !nlp.flags.anyOfficialWarning;
  const hardNonIncident = spamFlag || adFlag || ventFlag || pureOpinionFlag || (listingFlag && !nlp.flags.hasActionableEvent);

  const docHist = /\b(?:baca(?:in)?|belajar|buku|artikel|kisah|cerita)\s+sejarah\b/i.test(raw);
  const anyForeignClause = nlp.flags.anyForeign;

  if (!hardNonIncident) {
    for (const tp of reg) {
      if (!tp || !tp.pos) continue;
      if (tp.adhoc && NLP.isGenericLocationPhrase(tp.id)) continue;
      if (listingFlag && FEED_ONLY.has(tp.id)) continue;

      for (let idx = 0; idx < nlp.clauses.length; idx++) {
        const cr = nlp.clauses[idx];
        const span = cr.clause.raw;
        const proseSpan = cr.clause.rawNoTags || span;
        const normGeo = cr.clause.normGeo || '';

        const proseText = proseSpan.trim();
        const normProseText = cr.clause.normProse || '';
        const hasProseEvent = cr.events.length > 0;

        const matchedProse = (proseText && tp.pos.test(proseText)) || (!tp.adhoc && normProseText && tp.pos.test(normProseText));
        const allowTagFallback = !hasProseEvent || cr.events.some(e => e.topic === tp.id);
        const matchedTags = !matchedProse && allowTagFallback && tp.pos.test(span);
        const matchedPos = matchedProse || matchedTags;
        if (!matchedPos) continue;

        const isTradingHaltFin = /^(?:ihsg|rupiah)$/.test(tp.id) && /\b(?:trading\s+halt|bursa\s+efek)\b/i.test(span);
        const isTopicBlockedByMetaphor = NLP.metaphorBlocksTopic(cr.flags.metaphors, tp.id);
        const isMetaphor = isTopicBlockedByMetaphor || (!isTradingHaltFin && METAPHOR.test(proseText || span)) ||
          (options.noise && options.noise.test(proseText || span)) || (tp.neg && (tp.neg.test(proseText || span) || tp.neg.test(normProseText)));
        if (isMetaphor) {
          reasons.add('metaphor_or_nonincident_usage');
          rejectedReasons.add(NLP.REJECT_REASONS.METAPHORICAL_LANGUAGE);
          continue;
        }

        const hasNlpFrame = cr.events.some(e => e.topic === tp.id);
        if (tp.ctx && !(tp.strong && (tp.strong.test(span) || tp.strong.test(normGeo))) &&
            !tp.ctx.test(span) && !tp.ctx.test(normGeo) && !hasNlpFrame) {
          reasons.add('insufficient_topic_context');
          continue;
        }

        topics.add(tp.id);
        const category = CATEGORY[tp.id] || null;
        const feedOnly = FEED_ONLY.has(tp.id);
        const isAdhoc = !!tp.adhoc;

        const target = isAdhoc ? null : concreteTarget(span, category);
        let scope = isAdhoc ? 'unknown' : cr.geo.scope;
        let location = isAdhoc ? null : (cr.geo.location ? {
          name: cr.geo.location.name,
          prov: cr.geo.location.prov,
          prec: cr.geo.location.prec,
          la: cr.geo.location.la,
          lo: cr.geo.location.lo,
          ...(cr.geo.location.provCode ? { provCode: cr.geo.location.provCode } : {}),
          ...(cr.geo.location.kabCode ? { kabCode: cr.geo.location.kabCode } : {}),
          ...(cr.geo.location.kecCode ? { kecCode: cr.geo.location.kecCode } : {}),
          ...(cr.geo.location.code ? { code: cr.geo.location.code } : {}),
        } : null);

        if (!isAdhoc && !location && scope === 'unknown' && !anyForeignClause) {
          for (const adj of [idx - 1, idx + 1]) {
            if (adj < 0 || adj >= nlp.clauses.length) continue;
            const nb = nlp.clauses[adj];
            const badRole = nb.geo.primaryRole === NLP.GEO_ROLES.READER_LOCATION ||
              nb.geo.primaryRole === NLP.GEO_ROLES.AUTHOR_CURRENT_LOCATION ||
              nb.geo.primaryRole === NLP.GEO_ROLES.AUTHOR_HOMETOWN ||
              nb.geo.primaryRole === NLP.GEO_ROLES.HISTORICAL_LOCATION;
            if (nb.geo.scope === 'Indonesia' && nb.geo.location && !badRole &&
                !nb.flags.isDenial && !nb.flags.isHist && !nb.flags.isReader && !nb.flags.isHearsay &&
                !nb.flags.isCommercial && !nb.flags.isAd && !nb.flags.isVent && !nb.flags.isOpinion && !nb.flags.isSpam) {
              scope = 'Indonesia';
              location = { ...nb.geo.location };
              break;
            }
          }
        }

        const negTok = cr.flags.negatedTokens instanceof Set
          ? cr.flags.negatedTokens
          : new Set(Array.isArray(cr.flags.negatedTokens) ? cr.flags.negatedTokens : []);
        const isTopicNegated = negTok.has(tp.id) ||
          (tp.id === 'banjir' && negTok.has('flood')) ||
          (tp.id === 'gempa' && negTok.has('earthquake'));

        let reportType = (cr.flags.isDenial || DENIED_ANY.test(span) || DENIED.test(span) || isTopicNegated)
          ? 'denied'
          : (docHist || cr.flags.isHist || isHistorical(span, options.year))
            ? 'historical'
            : (!cr.flags.isCeremony && (cr.flags.isWarning || WARNING.test(span)))
              ? 'warning'
              : (cr.flags.isEdu || EDUCATION.test(span) || cr.flags.isCond)
                ? 'educational'
                : AID.test(span)
                  ? 'response'
                  : (cr.flags.isQuest || cr.flags.isHearsay || QUESTION.test(span) || cr.flags.isSatire)
                    ? 'unverified_question'
                    : 'commentary';

        const isMinorWaterloggingCorrection = tp.id === 'banjir' && cr.events.some(e => e.minorWaterlogging);
        if (isMinorWaterloggingCorrection) {
          reportType = 'commentary';
          if (isTopicNegated) reasons.add('negated_incident');
          reasons.add('minor_waterlogging_condition');
        }

        const report = !isAdhoc && !cr.flags.isCeremony && isReport(tp.id, proseSpan, location, target, cr);
        if (reportType === 'commentary' && report && !cr.flags.isReader && !cr.flags.isSatire) {
          reportType = 'reported';
        }

        const evType = hasNlpFrame
          ? cr.events.find(e => e.topic === tp.id).type
          : eventType(tp.id, span);

        const eligible = !spamFlag && !feedOnly && !isAdhoc && !cr.flags.isCeremony && !cr.flags.isReader &&
          !cr.flags.isSatire && !cr.flags.isQuest && !cr.flags.isHearsay && !cr.flags.isCommentaryMeta &&
          nlp.intent !== 'rumor' &&
          scope === 'Indonesia' && !!(location || target) &&
          (report || (reportType === 'warning' && !!(location || target) && !isTopicNegated)) &&
          (reportType === 'reported' || reportType === 'warning');

        if (scope !== 'Indonesia') reasons.add(scope === 'foreign' ? 'foreign_scope' : 'scope_not_established');
        if (!report && reportType !== 'warning') reasons.add('no_concrete_event');
        if (!eligible) reasons.add(reportType);
        if (eligible) {
          reasons.add(reportType === 'warning' ? 'official_warning_cue' : 'incident_action_detected');
          if (location) reasons.add('event_location_resolved');
          if (cr.flags.isEyewitness) reasons.add('eyewitness_indicator');
        }

        findings.push({
          topic: tp.id,
          category,
          type: evType,
          location,
          target,
          scope,
          reportType,
          signalEligible: eligible,
          ...(feedOnly ? { feedOnly: true } : {}),
          ...(isAdhoc ? { adhoc: true } : {}),
          evidence: span,
          severity: reportType === 'warning' ? 'warning' : 'unknown',
        });
      }
    }
  }

  if (!hardNonIncident && nlp.extractedEvents.length > 0) {
    for (const ev of nlp.extractedEvents) {
      if (ev.minorWaterlogging) continue;
      const regTp = reg.find(t => t.id === ev.topic && !t.adhoc);
      if (!regTp) continue;
      if (findings.some(f => f.topic === ev.topic && f.signalEligible)) continue;

      const loc = ev.location && ev.scope === 'Indonesia' ? {
        name: ev.location.name,
        prov: ev.location.prov,
        prec: ev.location.prec,
      } : null;
      const evRaw = (ev.evidence && ev.evidence[0]) || raw;
      const target = concreteTarget(evRaw, ev.category) || (NLP.LOCAL_ORG_RE.test(evRaw) ? NLP.LOCAL_ORG_RE.exec(evRaw)[0].toUpperCase() : null);
      const isWarning = ev.action === 'warning_issued' || nlp.intent === 'official_warning';
      const hasGeoOrTarget = (!!loc && (!ev.location || ev.location.role === NLP.GEO_ROLES.EVENT_LOCATION)) || (!!target && ev.scope === 'Indonesia');
      const isReportable = ev.strong && ev.scope === 'Indonesia' && hasGeoOrTarget &&
        nlp.intent !== 'rumor' && !nlp.flags.anyHearsay && !ev.clauseFlags.isCommentaryMeta &&
        !ev.clauseFlags.isCeremony && !ev.clauseFlags.isDenial && !ev.clauseFlags.isHist && !ev.clauseFlags.isQuest &&
        !ev.clauseFlags.isHearsay && !ev.clauseFlags.isReader && !ev.clauseFlags.isSatire;

      if (isReportable) {
        topics.add(ev.topic);
        const rt = isWarning ? 'warning' : 'reported';
        reasons.add(isWarning ? 'official_warning_cue' : 'incident_action_detected');
        if (ev.sourceType === 'eyewitness') reasons.add('eyewitness_indicator');
        if (loc) reasons.add('event_location_resolved');
        findings.push({
          topic: ev.topic,
          category: ev.category,
          type: ev.eventType,
          location: loc,
          target,
          scope: 'Indonesia',
          reportType: rt,
          signalEligible: true,
          evidence: evRaw,
          severity: isWarning ? 'warning' : 'unknown',
        });
      }
    }
  }

  if (spamFlag) { reasons.add('spam'); rejectedReasons.add(NLP.REJECT_REASONS.SPAM_OR_ENGAGEMENT_BAIT); }
  if (listingFlag && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.COMMERCIAL_LISTING);
  if (adFlag && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.ADVERTISEMENT);
  if (ventFlag && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.PERSONAL_VENT);
  if (pureOpinionFlag) {
    rejectedReasons.add(NLP.REJECT_REASONS.OPINION_OR_COMMENTARY);
    rejectedReasons.add(NLP.REJECT_REASONS.NO_CONCRETE_EVENT);
  }
  if (nlp.intent === 'historical' && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.HISTORICAL_REFERENCE);
  if (nlp.intent === 'educational' && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.EDUCATIONAL_CONTENT);
  if (nlp.intent === 'denial_or_debunk') {
    rejectedReasons.add(nlp.negatedEvents.length ? NLP.REJECT_REASONS.NEGATED_INCIDENT : NLP.REJECT_REASONS.DENIAL_OR_DEBUNK);
  }
  if (anyForeignClause && !findings.some(f => f.scope === 'Indonesia')) rejectedReasons.add(NLP.REJECT_REASONS.FOREIGN_SCOPE);
  if (nlp.flags.anyMetaphor && !nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.METAPHORICAL_LANGUAGE);
  if (nlp.geographicContext.role === NLP.GEO_ROLES.AUTHOR_CURRENT_LOCATION || nlp.geographicContext.role === NLP.GEO_ROLES.READER_LOCATION || nlp.geographicContext.role === NLP.GEO_ROLES.MENTIONED_IN_PASSING) {
    if (!nlp.flags.hasActionableEvent) rejectedReasons.add(NLP.REJECT_REASONS.LOCATION_NOT_EVENT_LOCATION);
  }

  const events = findings.filter(f => f.signalEligible);
  const eligible = events.length > 0;

  const nonAdhocFindings = findings.filter(f => !f.adhoc);
  const scope = eligible
    ? 'Indonesia'
    : (nonAdhocFindings.some(f => f.scope === 'Indonesia') || nlp.geographicContext.role === NLP.GEO_ROLES.EVENT_LOCATION)
      ? 'Indonesia'
      : anyForeignClause
        ? 'foreign'
        : 'unknown';

  const reportType = eligible
    ? (events.every(f => f.reportType === 'warning') ? 'warning' : 'reported')
    : nonAdhocFindings[0]?.reportType || findings[0]?.reportType || (nlp.intent === 'denial_or_debunk' ? 'denied' : nlp.intent === 'historical' ? 'historical' : nlp.intent === 'educational' ? 'educational' : nlp.intent === 'question' ? 'unverified_question' : 'irrelevant');

  const hasPermanentTopic = [...topics].some(tid => !reg.find(r => r.id === tid)?.adhoc);
  const hasSituationalIntent = ['question', 'rumor', 'discussion', 'personal_experience', 'satire'].includes(nlp.intent)
    || nlp.flags.anyMinorWaterlogging
    || (nlp.intent === 'eyewitness_report' && nlp.flags.anyMinorWaterlogging);

  const hasCrisisContext = nlp.clauses.some(c => c.flags.hasHazardCue || c.flags.hasHazardQuestion)
    || nonAdhocFindings.some(f => !f.adhoc && f.scope === 'Indonesia' && !['denied', 'historical', 'educational'].includes(f.reportType));

  const ID_PROSE_RE = /\b(?:yang|yg|di|ke|dari|ini|itu|untuk|utk|dengan|dgn|atau|pada|akan|sudah|udah|udh|belum|blm|tidak|tak|bukan|ga|gak|nggak|enggak|engga|kagak|kaga|jangan|jgn|warga|korban|mahasiswa|polisi|aparat|pemerintah|kawan|orang|org|rumah|rmh|jalan|jln|kota|daerah|wilayah|tempat|kantor|sekolah|kampus|pasar|mall|stasiun|bandara|tol|sungai|kali|tanggul|hujan|ujan|angin|api|asap|listrik|air|lampu|mati\s+lampu|mati\s+listrik|listrik\s+padam|byarpet|banjir|kebanjiran|longsor|kebakaran|terbakar|damkar|karhutla|gempa|erupsi|puting\s+beliung|kecelakaan|tabrakan|penembakan|ditembak|pencurian|curanmor|begal|jambret|dirampok|maling|penangkapan|ditangkap|diamankan|tersangka|korupsi|suap|ott|unjuk\s+rasa|demonstrasi|aksi\s+massa|bentrok|ricuh|mogok|keracunan|wabah|demam\s+berdarah|puskesmas|sembako|minyak\s+goreng|pertalite|pertamax|spbu|bansos|pemilu|pilkada|pilpres|caleg|menteri|presiden|gubernur|bupati|prabowo|gibran|jokowi|ihsg|rupiah|diretas|dibobol|peretasan|kebocoran\s+data|bocor|hari|pagi|siang|sore|malam|malem|jam|tahun|bulan|minggu|tadi|barusan|kemarin|kmrn|besok|sekarang|skrg|ada|adakah|apakah|apa|siapa|kapan|dimana|dmn|kemana|gimana|gmn|bagaimana|kenapa|knp|mengapa|berapa|karena|krn|karna|kalau|kalo|klo|jika|bila|tapi|tp|tetapi|terus|trs|jadi|jd|masih|msh|lagi|lg|baru|abis|habis|mau|pengen|pingin|bisa|bs|sama|sm|buat|bikin|pakai|pake|cuma|cm|cuman|hanya|banyak|semua|para|tiap|setiap|saat|waktu|pas|terjadi|melanda|merendam|terendam|mengungsi|evakuasi|tewas|meninggal|luka|rusak|ambruk|roboh|runtuh|jebol|meluap|padam|naik|turun|parah|banget|bgt|sekali|bener|benar|beneran|katanya|kabarnya|kayak|kyk|seperti|kaya|malah|padahal|memang|emang|emg|pasti|mungkin|kayaknya|agak|lumayan|cukup|kurang|lebih|paling|makin|tambah|udah|sih|dong|deh|nih|tuh|kok|lah|kah|mah|pun|kek|yak|yaa|yah|yuk|mari|ayo|tolong|plis|jir|anjir|njir|bjir|anjay|astaga|waduh|buset|parno|hectic|jujurly|literally\s+(?:di|udah|lagi|bikin|parah|gue|gw|aku|ada|ga|gak)|gue|gw|gua|aku|saya|lo|lu|kamu|kalian|kami|kita|mereka|dia|beliau|pak|bu|bang|bg|mas|mbak|mba|kak|om|tante|nder|min|mimin|bro|sis|guys\s+(?:ada|di|yg|ini|itu|kok|udah|lagi)|wkwk\w*|haha\w*|hehe\w*|cok|cuk|rek|lur|gan|bray|wes|wis|ora|nek|neng|ning|ndek|iki|iku|koe|koen|ngopo|gawe|ketok|enek|ana|teu|geus|ayeuna|atuh|euy|punten|sampurasun|wargi|caah|lindhu|udan|banyu|cai)\b/i;
  const FOREIGN_NON_ID_SCRIPT_OR_WORD_RE = /[¿¡ñÑçÇßãõÃÕåøæÅØÆłńśźżŁŃŚŹŻčřšžČŘŠŽğışĞİŞ]|\b(?:habra|habrá|dado|povo|assusta|infidelite|infidélité|nouveau|nouvelle|is\s+het|gaat\s+het|hebben\s+we|het\s+kabinet|uit\s+het|staat\s+op\s+vallen|gevallen|klappen|gestapt|vvd|cda|d66|pvv|fvd|nsc|tweede\s+kamer|eerste\s+kamer|den\s+haag|nederland|nederlands|verkiezingen|tussenformeren|belasting|gestemd|stemming|conclusie|hoezo|democratie|formatie|regerende\s+partijen|coalitieleden|verkiezingsuitslag|debacle-kabinet|links\s+kabinet|varian\s+baharu|baharu|dikesan|sejauh\s+mana\s+bahayanya)\b/i;
  const proseClean = raw.replace(/https?:\/\/\S+|[@#]\S+/g, ' ');
  const isForeignLanguage = nlp.flags.anyForeign || (nlp.layerTrace && nlp.layerTrace.isForeignLanguage);
  const hasIndonesianGrounding = !isForeignLanguage && (scope === 'Indonesia' || ID_PROSE_RE.test(proseClean) || LOCAL_ORG.test(proseClean) || LOCAL_MACRO.test(proseClean));
  const isUnanchoredForeign = isForeignLanguage || (!hasIndonesianGrounding && (scope === 'foreign' || FOREIGN_NON_ID_SCRIPT_OR_WORD_RE.test(proseClean) || proseClean.trim().length > 0));

  let feedLane = NLP.FEED_LANES.REJECTED;
  if (isUnanchoredForeign) {
    feedLane = NLP.FEED_LANES.REJECTED;
    rejectedReasons.add(NLP.REJECT_REASONS.FOREIGN_SCOPE);
  } else if (eligible) {
    feedLane = NLP.FEED_LANES.INCIDENT_SIGNALS;
  } else if (
    !hardNonIncident &&
    !isForeignLanguage &&
    topics.size > 0 &&
    !['denied', 'historical', 'educational'].includes(reportType) &&
    !['historical', 'educational', 'denial_or_debunk', 'unrelated', 'unknown'].includes(nlp.intent) &&
    scope !== 'foreign' &&
    hasIndonesianGrounding &&
    (hasPermanentTopic || hasCrisisContext) &&
    (hasSituationalIntent || nonAdhocFindings.some(f => f.feedOnly && f.scope === 'Indonesia'))
  ) {
    feedLane = NLP.FEED_LANES.SITUATIONAL_CONTEXT;
  } else if (
    !hardNonIncident &&
    !['historical', 'educational', 'denial_or_debunk', 'unrelated'].includes(nlp.intent) &&
    !['denied', 'historical', 'educational'].includes(reportType) &&
    scope !== 'foreign' &&
    (topics.size > 0 || nlp.flags.anySatire) &&
    nlp.confidence < 0.62
  ) {
    feedLane = NLP.FEED_LANES.DISCOVERY_CANDIDATES;
    rejectedReasons.add(NLP.REJECT_REASONS.LOW_CONFIDENCE);
  } else {
    feedLane = NLP.FEED_LANES.REJECTED;
    if (rejectedReasons.size === 0) {
      if (nlp.intent === 'question') rejectedReasons.add(NLP.REJECT_REASONS.QUESTION_WITHOUT_EVENT_EVIDENCE);
      else if (topics.size === 0) rejectedReasons.add(NLP.REJECT_REASONS.UNRELATED_TOPIC);
      else rejectedReasons.add(NLP.REJECT_REASONS.NO_CONCRETE_EVENT);
    }
  }

  const finalTopics = (feedLane === NLP.FEED_LANES.REJECTED && hardNonIncident) ? [] : [...topics];
  const feedEligible = feedLane === NLP.FEED_LANES.INCIDENT_SIGNALS || feedLane === NLP.FEED_LANES.SITUATIONAL_CONTEXT;

  let finalIntent = nlp.intent;
  if (eligible && !['incident_report', 'eyewitness_report', 'official_warning', 'official_update'].includes(finalIntent)) {
    finalIntent = reportType === 'warning' ? 'official_warning' : (nlp.flags.anyEyewitness ? 'eyewitness_report' : 'incident_report');
  }

  const out = {
    version: VERSION,
    topics: spamFlag ? [] : finalTopics,
    scope,
    reportType,
    feedEligible,
    signalEligible: eligible,
    events,
    findings,
    reasons: [...reasons],
    rejectedReasons: (feedLane === NLP.FEED_LANES.INCIDENT_SIGNALS || feedLane === NLP.FEED_LANES.SITUATIONAL_CONTEXT) ? [] : [...rejectedReasons],
    severity: eligible && events.some(f => f.severity === 'warning') ? 'warning' : 'unknown',
    normalizedText: nlp.normDoc.normalized,
    contentHash: nlp.normDoc.contentHash,
    intent: finalIntent,
    feedLane,
    confidence: nlp.confidence,
    classification: {
      intent: finalIntent,
      topicMatch: finalTopics.length > 0,
      incidentEvidence: eligible || nlp.flags.hasActionableEvent,
      feedLane,
      confidence: nlp.confidence,
    },
    geographicContext: nlp.geographicContext,
    event: nlp.event,
    extractedEvents: nlp.extractedEvents.map(({ clauseFlags, ...rest }) => rest),
    layerTrace: {
      normalization: {
        clauses: nlp.clauses.length,
        hashtagsSegmented: nlp.normDoc.hashtagsSegmented,
        reduplication: nlp.normDoc.reduplication,
      },
      intentScoresTop3: Object.entries(nlp.intentScores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3),
      geoRole: nlp.geographicContext.role,
      negatedEvents: nlp.negatedEvents,
      metaphors: nlp.metaphorHits,
    },
  };

  if (cacheKey) {
    if (ASSESS_CACHE.size >= ASSESS_CACHE_MAX) ASSESS_CACHE.delete(ASSESS_CACHE.keys().next().value);
    ASSESS_CACHE.set(cacheKey, out);
    if (options.onCache) options.onCache(false, ASSESS_CACHE.size);
  }

  return cloneAssessment(out);
}

module.exports = {
  VERSION,
  CATEGORY,
  FEED_ONLY,
  assess,
  isHistorical,
  norm,
  clauses,
  classifyScope,
  INTENTS: NLP.INTENTS,
  FEED_LANES: NLP.FEED_LANES,
  GEO_ROLES: NLP.GEO_ROLES,
  REJECT_REASONS: NLP.REJECT_REASONS,
  normalizeIndonesian: NLP.normalizeIndonesian,
  isGenericLocationPhrase: NLP.isGenericLocationPhrase,
};
