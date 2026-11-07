'use strict';
/* ============================================================
   SOCIAL TOPIC REGISTRY — satu sumber kebenaran buat X + Threads.
   - Chip, query fetch, dan klasifikasi post semua turun dari SOC_TOPICS.
   - Tiap post diklasifikasi SEKALI di server ke topics[] (bukan "query yang kebetulan nemu").
   - Pure module: tanpa I/O, bisa dites offline.
   ============================================================ */

// metafora / idiom: "kebakaran jenggot", "banjir orderan", dst. Post begini bukan kejadian.
const SOC_NOISE_RE = /(kebakaran jenggot|banjir (order|orderan|diskon|promo|pujian|notif|notifikasi|air mata|komen|komentar|dm|like|followers?|rezeki|cuan|berkah|hadiah|bonus|kado|tawaran|pesanan|chat|ucapan)|(hati|dada|semangat|jiwa|emosi|cemburu|amarah)[^.\n]{0,12}terbakar|terbakar (semangat|emosi|cemburu|amarah|api asmara|rindu)|tenggelam dalam|hanyut dalam|terjun (bebas )?(ke dunia|ke politik|payung)|gempa (hati|rasa|jantung)|meledak(-ledak)? (emosi|tawa|tangis))/i;

// spam/farming/phishing: engagement-bait & jualan, bukan konten kejadian.
// pola: "Vote for X", rantai "Follow A. Follow B.", "DM untuk order", "link di bio", hashtag stuffing.
const SOC_SPAM_RE = /(vote for|follow\s+[\w.@-]+\s*[+.&]?\s*follow|like\s*(dan|&|\+)\s*(follow|rt)|rt\s*(dan|&|\+)\s*follow|dm\s+(untuk|di|ke)\s*(order|harga|promo|info|respon|detail|ticket|tiket)|link\s+(di|ada di)\s+bio|cek\s+(link\s+)?di\s+bio|order\s+(via|melalui|di)\s+(wa|dm|wa\.me))/i;
const socHashCount = t => (String(t).match(/#[\p{L}\p{N}_]+/gu) || []).length;
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
// kepadatan hashtag: spam kampanye/crypto numpuk tag; rasio karakter tag vs total teks
function socHashJunk(t) {
  const s = String(t || '');
  const tags = s.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (tags.length > 10) return true;
  const chars = tags.reduce((n, h) => n + h.length, 0);
  return s.length > 60 && chars / s.length > 0.4;
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
const SOC_FOREIGN_RE = /\b(amerika|texas|california|new york|brasil|brazil|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|perancis|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza|turki|meksiko|kanada|nigeria|afrika|trump)\b/i;
const SOC_LOCAL_RE = /(indonesia|\bwni\b|jakarta|jabar|jateng|jatim|jawa|sumatera|sumatra|kalimantan|sulawesi|papua|bali\b|aceh|riau|banten|bekasi|bogor|depok|tangerang|bandung|surabaya|medan|makassar|semarang|yogya|bpbd|bnpb|bmkg|polres|polda|polsek|kodim|damkar|pemkot|pemkab|kabupaten|provinsi|prabowo|gibran|\bdpr\b|dprd|kapolri|polri)/i;

const SOC_TOPICS = [
  { id: 'demo', local: true,
    pos: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|\bdemo\b|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day)/i,
    strong: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day)/i,   // tanpa ini, kata "demo" polos butuh konteks
    ctx: /(tuntut|tolak|mahasiswa|\bbem\b|buruh|ojol|\bdpr\b|dprd|gedung|polisi|aparat|gas air mata|\baksi\b|\bmassa\b|orasi|turun ke jalan|spanduk|ricuh|bentrok|rusuh|ditangkap|diamankan|bubarkan|barikade|molotov|water cannon|kapolda|kapolres|reformasi|pemerintah|istana|patung kuda|march|aksi damai|long march)/i,
    neg: /(demo (lagu|musik|reel|reels|app|apps|aplikasi|akun|produk|plane|game|beat|tape|masak|memasak|cooking|vokal|record|rekaman|day|link|version|ui|web|website|bot|trading)|free demo|live demo|cooking demo|demonstrasi (produk|alat|masak|memasak|fitur)|\bdemo\b.{0,20}#(music|musik|beat))/i,
    x: ['(unjuk rasa OR demonstrasi OR "aksi massa" OR demonstran) -filter:replies',
        'demo (mahasiswa OR buruh OR ojol OR DPR OR tuntutan OR ricuh OR polisi) -filter:replies'],
    th: ['unjuk rasa', 'demo mahasiswa', '#unjukrasa'] },
  { id: 'kebakaran', local: true,
    pos: /(kebakaran|terbakar|kobaran api|si jago merah|dilalap api|ludes dilalap)/i,
    neg: /(kebakaran (hutan|lahan)|karhutla|kebakaran (harga|promo|diskon|obral|sale|murah|gila|meriah|jagoan|gaib|mangling|total)|harga (kebakaran|panas|terbakar))/i,   // hutan/lahan masuk topik sendiri; "kebakaran harga" = slang sale
    x: ['(kebakaran OR "si jago merah" OR "ludes terbakar" OR damkar) -filter:replies'],
    th: ['kebakaran', '#kebakaran', 'kebakaran hari ini'] },
  { id: 'karhutla', local: true,
    pos: /(karhutla|kebakaran (hutan|lahan)|titik panas|hotspot|kabut asap)/i,
    // "titik panas" juga dipakai wabah/kesehatan — wajib konteks kebakaran lahan
    strong: /(karhutla|kebakaran (hutan|lahan)|kabut asap)/i,
    ctx: /(hutan|lahan|karhutla|asap|kebakaran|riau|sumatera|kalimantan|papua|jambi|sumsel)/i,
    x: ['(karhutla OR "kebakaran hutan" OR "kebakaran lahan" OR "kabut asap") -filter:replies'],
    th: ['karhutla', 'kabut asap', '#karhutla'] },
  { id: 'banjir', local: true,
    pos: /(banjir|longsor|tanggul jebol|air meluap|genangan)/i,
    x: ['(banjir OR longsor OR "banjir bandang" OR "tanggul jebol") -filter:replies'],
    th: ['banjir', '#banjir', 'banjir bandang'] },
  { id: 'gempa', local: true,
    pos: /(gempa|tsunami|magnitudo|erupsi|letusan gunung)/i,
    // "tsunami" sendirian sering kiasan: "blue/blauwe tsunami" = gerakan protes politik,
    // tsunami finance/sport — wajib konteks seismik atau lokasi bencana
    neg: /(blue|blauwe)\s+tsunami|tsunami\s+(biru|politik|protes)/i,
    strong: /(gempa|magnitudo|erupsi|letusan)/i,
    ctx: /(gempa|earthquake|megathrust|gelombang pasang|air bah|pesisir|tepi laut|palung|bmkg|bnpb|bpbd|tsunami warning|peringatan(?: dini)? tsunami|tsunami (?:menerjang|melanda|menghantam) (?:pantai|pesisir))/i,
    x: ['(gempa OR tsunami OR magnitudo OR erupsi) -filter:replies'],
    th: ['gempa', 'gempa bumi', '#gempa'] },
  { id: 'kecelakaan', local: true,
    pos: /(kecelakaan|tabrakan|tabrak lari|kapal (tenggelam|karam)|pesawat jatuh|bus terguling|truk terguling|kereta anjlok|ledakan)/i,
    // "ledakan"/"tabrakan" sering kiasan: ledakan penduduk, tabrakan pendapat
    neg: /(ledakan (penduduk|jumlah|kasus|order|orders|promo|penjualan|chat|emoji|tawa|tangis|debat|lagu|musik|harga|bonus|like|komentar|followers?|data|traffic|trafik)|tabrakan (pendapat|argumen|prinsip|debat|pemikiran))/i,
    x: ['(kecelakaan OR "tabrak lari" OR "bus terguling" OR "kapal tenggelam" OR ledakan) -filter:replies'],
    th: ['kecelakaan', 'kecelakaan lalu lintas'] },
  { id: 'penembakan', local: true,
    pos: /(penembakan|ditembak|baku tembak|tertembak)/i,
    neg: /(ditembak (hati|cinta|asmara|batin|panah|tatapan))/i,   // kiasan asmara/cinta
    x: ['(penembakan OR ditembak OR "baku tembak") -filter:replies'],
    th: ['penembakan', 'ditembak'] },
  { id: 'pencurian', local: true,
    pos: /(pencurian|curanmor|begal|perampokan|jambret|dirampok|kemalingan)/i,
    x: ['(pencurian OR curanmor OR begal OR perampokan OR jambret) -filter:replies'],
    th: ['pencurian', 'curanmor', 'begal'] },
  { id: 'penangkapan', local: true,
    pos: /(penangkapan|ditangkap|diamankan|\bott\b)/i,
    ctx: /(polisi|polres|polda|polsek|\bkpk\b|kejaksaan|\bbnn\b|densus|petugas|aparat|tersangka|pelaku|buron)/i,
    x: ['(penangkapan OR ditangkap OR OTT) (polisi OR KPK OR Densus OR tersangka) -filter:replies'],
    th: ['penangkapan', 'ditangkap polisi'] },
  { id: 'phk',
    pos: /(\bphk\b|pemutusan hubungan kerja|dirumahkan|pabrik tutup)/i,
    x: ['(PHK OR "pemutusan hubungan kerja" OR dirumahkan OR "pabrik tutup") -filter:replies'],
    th: ['PHK', 'pemutusan hubungan kerja'] },
  { id: 'rupiah',
    pos: /(rupiah|kurs dolar|kurs dollar|nilai tukar)/i,
    x: ['(rupiah OR "kurs dolar" OR "nilai tukar") -filter:replies'],
    th: ['rupiah', 'kurs dollar', 'dollar naik'] },
  { id: 'ihsg',
    pos: /(\bihsg\b|trading halt|bursa efek|\bidx\b)/i,
    x: ['(IHSG OR "trading halt" OR "bursa efek") -filter:replies'],
    th: ['IHSG', 'bursa efek', 'trading halt'] },
  { id: 'listrik padam',
    pos: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|blackout|byarpet)/i,
    // "blackout" sendirian terlalu longgar: dipakai kampanye K-pop (#Blackoutforboom),
    // EDM, dan spam tiket — wajib konteks utilitas/Indonesia
    strong: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|byarpet)/i,
    ctx: /(listrik|pln|pemadaman listrik|padam listrik|mati listrik)/i,
    x: ['("listrik padam" OR "mati listrik" OR "pemadaman listrik" OR blackout) -filter:replies'],
    th: ['listrik padam', 'mati listrik', 'PLN padam'] },
  { id: 'wabah',
    pos: /(wabah|\bklb\b|kejadian luar biasa|keracunan (massal|makanan|mbg)|kasus (dbd|campak|difteri|kolera|covid|flu burung))/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood)/i,
    x: ['(wabah OR "keracunan massal" OR "keracunan makanan" OR KLB OR "kasus DBD") -filter:replies'],
    th: ['wabah', 'keracunan massal', 'demam berdarah', 'DBD'] },
  { id: 'pemilu', local: true,
    pos: /(pemilu|pilkada|pilpres|\bkpu\b|bawaslu)/i,
    x: ['(pemilu OR pilkada OR pilpres OR KPU OR Bawaslu) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', '#pilkada2026'] },
  { id: 'politik', local: true,
    pos: /(partai politik|caleg|capil|daftar caleg|\bdpr\b|\bdprd\b|parlemen|fraksi|koalisi|oposisi|kabinet|reshuffle|\bmenteri\b|wakil (presiden|menteri)|\bistana\b|senayan|menko|kadin|\bgubernur\b|\bbupati\b|wali kota|\bpilkada\b|\bpilgub\b|\bpilbup\b|\bpilgici\b|\bkpud\b|impeachment|majelis kehormatan|sidang mk)/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hakase|kpop|k-pop|\bdpr\b[^.\n]{0,15}(cream|artic|live|concert|fan|bias|music|song|album|stage)|dpr (cream|artic))/i,
    x: ['(pemilu OR pilkada OR pilpres OR "partai politik" OR caleg OR DPR OR kabinet OR reshuffle OR menteri) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', 'DPR', 'kabinet', 'reshuffle'] },
  { id: 'konflik', local: true,
    pos: /(perang|konflik|invasi|aneksasi|pendudukan|gencatan senjata|ultimatum|kudeta|pemberontakan|separatis|genosida|blokade|embargo|sandera|pembajakan|pertempuran|darurat militer|darurat sipil|mobilisasi|milisi|paramiliter|peluru kendali|\brudal\b|\bdrone\b|\bdron\b|serangan udara|serangan rudal|\bbom\b|granat|artileri|\btni\b|\btentara\b|militer|perjanjian damai|perundingan damai)/i,
    // "perang harga" = sale; "konflik batin/rumah tangga" = personal; "bom waktu/saraf" = bukan senjata
    neg: /(perang harga|konflik (batin|psikologis|rumah tangga|hukum|personal)|bom (waktu|tank|mobil|rakit|dekat|saraf)|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|dirgahayu|kami (akan |sedang )?melaksanakan|wajib hijrah|jauhi yang kafir|khalifahah)/i,
    x: ['(perang OR "gencatan senjata" OR ultimatum OR invasi OR aneksasi OR kudeta OR "perjanjian damai" OR "darurat militer") -filter:replies'],
    th: ['perang', 'konflik', 'gencatan senjata', 'invasi', 'kudeta', 'serangan udara'] },
  { id: 'insiden', local: true,
    pos: /(ambruk|runtuh|pohon tumbang|tenggelam|kapal karam|kapal tenggelam|hanyut|tergelincir|jatuh dari gedung)/i,
    x: ['(ambruk OR runtuh OR "pohon tumbang" OR tenggelam OR karam) -filter:replies'],
    th: ['ambruk', 'kapal tenggelam', 'runtuh', 'tenggelam'] },
  { id: 'kriminal', local: true,
    pos: /(pembunuhan|dibunuh|pengeroyokan|dikeroyok|begal|\bcurat\b|perampokan|dirampok|terorisme|narkoba|penculikan|perkosaan|rudapaksa)/i,
    x: ['(pembunuhan OR pengeroyokan OR begal OR perampokan OR penculikan OR narkoba) -filter:replies'],
    th: ['pembunuhan', 'begal', 'pengeroyokan', 'perampokan'] },
  { id: 'kesehatan', local: true,
    pos: /(demam berdarah|\bdbd\b|\bdhf\b|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|kolera|rabies|gila anjing|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|rotavirus|flu burung|h1n1|malaria|wabah|\bklb\b|kejadian luar biasa|gagal ginjal|stunting|vaksin|imunisasi)/i,
    // DBD = Dead by Daylight (game) sangat ramai di X — "main DBD", "DBD match/rank/chapter" bukan demam berdarah.
    // "TBC" = to be confirmed di posting hasil laga: "FINAL | X 1 Y 0 TBC", "we exit the cup" — bukan tuberkulosis.
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood|dead by daylight|main\s+dbd|play\s+dbd|dbd[^.\n]{0,30}(match|rank|chapter|killer|survivor|lag|server|mobile|skin|update|repair|macro|rivals|phasmo|twitch|stream|queue|gaming|lobby|game|main|play|take on|grinding|leveling)|deadbydaylight|dead[- ]by[- ]daylight|\b(?:el|la|del|al)\s+dbd\b|\bwe\s+(?:exit|advance|progress|through|win|drew|lost|booked|qualified)\b[^.\n]{0,50}\b(?:cup|final|match|game|tie|round|knockout|semi|qf|sf|league)\b|\b(?:man|player|goal|motm)\s+of\s+the\s+match\b|\bsafe trip home\b|\b(?:full[- ]?time|ft)\s*(?:result|score|whistle|report)\b)/i,
    // "TBC" telanjang di X = "to be confirmed" (hasil laga) — dipisah ke query lang:id
    x: ['("demam berdarah" OR DBD OR COVID OR influenza OR campak OR "tangan kaki mulut" OR leptospirosis OR rabies OR kolera OR mpox OR polio OR "gagal ginjal" OR KLB OR wabah OR imunisasi OR vaksin) -filter:replies',
        'lang:id (TBC OR tuberkulosis OR "TBC paru") -filter:replies'],
    th: ['demam berdarah', 'wabah', 'TBC', 'influenza', 'keracunan massal', 'gagal ginjal', 'vaksin', 'imunisasi'] },
  { id: 'ransomware', local: true,
    pos: /(ransomware|malware)/i,
    // "malware" dipakai kiasan ("humans were malware infected") dan disebut dalam daftar kejahatan
    // artikel regulasi — wajib konteks insiden siber nyata
    neg: /(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|energi|pikiran)[^.\n]{0,40}(malware|virus)|(malware|virus)[^.\n]{0,40}(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|pikiran)/i,
    x: ['(ransomware OR malware) -filter:replies'],
    th: ['ransomware', 'malware', 'bocor data'] },
  { id: 'serangan siber', local: true,
    pos: /(serangan siber|serangan cyber|peretasan|\bperetas\b|diretas|dibobol|kebocoran data|bocor data|pencurian data|(mencuri|curi|curian) data|\bddos\b|data breach|\bbssn\b|\bpdn\b|exploit|dieksploitasi|\bcve[- ]?\d{4}|kerentanan|vulnerabilit|backdoor|spyware|skimming|carding|cryptojack|deepfake|deface|defacement|phishing|\bphish|vishing|smishing|sextortion|botnet|\bzero[- ]day\b|\bn[- ]?day\b|infrastruktur kritis|apt\d{1,2}\b|\bc2\b|command and control|leak site|layanan lumpuh|situs lumpuh|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|insiden keamanan|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|investasi bodong|scam|penipuan online|pinjol ilegal|akun palsu)/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hackathon|mbti|enneagram)/i,
    x: ['("serangan siber" OR peretasan OR diretas OR "kebocoran data" OR BSSN OR DDoS OR exploit OR phishing OR ransomware OR deepfake) -filter:replies'],
    th: ['serangan siber', 'kebocoran data', 'ransomware', 'phishing', 'exploit', 'diretas', 'BSSN'] },
  { id: 'akun dibajak', local: true,
    pos: /(akun[^.\n]{0,30}(dibajak|diretas|dibobol|di-?hack|kena hack|disusupi)|akun (instagram|facebook|whatsapp|telegram|twitter|\bx\b|tiktok)[^.\n]{0,25}(dibajak|diretas|dibobol|hack))/i,
    x: ['(akun (dibajak OR diretas OR dibobol OR "kena hack")) -filter:replies'],
    th: ['akun dibajak', 'akun diretas', 'akun dibobol'] },
  { id: 'mbg', local: true,
    pos: /\bmbg\b|makan bergizi gratis|\bsppg\b|badan gizi nasional|\bbgn\b|keracunan mbg/i,
    neg: /(resep|food ?vlog|foodreview|food review|cooking|memasak|review makanan)/i,   // konten kuliner, bukan program
    x: ['("makan bergizi gratis" OR MBG OR SPPG OR "badan gizi nasional" OR BGN) -filter:replies'],
    th: ['makan bergizi gratis', 'MBG', '#makanbergizigratis'] },
  { id: 'bbm', local: true,
    pos: /\bbbmm?\b|bahan bakar (minyak|non ?subsidi|subsidi)|pertalite|pertamax|dexlite|biosolar|\bspbu\b|kelangkaan (bbm|minyak|solar)|antrean (spbu|bbm|minyak)|harga (bbm|minyak tanah)/i,
    neg: /(minyak (goreng|zaitun|wangi)|solar (panel|pembangkit)|bensin (romantis|story))/i,
    x: ['(BBM OR Pertalite OR Pertamax OR "harga BBM" OR SPBU OR "bahan bakar" OR "minyak tanah") -filter:replies'],
    th: ['BBM', 'harga BBM', 'Pertalite', 'SPBU', '#bbm'] },
  { id: 'pangan', local: true,
    pos: /(minyak goreng|harga (beras|telur|daging|cabai|gula|tepung|beras medium)|sembako|inflasi pangan|pangan (mahal|pasti)|stok (beras|pangan|sembako)|impor (beras|pangan|gula|tepung)|operasi pasar|bantuan pangan)/i,
    neg: /(resep|menu masak|food ?vlog|kuliner|review (makanan|resto))/i,
    x: ['("minyak goreng" OR "harga beras" OR sembako OR "operasi pasar" OR "inflasi pangan" OR "harga telur" OR "harga daging") -filter:replies'],
    th: ['minyak goreng', 'harga beras', 'sembako', 'inflasi pangan'] },
  { id: 'bansos', local: true,
    pos: /(bansos|bantuan sosial|bantuan langsung tunai|\bblt\b|\bpkh\b|\bbpnt\b|\bbsu\b|subsidi (listrik|gula|upah|pupuk)|rastra|kartu (sembako|prakerja|indonesia pintar)|program keluarga harapan)/i,
    neg: /(film|sinema|sinetron|nonton)/i,
    x: ['(bansos OR "bantuan sosial" OR PKH OR BPNT OR BSU OR BLT OR "subsidi listrik" OR "kartu prakerja") -filter:replies'],
    th: ['bansos', 'bantuan sosial', 'PKH', 'BSU', 'subsidi listrik'] },
  { id: 'hukum', local: true,
    pos: /(rkuhap|rkuhp|\bkuhp\b|\bkuhap\b|tipikor|korupsi|gratifikasi|suap|penyuapan|pengadilan|putusan (pengadilan|hakim)|kasasi|\bdiversi\b|kejaksaan|upacara hukuman mati|eksekusi (hukuman|mati)|rehabilitasi narkotika)/i,
    neg: /(film|sinema|sinetron|sinetrik|trailer|nonton|netflix)/i,
    x: ['(RKUHAP OR RKUHP OR KUHP OR KUHAP OR tipikor OR korupsi OR KPK OR kejaksaan OR "putusan pengadilan") -filter:replies'],
    th: ['RKUHAP', 'tipikor', 'korupsi', 'KPK', 'RKUHP'] },
  { id: 'olahraga', local: false,
    pos: /(timnas|bulu tangkis|badminton|sepak ?bola|liga 1|liga 2|liga champions|premier league|piala AFF|sea games|\bpiala dunia\b|\bolimpiade\b|atletik|panjat tebing|motogp|motoGp|balap (f1|motor|mobil)|formula 1|ganda (putra|putri|campuran)|tunggal (putra|putri)|volleyball|basket\b|nba\b)/i,
    neg: /(film|trailer|nonton|netflix|sinetron|sinetrik|game|genshin)/i,
    x: ['(timnas OR bulu tangkis OR badminton OR "piala AFF" OR "sea games" OR "liga 1" OR "premier league" OR atletik OR panjat tebing) -filter:replies'],
    th: ['timnas', 'bulu tangkis', 'piala AFF', 'sea games', 'liga 1', 'atletik'] },
  { id: 'transport', local: true,
    pos: /(kereta api|\bkai\b|delay (penerbangan|pesawat|kereta)|penerbangan (delay|dibatalkan|batal landas)|tiket (pesawat|kereta|kapal)|\bdermaga\b|kapal feri|\bferry\b|mudik|batal mudik|tol (macet|boleh|putus|buntu|lalu lintas)|jalan tol|busway|transjakarta|\bmrt\b|\blrt\b|\bkrl\b|angkot|ojol|gojek|grabfood|\bgrab\s*(?:car|bike|food|motor|ride|dana|share|express)\b|taxi online|kecelakaan (kereta|bus|truk))/i,
    neg: /(judi|togel|slot online|gacor|prediksi)/i,
    x: ['(kereta api OR "delay penerbangan" OR "penerbangan dibatalkan" OR bandara OR "jalan tol" OR mudik OR ojol OR TransJakarta OR MRT OR KRL OR angkot) -filter:replies'],
    th: ['kereta api', 'delay penerbangan', 'jalan tol', 'mudik', 'ojol', 'TransJakarta'] },
  { id: 'pendidikan', local: true,
    pos: /(ukt|biaya kuliah tunggal|beasiswa (dipotong|batal|ditolak|gelombang)|guru (honorer|pppk)|keracunan (kantin|sekolah|massal|makanan)|murid (pingsan|tenggelam|meninggal|kecelakaan)|siswa (pingsan|tenggelam|meninggal|keracunan|kecelakaan)|mahasiswa (pingsan|tenggelam|meninggal|keracunan|demo|unjuk rasa|demonstrasi)|sekolah (kebakaran|longsor|ambruk|ditutup|runtuh|tenggelam)|kampus (kebakaran|longsor|ambruk)|snbt|sbmptn|kurikulum merdeka)/i,
    neg: /(film|sinema|sinetron|nonton|netflix)/i,
    x: ['(UKT OR "biaya kuliah" OR "guru honorer" OR "siswa pingsan" OR "keracunan sekolah" OR "sekolah kebakaran" OR beasiswa OR SNBT OR "guru PPPK") -filter:replies'],
    th: ['UKT', 'biaya kuliah', 'guru honorer', 'siswa pingsan', 'keracunan sekolah', 'beasiswa'] }
];
for (const t of SOC_TOPICS) t.adhoc = false;

