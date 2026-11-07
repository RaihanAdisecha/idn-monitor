'use strict';
/* Event-level merge untuk pin insiden: satu peristiwa = satu pin.
   Dipisah dari server.js supaya bisa dites tanpa menyalakan server.

   Aturan:
   - grup = kind + tempat (tempat sudah dinormalisasi)
   - dua artikel menyatu kalau berbagi token langka (>=5 huruf, bukan kata umum/topik/nama tempat)
   - bencana alam dengan jenis sama di tempat sama dalam jendela waktu singkat menyatu
     (gempa + gempa susulan), karena judul BMKG sering tidak berbagi entitas apa pun
   - eid diwarisi dari pin sebelumnya secara eksklusif, lalu disimpan di item.rt
     supaya stabilitas tidak bergantung pada judul representative
*/

const breakNorm = t => String(t).toLowerCase().replace(/\s+-\s+[^-]{2,45}$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu minggu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri').split(' '));

const EV_GENERIC = new Set([...TSTOP,
  // jenis kejadian: topik, bukan entitas
  'kebakaran','karhutla','banjir','gempa','guncang','kecelakaan','tabrak','tabrakan','tawuran',
  'longsor','demo','unjuk','rasa','massa','damkar','pemadam','waspada','peringatan','tertimpa',
  'menimpa','luka','tewas','tewaskan','meninggal','korban','evakuasi','ditangkap','terbakar',
  'meluas','amblas','rob','genangan','macet','terpampang','terkunci','terdampak','erupsi',
  'letusan','penembakan','pembakaran','penangkapan','pembunuhan','pencurian','perampokan',
  'penyelundupan','penggerebekan','penemuan','ledakan','bentrok','kerusuhan','penganiayaan',
  'penipuan','korupsi','narkoba','sabu','senjata','bom','kebocoran','pencemaran','kekeringan',
  // benda/tipe tempat: bukan identitas peristiwa
  'rumah','jalan','gedung','kantor','sekolah','kampus','pasar','warung','toko','pabrik','gudang',
  'terminal','stasiun','bandara','pelabuhan','jembatan','sungai','desa','kampung','kelurahan',
  'kecamatan','kota','kabupaten','provinsi','tol','ruas','lahan','hutan','hektare','hektar',
  'mobil','motor','truk','bus','angkot','kereta','kapal','pesawat','helikopter',
  'warga','pelaku','tersangka','siswa','mahasiswa','guru','petani','nelayan','buruh','pemuda',
  'pria','wanita','orang','masyarakat','keluarga','remaja',
  // aktor/kebijakan: hampir selalu muncul di banyak berita berbeda
  'pemerintah','pemkot','pemkab','gubernur','bupati','walikota','menteri','presiden','dpr',
  'dprd','polisi','polda','polres','tni','bpbd','bnpb','dinas','badan','komisi','kementerian',
  'pemprov','pemda','satpol','dishub','puskesmas','rumahsakit',
  // provinsi: place key sudah memisahkan, token ini cuma noise
  'kalteng','kaltim','kalsel','kalbar','kaltara','jateng','jatim','jabar','sumut','sumbar',
  'sumsel','kepri','sulut','sulteng','sulsel','sultra','sulbar','malut','ntb','ntt','diy'
]);

const HAZARD = [
  ['gempa', /\b(?:gempa|gempabumi|tektonik|sesar|aftershock|susulan)\b/i],
  ['erupsi', /\b(?:erupsi|letusan|awan panas|vulkanik)\b/i],
  ['flood', /\b(?:banjir|longsor|genangan)\b/i]
];
const hazardOf = t => { for (const [k, re] of HAZARD) if (re.test(t)) return k; return ''; };

const BAD_REP = /\b(?:video|foto|komentar|opini|analisis|kolom|kata|menurut|sebut|harap|minta|imbau|dukung|kecam|respons|tanggapi|program|inovasi|sosialisasi|edukasi|kesiapsiagaan|mitigasi|pencegahan|peringatan|tinjau|kunjungi|resmikan|launching|pelatihan|simulasi)\b/i;
const GOOD_REP = /\b(?:kebakaran|banjir|gempa|erupsi|letusan|longsor|tabrakan|kecelakaan|pembakaran|penembakan|tewas|tewaskan|meninggal|luka|korban|evakuasi|terbakar|ambruk|tertimpa|terendam|hanyut|hilang|diselamatkan|ditangkap)\b/i;

/* Representative dipilih dari kualitas laporan, bukan cuma yang paling baru.
   Tanpa ini, pin bisa berjudul komentar pejabat atau video pemakaman. */
const repScore = p => {
  const t = String((p && (p.title || p.name)) || '');
  let s = 0;
  if (GOOD_REP.test(t)) s += 2;
  if (BAD_REP.test(t)) s -= 3;
  if (/^\s*(?:video|foto)\b/i.test(t)) s -= 2;
  return s;
};

const evHash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };

