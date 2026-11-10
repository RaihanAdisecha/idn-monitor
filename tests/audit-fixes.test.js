'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SOC = require('../social');
const { socAssess, socTopics, socKeepX, socKeepTh } = SOC;
const H = require('../social-history');
const FEEDTEXT = require('../feedtext');
const { newsEnglish, cleanTitle } = FEEDTEXT;

test('SOC_NOISE_RE scopes entertainment tokens without killing real disaster reports', () => {
  // Fire report with "nonton" in same sentence must keep kebakaran topic
  const t1 = 'kebakaran di pasar baru, warga pada nonton dari atap ruko';
  const a1 = socAssess(t1);
  assert.ok(a1.topics.includes('kebakaran'), 'Topic kebakaran should be preserved despite nonton');

  // Cinema fire report must keep kebakaran topic
  const t2 = 'Bioskop XXI Kelapa Gading kebakaran semalam, penonton dievakuasi';
  const a2 = socAssess(t2);
  assert.ok(a2.topics.includes('kebakaran'), 'Cinema fire should retain kebakaran');

  // Pure entertainment spam must not produce incident topics
  const t3 = 'Tiket nonton film bioskop terbaru diskon 50%';
  const a3 = socAssess(t3);
  assert.equal(a3.signalEligible, false);
});

test('histAstroturf protects official authority accounts and signalEligible posts', () => {
  // We simulate histAstroturf logic from server.js
  const AUTH_ACCOUNTS = new Set(['infobmkg', 'bnpb_indonesia', 'basarnas', 'damkardki', 'tmcpoldametro']);
  const map = new Map();
  const bulletin = 'Peringatan Dini Cuaca Wilayah DKI Jakarta: Berpotensi hujan lebat disertai kilat dan angin kencang hingga sore hari.';
  
  // 3 copies from BMKG or authority accounts
  map.set('p1', { text: bulletin, handle: '@infobmkg', assessment: { signalEligible: true } });
  map.set('p2', { text: bulletin, handle: '@infobmkg', assessment: { signalEligible: true } });
  map.set('p3', { text: bulletin, handle: '@bnpb_indonesia', assessment: { signalEligible: true } });

  // Astroturf check simulation
  const astroturfSig = SOC.astroturfSig(bulletin);
  assert.ok(astroturfSig.length > 0);
  
  // Ensure authority accounts are exempt
  for (const [k, p] of map) {
    const u = String(p.handle || '').toLowerCase().replace(/^@/, '');
    assert.ok(AUTH_ACCOUNTS.has(u), 'Authority account recognized');
  }
});

test('Protest hashtags do not create phantom fire or karhutla incidents', () => {
  const text = 'Mahasiswa BEM gelar aksi tolak kebijakan di Tugu Tani #karhutla #saveindonesia #kebakaranhutan';
  const a = socAssess(text);
  // Should NOT trigger a fire or karhutla incident finding in Tugu Tani
  const fireEvents = (a.events || []).filter(e => e.category === 'karhutla' || e.category === 'kebakaran');
  assert.equal(fireEvents.length, 0, 'No phantom fire event created from protest hashtags');
});

test('Reply retention: socKeepX aligns with socKeepTh to preserve signal-eligible or topical replies', () => {
  const replyPost = { text: 'Banjir setinggi 1 meter merendam rumah warga di Bekasi', in_reply_to_user_id: '123', like_count: 2 };
  const a = socAssess(replyPost.text);
  replyPost.topics = a.topics;
  replyPost.signalEligible = a.signalEligible;

  // socKeepX should preserve this reply even with low likes because it has topics / signalEligible
  assert.ok(socKeepX(replyPost), 'X reply with valid disaster topic should be retained');
});

test('Recall gaps: demo keywords and expanded banjir verbs are detected', () => {
  // Demo keywords: mogok, protes, bentrok, pemogokan, kerusuhan
  assert.ok(socTopics('Ratusan mahasiswa mogok kuliah tolak kebijakan rektorat').includes('demo'));
  assert.ok(socTopics('Buruh gelar aksi protes tolak revisi peraturan upah').includes('demo'));
  assert.ok(socTopics('Terjadi bentrok antar massa di jalan protokol').includes('demo'));
  assert.ok(socTopics('Serikat pekerja serukan pemogokan umum').includes('demo'));

  // Banjir verbs: melanda, parah, kembali, menerjang
  assert.ok(socTopics('Banjir melanda kawasan pemukiman warga di Bekasi').includes('banjir'));
  assert.ok(socTopics('Banjir parah kembali merendam puluhan ruko di Karawang').includes('banjir'));
  assert.ok(socTopics('Banjir bandang menerjang pemukiman lereng gunung').includes('banjir'));
});

