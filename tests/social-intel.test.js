'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { socPhraseScan, socKeywordMine } = require('../social');

const NOW = Date.parse('2025-06-01T12:00:00Z');
const mk = (text, over = {}) => Object.assign({
  text, ts: NOW - 30 * 60e3, topics: [], platform: 'x', user: 'anon'
}, over);
const byAuthors = (text, users, over = {}) => users.map((u, i) => mk(text, { ...over, user: '@' + u + i }));

test('socPhraseScan: frasa berulang >=3 author dalam window muncul', () => {
  const posts = [
    ...byAuthors('Banjir Jakarta Besar merendam ratusan rumah semalam.', ['a', 'b', 'c']),
    mk('Cuaca ekstrem menggila.', { user: 'd' }),
  ];
  const out = socPhraseScan(posts, { now: NOW });
  const hit = out.find(r => r.id === 'banjir jakarta besar');
  assert.ok(hit, 'frasa target harus ada');
  assert.equal(hit.users, 3);
  assert.equal(hit.ph, 'Banjir Jakarta Besar');
  assert.ok(hit.n >= 3);
});

test('socPhraseScan: <3 author unik tidak lolos', () => {
  const posts = [
    mk('Longsor Susulan Guncang Desa', { user: 'x' }),
    mk('Longsor Susulan Guncang Desa lagi', { user: 'y' }),
    mk('Longsor Susulan Guncang Desa juga', { user: 'x' }),
  ];
  const out = socPhraseScan(posts, { now: NOW });
  assert.ok(!out.some(r => r.id === 'longsor susulan guncang desa'));
});

test('socPhraseScan: post lebih tua dari window diabaikan', () => {
  const posts = byAuthors('Kebakaran Melanda Desa Besar', ['a', 'b', 'c'], { ts: NOW - 4 * 3600e3 });
  const out = socPhraseScan(posts, { now: NOW });
  assert.ok(!out.some(r => r.id === 'kebakaran melanda desa besar'));
});

test('socPhraseScan: exclude set memangkas frasa topik registry', () => {
  const posts = byAuthors('Banjir Jakarta Besar merendam rumah.', ['a', 'b', 'c']);
  const out = socPhraseScan(posts, { now: NOW, exclude: new Set(['banjir', 'kebakaran']) });
  assert.ok(!out.some(r => r.id === 'banjir jakarta besar'));
});

test('socPhraseScan: hashtag ikut jadi kandidat (lowercase tanpa #)', () => {
  const posts = byAuthors('Hujan deras semalaman #banjirbandang', ['a', 'b', 'c']);
  const out = socPhraseScan(posts, { now: NOW });
  const hit = out.find(r => r.id === 'banjirbandang');
  assert.ok(hit, 'hashtag harus muncul');
  assert.equal(hit.users, 3);
});

test('socPhraseScan: max membatasi hasil', () => {
  const posts = [];
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  for (let i = 0; i < 6; i++)
    posts.push(...byAuthors(`Peristiwa Langka ${names[i]} Guncang`, ['u' + i + 'a', 'u' + i + 'b', 'u' + i + 'c']));
  const out = socPhraseScan(posts, { now: NOW, max: 3 });
  assert.equal(out.length, 3);
});

test('socPhraseScan: mention & URL distrip sebelum ekstraksi', () => {
  const posts = byAuthors('@DetikCom Bilang Banjir Melanda', ['a', 'b', 'c']);
  const out = socPhraseScan(posts, { now: NOW });
  assert.ok(!out.some(r => r.id.includes('detikcom') || r.ph.toLowerCase().includes('detikcom')),
    'mention @DetikCom tidak boleh jadi kandidat');
  assert.ok(out.some(r => r.id === 'bilang banjir melanda'), 'sisa frasa setelah mention dicabut tetap kehitung');
});

test('socPhraseScan: sub-frasa kontigu dari match panjang ikut teragregasi', () => {
  const posts = [
    ...byAuthors('Banjir Jakarta Raya Melanda', ['a', 'b']),
    ...byAuthors('Banjir Jakarta Pusat Melanda', ['c', 'd']),
  ];
  const out = socPhraseScan(posts, { now: NOW, minUsers: 2 });
  assert.ok(out.some(r => r.id === 'banjir jakarta'),
    '"banjir jakarta" harus ngumpul dari dua varian ekor berbeda');
});

test('socPhraseScan: hashtag murni digit ditolak', () => {
  const posts = byAuthors('Situasi Memanas #2025', ['a', 'b', 'c']);
  const out = socPhraseScan(posts, { now: NOW });
  assert.ok(!out.some(r => r.id === '2025'));
});

test('socKeywordMine: token dari URL & mention tidak ikut term', () => {
  const posts = Array.from({ length: 4 }, (_, i) => mk(
    'kebakaran kios https://berita.com/Status/2025/Detail @DetikCom',
    { topics: ['kebakaran'], user: 'u' + i }));
  const terms = socKeywordMine(posts, 'kebakaran', { now: NOW }).map(r => r.term);
  assert.ok(terms.includes('kios'));
  for (const junk of ['status', 'detail', 'https', 'detikcom'])
    assert.ok(!terms.includes(junk), junk + ' harus ke-strip');
});

test('socKeywordMine: istilah sering & bukan stopword/query muncul', () => {
  const texts = [
    'kebakaran melanda kios dan warung, mobil warga terbakar',
    'api merambat ke kios serta warung, satu mobil hangus',
    'kebakaran besar, kios warung dan beberapa mobil musnah',
    'kobaran api menghanguskan kios warung mobil warga',
    'damai tapi kios warung mobil jadi abu',
  ];
  const posts = texts.map((t, i) => mk(t, { topics: ['kebakaran'], user: 'm' + i }));
  const out = socKeywordMine(posts, 'kebakaran', { now: NOW });
  const terms = out.map(r => r.term);
  assert.ok(terms.includes('kios'), 'kios harus jadi kandidat');
  assert.ok(terms.includes('warung'));
  assert.ok(!terms.includes('kebakaran'), 'istilah query existing harus ke-skip');
  assert.ok(!terms.includes('terbakar'), 'istilah di th[] harus ke-skip');
  assert.ok(!terms.includes('dan'), 'stopword harus ke-skip');
  const kios = out.find(r => r.term === 'kios');
  assert.equal(kios.df, 5);
});

test('socKeywordMine: post tanpa topik / di luar window tidak dihitung', () => {
  const posts = [
    mk('kios warung mobil', { topics: ['kebakaran'], user: 'x1' }),
    mk('kios warung mobil', { topics: ['kebakaran'], user: 'x2' }),
    mk('kios warung mobil', { topics: [], user: 'x3' }),
    mk('kios warung mobil', { topics: ['kebakaran'], user: 'x4', ts: NOW - 8 * 3600e3 }),
  ];
  const out = socKeywordMine(posts, 'kebakaran', { now: NOW });
  assert.equal(out.length, 0);
});

test('socKeywordMine: topik tak dikenal -> []', () => {
  assert.deepEqual(socKeywordMine([mk('apa saja')], 'topik-ngawur', { now: NOW }), []);
});
