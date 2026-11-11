'use strict';

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 2500;
const MAX_RETRIES = 1;
const CACHE_CAP = 512;

function getConfig(env = process.env) {
  const provider = String(env.SITREP_NLP_PROVIDER || '').trim().toLowerCase();
  const endpoint = String(env.SITREP_NLP_ENDPOINT || '').trim();
  const apiKey = String(env.SITREP_NLP_API_KEY || '').trim();
  const model = String(env.SITREP_NLP_MODEL || '').trim();
  const timeoutMs = Math.max(500, Math.min(10000, Number(env.SITREP_NLP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  const enabled = Boolean(provider && endpoint && apiKey);
  return { enabled, provider, endpoint, apiKey, model, timeoutMs };
}

function redactPII(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
    .replace(/@[\w.]+/g, '[USER]')
    .replace(/(?<![\w+])(?:\+?62|0)8\d{7,11}\b/g, '[PHONE]')
    .replace(/\b\d{12,16}\b/g, '[ID]')
    .trim();
}

function createNlpAdapter(opts = {}) {
  const fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch : null);
  const env = opts.env || process.env;
  const resultCache = new Map();
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const stats = { calls: 0, cacheHits: 0, successes: 0, failures: 0, fallbacks: 0, circuitSkips: 0 };

  function isAvailable() {
    const cfg = getConfig(env);
    if (!cfg.enabled || !fetchFn) return false;
    if (Date.now() < circuitOpenUntil) return false;
    return true;
  }

  function cacheSet(k, v) {
    if (resultCache.size >= CACHE_CAP) resultCache.delete(resultCache.keys().next().value);
    resultCache.set(k, v);
  }

  async function invokeExternal(redactedText, localAssessment, cfg) {
    const payload = {
      model: cfg.model || 'sitrep-id-intent-v1',
      text: redactedText,
      localIntent: localAssessment && localAssessment.intent,
      localFeedLane: localAssessment && localAssessment.feedLane,
      localConfidence: localAssessment && localAssessment.confidence,
    };

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('NLP adapter timeout')), cfg.timeoutMs);
      try {
        const res = await fetchFn(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer ' + cfg.apiKey,
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error('NLP HTTP ' + res.status);
        const data = await res.json();
        if (!data || typeof data.intent !== 'string') throw new Error('Invalid NLP payload');
        return data;
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function disambiguate(rawText, localAssessment) {
    const cfg = getConfig(env);
    if (!cfg.enabled || !fetchFn) {
      stats.fallbacks++;
      return { usedExternal: false, reason: 'disabled_offline_fallback', assessment: localAssessment };
    }
    if (Date.now() < circuitOpenUntil) {
      stats.circuitSkips++;
      stats.fallbacks++;
      return { usedExternal: false, reason: 'circuit_open_fallback', assessment: localAssessment };
    }

    if (localAssessment && (localAssessment.feedLane === 'incident_signals' || localAssessment.feedLane === 'rejected')) {
      return { usedExternal: false, reason: 'not_borderline', assessment: localAssessment };
    }

    const redacted = redactPII(rawText);
    const key = crypto.createHash('sha1').update((cfg.model || '') + '|' + redacted).digest('hex');
    if (resultCache.has(key)) {
      stats.cacheHits++;
      return { usedExternal: true, cached: true, override: resultCache.get(key), assessment: localAssessment };
    }

    stats.calls++;
    try {
      const out = await invokeExternal(redacted, localAssessment, cfg);
      consecutiveFailures = 0;
      stats.successes++;
      const sanitized = {
        intent: String(out.intent || '').slice(0, 40),
        confidence: Number.isFinite(Number(out.confidence)) ? Math.max(0, Math.min(1, Number(out.confidence))) : null,
        isMetaphor: Boolean(out.isMetaphor),
        isSarcasm: Boolean(out.isSarcasm),
      };
      cacheSet(key, sanitized);
      return { usedExternal: true, override: sanitized, assessment: localAssessment };
    } catch (err) {
      consecutiveFailures++;
      stats.failures++;
      stats.fallbacks++;
      if (consecutiveFailures >= 3) {
        circuitOpenUntil = Date.now() + 60000;
      }

      return {
        usedExternal: false,
        reason: 'error_deterministic_fallback',
        error: String(err && err.message || err).slice(0, 120),
        assessment: localAssessment,
      };
    }
  }

  return {
    isAvailable,
    disambiguate,
    getStats: () => ({ ...stats, circuitOpen: Date.now() < circuitOpenUntil, cacheSize: resultCache.size }),
    reset: () => {
      resultCache.clear();
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      for (const k of Object.keys(stats)) stats[k] = 0;
    },
  };
}

module.exports = {
  getConfig,
  redactPII,
  createNlpAdapter,
};
