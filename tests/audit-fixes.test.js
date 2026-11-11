'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SOC = require('../social');
const { socAssess, socTopics, socKeepX, socKeepTh } = SOC;
const ASSESS = require('../assessment');
const H = require('../social-history');
const FEEDTEXT = require('../feedtext');
const { newsEnglish, cleanTitle } = FEEDTEXT;

test('SOC_NOISE_RE scopes entertainment tokens without killing real disaster reports', () => {

  const t1 = 'kebakaran di pasar baru, warga pada nonton dari atap ruko';
  const a1 = socAssess(t1);
  assert.ok(a1.topics.includes('kebakaran'), 'Topic kebakaran should be preserved despite nonton');

  const t2 = 'Bioskop XXI Kelapa Gading kebakaran semalam, penonton dievakuasi';
  const a2 = socAssess(t2);
  assert.ok(a2.topics.includes('kebakaran'), 'Cinema fire should retain kebakaran');

  const t3 = 'Tiket nonton film bioskop terbaru diskon 50%';
  const a3 = socAssess(t3);
  assert.equal(a3.signalEligible, false);
});

test('histAstroturf protects official authority accounts and signalEligible posts', () => {

  const AUTH_ACCOUNTS = new Set(['infobmkg', 'bnpb_indonesia', 'basarnas', 'damkardki', 'tmcpoldametro']);
  const map = new Map();
  const bulletin = 'Peringatan Dini Cuaca Wilayah DKI Jakarta: Berpotensi hujan lebat disertai kilat dan angin kencang hingga sore hari.';

  map.set('p1', { text: bulletin, handle: '@infobmkg', assessment: { signalEligible: true } });
  map.set('p2', { text: bulletin, handle: '@infobmkg', assessment: { signalEligible: true } });
  map.set('p3', { text: bulletin, handle: '@bnpb_indonesia', assessment: { signalEligible: true } });

  const astroturfSig = SOC.astroturfSig(bulletin);
  assert.ok(astroturfSig.length > 0);

  for (const [k, p] of map) {
    const u = String(p.handle || '').toLowerCase().replace(/^@/, '');
    assert.ok(AUTH_ACCOUNTS.has(u), 'Authority account recognized');
  }
});

test('Protest hashtags do not create phantom fire or karhutla incidents', () => {
  const text = 'Mahasiswa BEM gelar aksi tolak kebijakan di Tugu Tani #karhutla #saveindonesia #kebakaranhutan';
  const a = socAssess(text);

  const fireEvents = (a.events || []).filter(e => e.category === 'karhutla' || e.category === 'kebakaran');
  assert.equal(fireEvents.length, 0, 'No phantom fire event created from protest hashtags');
});

test('Reply retention: socKeepX aligns with socKeepTh to preserve signal-eligible or topical replies', () => {
  const replyPost = { text: 'Banjir setinggi 1 meter merendam rumah warga di Bekasi', in_reply_to_user_id: '123', like_count: 2 };
  const a = socAssess(replyPost.text);
  replyPost.topics = a.topics;
  replyPost.signalEligible = a.signalEligible;

  assert.ok(socKeepX(replyPost), 'X reply with valid disaster topic should be retained');
});

test('Recall gaps: demo keywords and expanded banjir verbs are detected', () => {

  assert.ok(socTopics('Ratusan mahasiswa mogok kuliah tolak kebijakan rektorat').includes('demo'));
  assert.ok(socTopics('Buruh gelar aksi protes tolak revisi peraturan upah').includes('demo'));
  assert.ok(socTopics('Terjadi bentrok antar massa di jalan protokol').includes('demo'));
  assert.ok(socTopics('Serikat pekerja serukan pemogokan umum').includes('demo'));

  assert.ok(socTopics('Banjir melanda kawasan pemukiman warga di Bekasi').includes('banjir'));
  assert.ok(socTopics('Banjir parah kembali merendam puluhan ruko di Karawang').includes('banjir'));
  assert.ok(socTopics('Banjir bandang menerjang pemukiman lereng gunung').includes('banjir'));
});

