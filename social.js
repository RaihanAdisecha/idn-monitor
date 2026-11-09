'use strict';
/* ============================================================
   SOCIAL TOPIC REGISTRY — satu sumber kebenaran buat X + Threads.
   - Chip, query fetch, dan klasifikasi post semua turun dari SOC_TOPICS.
   - Tiap post diklasifikasi SEKALI di server ke topics[] (bukan "query yang kebetulan nemu").
   - Pure module: tanpa I/O, bisa dites offline.
   ============================================================ */

// metafora / idiom: "kebakaran jenggot", "banjir orderan", dst. Post begini bukan kejadian.
const SOC_NOISE_RE = /(kebakaran jenggot|banjir (order|orderan|diskon|promo|pujian|notif|notifikasi|air\s?mata|ingus|berita|informasi|data|inbox|email|surel|wa|whatsapp|komen|komentar|dm|like|followers?|rezeki|cuan|berkah|hadiah|bonus|kado|tawaran|pesanan|chat|ucapan)|(hati|dada|semangat|jiwa|emosi|cemburu|amarah)[^.\n]{0,12}terbakar|terbakar (semangat|emosi|cemburu|amarah|api asmara|rindu)|tenggelam dalam|hanyut dalam|terjun (bebas )?(ke dunia|ke politik|payung)|gempa (hati|rasa|jantung)|meledak(-ledak)? (emosi|tawa|tangis)|film|sinema|bioskop|trailer|teaser|nonton|netflix|sinetron|sinetrik|drakor|kpop|k-pop|fancam|webtoon|anime|episode|\beps\b|chapter|konser|concert)/i;

