'use strict';

function buildXAccounts(env = process.env, cfgX = {}) {
  const candidates = [];
  const pushPair = (tok, ct0) => {
    const a = String(tok || '').trim();
    const c = String(ct0 || '').trim();
    if (a && c) candidates.push({ auth_token: a, ct0: c });
  };

  const splitList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const envToks = splitList(env.X_AUTH_TOKEN);
  const envCts = splitList(env.X_CT0);
  if (envToks.length && envCts.length) {
    for (let i = 0; i < Math.min(envToks.length, envCts.length); i++) {
      pushPair(envToks[i], envCts[i]);
    }
  } else if (cfgX && cfgX.auth_token && cfgX.ct0) {
    pushPair(cfgX.auth_token, cfgX.ct0);
  }

  for (let n = 2; n <= 10; n++) {
    pushPair(env['X_AUTH_TOKEN_' + n], env['X_CT0_' + n]);
  }

  if (cfgX && Array.isArray(cfgX.accounts)) {
    for (const acc of cfgX.accounts) {
      if (acc) pushPair(acc.auth_token, acc.ct0);
    }
  }

  const seen = new Set();
  const out = [];
  for (const item of candidates) {
    if (seen.has(item.auth_token)) continue;
    seen.add(item.auth_token);
    out.push({
      id: out.length + 1,
      auth_token: item.auth_token,
      ct0: item.ct0,
      cooldownUntil: 0,
      disabledUntil: 0
    });
  }
  return out;
}

function createXPool(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  let cursor = 0;

  const isHealthy = (acc, now) => now >= acc.cooldownUntil && now >= acc.disabledUntil;

  const pick = (now = Date.now(), exclude = null) => {
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const idx = (cursor + i) % list.length;
      const acc = list[idx];
      if (exclude && exclude.has(acc)) continue;
      if (isHealthy(acc, now)) {
        cursor = (idx + 1) % list.length;
        return acc;
      }
    }
    return null;
  };

  const allCooling = (now = Date.now()) => list.length > 0 && list.every(a => !isHealthy(a, now));

  const earliestReset = (now = Date.now()) => {
    if (!list.length) return now;
    let min = Infinity;
    for (const a of list) {
      const until = Math.max(a.cooldownUntil || 0, a.disabledUntil || 0);
      if (until < min) min = until;
    }
    return isFinite(min) ? min : now;
  };

  const markRateLimit = (acc, resetTime = 0, now = Date.now()) => {
    if (!acc) return;
    const target = resetTime > now ? resetTime : now + 5 * 60e3;
    if (target > acc.cooldownUntil) acc.cooldownUntil = target;
  };

  const markAuthError = (acc, now = Date.now()) => {
    if (!acc) return;
    const target = now + 30 * 60e3;
    if (target > acc.disabledUntil) acc.disabledUntil = target;
  };

  const status = (now = Date.now()) => list.map(a => {
    const until = Math.max(a.cooldownUntil, a.disabledUntil);
    return {
      id: a.id,
      healthy: isHealthy(a, now),
      waitSec: until > now ? Math.ceil((until - now) / 1000) : 0
    };
  });

  return {
    all: () => list,
    size: () => list.length,
    has: () => list.length > 0,
    pick,
    allCooling,
    earliestReset,
    markRateLimit,
    markAuthError,
    status
  };
}

function formatWibTime(ms) {
  const d = new Date((Number(ms) || Date.now()) + 7 * 3600e3);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

module.exports = { buildXAccounts, createXPool, formatWibTime };
