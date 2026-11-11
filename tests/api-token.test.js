'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server.js');
const TOKEN = 'test-token-abc';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

const withTimeout = (ms) => ({ signal: AbortSignal.timeout(ms) });

let child = null;

function killChild() {
  if (!child || !child.pid) return;

  try { process.kill(-child.pid, 'SIGKILL'); } catch {  }
  try { child.kill('SIGKILL'); } catch {  }
}

after(() => killChild());

async function waitForPing() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server process exited before it became ready');
    try {
      const r = await fetch(`${BASE}/api/ping`, withTimeout(1000));
      if (r.status === 200) return;
    } catch {  }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('server did not answer /api/ping within ~10s');
}

test('API token gate (spawned server.js)', { timeout: 90000 }, async (t) => {
  child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), SITREP_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitForPing();

  await t.test('GET /api/ping needs no token, reports ok:true, and never echoes the token', async () => {
    const r = await fetch(`${BASE}/api/ping`, withTimeout(9000));
    const body = await r.text();
    assert.equal(r.status, 200);
    assert.match(body, /"ok"\s*:\s*true/);
    assert.ok(!body.includes(TOKEN), '/api/ping must not leak the token');
  });

  await t.test('GET /api/no-such-endpoint without a token -> 403 with the expected JSON error', async () => {
    const r = await fetch(`${BASE}/api/no-such-endpoint`, withTimeout(9000));
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { ok: false, err: 'token tidak valid' });
  });

  await t.test('a valid x-sitrep-token header passes the gate (404/unknown is fine)', async () => {

    const r = await fetch(`${BASE}/api/no-such-endpoint`, {
      ...withTimeout(9000),
      headers: { 'x-sitrep-token': TOKEN },
    });
    assert.notEqual(r.status, 403, 'a valid header token must not be rejected by the gate');
  });

  await t.test('a valid ?token= query param passes the gate (404/unknown is fine)', async () => {
    const r = await fetch(`${BASE}/api/no-such-endpoint?token=${TOKEN}`, withTimeout(9000));
    assert.notEqual(r.status, 403, 'a valid query-param token must not be rejected by the gate');
  });

  await t.test('GET / injects the sitrep-token meta tag', async () => {
    const r = await fetch(`${BASE}/`, withTimeout(9000));
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.ok(
      html.includes(`<meta name="sitrep-token" content="${TOKEN}">`),
      'HTML must carry the boot/env token in a <meta name="sitrep-token"> tag',
    );
  });

  await t.test('GET /img without a token is 403 (gate covers proxy endpoints)', async () => {

    const r = await fetch(`${BASE}/img?u=` + encodeURIComponent('https://example.com/a.png'), withTimeout(9000));
    assert.equal(r.status, 403);
  });
});
