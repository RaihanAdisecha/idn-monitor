'use strict';
// Regression tests for the in-progress hardening pass. Every assertion below was
// verified directly against the current source before being written.
// evmerge.js is intentionally NOT tested here: it is already covered by
// tests/evmerge.test.js (and the standard run includes that file via tests/*.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../assessment');
const S = require('../social');
const H = require('../social-history');
const GEO = require('../geocode');

// A minimal topic registry: assess() walks topics x clauses and needs tp.id +
// tp.pos. Keeping it tiny avoids pulling in the full SOC_TOPICS registry.
const banjirReg = [{ id: 'banjir', pos: /banjir/i }];
const reportTypeOf = (text) => A.assess(text, banjirReg).findings[0].reportType;

test('FEED_ONLY topics never produce a signalEligible finding', () => {
  const feedOnly = ['mbg', 'bbm', 'pangan', 'bansos', 'hukum', 'transport', 'pendidikan'];
  for (const id of feedOnly) assert.ok(A.FEED_ONLY.has(id), `${id} should be in FEED_ONLY`);
  assert.equal(A.FEED_ONLY.has('olahraga'), false, 'olahraga must not be in FEED_ONLY');

  const registry = feedOnly.map((id) => ({ id, pos: new RegExp(id, 'i') }));
  // Include concrete event language + an Indonesian location so these findings
  // would otherwise look reportable; the FEED_ONLY flag must still veto signals.
  const r = A.assess(
    'MBG BBM Pangan Bansos Hukum Transport Pendidikan melanda Jakarta terjadi',
    registry,
  );
  const findings = r.findings.filter((f) => A.FEED_ONLY.has(f.topic));
  assert.equal(findings.length, feedOnly.length, 'each FEED_ONLY topic should yield a finding');
  assert.ok(findings.every((f) => f.signalEligible === false), 'no FEED_ONLY finding may be signalEligible');
  assert.ok(findings.every((f) => f.feedOnly === true), 'FEED_ONLY findings should be flagged feedOnly');
  assert.equal(r.signalEligible, false);
  assert.equal(r.events.length, 0);
});

test('classifyScope strips diacritics so foreign place names are not read as local', () => {
  // "kraków": after NFD + removing combining marks the word boundary matches
  // the Krakow foreign marker, exactly like the ASCII spelling.
  const plain = A.classifyScope('penembakan di krakow', null);
  const diacritic = A.classifyScope('penembakan di kraków', null);
  assert.equal(diacritic.scope, plain.scope, 'diacritics must not change the scope result');
  assert.equal(diacritic.scope, 'foreign');
  assert.notEqual(diacritic.scope, 'Indonesia');
  assert.equal(A.classifyScope('penembakan di Jakarta', null).scope, 'Indonesia');
});

test('only years already past are treated as historical (relative to the current clock)', () => {
  // Relative to a 2026 clock this is "tahun 2019" (historical) vs "tahun 2026"
  // (NOT historical). Computed dynamically so the test stays valid next year too.
  const nowYear = new Date().getFullYear();
  const past = String(nowYear - 7);
  const thisYear = String(nowYear);
  const future = String(nowYear + 4);
  assert.equal(reportTypeOf(`Banjir tahun ${past} melanda Jakarta`), 'historical');
  assert.notEqual(reportTypeOf(`Banjir tahun ${thisYear} melanda Jakarta`), 'historical');
  assert.notEqual(reportTypeOf(`Banjir tahun ${future} melanda Jakarta`), 'historical');
});

test('denied markers ("hoaks") are scoped to the same clause, not to all findings', () => {
  const sameClause = A.assess('Banjir hoaks melanda Jakarta', banjirReg);
  assert.equal(sameClause.findings.length, 1);
  assert.equal(sameClause.findings[0].reportType, 'denied');

  const otherClauseText = 'Banjir melanda Jakarta. Kabar itu hoaks.';
  assert.ok(A.clauses(otherClauseText).length >= 2, 'the two statements must be separate clauses');
  const otherClause = A.assess(otherClauseText, banjirReg);
  assert.equal(otherClause.findings.length, 1);
  assert.notEqual(otherClause.findings[0].reportType, 'denied', 'hoaks in another clause must not deny this finding');
});