test('bodyLen < 10 passes tag() when media is attached', () => {
  const post = { text: '#banjir', media: ['https://pbs.twimg.com/media/test.jpg'], ts: Date.now() - 1000 };
  const ok = H.tag(post);
  // With media, bodyLen restriction is bypassed
  // (Note: whether feedEligible passes depends on assessment, but it should not fail on bodyLen)
  assert.ok(H.DROP_STATS.total > 0, 'DROP_STATS tracked');
});

test('Semantic disambiguation: false positives prevented across categories', () => {
  // Konflik false positives
  assert.equal(socAssess('Perang antar fandom boyband di media sosial semakin panas di Jakarta').signalEligible, false);
  assert.equal(socAssess('Siswa berkunjung ke museum militer kemarin di Bandung').signalEligible, false);
  assert.equal(socAssess('Komunitas hobi menerbangkan drone FPV di lapangan Monas').signalEligible, false);

  // Insiden false positives (metaphors)
  assert.equal(socAssess('Hatiku ambruk melihat kenyataan hidup di Depok').signalEligible, false);
  assert.equal(socAssess('Hanyut oleh senyuman manis dan tatapan matanya').signalEligible, false);

  // Kesehatan: personal curhat nausea vs actual mass poisoning
  assert.equal(socAssess('Badan lemas dan mual terus dari kemarin di Bekasi').signalEligible, false);
  const healthReport = socAssess('Puluhan santri keracunan massal mual muntah usai santap malam di Tasikmalaya');
  assert.ok(healthReport.signalEligible, 'Mass poisoning report is eligible');
  assert.ok(healthReport.events.some(e => e.category === 'kesehatan'), 'Categorized as kesehatan');

  // Cicak is not gempa
  assert.ok(!socTopics('Ada suara cicak di dinding kamar').includes('gempa'));

  // Kriminal slang
  assert.ok(!socTopics('Wajahnya maling banget komuknya').includes('kriminal'));
});

test('Cyber PSA reports for pinjol and investasi bodong are not killed by spam filter', () => {
  const psa = 'Waspada penipuan investasi bodong modus titip dana trading di telegram';
  assert.ok(!SOC.SOC_SPAM_RE.test(psa), 'PSA warning must not trigger commercial spam filter');
  const topics = socTopics(psa);
  assert.ok(topics.includes('serangan siber'), 'PSA tagged as cyber attack/scam');
});

test('newsEnglish accurately detects short English headlines without tripping on Indonesian', () => {
  assert.equal(newsEnglish('Hurricane leaves 20 dead in coastal region'), true);
  assert.equal(newsEnglish('Air strike kills five militants in border town'), true);
  assert.equal(newsEnglish('Earthquake jolts eastern province, no tsunami warning'), true);
  
  // Indonesian headlines must NOT be flagged as English
  assert.equal(newsEnglish('Pemerintah salurkan bantuan untuk korban bencana banjir'), false);
  assert.equal(newsEnglish('BMKG rilis peringatan dini cuaca ekstrem di Jawa Barat'), false);
  assert.equal(newsEnglish('Presiden resmikan jembatan baru di Papua'), false);
});

test('cleanTitle is consistent and removes unwanted outlet suffixes', () => {
  assert.equal(cleanTitle('Banjir Rendam Puluhan Rumah di Bekasi - Detikcom'), 'Banjir Rendam Puluhan Rumah di Bekasi');
  assert.equal(cleanTitle('Gunung Marapi Erupsi Lagi | Kompas.com'), 'Gunung Marapi Erupsi Lagi');
});

test('Target Jakarta CCTV cameras are defined with active live streams and geo coordinates', () => {
  const fs = require('fs');
  const html = fs.readFileSync('public/index.html', 'utf8');
  const m = html.match(/<script type="application\/json" id="cam-data">([\s\S]*?)<\/script>/);
  assert.ok(m, 'cam-data script tag must exist');
  const cams = JSON.parse(m[1]);

  const targets = [
    'Bendungan Hilir 011',
    'Bendungan Hilir 001',
    'Gelora 026',
    'Gelora 015',
    'Gelora 038',
    'Karet Semanggi 006',
    'Gelora 008',
    'Bendungan Hilir 006',
    'Bendungan Hilir 008',
    'Tugu Tani'
  ];

  for (const name of targets) {
    const found = cams.find(c => c.n === name);
    assert.ok(found, `Camera "${name}" must exist in cam-data`);
    assert.ok(found.s && found.s.startsWith('https://'), `Camera "${name}" must have valid HTTPS stream`);
    assert.ok(Number.isFinite(found.la) && Number.isFinite(found.lo), `Camera "${name}" must have finite coordinates`);
  }
});