/* ---------- klasifikasi: teks -> topics[] ---------- */
const ASSESS = require('./assessment');
function socAssess(text, extra) {
  return ASSESS.assess(text, SOC_TOPICS.concat(extra || []), { noise: SOC_NOISE_RE, spam: SOC_SPAM_RE });
}
function socTopics(text, extra) { return socAssess(text, extra).topics; }

/* topik ad-hoc dari judul berita (nama kasus yang lagi naik) */
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function socAdhoc(phrases) {
  return (phrases || []).slice(0, 2).map(ph => ({
    id: String(ph).toLowerCase(), adhoc: true, local: true,
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
  if (p.is_reply && (p.like_count || 0) < 5) return false;
  return true;
}

/* ---------- balancer: satu topik / satu akun nggak boleh makan buffer ---------- */
function socBalance(arr, max, userOf, perTopic = 0.22, perUser = 3) {
  const capT = Math.max(8, Math.ceil(max * perTopic)), tc = Object.create(null), uc = Object.create(null), out = [];
  for (const p of arr) {
    const tps = [...new Set(p.topics || [])], u = String(userOf(p) || '?').toLowerCase();
    if (!tps.length || tps.some(t => (tc[t] || 0) >= capT || (uc[u + '|' + t] || 0) >= perUser)) continue;
    for (const t of tps) { tc[t] = (tc[t] || 0) + 1; uc[u + '|' + t] = (uc[u + '|' + t] || 0) + 1; }
    out.push(p);
    if (out.length >= max) break;
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

module.exports = { CLASSIFIER_VERSION: ASSESS.VERSION, SOC_TOPICS, socAssess, socTopics, socAdhoc, socKeepX, socKeepTh, socBalance, socQueries, socHot, socNonLatin, socVi, socHashJunk, astroturfSig, socForeignLang, SOC_FOREIGN_RE, SOC_LOCAL_RE };
