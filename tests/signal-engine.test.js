'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const signals = require('../public/signals');
const NOW = 1800000000000;
const MINUTE = 60000;

function event(overrides = {}) {
  return { topic: 'banjir', category: 'flood', type: 'flood',
    location: { name: 'Bandung', prov: 'Jawa Barat' }, target: null,
    scope: 'Indonesia', reportType: 'reported', signalEligible: true, evidence: 'Cikapundung meluap merendam Braga pertokoan',
    severity: 'unknown', ...overrides };
}
function post(overrides = {}, eventOverrides = {}) {
  return { text: 'Cikapundung meluap merendam Braga pertokoan Bandung', url: 'https://x.test/1',
    ts: NOW - MINUTE, from: 'X', handle: '@alice', assessment: {
      version: signals.VERSION, topics: ['banjir'], scope: 'Indonesia', reportType: 'reported',
      signalEligible: true, events: [event(eventOverrides)]
    }, ...overrides };
}
function distinct(index, overrides = {}, eventOverrides = {}) {
  return post({ text: 'Cikapundung meluap merendam Braga pertokoan Bandung saksi' + index,
    url: 'https://x.test/' + index, handle: '@account' + index, ...overrides }, eventOverrides);
}
function payload(posts, snapshotAt = NOW) {
  return { ok: true, snapshot: true, classifierVersion: signals.VERSION, snapshotAt, posts };
}

test('CommonJS and browser UMD expose the same explicit version and API', () => {
  assert.equal(signals.VERSION, '2026-11-07.3');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../public/signals'), 'utf8'), context);
  assert.equal(context.SitrepSignals.VERSION, signals.VERSION);
  for (const name of ['adoptClassifierVersion', 'buildGroups', 'related', 'reconcile', 'tokens', 'matches']) {
    assert.equal(typeof context.SitrepSignals[name], 'function');
  }
});

test('assessment-level version, eligibility, scope, report and topic gates are mandatory', () => {
  const base = post();
  for (const patch of [
    { version: 'old' }, { signalEligible: false }, { signalEligible: 'true' },
    { scope: 'global' }, { scope: 'unknown' }, { reportType: 'metaphor' },
    { reportType: 'historical' }, { reportType: 'opinion' }, { topics: [] }, { events: null }
  ]) assert.equal(signals.buildGroups([{ ...base, assessment: { ...base.assessment, ...patch } }], NOW).length, 0, JSON.stringify(patch));
  assert.equal(signals.buildGroups([{ ...base, assessment: undefined }], NOW).length, 0);
  assert.equal(signals.buildGroups([post({ topics: ['banjir'], assessment: null })], NOW).length, 0);
});

test('event-level scope, report, evidence and severity gates are mandatory', () => {
  for (const patch of [
    { scope: 'global' }, { reportType: 'metaphor' }, { reportType: 'forecast' }, { topic: 'gempa' },
    { signalEligible: false }, { signalEligible: undefined }, { type: '' }, { category: '' }, { evidence: '' },
    { severity: 'verified' }
  ]) assert.equal(signals.buildGroups([post({}, patch)], NOW).length, 0, JSON.stringify(patch));
  const warning = post({}, { reportType: 'warning', severity: 'warning' });
  warning.assessment.reportType = 'warning';
  assert.equal(signals.buildGroups([warning], NOW)[0].severity, 'warning');
});

test('signal timestamps require finite positive numbers, no future and at most 90 minutes', () => {
  for (const ts of [undefined, null, 0, -1, NaN, Infinity, String(NOW), NOW + 1, NOW - 90 * MINUTE - 1]) {
    assert.equal(signals.buildGroups([post({ ts })], NOW).length, 0, String(ts));
  }
  assert.equal(signals.buildGroups([post({ ts: NOW - 90 * MINUTE })], NOW).length, 1);
  assert.equal(signals.buildGroups([post({ ts: NOW })], NOW).length, 1);
});

test('groups retain exact member objects, newest first, without mutating posts', () => {
  const older = distinct(2, { ts: NOW - 2 * MINUTE });
  const latest = distinct(1);
  const input = [older, latest];
  const group = signals.buildGroups(input, NOW)[0];
  assert.deepEqual(input, [older, latest]);
  assert.equal(group.posts[0], latest);
  assert.equal(group.posts[1], older);
  assert.equal(group.events[0], latest.assessment.events[0]);
  assert.equal(group.latest, latest.ts);
  assert.equal(group.sample, latest.text);
  assert.equal(group.n, 2);
  assert.equal(group.cat, 'flood');
  assert.equal(group.type, 'flood');
  assert.equal(group.place, 'Bandung');
});

