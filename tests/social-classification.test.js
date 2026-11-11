'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ASSESS = require('../assessment');
const SOC = require('../social');
const NLP = require('../indonesian-nlp');
const HISTORY = require('../social-history');
const CLUSTER = require('../social-cluster');
const DIAG = require('../social-diagnostics');
const ADAPTER = require('../nlp-adapter');
const SIGNALS = require('../public/signals');
const GEO = require('../geocode');

const CORPUS_PATH = path.join(__dirname, 'fixtures', 'indonesian-eval-corpus.json');
const CORPUS = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));

let childProc = null;
let tmpDataDir = null;

function cleanup() {
  if (childProc && childProc.pid) {
    try { process.kill(-childProc.pid, 'SIGKILL'); } catch {}
    try { childProc.kill('SIGKILL'); } catch {}
    childProc = null;
  }
  if (tmpDataDir) {
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch {}
    tmpDataDir = null;
  }
}

after(() => cleanup());

test('1. Curated Indonesian evaluation corpus (>=100 fixtures + 20 mandatory cases)', () => {
  assert.ok(CORPUS.length >= 100, `Expected >=100 corpus fixtures, got ${CORPUS.length}`);

  const report = DIAG.evaluateCorpus(CORPUS, fx => SOC.socAssess(fx.text));
  console.log('\n[eval-corpus] summary:', JSON.stringify({
    total: report.total,
    confusion: report.confusion,
    precision: report.precision,
    recall: report.recall,
    f1: report.f1,
    falsePositiveRate: report.falsePositiveRate,
    falseNegativeRate: report.falseNegativeRate,
    feedRoutingAccuracy: report.feedRoutingAccuracy,
    intentAccuracy: report.intentAccuracy,
  }));

  if (report.failures.length > 0) {
    console.log('[eval-corpus] failures:', JSON.stringify(report.failures, null, 2));
  }

  const mandatory = CORPUS.filter(fx => String(fx.id).startsWith('m'));
  assert.equal(mandatory.length, 20, 'All 20 mandatory test cases must be present');
  for (const fx of mandatory) {
    const res = SOC.socAssess(fx.text);
    const acceptableLanes = fx.acceptableLanes || [fx.expectedLane];
    const acceptableIntents = fx.acceptableIntents || [fx.expectedIntent];
    assert.equal(
      res.signalEligible,
      fx.expectedSignalEligible,
      `Mandatory ${fx.id} ("${fx.text}") signalEligible expected ${fx.expectedSignalEligible}, got ${res.signalEligible} (intent=${res.intent}, lane=${res.feedLane})`
    );
    assert.ok(
      acceptableLanes.includes(res.feedLane),
      `Mandatory ${fx.id} ("${fx.text}") lane expected in ${JSON.stringify(acceptableLanes)}, got ${res.feedLane}`
    );
    assert.ok(
      acceptableIntents.includes(res.intent),
      `Mandatory ${fx.id} ("${fx.text}") intent expected in ${JSON.stringify(acceptableIntents)}, got ${res.intent}`
    );
    if (fx.expectedGeo) {
      assert.equal(
        res.geographicContext && res.geographicContext.name,
        fx.expectedGeo,
        `Mandatory ${fx.id} expectedGeo ${fx.expectedGeo}, got ${res.geographicContext && res.geographicContext.name}`
      );
    }
    if (fx.expectedReaderGeo) {
      const mentions = (res.geographicContext && res.geographicContext.mentions) || [];
      assert.ok(
        mentions.some(m => m.name === fx.expectedReaderGeo && (m.role === 'reader_location' || m.role === 'author_current_location')),
        `Mandatory ${fx.id} expected reader geo ${fx.expectedReaderGeo} with non-event role, got ${JSON.stringify(mentions)}`
      );
    }
  }

  assert.ok(report.precision >= 0.94, `Precision too low: ${report.precision}`);
  assert.ok(report.recall >= 0.90, `Recall too low: ${report.recall}`);
  assert.ok(report.falsePositiveRate <= 0.04, `FPR too high: ${report.falsePositiveRate}`);
  assert.ok(report.feedRoutingAccuracy >= 0.85, `Feed routing accuracy too low: ${report.feedRoutingAccuracy}`);
  assert.ok(report.intentAccuracy >= 0.82, `Intent accuracy too low: ${report.intentAccuracy}`);
});

