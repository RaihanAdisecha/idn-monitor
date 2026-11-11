'use strict';

const breakNorm = t => String(t).toLowerCase().replace(/\s+-\s+[^-]{2,45}$/, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu minggu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri').split(' '));

const EV_GENERIC = new Set([...TSTOP,

  'kebakaran','karhutla','banjir','gempa','guncang','kecelakaan','tabrak','tabrakan','tawuran',
  'longsor','demo','unjuk','rasa','massa','damkar','pemadam','waspada','peringatan','tertimpa',
  'menimpa','luka','tewas','tewaskan','meninggal','korban','evakuasi','ditangkap','terbakar',
  'meluas','amblas','rob','genangan','macet','terpampang','terkunci','terdampak','erupsi',
  'letusan','penembakan','pembakaran','penangkapan','pembunuhan','pencurian','perampokan',
  'penyelundupan','penggerebekan','penemuan','ledakan','bentrok','kerusuhan','penganiayaan',
  'penipuan','korupsi','narkoba','sabu','senjata','bom','kebocoran','pencemaran','kekeringan',

  'rumah','jalan','gedung','kantor','sekolah','kampus','pasar','warung','toko','pabrik','gudang',
  'terminal','stasiun','bandara','pelabuhan','jembatan','sungai','desa','kampung','kelurahan',
  'kecamatan','kota','kabupaten','provinsi','tol','ruas','lahan','hutan','hektare','hektar',
  'mobil','motor','truk','bus','angkot','kereta','kapal','pesawat','helikopter',
  'warga','pelaku','tersangka','siswa','mahasiswa','guru','petani','nelayan','buruh','pemuda',
  'pria','wanita','orang','masyarakat','keluarga','remaja',

  'pemerintah','pemkot','pemkab','gubernur','bupati','walikota','menteri','presiden','dpr',
  'dprd','polisi','polda','polres','tni','bpbd','bnpb','dinas','badan','komisi','kementerian',
  'pemprov','pemda','satpol','dishub','puskesmas','rumahsakit',

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

  const eidDiscriminators = (title, pk) => {
    const pt = new Set(pk.split(' '));
    return [...new Set(bn(title).split(' ').filter(w => w.length >= 3 && !TSTOP.has(w) && !pt.has(w)))].sort();
  };

  const prevByKey = new Map();
  for (const pp of (prevPins || [])) {
    if (!pp || !pp.eid || pp.kind === 'node' || typeof pp.name !== 'string') continue;
    const k = pp.kind + '|' + normPlace(pp.name);
    if (!prevByKey.has(k)) prevByKey.set(k, []);
    prevByKey.get(k).push(pp);
  }

  const groups = new Map();
  const groupDf = new Map();
  for (const p of (out || [])) {
    const pk = normPlace(p.name);
    const key = p.kind + '|' + pk;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ p, rs: rare(p.title, pk) });
  }
  for (const [, members0] of groups) {
    const seenInGroup = new Set();
    for (const m of members0) for (const t of m.rs) seenInGroup.add(t);
    for (const t of seenInGroup) groupDf.set(t, (groupDf.get(t) || 0) + 1);
  }

  const merged = [];
  const used = new Set();
  for (const [key, members0] of groups) {
    const cut = key.indexOf('|');
    const cat = key.slice(0, cut), pk = key.slice(cut + 1);

    members0.sort((a, b) => repScore(b.p) - repScore(a.p) || (b.p.ts || 0) - (a.p.ts || 0));
    const hz = members0.map(m => hazardOf(m.p.title));

    const n = members0.length;
    const df = new Map();
    for (const m of members0) for (const t of m.rs) df.set(t, (df.get(t) || 0) + 1);
    const dfMax = Math.max(2, Math.floor(n * 0.3));
    const eff = members0.map(m => new Set([...m.rs].filter(t => (df.get(t) || 0) <= dfMax || (groupDf.get(t) || 0) < 3)));

    const sharedCount = (i, j) => { let c = 0; for (const t of eff[i]) if (eff[j].has(t)) c++; return c; };

    const sameHaz = (i, j) => (cat === 'disaster' || cat === 'flood') && hz[i] && hz[i] === hz[j] &&
      Math.abs((members0[i].p.ts || 0) - (members0[j].p.ts || 0)) <= (hz[i] === 'flood' ? 6 : 12) * 3600e3;

    const cls = [];
    members0.forEach((m, i) => {
      const cl = cls.find(c => sharedCount(c.rep, i) >= 2 || sameHaz(c.rep, i));
      if (cl) cl.members.push(i); else cls.push({ rep: i, members: [i] });
    });

    for (const { members: idxs } of cls) {
      const members = idxs.map(i => members0[i]);
      members.sort((a, b) => repScore(b.p) - repScore(a.p) || (b.p.ts || 0) - (a.p.ts || 0));
      const rep = members[0].p;
      const hzRep = hazardOf(rep.title);
      const rareU = new Set();
      members.forEach(m => m.rs.forEach(t => rareU.add(t)));
      const newestTs = Math.max(...members.map(m => m.p.ts || 0));
      const earliestTs = Math.min(...members.map(m => m.p.ts || newestTs || 0));
      let eid = '';
      for (const pp of (prevByKey.get(key) || [])) {
        if (used.has(pp.eid)) continue;
        if (newestTs && pp.ts && Math.abs(newestTs - pp.ts) > 24 * 3600e3) continue;
        const pr = new Set(Array.isArray(pp.rt) && pp.rt.length ? pp.rt : [...rare(pp.title, pk)]);
        let shared = 0;
        for (const t of rareU) if (pr.has(t)) shared++;
        const sameExact = rareU.size === 0 && pr.size === 0 && bn(pp.title) === bn(rep.title);
        const singleExact = rareU.size === 1 && pr.size === 1 && shared === 1 && (!newestTs || !pp.ts || Math.abs(newestTs - pp.ts) <= 6 * 3600e3);
        const sameHazPrev = (cat === 'disaster' || cat === 'flood') && hzRep && hzRep === hazardOf(pp.title) &&
          (!newestTs || !pp.ts || Math.abs(newestTs - pp.ts) <= (hzRep === 'flood' ? 6 : 12) * 3600e3);
        if (shared >= 2 || singleExact || sameExact || sameHazPrev) {
          eid = pp.eid; used.add(eid); break;
        }
      }
      if (!eid) {
        const seedTokens = rareU.size
          ? [...rareU].sort().join(',')
          : (eidDiscriminators(rep.title, pk).join(',') || bn(rep.title)) + '@' + Math.floor((earliestTs || 0) / (12 * 3600e3));
        eid = 'e' + hash(cat + '|' + pk + '|' + seedTokens);
        if (used.has(eid)) {
          eid = 'e' + hash(cat + '|' + pk + '|' + bn(rep.title) + '|' + used.size);
        }
        used.add(eid);
      }

      const item = { ...rep, eid, rt: [...rareU], reportedTs: rep.ts || 0, lastSeenTs: newestTs, ts: newestTs };
      if (members.length > 1) item.n = members.length;
      merged.push(item);
    }
  }
  return merged;
}

module.exports = { mergeEvents, evRare: (t, pk) => { const pt = new Set(String(pk || '').split(' ')); return new Set(breakNorm(t).split(' ').filter(w => w.length >= 5 && !EV_GENERIC.has(w) && !pt.has(w))); }, EV_GENERIC, TSTOP, breakNorm, hazardOf, repScore, evHash };
