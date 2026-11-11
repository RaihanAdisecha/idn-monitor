'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeEvents } = require('../evmerge');

const NOW = 1800000000000;
const pin = (title, over = {}) => ({ title, name: 'Bandung', kind: 'fire', ts: NOW - 3600e3, ...over });

test('dua insiden yang hanya berbagi satu token tidak menyatu', () => {
  const out = mergeEvents([
    pin('Kebakaran rumah sariwati melati di Bandung'),
    pin('Kebakaran ruko sariwati jebol di Bandung'),
  ], []);
  assert.equal(out.length, 2);
});

test('dua artikel dengan >=2 token langka sama menjadi satu pin', () => {
  const out = mergeEvents([
    pin('Kebakaran rumah sariwati melati di Bandung'),
    pin('Kebakaran rumah sariwati melati jebol di Bandung'),
  ], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].n, 2);
});

test('rantai transitif A-B-C tidak menggabungkan A dan C', () => {

  const out = mergeEvents([
    pin('Kebakaran rumah senja anggrek di Bandung'),
    pin('Kebakaran rumah senja anggrek melati di Bandung'),
    pin('Kebakaran rumah melati cempaka di Bandung'),
  ], []);
  assert.equal(out.length, 2);
  assert.ok(!out.some(p => p.n === 3), 'A,B,C tidak boleh satu klaster');
});

test('empty rareU incidents in same city do not collide on identical EID', () => {
  const out = mergeEvents([
    pin('Kebakaran Rumah di Jakarta Selatan', { name: 'Jakarta Selatan', ts: NOW - 1800e3 }),
    pin('Kebakaran Pasar di Jakarta Selatan', { name: 'Jakarta Selatan', ts: NOW - 900e3 }),
  ], []);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].eid, out[1].eid, 'unrelated events with empty rare tokens must have unique EIDs');
});

test('one rare token plus generic time/place words still does not merge multi-token events', () => {
  const out = mergeEvents([
    pin('Kebakaran rumah sariwati mangga malam kemarin di Jakarta Selatan', { name: 'Jakarta Selatan' }),
    pin('Kebakaran ruko sariwati kenanga siang barusan di Jakarta Selatan', { name: 'Jakarta Selatan' }),
  ], []);
  assert.equal(out.length, 2, 'generic words malam/siang/jakarta/selatan must not boost rare overlap');
});

test('mergeEvents EID and representative selection are permutation-invariant', () => {
  const a = pin('Kebakaran gudang tekstil cipondoh merambat ke tiga ruko', { name: 'Tangerang', ts: NOW - 2000e3, src: 'ANTARA' });
  const b = pin('Gudang tekstil cipondoh terbakar hebat malam ini', { name: 'Tangerang', ts: NOW - 1000e3, src: 'DETIK' });
  const r1 = mergeEvents([a, b], []);
  const r2 = mergeEvents([b, a], []);
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.equal(r1[0].eid, r2[0].eid);
  assert.equal(r1[0].title, r2[0].title);
});

test('operational focus metadata never alters event identity or clustering', () => {
  const baseA = pin('Ledakan kilang pertamina cilamaya karawang terbakar', { name: 'Karawang', operationalFocus: 'evakuasi', recommendedAction: 'dispatch_damkar' });
  const baseB = pin('Kebakaran kilang pertamina cilamaya karawang malam ini', { name: 'Karawang', operationalFocus: 'lalu_lintas', recommendedAction: 'rekayasa_jalan' });
  const withFocus = mergeEvents([baseA, baseB], []);
  const withoutFocus = mergeEvents([{ ...baseA, operationalFocus: undefined }, { ...baseB, operationalFocus: undefined }], []);
  assert.equal(withFocus.length, 1);
  assert.equal(withFocus[0].eid, withoutFocus[0].eid);
});

test('prevPins preserves EID across refreshes', () => {
  const first = mergeEvents([
    pin('Gempa magnitudo 5.4 guncang Cianjur selatan', { name: 'Cianjur', kind: 'disaster', ts: NOW - 3600e3 }),
  ], []);
  const second = mergeEvents([
    pin('Update gempa magnitudo 5.4 Cianjur selatan warga mengungsi', { name: 'Cianjur', kind: 'disaster', ts: NOW - 600e3 }),
  ], first);
  assert.equal(second.length, 1);
  assert.equal(second[0].eid, first[0].eid);
});