test('socHashJunk strips URLs so a t.co link does not inflate the hashtag ratio', () => {
  // socHashJunk is exported, so it can be asserted directly (no need for
  // socAssess/socKeepX). The '#...' fragments live inside the URL and must be
  // removed before tags are counted.
  assert.equal(
    S.socHashJunk('Banjir melanda Jakarta hari ini https://t.co/abc#one#two#three#four#five'),
    false,
    'a legit post with a fragment-heavy t.co link must not be junk',
  );
  // Control: the same kind of tag density as real hashtags IS junk.
  assert.equal(
    S.socHashJunk('Banjir melanda Jakarta #satu #dua #tiga #empat #lima'),
    true,
  );
});

test('social-history: identical text without url/code does not overwrite distinct posts', () => {
  // social-history.js exports keyOf (not a "merge" function); keyOf is the
  // map-key builder responsible for keeping bare-text posts distinct.
  const text = 'Banjir melanda Jakarta';
  const p1 = { text, created_at: '2026-11-01T01:00:00Z', author: 'alice' };
  const p2 = { text, created_at: '2026-11-02T02:00:00Z', author: 'bob' };
  assert.ok(!p1.url && !p1.code && !p2.url && !p2.code, 'neither post has a url/code');
  const k1 = H.keyOf(p1);
  const k2 = H.keyOf(p2);
  assert.notEqual(k1, k2, 'different author/created_at must yield different keys');
  const map = new Map();
  map.set(k1, p1);
  map.set(k2, p2);
  assert.equal(map.size, 2, 'both posts must survive in the map');
});

test('geocode aliases NTB / DIY / DKI resolve to the expected regions', () => {
  assert.equal(GEO.locate('NTB')?.name, 'Nusa Tenggara Barat');
  assert.equal(GEO.locate('DIY')?.name, 'DI Yogyakarta');
  assert.equal(GEO.locate('DKI')?.name, 'Jakarta');
});

test('real-estate listing posts are dropped from the social feed', () => {
  // Threads listing: house for sale, transit amenities, price slang. The
  // transport topic (KRL/TransJakarta) must NOT keep it feed-eligible.
  const listing = 'Yang cari rumah di Jakarta merapat !!\n\n' +
    'Lokasi rumah di Jalan Jatinegara Raya, Bali Mester, Jatinegara, punya akses ke:\n' +
    ' Stasiun KRL Jatinegara\n TransJakarta Koridor 5 & 11\n Mikrotrans JakLingko\n' +
    ' LT 66m LB 200m\n\n' +
    'Turun harganya ga ngotak, bener2 hemat 700juta woy Kata gue mh buruan dah pinang, wortthhhh banget banget banget !';
  const r = S.socAssess(listing);
  assert.deepEqual(r.topics, [], 'listing post must not carry any topic');
  assert.equal(r.feedEligible, false);
  assert.equal(r.signalEligible, false);

  // Deal words without a property noun, or a property noun without deal words,
  // must not trigger listing detection.
  const incident = S.socAssess('Kebakaran rumah di Jatinegara Jakarta hari ini, damkar padamkan api');
  assert.ok(incident.topics.includes('kebakaran'), 'real incident mentioning "rumah" must survive');
  const noDeal = S.socAssess('Longsor menutup rumah warga di Sukabumi, 3KK terdampak');
  assert.ok(noDeal.topics.length > 0, 'incident without deal language must stay feed-eligible');
});

test('listing only suppresses FEED_ONLY topics; real incident topics survive', () => {
  const r = S.socAssess('Kebakaran ruko di Jakarta, ruko itu kabarnya dijual tahun lalu');
  assert.ok(r.topics.includes('kebakaran'), 'non-feed-only topic must survive listing detection');
});

test('BOM akronim Inggris (Bureau of Meteorology) bukan bahan peledak', () => {
  const r = S.socAssess('After 63 years recording Mitta Mitta\'s weather, couple wants the BOM to replace them with a weather station');
  assert.ok(!r.topics.includes('konflik'), 'BOM = akronim cuaca Australia, bukan "bom"');
  assert.equal(r.topics.length, 0);
  // bom bahan peledak dalam bahasa Indonesia tetap terdeteksi
  const real = S.socAssess('Polisi menemukan bom di pasar');
  assert.ok(real.topics.includes('konflik'), 'bom literal harus tetap jadi konflik');
});

test('geocode: street name "Bali Mester" does not outvote the Jatinegara POI', () => {
  const loc = GEO.locate('Lokasi rumah di Jalan Jatinegara Raya, Bali Mester, Jatinegara, ' +
    'punya akses ke Stasiun KRL Jatinegara TransJakarta Koridor 5 11 Mikrotrans JakLingko LT 66m LB 200m');
  assert.equal(loc?.name, 'Jatinegara');
  assert.equal(loc?.prov, 'DKI Jakarta');
});

