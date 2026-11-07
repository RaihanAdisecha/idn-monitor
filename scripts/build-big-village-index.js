#!/usr/bin/env node
'use strict';
/* Build the compact runtime gazetteer from BIG's mapped desa/kelurahan CSV.
   Usage: node scripts/build-big-village-index.js /path/to/indonesia_desa_kelurahan_centroids_big.csv */
const fs = require('fs');
const path = require('path');

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/build-big-village-index.js /path/to/BIG-village-centroids.csv');

function parseCsvLine(line) {
  const out = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(value); value = '';
    } else value += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  out.push(value);
  return out;
}
const canonicalFields = value => (Array.isArray(value) ? value : [value])
  .map(x => String(x).normalize('NFKC').trim().toLowerCase());
function putUnique(map, code, value, label) {
  if (!code || !value) throw new Error(`Missing ${label} code/name`);
  const old = map.get(code);
  if (old !== undefined && JSON.stringify(canonicalFields(old)) !== JSON.stringify(canonicalFields(value))) {
    throw new Error(`Conflicting ${label} record for ${code}`);
  }
  // Keep the first source spelling when differences are case-only (e.g. Grong-Grong).
  if (old === undefined) map.set(code, value);
}

const text = fs.readFileSync(input, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
if (lines.length < 2) throw new Error('CSV has no data rows');
const header = parseCsvLine(lines[0]);
const col = Object.fromEntries(header.map((name, i) => [name, i]));
const required = [
  'kode_pum_provinsi', 'provinsi', 'kode_pum_kabupaten_kota', 'kabupaten_kota',
  'kode_pum_kecamatan', 'kecamatan', 'kode_pum_desa_kelurahan', 'desa_kelurahan',
  'tipe_administrasi', 'status_batas_big', 'latitude', 'longitude'
];
for (const name of required) if (col[name] === undefined) throw new Error(`Missing CSV column: ${name}`);

const provinces = new Map(), kabupatenKota = new Map(), kecamatan = new Map();
const places = [], codes = new Set(), typeCounts = { Desa: 0, Kelurahan: 0 };
for (let lineNo = 1; lineNo < lines.length; lineNo++) {
  const row = parseCsvLine(lines[lineNo]);
  const get = key => row[col[key]] || '';
  const provCode = get('kode_pum_provinsi'), provName = get('provinsi');
  const kabCode = get('kode_pum_kabupaten_kota'), kabName = get('kabupaten_kota');
  const kecCode = get('kode_pum_kecamatan'), kecName = get('kecamatan');
  const code = get('kode_pum_desa_kelurahan'), name = get('desa_kelurahan');
  const type = get('tipe_administrasi'), status = get('status_batas_big');
  const lat = Number(get('latitude')), lon = Number(get('longitude'));
  const parts = code.split('.');
  if (parts.length !== 4 || parts[0] !== provCode || `${parts[0]}.${parts[1]}` !== kabCode ||
      `${parts[0]}.${parts[1]}.${parts[2]}` !== kecCode) {
    throw new Error(`Broken PUM hierarchy at CSV line ${lineNo + 1}: ${code}`);
  }
  if (codes.has(code)) throw new Error(`Duplicate PUM village code: ${code}`);
  if (!name || !['Desa', 'Kelurahan'].includes(type)) throw new Error(`Invalid village/type at CSV line ${lineNo + 1}`);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -12 || lat > 8 || lon < 92 || lon > 145) {
    throw new Error(`Invalid WGS84 coordinate at CSV line ${lineNo + 1}: ${lat},${lon}`);
  }
  codes.add(code);
  typeCounts[type]++;
  putUnique(provinces, provCode, provName, 'province');
  putUnique(kabupatenKota, kabCode, [kabName, provCode], 'kabupaten/kota');
  putUnique(kecamatan, kecCode, [kecName, kabCode], 'kecamatan');
  places.push([code, name, type, lat, lon, status]);
}

const expected = { provinces: 38, kabupatenKota: 514, kecamatan: 7282, places: 83529, Desa: 75034, Kelurahan: 8495 };
const actual = { provinces: provinces.size, kabupatenKota: kabupatenKota.size, kecamatan: kecamatan.size, places: places.length, ...typeCounts };
for (const [key, value] of Object.entries(expected)) {
  if (actual[key] !== value) throw new Error(`Unexpected ${key} count: ${actual[key]} (expected ${value}); review the source edition before rebuilding`);
}
const byCode = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
places.sort(byCode);
const out = {
  src: 'Badan Informasi Geospasial (BIG), BATAS_DESAKEL_AR',
  sourceUrl: 'https://geoservices.big.go.id/rbi/rest/services/BATASWILAYAH/BATAS_DESAKEL_AR/MapServer/0',
  edition: '2026-06',
  captured: '2026-11-07',
  crs: 'EPSG:4326',
  coordinateMethod: 'Approximate polygon centroid; seven repeated PUM codes were consolidated with area-weighted centroids; source geometry was simplified with maxAllowableOffset=0.0001 degrees.',
  caveat: 'Mapped BIG units only. A centroid is an administrative reference point, not an incident address, and may fall outside a concave boundary. Boundary status is not a coordinate-confidence score.',
  attribution: 'BIG attribution retained. Verify current reuse and redistribution terms before public deployment.',
  counts: { ...actual },
  provinces: [...provinces].map(([code, name]) => [code, name]).sort(byCode),
  kabupatenKota: [...kabupatenKota].map(([code, [name, provCode]]) => [code, name, provCode]).sort(byCode),
  kecamatan: [...kecamatan].map(([code, [name, kabCode]]) => [code, name, kabCode]).sort(byCode),
  places
};
const output = path.join(__dirname, '..', 'geo', 'desa-kelurahan-big.json');
fs.writeFileSync(output, JSON.stringify(out) + '\n');
console.log(JSON.stringify({ output, ...actual, bytes: fs.statSync(output).size }, null, 2));
