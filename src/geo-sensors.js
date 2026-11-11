'use strict';

const https = require('https');

function createGeoSensors({
  crypto,
  UA,
  SEC,
  TRUSTED_ROOTS,
  get,
  mediaGet,
  mediaText,
  singleFlight,
  cacheFail,
  sleep,
  isDraining,
  isMain,
}) {
  const FL_PTS = [[3.6, 98.7, 250], [-6.2, 106.8, 250], [-3, 114.6, 250], [-2, 120.5, 250],
    [-8.6, 115.3, 250], [-2.5, 140.7, 250]];
  const flCache = { at: 0, items: [] };
  const flights = () => singleFlight(flCache, 20000, async () => {
    const seen = new Map();
    let anyOk = false;
    const norm = a => {
      if (a.lat == null || a.lon == null || a.alt_baro == null || a.alt_baro < 0) return;
      const k = a.hex || (a.flight + a.lat + a.lon);
      if (!seen.has(k)) seen.set(k, { cs: (a.flight || '').trim() || a.hex || '?', lat: a.lat, lon: a.lon,
        alt: Math.round(a.alt_baro * 0.3048), gs: a.gs != null ? Math.round(a.gs * 1.852) : null,
        hdg: a.track != null ? Math.round(a.track) : null, type: a.t || a.desc || '' });
    };
    for (const [lat, lon, dist] of FL_PTS) {
      try {
        const r = await get(`https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`, {}, 15000);
        if (r.ok) { anyOk = true; const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
        else throw new Error('fi ' + r.status);
      } catch (e) {
        try {
          const r = await get(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`, {}, 15000);
          if (r.ok) { anyOk = true; const d = await r.json(); for (const a of (d.ac || [])) norm(a); }
        } catch (e2) {}
      }
      await sleep(1050);
    }
    if (anyOk || !flCache.items.length) {
      flCache.items = [...seen.values()].slice(0, 1500);
      flCache.at = anyOk ? Date.now() : (Date.now() - 20000 + 8000);
    } else {
      flCache.at = Date.now() - 20000 + 8000;
    }
    return flCache.items;
  });

  const disCache = { at: 0, data: null };
  const VOLCANO_COORDS = {
    'Anak Krakatau':[-6.10,105.42],'Merapi':[-7.54,110.44],'Semeru':[-8.11,112.92],'Ibu':[-1.49,127.63],
    'Dukono':[1.69,127.88],'Sangeang Api':[-8.20,119.07],'Bromo':[-7.94,112.95],'Agung':[-8.34,115.51],
    'Sinabung':[3.17,98.39],'Kerinci':[-1.70,101.26],'Dempo':[-4.02,103.13],'Papandayan':[-7.32,107.73],
    'Guntur':[-7.25,107.85],'Batu Tara':[-7.79,123.58],'Karangetang':[2.78,125.41],'Lokon':[1.37,124.83],
    'Kelimutu':[-8.77,122.80],'Egon':[-8.68,122.45],'Lewotobi':[-8.54,122.77],
    'Lewotolo':[-8.27,123.50],'Paluweh':[-8.32,121.78],'Ili Lewotolok':[-8.27,123.50],'Sirung':[-8.49,124.13],
    'Namlegung':[-8.07,123.40],'Iya':[-8.89,121.63],'Batur':[-8.24,115.38],'Gamalama':[-8.08,127.32],
    'Dieng':[-7.20,109.90],'Slamet':[-7.24,109.21],'Lawu':[-7.63,111.19],'Merbabu':[-7.45,110.44],
    'Kelud':[-7.93,112.31],'Raung':[-8.13,114.06],'Argopuro':[-7.77,113.58],'Ijen':[-8.06,114.24]
  };
  function parseMagma(html) {
    const marks = [...html.matchAll(/Level\s+(IV|III|II|I)\s*\((Awas|Siaga|Waspada|Normal)\)/g)];
    const out = [];
    for (let i = 0; i < marks.length; i++) {
      const sec = html.slice(marks[i].index, marks[i+1] ? marks[i+1].index : html.length);
      for (const m of sec.matchAll(/<td>\s*([^<>]+?)\s*-\s*([^<>]+?)\s*<a/g)) {
        const name = m[1].trim();
        out.push({ name, loc: m[2].trim(), level: 'LEVEL ' + marks[i][1], status: marks[i][2],
          lat: VOLCANO_COORDS[name] ? VOLCANO_COORDS[name][0] : null,
          lon: VOLCANO_COORDS[name] ? VOLCANO_COORDS[name][1] : null });
      }
    }
    return out;
  }

  const tmaCache = { at: 0, data: null };
  const tmaPintuAir = () => singleFlight(tmaCache, 60000, async () => {
    try {
      const r = await get('https://sisteminformasibanjir.jakarta.go.id/map_master/pintu_air', {
        headers: { accept: 'application/json, text/plain, */*' }
      }, 8000);
      const parsed = await r.json();
      const gates = [];
      const SIAGA_LABEL = { 1: 'Siaga 1 (Bahaya)', 2: 'Siaga 2 (Kritis)', 3: 'Siaga 3 (Waspada)', 4: 'Siaga 4 (Normal)' };
      for (const f of (parsed.features || [])) {
        const p = f.properties || {};
        const pa = p.pintu_air || {};
        const coords = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
        const lon = parseFloat(coords[0]), lat = parseFloat(coords[1]);
        const siaga = Number(p.status_siaga || 4);
        gates.push({
          id: pa.id || p.id,
          name: pa.name || p.name || 'Pintu Air',
          sistem: pa.sistem_aliran || '',
          ketinggian: Number(p.ketinggian != null ? p.ketinggian : 0),
          siaga,
          siaga_label: SIAGA_LABEL[siaga] || `Siaga ${siaga}`,
          cuaca: p.cuaca?.nama || (typeof p.cuaca === 'string' ? p.cuaca : '—'),
          tanggal: p.tanggal || '',
          jam: p.jam || '',
          lat: isFinite(lat) ? lat : null,
          lon: isFinite(lon) ? lon : null
        });
      }
      tmaCache.at = Date.now();
      tmaCache.data = { ok: true, gates, at: Date.now() };
      return tmaCache.data;
    } catch (e) {
      return cacheFail(tmaCache, 60000, { ok: false, err: String(e.message || e).slice(0, 150), gates: [] });
    }
  });

  const disaster = () => singleFlight(disCache, 120000, async () => {
    const now = Date.now();
    const [auto, hist, magma] = await Promise.allSettled([
      get('https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json', {}, 15000).then(r => r.json()),
      get('https://data.bmkg.go.id/DataMKG/TEWS/gempaterkini.json', {}, 15000).then(r => r.json()),
      get('https://magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas', {}, 15000).then(r => r.text())
    ]);
    const gempa = [];
    const push = g => {
      const [lat, lon] = String(g.Coordinates || '').split(',').map(Number);
      if (!isFinite(lat) || !isFinite(lon)) return;
      gempa.push({ mag: parseFloat(g.Magnitude) || 0, lat, lon, depth: g.Kedalaman || '',
        wilayah: g.Wilayah || '', mmi: g.Dirasakan || '', potensi: g.Potensi || '', time: g.DateTime || g.Tanggal || '' });
    };
    if (auto.status === 'fulfilled') { const g = auto.value?.Infogempa?.gempa; if (g) push(g); }
    if (hist.status === 'fulfilled') { const arr = hist.value?.Infogempa?.gempa || []; arr.slice(0, 15).forEach(push); }
    const gunung = magma.status === 'fulfilled' ? parseMagma(magma.value) : [];
    const seen = new Set(), dedup = gempa.filter(g => { const k = g.lat.toFixed(3) + g.lon.toFixed(3) + g.mag; if (seen.has(k)) return false; seen.add(k); return true; });
    const gempaOk = auto.status === 'fulfilled' || hist.status === 'fulfilled';
    const magmaOk = magma.status === 'fulfilled';
    const tmaRes = await tmaPintuAir().catch(() => ({ ok: false, gates: [] }));
    const prev = disCache.data;
    const gempaOut = gempaOk ? dedup : (prev ? prev.gempa : []);
    const gunungOut = magmaOk ? gunung : (prev ? prev.gunung : []);
    const tmaOut = tmaRes.ok ? tmaRes.gates : (prev ? prev.tma || [] : []);
    const stale = !!prev && (!gempaOk || !magmaOk);
    disCache.at = now; disCache.data = { ok: true, gempa: gempaOut, gunung: gunungOut, tma: tmaOut, at: now, stale, srcErr: { gempa: !gempaOk, gunung: !magmaOk } };
    return disCache.data;
  });

  const WX_PTS = [[95.3,5.5],[99.5,0.5],[105.8,-6.2],[110.4,-7.5],[114.5,-3],[119.4,-0.5],[117.0,-5.1],[113.6,-7.3],[120.9,0.5],[119.9,-4.5],[123.0,-1.5],[124.8,0.9],[127.4,0.9],[130.8,-1.5],[131.3,-3],[136.1,-4.5],[137.8,-3],[140.5,-3.7],[113.9,0.5],[95.3,3.6]];
  const wxCache = { at: 0, data: null };
  const weather = () => singleFlight(wxCache, 600000, async () => {
    try {
      const lats = WX_PTS.map(p => p[1]).join(','), lons = WX_PTS.map(p => p[0]).join(',');
      const r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation,precipitation_probability,pressure_msl,relative_humidity_2m,visibility&timezone=Asia%2FJakarta`, {}, 20000);
      const d = await r.json();
      const list = Array.isArray(d) ? d : [d];
      const items = list.map((w, i) => ({ lat: WX_PTS[i][1], lon: WX_PTS[i][0],
        temp: w.current?.temperature_2m, code: w.current?.weather_code,
        wind: w.current?.wind_speed_10m, wdir: w.current?.wind_direction_10m,
        gust: w.current?.wind_gusts_10m, cloud: w.current?.cloud_cover,
        precip: w.current?.precipitation, precipProb: w.current?.precipitation_probability,
        pressure: w.current?.pressure_msl, humidity: w.current?.relative_humidity_2m,
        visibility: w.current?.visibility }));
      wxCache.at = Date.now(); wxCache.data = { ok: true, items, at: Date.now() };
    } catch (e) { return cacheFail(wxCache, 600000, { ok: false, err: String(e.message || e).slice(0, 150), items: [] }); }
    return wxCache.data;
  });

  const radarCache = { at: 0, data: null };
  const radar = () => singleFlight(radarCache, 300000, async () => {
    try {
      const r = await get('https://api.rainviewer.com/public/weather-maps.json', {}, 15000);
      const d = await r.json();
      const past = (d.radar && d.radar.past) || [];
      radarCache.at = Date.now();
      radarCache.data = { ok: true, generated: Number(d.generated) || Date.now() / 1000,
        host: String(d.host || 'https://tilecache.rainviewer.com'),
        frames: past.map(f => ({ time: Number(f.time), path: String(f.path || '') })), at: Date.now() };
      return radarCache.data;
    } catch (e) { return cacheFail(radarCache, 300000, { ok: false, err: String(e.message || e).slice(0, 150), frames: [] }); }
  });

  const fireCache = { at: 0, data: null };
  const FIRE_SOURCES = [
    ['VIIRS_SNPP_NRT', 'VIIRS SNPP', 3],
    ['VIIRS_NOAA20_NRT', 'VIIRS NOAA-20', 3],
    ['VIIRS_NOAA21_NRT', 'VIIRS NOAA-21', 3],
    ['MODIS_NRT', 'MODIS', 2]
  ];
  function csvLine(line) {
    return line.split(',').map(v => v.trim());
  }
  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const head = csvLine(lines[0]).map(h => h.toLowerCase());
    const idx = name => head.indexOf(name);
    const iLat = idx('latitude'), iLon = idx('longitude'), iDate = idx('acq_date'), iTime = idx('acq_time');
    const iSat = idx('satellite'), iInstr = idx('instrument'), iConf = idx('confidence'), iFrp = idx('frp'), iDay = idx('daynight');
    if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0) return [];
    return lines.slice(1).map(line => {
      const c = csvLine(line);
      const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      const hhmm = String(c[iTime] || '0').padStart(4, '0');
      const ts = Date.parse(`${c[iDate]}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00Z`) || 0;
      return {
        lat, lon, time: ts, acqDate: c[iDate], acqTime: hhmm,
        satellite: iSat >= 0 ? c[iSat] : '', instrument: iInstr >= 0 ? c[iInstr] : '',
        confidence: iConf >= 0 ? c[iConf] : '', frp: iFrp >= 0 ? parseFloat(c[iFrp]) || null : null,
        daynight: iDay >= 0 ? c[iDay] : ''
      };
    }).filter(Boolean);
  }
  const fires = () => singleFlight(fireCache, 600000, async () => {
    const key = (process.env.NASA_FIRMS_API_KEY || '').trim();
    if (!key) { fireCache.at = Date.now(); fireCache.data = { ok: false, err: 'NASA_FIRMS_API_KEY belum diset', items: [], at: Date.now(), sources: [] }; return fireCache.data; }
    const out = [];
    const sourceStatus = [];
    for (const [id, label] of FIRE_SOURCES) {
      try {
        const r = await get(`https://firms2.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${id}/95,-11,141,6/1`, {}, 20000);
        const text = await r.text();
        if (!r.ok || /Invalid MAP_KEY|provided MAP_KEY/i.test(text)) {
          sourceStatus.push({ id, ok: false, err: 'invalid key or request' }); continue;
        }
        const items = parseCsv(text).map(p => ({ ...p, source: id, sensor: label }));
        sourceStatus.push({ id, ok: true, count: items.length });
        out.push(...items);
      } catch (e) {
        sourceStatus.push({ id, ok: false, err: String(e.message || e).slice(0, 100) });
      }
    }
    out.sort((a, b) => b.time - a.time);
    return cacheFail(fireCache, 600000, { ok: sourceStatus.some(s => s.ok), items: out.slice(0, 3000), sources: sourceStatus, at: Date.now() });
  });

  const sipongiCache = { at: 0, data: null };
  const SIPONGI = 'https://opsroom.sipongidata.my.id';
  const SIPONGI_HOTSPOT_URL = SIPONGI + '/api/opsroom/indoHotspot?wilayah=IN&filterperiode=false&from=&to=&late=24' +
    '&satelit%5B%5D=NASA-MODIS&satelit%5B%5D=NASA-SNPP&satelit%5B%5D=NASA-NOAA20&satelit%5B%5D=NASA-NOAA21' +
    '&satelit%5B%5D=LPN-MODIS&satelit%5B%5D=LPN-NPP&satelit%5B%5D=LPN-NOAA20&satelit%5B%5D=LPN-LANDSAT8' +
    '&confidence%5B%5D=low&confidence%5B%5D=medium&confidence%5B%5D=high&provinsi=&kabkota=';
  const sipongi = () => singleFlight(sipongiCache, 600000, async () => {
    try {
      const [hsR, aqR] = await Promise.all([
        get(SIPONGI_HOTSPOT_URL, {}, 45000),
        get(SIPONGI + '/api/aqms', {}, 30000)
      ]);
      if (!hsR.ok && !aqR.ok) throw new Error(`sipongi http ${hsR.status}/${aqR.status}`);
      const hs = hsR.ok ? await hsR.json() : { features: [] };
      const aq = aqR.ok ? await aqR.json() : { features: [] };
      const spots = (hs.features || []).map(f => {
        const c = (f.geometry && f.geometry.coordinates) || [];
        const p = f.properties || {};
        const lon = parseFloat(c[0]), lat = parseFloat(c[1]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        return {
          lat, lon, time: Date.parse(p.date_hotspot_ori || p.hs_id || '') || 0,
          sumber: p.sumber || '', confidence: p.confidence_level || '',
          desa: p.desa || '', kecamatan: p.kecamatan || '', kabkota: p.kabkota || '',
          provinsi: p.nama_provinsi || ''
        };
      }).filter(Boolean);
      const air = (aq.features || []).map(f => {
        const c = (f.geometry && f.geometry.coordinates) || [];
        const p = f.properties || {};
        const lon = parseFloat(c[0]), lat = parseFloat(c[1]);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        return { lat, lon, kota: p.kota || '', provinsi: p.provinsi || '', alamat: p.alamat || '',
          nilai: p.nilai != null ? String(p.nilai) : (p.val != null ? String(p.val) : ''),
          cat: p.cat || '', waktu: p.waktu || '' };
      }).filter(Boolean);
      return cacheFail(sipongiCache, 600000, { ok: spots.length > 0 || air.length > 0, hotspots: spots, air, at: Date.now() });
    } catch (e) {
      return cacheFail(sipongiCache, 600000, { ok: false, err: String(e.message || e).slice(0, 150), hotspots: [], air: [], at: Date.now() });
    }
  });

  const modelRunCache = { at: 0, data: null };
  const bmkgModelRun = () => singleFlight(modelRunCache, 300000, async () => {
    try {
      const r = await get('https://satellite.bmkg.go.id/api22/modelrun', {}, 15000);
      const d = await r.json();
      return cacheFail(modelRunCache, 300000, { ok: true, himawari9: d.himawari9 || [], at: Date.now() });
    } catch (e) { return cacheFail(modelRunCache, 300000, { ok: false, err: String(e.message || e).slice(0, 150), himawari9: [] }); }
  });

  const SAT_PRODUCTS = [
    { id: 'ir', name: 'IR Enhanced', layerType: 'tile', param: 'EH', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_EH_Indonesia.png' },
    { id: 'natural', name: 'Natural Color (siang)', layerType: 'tile', param: 'NC', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_NC_Indonesia.png' },
    { id: 'water', name: 'Water Vapor Enhanced', layerType: 'tile', param: 'WV', updateMinutes: 10, dataType: 'observation', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_WE_Indonesia.png' },
    { id: 'rain', name: 'Rainfall Potential', layerType: 'tile', param: 'RP', updateMinutes: 10, dataType: 'derived', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/HIMA/H08_RP_Indonesia.png' },
    { id: 'geohotspot', name: 'Geohotspot', layerType: 'image', updateMinutes: 10, dataType: 'derived', source: 'BMKG Himawari-9', url: 'https://inderaja.bmkg.go.id/IMAGE/GEOHOTSPOT/H08_GH_Asean.png' },
    { id: 'cth', name: 'Cloud Top Height', layerType: 'image', updateMinutes: 60, dataType: 'derived', source: 'BMKG × JMA', url: 'https://inderaja.bmkg.go.id/IMAGE/HCAI/HTC/HCAI_HTC_Indonesia.png' },
    { id: 'ctype', name: 'Cloud Type', layerType: 'image', updateMinutes: 60, dataType: 'derived', source: 'BMKG × JMA', url: 'https://inderaja.bmkg.go.id/IMAGE/HCAI/CLC/HCAI_CLC_Indonesia.png' }
  ];
  const satelliteCache = { at: 0, data: null };
  const satelliteProducts = () => singleFlight(satelliteCache, 600000, async () => {
    const products = await Promise.all(SAT_PRODUCTS.map(async p => {
      try {
        const r = await get(p.url, { method: 'HEAD' }, 15000);
        return { ...p, lastModified: r.headers.get('last-modified') || null, contentLength: Number(r.headers.get('content-length')) || null, status: r.status, error: null };
      } catch (e) {
        return { ...p, lastModified: null, contentLength: null, status: 0, error: String(e.message || e).slice(0, 150) };
      }
    }));
    return cacheFail(satelliteCache, 600000, { ok: products.some(p => p.status === 200), products, attribution: 'BMKG · Himawari-9', at: Date.now() });
  });

  const WIND_LATS_DESC = [6,4,2,0,-2,-4,-6,-8,-10];
  const WIND_LONS = [95,98,101,104,107,110,113,116,119,122,125,128,131,134,137,140];
  const WIND_GRID = [];
  for (const la of WIND_LATS_DESC) for (const lo of WIND_LONS) WIND_GRID.push([la, lo]);
  const windCache = { at: 0, data: null };
  const windGrid = () => singleFlight(windCache, 900000, async () => {
    try {
      const lats = WIND_GRID.map(p => p[0]).join(','), lons = WIND_GRID.map(p => p[1]).join(',');
      const r = await get(`https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=wind_speed_10m,wind_direction_10m&timezone=Asia%2FJakarta`, {}, 30000);
      const d = await r.json();
      const list = Array.isArray(d) ? d : [d];
      const cur = new Map();
      list.forEach((w, i) => cur.set(WIND_GRID[i][0] + ',' + WIND_GRID[i][1], w.current || {}));
      const uData = [], vData = [];
      for (const la of WIND_LATS_DESC) {
        for (const lo of WIND_LONS) {
          const w = cur.get(la + ',' + lo) || {};
          const speed = (w.wind_speed_10m || 0) / 3.6;
          const dir = (w.wind_direction_10m || 0) * Math.PI / 180;
          uData.push(-speed * Math.sin(dir));
          vData.push(-speed * Math.cos(dir));
        }
      }
      const refTime = Date.now();
      const mkHeader = n => ({
        lo1: WIND_LONS[0], la1: WIND_LATS_DESC[0], dx: 3, dy: 2,
        nx: WIND_LONS.length, ny: WIND_LATS_DESC.length,
        refTime, forecastTime: 0, parameterCategory: 2, parameterNumber: n,
        parameterName: n === 2 ? 'u-component_of_wind' : 'v-component_of_wind'
      });
      windCache.at = Date.now();
      windCache.data = { ok: true, data: [
        { header: mkHeader(2), data: uData },
        { header: mkHeader(3), data: vData }
      ], at: Date.now() };
    } catch (e) { return cacheFail(windCache, 900000, { ok: false, err: String(e.message || e).slice(0, 150), data: null }); }
    return windCache.data;
  });

  const alertCache = { at: 0, data: null };
  function parseCapField(xml, tag) {
    const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
  }
  function parsePolygon(text) {
    const pts = [];
    const tokens = text.trim().split(/\s+/);
    for (const t of tokens) {
      const parts = t.split(',');
      if (parts.length === 2) {
        const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
        if (isFinite(a) && isFinite(b)) pts.push([a, b]);
      }
    }
    if (pts.length === 0) {
      const nums = text.trim().split(/[\s,]+/).map(Number).filter(isFinite);
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i+1]]);
    }
    return pts;
  }
  const alerts = () => singleFlight(alertCache, 300000, async () => {
    const out = [];
    try {
      const r = await get('https://www.bmkg.go.id/alerts/nowcast/id', {}, 20000);
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
      const details = [];
      for (const it of items) {
        const title = parseCapField(it, 'title');
        const link = parseCapField(it, 'link');
        const desc = parseCapField(it, 'description');
        const pubDate = parseCapField(it, 'pubDate');
        details.push({ title, link, desc, pubDate });
      }
      const conc = 4;
      for (let i = 0; i < details.length; i += conc) {
        const batch = details.slice(i, i + conc);
        const res = await Promise.all(batch.map(async d => {
          if (!d.link) return null;
          try {
            const { r: rr } = await mediaGet(d.link, 15000);
            const cx = await mediaText(rr, 1 << 20);
            const event = parseCapField(cx, 'event') || parseCapField(cx, 'headline') || d.title;
            const headline = parseCapField(cx, 'headline') || d.title;
            const description = parseCapField(cx, 'description') || d.desc;
            const effective = parseCapField(cx, 'effective');
            const expires = parseCapField(cx, 'expires');
            const severity = parseCapField(cx, 'severity');
            const urgency = parseCapField(cx, 'urgency');
            const certainty = parseCapField(cx, 'certainty');
            const web = parseCapField(cx, 'web');
            let polyText = '';
            const areaMatch = cx.match(/<polygon[^>]*>([\s\S]*?)<\/polygon>/i);
            if (areaMatch) polyText = areaMatch[1];
            else {
              const am = cx.match(/<area>([\s\S]*?)<\/area>/i);
              if (am) {
                const pm = am[1].match(/<polygon[^>]*>([\s\S]*?)<\/polygon>/i);
                if (pm) polyText = pm[1];
              }
            }
            const polygon = parsePolygon(polyText);
            return { event, headline, description, effective, expires, severity, urgency, certainty, web, polygon };
          } catch (e) { return null; }
        }));
        for (const r of res) if (r) out.push(r);
      }
      alertCache.at = Date.now();
      alertCache.data = { ok: true, items: out, at: Date.now() };
    } catch (e) {
      return cacheFail(alertCache, 300000, { ok: false, err: String(e.message || e).slice(0, 150), items: [] });
    }
    return alertCache.data;
  });

  const shipMap = new Map();
  let wsSock = null, wsBuf = Buffer.alloc(0), wsRetry = 0, wsTimer = null;
  function stopAis() {
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    if (wsSock) { try { wsSock.destroy(); } catch {} wsSock = null; }
  }
  function isAisLive() {
    return !!(wsSock && !wsSock.destroyed);
  }
  function wsSchedule(ms) {
    if (isDraining() || wsTimer) return;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      if (!isDraining() && isMain) {
        SEC.runIsolated('ais', () => aisConnect());
      }
    }, ms);
    if (wsTimer.unref) wsTimer.unref();
  }
  function wsSend(text) {
    if (!wsSock || wsSock.destroyed) return;
    const p = Buffer.from(text), mask = crypto.randomBytes(4);
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    const masked = Buffer.from(p); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try { wsSock.write(Buffer.concat([h, mask, masked])); } catch (e) {}
  }
  function wsFrames() {
    for (;;) {
      if (wsBuf.length < 2) return;
      const op = wsBuf[0] & 0x0f, len0 = wsBuf[1] & 0x7f; let off = 2, len = len0;
      if (len0 === 126) { if (wsBuf.length < 4) return; len = wsBuf.readUInt16BE(2); off = 4; }
      else if (len0 === 127) { if (wsBuf.length < 10) return; len = Number(wsBuf.readBigUInt64BE(2)); off = 10; }
      if (!Number.isFinite(len) || len < 0 || len > 2097152) {
        console.error('[ais] frame size tidak valid:', len);
        try { wsSock && wsSock.destroy(); } catch {}
        wsSock = null; wsBuf = Buffer.alloc(0);
        return;
      }
      if (wsBuf.length < off + len) return;
      const pl = wsBuf.slice(off, off + len); wsBuf = wsBuf.slice(off + len);
      if (op === 9) {
        const mask = crypto.randomBytes(4), pl2 = Buffer.from(pl);
        for (let i = 0; i < pl2.length; i++) pl2[i] ^= mask[i & 3];
        const h = Buffer.from([0x8a, 0x80 | pl2.length]);
        try { wsSock.write(Buffer.concat([h, mask, pl2])); } catch (e) {}
      } else if (op === 8) { try { wsSock.end(); } catch (e) {} wsSock = null; }
      else if (op === 1 || op === 2) {
        try {
          const d = JSON.parse(pl.toString());
          if (!global._aisLogged) { global._aisLogged = 1; console.log('[ais] msg', d.MessageType, JSON.stringify(d).slice(0, 200)); }
          if (d.MessageType === 'PositionReport' && d.Message && d.Message.PositionReport) {
            const p = d.Message.PositionReport, m = d.MetaData || {};
            if (p.Latitude != null && p.Longitude != null)
              shipMap.set(String(p.UserID), { mmsi: p.UserID, name: (m.ShipName || '').trim(),
                dest: (m.Destination || '').trim(), type: m.ShipType || '', lat: p.Latitude, lon: p.Longitude,
                sog: p.Sog != null ? +p.Sog.toFixed(1) : null, hdg: p.TrueHeading > 0 ? p.TrueHeading : (p.Cog != null ? Math.round(p.Cog) : null), at: Date.now() });
            if (shipMap.size > 3000) shipMap.delete(shipMap.keys().next().value);
          }
        } catch (e) {}
      }
    }
  }
  function aisConnect() {
    if (isDraining() || (wsSock && !wsSock.destroyed)) return;
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    const key = crypto.randomBytes(16).toString('base64');
    const req = https.request({
      host: 'stream.aisstream.io', path: '/v0/stream', method: 'GET', rejectUnauthorized: true, ca: TRUSTED_ROOTS.pems, timeout: 20000,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'User-Agent': UA }
    });
    req.on('upgrade', (res, socket) => {
      wsSock = socket; wsBuf = Buffer.alloc(0); wsRetry = 0;
      socket.on('data', c => {
        if (socket !== wsSock) return;
        if (wsBuf.length + c.length > 2097152) {
          console.error('[ais] buffer overflow, putus koneksi');
          wsBuf = Buffer.alloc(0);
          try { socket.destroy(); } catch {}
          return;
        }
        wsBuf = Buffer.concat([wsBuf, c]);
        wsFrames();
      });
      socket.on('close', () => { if (socket === wsSock) wsSock = null; if (!isDraining()) wsSchedule(15000); });
      socket.on('error', () => { if (socket === wsSock) wsSock = null; });
      wsSend(JSON.stringify({ APIKey: process.env.AISSTREAM_API_KEY || '',
        BoundingBoxes: [[[-11, 95], [6.5, 141]]],
        FilterMessageTypes: ['PositionReport'], FiltersShipMMSI: [] }));
    });
    req.on('timeout', () => { try { req.destroy(new Error('AIS handshake timeout')); } catch {} });
    req.on('response', (res) => { console.log('[ais] rejected', res.statusCode); req.destroy(); wsSchedule(Math.min(120000, 15000 * ++wsRetry)); });
    req.on('error', (e) => { console.log('[ais]', e.message); wsSchedule(Math.min(120000, 15000 * ++wsRetry)); });
    req.on('upgrade', () => console.log('[ais] connected'));
    req.end();
  }
  if (isMain) {
    SEC.runIsolated('ais', () => aisConnect());
  }
  async function ships() {
    const cutoff = Date.now() - 10 * 60000;
    return [...shipMap.values()].filter(s => s.at > cutoff)
      .sort((a, b) => (b.sog || 0) - (a.sog || 0)).slice(0, 800);
  }

  const TJ_API = 'https://tijeapi.transjakarta.co.id';
  const TJ_H = { 'Content-Type': 'application/json', 'User-Agent': 'okhttp/4.12.0',
    'X-App-OS': 'android', 'X-App-Version': '2.10.2', 'X-Device-ID': 'sitrep-console' };
  let tjToken = null, tjTokenAt = 0, busCache = { at: 0, items: [] };
  async function tjAuth() {
    if (tjToken && Date.now() - tjTokenAt < 20 * 3600e3) return tjToken;
    const r = await get(TJ_API + '/v1/auth/login/guest', { method: 'POST', headers: TJ_H, body: '{}' }, 15000);
    const d = await r.json();
    if (!d.token) throw new Error('tj guest login gagal');
    tjToken = d.token; tjTokenAt = Date.now();
    return tjToken;
  }
  const transit = () => singleFlight(busCache, 25000, async () => {
    try {
      const tok = await tjAuth();
      const r = await get(TJ_API + '/v1/bus?latitude=-6.1754&longitude=106.8272&radius=20',
        { headers: { ...TJ_H, Authorization: 'Bearer ' + tok } }, 25000);
      const d = await r.json();
      const arr = Array.isArray(d.data) ? d.data : (d.data && d.data.buses) || [];
      const items = arr.filter(b => b.latitude != null && b.longitude != null).map(b => ({
        id: b.bus_body_no || b.trip_id || '?', route: b.route_code || '', name: b.route_name || b.route_long_name || '',
        dest: b.trip_headsign || b.direction || '', speed: b.speed != null ? b.speed : null,
        bearing: b.bearing != null ? Math.round(b.bearing) : null, lat: b.latitude, lon: b.longitude })).slice(0, 2500);
      if (items.length) { busCache.at = Date.now(); busCache.items = items; }
      else busCache.at = Date.now();
    } catch (e) { busCache.at = Date.now(); }
    return busCache.items;
  });
  if (isMain) transit();

  return {
    flights,
    disaster,
    disCache,
    weather,
    radar,
    tmaPintuAir,
    fires,
    sipongi,
    bmkgModelRun,
    satelliteProducts,
    windGrid,
    alerts,
    ships,
    shipMap,
    stopAis,
    isAisLive,
    transit,
  };
}

module.exports = { createGeoSensors };
