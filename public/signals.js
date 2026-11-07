(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SitrepSignals = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '2026-11-07.1';
  const SIGNAL_WINDOW = 90 * 60 * 1000;
  const RETENTION_WINDOW = 24 * 60 * 60 * 1000;
  const REPORT_TYPES = new Set(['reported', 'warning']);
  const SEVERITIES = { unknown: 0, warning: 1, critical: 2 };
  const GENERIC = new Set(('a an the and or of to in on at for from with is are was were ' +
    'di ke dari yang dan atau untuk dengan pada dalam ini itu ada telah sudah akan ' +
    'sebuah seorang para oleh hari tadi kini today now breaking news update berita kabar terkini ' +
    'gempa earthquake earthquakes tsunami erupsi eruption gunung volcano banjir flood flooding ' +
    'kebakaran fire fires bencana disaster korban victim victims warga residents terjadi ' +
    'melanda mengguncang guncang guncangan kembali peringatan warning waspada ' +
    'dini reported report laporan lapor dilaporkan server rumah akun account house ' +
    'attack serangan siber cyber ransomware outage padam listrik insiden incident ' +
    'kecelakaan accident accidents penembakan shooting pencurian theft penangkapan arrest ' +
    'longsor landslide wabah outbreak karhutla wildfire bmkg bpbd pvmbg magnitudo magnitude').split(/\s+/));
  const GENERIC_TARGETS = new Set(['server', 'rumah', 'akun', 'account', 'house', 'website', 'situs', 'system', 'sistem']);

  function normalize(value) {
    return typeof value === 'string' ? value.normalize('NFKC').toLowerCase()
      .replace(/https?:\/\/\S+|www\.\S+/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ') : '';
  }

  function tokens(value) {
    const evidence = typeof value === 'string' ? value.replace(/@[\p{L}\p{N}_.]+/gu, ' ') : '';
    return Array.from(new Set(normalize(evidence).split(' ')
      .filter(token => token.length > 1 && !GENERIC.has(token) && !/^\d+$/.test(token))));
  }

  function validTime(ts, now, window) {
    return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 &&
      Number.isFinite(now) && ts <= now && now - ts <= window;
  }

  function currentAssessment(post) {
    const a = post && post.assessment;
    return a && a.version === VERSION && Array.isArray(a.topics) &&
      a.topics.every(topic => typeof topic === 'string') && Array.isArray(a.events) &&
      typeof a.scope === 'string' && typeof a.reportType === 'string' &&
      typeof a.signalEligible === 'boolean' ? a : null;
  }

  function eligibleEvents(post) {
    const a = currentAssessment(post);
    if (!a || !a.signalEligible || a.scope !== 'Indonesia' || !REPORT_TYPES.has(a.reportType)) return [];
    return a.events.filter(event => event && event.scope === 'Indonesia' &&
      REPORT_TYPES.has(event.reportType) && event.signalEligible === true && typeof event.topic === 'string' &&
      a.topics.includes(event.topic) && typeof event.category === 'string' && event.category.trim() &&
      typeof event.type === 'string' && event.type.trim() &&
      typeof event.evidence === 'string' && event.evidence.trim() &&
      Object.prototype.hasOwnProperty.call(SEVERITIES, event.severity));
  }

  function locationOf(event) {
    return normalize(event && event.location && event.location.name);
  }

  function targetOf(event) {
    const target = normalize(event && event.target);
    return target && !GENERIC_TARGETS.has(target) ? target : '';
  }

  // Relasi bertingkat: null = anchor konflik/tidak ada jangkar (bukan "unrelated" —
  // ketiadaan pasangan bukan bukti ketidakcocokan), 'weak' = kandidat longgar untuk
  // "kemungkinan terkait", 'strong' = anchor + evidence cukup untuk konfirmasi.
  // matches() tetap strict: hanya 'strong' yang boleh dipakai grouping/korelasi final.
  function relation(a, b) {
    if (!a || !b || a.category !== b.category) return null;
    const typeA = normalize(a.type), typeB = normalize(b.type);
    if (!typeA || typeA !== typeB) return null;
    const placeA = locationOf(a), placeB = locationOf(b);
    const rawTargetA = normalize(a.target), rawTargetB = normalize(b.target);
    if (placeA && placeB && placeA !== placeB) return null;
    if (rawTargetA && rawTargetB && rawTargetA !== rawTargetB) return null;
    // A same-named place in different provinces is still a conflicting location.
    const provA = normalize(a.location && a.location.prov);
    const provB = normalize(b.location && b.location.prov);
    if (provA && provB && provA !== provB) return null;
    const targetA = targetOf(a), targetB = targetOf(b);
    const anchorStrong = (placeA && placeA === placeB) || (targetA && targetA === targetB);
    const anchorWeak = anchorStrong || (provA && provA === provB);
    if (!anchorWeak) return null;
    const left = new Set(tokens(a.evidence)), right = new Set(tokens(b.evidence));
    let overlap = 0;
    for (const token of left) if (right.has(token)) overlap++;
    const union = left.size + right.size - overlap;
    const jac = union ? overlap / union : 0;
    if (anchorStrong && overlap >= 2 && jac >= 0.18) return 'strong';
    if (overlap >= 1 && jac >= 0.08) return 'weak';
    return null;
  }
  function matches(a, b) { return relation(a, b) === 'strong'; }

  function platform(post) { return normalize(post.from); }
  function textOf(post) { return typeof post.text === 'string' ? post.text : post.title || ''; }
  function defaultKey(post) {
    return platform(post) + '\u0000' + (typeof post.url === 'string' && post.url.trim() || normalize(textOf(post)));
  }

  function dedupe(posts, keyOf) {
    const keys = new Set(), texts = new Set(), result = [];
    // Latest copy wins; sorting a copy leaves the caller's input untouched.
    for (const post of posts.slice().sort((a, b) => b.ts - a.ts)) {
      const key = keyOf(post), text = normalize(textOf(post));
      if (keys.has(key) || (text && texts.has(text))) continue;
      keys.add(key);
      if (text) texts.add(text);
      result.push(post);
    }
    return result;
  }

  function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  function buildGroups(posts, now) {
    now = now === undefined ? Date.now() : now;
    if (!Array.isArray(posts) || !Number.isFinite(now)) return [];
    const valid = dedupe(posts.filter(post => post && validTime(post.ts, now, SIGNAL_WINDOW) &&
      currentAssessment(post)), defaultKey).filter(post => eligibleEvents(post).length);
    const groups = [];
    for (const post of valid) {
      for (const event of eligibleEvents(post)) {
        let group = groups.find(g => g.events.every(member => matches(member, event)));
        if (!group) {
          const anchor = [event.category, normalize(event.type), locationOf(event), normalize(event.target)].join('|');
          group = {
            id: 'signal-' + hash(anchor + '|' + normalize(event.evidence) + '|' + defaultKey(post)),
            cat: event.category, type: event.type,
            place: event.location && event.location.name || event.target || '',
            posts: [], n: 0, accounts: 0, latest: post.ts,
            sample: textOf(post), from: '', events: [], severity: 'unknown', confidence: 'unverified'
          };
          groups.push(group);
        }
        if (!group.posts.includes(post)) group.posts.push(post);
        group.events.push(event);
        if (SEVERITIES[event.severity] > SEVERITIES[group.severity]) group.severity = event.severity;
      }
    }
    for (const group of groups) {
      const accounts = new Set(), platforms = new Set();
      for (const post of group.posts) {
        const from = platform(post), handle = typeof post.handle === 'string' ?
          post.handle.trim().replace(/^@/, '').normalize('NFKC').toLowerCase() : '';
        if (from && handle) accounts.add(from + '\u0000' + handle);
        if (typeof post.from === 'string' && post.from.trim()) platforms.add(post.from.trim());
      }
      group.n = group.posts.length;
      group.accounts = accounts.size;
      group.from = Array.from(platforms).join(' + ');
      group.confidence = accounts.size > 1 ? 'multiple_accounts' : 'unverified';
    }
    return groups.sort((a, b) => b.latest - a.latest);
  }

  function related(group, candidates, now, limit) {
    now = now === undefined ? Date.now() : now;
    limit = limit === undefined ? 6 : limit;
    if (!group || !Array.isArray(group.events) || !group.events.length || !Array.isArray(candidates) ||
      !validTime(group.latest, now, SIGNAL_WINDOW) || !Number.isFinite(limit) || limit <= 0) return [];
    const valid = candidates.filter(post => post && validTime(post.ts, now, SIGNAL_WINDOW) &&
      Math.abs(post.ts - group.latest) <= SIGNAL_WINDOW &&
      eligibleEvents(post).some(event => group.events.every(member => matches(member, event))));
    return dedupe(valid, defaultKey).slice(0, Math.floor(limit));
  }

  function reconcile(currentMap, payload, options) {
    options = options || {};
    const now = options.now === undefined ? Date.now() : options.now;
    const previous = () => ({ accepted: false, posts: Array.from(currentMap.values()) });
    if (!payload || payload.snapshot !== true || payload.classifierVersion !== VERSION || payload.ok !== true ||
      !Array.isArray(payload.posts) || typeof payload.snapshotAt !== 'number' || !Number.isFinite(payload.snapshotAt) ||
      !Number.isFinite(now) || (Number.isFinite(currentMap._snapshotAt) && payload.snapshotAt < currentMap._snapshotAt)) return previous();
    const max = options.max === undefined ? Infinity : options.max;
    if (!(max === Infinity || (Number.isFinite(max) && max >= 0)) ||
      (options.keyOf !== undefined && typeof options.keyOf !== 'function')) return previous();
    const keyOf = options.keyOf || defaultKey;
    const posts = dedupe(payload.posts.filter(post => post && typeof post === 'object' &&
      validTime(post.ts, now, RETENTION_WINDOW) && currentAssessment(post)), keyOf).slice(0, Math.floor(max));
    // Prepare all keys before mutation, so a faulty caller key function cannot half-clear the map.
    const entries = posts.map(post => [keyOf(post), post]);
    currentMap.clear();
    for (const [key, post] of entries) currentMap.set(key, post);
    currentMap._snapshotAt = payload.snapshotAt;
    return { accepted: true, posts: Array.from(currentMap.values()) };
  }

  return { VERSION, buildGroups, related, reconcile, tokens, matches, relation };
}));
