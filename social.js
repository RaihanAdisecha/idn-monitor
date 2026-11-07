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
function socNonLatin(t) {
  const s = String(t || '');
  const nl = (s.match(SOC_NONLATIN_RE) || []).length;
  const lat = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  return nl >= 20 && nl > lat;
}

// kata negara asing: membuang "penembakan di Texas", "gempa Jepang" dst. KECUALI ada petunjuk lokal Indonesia.
const SOC_FOREIGN_RE = /\b(amerika|texas|california|new york|brasil|brazil|filipina|thailand|malaysia|korea|jepang|tiongkok|china|inggris|prancis|perancis|jerman|australia|india|pakistan|iran|israel|palestina|ukraina|rusia|gaza|turki|meksiko|kanada|nigeria|afrika|trump)\b/i;
const SOC_LOCAL_RE = /(indonesia|\bwni\b|jakarta|jabar|jateng|jatim|jawa|sumatera|sumatra|kalimantan|sulawesi|papua|bali\b|aceh|riau|banten|bekasi|bogor|depok|tangerang|bandung|surabaya|medan|makassar|semarang|yogya|bpbd|bnpb|bmkg|polres|polda|polsek|kodim|damkar|pemkot|pemkab|kabupaten|provinsi|prabowo|gibran|\bdpr\b|dprd|kapolri|polri)/i;

