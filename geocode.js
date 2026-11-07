"use strict";
/* Geocoder judul berita → titik di Indonesia.
   Prinsip: akurasi > recall. Lebih baik tidak ada titik daripada titik salah.
   - Sumber: geo/gazetteer.json (514 kab/kota + 38 provinsi + kecamatan unik, Kepmendagri 2025)
   - Matching per-token (bukan substring), frasa terpanjang menang ("Banda Aceh" tidak jadi "Aceh")
   - Nama yang juga kata umum (Malang, Batu, Serang, Metro...) hanya sah dengan penanda lokatif
   - Presisi dilaporkan jujur: poi > kab (pusat pemerintahan) > prov (centroid, perkiraan) */
const path = require('path');
const G = require(path.join(__dirname, 'geo', 'gazetteer.json'));
// koreksi koordinat hasil scripts/geo-audit.js (titik pesisir yang jatuh di laut → daratan; centroid provinsi kepulauan → ibukota)
let FIX = { kab: {}, prov: {} };
try { FIX = require(path.join(__dirname, 'geo', 'coord-fixes.json')); } catch (e) {}
for (const k of G.kab) { const f = FIX.kab[k.code]; if (f) { k.la = f[0]; k.lo = f[1]; } }
for (const p of G.prov) { const f = FIX.prov[p.code]; if (f) { p.la = f[0]; p.lo = f[1]; } }

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LEVEL = { poi: 7, kec: 6.5, kab: 6, region: 3.5, prov: 3 };

// nama kab/kota yang juga kata umum / nama institusi: wajib ada penanda lokatif tepat sebelumnya
const AMBIG = new Set(['batang', 'batu', 'batu bara', 'puncak', 'metro', 'serang', 'malang', 'buru', 'pati', 'sula', 'banjar', 'bone', 'kaur', 'tanah laut', 'kota baru', 'seribu', 'jaya', 'raya', 'mamasa', 'lahat']);
const LOC_CUE = new Set(['di', 'ke', 'kota', 'kabupaten', 'kab', 'pemkot', 'pemkab', 'walikota', 'bupati', 'kodya', 'kecamatan', 'kec', 'wilayah', 'kapolres', 'polres', 'polresta', 'polrestabes', 'kodim', 'bpbd']);
const PREFIX_KAB = new Set(['kabupaten', 'kab', 'pemkab', 'bupati']);
const PREFIX_KOTA = new Set(['kota', 'kodya', 'pemkot', 'walikota', 'polresta', 'polrestabes']);
const PREFIX_KEC = new Set(['kecamatan', 'kec']);
const PREFIX_PROV = new Set(['provinsi', 'prov', 'pemprov', 'gubernur']);
const CUE_IN = new Set(['di', 'wilayah', 'sekitar', 'kecamatan', 'kec', 'kabupaten', 'kota']);
const CUE_FROM = new Set(['dari', 'asal', 'warga', 'asal-usul']);
// tempat tujuan/asal bukan lokasi kejadian: "dipulangkan ke Jawa Tengah", "dilarikan ke Bandung", "bantuan untuk Flores"
const DEST_VERB = new Set(['dipulangkan', 'dikirim', 'dibawa', 'dilarikan', 'dirujuk', 'diterbangkan', 'diberangkatkan', 'dikembalikan', 'menuju', 'kembali', 'pulang', 'mudik', 'dipindahkan', 'dievakuasi', 'diangkut']);
const SEP_OK = new Set(['dan', 'serta', 'hingga', 'sampai', 'maupun', 'atau', 'juga', 'sekitarnya', 'dll', 'lainnya']);
// frasa yang kelihatan seperti lokasi tapi bukan
const NOT_PLACE = /\b(polda metro jaya|metro tv|metro jaya|batu bara kalori|harga batu bara|pembangkit batu bara|tambang batu bara|serang(?:an)? (?:balik|udara|siber))\b/;