test('2. Dynamic & ad-hoc location hardening: generic cities never become ad-hoc incident categories or bypass classification', () => {
  const genericLocations = ['Jakarta', 'jakarta', 'Bandung', 'Surabaya', 'Indonesia', 'Jawa Barat', 'Kebumen', 'DKI Jakarta', 'Medan'];
  for (const loc of genericLocations) {
    assert.equal(ASSESS.isGenericLocationPhrase(loc), true, `Expected ${loc} to be flagged as generic location`);
  }

  const built = SOC.socAdhoc([...genericLocations, 'kebakaran pasar', 'banjir bandang']);
  assert.deepEqual(
    built.map(t => t.id),
    ['kebakaran pasar', 'banjir bandang'],
    'socAdhoc must strip all generic location phrases'
  );

  const poisonedAdhoc = [{
    id: 'jakarta',
    label: 'JAKARTA',
    adhoc: true,
    local: true,
    pos: /\bjakarta\b/i,
  }];

  const noiseTexts = [
    'Dijual rumah 2 lantai di Jakarta Selatan, harga nego',
    'Capek banget kerja di Jakarta, pengen resign',
    'LOKER JAKARTA: dibutuhkan kasir dan admin gudang',
    'Open rent lightstick konser di GBK Jakarta murah',
    'Jakarta selalu punya tempat di hati',
    'Jakarta tidak terjadi banjir hari ini',
  ];

  for (const text of noiseTexts) {
    const a = ASSESS.assess(text, poisonedAdhoc);
    assert.equal(a.signalEligible, false, `Poisoned adhoc must not make "${text}" signalEligible`);
    assert.equal(a.feedEligible, false, `Poisoned adhoc must not make "${text}" feedEligible`);
    assert.equal(a.feedLane, 'rejected', `Expected "${text}" to be rejected even with poisoned adhoc`);
  }
});

test('3. Layer 2 Indonesian social media normalization preserves raw text and decodes slang, elongations, hashtags, and regional forms', () => {
  const raw = 'Air selokan udah naikk banjiiir masuk rmh gw di bks #BanjirBekasi parahhh bgt &amp; macet';
  const norm = NLP.normalizeIndonesian(raw);

  assert.equal(norm.raw, raw, 'Original post text must remain untouched');
  assert.ok(norm.normalized.includes('sudah'), `Expected "udah" normalized -> "sudah", got: ${norm.normalized}`);
  assert.ok(norm.normalized.includes('rumah'), `Expected "rmh" normalized -> "rumah", got: ${norm.normalized}`);
  assert.ok(norm.normalized.includes('saya'), `Expected "gw" normalized -> "saya", got: ${norm.normalized}`);
  assert.ok(norm.normalized.includes('bekasi'), `Expected "bks" normalized -> "bekasi", got: ${norm.normalized}`);
  assert.ok(norm.normalized.includes('banjir bekasi'), `Expected hashtag #BanjirBekasi segmented, got: ${norm.normalized}`);
  assert.ok(/\bbanjir\b/.test(norm.normalized), `Expected elongated "banjiiir" normalized -> "banjir", got: ${norm.normalized}`);

  const pluralRedup = NLP.normalizeIndonesian('Rumah-rumah warga di Dayeuhkolot kebanjiran');
  const leisureRedup = NLP.normalizeIndonesian('Jalan-jalan sore di Jakarta');
  assert.ok(pluralRedup.reduplication.collective.length > 0);
  assert.ok(leisureRedup.reduplication.leisure.length > 0);

  for (const regional of [
    'barusan kerasa lindhu gede banget di jogja',
    'caah gede pisan di bandung selatan caina geus asup ka imah',
    'banyu kali wis mlebu omah nang semarang timur',
  ]) {
    const res = SOC.socAssess(regional);
    assert.equal(res.signalEligible, true, `Regional expression "${regional}" should be recognized as signalEligible`);
  }
});

