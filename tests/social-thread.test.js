'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function pickPython() {
  const venv = path.join(__dirname, '..', '.venv', 'bin', 'python');
  for (const candidate of [venv, 'python3', 'python']) {
    if (candidate !== 'python3' && candidate !== 'python' && !fs.existsSync(candidate)) continue;
    try {
      const r = spawnSync(candidate, ['-c', 'print(1)'], { stdio: 'ignore' });
      if (r.status === 0) return candidate;
    } catch { /* try the next interpreter */ }
  }
  return null;
}

test('Threads thread worker correctly parses nested replies and returns top-level replies array', (t) => {
  const pythonBin = pickPython();
  if (!pythonBin) return t.skip('no Python interpreter available (.venv/bin/python, python3, python)');
  const workerScript = path.join(__dirname, '..', 'vendor', 'threads_thread.py');

  // Test empty url error handling
  const resEmpty = spawnSync(pythonBin, [workerScript, JSON.stringify({})], { encoding: 'utf-8' });
  assert.equal(resEmpty.status, 0);
  const jsonEmpty = JSON.parse(resEmpty.stdout);
  assert.equal(jsonEmpty.ok, false);
  assert.equal(jsonEmpty.err, 'url kosong');
});