test('dating, taaruf, and commercial recommendation requests are rejected as noise/spam', () => {
  const dating = `Hai. 
Aku mau ngenalin temen aku nih
Usia 29 tahun
Asli Surabaya
Kerja di Sidoarjo 
Pekerjaan sebagai guru honorer
Fisik dia agak gemoy tapi dia baik hati bertanggung jawab

Cari kriteria :
1. Laki laki
2. Islam
3. Umur 29-35 tahun
4. Pekerjaan ada
5. Tanggung jawab
6. Pendidikan minimal SMA (Diutamakan S1)
7. Tidak merokok
8. Tidak judi / miras dll
9. Bisa menjadi teman yang aman nyaman ketika bercerita`;

  const r1 = S.socAssess(dating);
  assert.equal(r1.feedEligible, false, 'dating post must not be feed-eligible');
  assert.equal(r1.signalEligible, false, 'dating post must not be signal-eligible');
  assert.ok(r1.reasons.includes('spam'), 'dating post must be flagged as spam');
  assert.equal(r1.topics.length, 0);

  const cleaning = 'Dear warga Threads, adakah rekomendasi jasa cleaning rumah & apartment yg profesional untuk wilayah Cakung & sekitarnya? Prefer yg bukan perorangan ya, karna sudah capek sama dramanya. Thanks in advance';
  const r2 = S.socAssess(cleaning);
  assert.equal(r2.feedEligible, false, 'cleaning service inquiry must not be feed-eligible');
  assert.equal(r2.signalEligible, false, 'cleaning service inquiry must not be signal-eligible');
  assert.ok(r2.reasons.includes('spam'), 'service inquiry must be flagged as spam');
  assert.equal(r2.topics.length, 0);

  // Legitimate labor dispute or protest by teachers must remain intact
  const protest = 'Ratusan guru honorer demo di depan kantor bupati di Surabaya menuntut gaji 6 bulan belum cair';
  const r3 = S.socAssess(protest);
  assert.ok(r3.topics.includes('pendidikan'), 'legitimate teacher protest must match pendidikan');
  assert.equal(r3.feedEligible, true, 'legitimate protest must be feed-eligible');
});

test('romantic confessions, dating drama, and shooting metaphors are rejected while real shooting incidents pass', () => {
  const romanticPost = "prtm kl ditembak duluan. malem kmrn 3 jam di obrolan ini lbh bnyk gua nya minta maaf, krn gua ngerasa jahat. i swear to god gua lg ga mau pacaran. thn ini berat buat gua, gua lg memperbaiki diri. td gua ajak dia makan malem bareng, bcs i didn’t want her to feel some type of way.";
  const res1 = S.socAssess(romanticPost);
  assert.equal(res1.feedEligible, false, 'romantic confession must not be feed-eligible');
  assert.equal(res1.signalEligible, false, 'romantic confession must not be signal-eligible');
  assert.equal(res1.topics.length, 0, 'romantic confession must have zero topics');
  assert.equal(res1.reportType, 'irrelevant');
  assert.ok(res1.reasons.includes('metaphor_or_nonincident_usage') || res1.reasons.includes('spam'));

  const gebetan = 'kemarin gue ditembak gebetan di kafe, tapi gue bingung mau jawab apa krn blm siap pacaran';
  const res2 = S.socAssess(gebetan);
  assert.equal(res2.feedEligible, false);
  assert.equal(res2.topics.length, 0);

  const mantanRp = 'mantan rp gw cuma satu, sering banget ngedrama kecelakaan, mamanya meninggal, bapaknya meninggal, keluarganya bankrut dll tapi kadang flexing juga. setaun pacaran sering mau gw putusin dia gak pernah mau, terus bilang mau nyamperin gw tiap gw putusin';
  const resRp = S.socAssess(mantanRp);
  assert.equal(resRp.feedEligible, false, 'fake drama accident / roleplay post must not be feed-eligible');
  assert.equal(resRp.topics.length, 0, 'fake drama accident must have zero topics');

  const bareShooting = 'kemarin dia ditembak tapi tidak jelas siapa orangnya';
  const res3 = S.socAssess(bareShooting);
  assert.equal(res3.topics.includes('penembakan'), false, 'bare ditembak without weapon/police context must not qualify for penembakan');

  const figurativeKriminal = 'malam ini aku dibunuh rasa rindu dan sepi di kosan';
  const res4 = S.socAssess(figurativeKriminal);
  assert.equal(res4.topics.includes('kriminal'), false, 'figurative dibunuh rindu must not qualify for kriminal');

  const figurativePencurian = 'ada pencuri hati yang bikin senyum-senyum sendiri';
  const res5 = S.socAssess(figurativePencurian);
  assert.equal(res5.topics.includes('pencurian'), false, 'figurative pencuri hati must not qualify for pencurian');

  // Real shooting incidents MUST pass and remain feedEligible
  const realShooting1 = 'Pelaku begal ditembak polisi saat berusaha kabur di Bekasi';
  const resReal1 = S.socAssess(realShooting1);
  assert.ok(resReal1.topics.includes('penembakan'), 'real police shooting must match penembakan');
  assert.equal(resReal1.feedEligible, true);

  const realShooting2 = 'Baku tembak pecah antara TNI dan KKB di Intan Jaya Papua';
  const resReal2 = S.socAssess(realShooting2);
  assert.ok(resReal2.topics.includes('penembakan'), 'gunfight must match penembakan');
  assert.equal(resReal2.feedEligible, true);

  const realShooting3 = 'Seorang pria tewas tertembak peluru nyasar di Cakung Jakarta Timur';
  const resReal3 = S.socAssess(realShooting3);
  assert.ok(resReal3.topics.includes('penembakan'), 'stray bullet shooting casualty must match penembakan');
  assert.equal(resReal3.feedEligible, true);
});