test('duplicates use platform plus URL and normalized copy-paste across platforms', () => {
  const base = post();
  const sameUrl = distinct(2, { url: base.url, ts: base.ts - 1 });
  const pasted = post({ from: 'Threads', url: 'https://threads.test/a',
    text: 'CIKAPUNDUNG  MELUAP, MERENDAM Braga pertokoan Bandung!!! https://example.test/a', ts: base.ts - 2 });
  assert.equal(signals.buildGroups([base, sameUrl, pasted], NOW)[0].n, 1);
  const crossPlatform = distinct(3, { from: 'Threads', url: base.url, handle: '@alice' });
  const group = signals.buildGroups([base, crossPlatform], NOW)[0];
  assert.equal(group.n, 2);
  assert.equal(group.accounts, 2);
  assert.equal(group.from, 'X + Threads');
  assert.equal(group.confidence, 'multiple_accounts');
});

test('accounts are distinct platform/handle pairs, not independent sources or post volume', () => {
  const copies = Array.from({ length: 20 }, (_, i) => distinct(i, { handle: i % 2 ? '@ALICE' : 'alice' }));
  let group = signals.buildGroups(copies, NOW)[0];
  assert.equal(group.n, 20);
  assert.equal(group.accounts, 1);
  assert.equal(group.confidence, 'unverified');
  assert.equal(group.severity, 'unknown');
  group = signals.buildGroups(copies.map(p => ({ ...p, handle: '' })), NOW)[0];
  assert.equal(group.accounts, 0);
  assert.equal(group.confidence, 'unverified');
  assert.equal(signals.buildGroups([distinct(1), distinct(2, {}, { severity: 'critical' })], NOW)[0].severity, 'critical');
});

test('same type and location match, conflicting type/location/province/target split', () => {
  assert.equal(signals.matches(event(), event({ location: { name: ' BANDUNG! ', prov: 'Jawa Barat' } })), true);
  for (const patch of [
    { type: 'earthquake' }, { location: { name: 'Aceh' } },
    { location: { name: 'Bandung', prov: 'Jawa Tengah' } }
  ]) assert.equal(signals.buildGroups([distinct(1), distinct(2, {}, patch)], NOW).length, 2);
  assert.equal(signals.matches(event({ target: 'Bank Alpha' }), event({ target: 'Bank Beta' })), false);
  assert.equal(signals.matches(event({ target: 'Bank Alpha' }), event({ target: 'Bank Alpha', location: { name: 'Aceh' } })), false);
});

test('a concrete target can anchor unknown locations, generic targets cannot', () => {
  const a = event({ location: null, target: 'Bank Alpha server' });
  assert.equal(signals.matches(a, { ...a }), true);
  for (const target of ['server', 'rumah', 'akun', null, '']) {
    const generic = event({ location: null, target });
    assert.equal(signals.matches(generic, generic), false, String(target));
  }
  assert.equal(signals.matches(event({ location: null }), event()), false);
});

test('evidence requires two distinctive shared tokens AND Jaccard at least 0.18', () => {
  assert.deepEqual(signals.tokens('BANJIR warga korban https://example.com/cikapundung Cikapundung Braga Braga'), ['cikapundung', 'braga']);
  assert.equal(signals.matches(event({ evidence: 'banjir warga cikapundung' }), event({ evidence: 'banjir warga cikapundung' })), false);
  assert.equal(signals.matches(event({ evidence: 'cikapundung braga' }), event({ evidence: 'cikapundung braga' })), true);
  assert.equal(signals.matches(event({ evidence: 'cikapundung braga alpha beta gamma delta epsilon zeta' }),
    event({ evidence: 'cikapundung braga eta theta iota kappa lambda omega' })), false);
  assert.equal(signals.matches(event(), event({ evidence: 'Banjir Bandung akses terminal stasiun terputus' })), false);
});

test('pairwise compatibility prevents ambiguous posts bridging contradictory groups', () => {
  const a = distinct(1, {}, { target: 'Bank Alpha' });
  const b = distinct(2);
  const c = distinct(3, {}, { target: 'Bank Beta' });
  const groups = signals.buildGroups([a, b, c], NOW);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => !(g.posts.includes(a) && g.posts.includes(c))));
});

