'use strict';

function createMarketService({ fs, path, HIST_DIR, UA, get, memo }) {
  let mktFetch = get;
  function setMarketFetch(fn) { mktFetch = typeof fn === 'function' ? fn : get; }

  const STOCK_BLUE = new Set(['BBCA', 'TLKM', 'GOTO', 'BMRI', 'ASII', 'UNVR', 'KLBF']);
  const FOREX_PAIRS = [['USDIDR', 'USD/IDR']];
  const FX_NAME = Object.fromEntries(FOREX_PAIRS);
  const COMMODITIES = [
    ['COMEX:GC1!', 'Gold', 'futures', 'GC=F', '@GC.1'],
    ['COMEX:SI1!', 'Silver', 'futures', 'SI=F', '@SI.1'],
    ['NYMEX:CL1!', 'WTI Oil', 'futures', 'CL=F', '@CL.1'],
    ['NYMEX:NG1!', 'Nat Gas', 'futures', 'NG=F', '@NG.1'],
    ['COMEX:HG1!', 'Copper', 'futures', 'HG=F', '@HG.1'],
    ['COMEX:ALI1!', 'Aluminum', 'futures', 'ALI=F', '@AL.1'],
    ['NYMEX:HO1!', 'Heat Oil', 'futures', 'HO=F', '@HO.1'],
    ['CBOT:ZR1!', 'Rice', 'futures', 'ZR=F', '@RR.1'],
    ['CBOT:ZW1!', 'Wheat', 'futures', 'ZW=F', '@W.1'],
    ['CBOT:ZC1!', 'Corn', 'futures', 'ZC=F', '@C.1'],
    ['CBOT:ZS1!', 'Soybean', 'futures', 'ZS=F', '@S.1'],
    ['CME:DC1!', 'Milk', 'futures', 'DC=F', '@DA.1'],
    ['ICEUS:KC1!', 'Coffee', 'futures', 'KC=F', '@KC.1'],
    ['ICEUS:SB1!', 'Sugar', 'futures', 'SB=F', '@SB.1'],
    ['ICEUS:CC1!', 'Cocoa', 'futures', 'CC=F', '@CC.1'],
    ['BINANCE:BTCUSDT', 'Bitcoin', 'crypto', 'BTC-USD', 'BTC.CM=']
  ];
  const CMD_YH = Object.fromEntries(COMMODITIES.map(c => [c[0], c[3]]));
  const CMD_CNBC = Object.fromEntries(COMMODITIES.map(c => [c[0], c[4]]));
  async function tvScan(marketName, body) {
    const r = await mktFetch(`https://scanner.tradingview.com/${marketName}/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, 15000);
    if (!r.ok) throw new Error('tv scan ' + r.status);
    const d = await r.json();
    return (d && d.data) || [];
  }
  const COLS = ['name', 'close', 'change', 'change_abs', 'volume'];
  const row = (marketName, s) => {
    const d = s.d || [];
    return { sym: s.s, ticker: d[0], name: d[0], price: d[1], pct: d[2] || 0,
      chg: d[3] || 0, vol: d[4] || 0, mkt: marketName };
  };
  const FXHIST_F = path.join(HIST_DIR, 'fxhist.json');
  let fxhist = [];
  try { fxhist = JSON.parse(fs.readFileSync(FXHIST_F, 'utf8')); } catch (e) {}
  const saveFx = () => { try { fs.writeFileSync(FXHIST_F, JSON.stringify(fxhist.slice(-400))); } catch (e) {} };
  let fxBackfill = null;
  function backfillFx() {
    if (fxBackfill) return fxBackfill;
    fxBackfill = (async () => {
      const days = [];
      for (let i = 29; i >= 1; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
      for (let i = 0; i < days.length; i += 4) {
        await Promise.all(days.slice(i, i + 4).map(async day => {
          try {
            const r = await mktFetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`, {}, 10000);
            if (!r.ok) return;
            const d = await r.json();
            const v = d && d.usd && d.usd.idr;
            if (v != null && !fxhist.some(h => h.d === day)) fxhist.push({ d: day, v: +v });
          } catch (e) {}
        }));
      }
      fxhist = [...new Map(fxhist.map(h => [h.d, h])).values()].sort((a, b) => a.d < b.d ? -1 : 1);
      saveFx();
    })().catch(() => {});
    return fxBackfill;
  }
  async function usdidr() {
    try {
      const r = await mktFetch('https://www.floatrates.com/daily/usd.json', {}, 10000);
      if (!r.ok) return null;
      const d = await r.json();
      const it = d && d.idr;
      if (!it || !it.rate) return null;
      const day = it.date ? new Date(it.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
      const price = +it.rate;
      const last = fxhist[fxhist.length - 1];
      if (!last || last.d !== day) { fxhist.push({ d: day, v: price }); saveFx(); }
      const prev = fxhist.length > 1 ? fxhist[fxhist.length - 2].v : null;
      const chg = prev ? price - prev : 0;
      if (fxhist.length < 25) backfillFx();
      return { price, chg, pct: prev ? chg / prev * 100 : 0, closes: fxhist.slice(-60).map(h => h.v) };
    } catch (e) { return null; }
  }
  const WORLD_IDX = [
    ['^GSPC', 'S&P 500', '.SPX', 'SP:SPX'], ['^NDX', 'NASDAQ 100', '.NDX', 'NASDAQ:NDX'],
    ['^DJI', 'DOW', '.DJI', 'DJ:DJI'], ['^RUT', 'RUSSELL', '.RUT', 'TVC:RUT'],
    ['^N225', 'NIKKEI', '.N225', 'TVC:NI225'], ['^KS11', 'KOSPI', '.KS11', 'KRX:KOSPI'],
    ['^HSI', 'HANG SENG', '.HSI', 'HSI:HSI'], ['^TWII', 'TAIEX', '.TWII', 'TWSE:TAIEX'],
    ['^GDAXI', 'DAX', '.GDAXI', 'XETR:DAX'], ['^FTSE', 'FTSE 100', '.FTSE', 'FTSE:UKX'],
    ['^FCHI', 'CAC 40', '.FCHI', 'EURONEXT:PX1'], ['^SSMI', 'SMI', '.SSMI', 'SIX:SMI'],
    ['^AXJO', 'ASX 200', '.AXJO', 'ASX:XJO'], ['^BSESN', 'SENSEX', '.BSESN', 'BSE:SENSEX'],
    ['^NSEI', 'NIFTY', '.NSEI', 'NSE:NIFTY'], ['^STI', 'STI', '.STI', 'TVC:STI'],
    ['000001.SS', 'SSE', '.SSEC', 'SSE:000001'], ['^BVSP', 'IBOVESPA', '.BVSP', 'BMFBOVESPA:IBOV']
  ];
  const WORLD_CNBC = Object.fromEntries(WORLD_IDX.map(w => [w[0], w[2]]));

  function downsampleCloses(arr, maxPoints = 90) {
    const clean = (arr || []).map(Number).filter(v => Number.isFinite(v) && v > 0);
    if (clean.length <= maxPoints) return clean;
    const out = [];
    const step = (clean.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints - 1; i++) out.push(clean[Math.round(i * step)]);
    out.push(clean[clean.length - 1]);
    return out;
  }

  function cnbcSymbolFor(k) {
    if (!k) return '';
    if (k === 'IDX:COMPOSITE' || k === '^JKSE') return '.JKSE';
    if (k.startsWith('IDX:')) return k.slice(4) + '-ID';
    if (k === 'FX_IDC:USDIDR' || k === 'IDR=X') return 'IDR=';
    if (CMD_CNBC[k]) return CMD_CNBC[k];
    if (WORLD_CNBC[k]) return WORLD_CNBC[k];
    return k;
  }

  const MKT_CLOSES_F = path.join(HIST_DIR, 'market-closes.json');
  const closeMemo = new Map();
  let mktClosesDirty = false;
  let mktClosesSaveAt = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(MKT_CLOSES_F, 'utf8'));
    const nowLoad = Date.now();
    for (const [k, e] of Object.entries((saved && saved.items) || {})) {
      if (e && Array.isArray(e.closes) && e.closes.length >= 2 && Number.isFinite(e.at) && nowLoad - e.at < 24 * 3600e3) {
        closeMemo.set(k, { at: e.at, closes: e.closes });
      }
    }
  } catch (e) {}

  let mktClosesSaving = false;
  function saveMktCloses(force = false) {
    const now = Date.now();
    if (!mktClosesDirty && !force) return;
    if (!force && (now - mktClosesSaveAt < 60000 || mktClosesSaving)) return;
    mktClosesSaveAt = now;
    mktClosesDirty = false;
    const items = {};
    for (const [k, v] of closeMemo) {
      if (v && Array.isArray(v.closes) && v.closes.length >= 2) {
        items[k] = { at: v.at, closes: v.closes.slice(-90) };
      }
    }
    const payload = JSON.stringify({ at: now, items });
    const tmp = MKT_CLOSES_F + '.' + process.pid + '.tmp';
    if (force) {
      try {
        fs.mkdirSync(HIST_DIR, { recursive: true });
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, MKT_CLOSES_F);
      } catch (e) {}
      return;
    }
    mktClosesSaving = true;
    fs.promises.mkdir(HIST_DIR, { recursive: true })
      .then(() => fs.promises.writeFile(tmp, payload))
      .then(() => fs.promises.rename(tmp, MKT_CLOSES_F))
      .catch(() => {})
      .finally(() => { mktClosesSaving = false; });
  }

  let yahooBlockedUntil = 0;

  async function cnbcCloses(cnbcSym, tf = '5D', maxPts = 90) {
    if (!cnbcSym) return [];
    try {
      const r = await mktFetch(
        `https://ts-api.cnbc.com/harmony/app/charts/${tf}.json?symbol=${encodeURIComponent(cnbcSym)}`,
        { headers: { 'user-agent': UA, accept: 'application/json' } },
        8500
      );
      if (!r.ok) return [];
      const j = await r.json();
      const bars = (j && j.barData && j.barData.priceBars) || [];
      const raw = bars.map(b => Number(b && b.close)).filter(v => Number.isFinite(v) && v > 0);
      if (raw.length < 2) return [];
      return tf === '1M' ? raw.slice(-40) : downsampleCloses(raw, maxPts);
    } catch (e) { return []; }
  }

  async function binanceCloses(symbol = 'BTCUSDT') {
    try {
      const r = await mktFetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=48`, {}, 7000);
      if (!r.ok) return [];
      const rows = await r.json();
      if (!Array.isArray(rows)) return [];
      return rows.map(rowItem => Number(rowItem && rowItem[4])).filter(v => Number.isFinite(v) && v > 0);
    } catch (e) { return []; }
  }

  async function googleFinanceCompositeCloses() {
    try {
      const r = await mktFetch('https://www.google.com/finance/quote/COMPOSITE:IDX?hl=en', { headers: { 'user-agent': UA } }, 8500);
      if (!r.ok) return [];
      const html = await r.text();
      const vals = [];
      for (const m of html.matchAll(/\[\[\d{4},\d{1,2},\d{1,2},[^\]]+\],\s*\[([0-9]+(?:\.[0-9]+)?),/g)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 500) vals.push(n);
      }
      return downsampleCloses(vals, 60);
    } catch (e) { return []; }
  }

  async function yahooCloses(sym, q = 'interval=1m&range=1d') {
    if (!sym || Date.now() < yahooBlockedUntil) return [];
    let closesArr = [];
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        const r = await mktFetch(`https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?${q}`, { headers: { 'user-agent': UA } }, 9000);
        if (r.status === 429 || r.status === 403) {
          yahooBlockedUntil = Date.now() + 15 * 60000;
          break;
        }
        if (!r.ok) continue;
        const d = await r.json();
        const res = d && d.chart && d.chart.result && d.chart.result[0];
        const qq = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
        closesArr = ((qq && qq.close) || []).filter(v => Number.isFinite(v) && v > 0);
        if (closesArr.length >= 2) return downsampleCloses(closesArr, 90);
      } catch (e) {}
    }
    return closesArr;
  }

  const closeInflight = new Map();
  async function fetchSymbolCloses(k) {
    if (!k) return [];
    const mem = closeMemo.get(k);
    const now = Date.now();
    if (mem && mem.closes && mem.closes.length >= 2 && now - mem.at < 10 * 60000) return mem.closes;
    if (mem && (!mem.closes || mem.closes.length < 2) && mem.failAt && now - mem.failAt < 30000) return [];
    if (closeInflight.has(k)) return closeInflight.get(k);

    const task = (async () => {
      let series = [];
      const cnbcSym = cnbcSymbolFor(k);

      if (k === 'FX_IDC:USDIDR') {
        if (fxhist.length >= 2) series = fxhist.slice(-60).map(h => h.v);
        if (series.length < 2) series = await cnbcCloses('IDR=', '5D', 60);
        if (series.length < 2) series = await yahooCloses('IDR=X', 'interval=15m&range=5d');
      } else if (k === 'IDX:COMPOSITE') {
        series = await cnbcCloses('.JKSE', '1D', 90);
        if (series.length < 12) series = await cnbcCloses('.JKSE', '5D', 90);
        if (series.length < 2) series = await cnbcCloses('.JKSE', '1M', 45);
        if (series.length < 2) series = await yahooCloses('^JKSE', 'interval=1m&range=1d');
        if (series.length < 2) series = await yahooCloses('^JKSE', 'interval=1d&range=1mo');
        if (series.length < 2) series = await googleFinanceCompositeCloses();
      } else if (k.startsWith('IDX:')) {
        const yh = k.slice(4) + '.JK';
        series = await cnbcCloses(cnbcSym, '1M', 40);
        if (series.length < 2) series = await yahooCloses(yh, 'interval=1d&range=1mo');
      } else if (k === 'BINANCE:BTCUSDT') {
        series = await cnbcCloses('BTC.CM=', '5D', 90);
        if (series.length < 2) series = await binanceCloses('BTCUSDT');
        if (series.length < 2) series = await yahooCloses('BTC-USD', 'interval=1m&range=1d');
      } else {
        series = await cnbcCloses(cnbcSym, '5D', 90);
        if (series.length < 2) series = await cnbcCloses(cnbcSym, '1M', 45);
        if (series.length < 2) {
          const yh = CMD_YH[k] || k;
          series = await yahooCloses(yh, 'interval=1m&range=1d');
          if (series.length < 2) series = await yahooCloses(yh, 'interval=1d&range=1mo');
        }
      }

      if (series && series.length >= 2) {
        closeMemo.set(k, { at: Date.now(), closes: series });
        if (closeMemo.size > 500) closeMemo.delete(closeMemo.keys().next().value);
        mktClosesDirty = true;
        saveMktCloses(false);
        return series;
      }

      if (mem && mem.closes && mem.closes.length >= 2) {
        mem.failAt = Date.now();
        return mem.closes;
      }
      closeMemo.set(k, { at: 0, failAt: Date.now(), closes: [] });
      return [];
    })().finally(() => closeInflight.delete(k));

    closeInflight.set(k, task);
    return task;
  }

  const worldIndex = () => memo('worldidx', 60000, async () => {
    const tvMap = new Map();
    try {
      const tvRows = await tvScan('global', {
        columns: COLS.slice(0, 4),
        symbols: { query: { types: [] }, tickers: WORLD_IDX.map(w => w[3]).filter(Boolean) }
      });
      for (const s of tvRows) tvMap.set(s.s, row('WORLD', s));
    } catch (e) {}

    const out = [];
    for (let i = 0; i < WORLD_IDX.length; i += 6) {
      await Promise.all(WORLD_IDX.slice(i, i + 6).map(async ([sym, name, , tvSym]) => {
        const tv = tvSym ? tvMap.get(tvSym) : null;
        const cl = await fetchSymbolCloses(sym);
        const price = tv && isFinite(tv.price) ? tv.price : (cl.length ? cl[cl.length - 1] : null);
        if (!isFinite(price)) return;
        const prev = cl.length > 1 ? cl[cl.length - 2] : null;
        const chg = tv && isFinite(tv.chg) ? tv.chg : (prev ? price - prev : 0);
        const pct = tv && isFinite(tv.pct) ? tv.pct : (prev ? chg / prev * 100 : 0);
        out.push({ sym, ticker: name, name, price, prev, chg, pct, closes: cl.slice(-45) });
      }));
    }
    return out;
  });

  const knownMarketSyms = new Set([
    'IDX:COMPOSITE', 'FX_IDC:USDIDR', 'BINANCE:BTCUSDT', '^JKSE', 'IDR=X',
    ...WORLD_IDX.map(w => w[0]),
    ...COMMODITIES.map(c => c[0]),
  ]);

  const market = () => memo('market', 45000, async () => {
    const cmdTick = m => COMMODITIES.filter(c => c[2] === m).map(c => c[0]);
    const [idx, fx, cmdF, cmdC, ihsgR, idrQ, world, ihsgCloses] = await Promise.all([
      tvScan('indonesia', { columns: COLS, range: [0, 900],
        symbols: { query: { types: ['stock'] }, tickers: [] } }),
      tvScan('forex', { columns: COLS.slice(0, 4),
        symbols: { query: { types: [] }, tickers: FOREX_PAIRS.map(p => 'FX_IDC:' + p[0]) } }),
      tvScan('futures', { columns: COLS.slice(0, 4),
        symbols: { query: { types: [] }, tickers: cmdTick('futures') } }),
      tvScan('crypto', { columns: COLS.slice(0, 4),
        symbols: { query: { types: [] }, tickers: cmdTick('crypto') } }),
      tvScan('indonesia', { columns: COLS,
        symbols: { query: { types: [] }, tickers: ['IDX:COMPOSITE'] } }),
      usdidr(),
      worldIndex().catch(() => []),
      fetchSymbolCloses('IDX:COMPOSITE').catch(() => [])
    ]);
    const stocks = idx.map(s => {
      const it = row('IDX', s);
      it.blue = STOCK_BLUE.has(it.ticker);
      const cached = closeMemo.get(it.sym);
      if (cached && cached.closes && cached.closes.length >= 2) it.closes = cached.closes;
      return it;
    }).filter(x => isFinite(x.price) && x.price > 0);
    if (!stocks.length) throw new Error('market kosong');
    const ihsg = ihsgR.length ? { ...row('IDX', ihsgR[0]), name: 'IHSG', ticker: 'IHSG' } : null;
    if (ihsg && ihsgCloses && ihsgCloses.length >= 2) ihsg.closes = ihsgCloses;
    const forex = fx.map(s => {
      const it = row('FX', s);
      it.name = FX_NAME[it.ticker] || it.ticker;
      return it;
    }).filter(x => isFinite(x.price));
    const cmdRows = [...cmdF, ...cmdC];
    for (const [sym, name] of COMMODITIES) {
      const s = cmdRows.find(x => x.s === sym);
      if (!s) continue;
      const it = row('CMD', s);
      it.name = name;
      const cached = closeMemo.get(sym);
      if (cached && cached.closes && cached.closes.length >= 2) it.closes = cached.closes;
      if (isFinite(it.price)) forex.push(it);
    }
    const idr = forex.find(x => x.ticker === 'USDIDR');
    if (idr && idrQ) Object.assign(idr, { price: idrQ.price, chg: idrQ.chg, pct: idrQ.pct, closes: idrQ.closes });
    for (const s of stocks) if (s && s.sym) knownMarketSyms.add(s.sym);
    for (const f of forex) if (f && f.sym) knownMarketSyms.add(f.sym);
    return { ok: true, ihsg, stocks: { ok: true, items: stocks }, forex: { ok: true, items: forex }, world, at: Date.now() };
  });

  async function closes(list) {
    const out = {};
    const keys = [...new Set((list || []).filter(Boolean))].slice(0, 60);
    for (let i = 0; i < keys.length; i += 6) {
      await Promise.all(keys.slice(i, i + 6).map(async k => {
        out[k] = await fetchSymbolCloses(k);
      }));
    }
    return { ok: true, closes: out };
  }

  return {
    setMarketFetch,
    WORLD_IDX,
    COMMODITIES,
    downsampleCloses,
    cnbcSymbolFor,
    fetchSymbolCloses,
    closes,
    market,
    worldIndex,
    closeMemo,
    saveMktCloses,
    knownMarketSyms,
  };
}

module.exports = { createMarketService };