test('4. Layer 4-6 Word-sense disambiguation, clause negation, unknown impact honesty, and geo role disambiguation', () => {

  const literalExplosion = SOC.socAssess('Tabung gas elpiji meledak di ruko Tangerang, dua korban luka');
  const priceExplosion = SOC.socAssess('Harga tiket pesawat Jakarta Bali makin meledak jelang liburan');
  assert.equal(literalExplosion.signalEligible, true);
  assert.equal(priceExplosion.signalEligible, false);
  assert.equal(priceExplosion.feedLane, 'rejected');

  const literalFire = SOC.socAssess('Gudang tekstil di Bandung terbakar hebat malam ini');
  const envyFire = SOC.socAssess('Terbakar api cemburu lihat mantan jalan di Bandung');
  assert.equal(literalFire.signalEligible, true);
  assert.equal(envyFire.signalEligible, false);

  const policeArrest = SOC.socAssess('Pelaku curanmor diamankan polisi di Polsek Bekasi Timur');
  const moneySafe = SOC.socAssess('Uang belanja sudah diamankan di dalam brankas rumah Jakarta');
  assert.equal(policeArrest.signalEligible, true);
  assert.equal(moneySafe.signalEligible, false);

  const cyberLeak = SOC.socAssess('Database pasien RSUD Surabaya bocor dan dijual di forum hacker');
  const roofLeak = SOC.socAssess('Atap kamar kosan bocor lagi tiap hujan di Jakarta');
  assert.equal(cyberLeak.signalEligible, true);
  assert.equal(roofLeak.signalEligible, false);

  const mixedClause = SOC.socAssess('Banjir tidak terjadi di Bekasi, tapi kebakaran hebat melanda pasar di Depok');
  assert.equal(mixedClause.signalEligible, true);
  assert.equal(mixedClause.geographicContext && mixedClause.geographicContext.name, 'Depok');
  assert.ok(!mixedClause.topics.includes('banjir'), 'Negated banjir clause should not activate banjir topic');
  assert.ok(mixedClause.topics.includes('kebakaran'), 'Real kebakaran clause should activate kebakaran topic');

  const noImpactMention = SOC.socAssess('Banjir merendam rumah warga di Bekasi');
  assert.equal(noImpactMention.event.impact.fatalities, null);
  assert.equal(noImpactMention.event.impact.injuries, null);
  assert.equal(noImpactMention.event.impact.displacement, null);

  const injuredMention = SOC.socAssess('Kebakaran ruko di Depok, 3 orang luka dibawa ke RS');
  assert.equal(injuredMention.event.impact.injuries, 3);
  assert.equal(injuredMention.event.impact.fatalities, null);

  const readerDistinction = SOC.socAssess('Saya membaca berita banjir Jakarta dari Bandung');
  assert.equal(readerDistinction.signalEligible, false);
  assert.equal(readerDistinction.feedLane, 'situational_context');
  assert.equal(readerDistinction.geographicContext.name, 'Jakarta');
  assert.equal(readerDistinction.geographicContext.role, 'event_location');

  const polresPlace = GEO.locate('Polsek Rawalumbu, Polres Metro Bekasi Kota evakuasi korban kecelakaan di Jalan Cut Mutia');
  assert.equal(polresPlace && polresPlace.name, 'Bekasi');
});