test('multiple eligible events put the same exact post in multiple groups', () => {
  const multi = post();
  const fire = event({ topic: 'kebakaran', category: 'fire', type: 'fire',
    location: { name: 'Jakarta' }, evidence: 'Glodok pertokoan hangus asap tebal', severity: 'warning' });
  multi.assessment.topics.push('kebakaran');
  multi.assessment.events.push(fire, event({ scope: 'global' }));
  const groups = signals.buildGroups([multi], NOW);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].id, groups[1].id);
  assert.ok(groups.every(g => g.posts[0] === multi && g.n === 1));
  assert.deepEqual(groups.map(g => g.cat), ['flood', 'fire']);
});

test('related only returns current compatible assessed candidates, never category padding', () => {
  const group = signals.buildGroups([post()], NOW)[0];
  const news = distinct(2, { title: 'Cikapundung meluap merendam Braga pertokoan', text: undefined, from: undefined });
  const other = distinct(3, {}, { location: { name: 'Aceh' } });
  const old = distinct(4, { ts: NOW - 91 * MINUTE });
  const future = distinct(5, { ts: NOW + 1 });
  const wrongVersion = distinct(6);
  wrongVersion.assessment.version = 'old';
  assert.deepEqual(signals.related(group, [news, other, old, future, wrongVersion, { cat: 'flood', title: news.title, ts: NOW }], NOW), [news]);
  assert.deepEqual(signals.related(group, [other], NOW), []);
  assert.equal(signals.related(group, Array.from({ length: 9 }, (_, i) => distinct(i)), NOW).length, 6);
  assert.equal(signals.related(group, [news], NOW, 0).length, 0);
  assert.equal(signals.related(group, [news], NOW + 91 * MINUTE).length, 0);
});

test('reconcile replaces authoritatively, retaining exact current assessments for 24 hours', () => {
  const map = new Map([['obsolete', post()]]);
  const excluded = distinct(2, { ts: NOW - 24 * 60 * MINUTE });
  excluded.assessment.signalEligible = false;
  const result = signals.reconcile(map, payload([excluded, distinct(3, { ts: NOW - 24 * 60 * MINUTE - 1 }), distinct(4, { ts: NOW + 1 })]), { now: NOW });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.posts, [excluded]);
  assert.equal([...map.values()][0], excluded);
  assert.equal(map._snapshotAt, NOW);
  assert.deepEqual(signals.reconcile(map, payload([], NOW + 1), { now: NOW }), { accepted: true, posts: [] });
  assert.equal(map.size, 0);
});

test('latest authoritative replacement can retag previously eligible posts', () => {
  const original = post();
  const map = new Map();
  signals.reconcile(map, payload([original]), { now: NOW });
  const retagged = { ...original, assessment: { ...original.assessment, signalEligible: false, topics: [], events: [], reportType: 'metaphor' } };
  const result = signals.reconcile(map, payload([retagged], NOW + 1), { now: NOW });
  assert.equal(result.posts[0], retagged);
  assert.equal(signals.buildGroups(result.posts, NOW).length, 0);
});

test('incompatible/failure payloads preserve map values and snapshot marker', () => {
  const original = post();
  const map = new Map([['original', original]]);
  map._snapshotAt = NOW;
  for (const patch of [
    { snapshot: false }, { snapshot: undefined }, { ok: false }, { ok: 'true' },
    { classifierVersion: 'old' }, { posts: null }, { posts: {} },
    { snapshotAt: NaN }, { snapshotAt: Infinity }, { snapshotAt: String(NOW) }
  ]) {
    assert.deepEqual(signals.reconcile(map, { ...payload([]), ...patch }, { now: NOW }), { accepted: false, posts: [original] });
    assert.equal(map.get('original'), original);
    assert.equal(map._snapshotAt, NOW);
  }
});

test('older snapshots cannot resurrect posts after newer empty snapshot; equal timestamp is accepted', () => {
  const map = new Map();
  signals.reconcile(map, payload([], NOW + 10), { now: NOW });
  assert.equal(signals.reconcile(map, payload([post()], NOW + 9), { now: NOW }).accepted, false);
  assert.equal(map.size, 0);
  assert.equal(map._snapshotAt, NOW + 10);
  assert.equal(signals.reconcile(map, payload([post()], NOW + 10), { now: NOW }).accepted, true);
});

