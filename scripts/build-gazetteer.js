#!/usr/bin/env node
/* Bangun geo/gazetteer.json dari cahyadsn/wilayah (Kepmendagri 300.2.2-2138/2025, MIT).
   Isi: provinsi (centroid = rata-rata pusat kab/kota), 514 kab/kota (koordinat pusat pemerintahan),
   dan kecamatan unik → kab induk. Jalankan: node scripts/build-gazetteer.js */
const fs = require('fs'), path = require('path');
const BASE = 'https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/';
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
(async () => {
  const get = async f => (await fetch(BASE + f)).text();
  const [l12, all] = await Promise.all([get('wilayah_level_1_2.sql'), get('wilayah.sql')]);
  const prov = {}, kab = [];
  const rowRe = /^\('([\d.]+)','((?:[^']|'')*)','((?:[^']|'')*)',\s*(-?[\d.]+),\s*(-?[\d.]+)/;
  for (const line of l12.split('\n')) {
    const m = rowRe.exec(line); if (!m) continue;
    const code = m[1], name = m[2].replace(/''/g, "'"), la = +m[4], lo = +m[5];
    if (!isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0)) continue;
    if (!code.includes('.')) prov[code] = { code, name, la, lo };
    else if (code.split('.').length === 2) {
      const kota = /^Kota /.test(name);
      kab.push({ code, name: name.replace(/^(Kabupaten|Kota Administrasi|Kota) /, ''), kota, ibukota: m[3].replace(/''/g, "'"), la, lo, prov: code.split('.')[0] });
    }
  }
  // koreksi manual untuk anomali sumber (diverifikasi: Wakatobi ~ -5.33,123.54)
  const FIX = { 'Wakatobi': { lo: 123.54 } };
  for (const k of kab) if (FIX[k.name]) Object.assign(k, FIX[k.name]);
  // sanity: semua titik harus di dalam bbox Indonesia
  for (const k of kab) if (k.la > 6.2 || k.la < -11.1 || k.lo < 94.9 || k.lo > 141.1) throw new Error('koordinat di luar Indonesia: ' + k.name);
  // centroid provinsi = rata-rata pusat kab/kota di dalamnya
  const acc = {};
  for (const k of kab) { const a = acc[k.prov] || (acc[k.prov] = { la: 0, lo: 0, n: 0 }); a.la += k.la; a.lo += k.lo; a.n++; }
  for (const p of Object.values(prov)) { const a = acc[p.code]; if (a) { p.la = +(a.la / a.n).toFixed(4); p.lo = +(a.lo / a.n).toFixed(4); } }
  // kecamatan: nama unik → daftar kab induk
  const kec = {};
  for (const line of all.split('\n')) {
    const m = /^\('(\d\d\.\d\d\.\d\d)','((?:[^']|'')*)'\)/.exec(line); if (!m) continue;
    const n = norm(m[2].replace(/''/g, "'")); if (n.length < 5) continue;
    const kc = m[1].slice(0, 5);
    (kec[n] || (kec[n] = new Set())).add(kc);
  }
  const kecOut = {};
  for (const [n, s] of Object.entries(kec)) kecOut[n] = [...s];
  const out = { src: 'cahyadsn/wilayah (Kepmendagri 300.2.2-2138/2025)', prov: Object.values(prov), kab, kec: kecOut };
  fs.mkdirSync(path.join(__dirname, '..', 'geo'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'geo', 'gazetteer.json'), JSON.stringify(out));
  console.log('prov', out.prov.length, 'kab/kota', kab.length, 'kec', Object.keys(kecOut).length);
})();