test('5. Deduplication, corroboration provenance, engagement exclusion & same-city multi-incident separation', () => {
  const now = Date.now();
  const makePost = (overrides) => {
    const a = SOC.socAssess(overrides.text, [], overrides);
    return {
      created_at: new Date(overrides.ts || now).toISOString(),
      ts: overrides.ts || now,
      assessment: a,
      ...overrides,
    };
  };

  const viralAnon = makePost({
    handle: '@random_viral',
    text: 'Banjir merendam permukiman warga di Bekasi Barat malam ini',
    likes: 95000,
    retweets: 25000,
  });
  const eyewitnessPost = makePost({
    handle: '@warga_bks',
    text: 'Air udah masuk rumah gue di Bekasi Barat malam ini tolong',
    likes: 1,
    retweets: 0,
  });
  const officialBmkg = makePost({
    handle: '@infobmkg',
    text: 'BMKG keluarkan peringatan hujan ekstrem untuk Jakarta Selatan malam ini',
    likes: 12,
    retweets: 5,
  });
  assert.equal(viralAnon.assessment.provenance.sourceType, 'anonymous');
  assert.equal(eyewitnessPost.assessment.provenance.sourceType, 'eyewitness');
  assert.equal(officialBmkg.assessment.provenance.sourceType, 'official_agency');
  assert.equal(officialBmkg.assessment.provenance.engagementExcludedFromCredibility, true);
  assert.ok(
    officialBmkg.assessment.provenance.authorityWeight > eyewitnessPost.assessment.provenance.authorityWeight &&
    eyewitnessPost.assessment.provenance.authorityWeight > viralAnon.assessment.provenance.authorityWeight,
    'Authority hierarchy official_agency > eyewitness > anonymous must hold regardless of viral engagement'
  );

  const orig = makePost({
    from: 'X',
    handle: '@detikcom',
    text: 'Kebakaran hebat melalap 20 kios di Pasar Baru Bekasi pagi ini, tim damkar berjibaku padamkan api',
  });
  const rtCopy = makePost({
    from: 'X',
    handle: '@reposter_akun',
    text: 'RT @detikcom: Kebakaran hebat melalap 20 kios di Pasar Baru Bekasi pagi ini, tim damkar berjibaku padamkan api https://t.co/abc',
  });
  const thCopy = makePost({
    from: 'Threads',
    handle: '@berita_bekasi',
    text: 'Kebakaran hebat melalap 20 kios di Pasar Baru Bekasi pagi ini, tim damkar berjibaku padamkan api #viral via @detikcom',
  });

  const floodBekasi1 = makePost({
    from: 'X',
    handle: '@warga_pondok',
    text: 'Air udah masuk rumah gue di Pondok Gede Bekasi setelah tanggul jebol',
  });
  const floodBekasi2 = makePost({
    from: 'Threads',
    handle: '@detikcom',
    text: 'Tanggul Kali Bekasi jebol di Pondok Gede Bekasi, puluhan rumah warga terendam banjir',
  });

  const clusters = CLUSTER.clusterIncidents([orig, rtCopy, thCopy, floodBekasi1, floodBekasi2]);
  assert.equal(clusters.length, 2, 'Two distinct incidents in Bekasi (fire vs flood) must NOT merge just because city=Bekasi');

  const fireCluster = clusters.find(c => c.category === 'fire');
  const floodCluster = clusters.find(c => c.category === 'flood');
  assert.ok(fireCluster, 'Fire cluster must exist');
  assert.ok(floodCluster, 'Flood cluster must exist');

  assert.equal(fireCluster.independentClaims, 1, 'Exact/near-duplicate RT and cross-platform reposts must fold to 1 claim');
  assert.equal(fireCluster.totalCopiesWithDuplicates, 3, 'All 3 copies must still be accounted for in totalCopiesWithDuplicates');
  assert.equal(floodCluster.independentClaims, 2, 'Two independent descriptions of the Pondok Gede flood should corroborate');
  assert.equal(floodCluster.corroborationLevel, 'multi_source_corroborated');

  assert.equal(SIGNALS.VERSION, '2026-11-07.3', 'Must preserve client UMD default VERSION contract');
  assert.equal(
    CLUSTER.stripBoilerplateForSimilarity(orig.text),
    CLUSTER.stripBoilerplateForSimilarity(rtCopy.text),
    'stripBoilerplateForSimilarity should fold RT prefixes and URLs'
  );
  assert.equal(CLUSTER.isNearDuplicate(orig.text, thCopy.text), true, 'Cross-platform variant must be detected as near-duplicate');

  SIGNALS.adoptClassifierVersion(SOC.CLASSIFIER_VERSION);
  const sigGroups = SIGNALS.buildGroups([orig, floodBekasi1, floodBekasi2], now);
  assert.equal(sigGroups.length, 2, 'signals.buildGroups should keep fire and flood groups separate');
  assert.equal(sigGroups.find(g => g.cat === 'fire').provenanceSummary.hasNews, true);
  assert.equal(sigGroups.find(g => g.cat === 'flood').provenanceSummary.hasEyewitness, true);
});