// spam/farming/phishing: engagement-bait & jualan, bukan konten kejadian.
// pola: "Vote for X", rantai "Follow A. Follow B.", "DM untuk order", "link di bio", hashtag stuffing.
// Listing properti/jual-beli: butuh KEDUA sisi — kata benda properti DAN bahasa
// deal/harga — supaya berita insiden yang kebetulan menyebut "rumah"/"tanah"
// tidak ikut terbuang. Hanya men-skip topik FEED_ONLY (lihat assessment.js).
const SOC_LISTING_RE = /(rumah|propert\w*|tanah|kavling|ruko|rukan|kost|apartemen|villa|cluster|dagung|bengkel|gudang|kios|petak|showroom|motogarage|otomotif|motor second|mobil second|sewa mobil|rental mobil|sparepart|bengkel modifikasi)/i;
const SOC_LISTING_DEAL = /(dijual|disewakan|disewa|menjual|menyewakan|kpr|dp\s?(nol|0)?\b|cash\s?(keras|cepat|bertahap)|nego|furnish|siap (huni|tempati|pakai|lanjut)|strategis|prime location|turun harga|ngotak|pinang|worth+|hemat\s+\d|buruan|mumpung|bonus\s+(car|cash)|cashback|payment plan|cicilan|booking fee|unit (tinggal|tersedia|ready)|hubungi (wa|whatsapp)|pre[- ]?order|ready stock|bebas request|request (warna|striping|konsep|modifikasi|custom)|modifikasi sesuai|custom (livery|striping|wrap)|garansi\b|quality check|diserahterimakan|serah terima)/i;
const SOC_SPAM_RE = /(vote for|follow\s+[\w.@-]+\s*[+.&]?\s*follow|like\s*(dan|&|\+)\s*(follow|rt)|rt\s*(dan|&|\+)\s*follow|dm\s+(untuk|di|ke)\s*(order|harga|promo|info|respon|detail|ticket|tiket)|dm\s+ke\s+@|link\s+(di|ada di)\s+bio|cek\s+(link\s+)?di\s+bio|order\s+(via|melalui|di)\s+(wa|whatsapp|dm|bio|link)|order\s+(di|via)\s+bio|linktree|lynk\.?id|beacons\.?ai|taplink|bio\.?link|kasih\s+follow|follow\s+balik|jangan\s+lupa\s+follow|\bfyp\b|foryou|new\s+followers?|boost\s+followers?|giveaway|gifted|berhadiah|klaim\s+(hadiah|reward|bonus)|winner\s+dm|pemenang\s+(dm|di\s+(comment|komentar))|tag\s+(teman|orang|friend)|sebutkan\s+\d+\s*teman|tag\s+\d+\s*teman|(like|comment|share|follow)\s*(dan|&|\+)\s*(like|comment|share|follow|rt)|\b\d{1,2}\s*\/\s*(thread|bagian|part|lanjutan)|thread\s*\/|🧵|lanjut\s+di\s+thread|baca\s+sampai\s+habis|qris[^.\n]{0,40}order|order[^.\n]{0,40}qris|binary\s+option|robot\s+trading|signal\s+(trading|emas|crypto|kripto|saham)|rekomendasi\s+(saham|crypto|kripto)|cuan\s+tiap\s+hari|airdrop|seed\s+phrase|private\s+key|withdraw\s+(cepat|instan|kilat)|pinjol|investasi bodong|\bwtb\b|\bwts\b|jasa titip|\bjastip\b|jasa war|war tiket|titip (tiket|beli)|tetap\s+cep[ae]t\s+dan\s+terkoordinasi\s+dengan\s+baik|dikawal\s+penuh\s+pemerintah|#penanganankarhutla)/i;
// aksara non-Latin (Hangul, Thai, CJK, Kiril, Arab, Devanagari) dominan = konten luar negeri
// yang tidak tertangkap nama-negara Latin — misal spam tiket Korea full Hangul
const SOC_NONLATIN_RE = /[\u0E00-\u0E7F\u0E80-\u0EFF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u10A0-\u10FF]/g;
// aksara non-Latin per-script: ID/EN tidak pernah memakai ini, jadi ambang bisa rendah.
// URL/mention distrip dulu — t.co & handle Latin bukan konten.
const SOC_SCRIPT_RES = {
  kana: /[぀-ヿ]/g,                    // Hiragana+Katakana = Jepang
  hangul: /[가-힯ᄀ-ᅟ]/g,              // Korea
  thai: /[฀-๿]/g,
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  devanagari: /[ऀ-ॿ]/g,
  armenian: /[԰-֏]/g,
  hanzi: /[㐀-䶿一-鿿]/g              // Cina
};
const SOC_SCRIPT_MIN = { kana: 3, hangul: 3, thai: 4, arabic: 4, cyrillic: 4, devanagari: 4, armenian: 4, hanzi: 3 };
function socNonLatin(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
  for (const k in SOC_SCRIPT_RES) {
    if ((s.match(SOC_SCRIPT_RES[k]) || []).length >= SOC_SCRIPT_MIN[k]) return true;
  }
  // backstop: campuran non-Latin dominan tanpa satu script pun mencapai ambang
  const nl = (s.match(SOC_NONLATIN_RE) || []).length;
  const lat = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  return nl >= 20 && nl > lat;
}
// Vietnam Latin tapi penuh diakritik khas (đ/ă/ơ/ư + vokal bernada) — spam crypto/exchange VN lolos cek non-Latin
const SOC_VI_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/g;
function socVi(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
  const vi = (s.match(SOC_VI_RE) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return (vi >= 15 && vi * 4 >= lat) || (vi >= 8 && vi * 3 >= lat);
}
// kepadatan hashtag: spam kampanye/crypto numpuk tag; rasio karakter tag vs total teks.
// ＃ fullwidth ikut dihitung; cashtag ($XXX) dihitung terpisah — >=3 + istilah
// komersial/kripto = junk walau tanpa hashtag biasa.
function socHashJunk(t) {
  // URL distrip dulu (pola socNonLatin/socVi): fragmen t.co/tautan bisa ikut
  // terbaca sebagai hashtag dan menggelembungkan rasio tag post yang legit.
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ');
  const tags = s.match(/#[\p{L}\p{N}_]+/gu) || [];
  const n = tags.length + (s.match(/＃/g) || []).length;
  const cashtags = (s.match(/\$[\p{L}\p{N}]{2,}/gu) || []).length;
  if (n > 10) return true;
  if (cashtags >= 3 && /\b(crypto|kripto|bitcoin|btc|ethereum|airdrop|trading|cuan|investasi|signal|token|wallet)\b/i.test(s)) return true;
  const chars = tags.reduce((x, h) => x + h.length, 0);
  const ratio = chars / Math.max(1, s.length);
  if (n >= 8 && ratio > 0.28) return true;
  if (n >= 5 && s.length <= 80 && ratio > 0.30) return true;
  return s.length > 60 && ratio > 0.4;
}
// tanda tangan teks untuk deteksi astroturf: buang URL/mention/tag/emoji,
// sisakan alfabet+angka — dua postingan "sama" dari akun beda = koordinasi
function astroturfSig(t) {
  return String(t || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w]+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}
// bahasa Latin asing (Spanyol/Italia/Belanda/dst): franc statistik, hanya untuk
// teks cukup panjang.Whitelist: Indonesia + Melayu + bahasa daerah Indonesia
// (franc sering baca teks telegram-style sbg 'sun'/'min'/'jav' — tetap konten
// Indonesia), Inggris, dan 'und' (tak terdeteksi — biarkan, jangan over-strict).
const { franc } = require('franc');
const SOC_LANG_OK = new Set(['ind', 'zlm', 'eng', 'und',
  'sun', 'min', 'jav', 'mad', 'ban', 'bug', 'mak', 'ace']);
function socForeignLang(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ').trim();
  if (s.length < 40) return false;   // teks pendek: franc tidak stabil, biarkan gate lain
  const lang = franc(s);
  return !!lang && !SOC_LANG_OK.has(lang);
}

// kata negara asing: membuang "penembakan di Texas", "gempa Jepang" dst. KECUALI ada petunjuk lokal Indonesia.
const SOC_FOREIGN_RE = /\b(amerika|texas|california|new york|brasil|brazil|filipina|thailand|malaysia|korea|jepang|japan|tiongkok|china|inggris|britain|prancis|perancis|paris|france|jerman|germany|australia|india|pakistan|iran|israel|palestina|palestine|ukraina|ukraine|rusia|russia|gaza|turki|turkey|meksiko|mexico|kanada|canada|vietnam|chile|argentina|spanyol|spain|portugal|italia|italy|belanda|netherlands|swiss|swedia|sweden|norwegia|norway|denmark|yunani|greece|eropa|europe|nepal|london|oyo|osun|nigeria|afrika|trump|poland|polandia|polonia|krakow|warsaw|warszawa|lublin|czechia|ceko|prague|praha|austria|vienna|wina|finland|finlandia|helsinki|singapura|singapore|hong kong|taipei|tokyo|seoul|beijing|manila|bangkok|hanoi|kualalumpur|kathmandu|moskwa|moscow|berlin|rome|roma|madrid|amsterdam|brussels|zurich|stockholm|oslo|copenhagen|dublin|budapest|bucharest|sofia|belgrade|zagreb|vilnius|riga|tallinn|minsk|kiev|kyiv|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|nairobi|kampala|kigali|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|sucre|suriah|syria|irak|iraq|mesir|egypt|libya|libia|maroko|morocco|aljazair|algeria|tunisia|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|hungaria|hungary|rumania|romania|bulgaria|serbia|kroasia|croatia|slowakia|slovakia|slovenia|belgia|belgium|irlandia|ireland|estonia|latvia|lithuania|belarus|mongolia|maladewa|maldives|timor leste|selandia baru|new zealand|kuba|cuba|jamaika|jamaica|haiti|nikaragua|kosta rika|costa rica|kolombia|colombia|venezuela|bolivia|ekuador|ecuador|peru|paraguay|uruguay|congo|rwanda|uganda|tanzania|zambia|zimbabwe|mozambique|angola|namibia|botswana|lesotho|madagascar|mauritius|somalia|eritrea|djibouti|afghanistan|bhutan|brunei|albania|armenia|azerbaijan|cyprus|iceland|kosovo|luxembourg|malta|moldova|montenegro|san marino|vatikan|vatican|monako|monaco|georgia|jordan|panama|senegal|cameroon|gambia|guinea|sierra leone|liberia|mauritania|burkina faso)\b/i;
const SOC_LOCAL_RE = /(indonesia|\bwni\b|jakarta|jabar|jateng|jatim|jawa|sumatera|sumatra|kalimantan|sulawesi|papua|bali\b|aceh|riau|banten|bekasi|bogor|depok|tangerang|bandung|surabaya|medan|makassar|semarang|yogya|bpbd|bnpb|bmkg|polres|polda|polsek|kodim|damkar|pemkot|pemkab|kabupaten|provinsi|prabowo|gibran|\bdpr\b|dprd|kapolri|polri)/i;

const SOC_TOPICS = [
  { id: 'demo', local: true,
    pos: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|\bdemo\b|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day|\borasi\b|\bricuh\b|gas air mata|water cannon|buruh mogok|\bkspi\b|\bfspi\b|aksi buruh|\breformasi\b|turun ke jalan|\bmay day\b|long march|barikade|tuntutan mahasiswa)/i,
    strong: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day)/i,   // tanpa ini, kata "demo" polos butuh konteks
    ctx: /(tuntut|tolak|mahasiswa|\bbem\b|buruh|ojol|\bdpr\b|dprd|gedung|polisi|aparat|gas air mata|\baksi\b|\bmassa\b|\borasi\b|turun ke jalan|spanduk|\bricuh\b|bentrok|rusuh|ditangkap|diamankan|bubarkan|barikade|molotov|water cannon|kapolda|kapolres|\breformasi\b|pemerintah|istana|patung kuda|\bmarch\b|aksi damai|long march)/i,
    neg: /(demo (lagu|musik|reel|reels|app|apps|aplikasi|akun|produk|plane|game|beat|tape|masak|memasak|cooking|vokal|record|rekaman|day|link|version|ui|web|website|bot|trading)|free demo|live demo|cooking demo|demonstrasi (produk|alat|masak|memasak|fitur)|happy\s+(labor|labour|international\s+women'?s)\s+day|selamat\s+(hari buruh|hari perempuan|international women'?s day)|\bdemo\b.{0,20}#(music|musik|beat))/i,
    x: ['(unjuk rasa OR demonstrasi OR "aksi massa" OR demonstran) -filter:replies',
        'demo (mahasiswa OR buruh OR ojol OR DPR OR tuntutan OR ricuh OR polisi) -filter:replies'],
    th: ['unjuk rasa', 'aksi massa', 'demo hari ini', 'demo mahasiswa', 'demonstrasi', '#unjukrasa'] },
  { id: 'kebakaran', local: true,
    pos: /(kebakaran|terbakar|kobaran api|si jago merah|dilalap api|ludes dilalap|\bdamkar\b)/i,
    neg: /(kebakaran (hutan|lahan)|karhutla|kebakaran (harga|promo|diskon|obral|sale|murah|gila|meriah|jagoan|gaib|mangling|total)|harga (kebakaran|panas|terbakar)|(terbakar|kebakaran)[^.\n]{0,20}(nasi|roti|ayam|makanan|kuliner|resep|memasak|cooking|wajan|panci|steak|bakso|mie\b))/i,   // hutan/lahan masuk topik sendiri; "kebakaran harga" = slang sale; "nasi terbakar" = kuliner
    x: ['(kebakaran OR "si jago merah" OR "ludes terbakar" OR damkar) -filter:replies'],
    th: ['kebakaran hari ini', 'kebakaran', 'damkar', 'terbakar', 'kobaran api', 'dilalap api', '#kebakaran'] },
  { id: 'karhutla', local: true,
    pos: /(karhutla|kebakaran (hutan|lahan)|titik panas|hotspot|kabut asap|\basap\b|sipongi)/i,
    // "titik panas" juga dipakai wabah/kesehatan — wajib konteks kebakaran lahan
    strong: /(karhutla|kebakaran (hutan|lahan)|kabut asap)/i,
    ctx: /(hutan|lahan|karhutla|kebakaran|riau|sumatera|kalimantan|papua|jambi|sumsel)/i,
    x: ['(karhutla OR "kebakaran hutan" OR "kebakaran lahan" OR "kabut asap" OR "titik panas" OR hotspot) -filter:replies'],
    th: ['karhutla', 'kebakaran hutan', 'kabut asap', 'kebakaran lahan', 'titik panas'] },
  { id: 'banjir', local: true,
    pos: /(banjir|longsor|tanggul jebol|air meluap|genangan|hujan deras|air bah)/i,
    x: ['(banjir OR longsor OR "banjir bandang" OR "tanggul jebol") -filter:replies'],
    th: ['banjir hari ini', 'banjir', 'banjir bandang', 'longsor', 'tanggul jebol', 'air meluap', '#banjir'] },
  { id: 'gempa', local: true,
    pos: /(gempa|tsunami|magnitudo|erupsi|letusan gunung|guncangan|megathrust|hujan abu)/i,
    // "tsunami" sendirian sering kiasan: "blue/blauwe tsunami" = gerakan protes politik,
    // tsunami finance/sport — wajib konteks seismik atau lokasi bencana
    neg: /(blue|blauwe)\s+tsunami|tsunami\s+(biru|politik|protes)/i,
    strong: /(gempa|magnitudo|erupsi|letusan)/i,
    ctx: /(gempa|earthquake|megathrust|gelombang pasang|air bah|pesisir|tepi laut|palung|bmkg|bnpb|bpbd|tsunami warning|peringatan(?: dini)? tsunami|tsunami (?:menerjang|melanda|menghantam) (?:pantai|pesisir))/i,
    x: ['(gempa OR tsunami OR magnitudo OR erupsi) -filter:replies'],
    th: ['gempa barusan', 'gempa', 'gempa bumi', 'erupsi', 'bmkg gempa', '#gempa'] },
  { id: 'kecelakaan', local: true,
    pos: /(kecelakaan|tabrakan|tabrak lari|kapal (tenggelam|karam)|pesawat jatuh|bus terguling|truk terguling|kereta anjlok|ledakan)/i,
    // "ledakan"/"tabrakan" sering kiasan: ledakan penduduk, tabrakan pendapat
    // motorsport: "kecelakaan/tabrakan" dalam laporan balap (F1 dll) = insiden lintasan,
    // bukan kecelakaan publik. Wajib KEDUA sisi dalam klausa yang sama (neg dites per-span):
    // kata insiden dalam <=200 char dari marker motorsport, dua arah.
    neg: /(ledakan (penduduk|jumlah|kasus|order|orders|promo|penjualan|chat|emoji|tawa|tangis|debat|lagu|musik|harga|bonus|like|komentar|followers?|data|traffic|trafik)|tabrakan (pendapat|argumen|prinsip|debat|pemikiran|jadwal|acara|event|konser|libur|ujian|meeting|praktik|praktikum)|(jadwal|acara|event|konser|libur|ujian|meeting|praktik)[^.\n]{0,15}tabrakan|kecelakaan (cinta|asmara)|(?<=(?:kecelakaan|tabrakan|tertabrak|tertabrakan|tabrak lari)[^.\n]{0,200})(?:grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s*ferme|grid\s+(?:start|position)|start\s+grid|safety\s*car|safetycar|red\s+flag|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s*zone|\bdrs\b|\bers\b|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup))|(?:grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s*ferme|grid\s+(?:start|position)|start\s+grid|safety\s*car|safetycar|red\s+flag|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s+zone|\bdrs\b|\bers\b|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup))(?=[^.\n]{0,200}(?:kecelakaan|tabrakan|tertabrak|tertabrakan|tabrak lari)))/i,
    x: ['(kecelakaan OR "tabrak lari" OR "bus terguling" OR "kapal tenggelam" OR "truk terguling" OR "kereta anjlok" OR "pesawat jatuh" OR "kapal karam" OR tabrakan OR ledakan) -filter:replies'],
    th: ['kecelakaan hari ini', 'kecelakaan', 'kecelakaan lalu lintas', 'truk terguling', 'tabrakan', 'bus terguling', 'kereta anjlok', 'kapal tenggelam'] },
  { id: 'penembakan', local: true,
    pos: /(penembakan|ditembak|baku tembak|tertembak)/i,
    neg: /(ditembak (hati|cinta|asmara|batin|panah|tatapan))/i,   // kiasan asmara/cinta
    x: ['(penembakan OR ditembak OR "baku tembak") -filter:replies'],
    th: ['penembakan', 'ditembak', 'tertembak', 'baku tembak'] },
  { id: 'pencurian', local: true,
    pos: /(pencurian|curanmor|begal|perampokan|jambret|dirampok|kemalingan|maling|pencuri)/i,
    neg: /((pencuri|maling)[^.\n]{0,15}(hati|cinta|perhatian))/i,
    x: ['(pencurian OR curanmor OR begal OR perampokan OR jambret) -filter:replies'],
    th: ['pencurian', 'curanmor', 'begal', 'perampokan', 'jambret', 'dirampok', 'kemalingan'] },
  { id: 'penangkapan', local: true,
    pos: /(penangkapan|ditangkap|diamankan|\bott\b|razia|penahanan|buron|tersangka)/i,
    ctx: /(polisi|polres|polda|polsek|\bkpk\b|kejaksaan|\bbnn\b|densus|petugas|aparat|tersangka|pelaku|buron)/i,
    x: ['(penangkapan OR ditangkap OR OTT) (polisi OR KPK OR Densus OR tersangka) -filter:replies'],
    th: ['penangkapan', 'ditangkap polisi', 'ditangkap', 'diamankan', 'OTT', 'Densus'] },
  { id: 'phk',
    pos: /(\bphk\b|pemutusan hubungan kerja|dirumahkan|pabrik tutup)/i,
    x: ['(PHK OR "pemutusan hubungan kerja" OR dirumahkan OR "pabrik tutup") -filter:replies'],
    th: ['PHK', 'pemutusan hubungan kerja', 'dirumahkan', 'pabrik tutup'] },
  { id: 'rupiah',
    pos: /(rupiah|kurs dolar|kurs dollar|nilai tukar)/i,
    x: ['(rupiah OR "kurs dolar" OR "nilai tukar") -filter:replies'],
    th: ['rupiah', 'kurs dollar', 'dollar naik', 'kurs dolar', 'nilai tukar'] },
  { id: 'ihsg',
    pos: /(\bihsg\b|trading halt|bursa efek|\bidx\b)/i,
    x: ['(IHSG OR "trading halt" OR "bursa efek" OR IDX) -filter:replies'],
    th: ['IHSG', 'bursa efek', 'trading halt', 'IDX'] },
  { id: 'listrik padam',
    pos: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|mati lampu|blackout|byarpet)/i,
    // "blackout" sendirian terlalu longgar: dipakai kampanye K-pop (#Blackoutforboom),
    // EDM, dan spam tiket — wajib konteks utilitas/Indonesia
    strong: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|mati lampu|byarpet)/i,
    ctx: /(listrik|pln|pemadaman listrik|padam listrik|mati listrik|mati lampu)/i,
    x: ['("listrik padam" OR "mati listrik" OR "mati lampu" OR "pemadaman listrik" OR "padam listrik" OR byarpet OR blackout) -filter:replies'],
    th: ['mati lampu', 'mati listrik', 'listrik padam', 'PLN padam', 'padam listrik', 'byarpet'] },
  { id: 'wabah',
    pos: /(wabah|kejadian luar biasa|keracunan (massal|makanan|mbg)|kasus (dbd|campak|difteri|kolera|covid|flu burung))/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood)/i,
    x: ['(wabah OR "keracunan massal" OR "keracunan makanan" OR KLB OR "kejadian luar biasa" OR "kasus DBD") -filter:replies'],
    th: ['wabah', 'keracunan massal', 'demam berdarah', 'DBD', 'kejadian luar biasa'] },
  { id: 'pemilu', local: true,
    pos: /(pemilu|pilkada|pilpres|\bkpu\b|bawaslu|quick count|real count|coblos|surat suara|pilwalkot)/i,
    // kpu/bawaslu adalah akronim 3-7 huruf yang kebetulan jadi kata di bahasa lain
    // (Igbo "kpu", dll) — wajib konteks elektoral; ctx SENGAJA tanpa kpu/bawaslu
    // supaya tidak self-satisfy.
    strong: /(pemilu|pilkada|pilpres|pilwalkot|pilgub|pilbup|quick count|real count|coblos|surat suara|pemungutan suara|kotak suara)/i,
    ctx: /(pemilu|pilkada|pilpres|pemilihan|pemungutan|suara|kursi|partai|caleg|capil|capres|cawapres|paslon|dpr|dprd|kpud|kotak|coblos|golput|tahapan|penghitungan|pasangan|pasangan calon|pilgub|pilbup|pilgici)/i,
    x: ['(pemilu OR pilkada OR pilpres OR KPU OR Bawaslu) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', '#pilkada'] },
  { id: 'politik', local: true,
    pos: /(partai politik|caleg|capil|daftar caleg|\bdpr\b|\bdprd\b|parlemen|fraksi|koalisi|oposisi|kabinet|\bmenteri\b|wakil (presiden|menteri)|\bistana\b|senayan|menko|kadin|\bgubernur\b|\bbupati\b|wali kota|\bpilkada\b|\bpilgub\b|\bpilbup\b|\bpilgici\b|\bkpud\b|impeachment|majelis kehormatan|sidang mk|prabowo|apbn|rapbn|danantara|gibran|reshuffle[^.\n]{0,20}kabinet|kabinet[^.\n]{0,20}reshuffle)/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hakase|kpop|k-pop|bias[^.\n]{0,10}\bdpr\b|fans?[^.\n]{0,10}\bdpr\b|\bdpr\b[^.\n]{0,15}(cream|artic|live|concert|fan|bias|music|song|album|stage)|dpr (cream|artic))/i,
    x: ['(pemilu OR pilkada OR pilpres OR "partai politik" OR caleg OR DPR OR kabinet OR reshuffle OR menteri) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', 'DPR', 'kabinet', 'reshuffle'] },
  { id: 'konflik', local: true,
    pos: /(\bperang\b|\bkonflik\b|\binvasi\b|aneksasi|pendudukan|gencatan senjata|ultimatum|kudeta|pemberontakan|separatis|genosida|blokade|embargo|sandera|pembajakan|pertempuran|darurat militer|darurat sipil|mobilisasi|milisi|paramiliter|peluru kendali|\brudal\b|\bdrone\b|\bdron\b|serangan udara|serangan rudal|\bbom\b|granat|artileri|\btni\b|\btentara\b|militer|perjanjian damai|perundingan damai)/i,
    // "perang harga" = sale; "konflik batin/rumah tangga" = personal; "bom waktu/saraf" = bukan senjata
    neg: /(perang harga|perang (saudara|dagang|harga|dunia ketiga|polusi|sampah|hati|jiwa|batin|pendapat|online|dunia maya|netizen|gosip)|konflik (batin|psikologis|rumah tangga|hukum|personal)|bom (wacana|waktu|tank|mobil|rakit|dekat|saraf)|\bthe bom\b|\bbom(?:'s)?\s+(?:to|of|for|in|on|at|by|from|with|weather|station|bureau|meteorology|forecast|warning|australia|says?|said|announc\w*|expect\w*|predict\w*|replaces?|wants?|urges?|calls?|issues?|extends?|report\w*|confirm\w*)\b|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|dirgahayu|kami (akan |sedang )?melaksanakan|wajib hijrah|jauhi yang kafir|khalifahah)/i,
    x: ['(perang OR "gencatan senjata" OR ultimatum OR invasi OR aneksasi OR kudeta OR "perjanjian damai" OR "darurat militer") -filter:replies'],
    th: ['perang', 'konflik', 'gencatan senjata', 'invasi', 'kudeta', 'serangan udara', 'militer', 'tentara', 'TNI', 'rudal', 'drone', 'pertempuran', 'sandera', 'pembajakan', 'ultimatum', 'aneksasi', 'mobilisasi', 'darurat militer', 'perundingan damai'] },
  { id: 'insiden', local: true,
    pos: /(ambruk|runtuh|pohon tumbang|tenggelam|kapal karam|kapal tenggelam|hanyut|tergelincir|jatuh dari gedung|jembatan putus|bangunan roboh)/i,
    // metafora: "runtuhnya NKRI/keluarga", "ambruknya kurs/ekonomi" bukan insiden fisik
    neg: /(runtuhnya (NKRI|negara|keluarga|ekonomi|rezim|pemerintah|sistem|karir|hubungan|cinta|pernikahan)|ambruknya (kurs|ekonomi|pendidikan|parlementarisme|rezim|pemerintah|sistem|hubungan|cinta|karir))/i,
    x: ['(ambruk OR runtuh OR "pohon tumbang" OR tenggelam OR karam) -filter:replies'],
    th: ['ambruk', 'kapal tenggelam', 'runtuh', 'tenggelam'] },
  { id: 'kriminal', local: true,
    pos: /(pembunuhan|dibunuh|pengeroyokan|dikeroyok|begal|\bcurat\b|perampokan|dirampok|terorisme|narkoba|penculikan|perkosaan|rudapaksa|kdrt|judol|tppo|judi online)/i,
    x: ['(pembunuhan OR pengeroyokan OR begal OR perampokan OR penculikan OR narkoba) -filter:replies'],
    th: ['pembunuhan', 'begal', 'pengeroyokan', 'perampokan'] },
  { id: 'kesehatan', local: true,
    pos: /(demam berdarah|\bdbd\b|\bdhf\b|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|kolera|rabies|gila anjing|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|rotavirus|flu burung|h1n1|malaria|wabah|kejadian luar biasa|gagal ginjal|stunting|vaksin|imunisasi|puskesmas|kemenkes|rumah sakit|obat palsu|gizi buruk)/i,
    // DBD = Dead by Daylight (game) sangat ramai di X — "main DBD", "DBD match/rank/chapter" bukan demam berdarah.
    // "TBC" = to be confirmed di posting hasil laga: "FINAL | X 1 Y 0 TBC", "we exit the cup" — bukan tuberkulosis.
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood|dead by daylight|main\s+dbd|play\s+dbd|dbd[^.\n]{0,30}(match|rank|chapter|killer|survivor|lag|server|mobile|skin|update|repair|macro|rivals|phasmo|twitch|stream|queue|gaming|lobby|game|main|play|take on|grinding|leveling)|deadbydaylight|dead[- ]by[- ]daylight|\b(?:el|la|del|al)\s+dbd\b|\bwe\s+(?:exit|advance|progress|through|win|drew|lost|booked|qualified)\b[^.\n]{0,50}\b(?:cup|final|match|game|tie|round|knockout|semi|qf|sf|league)\b|\b(?:man|player|goal|motm)\s+of\s+the\s+match\b|\bsafe trip home\b|\b(?:full[- ]?time|ft)\s*(?:result|score|whistle|report)\b|\btbc\b[^.\n]{0,40}(lineup|squad|bench|starting|kick.?off|match|game|vs\b|injur|suspend)|\(tbc\))/i,
    // "TBC" telanjang di X = "to be confirmed" (hasil laga) — dipisah ke query lang:id
    x: ['("demam berdarah" OR DBD OR COVID OR influenza OR campak OR "tangan kaki mulut" OR leptospirosis OR rabies OR kolera OR mpox OR polio OR "gagal ginjal" OR KLB OR wabah OR imunisasi OR vaksin) -filter:replies',
        'lang:id (TBC OR tuberkulosis OR "TBC paru") -filter:replies'],
    th: ['demam berdarah', 'wabah', 'TBC', 'influenza', 'keracunan massal', 'gagal ginjal', 'vaksin', 'imunisasi', 'DBD', 'covid', 'korona', 'tifus', 'stunting', 'malaria', 'diare', 'campak', 'kolera', 'rabies', 'tuberkulosis', 'pneumonia', 'tangan kaki mulut', 'leptospirosis'] },
  { id: 'ransomware', local: true,
    pos: /(ransomware|malware|lockbit|blackcat|alphv|\bclop\b)/i,
    // "malware" dipakai kiasan ("humans were malware infected") dan disebut dalam daftar kejahatan
    // artikel regulasi — wajib konteks insiden siber nyata
    neg: /(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|energi|pikiran)[^.\n]{0,40}(malware|virus)|(malware|virus)[^.\n]{0,40}(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|pikiran)/i,
    x: ['(ransomware OR malware) -filter:replies'],
    th: ['ransomware', 'malware', 'bocor data'] },
  { id: 'serangan siber', local: true,
    pos: /(serangan siber|serangan cyber|peretasan|\bperetas\b|diretas|dibobol|kebocoran data|bocor data|pencurian data|(mencuri|curi|curian) data|\bddos\b|data breach|\bbssn\b|\bpdn\b|dieksploitasi|\bcve[- ]?\d{4}|kerentanan|vulnerabilit|backdoor|spyware|skimming|carding|cryptojack|deepfake|deface|defacement|phishing|\bphish|vishing|smishing|sextortion|botnet|\bzero[- ]day\b|\bn[- ]?day\b|infrastruktur kritis|apt\d{1,2}\b|\bc2\b|command and control|leak site|layanan lumpuh|situs lumpuh|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|insiden keamanan|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|investasi bodong|scam|penipuan online|pinjol ilegal|akun palsu|\bhacker\b|\bcve\b|dieksploitasi|di-?exploit(?:asi|kan)?|exploit\s+(?:celah|kerentanan|sistem|jaringan|server|akun|data|perangkat|zero[- ]day|vulnerabilit))/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hackathon|mbti|enneagram)/i,
    x: ['("serangan siber" OR peretasan OR diretas OR "kebocoran data" OR BSSN OR DDoS OR exploit OR phishing OR ransomware OR deepfake) -filter:replies'],
    th: ['serangan siber', 'kebocoran data', 'ransomware', 'phishing', 'exploit', 'diretas', 'BSSN', 'peretasan', 'dibobol', 'ddos', 'deepfake', 'penipuan online', 'pinjol', 'investasi bodong', 'situs lumpuh', 'insiden keamanan', 'akun palsu'] },
  { id: 'akun dibajak', local: true,
    pos: /(akun[^.\n]{0,30}(dibajak|diretas|dibobol|di-?hack|kena hack|disusupi)|akun (instagram|facebook|whatsapp|telegram|twitter|\bx\b|tiktok)[^.\n]{0,25}(dibajak|diretas|dibobol|hack))/i,
    x: ['(akun (dibajak OR diretas OR dibobol OR "kena hack")) -filter:replies'],
    th: ['akun dibajak', 'akun diretas', 'akun dibobol'] },
  { id: 'mbg', local: true,
    pos: /\bmbg\b|makan bergizi gratis|makan gratis|program makan gratis|gizi gratis|makan siang gratis|\bsppg\b|badan gizi nasional|\bbgn\b|keracunan mbg/i,
    // "mbg" telanjang sering Mbappé / "my bini gue"; "bgn" = singkatan "bagaimana".
    // Program MBG wajib konteks gizi/makanan — istilah yang sudah spesifik bypass via strong.
    strong: /(makan bergizi gratis|makan gratis|program makan gratis|gizi gratis|makan siang gratis|\bsppg\b|badan gizi nasional|keracunan mbg)/i,
    ctx: /(makan|bergizi|gizi|bgn|program|keracunan|gratis|balita|sekolah|kantin|siswa|mbg)/i,
    neg: /(resep|food ?vlog|foodreview|food review|cooking|memasak|review makanan|mbappe|real madrid|bundesliga|my bini)/i,   // konten kuliner/bola, bukan program
    x: ['("makan bergizi gratis" OR MBG OR SPPG OR "badan gizi nasional" OR BGN) -filter:replies'],
    th: ['makan bergizi gratis', 'MBG', '#makanbergizigratis'] },
  { id: 'bbm', local: true,
    pos: /\bbbmm?\b|bahan bakar (minyak|non ?subsidi|subsidi)|pertalite|pertamax|dexlite|biosolar|\bspbu\b|kelangkaan (bbm|minyak|solar)|antrean (spbu|bbm|minyak)|harga (bbm|minyak tanah)|harga minyak|subsidi energi|gas langka/i,
    neg: /(minyak (goreng|zaitun|wangi)|solar (panel|pembangkit)|bensin (romantis|story)|\bbbmm?\b[^.\n]{0,40}(bola|football|soccer|liga|premier league|manager|coach|lineup|formasi|gol\b|assist))/i,
    x: ['(BBM OR Pertalite OR Pertamax OR "harga BBM" OR SPBU OR "bahan bakar" OR "minyak tanah") -filter:replies'],
    th: ['BBM', 'harga BBM', 'Pertalite', 'SPBU', '#bbm'] },
  { id: 'pangan', local: true,
    pos: /(minyak goreng|harga (beras|telur|daging|cabai|gula|tepung|beras medium)|sembako|inflasi pangan|pangan (mahal|pasti)|stok (beras|pangan|sembako)|impor (beras|pangan|gula|tepung)|operasi pasar|bantuan pangan|beras oplosan|harga pangan|bawang merah|daging ayam)/i,
    neg: /(resep|menu masak|food ?vlog|kuliner|review (makanan|resto))/i,
    x: ['("minyak goreng" OR "harga beras" OR sembako OR "operasi pasar" OR "inflasi pangan" OR "harga telur" OR "harga daging") -filter:replies'],
    th: ['minyak goreng', 'harga beras', 'sembako', 'inflasi pangan', 'harga telur', 'harga daging', 'harga cabai', 'stok beras', 'impor beras', 'operasi pasar'] },
  { id: 'bansos', local: true,
    pos: /(bansos|bantuan sosial|bantuan langsung tunai|\bblt\b|\bpkh\b|\bbpnt\b|\bbsu\b|subsidi (listrik|gula|upah|pupuk)|rastra|kartu (sembako|prakerja|indonesia pintar)|program keluarga harapan|kemensos|\bdtks\b)/i,
    // "BLT" = bacon-lettuce-tomato & singkatan olahraga AS; akronim bansos wajib konteks program
    strong: /(bansos|bantuan sosial|bantuan langsung tunai|subsidi (listrik|gula|upah|pupuk)|rastra|kartu (sembako|prakerja|indonesia pintar)|program keluarga harapan|kemensos|\bdtks\b)/i,
    ctx: /(bansos|bantuan|pemerintah|kuota|cair|desember|regulasi|program|tunai|sosial|dtks|kemensos|penerima|kartu|subsidi|raskin|sembako|\bblt\b|\bpkh\b|\bbpnt\b|\bbsu\b)/i,
    neg: /(film|sinema|sinetron|nonton)/i,
    x: ['(bansos OR "bantuan sosial" OR PKH OR BPNT OR BSU OR BLT OR "subsidi listrik" OR "kartu prakerja") -filter:replies'],
    th: ['bansos', 'bantuan sosial', 'PKH', 'BSU', 'subsidi listrik', 'BLT', 'BPNT', 'rastra', 'kartu sembako', 'kartu prakerja'] },
  { id: 'hukum', local: true,
    pos: /(rkuhap|rkuhp|\bkuhp\b|\bkuhap\b|tipikor|korupsi|gratifikasi|suap|penyuapan|pengadilan|putusan (pengadilan|hakim)|kasasi|\bdiversi\b|kejaksaan|upacara hukuman mati|eksekusi (hukuman|mati)|rehabilitasi narkotika)/i,
    neg: /(film|sinema|sinetron|sinetrik|trailer|nonton|netflix)/i,
    x: ['(RKUHAP OR RKUHP OR KUHP OR KUHAP OR tipikor OR korupsi OR KPK OR kejaksaan OR "putusan pengadilan") -filter:replies'],
    th: ['RKUHAP', 'tipikor', 'korupsi', 'KPK', 'RKUHP', 'KUHP', 'KUHAP', 'pengadilan', 'kasasi', 'suap', 'kejaksaan'] },
  { id: 'olahraga', local: true,
    // hanya ejaan/istilah Indonesia — "premier league"/"nba" dsb bukan konten lokal
    // dan pernah menarik feed bola Inggris (Arsenal, Konsa, dll)
    pos: /(timnas|timnas (indonesia|putri|putra)|bulu tangkis|badminton|piala aff|sea games|olimpiade|panjat tebing|panjat speed|liga 1|liga 2|piala presiden|kontingen indonesia|asiad|aff cup|volleyball indonesia|timnas basket|timnas bola voli|ganda (putra|putri|campuran)|tunggal (putra|putri)|bulutangkis|atletik)/i,
    neg: /(film|trailer|nonton|netflix|sinetron|sinetrik|genshin|pubg|mobile legends|free ?fire|honkai|zenless|valorant|premier league|la liga|serie a|bundesliga|champions league|nba|nfl|mlb)/i,
    x: ['(timnas OR bulu tangkis OR badminton OR "piala AFF" OR "sea games" OR "liga 1" OR "panjat tebing") -filter:replies'],
    th: ['timnas', 'bulu tangkis', 'piala AFF', 'sea games', 'liga 1'] },
  { id: 'transport', local: true,
    pos: /(kereta api|\bkai\b|delay (penerbangan|pesawat|kereta)|penerbangan (delay|dibatalkan|batal landas)|tiket (pesawat|kereta|kapal)|\bdermaga\b|kapal feri|\bferry\b|mudik|batal mudik|tol (macet|boleh|putus|buntu|lalu lintas)|jalan tol|busway|transjakarta|\bmrt\b|\blrt\b|\bkrl\b|angkot|ojol|gojek|grabfood|\bgrab\s*(?:car|bike|food|motor|ride|dana|share|express)\b|taxi online|kecelakaan (kereta|bus|truk)|bandara)/i,
    // nama moda telanjang (lrt/krl/mrt/kai/angkot/ojol) terlalu ambigu: LRT = grup K-pop,
    // KRL = slang Portugis, MRT = listing Malaysia, KAI = Kai Havertz / jasa tiket.
    // Wajib anchor transit/insiden; frasa yang sudah spesifik bypass via strong.
    strong: /(kereta api|tiket (pesawat|kereta|kapal)|delay (penerbangan|pesawat|kereta)|penerbangan (delay|dibatalkan|batal landas)|kapal (feri|tenggelam|karam)|\bdermaga\b|\bferry\b|busway|transjakarta|jalan tol|tol (macet|boleh|putus|buntu|lalu lintas)|mudik|batal mudik|taxi online|kecelakaan (kereta|bus|truk))/i,
    ctx: /(jakarta|jabodetabek|indonesia|stasiun|bandara|terminal|pelabuhan|dermaga|mudik|pulang kampung|penumpang|tiket|tol|busway|transjakarta|kereta api|commuter line|delay|batal landas|angkutan umum|ojek online|angkot umum|penerbangan|pesawat|kapal|ferry|macet|gangguan|kerusakan|dibatalkan|kecelakaan|tabrakan|kembali normal|operasional|naik|turun|perjalanan)/i,
    neg: /(judi|togel|slot online|gacor|prediksi)/i,
    x: ['(kereta api OR "delay penerbangan" OR "penerbangan dibatalkan" OR "jalan tol" OR mudik OR ojol OR TransJakarta OR MRT OR KRL OR angkot OR LRT OR "kapal feri" OR "batal mudik" OR dermaga OR "tol macet") -filter:replies'],
    th: ['kereta api', 'delay penerbangan', 'jalan tol', 'mudik', 'ojol', 'TransJakarta', 'MRT', 'KRL', 'LRT', 'angkot', 'penerbangan dibatalkan', 'tol macet', 'kapal feri', 'batal mudik', 'dermaga'] },
  { id: 'pendidikan', local: true,
    pos: /(ukt|biaya kuliah tunggal|beasiswa (dipotong|batal|ditolak|gelombang)|guru (honorer|pppk)|keracunan (kantin|sekolah|siswa|mahasiswa|mbg|massal)|murid (pingsan|tenggelam|meninggal|kecelakaan)|siswa (pingsan|tenggelam|meninggal|keracunan|kecelakaan)|mahasiswa (pingsan|tenggelam|meninggal|keracunan|\bdemo\b|unjuk rasa|demonstrasi)|sekolah (kebakaran|longsor|ambruk|ditutup|runtuh|tenggelam)|kampus (kebakaran|longsor|ambruk)|snbt|sbmptn|kurikulum merdeka|\bpppk\b|\bcpns\b|\bcasn\b|\bspp\b|lpdp|kip kuliah|sekolah gratis)/i,
    neg: /(film|sinema|sinetron|nonton|netflix)/i,
    x: ['(UKT OR "biaya kuliah" OR "guru honorer" OR "siswa pingsan" OR "keracunan sekolah" OR "sekolah kebakaran" OR beasiswa OR SNBT OR "guru PPPK") -filter:replies'],
    th: ['UKT', 'biaya kuliah', 'guru honorer', 'siswa pingsan', 'keracunan sekolah', 'beasiswa', 'SNBT', 'SBMPTN', 'kurikulum merdeka', 'guru PPPK', 'sekolah ambruk', 'sekolah longsor', 'beasiswa dipotong'] }
];
for (const t of SOC_TOPICS) t.adhoc = false;