const kabByCode = {}, provByCode = {};
for (const p of G.prov) provByCode[p.code] = p;
const kotaNames = new Set(G.kab.filter(k => k.kota).map(k => norm(k.name)));
const idx = new Map();   // frasa → [entri]
const put = (key, e) => {
  if (!key || key.length < 4) return;
  const a = idx.get(key); if (a) { if (!a.some(x => x.id === e.id)) a.push(e); } else idx.set(key, [e]);
};
const LABEL_FIX = { 'Palangkaraya': 'Palangka Raya', 'Bau Bau': 'Baubau', 'Kep. Siau Tagulandang Biaro': 'Sitaro', 'Toli-Toli': 'Tolitoli' };
const displayKab = k => (!k.kota && kotaNames.has(norm(k.name)) ? 'Kab. ' : '') + (LABEL_FIX[k.name] || k.name);
for (const k of G.kab) {
  const e = { id: k.code, level: 'kab', kota: k.kota, name: displayKab(k), la: k.la, lo: k.lo, prov: provByCode[k.prov].name, prec: 'kab' };
  kabByCode[k.code] = e;
  const n = norm(k.name);
  put(n, e);
  if (n.includes(' ') && n.length >= 8) put(n.replace(/ /g, ''), e);
  const m = /^(kepulauan|pulau) (.+)$/.exec(n);
  if (m && m[2].length >= 5 && m[2] !== 'seribu') put(m[2], e);
}
// ibukota kabupaten sebagai alias (Ruteng, Labuan Bajo, Sigli...): hanya yang unik secara nasional,
// bukan kata generik, dan tidak bentrok dengan nama kab/kota lain
const IK_GENERIC = new Set(['tanjung', 'kuala', 'muara', 'sungai', 'simpang', 'pulau', 'bukit', 'batu', 'air', 'pasar', 'kota', 'teluk', 'padang', 'lubuk', 'pangkalan', 'labuhan', 'sei', 'karang', 'sinar', 'baru', 'mekar', 'tebing', 'talang', 'ujung', 'mandiri', 'jaya', 'wonosari', 'bangkinang']);
const ikCount = {};
for (const k of G.kab) { const ik = norm(k.ibukota.replace(/^Kota /, '')); ikCount[ik] = (ikCount[ik] || 0) + 1; }
for (const k of G.kab) {
  const ik = norm(k.ibukota.replace(/^Kota /, ''));
  if (ik.length >= 6 && ikCount[ik] === 1 && !idx.has(ik) && !AMBIG.has(ik) && !IK_GENERIC.has(ik.split(' ')[0])) put(ik, { ...kabByCode[k.code], alias: true });
}
// alias manual (singkatan & sebutan umum)
const kabByName = (nm, kota) => G.kab.find(k => norm(k.name) === norm(nm) && (kota == null || k.kota === kota));
const alias = (key, nm, kota, label) => { const k = kabByName(nm, kota); if (k) put(key, { ...kabByCode[k.code], name: label || kabByCode[k.code].name }); };
alias('jakarta', 'Jakarta Pusat', true, 'Jakarta'); alias('dki', 'Jakarta Pusat', true, 'Jakarta');
alias('jogja', 'Yogyakarta', true); alias('yogya', 'Yogyakarta', true);
alias('tangsel', 'Tangerang Selatan', true); alias('pangkalpinang', 'Pangkal Pinang', true);
alias('tanjungpinang', 'Tanjung Pinang', true); alias('tasik', 'Tasikmalaya', true);
alias('banjarbaru', 'Banjar Baru', true); alias('sitaro', 'Kep. Siau Tagulandang Biaro', false); alias('tolitoli', 'Toli-Toli', false); alias('baubau', 'Bau Bau', true);
// provinsi
const PROV_ALIAS = {
  '11': ['aceh', 'nanggroe aceh'], '12': ['sumatera utara', 'sumatra utara', 'sumut'], '13': ['sumatera barat', 'sumatra barat', 'sumbar'], '14': ['riau'], '15': ['jambi'],
  '16': ['sumatera selatan', 'sumatra selatan', 'sumsel'], '17': ['bengkulu'], '18': ['lampung'], '19': ['bangka belitung', 'babel', 'kepulauan bangka belitung', 'bangka', 'belitung'],
  '21': ['kepulauan riau', 'kepri'], '31': [], '32': ['jawa barat', 'jabar'], '33': ['jawa tengah', 'jateng'], '34': ['diy', 'daerah istimewa yogyakarta'],
  '35': ['jawa timur', 'jatim'], '36': ['banten'], '51': ['bali'], '52': ['nusa tenggara barat', 'ntb'], '53': ['nusa tenggara timur', 'ntt'],
  '61': ['kalimantan barat', 'kalbar'], '62': ['kalimantan tengah', 'kalteng'], '63': ['kalimantan selatan', 'kalsel'], '64': ['kalimantan timur', 'kaltim'],
  '65': ['kalimantan utara', 'kaltara'], '71': ['sulawesi utara', 'sulut'], '72': ['sulawesi tengah', 'sulteng'], '73': ['sulawesi selatan', 'sulsel'],
  '74': ['sulawesi tenggara', 'sultra'], '75': ['gorontalo'], '76': ['sulawesi barat', 'sulbar'], '81': ['maluku'], '82': ['maluku utara', 'malut'],
  '91': ['papua'], '92': ['papua barat'], '93': ['papua selatan'], '94': ['papua tengah'], '95': ['papua pegunungan'], '96': ['papua barat daya']
};
for (const p of G.prov) {
  const e = { id: 'P' + p.code, level: 'prov', name: p.name.replace('Daerah Khusus Ibukota ', '').replace('Daerah Istimewa ', 'DI '), la: p.la, lo: p.lo, prov: p.name, prec: 'prov' };
  put(norm(p.name), e);
  for (const a of PROV_ALIAS[p.code] || []) put(a, e);
}
// provinsi dengan nama sama kota (Gorontalo, Bengkulu, Jambi, Bali..): ambil kota bila ada "kota"; selain itu tingkat provinsi
// wilayah kepulauan (tanpa batas administratif, presisi kasar)
for (const [key, name, la, lo] of [['flores', 'Flores', -8.65, 121.0], ['lombok', 'Lombok', -8.65, 116.32], ['sumba', 'Sumba', -9.7, 119.9], ['halmahera', 'Halmahera', 0.8, 128.0]])
  put(key, { id: 'R' + key, level: 'region', name, la, lo, prov: '', prec: 'region' });

