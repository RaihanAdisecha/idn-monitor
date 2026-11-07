#!/usr/bin/env node
/* Uji geocoder: (1) semua koordinat yang dipakai harus di daratan, (2) set judul emas (lokasi benar / harus null).
   node tests/geo.test.js   -> exit 1 bila ada yang gagal. Tambah kasus baru tiap ketemu false positive. */
const GEO = require('../geocode'), { onLand, nearestLand } = require('../scripts/geo-audit');
const G = require('../geo/gazetteer.json');
let fail = 0; const bad = (m) => { fail++; console.log('GAGAL  ' + m); };

// 1. koordinat di daratan (pulau kecil yang tak ada di poligon dikecualikan eksplisit)
const ISLAND_OK = ['Kepulauan Seribu'];   // juga: gunung api pulau mungil (Ruang, dll) memakai koordinat PVMBG asli, tidak diuji terhadap poligon
for (const n of GEO.NODES) {
  if (ISLAND_OK.some(x => n.name.includes(x))) continue;
  if (!onLand(n.lo, n.la)) bad(`node di laut: ${n.name} (${nearestLand(n.lo, n.la).km.toFixed(1)} km dari pantai)`);
}
for (const p of G.prov) {
  const r = GEO.locate('Banjir di Provinsi ' + p.name);
  if (!r) { bad('provinsi tidak ter-geocode: ' + p.name); continue; }
  if (!onLand(r.lo, r.la)) bad(`provinsi di laut: ${p.name} (${nearestLand(r.lo, r.la).km.toFixed(1)} km)`);
}
for (const t of ['Banjir di Flores', 'Gempa di Lombok', 'Banjir di Sumba', 'Banjir di Halmahera', 'Erupsi Gunung Semeru', 'Erupsi Ili Lewotolok', 'Erupsi Gunung Merapi', 'Erupsi Gunung Karangetang', 'Demo di depan Istana Merdeka', 'Demo di Gedung DPR']) {
  const r = GEO.locate(t); if (!r) { bad('POI/region tidak ketemu: ' + t); continue; }
  if (!onLand(r.lo, r.la)) bad(`POI/region di laut: ${t} -> ${r.name} (${nearestLand(r.lo, r.la).km.toFixed(1)} km)`);
}

// 2. set emas: [judul, nama yang diharapkan | null, (opsional) daftar multi]
const GOLD = [
  ['BPBD: Semua Kecamatan di Kota Malang Rawan Terdampak Bencana', 'Malang'],
  ['Atap Aula Kelurahan Limusnunggal Sukabumi Ambruk', 'Sukabumi'],
  ['Pemkab Barito Selatan Perpanjang Status Tanggap Darurat Karhutla', 'Barito Selatan'],
  ['Marapi Erupsi Sabtu pagi, sebaran abu vulkanik terpantau di Agam', 'Gunung Marapi'],
  ['Kebakaran Pasar di Kota Bandung Hanguskan 20 Kios', 'Bandung'],
  ['Banjir Rendam Kabupaten Bandung, Ratusan Warga Mengungsi', 'Kab. Bandung'],
  ['Aktivitas Erupsi Gunung Ile Lewotolok di NTT Masih Tinggi', 'Gunung Lewotolok'],
  ['Demo Buruh di Kantor Gubernur Jawa Barat Tuntut UMP Naik', 'Jawa Barat'],
  ['Gempa M5,2 Guncang Cilacap, Warga Panik', 'Cilacap'],
  ['Kecelakaan Bus di Tol Cipali Tewaskan 5 Orang', null],            // nama jalan tol bukan kab
  ['Metro TV Gelar Diskusi Soal Ekonomi', null],                      // institusi, bukan Kota Metro
  ['Harga Batu Bara Naik di Pasar Global', null],                     // Batu Bara bukan kabupaten di sini
  ['Serangan Balik Pemain Persija Bikin Gol', null],                  // "serang" bukan Kota Serang
  ['Jenazah korban kecelakaan helikopter dipulangkan ke Jawa Tengah', null],        // tujuan, bukan kejadian
  ['Korban dilarikan ke RSUD Bandung usai kecelakaan di Cilegon', 'Cilegon'],       // RS tujuan diabaikan
  ['Gerak Cepat Pemerintah Tangani Banjir di Aceh dan Sumatra Utara', 'Aceh', ['Aceh', 'Sumatera Utara']],
  ['Longsor di Aceh, Jawa Tengah dan Jawa Timur Telan Korban', 'Aceh', ['Aceh', 'Jawa Tengah', 'Jawa Timur']],
  ['Pria Asal Bogor Ditangkap di Cilegon karena Curanmor', 'Cilegon'],             // asal bukan lokasi
];
for (const [t, exp, multi] of GOLD) {
  const r = GEO.locate(t), got = r && r.name;
  if (got !== exp) bad(`"${t}" -> ${got} (harusnya ${exp})`);
  if (multi) { const all = (r && r.all || []).map(x => x.name); if (JSON.stringify(all) !== JSON.stringify(multi)) bad(`multi "${t}" -> ${JSON.stringify(all)} (harusnya ${JSON.stringify(multi)})`); }
}
console.log(fail ? `\n${fail} kegagalan` : `OK: ${GEO.NODES.length} node, ${G.prov.length} provinsi, ${GOLD.length} judul emas`);
process.exit(fail ? 1 : 0);
