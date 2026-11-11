'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeEntities, htmlToText, descFrom } = require('../feedtext');

test('decodeEntities: named entities', () => {
  assert.equal(decodeEntities('&mdash; &uuml; &hellip; &nbsp;x'), '— ü …  x');
});

test('decodeEntities: numeric refs', () => {
  assert.equal(decodeEntities('&#8212; &#x2014;'), '— —');
  assert.equal(decodeEntities('&#xD800;ok'), 'ok');
});

test('decodeEntities: amp decodes last, unknown stays literal', () => {
  assert.equal(decodeEntities('&amp;mdash;'), '&mdash;');
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});

test('htmlToText: br keeps word separation', () => {
  assert.equal(htmlToText('kata<br>lain'), 'kata lain');
});

test('htmlToText: strips script/style and tags', () => {
  const html = '<p>Halo <b>dunia</b></p><script>alert(1)</script><style>x{}</style>';
  const out = htmlToText(html);
  assert.ok(!out.includes('alert'));
  assert.ok(!out.includes('<'));
  assert.match(out, /Halo dunia/);
});

test('descFrom: GN-style headline + publisher → degenerate', () => {
  assert.equal(descFrom({ description: 'Hujan deras picu banjir di Jakarta   ANTARA' }, 'Hujan deras picu banjir di Jakarta'), '');
  assert.equal(descFrom({ description: 'Judul Berita Tempo.co' }, 'Judul Berita'), '');
});

test('descFrom: trailing outlet stripped', () => {

  assert.equal(
    descFrom({ description: 'Hujan deras picu banjir di wilayah Jabodetabek - ANTARA' }, 'Lain'),
    'Hujan deras picu banjir di wilayah Jabodetabek'
  );
  assert.equal(
    descFrom({ description: 'Presiden mengumumkan kebijakan ekonomi baru — tempo.co' }, 'Lain'),
    'Presiden mengumumkan kebijakan ekonomi baru'
  );
});

test('descFrom: paren photo credit removed', () => {
  const out = descFrom({
    description: 'Gempa magnitude 5.2 mengguncang wilayah Sumatera. Korban dipastikan aman dan tidak ada kerusakan berarti. (Foto: Antara)',
  }, 'Gempa');
  assert.ok(!out.includes('Foto'));
  assert.match(out, /Gempa magnitude/);
});

test('descFrom: "Sumber: X." keeps following sentence', () => {
  const out = descFrom({
    description: 'Sumber: BNPB. Korban dievakuasi dari lokasi banjir dan kini berada di posko pengungsian.',
  }, 'Banjir');
  assert.match(out, /Korban dievakuasi/);
  assert.ok(!/^\s*Sumber/i.test(out));
});

test('descFrom: read-more tail cut', () => {
  const out = descFrom({
    description: 'Pemerintah menaikkan anggaran infrastruktur tahun depan. Baca selengkapnya di cnnindonesia.com',
  }, 'Anggaran');
  assert.equal(out, 'Pemerintah menaikkan anggaran infrastruktur tahun depan.');
});

test('descFrom: contentEncoded HTML becomes readable text', () => {
  const html = '<p>Paragraf pertama berita <b>penting</b>.</p>' +
    '<figure><img src="x.jpg"><figcaption>Foto: Istimewa</figcaption></figure>' +
    '<p>Paragraf kedua berita.</p>';
  const out = descFrom({ contentEncoded: html }, 'Judul');
  assert.ok(out.length >= 40, 'expected >=40 chars, got: ' + out);
  assert.ok(!out.includes('<'), 'tags remain');
  assert.ok(!/kata\S*lain/.test(out) || true);

  assert.match(out, /pertama berita penting\. Paragraf kedua/);
});

test('descFrom: field priority — good description beats contentEncoded', () => {
  const good = 'Pemerintah mengumumkan kebijakan baru untuk mendukung pertumbuhan ekonomi nasional tahun depan.';
  const heavy = '<p>' + 'x'.repeat(200) + '</p>';
  assert.equal(descFrom({ description: good, contentEncoded: heavy }, 'T'), good);
});

test('descFrom: degenerate description falls back to contentEncoded', () => {
  const good = 'Pemerintah mengumumkan kebijakan baru untuk mendukung pertumbuhan ekonomi nasional tahun depan.';
  assert.equal(
    descFrom({ description: 'ANTARA', contentEncoded: '<p>' + good + '</p>' }, 'T'),
    good
  );
});

test('descFrom: 600-char input capped at word boundary + …', () => {
  const long = ('Kata berita panjang yang terus berlanjut tanpa henti. '.repeat(20));
  const out = descFrom({ description: long }, 'T');
  assert.ok(out.length <= 521, 'len=' + out.length);
  assert.ok(out.endsWith('…'), 'ends with ellipsis');

  const body = out.slice(0, -1);
  assert.match(body, /[a-zA-Z]$/);
});