test('6. social-history.js tag() and retag() purge stale ad-hoc location noise upon classifier upgrade', () => {
  const now = Date.now();
  const map = new Map();

  map.set('stale_ad', {
    url: 'https://x.com/user1/status/1',
    text: 'Dijual rumah 2 lantai di Jakarta Selatan dekat stasiun harga nego',
    ts: now - 3600e3,
    adhocPhrases: ['jakarta'],
    assessment: { version: '2026-04-01.1', topics: ['jakarta'], signalEligible: true, feedEligible: true },
  });
  map.set('stale_vent', {
    url: 'https://x.com/user2/status/2',
    text: 'Capek banget kerja di Jakarta pengen resign aja tiap hari macet',
    ts: now - 1800e3,
    adhocPhrases: ['jakarta'],
    assessment: { version: '2026-04-01.1', topics: ['jakarta'], signalEligible: true, feedEligible: true },
  });
  map.set('valid_flood', {
    url: 'https://x.com/user3/status/3',
    text: 'Banjir merendam puluhan rumah warga di Bekasi Timur pagi ini',
    ts: now - 1200e3,
    adhocPhrases: ['jakarta'],
    assessment: { version: '2026-04-01.1', topics: ['jakarta'], signalEligible: false, feedEligible: false },
  });
  map.set('short_no_media', {
    url: 'https://x.com/user4/status/4',
    text: 'Banjir!',
    ts: now - 600e3,
  });

  const extra = SOC.socAdhoc(['Jakarta', 'kebakaran pasar']);
  HISTORY.retag(map, SOC.socKeepX, extra, now);

  assert.equal(map.has('stale_ad'), false, 'Legacy ad post must be purged by retag');
  assert.equal(map.has('stale_vent'), false, 'Legacy personal vent post must be purged by retag');
  assert.equal(map.has('short_no_media'), false, 'Sub-10 char post without media must be purged');
  assert.equal(map.has('valid_flood'), true, 'Genuine flood report must survive retag and upgrade');

  const kept = map.get('valid_flood');
  assert.equal(kept.assessment.version, SOC.CLASSIFIER_VERSION);
  assert.equal(kept.assessment.signalEligible, true);
  assert.ok(!kept.adhocPhrases.includes('jakarta'), 'Generic location phrase must be stripped from saved adhocPhrases');
});

