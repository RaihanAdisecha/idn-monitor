'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildXAccounts, createXPool, formatWibTime } = require('../xpool');

test('buildXAccounts parses single, numbered, comma-separated, and config pairs with deduplication', () => {
  const accs = buildXAccounts({
    X_AUTH_TOKEN: 'tok1, tok2',
    X_CT0: 'ct1, ct2',
    X_AUTH_TOKEN_2: 'tok2',
    X_CT0_2: 'ct2',
    X_AUTH_TOKEN_3: 'tok3',
    X_CT0_3: 'ct3',
    X_AUTH_TOKEN_4: 'missing_ct0'
  }, {
    accounts: [{ auth_token: 'tok4', ct0: 'ct4' }, { auth_token: 'tok1', ct0: 'ct1' }]
  });

  assert.equal(accs.length, 4);
  assert.deepEqual(accs.map(a => a.auth_token), ['tok1', 'tok2', 'tok3', 'tok4']);
  assert.deepEqual(accs.map(a => a.ct0), ['ct1', 'ct2', 'ct3', 'ct4']);
});

test('createXPool round-robins across healthy accounts and fails over cleanly on per-account 429', () => {
  const pool = createXPool(buildXAccounts({
    X_AUTH_TOKEN: 'a1',
    X_CT0: 'c1',
    X_AUTH_TOKEN_2: 'a2',
    X_CT0_2: 'c2'
  }));

  const now = 1_700_000_000_000;
  assert.equal(pool.size(), 2);
  assert.equal(pool.allCooling(now), false);

  const p1 = pool.pick(now);
  const p2 = pool.pick(now);
  const p3 = pool.pick(now);
  assert.equal(p1.auth_token, 'a1');
  assert.equal(p2.auth_token, 'a2');
  assert.equal(p3.auth_token, 'a1');

  pool.markRateLimit(p1, now + 600_000, now);
  assert.equal(pool.allCooling(now), false);
  assert.equal(pool.pick(now).auth_token, 'a2');
  assert.equal(pool.pick(now).auth_token, 'a2');

  assert.equal(pool.pick(now, new Set([p2])), null);

  pool.markRateLimit(p2, now + 120_000, now);
  assert.equal(pool.allCooling(now), true);
  assert.equal(pool.earliestReset(now), now + 120_000);
  assert.equal(pool.pick(now), null);

  assert.equal(pool.pick(now + 120_001).auth_token, 'a2');
});

test('createXPool isolates 401/403 auth errors and omits secrets from status()', () => {
  const pool = createXPool(buildXAccounts({
    X_AUTH_TOKEN: 'secret-tok-1',
    X_CT0: 'secret-ct-1',
    X_AUTH_TOKEN_2: 'secret-tok-2',
    X_CT0_2: 'secret-ct-2'
  }));

  const now = 1_700_000_000_000;
  const first = pool.pick(now);
  pool.markAuthError(first, now);

  assert.equal(pool.allCooling(now), false);
  assert.equal(pool.pick(now).auth_token, 'secret-tok-2');

  const stJson = JSON.stringify(pool.status(now));
  assert.ok(!stJson.includes('secret-tok'), 'status() must never expose auth_token');
  assert.ok(!stJson.includes('secret-ct'), 'status() must never expose ct0');
});

test('formatWibTime converts UTC timestamps deterministically to UTC+7 WIB', () => {

  assert.equal(formatWibTime(Date.parse('2026-11-10T05:54:00Z')), '12:54');

  assert.equal(formatWibTime(Date.parse('2026-11-10T17:05:00Z')), '00:05');
});