/* ---------- klasifikasi: teks -> topics[] ---------- */
const ASSESS = require('./assessment');
// eventType dikoreksi di lapisan ini (eventType inti milik assessment.js):
//  - insiden: 'maritime_accident' hanya kalau span memang konteks laut/kapal;
//    tenggelam/hanyut generik (kolam, got, anak) -> 'kecelakaan' supaya bisa
//    korelasikan dengan event topik kecelakaan.
//  - kecelakaan + konteks laut -> 'maritime_accident' (menyamakan dgn insiden,
//    jadi "kapal tenggelam" dari dua topik bisa corroborate).
//  - wabah -> type 'health_incident' + category 'kesehatan' (menyamakan dgn
//    topik kesehatan; sebelumnya category null jadi event-nya tak pernah
//    bisa masuk grup sinyal).
const SOC_SEA_RE = /(kapal|laut|selat|ombak|nelayan|feri|perahu|sungai|perairan|samudra|ocean|boat|ship|tpi|dermaga)/i;
function socFixEvents(res) {
  for (const f of res.findings || []) {
    const ev = f.evidence || '';
    if (f.topic === 'insiden' && f.type === 'maritime_accident' && !SOC_SEA_RE.test(ev)) f.type = 'kecelakaan';
    else if (f.topic === 'kecelakaan' && /tenggelam|karam|hanyut/i.test(ev) && SOC_SEA_RE.test(ev)) f.type = 'maritime_accident';
    else if (f.topic === 'wabah') { f.type = 'health_incident'; if (!f.category) f.category = 'kesehatan'; }
  }
  return res;
}
// Post-level motorsport gate: neg regex di topik kecelakaan hanya per-klausa —
// laporan balap multi-kalimat ("Rafa mengalami kecelakaan. Safety car keluar.")
// tetap lolos. >=2 marker balap berbeda di SELURUH teks -> buang topik
// kecelakaan dari registry untuk post ini.
const SOC_MOTOR_MARK_RE = /grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s+ferme|safety\s*car|safetycar|red\s+flag|bendera\s+(?:merah|kuning)|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s*zone|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup)/gi;
function socIsMotorsport(t) {
  const m = String(t || '').matchAll(SOC_MOTOR_MARK_RE);
  return new Set([...m].map(x => x[0].toLowerCase())).size >= 2;
}
function socAssess(text, extra) {
  const t = String(text || '');
  const listing = SOC_LISTING_RE.test(t) && SOC_LISTING_DEAL.test(t);
  const topics = socIsMotorsport(t) ? SOC_TOPICS.filter(tp => tp.id !== 'kecelakaan') : SOC_TOPICS;
  return socFixEvents(ASSESS.assess(t, topics.concat(extra || []), { noise: SOC_NOISE_RE, spam: SOC_SPAM_RE, listing }));
}
function socTopics(text, extra) { return socAssess(text, extra).topics; }