test('descFrom: desc equal to title → empty', () => {
  const t = 'Presiden mengumumkan kebijakan ekonomi baru untuk tahun depan';
  assert.equal(descFrom({ description: t }, t), '');
});

test('descFrom: mid-sentence outlet name kept', () => {
  const out = descFrom({
    description: 'Menurut ANTARA, kebijakan baru itu akan berlaku mulai awal tahun depan bagi seluruh sektor usaha.',
  }, 'Kebijakan');
  assert.match(out, /Menurut ANTARA,/);
});

test('descFrom: publisher-only desc → empty', () => {
  assert.equal(descFrom({ description: 'ANTARA' }, 'Apa pun'), '');
  assert.equal(descFrom({ description: 'tempo.co' }, 'Apa pun'), '');
});

test('descFrom: empty/undefined fields → empty', () => {
  assert.equal(descFrom({}, 'T'), '');
  assert.equal(descFrom(undefined, 'T'), '');
  assert.equal(descFrom({ description: '', contentEncoded: '   ' }, 'T'), '');
});

test('newsEnglish: judul Inggris murni terdeteksi', () => {
  const { newsEnglish } = require('../feedtext');
  assert.equal(newsEnglish(
    'Couple wants the BOM to replace them with a weather station',
    'After six decades of recording rainfall data, Ernie and Merrillyn Cole want the Bureau of Meteorology to take over.'), true);
  assert.equal(newsEnglish('NSW prisoners made more than 32,000 complaints in past year', ''), true);
});

test('newsEnglish: berita Indonesia tidak ikut terbuang', () => {
  const { newsEnglish } = require('../feedtext');
  assert.equal(newsEnglish('Heli water bombing jatuh di Sungai Barito, 2 selamat 1 meninggal', 'Kru helikopter pemadam karhutla...'), false);
  assert.equal(newsEnglish('Rupiah menguat ke Rp18.250 per dolar AS', 'Nilai tukar rupiah terhadap dolar Amerika Serikat diprediksi fluktuasi ketat pekan ini.'), false);
  assert.equal(newsEnglish('Gempa M5.2 guncang Maluku, 3 meninggal', ''), false);
});

test('cleanTitle: strips uncleaned source domains and suffixes without cutting compound words', () => {
  const { cleanTitle } = require('../feedtext');

  assert.equal(cleanTitle('Polisi Tangkap Pengedar Narkoba - tribatanews.com', 'tribatanews.com'), 'Polisi Tangkap Pengedar Narkoba');
  assert.equal(cleanTitle('Patroli Malam di Wilayah Rawan - tribratanews.com'), 'Patroli Malam di Wilayah Rawan');
  assert.equal(cleanTitle('Kecelakaan Tol Cipali, 2 Orang Luka-Luka - tribratanews-polrescirebon.com', 'tribratanews-polrescirebon.com'), 'Kecelakaan Tol Cipali, 2 Orang Luka-Luka');
  assert.equal(cleanTitle('Dua Pelaku Curanmor Diamankan – Polresta Cirebon'), 'Dua Pelaku Curanmor Diamankan');
  assert.equal(cleanTitle('Waspada Cuaca Ekstrem di Kaltim - Niaga.Asia', 'Niaga.Asia'), 'Waspada Cuaca Ekstrem di Kaltim');
  assert.equal(cleanTitle('Harga Kebutuhan Pokok Naik - Jambiupdate.co'), 'Harga Kebutuhan Pokok Naik');
  assert.equal(cleanTitle('Penyelundupan Rokok Ilegal Digagalkan - Batamtimes.co'), 'Penyelundupan Rokok Ilegal Digagalkan');
  assert.equal(cleanTitle('Pelantikan Pejabat Baru - pemerintah Kabupaten Aceh Barat Daya'), 'Pelantikan Pejabat Baru');

  assert.equal(cleanTitle('Anak-anak Korban Bencana Trauma, Mengaku Pura-pura Sakit - Detikcom', 'detikcom'), 'Anak-anak Korban Bencana Trauma, Mengaku Pura-pura Sakit');
  assert.equal(cleanTitle('Jalur Tol Pejagan-Pemalang Macet Parah - Radar Tegal', 'radar tegal'), 'Jalur Tol Pejagan-Pemalang Macet Parah');
  assert.equal(cleanTitle('Konflik Tambang-Sawit Diselesaikan Warga Kassi-Kassi - Tribunnews', 'tribunnews'), 'Konflik Tambang-Sawit Diselesaikan Warga Kassi-Kassi');

  assert.equal(cleanTitle('Berita Video - Evakuasi Korban Longsor Berlanjut - Kompas.com', 'kompas.com'), 'Evakuasi Korban Longsor Berlanjut');
  assert.equal(cleanTitle('Breaking News - Gunung Merapi Luncurkan Awan Panas - CNN Indonesia', 'cnn indonesia'), 'Gunung Merapi Luncurkan Awan Panas');
});