/* POI: gunung api & landmark dengan koordinat nyata */
const VOLC = {
  'anak krakatau': [-6.10, 105.42], krakatau: [-6.10, 105.42], merapi: [-7.54, 110.44], semeru: [-8.108, 112.92], bromo: [-7.94, 112.95], agung: [-8.34, 115.51],
  sinabung: [3.17, 98.39], kerinci: [-1.70, 101.26], marapi: [-0.38, 100.47], dempo: [-4.02, 103.13], papandayan: [-7.32, 107.73], guntur: [-7.25, 107.85],
  'tangkuban perahu': [-6.76, 107.61], galunggung: [-7.25, 108.06], slamet: [-7.24, 109.21], dieng: [-7.20, 109.90], lawu: [-7.63, 111.19], kelud: [-7.93, 112.31],
  raung: [-8.13, 114.06], ijen: [-8.06, 114.24], batur: [-8.24, 115.38], rinjani: [-8.41, 116.46], tambora: [-8.25, 118.0], 'sangeang api': [-8.20, 119.07],
  'lewotobi laki laki': [-8.54, 122.77], 'lewotobi': [-8.54, 122.77], 'ili lewotolok': [-8.27, 123.50], lewotolok: [-8.27, 123.50], 'batu tara': [-7.79, 123.58],
  karangetang: [2.78, 125.41], lokon: [1.37, 124.83], soputan: [1.11, 124.73], ruang: [2.30, 125.37], ibu: [1.49, 127.63], dukono: [1.69, 127.88], gamalama: [0.80, 127.33], kelimutu: [-8.77, 122.80], egon: [-8.68, 122.45]
};
const VOLC_BARE = new Set(['merapi', 'semeru', 'bromo', 'sinabung', 'kerinci', 'marapi', 'krakatau', 'anak krakatau', 'karangetang', 'lokon', 'soputan', 'lewotobi', 'lewotobi laki laki', 'ili lewotolok', 'lewotolok', 'kelud', 'raung', 'galunggung', 'tangkuban perahu', 'rinjani', 'tambora', 'papandayan', 'sangeang api', 'dukono', 'gamalama', 'kelimutu']);
const POI = [];
for (const [nm, [la, lo]] of Object.entries(VOLC)) {
  const label = 'Gunung ' + nm.replace(/\b\w/g, c => c.toUpperCase());
  const pre = '(?:gunung|gunungapi|gn|g|erupsi|letusan|status|awan panas|kawah) ';
  const re = VOLC_BARE.has(nm) ? new RegExp('(?:^| )(?:' + pre + ')?' + nm + '(?= |$)') : new RegExp('(?:^| )' + pre + nm + '(?= |$)');
  POI.push({ re, e: { id: 'V' + nm, level: 'poi', name: label, la, lo, prov: '', prec: 'poi' } });
}
const LM = (id, name, la, lo, re) => POI.push({ re, e: { id, level: 'poi', name, la, lo, prov: 'DKI Jakarta', prec: 'poi' } });
LM('istana', 'Istana Merdeka', -6.1702, 106.8272, /(?:^| )(?:istana negara|istana merdeka|istana presiden|(?:depan|sekitar|area|kawasan) istana)(?= |$)/);
LM('dpr', 'DPR / MPR Senayan', -6.2185, 106.8002, /(?:^| )(?:(?:gedung|depan|kompleks|kawasan) (?:dpr|mpr|dpr ri|parlemen)|senayan)(?= |$)/);
LM('monas', 'Monas', -6.1754, 106.8272, /(?:^| )(?:monas|patung kuda|medan merdeka|lapangan banteng|bundaran hi)(?= |$)/);
POI.push({ re: /(?:^| )pelaga(?= |$)/, e: { id: 'pelaga', level: 'poi', name: 'Pelaga, Badung', la: -8.36, lo: 115.35, prov: 'Bali', prec: 'poi' } });

/* POI kawasan kota & landmark: nama daerah yang sering muncul di berita tapi tidak
   ada di gazetteer kab/kota (Gambir, Tanah Abang, Cikini, dst). coords dari OSM/Nominatim.
   cue:true = wajib didahului penanda lokatif — untuk nama yang juga kata umum
   (karet, srengseng, sukun, blimbing, mlati, pancoran, kembangan, halim).
   special: 'genteng'/'candi'/'makasar' terlalu ambigu → wajib konteks kota tetangga. */
