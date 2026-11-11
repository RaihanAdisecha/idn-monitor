'use strict';

function makeBucket() {
  return {
    retrieved: 0,
    classified: 0,
    topicMatches: 0,
    incidentSignals: 0,
    contextualPosts: 0,
    discoveryCandidates: 0,
    rejected: 0,
  };
}

function createDiagnostics() {
  const state = {
    startedAt: Date.now(),
    retrieved: 0,
    classified: 0,
    topicMatches: 0,
    incidentSignals: 0,
    contextualPosts: 0,
    discoveryCandidates: 0,
    rejected: 0,
    rejectionReasons: Object.create(null),
    intents: Object.create(null),
    confidenceDistribution: { high: 0, medium: 0, low: 0 },
    byPlatform: {
      x: makeBucket(),
      threads: makeBucket(),
      other: makeBucket(),
    },
    byDiscoverySource: {
      permanent: makeBucket(),
      adhoc: makeBucket(),
      profile: makeBucket(),
      lazy: makeBucket(),
    },
    cache: { hits: 0, misses: 0, size: 0 },
  };

  function incMap(map, key) {
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(map, key) && Object.keys(map).length >= 120) return;
    map[key] = (map[key] || 0) + 1;
  }

  function recordRetrieved(platform = 'other', discoverySource = 'permanent', count = 1) {
    const n = Math.max(0, Number(count) || 0);
    state.retrieved += n;
    const pBucket = state.byPlatform[platform] || state.byPlatform.other;
    pBucket.retrieved += n;
    const dBucket = state.byDiscoverySource[discoverySource] || state.byDiscoverySource.permanent;
    dBucket.retrieved += n;
  }

  function recordClassification(assessment, meta = {}) {
    if (!assessment) return;
    const platform = meta.platform === 'x' ? 'x' : (meta.platform === 'th' || meta.platform === 'threads') ? 'threads' : 'other';
    const discovery = meta.discoverySource || (meta.isAdhoc ? 'adhoc' : 'permanent');

    const pBucket = state.byPlatform[platform] || state.byPlatform.other;
    const dBucket = state.byDiscoverySource[discovery] || state.byDiscoverySource.permanent;

    state.classified++;
    pBucket.classified++;
    dBucket.classified++;

    if (Array.isArray(assessment.topics) && assessment.topics.length > 0) {
      state.topicMatches++;
      pBucket.topicMatches++;
      dBucket.topicMatches++;
    }

    const lane = (assessment.classification && assessment.classification.feedLane) || assessment.feedLane || 'rejected';
    if (lane === 'incident_signals') {
      state.incidentSignals++;
      pBucket.incidentSignals++;
      dBucket.incidentSignals++;
    } else if (lane === 'situational_context') {
      state.contextualPosts++;
      pBucket.contextualPosts++;
      dBucket.contextualPosts++;
    } else if (lane === 'discovery_candidates') {
      state.discoveryCandidates++;
      pBucket.discoveryCandidates++;
      dBucket.discoveryCandidates++;
    } else {
      state.rejected++;
      pBucket.rejected++;
      dBucket.rejected++;
    }

    const intent = (assessment.classification && assessment.classification.intent) || assessment.intent || 'unknown';
    incMap(state.intents, intent);

    for (const r of (assessment.rejectedReasons || [])) {
      incMap(state.rejectionReasons, r);
    }

    const conf = Number((assessment.classification && assessment.classification.confidence) ?? assessment.confidence ?? 0);
    if (conf >= 0.8) state.confidenceDistribution.high++;
    else if (conf >= 0.5) state.confidenceDistribution.medium++;
    else state.confidenceDistribution.low++;
  }

  function recordCache(hit, size = 0) {
    if (hit) state.cache.hits++;
    else state.cache.misses++;
    state.cache.size = size;
  }

  function snapshot() {
    return {
      startedAt: state.startedAt,
      at: Date.now(),
      retrieved: state.retrieved,
      classified: state.classified,
      topicMatches: state.topicMatches,
      incidentSignals: state.incidentSignals,
      contextualPosts: state.contextualPosts,
      discoveryCandidates: state.discoveryCandidates,
      rejected: state.rejected,
      rejectionReasons: { ...state.rejectionReasons },
      intents: { ...state.intents },
      confidenceDistribution: { ...state.confidenceDistribution },
      byPlatform: {
        x: { ...state.byPlatform.x },
        threads: { ...state.byPlatform.threads },
        other: { ...state.byPlatform.other },
      },
      byDiscoverySource: {
        permanent: { ...state.byDiscoverySource.permanent },
        adhoc: { ...state.byDiscoverySource.adhoc },
        profile: { ...state.byDiscoverySource.profile },
        lazy: { ...state.byDiscoverySource.lazy },
      },
      cache: { ...state.cache },
    };
  }

  function reset() {
    state.startedAt = Date.now();
    state.retrieved = 0;
    state.classified = 0;
    state.topicMatches = 0;
    state.incidentSignals = 0;
    state.contextualPosts = 0;
    state.discoveryCandidates = 0;
    state.rejected = 0;
    state.rejectionReasons = Object.create(null);
    state.intents = Object.create(null);
    state.confidenceDistribution = { high: 0, medium: 0, low: 0 };
    state.byPlatform = { x: makeBucket(), threads: makeBucket(), other: makeBucket() };
    state.byDiscoverySource = { permanent: makeBucket(), adhoc: makeBucket(), profile: makeBucket(), lazy: makeBucket() };
    state.cache = { hits: 0, misses: 0, size: 0 };
  }

  return { recordRetrieved, recordClassification, recordCache, snapshot, reset };
}

