'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const VENDOR = path.join(REPO, 'vendor');

const STUB = [
  'import os',
  '',
  'class ScrapeError(Exception):',
  '    pass',
  '',
  'class Threads:',
  '    def __init__(self, *a, **k):',
  '        if os.environ.get("STUB_FATAL"):',
  '            raise RuntimeError("stub ctor down")',
  '',
  '    def _log(self, kind, value):',
  '        p = os.environ.get("STUB_LOG")',
  '        if p:',
  '            with open(p, "a", encoding="utf-8") as f:',
  '                f.write(kind + ":" + str(value) + "\\n")',
  '',
  '    def search(self, q, limit=20):',
  '        self._log("search", q)',
  '        if os.environ.get("STUB_RATE"):',
  '            raise ScrapeError("HTTP 429")',
  '        return []',
  '',
  '    def posts(self, u, n):',
  '        self._log("posts", u)',
  '        return []',
  '',
].join('\n');

function pickPython() {
  const venv = path.join(REPO, '.venv', 'bin', 'python');
  for (const candidate of [venv, 'python3']) {
    if (candidate !== 'python3' && !fs.existsSync(candidate)) continue;
    try {
      const r = spawnSync(candidate, ['-c', 'print(1)'], { stdio: 'ignore' });
      if (r.status === 0) return candidate;
    } catch {  }
  }
  return null;
}

const PY = pickPython();
const SKIP = PY ? false : 'no Python interpreter available (.venv/bin/python or python3)';

let tmpDir = null;
let logFile = null;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-threads-'));
  logFile = path.join(tmpDir, 'calls.log');
  fs.writeFileSync(path.join(tmpDir, 'threads_scraper.py'), STUB);

  fs.copyFileSync(path.join(VENDOR, 'threads_worker.py'), path.join(tmpDir, 'threads_worker.py'));
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runWorker(spec, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    fs.writeFileSync(logFile, '');
    const args = [path.join(tmpDir, 'threads_worker.py')];
    if (spec !== undefined) args.push(spec);
    const child = spawn(PY, args, {
      cwd: REPO,
      env: {
        ...process.env,
        PYTHONPATH: `${tmpDir}${path.delimiter}${VENDOR}`,
        STUB_LOG: logFile,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function readCalls() {
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

function parseOne(out) {
  const obj = JSON.parse(out.trim());
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), 'stdout must be one JSON object');
  return obj;
}

test('malformed JSON argv still emits one valid JSON object with ok/posts and non-empty errs',
  { skip: SKIP, timeout: 20000 }, async () => {

    const { code, out } = await runWorker('{not json', { STUB_FATAL: '1' });
    assert.equal(code, 0);
    const obj = parseOne(out);
    assert.equal(obj.ok, true);
    assert.deepEqual(obj.posts, []);
    assert.ok(Array.isArray(obj.errs) && obj.errs.length > 0, 'errs must be non-empty');
  });

test('a bare string spec is treated as a single search',
  { skip: SKIP, timeout: 20000 }, async () => {
    const { code, out } = await runWorker('"banjir"');
    assert.equal(code, 0);
    const obj = parseOne(out);
    assert.equal(obj.ok, true);
    assert.deepEqual(obj.posts, []);
    assert.deepEqual(readCalls(), ['search:banjir'], 'stub must record exactly one search for "banjir"');
  });

test('repeated ScrapeError(HTTP 429) halts early but still emits valid JSON',
  { skip: SKIP, timeout: 20000 }, async () => {
    const searches = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
    const spec = JSON.stringify({ searches, profiles: ['user1'] });
    const { code, out } = await runWorker(spec, { STUB_RATE: '1' });
    assert.equal(code, 0);
    const obj = parseOne(out);
    assert.equal(obj.ok, true);
    assert.ok(Array.isArray(obj.posts));
    assert.ok(Array.isArray(obj.errs) && obj.errs.length > 0, 'throttled queries must be recorded in errs');
    const calls = readCalls();
    const searchCalls = calls.filter((c) => c.startsWith('search:'));
    const postsCalls = calls.filter((c) => c.startsWith('posts:'));
    assert.ok(
      searchCalls.length > 0 && searchCalls.length < searches.length,
      `early halt must skip remaining queries (got ${searchCalls.length}/${searches.length})`,
    );
    assert.equal(postsCalls.length, 0, 'halt must also skip all profiles');
  });

test('a stub whose Threads() constructor raises still emits valid JSON with a fatal: errs entry',
  { skip: SKIP, timeout: 20000 }, async () => {
    const { code, out } = await runWorker('{"searches":["x"]}', { STUB_FATAL: '1' });
    assert.equal(code, 0);
    const obj = parseOne(out);
    assert.equal(obj.ok, true);
    assert.deepEqual(obj.posts, []);
    assert.ok(
      Array.isArray(obj.errs) && obj.errs.some((e) => typeof e.err === 'string' && e.err.includes('fatal:')),
      'errs must contain a fatal: entry',
    );
    assert.equal(readCalls().length, 0, 'no scraper call may follow a fatal constructor error');
  });