const SOC_TOPICS = [
  { id: 'demo', local: true,
    pos: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|\bdemo\b)/i,
    strong: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa)/i,   // tanpa ini, kata "demo" polos butuh konteks
    ctx: /(tuntut|tolak|mahasiswa|\bbem\b|buruh|ojol|\bdpr\b|dprd|gedung|polisi|aparat|gas air mata|\baksi\b|\bmassa\b|orasi|turun ke jalan|spanduk|ricuh|bentrok|rusuh|ditangkap|diamankan|bubarkan|barikade|molotov|water cannon|kapolda|kapolres|reformasi|pemerintah|istana|patung kuda|march|aksi damai|long march)/i,
    neg: /(demo (lagu|musik|reel|reels|app|apps|aplikasi|akun|produk|plane|game|beat|tape|masak|memasak|cooking|vokal|record|rekaman|day|link|version|ui|web|website|bot|trading)|free demo|live demo|cooking demo|demonstrasi (produk|alat|masak|memasak|fitur)|\bdemo\b.{0,20}#(music|musik|beat))/i,
    x: ['(unjuk rasa OR demonstrasi OR "aksi massa" OR demonstran) -filter:replies',
        'demo (mahasiswa OR buruh OR ojol OR DPR OR tuntutan OR ricuh OR polisi) -filter:replies'],
    th: ['unjuk rasa', 'demo mahasiswa'] },
  { id: 'kebakaran', local: true,
    pos: /(kebakaran|terbakar|kobaran api|si jago merah|dilalap api|ludes dilalap)/i,
    neg: /(kebakaran (hutan|lahan)|karhutla|kebakaran (harga|promo|diskon|obral|sale|murah|gila|meriah|jagoan|gaib|mangling|total)|harga (kebakaran|panas|terbakar))/i,   // hutan/lahan masuk topik sendiri; "kebakaran harga" = slang sale
    x: ['(kebakaran OR "si jago merah" OR "ludes terbakar" OR damkar) -filter:replies'],
    th: ['kebakaran'] },
  { id: 'karhutla', local: true,
    pos: /(karhutla|kebakaran (hutan|lahan)|titik panas|hotspot|kabut asap)/i,
    // "titik panas" juga dipakai wabah/kesehatan — wajib konteks kebakaran lahan
    strong: /(karhutla|kebakaran (hutan|lahan)|kabut asap|hotspot)/i,
    ctx: /(hutan|lahan|karhutla|asap|kebakaran|riau|sumatera|kalimantan|papua|jambi|sumsel)/i,
    x: ['(karhutla OR "kebakaran hutan" OR "kebakaran lahan" OR "kabut asap") -filter:replies'],
    th: ['karhutla'] },
  { id: 'banjir', local: true,
    pos: /(banjir|longsor|tanggul jebol|air meluap|genangan)/i,
    x: ['(banjir OR longsor OR "banjir bandang" OR "tanggul jebol") -filter:replies'],
    th: ['banjir'] },
  { id: 'gempa', local: true,
    pos: /(gempa|tsunami|magnitudo|erupsi|letusan gunung)/i,
    // "tsunami" sendirian sering kiasan: "blue/blauwe tsunami" = gerakan protes politik,
    // tsunami finance/sport — wajib konteks seismik atau lokasi bencana
    neg: /(blue|blauwe)\s+tsunami|tsunami\s+(biru|politik|protes)/i,
    strong: /(gempa|magnitudo|erupsi|letusan)/i,
    ctx: /(jepang|japan|indonesia|jakarta|jkt|sumatera|pantai|beach|gelombang|dahsyat|air bah|megathrust|pesisir|tepi laut|gempa|earthquake|gelombang pasang|\brob\b|banjir rob|palung|waspada|peringatan|imau|bnpb|bpbd)/i,
    x: ['(gempa OR tsunami OR magnitudo OR erupsi) -filter:replies'],
    th: ['gempa'] },
  { id: 'kecelakaan', local: true,
    pos: /(kecelakaan|tabrakan|tabrak lari|kapal (tenggelam|karam)|pesawat jatuh|bus terguling|truk terguling|kereta anjlok|ledakan)/i,
    // "ledakan"/"tabrakan" sering kiasan: ledakan penduduk, tabrakan pendapat
    neg: /(ledakan (penduduk|jumlah|kasus|order|orders|promo|penjualan|chat|emoji|tawa|tangis|debat|lagu|musik|harga|bonus|like|komentar|followers?|data|traffic|trafik)|tabrakan (pendapat|argumen|prinsip|debat|pemikiran))/i,
    x: ['(kecelakaan OR "tabrak lari" OR "bus terguling" OR "kapal tenggelam" OR ledakan) -filter:replies'],
    th: ['kecelakaan'] },
  { id: 'penembakan', local: true,
    pos: /(penembakan|ditembak|baku tembak|tertembak)/i,
    neg: /(ditembak (hati|cinta|asmara|batin|panah|tatapan))/i,   // kiasan asmara/cinta
    x: ['(penembakan OR ditembak OR "baku tembak") -filter:replies'],
    th: ['penembakan'] },
  { id: 'pencurian', local: true,
    pos: /(pencurian|curanmor|begal|perampokan|jambret|dirampok|kemalingan)/i,
    x: ['(pencurian OR curanmor OR begal OR perampokan OR jambret) -filter:replies'],
    th: ['pencurian'] },
  { id: 'penangkapan', local: true,
    pos: /(penangkapan|ditangkap|diamankan|\bott\b)/i,
    ctx: /(polisi|polres|polda|polsek|\bkpk\b|kejaksaan|\bbnn\b|densus|petugas|aparat|tersangka|pelaku|buron)/i,
    x: ['(penangkapan OR ditangkap OR OTT) (polisi OR KPK OR Densus OR tersangka) -filter:replies'],
    th: ['penangkapan'] },
  { id: 'phk',
    pos: /(\bphk\b|pemutusan hubungan kerja|dirumahkan|pabrik tutup)/i,
    x: ['(PHK OR "pemutusan hubungan kerja" OR dirumahkan OR "pabrik tutup") -filter:replies'],
    th: ['phk'] },
  { id: 'rupiah',
    pos: /(rupiah|kurs dolar|kurs dollar|nilai tukar)/i,
    x: ['(rupiah OR "kurs dolar" OR "nilai tukar") -filter:replies'],
    th: ['rupiah'] },
  { id: 'ihsg',
    pos: /(\bihsg\b|trading halt|bursa efek|\bidx\b)/i,
    x: ['(IHSG OR "trading halt" OR "bursa efek") -filter:replies'],
    th: ['ihsg'] },
  { id: 'listrik padam',
    pos: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|blackout|byarpet)/i,
    // "blackout" sendirian terlalu longgar: dipakai kampanye K-pop (#Blackoutforboom),
    // EDM, dan spam tiket — wajib konteks utilitas/Indonesia
    strong: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|byarpet)/i,
    ctx: /(listrik|pln|pemadaman|padam|mati|gelap|indonesia|jakarta|\bjkt\b|jabar|jateng|jatim|sumatera|kalimantan|sulawesi|papua|bali\b|aceh|riau|banten|bekasi|bogor|depok|tangerang|bandung|surabaya|medan|makassar|semarang|yogya|denpasar|bpbd|bnpb|pemkot|pemkab)/i,
    x: ['("listrik padam" OR "mati listrik" OR "pemadaman listrik" OR blackout) -filter:replies'],
    th: ['listrik padam'] },
  { id: 'wabah',
    pos: /(wabah|\bklb\b|kejadian luar biasa|keracunan (massal|makanan|mbg)|kasus (dbd|campak|difteri|kolera|covid|flu burung))/i,
    x: ['(wabah OR "keracunan massal" OR "keracunan makanan" OR KLB OR "kasus DBD") -filter:replies'],
    th: ['wabah', 'keracunan massal'] },
  { id: 'pemilu', local: true,
    pos: /(pemilu|pilkada|pilpres|\bkpu\b|bawaslu)/i,
    x: ['(pemilu OR pilkada OR pilpres OR KPU OR Bawaslu) -filter:replies'],
    th: ['pemilu', 'pilkada'] },
  { id: 'ransomware',
    pos: /(ransomware|malware)/i,
    x: ['(ransomware OR malware) -filter:replies'],
    th: ['ransomware'] },
  { id: 'serangan siber',
    pos: /(serangan siber|serangan cyber|peretasan|diretas|kebocoran data|bocor data|\bddos\b|data breach|\bbssn\b|\bpdn\b)/i,
    x: ['("serangan siber" OR peretasan OR diretas OR "kebocoran data" OR BSSN OR DDoS) -filter:replies'],
    th: ['serangan siber', 'kebocoran data'] },
  { id: 'akun dibajak',
    pos: /akun[^.\n]{0,25}(dibajak|diretas|kena hack|di-hack|dibobol)/i,
    x: ['(akun (dibajak OR diretas OR dibobol)) -filter:replies'],
    th: ['akun dibajak'] }
];
for (const t of SOC_TOPICS) t.adhoc = false;

