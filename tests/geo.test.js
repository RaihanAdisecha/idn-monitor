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
  ['Atap Aula Kelurahan Limusnunggal Sukabumi Ambruk', 'Kelurahan Limusnunggal, Kecamatan Cibeureum, Sukabumi, Jawa Barat'],
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
// 3. BIG desa/kelurahan: centroids, parent disambiguation, POI precedence, and no arbitrary duplicate-name pick.
const stats = GEO.stats();
if (GEO.NODES.length !== 514) bad(`NODES memuat ${GEO.NODES.length} titik tetap, seharusnya hanya 514 kab/kota`);
if (stats.villages !== 83529 || stats.desa !== 75034 || stats.kelurahan !== 8495) bad(`statistik BIG tidak sesuai: ${JSON.stringify(stats)}`);
const BIG_GOLD = [
  ['Kebakaran di Kelurahan Gambir, Jakarta Pusat', '31.71.01.1001', 'kelurahan', -6.176377, 106.826707],
  ['Banjir di Desa Keude Bakongan, Kecamatan Bakongan, Kabupaten Aceh Selatan', '11.01.01.2001', 'desa', 2.93109, 97.48459],
  ['Banjir di Desa Limusnunggal, Kecamatan Cileungsi, Kabupaten Bogor', '32.01.07.2011', 'desa', -6.375136, 106.96945],
  ['Banjir di Desa Limusnunggal, Kecamatan Bantargadung, Kabupaten Sukabumi', '32.02.04.2004', 'desa', -6.956538, 106.640443],
  ['Atap Aula Kelurahan Limusnunggal Sukabumi Ambruk', '32.72.07.1004', 'kelurahan', -6.947022, 106.941743],
  ['Banjir di Desa Sukamaju, Kecamatan Bantan, Kabupaten Bengkalis', '14.03.02.2015', 'desa', 1.479932, 102.400612],
];
for (const [title, code, prec, la, lo] of BIG_GOLD) {
  const r = GEO.locate(title);
  if (!r) { bad(`BIG tidak menemukan: ${title}`); continue; }
  if (r.code !== code || r.prec !== prec) bad(`BIG salah administrasi untuk "${title}": ${r.code}/${r.prec}, seharusnya ${code}/${prec}`);
  if (Math.abs(r.la - la) > 1e-9 || Math.abs(r.lo - lo) > 1e-9) bad(`BIG salah koordinat untuk "${title}": ${r.la},${r.lo}`);
  if (r.coordinateSource !== 'BIG administrative polygon centroid' || !r.boundaryStatus) bad(`metadata centroid BIG hilang untuk "${title}"`);
}
const ambiguousVillage = GEO.locate('Banjir di Desa Limusnunggal');
if (ambiguousVillage) bad(`nama desa ambigu dipilih tanpa konteks: ${JSON.stringify(ambiguousVillage)}`);
for (const title of ['Gempa di Jepang', 'Gempa di London']) {
  if (GEO.locate(title)) bad(`nama negara/kota asing tersangkut ke nama desa lokal: ${title}`);
}
const stationVillageTitle = GEO.locate('Kebakaran di Stasiun Gambir, Kelurahan Gambir');
if (!stationVillageTitle || stationVillageTitle.prec !== 'poi' || stationVillageTitle.la !== -6.1767 || stationVillageTitle.lo !== 106.8306) bad(`POI spesifik Stasiun Gambir kalah dari centroid kelurahan: ${JSON.stringify(stationVillageTitle)}`);
const kecFallback = GEO.locate('Banjir di Kecamatan Huta Bayu Raja');
if (!kecFallback || kecFallback.prec !== 'kec' || !kecFallback.name.includes('Huta Bayu Raja')) bad(`fallback kecamatan BIG hilang: ${JSON.stringify(kecFallback)}`);
const okIlir = GEO.locate('Banjir di Ogan Komering Ilir');
if (!okIlir || okIlir.prec !== 'kab' || !okIlir.name.includes('Ogan Komering Ilir')) bad(`alias kabupaten BIG hilang: ${JSON.stringify(okIlir)}`);
console.log(fail ? `\n${fail} kegagalan` : `OK: ${GEO.NODES.length} node, ${G.prov.length} provinsi, ${GOLD.length} judul emas, ${BIG_GOLD.length} koordinat BIG`);
process.exit(fail ? 1 : 0);