function mergeEvents(out, prevPins, opts) {
  opts = opts || {};
  const normPlace = opts.normPlace || (s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
  const bn = opts.breakNorm || breakNorm;
  const hash = opts.evHash || evHash;
  const rare = (title, pk) => {
    const pt = new Set(pk.split(' '));
    return new Set(bn(title).split(' ').filter(w => w.length >= 5 && !EV_GENERIC.has(w) && !pt.has(w)));
  };

  const prevByKey = new Map();
  for (const pp of (prevPins || [])) {
    if (!pp || !pp.eid || pp.kind === 'node' || typeof pp.name !== 'string') continue;
    const k = pp.kind + '|' + normPlace(pp.name);
    if (!prevByKey.has(k)) prevByKey.set(k, []);
    prevByKey.get(k).push(pp);
  }

  const groups = new Map();
  for (const p of (out || [])) {
    const pk = normPlace(p.name);
    const key = p.kind + '|' + pk;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ p, rs: rare(p.title, pk) });
  }

  const merged = [];
  for (const [key, members0] of groups) {
    const cut = key.indexOf('|');
    const cat = key.slice(0, cut), pk = key.slice(cut + 1);
    const hz = members0.map(m => hazardOf(m.p.title));
    const parent = members0.map((_, i) => i);
    const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < members0.length; i++) for (let j = i + 1; j < members0.length; j++) {
      let shared = 0;
      for (const t of members0[i].rs) if (members0[j].rs.has(t)) { shared++; break; }
      // gempa/erupsi/banjir di tempat sama dalam jendela singkat = satu rangkaian peristiwa,
      // walau judul BMKG tidak berbagi entitas (Sigi: "sesar palolo" vs "gempa susulan")
      const sameHaz = (cat === 'disaster' || cat === 'flood') && hz[i] && hz[i] === hz[j] &&
        Math.abs((members0[i].p.ts || 0) - (members0[j].p.ts || 0)) <= (hz[i] === 'flood' ? 6 : 12) * 3600e3;
      if (shared || sameHaz) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }

    const cls = new Map();
    members0.forEach((m, i) => { const r = find(i); if (!cls.has(r)) cls.set(r, []); cls.get(r).push(m); });

    const used = new Set();   // prev eid hanya boleh diklaim satu cluster
    for (const members of cls.values()) {
      members.sort((a, b) => repScore(b.p) - repScore(a.p) || (b.p.ts || 0) - (a.p.ts || 0));
      const rep = members[0].p;
      const rareU = new Set();
      members.forEach(m => m.rs.forEach(t => rareU.add(t)));
      let eid = '';
      for (const pp of (prevByKey.get(key) || [])) {
        if (used.has(pp.eid)) continue;
        const pr = new Set(Array.isArray(pp.rt) && pp.rt.length ? pp.rt : [...rare(pp.title, pk)]);
        if ([...rareU].some(t => pr.has(t))) { eid = pp.eid; used.add(eid); break; }
      }
      if (!eid) { eid = 'e' + hash(cat + '|' + pk + '|' + [...rareU].sort().join(',')); used.add(eid); }
      // ts event = artikel terbaru dalam cluster, bukan ts rep — pin tetap
      // "panas" untuk fokus walau representative-nya artikel yang lebih tua
      const item = { ...rep, eid, rt: [...rareU], ts: Math.max(...members.map(m => m.p.ts || 0)) };
      if (members.length > 1) item.n = members.length;
      merged.push(item);
    }
  }
  return merged;
}

module.exports = { mergeEvents, evRare: (t, pk) => { const pt = new Set(String(pk || '').split(' ')); return new Set(breakNorm(t).split(' ').filter(w => w.length >= 5 && !EV_GENERIC.has(w) && !pt.has(w))); }, EV_GENERIC, TSTOP, breakNorm, hazardOf, repScore, evHash };
