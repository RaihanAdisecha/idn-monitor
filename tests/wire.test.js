'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WireCore = require('../public/wire-core');
const GEO = require('../geocode');
const EVMERGE = require('../evmerge');
const FEEDTEXT = require('../feedtext');
const ASSESS = require('../assessment');
const SOC = require('../social');
const SIGNALS = require('../public/signals');

test('WireCore.prepare preserves publisher/url alignment while adopting longer desc', () => {
  const now = 1_700_000_000_000;
  const items = [
    { title: 'Banjir Rendam Bekasi Hari Ini', url: 'https://detik.com/1', pub: 'Detik', src: 'DETIK', desc: 'Pendek', ts: now - 10_000 },
    { title: 'Banjir Rendam Bekasi Hari Ini!', url: 'https://kompas.com/2', pub: 'Kompas', src: 'KOMPAS', desc: 'Deskripsi jauh lebih panjang dari artikel kedua', img: 'https://img/k.jpg', ts: now - 60_000 },
  ];
  const out = WireCore.prepare(items, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://detik.com/1');
  assert.equal(out[0].pub, 'Detik');
  assert.equal(out[0].src, 'DETIK');
  assert.equal(out[0].desc, 'Deskripsi jauh lebih panjang dari artikel kedua');
  assert.equal(out[0].img, 'https://img/k.jpg');
});

test('geocode blocks generic village/ibukota hijacks and resolves Province/POI accurately', () => {
  assert.equal(GEO.locate('Helikopter jatuh di hutan'), null);
  assert.equal(GEO.locate('Anggaran negara untuk pendidikan'), null);
  assert.equal(GEO.locate('Warga berkumpul di lapangan'), null);
  assert.equal(GEO.locate('Kebakaran di Kelantan Malaysia'), null);

  const jambi = GEO.locate('Banjir di Provinsi Jambi');
  assert.ok(jambi);
  assert.equal(jambi.prec, 'prov');
  assert.equal(jambi.prov, 'Jambi');

  const boyolali = GEO.locate('Demo mahasiswa di Simpang Lima Boyolali');
  assert.ok(boyolali);
  assert.match(boyolali.name, /Boyolali/);

  const pg = GEO.locate('Banjir di Pondok Gede');
  assert.ok(pg);
  assert.equal(pg.prov, 'Jawa Barat');
});

test('evmerge preserves shared incident tokens across large single-city cluster', () => {
  const now = 1_700_000_000_000;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    kind: 'kebakaran',
    place: 'Jakarta Selatan',
    prov: 'DKI Jakarta',
    la: -6.26,
    lo: 106.81,
    prec: 'kab',
    title: `Kebakaran Depo Pertamina Plumpang Jakarta Selatan laporan ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    src: `SRC${i + 1}`,
    ts: now - i * 60_000,
  }));
  const merged = EVMERGE.mergeEvents(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].n, 12);
});

test('feedtext preserves video amatir in prose and handles Indonesian rank abbreviations', () => {
  const cleaned = FEEDTEXT.descFrom({ description: 'Polisi memeriksa video amatir yang merekam detik-detik kejadian kecelakaan tersebut di jalan raya.' }, '');
  assert.match(cleaned, /video amatir/i);

  const lede = FEEDTEXT.descFrom({ contentEncoded: '<p>Kombes. Pol. Budi Santoso mengatakan pelaku sudah ditangkap di Bekasi tadi malam oleh tim gabungan.</p>' }, '');
  assert.match(lede, /Kombes\. Pol\. Budi Santoso/);
});

test('assessment links multiline Threads location and blocks Malaysian states', () => {
  const th = SOC.socAssess('Innalillahi, siswa SMK 7 Semarang\nMeninggal kecelakaan\nDi lemah Abang semarang');
  assert.equal(th.signalEligible, true);
  assert.equal(th.scope, 'Indonesia');
  assert.ok(th.events.some(e => e.location && /Semarang/i.test(e.location.name)));

  const my = SOC.socAssess('Kebakaran besar melanda kawasan perumahan di Kelantan petang tadi');
  assert.equal(my.scope, 'foreign');
  assert.equal(my.signalEligible, false);

  const ent = SOC.socAssess('Kecelakaan beruntun terjadi di Tol Cipularang &amp; jalur arah Bandung macet parah');
  assert.ok(ent.events.length >= 1);
  assert.ok(!ent.events[0].evidence.includes('&amp'));
});

test('signals matches rare specific events with 1 shared specific token', () => {
  const v = SIGNALS.VERSION;
  const a = {
    category: 'bencana',
    type: 'earthquake',
    scope: 'Indonesia',
    reportType: 'reported',
    signalEligible: true,
    severity: 'critical',
    location: { name: 'Kab. Cianjur', prov: 'Jawa Barat', prec: 'kab' },
    evidence: 'Gempa magnitudo mengguncang Cugenang Cianjur',
    version: v,
  };
  const b = {
    category: 'bencana',
    type: 'earthquake',
    scope: 'Indonesia',
    reportType: 'reported',
    signalEligible: true,
    severity: 'critical',
    location: { name: 'Kab. Cianjur', prov: 'Jawa Barat', prec: 'kab' },
    evidence: 'Warga Cugenang panik saat gempa bumi',
    version: v,
  };
  assert.equal(SIGNALS.relation(a, b), 'strong');
  assert.equal(SIGNALS.matches(a, b), true);
});
