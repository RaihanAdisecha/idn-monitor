#!/usr/bin/env node
/* Audit + perbaikan koordinat gazetteer terhadap daratan Indonesia (public/idn.geo.json, Natural Earth 10m).
   node scripts/geo-audit.js          -> laporan titik di laut (kab, provinsi, POI, region)
   node scripts/geo-audit.js --write  -> tulis geo/coord-fixes.json (dipakai geocode.js saat load)
   Aturan: pulau-pulau kecil yang memang tidak ada di poligon (ISLAND_OK) dibiarkan; selain itu titik <= 12 km dari
   pantai digeser ke daratan terdekat (+ dorongan ~200 m ke dalam); provinsi yang centroid-nya di laut pindah ke ibukota provinsi. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const G = require(path.join(root, 'geo', 'gazetteer.json'));
const land = JSON.parse(fs.readFileSync(path.join(root, 'public', 'idn.geo.json'), 'utf8'));
const polys = [];
for (const f of land.features) { const g = f.geometry; for (const p of (g.type === 'Polygon' ? [g.coordinates] : g.coordinates)) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, y] of p[0]) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
  polys.push({ p, bb: [a, b, c, d] }); } }
const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const onLand = (lo, la) => polys.some(({ p, bb }) => lo >= bb[0] && lo <= bb[2] && la >= bb[1] && la <= bb[3] && inRing(p[0], lo, la) && !p.slice(1).some(h => inRing(h, lo, la)));
const km = (lo1, la1, lo2, la2) => Math.hypot((lo1 - lo2) * 111.32 * Math.cos(la1 * Math.PI / 180), (la1 - la2) * 110.57);
function nearestLand(lo, la) {   // titik terdekat pada garis pantai (proyeksi ke segmen, bukan cuma vertex)
  let best = null, m = 1e9;
  for (const { p, bb } of polys) {
    if (lo < bb[0] - 1 || lo > bb[2] + 1 || la < bb[1] - 1 || la > bb[3] + 1) continue;
    for (const r of p) for (let i = 1; i < r.length; i++) {
      const [ax, ay] = r[i - 1], [bx, by] = r[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((lo - ax) * dx + (la - ay) * dy) / L)) : 0, px = ax + t * dx, py = ay + t * dy, d = km(lo, la, px, py);
      if (d < m) { m = d; best = [px, py]; } } }
  return { pt: best, km: m };
}
function pushInland(pt) {   // geser ~200 m ke arah yang masih daratan
  const [x, y] = pt;
  for (const r of [0.0018, 0.003, 0.006]) for (let a = 0; a < 16; a++) {
    const lo = x + Math.cos(a * Math.PI / 8) * r, la = y + Math.sin(a * Math.PI / 8) * r;
    if (onLand(lo, la)) return [lo, la]; }
  return null;
}
const ISLAND_OK = ['Kepulauan Seribu'];   // ibukota di pulau kecil yang tidak muncul di poligon
const PROV_CAP = { '11': 'Banda Aceh', '12': 'Medan', '13': 'Padang', '14': 'Pekanbaru', '15': 'Jambi', '16': 'Palembang', '17': 'Bengkulu', '18': 'Bandar Lampung',
  '19': 'Pangkal Pinang', '21': 'Tanjung Pinang', '31': 'Jakarta Pusat', '32': 'Bandung', '33': 'Semarang', '34': 'Yogyakarta', '35': 'Surabaya', '36': 'Serang',
  '51': 'Denpasar', '52': 'Mataram', '53': 'Kupang', '61': 'Pontianak', '62': 'Palangka Raya', '63': 'Banjar Baru', '64': 'Samarinda', '65': 'Bulungan',
  '71': 'Manado', '72': 'Palu', '73': 'Makassar', '74': 'Kendari', '75': 'Gorontalo', '76': 'Mamuju', '81': 'Ambon', '82': 'Tidore Kepulauan',
  '91': 'Jayapura', '92': 'Manokwari', '93': 'Merauke', '94': 'Nabire', '95': 'Jayawijaya', '96': 'Sorong' };
const fixes = { kab: {}, prov: {} }, report = [];
for (const k of G.kab) {
  if (onLand(k.lo, k.la) || ISLAND_OK.some(n => k.name.includes(n))) continue;
  const n = nearestLand(k.lo, k.la), inl = n.pt && pushInland(n.pt);
  if (inl && n.km <= 12) { fixes.kab[k.code] = [+inl[1].toFixed(5), +inl[0].toFixed(5)]; report.push(['kab', k.name, +n.km.toFixed(1), 'snap']); }
  else report.push(['kab', k.name, +n.km.toFixed(1), 'PERIKSA MANUAL']);
}
for (const p of G.prov) {
  if (onLand(p.lo, p.la)) continue;
  const cap = G.kab.find(k => k.prov === p.code && k.name.replace(/^Kota /, '') === PROV_CAP[p.code] && onLand(k.lo, k.la)) || G.kab.find(k => k.prov === p.code && PROV_CAP[p.code] && k.name === PROV_CAP[p.code]);
  if (cap) { fixes.prov[p.code] = [+cap.la.toFixed(5), +cap.lo.toFixed(5), cap.name]; report.push(['prov', p.name, +nearestLand(p.lo, p.la).km.toFixed(1), 'ke ibukota: ' + cap.name]); }
  else report.push(['prov', p.name, 0, 'ibukota tidak ketemu']);
}
function run() {
  console.log('kab:', G.kab.length, '| titik di laut:', report.filter(r => r[0] === 'kab').length, '| provinsi di laut:', report.filter(r => r[0] === 'prov').length);
  console.table(report.map(r => ({ jenis: r[0], nama: r[1], km: r[2], aksi: r[3] })));

  if (process.argv.includes('--write')) { fs.writeFileSync(path.join(root, 'geo', 'coord-fixes.json'), JSON.stringify(fixes, null, 1)); console.log('ditulis geo/coord-fixes.json'); }
  
}
module.exports = { onLand, nearestLand, km };
if (require.main === module) run();