/* ---------- klasifikasi: teks -> topics[] ---------- */
function socTopics(text, extra) {
  const t = String(text || '');
  if (!t || SOC_NOISE_RE.test(t) || SOC_SPAM_RE.test(t) || socHashCount(t) >= 10) return [];
  const foreign = (SOC_FOREIGN_RE.test(t) || socNonLatin(t)) && !SOC_LOCAL_RE.test(t);
  const out = [];
  for (const tp of extra && extra.length ? SOC_TOPICS.concat(extra) : SOC_TOPICS) {
    if (!tp.pos.test(t)) continue;
    if (tp.neg && tp.neg.test(t)) continue;
    if (tp.ctx && !(tp.strong && tp.strong.test(t)) && !tp.ctx.test(t)) continue;
    if (tp.local && foreign) continue;
    out.push(tp.id);
  }
  return out;
}

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
  const capT = Math.max(8, Math.ceil(max * perTopic)), tc = Object.create(null), uc = Object.create(null), out = [], skipped = [];
  for (const p of arr) {                       // arr harus sudah urut terbaru -> lama
    const tps = p.topics || [];
    if (!tps.length) continue;
    const u = userOf(p) || '?';
    if (tps.every(t => (tc[t] || 0) >= capT) || tps.every(t => (uc[u + '|' + t] || 0) >= perUser)) { skipped.push(p); continue; }
    for (const t of tps) { tc[t] = (tc[t] || 0) + 1; uc[u + '|' + t] = (uc[u + '|' + t] || 0) + 1; }
    out.push(p);
    if (out.length >= max) break;
  }
  // data sepi: jangan biarkan buffer kosong gara-gara cap; isi sampai 50% dari sisa
  const floor = Math.floor(max * 0.5);
  for (let i = 0; out.length < floor && i < skipped.length; i++) out.push(skipped[i]);
  return out.sort((a, b) => (b.ts || Date.parse(b.created_at || '') || 0) - (a.ts || Date.parse(a.created_at || '') || 0));
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
  const W = 90 * 60e3, B = 24 * 3600e3;
  const st = Object.create(null);
  for (const p of posts) {
    for (const t of p.topics || []) {
      const e = st[t] || (st[t] = { x: 0, th: 0, rx: new Set(), rt: new Set(), base: 0 });
      e[p.platform]++;
      const age = now - p.ts;
      if (age <= W) (p.platform === 'x' ? e.rx : e.rt).add(p.user || '?');
      else if (age <= B) e.base++;
    }
  }
  const stats = {}, hot = [];
  for (const [t, e] of Object.entries(st)) {
    stats[t] = { x: e.x, th: e.th };
    const users = e.rx.size + e.rt.size;
    const baseRate = e.base / ((B - W) / W);           // ekspektasi akun-per-window dari baseline
    const both = e.rx.size > 0 && e.rt.size > 0;
    if (users < 3) continue;
    const score = (users / (1 + baseRate)) * (both ? 1.5 : 1);
    hot.push({ id: t, users, both, score: +score.toFixed(2) });
  }
  hot.sort((a, b) => b.score - a.score);
  return { stats, hot: hot.slice(0, 6) };
}

module.exports = { SOC_TOPICS, socTopics, socAdhoc, socKeepX, socKeepTh, socBalance, socQueries, socHot, SOC_FOREIGN_RE, SOC_LOCAL_RE };
