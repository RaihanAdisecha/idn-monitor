'use strict';
/* Uji mergeEvents: satu token langka tidak cukup, butuh >=2 (atau sameHazard),
   dan klaster tidak boleh merantai secara transitif (A-B + B-C != A,C satu pin). */
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
  // A~B berbagi senja+anggrek; B~C berbagi melati+cempaka; A~C tidak berbagi apa pun.
  const out = mergeEvents([
    pin('Kebakaran rumah senja anggrek di Bandung'),
    pin('Kebakaran rumah senja anggrek melati di Bandung'),
    pin('Kebakaran rumah melati cempaka di Bandung'),
  ], []);
  assert.equal(out.length, 2);
  assert.ok(!out.some(p => p.n === 3), 'A,B,C tidak boleh satu klaster');
});
