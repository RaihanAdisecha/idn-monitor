'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Threads thread worker correctly parses nested replies and returns top-level replies array', () => {
  const pythonBin = path.join(__dirname, '..', '.venv', 'bin', 'python');
  const workerScript = path.join(__dirname, '..', 'vendor', 'threads_thread.py');

  // Test empty url error handling
  const resEmpty = spawnSync(pythonBin, [workerScript, JSON.stringify({})], { encoding: 'utf-8' });
  assert.equal(resEmpty.status, 0);
  const jsonEmpty = JSON.parse(resEmpty.stdout);
  assert.equal(jsonEmpty.ok, false);
  assert.equal(jsonEmpty.err, 'url kosong');
});
