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
  const feedOnly = ['mbg', 'bbm', 'pangan', 'bansos', 'hukum', 'olahraga', 'transport', 'pendidikan'];
  for (const id of feedOnly) assert.ok(A.FEED_ONLY.has(id), `${id} should be in FEED_ONLY`);

  const registry = feedOnly.map((id) => ({ id, pos: new RegExp(id, 'i') }));
  // Include concrete event language + an Indonesian location so these findings
  // would otherwise look reportable; the FEED_ONLY flag must still veto signals.
  const r = A.assess(
    'MBG BBM Pangan Bansos Hukum Olahraga Transport Pendidikan melanda Jakarta terjadi',
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