test('disaster radar covers volcanic eruptions, storms, and tornadoes while rejecting metaphors', () => {
  // 1. Real volcanic eruptions
  const lewotobi = 'Gunung Lewotobi Laki-laki kembali meletus semburkan awan panas guguran setinggi 4000 meter di Flores Timur';
  const resV1 = S.socAssess(lewotobi);
  assert.ok(resV1.topics.includes('gempa'), 'volcano eruption must map to disaster/gempa topic');
  assert.equal(resV1.feedEligible, true, 'volcano eruption must be feed eligible');
  assert.ok(resV1.events.some(e => e.category === 'disaster' && e.type === 'eruption'), 'event must have category disaster and type eruption');

  const marapi = 'Hujan abu vulkanik tebal melanda permukiman warga akibat erupsi Gunung Marapi di Agam Sumatera Barat';
  const resV2 = S.socAssess(marapi);
  assert.ok(resV2.topics.includes('gempa'));
  assert.equal(resV2.feedEligible, true);
  assert.ok(resV2.events.some(e => e.category === 'disaster' && e.type === 'eruption'));

  // 2. Real severe storm, cyclone, and tornado (puting beliung)
  const putingBeliung = 'Angin puting beliung terjang Rancaekek Bandung, puluhan atap rumah beterbangan dan pohon tumbang';
  const resS1 = S.socAssess(putingBeliung);
  assert.ok(resS1.topics.includes('badai'), 'puting beliung must map to badai topic');
  assert.equal(resS1.feedEligible, true, 'tornado must be feed eligible');
  assert.ok(resS1.events.some(e => e.category === 'disaster' && (e.type === 'tornado' || e.type === 'storm')), 'event must have category disaster');

  const siklon = 'Bibit siklon tropis di Laut Timor memicu badai petir dan gelombang pasang di pesisir Kupang NTT';
  const resS2 = S.socAssess(siklon);
  assert.ok(resS2.topics.includes('badai'), 'cyclone must map to badai topic');
  assert.equal(resS2.feedEligible, true);

  // 3. Metaphors must be rejected
  const badaiAsmara = 'setelah melewati badai asmara dan drama cinta, akhirnya mereka putus juga';
  const resM1 = S.socAssess(badaiAsmara);
  assert.equal(resM1.topics.includes('badai'), false, 'metaphorical badai asmara must not qualify for badai');
  assert.equal(resM1.feedEligible, false);

  const badaiPastiBerlalu = 'jangan sedih sobat, badai pasti berlalu tetap semangat jalani hidup';
  const resM2 = S.socAssess(badaiPastiBerlalu);
  assert.equal(resM2.topics.includes('badai'), false, 'badai pasti berlalu idiom must not qualify for badai');
  assert.equal(resM2.feedEligible, false);
});