function evaluateCorpus(corpus, classifyFn) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  let laneCorrect = 0;
  let intentCorrect = 0;
  const perClass = Object.create(null);
  const failures = [];

  const ensureClass = c => (perClass[c] || (perClass[c] = { total: 0, tp: 0, fp: 0, fn: 0, laneMatched: 0, intentMatched: 0 }));

  for (const fx of corpus) {
    const res = classifyFn(fx);
    const predSig = Boolean(res && res.signalEligible);
    const predLane = (res && res.classification && res.classification.feedLane) || (res && res.feedLane) || 'rejected';
    const predIntent = (res && res.classification && res.classification.intent) || (res && res.intent) || 'unknown';

    const expSig = Boolean(fx.expectedSignalEligible);
    const expLane = fx.expectedLane;
    const expIntent = fx.expectedIntent;

    const cStat = ensureClass(expIntent);
    cStat.total++;

    if (expSig && predSig) tp++;
    else if (!expSig && predSig) fp++;
    else if (!expSig && !predSig) tn++;
    else if (expSig && !predSig) fn++;

    if (predLane === expLane) {
      laneCorrect++;
      cStat.laneMatched++;
    }
    const intentAcceptable = Array.isArray(fx.acceptableIntents)
      ? fx.acceptableIntents.includes(predIntent) || predIntent === expIntent
      : predIntent === expIntent;
    if (intentAcceptable) {
      intentCorrect++;
      cStat.intentMatched++;
    }

    const laneAcceptable = Array.isArray(fx.acceptableLanes)
      ? fx.acceptableLanes.includes(predLane) || predLane === expLane
      : predLane === expLane;

    if (predSig === expSig && laneAcceptable) {
      cStat.tp++;
    } else {
      if (predSig && !expSig) cStat.fp++;
      if (!predSig && expSig) cStat.fn++;
      failures.push({
        id: fx.id || fx.text.slice(0, 40),
        text: fx.text,
        expected: { sig: expSig, lane: expLane, intent: expIntent },
        actual: { sig: predSig, lane: predLane, intent: predIntent, reasons: res && res.reasons, rejectedReasons: res && res.rejectedReasons },
      });
    }
  }

  const total = corpus.length || 1;
  const precision = (tp + fp) ? tp / (tp + fp) : 1;
  const recall = (tp + fn) ? tp / (tp + fn) : 1;
  const fpr = (fp + tn) ? fp / (fp + tn) : 0;
  const fnr = (tp + fn) ? fn / (tp + fn) : 0;
  const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    total: corpus.length,
    confusion: { tp, fp, tn, fn },
    precision: +precision.toFixed(4),
    recall: +recall.toFixed(4),
    f1: +f1.toFixed(4),
    falsePositiveRate: +fpr.toFixed(4),
    falseNegativeRate: +fnr.toFixed(4),
    feedRoutingAccuracy: +(laneCorrect / total).toFixed(4),
    intentAccuracy: +(intentCorrect / total).toFixed(4),
    perClass,
    failures,
  };
}

module.exports = {
  createDiagnostics,
  evaluateCorpus,
};