const CITY = [];
const CUE_PRE = '(?:di|ke|dari|warga|sekitar|area|kecamatan|kec|pemkot|dishub|polres|truk|bus|angkot|mahasiswa)';
const cpoi = (id, name, la, lo, prov, keys, cue) => {
  // cue:true → lookbehind: match mulai di NAMA (bukan kata cue), supaya preceding-token
  // tetap penanda lokatif dan bonus cue di loop POI tetap dihitung
  const pre = cue ? '(?<=(?:^| )' + CUE_PRE + ' )' : '';
  for (const k of keys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    CITY.push({ re: new RegExp('(?:^| )' + pre + esc + '(?= |$)'), e: { id, level: 'poi', name, la, lo, prov, prec: 'poi' } });
  }
};
/* ---- DKI Jakarta ---- */
const J = 'DKI Jakarta';
cpoi('gambir', 'Gambir', -6.1767, 106.8306, J, ['gambir', 'stasiun gambir']);
cpoi('tanah-abang', 'Pasar Tanah Abang', -6.2063, 106.8178, J, ['pasar tanah abang']);
cpoi('tanah-abang-kec', 'Tanah Abang', -6.1857, 106.8109, J, ['tanah abang']);
cpoi('cikini', 'Cikini', -6.1985, 106.8413, J, ['cikini']);
cpoi('senen', 'Senen', -6.1744, 106.8446, J, ['senen', 'pasar senen']);
cpoi('kemayoran', 'Kemayoran', -6.1617, 106.8414, J, ['kemayoran']);
cpoi('halim', 'Halim Perdanakusuma', -6.2656, 106.8936, J, ['halim perdanakusuma', 'bandara halim'], true);
CITY.push({ re: new RegExp('(?:^| )(?<=(?:^| )' + CUE_PRE + ' )halim(?= |$)'), e: { id: 'halim', level: 'poi', name: 'Halim Perdanakusuma', la: -6.2656, lo: 106.8936, prov: J, prec: 'poi' } });
cpoi('tanjung-priok', 'Tanjung Priok', -6.1289, 106.8708, J, ['tanjung priok']);
cpoi('pluit', 'Pluit', -6.1150, 106.7874, J, ['pluit']);
cpoi('kalideres', 'Kalideres', -6.1370, 106.7016, J, ['kalideres']);
cpoi('gbk', 'GBK', -6.2186, 106.8036, J, ['gelora bung karno', 'gbk']);
cpoi('taman-mini', 'Taman Mini', -6.3026, 106.8953, J, ['taman mini']);
cpoi('mangga-besar', 'Mangga Besar', -6.1498, 106.8270, J, ['mangga besar']);
cpoi('matraman', 'Matraman', -6.2126, 106.8598, J, ['matraman']);
cpoi('menteng', 'Menteng', -6.1950, 106.8322, J, ['menteng']);
cpoi('tebet', 'Tebet', -6.2264, 106.8584, J, ['tebet']);
cpoi('pancoran', 'Pancoran', -6.2581, 106.8427, J, ['pancoran'], true);
cpoi('kebayoran', 'Kebayoran', -6.2372, 106.7825, J, ['kebayoran']);
cpoi('ciracas', 'Ciracas', -6.3296, 106.8766, J, ['ciracas']);
cpoi('duren-sawit', 'Duren Sawit', -6.2341, 106.9192, J, ['duren sawit']);
cpoi('jagakarsa', 'Jagakarsa', -6.3301, 106.8222, J, ['jagakarsa']);
cpoi('pondok-gede', 'Pondok Gede', -6.2896, 106.8959, J, ['pondok gede']);
cpoi('sawah-besar', 'Sawah Besar', -6.1607, 106.8277, J, ['sawah besar']);
cpoi('johar-baru', 'Johar Baru', -6.1831, 106.8553, J, ['johar baru']);
cpoi('gunung-sahari', 'Gunung Sahari', -6.1368, 106.8324, J, ['gunung sahari']);
cpoi('koja', 'Koja', -6.1208, 106.9074, J, ['koja']);
cpoi('penjaringan', 'Penjaringan', -6.1173, 106.7674, J, ['penjaringan']);
cpoi('ancol', 'Ancol', -6.1281, 106.8451, J, ['ancol']);
cpoi('kelapa-gading', 'Kelapa Gading', -6.1599, 106.9025, J, ['kelapa gading']);
cpoi('cengkareng', 'Cengkareng', -6.1529, 106.7447, J, ['cengkareng']);
cpoi('tomang', 'Tomang', -6.1716, 106.7969, J, ['tomang']);
cpoi('grogol', 'Grogol', -6.1620, 106.7896, J, ['grogol']);
cpoi('palmerah', 'Palmerah', -6.2079, 106.7972, J, ['palmerah']);
cpoi('karet', 'Karet', -6.2135, 106.8271, J, ['karet'], true);
cpoi('mampang', 'Mampang', -6.2362, 106.8198, J, ['mampang']);
cpoi('kramat-jati', 'Kramat Jati', -6.2749, 106.8625, J, ['kramat jati']);
cpoi('balekambang', 'Balekambang', -6.2807, 106.8521, J, ['balekambang']);
cpoi('bendungan-hilir', 'Bendungan Hilir', -6.2150, 106.8179, J, ['bendungan hilir']);
cpoi('pasar-minggu', 'Pasar Minggu', -6.2833, 106.8449, J, ['pasar minggu']);
cpoi('kembangan', 'Kembangan', -6.1914, 106.7406, J, ['kembangan'], true);
cpoi('pondok-labu', 'Pondok Labu', -6.3088, 106.7979, J, ['pondok labu']);
cpoi('lubang-buaya', 'Lubang Buaya', -6.2929, 106.9031, J, ['lubang buaya']);
cpoi('jatinegara', 'Jatinegara', -6.2149, 106.8703, J, ['jatinegara']);
cpoi('pulo-gadung', 'Pulo Gadung', -6.1911, 106.8906, J, ['pulo gadung']);
cpoi('cipayung', 'Cipayung', -6.3294, 106.9037, J, ['cipayung']);
cpoi('klender', 'Klender', -6.2133, 106.8994, J, ['klender']);
cpoi('cakung', 'Cakung', -6.2191, 106.9525, J, ['cakung']);
cpoi('pasar-rebo', 'Pasar Rebo', -6.3250, 106.8534, J, ['pasar rebo']);
cpoi('kalibata', 'Kalibata', -6.2624, 106.8403, J, ['kalibata']);
cpoi('lebak-bulus', 'Lebak Bulus', -6.3017, 106.7797, J, ['lebak bulus']);
cpoi('pesanggrahan', 'Pesanggrahan', -6.2555, 106.7631, J, ['pesanggrahan']);
cpoi('tanjung-barat', 'Tanjung Barat', -6.3080, 106.8389, J, ['tanjung barat']);
cpoi('srengseng', 'Srengseng', -6.2065, 106.7541, J, ['srengseng'], true);
cpoi('sukapura', 'Sukapura', -6.1476, 106.9304, J, ['sukapura']);
// Makasar (Jakarta): rawan salah-baca sbg Makassar → wajib konteks Jakarta
CITY.push({ re: /(?:^| )(?:kecamatan |kec |di |ke )?makasar(?= jakarta| dki)(?= |$)/, e: { id: 'makasar', level: 'poi', name: 'Makasar, Jakarta', la: -6.2696, lo: 106.8887, prov: J, prec: 'poi' } });
CITY.push({ re: /(?:^| )(?:jakarta|dki)(?: [a-z]+){0,4} makasar(?= |$)/, e: { id: 'makasar', level: 'poi', name: 'Makasar, Jakarta', la: -6.2696, lo: 106.8887, prov: J, prec: 'poi' } });
/* ---- kota besar lain ---- */
cpoi('ciputat', 'Ciputat', -6.3111, 106.7184, 'Banten', ['ciputat']);
cpoi('stasiun-tugu', 'Stasiun Tugu, Yogyakarta', -7.7897, 110.3632, 'DI Yogyakarta', ['stasiun tugu']);
cpoi('sardjito', 'RSUP Dr Sardjito', -7.7689, 110.3725, 'DI Yogyakarta', ['rsup dr sardjito', 'sardjito']);
cpoi('mantrijeron', 'Mantrijeron', -7.8181, 110.3597, 'DI Yogyakarta', ['mantrijeron']);
cpoi('gondokusuman', 'Gondokusuman', -7.7867, 110.3810, 'DI Yogyakarta', ['gondokusuman']);
cpoi('umbulharjo', 'Umbulharjo', -7.8144, 110.3874, 'DI Yogyakarta', ['umbulharjo']);
cpoi('mlati', 'Mlati', -7.8013, 110.3647, 'DI Yogyakarta', ['mlati'], true);
cpoi('bandung-kota', 'Bandung Kota', -6.9143, 107.6021, 'Jawa Barat', ['bandung kota']);
cpoi('dago', 'Dago', -6.8750, 107.6160, 'Jawa Barat', ['dago']);
cpoi('cihampelas', 'Cihampelas', -6.8989, 107.6043, 'Jawa Barat', ['cihampelas']);
cpoi('gedung-sate', 'Gedung Sate', -6.9025, 107.6188, 'Jawa Barat', ['gedung sate']);
cpoi('wonokromo', 'Wonokromo', -7.3021, 112.7392, 'Jawa Timur', ['wonokromo']);
cpoi('rungkut', 'Rungkut', -7.3197, 112.7905, 'Jawa Timur', ['rungkut']);
cpoi('mulyorejo', 'Mulyorejo', -7.2680, 112.7935, 'Jawa Timur', ['mulyorejo']);
cpoi('gunungsari', 'Gunungsari', -7.2998, 112.7149, 'Jawa Timur', ['gunungsari']);
cpoi('sukolilo', 'Sukolilo', -7.2930, 112.7864, 'Jawa Timur', ['sukolilo']);
cpoi('siwalankerto', 'Siwalankerto', -7.3356, 112.7360, 'Jawa Timur', ['siwalankerto']);
cpoi('tandes', 'Tandes', -7.2551, 112.6740, 'Jawa Timur', ['tandes']);
cpoi('kenjeran', 'Kenjeran', -7.2202, 112.7716, 'Jawa Timur', ['kenjeran']);
cpoi('pasar-turi', 'Stasiun Pasar Turi', -7.2483, 112.7311, 'Jawa Timur', ['stasiun pasar turi']);
cpoi('juanda', 'Bandara Juanda', -7.3735, 112.7857, 'Jawa Timur', ['bandara juanda', 'juanda']);
cpoi('medan-kota', 'Medan Kota', 3.5730, 98.6889, 'Sumatera Utara', ['medan kota']);
cpoi('glugur', 'Glugur', 3.6099, 98.6749, 'Sumatera Utara', ['glugur']);
cpoi('polonia', 'Polonia', 3.5596, 98.6659, 'Sumatera Utara', ['polonia']);
cpoi('helvetia', 'Helvetia', 3.6070, 98.6305, 'Sumatera Utara', ['helvetia']);
cpoi('perumnas', 'Perumnas', 3.6952, 98.6873, 'Sumatera Utara', ['perumnas']);
cpoi('tamalanrea', 'Tamalanrea', -5.1105, 119.4695, 'Sulawesi Selatan', ['tamalanrea']);
cpoi('mariso', 'Mariso', -5.1553, 119.4069, 'Sulawesi Selatan', ['mariso']);
cpoi('tamalate', 'Tamalate', -5.1930, 119.3862, 'Sulawesi Selatan', ['tamalate']);
cpoi('panakkukang', 'Panakkukang', -5.1437, 119.4536, 'Sulawesi Selatan', ['panakkukang']);
cpoi('simpang-lima', 'Simpang Lima', -6.9893, 110.4236, 'Jawa Tengah', ['simpang lima']);
cpoi('banyumanik', 'Banyumanik', -7.0607, 110.4189, 'Jawa Tengah', ['banyumanik']);
cpoi('pedurungan', 'Pedurungan', -7.0012, 110.4761, 'Jawa Tengah', ['pedurungan']);
cpoi('genuk', 'Genuk', -6.9614, 110.4784, 'Jawa Tengah', ['genuk']);
cpoi('tembalang', 'Tembalang', -7.0601, 110.4466, 'Jawa Tengah', ['tembalang']);
cpoi('pasar-kliwon', 'Pasar Kliwon', -7.5836, 110.8286, 'Jawa Tengah', ['pasar kliwon']);
cpoi('jebres', 'Jebres', -7.5587, 110.8407, 'Jawa Tengah', ['jebres']);
cpoi('laweyan', 'Laweyan', -7.5700, 110.7969, 'Jawa Tengah', ['laweyan']);
cpoi('klojen', 'Klojen', -7.9771, 112.6340, 'Jawa Timur', ['klojen']);
cpoi('lowokwaru', 'Lowokwaru', -7.9563, 112.6324, 'Jawa Timur', ['lowokwaru']);
cpoi('sukun', 'Sukun', -7.9934, 112.6199, 'Jawa Timur', ['sukun'], true);
cpoi('blimbing', 'Blimbing', -7.9399, 112.6449, 'Jawa Timur', ['blimbing'], true);
cpoi('denpasar-barat', 'Denpasar Barat', -8.6609, 115.1961, 'Bali', ['denpasar barat']);
cpoi('denpasar-timur', 'Denpasar Timur', -8.6332, 115.2449, 'Bali', ['denpasar timur']);
cpoi('panjer', 'Panjer', -8.6842, 115.2271, 'Bali', ['panjer']);
cpoi('sanur', 'Sanur', -8.6946, 115.2606, 'Bali', ['sanur']);
cpoi('balikpapan-kota', 'Balikpapan Kota', -1.2671, 116.8230, 'Kalimantan Timur', ['balikpapan kota']);
cpoi('balikpapan-utara', 'Balikpapan Utara', -1.1536, 116.8828, 'Kalimantan Timur', ['balikpapan utara']);
cpoi('sepinggan', 'Sepinggan', -1.2431, 116.9201, 'Kalimantan Timur', ['sepinggan']);
cpoi('ilir-timur', 'Ilir Timur', -2.9762, 104.7419, 'Sumatera Selatan', ['ilir timur']);
cpoi('seberang-ulu', 'Seberang Ulu', -3.0245, 104.7800, 'Sumatera Selatan', ['seberang ulu']);
cpoi('kertapati', 'Kertapati', -3.0169, 104.7511, 'Sumatera Selatan', ['kertapati']);
cpoi('plaju', 'Plaju', -3.0104, 104.8215, 'Sumatera Selatan', ['plaju']);
cpoi('soekarno-hatta', 'Bandara Soekarno-Hatta', -6.1274, 106.6522, 'Banten', ['soekarno hatta', 'bandara soekarno hatta']);
cpoi('ngurah-rai', 'Bandara Ngurah Rai', -8.7420, 115.1637, 'Bali', ['ngurah rai', 'bandara ngurah rai']);
// 'genteng' (Genteng, Surabaya) & 'candi' (Candi, Semarang): kata umum → wajib tetangga kota
const cityE = (id, name, la, lo, prov) => ({ id, level: 'poi', name, la, lo, prov, prec: 'poi' });
CITY.push({ re: /(?:^| )(?:di|ke|kecamatan|kec) genteng(?= surabaya)(?= |$)/, e: cityE('genteng', 'Genteng, Surabaya', -7.2585, 112.7443, 'Jawa Timur') });
CITY.push({ re: /(?:^| )genteng(?= surabaya)(?= |$)/, e: cityE('genteng', 'Genteng, Surabaya', -7.2585, 112.7443, 'Jawa Timur') });
CITY.push({ re: /(?:^| )surabaya(?: [a-z]+){0,4} genteng(?= |$)/, e: cityE('genteng', 'Genteng, Surabaya', -7.2585, 112.7443, 'Jawa Timur') });
CITY.push({ re: /(?:^| )(?:di|ke|kecamatan|kec) candi(?= (?:kota |kabupaten )?semarang)(?= |$)/, e: cityE('candi', 'Candi, Semarang', -7.0107, 110.4290, 'Jawa Tengah') });
CITY.push({ re: /(?:^| )candi(?= (?:kota |kabupaten )?semarang)(?= |$)/, e: cityE('candi', 'Candi, Semarang', -7.0107, 110.4290, 'Jawa Tengah') });
CITY.push({ re: /(?:^| )semarang(?: [a-z]+){0,4} candi(?= |$)/, e: cityE('candi', 'Candi, Semarang', -7.0107, 110.4290, 'Jawa Tengah') });
for (const c of CITY) POI.push(c);