/* topik ad-hoc dari judul berita (nama kasus yang lagi naik) */
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function socAdhoc(phrases) {
  return (phrases || []).map(ph => String(ph || '').replace(/["'\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2).map(ph => ({
    id: ph.toLowerCase(), adhoc: true, local: true,
    pos: new RegExp('\\b' + escRe(ph).replace(/\s+/g, '\\s+') + '\\b', 'i'),
    x: ['"' + ph + '" -filter:replies'], th: [ph]
  }));
}

/* ---------- post yang layak (buang balasan obrolan) ---------- */
function socKeepX(p) {
  if (/^\s*@\w+/.test(p.text || '') && (p.likes || 0) < 10) return false;      // reply chatter
  return true;
}
function socKeepTh(p) {
  // reply tanpa engagement dibuang — kecuali ia match topik (tag() sudah jalan
  // lebih dulu dan mengisi p.topics), karena Threads itu reply-heavy
  if (p.is_reply && (p.like_count || 0) < 5 && !(p.topics || []).length) return false;
  return true;
}

/* ---------- balancer: satu topik / satu akun nggak boleh makan buffer ---------- */
// Dua pass: post prioritas (assessment.signalEligible atau reportType 'reported')
// klaim budget topik/akun DULU, baru komentar biasa ngikutin cap yang sama.
// Cap global per user (~10/24h) hanya berlaku untuk non-signalEligible.
function socBalance(arr, max, userOf, perTopic = 0.22, perUser = 3, userCap = 10) {
  if (!(max > 0)) return [];
  const capT = Math.max(8, Math.ceil(max * perTopic)), tc = Object.create(null), uc = Object.create(null), ug = Object.create(null), out = [];
  const isSig = p => !!(p && p.assessment && p.assessment.signalEligible === true);
  const isRep = p => isSig(p) || !!(p && p.assessment && p.assessment.reportType === 'reported');
  for (const want of [isRep, p => !isRep(p)]) {
    for (const p of arr) {
      if (!want(p)) continue;
      const tps = [...new Set(p.topics || [])], u = String(userOf(p) || '?').toLowerCase();
      if (!tps.length || tps.some(t => (tc[t] || 0) >= capT || (uc[u + '|' + t] || 0) >= perUser)) continue;
      if (!isSig(p) && userCap > 0 && (ug[u] || 0) >= userCap) continue;
      for (const t of tps) { tc[t] = (tc[t] || 0) + 1; uc[u + '|' + t] = (uc[u + '|' + t] || 0) + 1; }
      if (!isSig(p)) ug[u] = (ug[u] || 0) + 1;
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/* ---------- query list datar buat fetch: [{t, q}] ---------- */
function socQueries(kind, extra) {
  const out = [];
  for (const tp of extra && extra.length ? SOC_TOPICS.concat(extra) : SOC_TOPICS)
    for (const q of tp[kind] || []) out.push({ t: tp.id, q });
  return out;
}

/* ---------- statistik + trending dari sosial itu sendiri ---------- */
// posts: [{topics, platform:'x'|'th', user, ts}]
function socHot(posts, now = Date.now()) {
  const W = 90 * 60e3, B = 24 * 3600e3, windows = Math.ceil(B / W);
  const st = Object.create(null);
  for (const p of posts) {
    const age = now - p.ts;
    if (!Number.isFinite(p.ts) || p.ts <= 0 || age < 0 || age > B || !['x', 'th'].includes(p.platform)) continue;
    const author = String(p.user || '').toLowerCase().replace(/^@/, '');
    for (const t of new Set(p.topics || [])) {
      const e = st[t] || (st[t] = { x: 0, th: 0, rx: new Set(), rt: new Set(), buckets: new Map() });
      e[p.platform]++;
      if (!author) continue;
      if (age < W) (p.platform === 'x' ? e.rx : e.rt).add(author);
      else {
        const bucket = Math.floor(age / W), users = e.buckets.get(bucket) || new Set();
        users.add(p.platform + ':' + author); e.buckets.set(bucket, users);
      }
    }
  }
  const stats = {}, hot = [];
  for (const [t, e] of Object.entries(st)) {
    stats[t] = { x: e.x, th: e.th };
    const users = e.rx.size + e.rt.size;
    // Unique platform accounts in equally sized windows, not posts versus users.
    const baseRate = [...e.buckets.values()].reduce((n, s) => n + s.size, 0) / (windows - 1);
    const both = e.rx.size > 0 && e.rt.size > 0;
    if (users < 3) continue;
    const score = users / (1 + baseRate);
    hot.push({ id: t, users, both, score: +score.toFixed(2), coverage: 'sampled', unit: 'platform_accounts' });
  }
  hot.sort((a, b) => b.score - a.score);
  return { stats, hot: hot.slice(0, 6) };
}

/* ---------- social-first intel: frasa naik + keyword mining ---------- */
// Stopword lokal (subset TSTOP/TBLK server.js + dasar EN): dipakai bersama
// socPhraseScan & socKeywordMine supaya dua-duanya konsisten.
const SOC_TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri detik cnn tempo liputan6 republika tribun cnbc antara jawapos okezone kumparan suara merdeka sindonews jpnn tvri inews media news kompas viva metrotvnews rmol infopublik jabarprov korankaltim tvone merahputih poskota beritasatu gridoto wowkeren bola bolaoverza mediaindonesia faktualnews berita foto video gallery wawancara investigasi khusus daerah nasional internasional ekonomi hiburan selebriti olahraga dishub cumplik the and for with that this from have has are was were will would can could should not but all any more than then when what which who how its our your their his her').split(' '));
// author post history: user/handle/username -> lowercase tanpa '@' (ala histUser)
const socAuthor = p => String((p && (p.user || p.handle || p.username)) || '').toLowerCase().replace(/^@/, '');
const socInWin = (p, now, windowMs) => {
  const ts = p && p.ts, age = now - ts;
  return Number.isFinite(ts) && ts > 0 && age > 0 && age <= windowMs;
};
// bersihin teks sebelum ekstraksi: URL & mention (@handle) jangan sampai
// jadi kandidat frasa/term — @DetikCom yang di-mention banyak orang bakal
// selalu menang sort users. Pola sama dengan astroturfSig/socNonLatin.
const socClean = t => String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
// frasa kapital multi-kata — pola persis trendingQueries di server.js
const SOC_PHRASE_RE = /[A-Z][A-Za-z'&]{2,}(?:\s+(?:[A-Z][A-Za-z'&]{2,}|[A-Z]{2,8})){0,3}/g;
const SOC_TAG_RE = /#([\p{L}\p{N}_]+)/gu;
// Frasa yang lagi ramai di sosial, independen dari registry topik.
// Kandidat: sekuens kapital 2-4 kata + hashtag. Skor = unique author,
// tie-break total mention. exclude = Set id topik (registry + adhoc).
function socPhraseScan(posts, { now = Date.now(), windowMs = 3 * 3600e3, minUsers = 3, exclude = null, max = 8 } = {}) {
  const excl = exclude ? new Set(exclude instanceof Set ? [...exclude] : exclude) : null;
  const ok = (id, multi) => {
    if (id.length < 4 || id.length > 42) return false;
    if (!/[\p{L}]/u.test(id)) return false;   // hashtag murni digit (#2025) bukan frasa
    const words = id.split(' ');
    if (multi && words.length < 2) return false;
    if (words.some(w => w.length < 3 || SOC_TSTOP.has(w))) return false;
    if (SOC_FOREIGN_RE.test(id)) return false;
    if (excl) for (const t of excl) {
      const tl = String(t).toLowerCase();
      if (id === tl || id.includes(tl) || tl.includes(id)) return false;
    }
    return true;
  };
  const scores = new Map();   // id -> {ph, users:Set, n}
  for (const p of posts || []) {
    if (!socInWin(p, now, windowMs)) continue;
    const text = socClean(p.text);
    if (!text.trim()) continue;
    const author = socAuthor(p);
    const found = new Map();   // id -> ph (asli berkaps); dedupe per post
    for (const m of text.matchAll(SOC_PHRASE_RE)) {
      const words = m[0].trim().split(/\s+/);
      // fragmentasi: match 3-4 kata juga nyumbang sub-frasa kontigu >=2 kata,
      // jadi "Banjir Jakarta Raya" & "Banjir Jakarta Pusat" tetap ngumpul
      // di "banjir jakarta". Murah: match maks 4 kata -> <=6 window.
      for (let len = words.length; len >= 2; len--)
        for (let s = 0; s + len <= words.length; s++) {
          const ph = words.slice(s, s + len).join(' ');
          const id = ph.toLowerCase();
          if (ok(id, true) && !found.has(id)) found.set(id, ph);
        }
    }
    for (const m of text.matchAll(SOC_TAG_RE)) {
      const id = m[1].toLowerCase().replace(/_+/g, ' ').trim();
      if (ok(id, false) && !found.has(id)) found.set(id, id);
    }
    for (const [id, ph] of found) {
      const e = scores.get(id) || (scores.set(id, { ph, users: new Set(), n: 0 }), scores.get(id));
      if (author) e.users.add(author);
      e.n++;
    }
  }
  return [...scores.entries()]
    .filter(([, e]) => e.users.size >= minUsers)
    .sort((a, b) => (b[1].users.size - a[1].users.size) || (b[1].n - a[1].n))
    .slice(0, max)
    .map(([id, e]) => ({ ph: e.ph, id, users: e.users.size, n: e.n }));
}
// token kandidat buat keyword mining: alfabet murni >=4 huruf
const SOC_KW_RE = /[a-z][a-z'-]{3,}/g;
// Ekspansi query otomatis: istilah yang sering ditulis poster topik tapi
// belum ada di query th/x topik itu. df = document frequency (post unik).
function socKeywordMine(posts, topicId, { now = Date.now(), windowMs = 6 * 3600e3, maxTerms = 8 } = {}) {
  const id = String(topicId || '').toLowerCase();
  const topic = SOC_TOPICS.find(t => t.id === id);
  if (!topic) return [];
  const hay = (topic.th || []).concat(topic.x || []).join(' ').toLowerCase();
  const df = new Map();
  let scanned = 0;
  for (const p of posts || []) {
    if (scanned >= 400) break;   // cap scan biar post history gede nggak berat
    if (!socInWin(p, now, windowMs)) continue;
    const tps = (p.topics || []).map(t => String(t).toLowerCase());
    if (!tps.includes(id) && String(p.q || '').toLowerCase() !== id) continue;
    scanned++;
    const text = socClean(p.text);
    if (socHashJunk(text) || socNonLatin(text) || socVi(text)) continue;
    const seen = new Set();
    for (const m of text.toLowerCase().matchAll(SOC_KW_RE)) {
      const term = m[0].replace(/^['-]+|['-]+$/g, '');
      if (term.length < 4 || seen.has(term)) continue;
      if (SOC_TSTOP.has(term) || SOC_FOREIGN_RE.test(term)) continue;
      if (hay.includes(term)) continue;   // sudah tercakup query topik
      seen.add(term);
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const need = Math.max(3, Math.ceil(scanned * 0.01));
  return [...df.entries()]
    .filter(([, n]) => n >= need)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, dfN]) => ({ term, df: dfN }));
}

// patch bump di atas VERSION assessment.js: registry/klasifikasi di file ini berubah
const SOC_CLASSIFIER_VERSION = ASSESS.VERSION;
module.exports = { CLASSIFIER_VERSION: SOC_CLASSIFIER_VERSION, SOC_TOPICS, socAssess, socTopics, socAdhoc, socKeepX, socKeepTh, socBalance, socQueries, socHot, socNonLatin, socVi, socHashJunk, astroturfSig, socForeignLang, socPhraseScan, socKeywordMine, SOC_FOREIGN_RE, SOC_LOCAL_RE, SOC_LISTING_RE, SOC_LISTING_DEAL };
