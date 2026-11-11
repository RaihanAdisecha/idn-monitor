'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sitrep-mkt-test-'));
process.env.SITREP_DATA_DIR = TMP_DATA_DIR;
const SRV = require('../server');

function clearMarketState() {
  SRV.closeMemo.clear();
  SRV.cache.delete('market');
  SRV.cache.delete('worldidx');
  SRV.setMarketFetch(null);
}

after(() => {
  clearMarketState();
  try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch {}
});
beforeEach(() => clearMarketState());

test('1. downsampleCloses cleans invalid entries and preserves endpoints', () => {
  assert.deepEqual(SRV.downsampleCloses([null, 0, -5, NaN, 100, 105, 110]), [100, 105, 110]);
  const long = Array.from({ length: 300 }, (_, i) => 5000 + i);
  const ds = SRV.downsampleCloses(long, 60);
  assert.equal(ds.length, 60);
  assert.equal(ds[0], 5000);
  assert.equal(ds[ds.length - 1], 5299);
});

test('2. cnbcSymbolFor maps IHSG, IDX equities, commodities, crypto, FX, and world indices', () => {
  assert.equal(SRV.cnbcSymbolFor('IDX:COMPOSITE'), '.JKSE');
  assert.equal(SRV.cnbcSymbolFor('IDX:BBCA'), 'BBCA-ID');
  assert.equal(SRV.cnbcSymbolFor('FX_IDC:USDIDR'), 'IDR=');
  assert.equal(SRV.cnbcSymbolFor('COMEX:ALI1!'), '@AL.1');
  assert.equal(SRV.cnbcSymbolFor('CBOT:ZR1!'), '@RR.1');
  assert.equal(SRV.cnbcSymbolFor('CME:DC1!'), '@DA.1');
  assert.equal(SRV.cnbcSymbolFor('BINANCE:BTCUSDT'), 'BTC.CM=');
  assert.equal(SRV.cnbcSymbolFor('^GSPC'), '.SPX');
  assert.equal(SRV.cnbcSymbolFor('000001.SS'), '.SSEC');
});