test('bodyLen < 10 passes tag() when media is attached', () => {
  const post = { text: '#banjir', media: ['https://pbs.twimg.com/media/test.jpg'], ts: Date.now() - 1000 };
  const ok = H.tag(post);

  assert.ok(H.DROP_STATS.total > 0, 'DROP_STATS tracked');
});

test('Semantic disambiguation: false positives prevented across categories', () => {

  assert.equal(socAssess('Perang antar fandom boyband di media sosial semakin panas di Jakarta').signalEligible, false);
  assert.equal(socAssess('Siswa berkunjung ke museum militer kemarin di Bandung').signalEligible, false);
  assert.equal(socAssess('Komunitas hobi menerbangkan drone FPV di lapangan Monas').signalEligible, false);

  assert.equal(socAssess('Hatiku ambruk melihat kenyataan hidup di Depok').signalEligible, false);
  assert.equal(socAssess('Hanyut oleh senyuman manis dan tatapan matanya').signalEligible, false);

  assert.equal(socAssess('Badan lemas dan mual terus dari kemarin di Bekasi').signalEligible, false);
  const healthReport = socAssess('Puluhan santri keracunan massal mual muntah usai santap malam di Tasikmalaya');
  assert.ok(healthReport.signalEligible, 'Mass poisoning report is eligible');
  assert.ok(healthReport.events.some(e => e.category === 'kesehatan'), 'Categorized as kesehatan');

  assert.ok(!socTopics('Ada suara cicak di dinding kamar').includes('gempa'));

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

test('Demo intelligence & morphology expansion captures field unrest, protest mobilization, and campus sieges while filtering pure motivational text', () => {
  const GEO = require('../geocode');

  const gSurabaya = GEO.locate('UPDATE DEMO 10 November 2026 Kota Pahlawan Dihari Pahlawan Masih terus MELAWAN');
  assert.ok(gSurabaya, 'Kota Pahlawan must be recognized by geocode');
  assert.equal(gSurabaya.name, 'Surabaya');
  assert.equal(gSurabaya.prov, 'Jawa Timur');

  const p1 = {
    code: 'DfkMfd8EbT1',
    username: 'kaivalyaarunika',
    text: 'UPDATE DEMO 10 November 2026\nKota Pahlawan Dihari Pahlawan Masih terus MELAWAN\nNON SERVIAM✊',
    created_at: new Date(Date.now() - 3600000).toISOString()
  };
  assert.equal(H.tag(p1, [], Date.now(), { platform: 'threads' }), true);
  assert.ok(p1.topics.includes('demo'));
  assert.equal(p1.assessment.feedEligible, true);
  assert.equal(SOC.socKeepTh(p1), true);

  const p2 = {
    code: 'DfkQPwaGQ8p',
    username: 'asripatona2323',
    text: 'UP GUYS!! JOGJA GA KONDUSIF!!!',
    created_at: new Date(Date.now() - 3600000).toISOString()
  };
  assert.equal(H.tag(p2, [], Date.now(), { platform: 'threads' }), true);
  assert.ok(p2.topics.includes('demo'));
  assert.equal(p2.assessment.feedEligible, true);
  assert.equal(SOC.socKeepTh(p2), true);

  const p3 = {
    code: 'DfkKdsiFJlG',
    username: 'gnarly.ang',
    text: 'VOX POPULI, VOX DEI\n.\nRakyat bersatu, tak bisa dikalahkan\n\n\n KAMPUS DIKEPUNG⁉️\nLOGISTIK DIHALANGI MASUK?⁉️\nKAWAN-KAWAN YANG BERDEMO DIDUGA DICULIK?⁉️\nAPA SEBENARNYA YANG SEDANG TERJADI⁉️\nKAMPUS BUKAN MEDAN PERANG. MAHASISWA BUKAN MUSUH NEGARA. LOGISTIK KEMANUSIAAN BUKAN ANCAMAN\nSTOP❗️CUKUP❗️',
    created_at: new Date(Date.now() - 3600000).toISOString()
  };
  assert.equal(H.tag(p3, [], Date.now(), { platform: 'threads' }), true);
  assert.ok(p3.topics.includes('demo'));
  assert.equal(p3.assessment.feedEligible, true);
  assert.equal(SOC.socKeepTh(p3), true);

  const p4 = {
    code: 'mhs1',
    username: 'aliansi_mhs',
    text: 'Mahasiswa turun ke jalan menyuarakan keadilan dan memperjuangkan kebenaran di depan gedung DPR!',
    created_at: new Date(Date.now() - 3600000).toISOString()
  };
  assert.equal(H.tag(p4, [], Date.now(), { platform: 'threads' }), true);
  assert.ok(p4.topics.includes('demo'));
  assert.equal(p4.assessment.feedEligible, true);

  const p5 = {
    code: 'mot1',
    username: 'quote_pagi',
    text: 'Mari kita senantiasa menyuarakan keadilan dalam kehidupan sehari-hari agar hati tenang.',
    created_at: new Date(Date.now() - 3600000).toISOString()
  };
  assert.equal(H.tag(p5, [], Date.now(), { platform: 'threads' }), false);
  assert.equal(p5.assessment.feedEligible, false);
});

test('Acronym & K-pop music noise (DPR IAN, banjir pc) and non-Indonesian English chatter are rejected cleanly while real DPR/Indonesia events pass', () => {
  const now = Date.now();
  const mk = (code, text) => ({ code, username: 'u_' + code, text, created_at: new Date(now - 1800000).toISOString() });

  const rejectCases = [
    ['dpr_ian', 'DPR IAN talking about his next album has me vibrating cuz what do you MEAN “nothing will prepare us for this”?! \n\nEverything he does is so immaculate'],
    ['dpr_live', 'Finally saw DPR LIVE perform live last night, amazing stage and new song!'],
    ['banjir_pc', 'aduh senangnya lah jadi carat sama jdi shotties.. satu album banjir pc'],
    ['blue_tsu', 'Like Charlie Brown, the Democrats kick off their post-blue-tsunami November agenda'],
    ['my_banjir', 'Can anyone update the condition at section 13 and bukit jelutong. Banjir tak guys?'],
    ['us_stroke', 'Wondering if there is any update in senator Chris Murphy?? Hope he is recovering from his stroke'],
    ['ca_quake', 'A magnitude 4.6 earthquake has occurred 91 km SW of Tahsis, BC. There is NO tsunami threat to #BC.'],
    ['ddos_ad', 'DDoS Protection and Mitigation Security Market is anticipated to expand from $4.0 billion in 2024 to $9.2 billion.'],
    ['badminton_en', "Anyone want to play badminton together? I'm super good at it."],
    ['scone_racing', "SCONE R1 #3 Tasman Deel ($1.28) R2 #2 Reelflare ($2.35) R3 #3 Ocean Tsunami ($1.45) R4 #12 Tennessee River ($2.00) R5 #2 Tickelova ($6.00) R6 #4 Won'thearmecoming ($3.80) R7 #8 The Autumn Wind ($1.22) Tweet by crowcaster.com"],
    ['surf_tsunami', 'Surfing a tsunami top 10 to me, Idc'],
    ['pt_dbd', 'tenho q voltar a jogar dbd'],
    ['css_bem', 'Kenapa BEM itu keren? - Bikin struktur kode lebih jelas. - Mudah dipahami meskipun proyek besar. - Minim konflik'],
    ['civic_sale', 'Halo wargaaa, gua mau jual civic 2009 matic pemakaian gua sendiri yaa. surat lengkap pajak hidup pokoknya surat menyurat aman semua, mobil bebas laka ataupun banjir dijaminn.'],
    ['my_highway', 'Perjalanan lebih selamat di Lebuhraya SILK tanpa halangan banjir. Berhati-hati ketika memandu'],
    ['janda_spam', 'Janda (Jakarta Janda) open bo ready malam ini'],
    ['skyalliece_snbt', 'gonu lu dmna nuu yaelahh kangen bnget nih gua... rasa kangen gua kyknya udh bisa dipake jadi pembangkit listrik tenaga kangen... lama bngt kyk nunggu orang hamil lahiran... lama bngt kyk nunggu pengumuman snbt... udah ga sih? ayok pulang... itu member kangen dimasakin katanya...'],
    ['nadia_omara', 'acil² di wdhku begawi kemaren ku racuni nadia omara lngsung ke part 400. hari ini betagih hdk mndgr lg, "mana ceritanya nda?" jr. HAHAHA bujuran keracunan😭'],
    ['anjing_rabies', 'lagian si jn adakah di suruh jadi anjing rabies?? wkwkwk gausah hiperbola begitu lah cringe anjirr'],
    ['jam_korupsi', 'ini samsat keliling ditempat gw, jadwal jam berapa sampe sekarang belum dtg... gila ya jam aja di korupsi anjg?'],
    ['msia_cyber', "Serangan siber terhadap sistem sejuk beku boleh ancam bekalan makanan M'sia?"],
    ['blt_sandwich', 'BLT or Grilled Cheese?'],
    ['us_covid_en', 'Why did so many Americans needlessly die of COVID?'],
    ['msia_parlimen', 'Berbaki setahun lebih, penyokong PH kata eloklah rombak kabinet. TPM pula kata bubarkan parlimen.'],
    ['olahraga_timnas', 'Timnas Indonesia menang lawan Vietnam di Piala AFF malam ini'],
    ['lini_tengah_timnas', 'Timnas Indonesia memperkuat lini tengah dan lini belakang saat latihan di Bali'],
  ];

  for (const [id, text] of rejectCases) {
    const p = mk(id, text);
    assert.equal(H.tag(p, [], now, { platform: 'threads' }), false, `Must reject Threads noise: ${id}`);
  }

  assert.equal(SOC.SOC_TOPICS.some(t => t.id === 'olahraga'), false, 'olahraga topic must be removed from SOC_TOPICS');
  assert.equal(ASSESS.FEED_ONLY.has('olahraga'), false, 'olahraga must be removed from FEED_ONLY');

  const bltReal = mk('blt_real', 'BLT bansos Kemensos tahap akhir sudah cair ke rekening warga Jakarta hari ini.');
  assert.equal(H.tag(bltReal, [], now, { platform: 'threads' }), true);
  assert.ok(bltReal.topics.includes('bansos'));

  const xQueries = SOC.socQueries('x', []);
  assert.ok(xQueries.length > 0 && xQueries.every(q => !/\blang:(?:id|in)\b/i.test(q.q)), 'X queries must avoid broken lang:id/lang:in operators');

  const dprReal = mk('dpr_real', 'Ketua DPR RI resmi dilantik kembali dalam sidang paripurna di Jakarta hari ini.');
  assert.equal(H.tag(dprReal, [], now, { platform: 'threads' }), true);
  assert.ok(dprReal.topics.includes('politik'));
  assert.equal(dprReal.assessment.signalEligible, true);

  const engJakarta = mk('eng_jkt', 'Heavy flooding has submerged several streets in South Jakarta this morning, commuters asked to find alternative routes.');
  assert.equal(H.tag(engJakarta, [], now, { platform: 'threads' }), true);
  assert.ok(engJakarta.topics.includes('banjir'));
  assert.equal(engJakarta.assessment.scope, 'Indonesia');
});
