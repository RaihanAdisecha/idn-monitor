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

/* Kecamatan unik: hanya sah dengan penanda "kecamatan/kec" (nama kecamatan sering kata umum) */
const KEC_LOOSE = new Set(['di', 'ke', 'warga', 'wilayah', 'desa']);
const KEC_STOP = new Set(['kampung baru', 'pasar baru', 'tanjung raya', 'sungai raya', 'bukit raya', 'kota baru', 'pulau besar', 'air besar', 'indonesia raya', 'jalan raya', 'cipta karya', 'karya jaya', 'sumber jaya', 'harapan jaya', 'makmur jaya', 'mandiri jaya']);
const kecIdx = new Map(Object.entries(G.kec));

function locate(title) {
  const text = norm(title);
  if (!text || NOT_PLACE.test(text)) return null;
  const tk = text.split(' ');
  const cands = [];
  for (const { re, e } of POI) { const m = re.exec(' ' + text); if (m) cands.push({ e, pos: m.index, cue: e.id[0] === 'V' ? 1 : 0, score: LEVEL.poi }); }   // gunung api disebut = lokasi kejadian, mengalahkan kab tempat abu terpantau

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