test('3. Multi-provider closes() serves CNBC charts when Yahoo returns 429 and avoids empty cache poisoning', async () => {
  let cnbcCalls = 0;
  let failMode = false;

  SRV.setMarketFetch(async (url) => {
    if (url.includes('finance.yahoo.com')) {
      return { ok: false, status: 429, text: async () => 'Too Many Requests', json: async () => ({}) };
    }
    if (url.includes('ts-api.cnbc.com')) {
      cnbcCalls++;
      if (failMode) return { ok: false, status: 503, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          barData: {
            priceBars: [
              { close: '5010.5' }, { close: '5040.2' }, { close: '5088.1' }, { close: '5125.7' }
            ]
          }
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  const out = await SRV.closes(['IDX:COMPOSITE', 'IDX:BBCA', 'COMEX:GC1!']);
  assert.equal(out.ok, true);
  assert.equal(out.closes['IDX:COMPOSITE'].length, 4);
  assert.equal(out.closes['IDX:BBCA'].length, 4);
  assert.equal(out.closes['COMEX:GC1!'].length, 4);
  assert.equal(out.closes['IDX:COMPOSITE'][3], 5125.7);

  const prevEntry = SRV.closeMemo.get('IDX:COMPOSITE');
  prevEntry.at = Date.now() - 20 * 60000;
  failMode = true;
  const fallbackOut = await SRV.fetchSymbolCloses('IDX:COMPOSITE');
  assert.equal(fallbackOut.length, 4, 'Must retain stale valid series instead of poisoning with []');

  const cold = await SRV.fetchSymbolCloses('IDX:COLDTEST');
  assert.deepEqual(cold, []);
  const coldMeta = SRV.closeMemo.get('IDX:COLDTEST');
  assert.equal(coldMeta.at, 0);
  assert.ok(coldMeta.failAt > 0);

  coldMeta.failAt = Date.now() - 60000;
  failMode = false;
  const recovered = await SRV.fetchSymbolCloses('IDX:COLDTEST');
  assert.equal(recovered.length, 4);
  assert.ok(cnbcCalls >= 4);
});

test('4. BINANCE:BTCUSDT falls back to Binance klines if CNBC & Yahoo fail', async () => {
  SRV.setMarketFetch(async (url) => {
    if (url.includes('ts-api.cnbc.com') || url.includes('finance.yahoo.com')) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    if (url.includes('api.binance.com/api/v3/klines')) {
      return {
        ok: true,
        status: 200,
        json: async () => [[0, '70000', '71000', '69000', '70500.5'], [1, '70500', '72000', '70000', '71850.25']]
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  const cl = await SRV.fetchSymbolCloses('BINANCE:BTCUSDT');
  assert.deepEqual(cl, [70500.5, 71850.25]);
});

test('5. market() and worldIndex() populate ihsg.closes and world indices even under Yahoo 429', async () => {
  SRV.setMarketFetch(async (url, opt) => {
    if (url.includes('finance.yahoo.com')) {
      return { ok: false, status: 429, json: async () => ({}) };
    }
    if (url.includes('scanner.tradingview.com/indonesia/scan')) {
      const body = JSON.parse(opt.body || '{}');
      if ((body.symbols && body.symbols.tickers || []).includes('IDX:COMPOSITE')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ s: 'IDX:COMPOSITE', d: ['COMPOSITE', 5125.72, 1.02, 51.95, 0] }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ s: 'IDX:BBCA', d: ['BBCA', 5300, 0.95, 50, 1000000] }] }) };
    }
    if (url.includes('scanner.tradingview.com/forex/scan')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ s: 'FX_IDC:USDIDR', d: ['USDIDR', 18030, -0.45, -81, 0] }] }) };
    }
    if (url.includes('scanner.tradingview.com/futures/scan') || url.includes('scanner.tradingview.com/crypto/scan')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ s: 'COMEX:GC1!', d: ['GC1!', 4042, 0.5, 20, 0] }] }) };
    }
    if (url.includes('scanner.tradingview.com/global/scan')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ s: 'SP:SPX', d: ['SPX', 7520.93, -0.38, -29.01, 0] }] }) };
    }
    if (url.includes('floatrates.com')) {
      return { ok: true, status: 200, json: async () => ({ idr: { rate: 18030, date: new Date().toUTCString() } }) };
    }
    if (url.includes('ts-api.cnbc.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ barData: { priceBars: [{ close: '5050' }, { close: '5090' }, { close: '5125.72' }] } })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  const mkt = await SRV.market();
  assert.equal(mkt.ok, true);
  assert.ok(mkt.ihsg && Array.isArray(mkt.ihsg.closes) && mkt.ihsg.closes.length >= 2, 'market() must return ihsg.closes directly');
  assert.ok(Array.isArray(mkt.world) && mkt.world.length >= 1, 'market() must populate world indices via TradingView + CNBC under Yahoo 429');
  assert.ok(mkt.world.some(w => w.sym === '^GSPC' && Array.isArray(w.closes) && w.closes.length >= 2));
});

test('6. public/index.html client market logic coalesces /api/closes and never locks empty [] series', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('function hasValidCloses(s){ return Array.isArray(CLOSES[s]) && CLOSES[s].length >= 2; }'));
  assert.ok(html.includes('if (Array.isArray(arr) && arr.length >= 2) {'));
  assert.ok(html.includes('if (closesInFlight) { closesQueued = true; return closesInFlight; }'));
  assert.ok(html.includes("if (IHSG && Array.isArray(IHSG.closes) && IHSG.closes.length >= 2) {\n    CLOSES['IDX:COMPOSITE'] = IHSG.closes;"));
  assert.ok(html.includes('const y = rg > 0 ? (h - 2 - (v - min) / rg * (h - 6)) : (h / 2);'));
});