test('reconcile filters invalid assessments, dedupes latest posts, supports keyOf/max', () => {
  const latest = distinct(1);
  const older = distinct(2, { url: latest.url, ts: latest.ts - 1 });
  const pasted = { ...latest, url: 'https://other.test/a', from: 'Threads', ts: latest.ts - 2 };
  const incompatible = distinct(3);
  incompatible.assessment.version = 'old';
  const map = new Map();
  const result = signals.reconcile(map, payload([older, latest, pasted, incompatible, null, post({ ts: 0 })]), { now: NOW, keyOf: p => p.from + p.url, max: 1 });
  assert.deepEqual(result.posts, [latest]);
  assert.equal(map.get(latest.from + latest.url), latest);
  assert.equal(signals.reconcile(map, payload([latest], NOW + 1), { now: NOW, max: 0 }).posts.length, 0);
});


test('latest current excluded copy prevents an older eligible URL from resurfacing', () => {
  const older = post({ ts: NOW - 2 * MINUTE });
  const newer = { ...older, ts: NOW - MINUTE, assessment: { ...older.assessment, signalEligible: false } };
  assert.deepEqual(signals.buildGroups([older, newer], NOW), []);
});

test('account identity preserves handle punctuation', () => {
  const group = signals.buildGroups([distinct(1, { handle: '@a.b' }), distinct(2, { handle: '@a_b' })], NOW)[0];
  assert.equal(group.accounts, 2);
});


test('standalone short eligible report stays unverified but cannot corroborate another', () => {
  const a = distinct(1, {}, { evidence: 'Banjir di Bekasi', location: { name: 'Bekasi' } });
  const b = distinct(2, {}, { evidence: 'Banjir di Bekasi', location: { name: 'Bekasi' } });
  const groups = signals.buildGroups([a, b], NOW);
  assert.equal(groups.length, 2);
  assert.ok(groups.every(g => g.n === 1 && g.confidence === 'unverified'));
  assert.notEqual(groups[0].id, groups[1].id);
});

test('category mismatch cannot merge otherwise identical events', () => {
  assert.equal(signals.matches(event(), event({ category: 'fire' })), false);
  assert.equal(signals.buildGroups([distinct(1), distinct(2, {}, { category: 'fire' })], NOW).length, 2);
});

test('unrelated same-city fires sharing only generic city or time tokens never merge', () => {
  const e1 = event({
    topic: 'kebakaran', category: 'fire', type: 'fire',
    location: { name: 'Jakarta Selatan' },
    evidence: 'Kebakaran rumah warga semalam akibat korsleting di Jakarta Selatan'
  });
  const e2 = event({
    topic: 'kebakaran', category: 'fire', type: 'fire',
    location: { name: 'Jakarta Selatan' },
    evidence: 'Kebakaran ruko pagi barusan diduga gas bocor di Jakarta Selatan'
  });
  assert.notEqual(signals.relation(e1, e2), 'strong');
  assert.equal(signals.matches(e1, e2), false);
  const p1 = post({ url: 'https://x.com/u1/status/901', handle: '@u1', text: e1.evidence }, e1);
  p1.assessment.topics = ['kebakaran']; p1.assessment.events = [e1];
  const p2 = post({ url: 'https://x.com/u2/status/902', handle: '@u2', text: e2.evidence }, e2);
  p2.assessment.topics = ['kebakaran']; p2.assessment.events = [e2];
  assert.equal(signals.buildGroups([p1, p2], NOW).length, 2);
});

test('matches() and relation() === strong stay strictly aligned across shared evidence', () => {
  const e1 = event({
    topic: 'kebakaran', category: 'fire',
    location: { name: 'Depok' },
    evidence: 'Kebakaran pabrik tekstil cimanggis malam ini di Depok'
  });
  const e2 = event({
    topic: 'kebakaran', category: 'fire',
    location: { name: 'Depok' },
    evidence: 'Api melalap pabrik tekstil cimanggis di Depok'
  });
  const e3 = event({
    topic: 'kebakaran', category: 'fire',
    location: { name: 'Depok' },
    evidence: 'Kebakaran gudang kayu sawangan pagi di Depok'
  });
  assert.equal(signals.relation(e1, e2), 'strong');
  assert.equal(signals.matches(e1, e2), true);
  assert.notEqual(signals.relation(e1, e3), 'strong');
  assert.equal(signals.matches(e1, e3), false);
});