/* Kecamatan unik: hanya sah dengan penanda "kecamatan/kec" (nama kecamatan sering kata umum) */
const KEC_LOOSE = new Set(['di', 'ke', 'warga', 'wilayah', 'desa']);
const KEC_STOP = new Set(['kampung baru', 'pasar baru', 'tanjung raya', 'sungai raya', 'bukit raya', 'kota baru', 'pulau besar', 'air besar', 'indonesia raya', 'jalan raya', 'cipta karya', 'karya jaya', 'sumber jaya', 'harapan jaya', 'makmur jaya', 'mandiri jaya']);
const kecIdx = new Map(Object.entries(G.kec));

function locate(title) {
  const text = norm(title);
  if (!text || NOT_PLACE.test(text)) return null;
  const tk = text.split(' ');
  const cands = [];
  for (const { re, e } of POI) {
    const m = re.exec(' ' + text); if (!m) continue;
    // bonus cue dari token sebelum match — setara dengan loop idx di bawah,
    // supaya POI tidak kalah tipis dari kab+cue (mis. 'kembangan' = ibukota alias Jakarta Barat)
    let pc = 0;
    const before = (' ' + text).slice(0, m.index).trim().split(' ').pop() || '';
    if (CUE_IN.has(before) || before === 'di') pc += 1.5;
    if (PREFIX_KAB.has(before) || PREFIX_KOTA.has(before) || PREFIX_PROV.has(before)) pc += 0.5;
    cands.push({ e, pos: m.index, cue: pc + (e.id[0] === 'V' ? 1 : 0), score: LEVEL.poi });   // gunung api disebut = lokasi kejadian, mengalahkan kab tempat abu terpantau
  }

  const matched = [];  // untuk kec → butuh tahu kab/prov lain di judul
  const used = new Array(tk.length).fill(false);
  for (let i = 0; i < tk.length; i++) {
    if (used[i]) continue;
    for (let n = Math.min(4, tk.length - i); n >= 1; n--) {
      const key = tk.slice(i, i + n).join(' ');
      const list = idx.get(key);
      if (!list) continue;
      const prev = tk[i - 1] || '', prev2 = tk[i - 2] || '';
      if (AMBIG.has(key) && !(LOC_CUE.has(prev) || PREFIX_KAB.has(prev) || PREFIX_KOTA.has(prev))) { continue; }
      if (key === 'malaka' && prev === 'selat') continue;
      if (key === 'metro' && /^(jaya|tv)$/.test(tk[i + 1] || '')) continue;
      // pilih entri: prefix eksplisit > kota (bila kembar kab/kota) > pertama
      let e = list[0];
      if (list.length > 1) {
        const wantKab = PREFIX_KAB.has(prev) || (prev === 'kota' ? false : PREFIX_KAB.has(prev2));
        const wantKota = PREFIX_KOTA.has(prev) || PREFIX_KOTA.has(prev2) && !PREFIX_KAB.has(prev);
        e = (wantKab && list.find(x => x.level === 'kab' && !x.kota)) || (wantKota && list.find(x => x.kota)) || list.find(x => x.kota) || list[0];
      }
      if (e.level === 'prov' && PREFIX_PROV.has(prev)) { /* eksplisit */ }
      // Jakarta/Yogyakarta/Bali.. nama provinsi sama dengan kota: prefix "kota" memaksa kota, "provinsi" memaksa prov
      let cue = 0;
      if (CUE_IN.has(prev) || prev === 'di') cue += 1.5;
      if (CUE_FROM.has(prev)) cue -= 1.5;
      if (PREFIX_KAB.has(prev) || PREFIX_KOTA.has(prev) || PREFIX_PROV.has(prev)) cue += 0.5;
      if ((prev === 'ke' || prev === 'kepada') && DEST_VERB.has(prev2)) { for (let j = 0; j < n; j++) used[i + j] = true; break; }   // tujuan, bukan lokasi kejadian
      if (DEST_VERB.has(prev) && !PREFIX_KAB.has(prev)) { for (let j = 0; j < n; j++) used[i + j] = true; break; }
      cands.push({ e, pos: i, n, cue, score: LEVEL[e.level], key });
      matched.push(e);
      for (let j = 0; j < n; j++) used[i + j] = true;
      break;
    }
  }
  // kecamatan: sah dengan "kecamatan/kec", atau tanpa prefix bila namanya khas (>=2 kata / >=9 huruf),
  // unik secara nasional, dan didahului penanda lokatif (di/ke/warga/wilayah)
  for (let i = 0; i < tk.length; i++) {
    const prev = tk[i - 1] || '';
    const explicit = PREFIX_KEC.has(prev), loose = !explicit && KEC_LOOSE.has(prev);
    if (!explicit && !loose) continue;
    for (let n = Math.min(3, tk.length - i); n >= 1; n--) {
      const key = tk.slice(i, i + n).join(' ');
      const parents = kecIdx.get(key);
      if (!parents) continue;
      if (loose && (parents.length !== 1 || (n === 1 && key.length < 9) || KEC_STOP.has(key) || used.slice(i, i + n).some(Boolean))) break;
      const pc = parents.length === 1 ? parents[0] : parents.find(c => matched.some(m => m.id === c || (m.level === 'prov' && m.prov === (kabByCode[c] || {}).prov)));
      if (!pc || !kabByCode[pc]) break;
      cands.push({ e: { ...kabByCode[pc], prec: 'kec' }, pos: i, cue: 1.5, score: LEVEL.kec, key });
      break;
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (b.score + b.cue) - (a.score + a.cue) || a.pos - b.pos);
  const best = cands[0];
  const e = best.e;
  // beberapa tempat sederajat yang disebut berurutan ("Aceh, Jawa Tengah dan Jawa Timur") → semuanya titik sah, bukan cuma yang pertama
  let all = [];
  if (best.n && (e.level === 'kab' || e.level === 'prov' || e.level === 'region')) {
    const same = cands.filter(c => c.n && c.e.level === e.level && c.cue >= 0).sort((a, b) => a.pos - b.pos);
    const seen = new Set(); const uniq = same.filter(c => !seen.has(c.e.id) && seen.add(c.e.id));
    if (uniq.length > 1 && uniq.some(c => c.e.id === e.id)) {
      const chain = [uniq[0]];
      for (let q = 1; q < uniq.length; q++) {
        const prevC = chain[chain.length - 1], gap = tk.slice(prevC.pos + prevC.n, uniq[q].pos);
        if (gap.length <= 2 && gap.every(w => SEP_OK.has(w))) chain.push(uniq[q]); else break;
      }
      if (chain.length > 1 && chain.some(c => c.e.id === e.id)) all = chain.slice(0, 4).map(c => ({ name: c.e.name, la: c.e.la, lo: c.e.lo, prec: c.e.prec, prov: c.e.prov }));
    }
  }
  return { name: e.name, la: e.la, lo: e.lo, prec: e.prec, prov: e.prov, via: best.key || e.id, all };
}

/* daftar node pemantauan tetap: semua kab/kota (pusat pemerintahan) */
const NODES = G.kab.map(k => kabByCode[k.code]).map(e => ({ name: e.name, la: e.la, lo: e.lo, prov: e.prov }));

module.exports = { locate, NODES, norm, stats: () => ({ keys: idx.size, kab: G.kab.length, prov: G.prov.length, kec: kecIdx.size, poi: POI.length }) };