test('7. nlp-adapter.js redacts PII, stays deterministic offline, and never turns errors into signals', async () => {

  const redacted = ADAPTER.redactPII('Hubungi @admin_budi 081234567890 atau budi@example.com NIK 3275011234567890 https://x.com/a/1');
  assert.ok(!redacted.includes('081234567890'));
  assert.ok(!redacted.includes('budi@example.com'));
  assert.ok(!redacted.includes('@admin_budi'));
  assert.ok(!redacted.includes('3275011234567890'));
  assert.ok(!redacted.includes('https://x.com/a/1'));
  assert.ok(redacted.includes('[PHONE]') && redacted.includes('[EMAIL]') && redacted.includes('[USER]') && redacted.includes('[URL]'));

  const localQ = SOC.socAssess('Ada yang dengar ledakan di daerah Jakarta?');
  const offline = ADAPTER.createNlpAdapter({ env: {} });
  assert.equal(offline.isAvailable(), false);
  const offRes = await offline.disambiguate('Ada yang dengar ledakan di daerah Jakarta?', localQ);
  assert.equal(offRes.usedExternal, false);
  assert.equal(offRes.assessment.signalEligible, false);

  let fetchCalls = 0;
  const failing = ADAPTER.createNlpAdapter({
    env: {
      SITREP_NLP_PROVIDER: 'openai-compat',
      SITREP_NLP_ENDPOINT: 'https://example.invalid/v1/classify',
      SITREP_NLP_API_KEY: 'dummy-test-key',
      SITREP_NLP_TIMEOUT_MS: '600',
    },
    fetchFn: async () => {
      fetchCalls++;
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });

  for (let i = 0; i < 4; i++) {
    const r = await failing.disambiguate(`Pertanyaan warga ke-${i} soal Jakarta banjir nggak?`, localQ);
    assert.equal(r.usedExternal, false);
    assert.equal(r.assessment.signalEligible, false);
  }
  const st = failing.getStats();
  assert.equal(st.circuitOpen, true, 'Circuit breaker must open after 3 consecutive failing disambiguations');
  assert.ok(st.circuitSkips >= 1, '4th call should be skipped immediately while circuit is open');
  assert.equal(st.failures, 3);
});

test('8. explainPost & SOC.diagnostics track single-post trace and aggregate counters', () => {
  SOC.diagnostics.reset();
  SOC.diagnostics.recordRetrieved('x', 'adhoc', 10);
  SOC.socAssess('Banjir merendam rumah warga di Bekasi', [], { platform: 'x', discoverySource: 'permanent', recordDiagnostics: true });
  SOC.socAssess('Dijual rumah 2 lantai di Jakarta Selatan', [], { platform: 'x', discoverySource: 'adhoc', recordDiagnostics: true });
  SOC.socAssess('Jakarta banjir nggak sih?', [], { platform: 'threads', discoverySource: 'permanent', recordDiagnostics: true });

  const snap = SOC.diagnostics.snapshot();
  assert.equal(snap.retrieved, 10);
  assert.equal(snap.classified, 3);
  assert.equal(snap.incidentSignals, 1);
  assert.equal(snap.contextualPosts, 1);
  assert.equal(snap.rejected, 1);
  assert.equal(snap.byPlatform.x.classified, 2);
  assert.equal(snap.byPlatform.threads.contextualPosts, 1);

  const expl = SOC.explainPost('BMKG keluarkan peringatan hujan ekstrem untuk Jakarta');
  assert.equal(expl.classifierVersion, SOC.CLASSIFIER_VERSION);
  assert.ok(expl.normalizedText);
  assert.ok(expl.clauses >= 1);
  assert.equal(expl.intent, 'official_warning');
  assert.equal(expl.feedLane, 'incident_signals');
  assert.equal(expl.signalEligible, true);
  assert.equal(expl.geographicContext.name, 'Jakarta');
  assert.ok(expl.layerTrace && expl.layerTrace.normalization && Array.isArray(expl.layerTrace.intentScoresTop3) && expl.layerTrace.geoRole);
});

test('9. HTTP integration: server.js purges legacy ad-hoc noise on load and serves diagnostics + explain endpoints', { timeout: 30000 }, async (t) => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-social-int-'));
  const now = Date.now();

  fs.writeFileSync(path.join(tmpDataDir, 'x-history.json'), JSON.stringify({
    classifierVersion: 'legacy-v0',
    posts: [
      {
        url: 'https://x.com/infobmkg/status/101',
        handle: '@infobmkg',
        user: 'infobmkg',
        text: 'BMKG keluarkan peringatan hujan ekstrem disertai angin kencang untuk wilayah Jakarta Selatan',
        created_at: new Date(now - 900e3).toISOString(),
        ts: now - 900e3,
      },
      {
        url: 'https://x.com/warga_bks/status/102',
        handle: '@warga_bks',
        user: 'warga_bks',
        text: 'Air udah masuk rumah gue di Bekasi setelah hujan deras sejam',
        created_at: new Date(now - 600e3).toISOString(),
        ts: now - 600e3,
      },
      {
        url: 'https://x.com/penjual/status/103',
        handle: '@penjual',
        user: 'penjual',
        text: 'Dijual rumah 2 lantai di Jakarta Selatan harga nego siap huni KPR',
        created_at: new Date(now - 300e3).toISOString(),
        ts: now - 300e3,
        adhocPhrases: ['jakarta'],
        assessment: { version: 'legacy-v0', topics: ['jakarta'], feedEligible: true, signalEligible: true },
      },
      {
        url: 'https://x.com/nanya/status/104',
        handle: '@nanya',
        user: 'nanya',
        text: 'Ada yang dengar suara ledakan keras di daerah Jakarta barusan?',
        created_at: new Date(now - 200e3).toISOString(),
        ts: now - 200e3,
      },
    ],
  }));

  fs.writeFileSync(path.join(tmpDataDir, 'threads-history.json'), JSON.stringify({
    classifierVersion: 'legacy-v0',
    posts: [
      {
        code: 'TH101',
        handle: '@warga_depok',
        username: 'warga_depok',
        text: 'Kebakaran melalap 4 ruko di Jalan Margonda Depok malam ini petugas damkar sudah di lokasi',
        created_at: new Date(now - 400e3).toISOString(),
        ts: now - 400e3,
      },
      {
        code: 'TH102',
        handle: '@curhat_jkt',
        username: 'curhat_jkt',
        text: 'Capek banget kerja di Jakarta pengen resign aja tiap hari pulang malem',
        created_at: new Date(now - 250e3).toISOString(),
        ts: now - 250e3,
        adhocPhrases: ['jakarta'],
      },
    ],
  }));

  const port = 25000 + Math.floor(Math.random() * 15000);
  const token = 'test-social-token-999';
  const base = `http://127.0.0.1:${port}`;

  childProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      SITREP_TOKEN: token,
      SITREP_DATA_DIR: tmpDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  childProc.stdout.on('data', () => {});
  childProc.stderr.on('data', () => {});

  const deadline = Date.now() + 12000;
  let ready = false;
  while (Date.now() < deadline) {
    if (childProc.exitCode !== null) throw new Error('server exited prematurely with code ' + childProc.exitCode);
    try {
      const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1000) });
      if (r.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(ready, 'Test server must become ready on /api/ping');

  const hdrs = { 'x-sitrep-token': token };

  await t.test('GET /api/x returns purified incident_signals + situational_context and excludes property listing noise', async () => {
    const r = await fetch(`${base}/api/x`, { headers: hdrs, signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.classifierVersion, SOC.CLASSIFIER_VERSION);
    assert.ok(data.diagnostics && typeof data.diagnostics.classified === 'number');

    const texts = data.posts.map(p => p.text);
    assert.ok(texts.some(s => s.includes('BMKG keluarkan peringatan')), 'Official warning must be present');
    assert.ok(texts.some(s => s.includes('Air udah masuk rumah gue di Bekasi')), 'Informal eyewitness must be present');
    assert.ok(!texts.some(s => s.includes('Dijual rumah 2 lantai')), 'Property ad must be purged from /api/x');

    const bmkg = data.posts.find(p => p.text.includes('BMKG keluarkan'));
    assert.equal(bmkg.assessment.feedLane, 'incident_signals');
    assert.equal(bmkg.assessment.signalEligible, true);

    const qPost = data.posts.find(p => p.text.includes('Ada yang dengar suara ledakan'));
    assert.ok(qPost, 'Question post should survive into situational_context');
    assert.equal(qPost.assessment.feedLane, 'situational_context');
    assert.equal(qPost.assessment.signalEligible, false);
  });

  await t.test('GET /api/threads returns Depok fire incident and purges personal vent', async () => {
    const r = await fetch(`${base}/api/threads`, { headers: hdrs, signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    const data = await r.json();
    const texts = data.posts.map(p => p.text);
    assert.ok(texts.some(s => s.includes('Kebakaran melalap 4 ruko di Jalan Margonda Depok')));
    assert.ok(!texts.some(s => s.includes('Capek banget kerja di Jakarta')));
  });

  await t.test('GET /api/social/diagnostics returns classifier version, lanes, dropStats, and clustersCount', async () => {
    const r = await fetch(`${base}/api/social/diagnostics`, { headers: hdrs, signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.ok, true);
    assert.equal(data.classifierVersion, SOC.CLASSIFIER_VERSION);
    assert.ok(data.diagnostics && data.diagnostics.classified >= 1);
    assert.ok(data.dropStats && data.dropStats.lanes);
    assert.ok(typeof data.clustersCount === 'number' && data.clustersCount >= 1);
  });

  await t.test('GET & POST /api/social/explain explains classification step-by-step and rejects invalid input', async () => {
    const rBad = await fetch(`${base}/api/social/explain`, { headers: hdrs, signal: AbortSignal.timeout(5000) });
    assert.equal(rBad.status, 400);

    const rPost = await fetch(`${base}/api/social/explain`, {
      method: 'POST',
      headers: { ...hdrs, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Harga rumah Jakarta makin meledak' }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(rPost.status, 200);
    const out = await rPost.json();
    assert.equal(out.ok, true);
    assert.equal(out.explanation.feedLane, 'rejected');
    assert.equal(out.explanation.signalEligible, false);
    assert.ok(out.explanation.rejectedReasons.length > 0);
  });

  await t.test('Unauthenticated /api/social/diagnostics fails with 403', async () => {
    const r = await fetch(`${base}/api/social/diagnostics`, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 403);
  });
});

test('10. Foreign cognate leak defense vs. Jaksel Indo-English code-switching preservation', () => {
  const now = Date.now();
  const foreignAndNoise = [
    'Me habrá dado covid?',
    'Is het kabinet nog niet gevallen?',
    'Gaat het kabinet vallen?',
    'Het #kabinet staat op vallen hè..? #VVD',
    'Kan het ook zo zijn dat morgen voor het belasting wordt gestemd en de VVD dan na die stemming uit het kabinet stapt , de wet toch door gaat ? En misschien de VVD ook wel ?',
    `Dus als vanavond door toedoen van de Brutus-aanval op de VVD door CDA en D66 het kabinet valt, dan komen er geen nieuwe verkiezingen maar gaan ze 'tussenformeren'.

Mijn conclusie: we hebben vorig jaar verkiezingen gehad, dan mag de grootste partij de formatie oppakken. Nu dat kabinet lijkt te vallen, zou de één na grootste partij, de PVV, dus het voortouw mogen nemen.

Maar die conclusie trekt men in Den Haag natuurlijk niet! De regerende partijen minus VVD (zo lijkt het) gaan op zoek naar één of twee nieuwe kandidaat-coalitieleden.

Met andere woorden: uit de verkiezingsuitslag van vorig jaar bleek dat er een meerderheid op rechts lag, maar na dit debacle-kabinet gaan we een links kabinet krijgen. Dus: de kiezer stemt in meerderheid rechts maar we slaan linksaf.

Hoezo democratie?`,
    'Wann zerbricht die Koalition im Bundestag und wann tritt das Kabinett von Scholz endlich zurück?',
    'Est-ce que le cabinet de Macron va annoncer la dissolution de l’Assemblée nationale ce soir ?',
    'L’INFIDÉLITÉ : un nouveau Covid ?',
    'Nouveau variant du COVID @grok ?',
    'o covid assusta o povo, né?',
    'Varian Baharu COVID-19 PJ.2.1 Dikesan Di Beberapa Negara, Sejauh Mana Bahayanya?',
    'Nationwide blackout?',
    'So apparently there’s gonna be a blackout?',
    'What happens if tsunami comes ?',
    'Dawg a use a hotspot from him fone?',
    'friend is using a hotspot to download GTA VI???',
    'Who Runs the Ransomware Group Qilin?',
    'COVID :Cancer?',
    'ada yg masih bgn??',
    'MBG DISBAND???',
    'beneran banjir konten plsssss',
    'IHSG Kebakaran +0,21%',
    'Kangen suasana jaman covid dulu jalanan sepi banget',
  ];

  for (const text of foreignAndNoise) {
    const a = SOC.socAssess(text);
    assert.equal(a.signalEligible, false, `Expected "${text}" signalEligible=false, got true`);
    assert.equal(a.feedEligible, false, `Expected "${text}" feedEligible=false, got true (lane=${a.feedLane}, topics=${JSON.stringify(a.topics)})`);
    const post = { text, ts: now - 60000, created_at: new Date(now - 60000).toISOString(), handle: '@testuser' };
    assert.equal(HISTORY.tag(post, [], now), false, `Expected HISTORY.tag to reject "${text}"`);
  }

  const jakselAndLocal = [
    {
      text: 'Jujurly agak parno covid lagi naik ya di Jaksel, ada yg ngerasa badan meriang juga ga sih guys?',
      expectFeed: true,
    },
    {
      text: 'Literally di Kemang blackout parah bgt udah 2 jam, PLN ada info kapan nyala ga sih?',
      expectFeed: true,
    },
    {
      text: 'Guys ada yg ngerasa gempa barusan di Jakarta Selatan ga sih? Lumayan berasa di kantor gue',
      expectFeed: true,
    },
    {
      text: 'PIM MATI LAMPU?????',
      expectFeed: true,
    },
    {
      text: 'Katanya di Bekasi tanggul kali ada yang jebol lagi ya barusan?',
      expectFeed: true,
    },
  ];

  for (const item of jakselAndLocal) {
    const a = SOC.socAssess(item.text);
    assert.equal(a.feedEligible, item.expectFeed, `Expected Jaksel/local post "${item.text}" feedEligible=${item.expectFeed}, got ${a.feedEligible} (lane=${a.feedLane}, rejected=${JSON.stringify(a.rejectedReasons)})`);
    const post = { text: item.text, ts: now - 60000, created_at: new Date(now - 60000).toISOString(), handle: '@anakjaksel' };
    assert.equal(HISTORY.tag(post, [], now), true, `Expected HISTORY.tag to keep Jaksel/local post "${item.text}"`);
  }
});
