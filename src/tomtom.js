'use strict';

function createTomTomService({
  crypto,
  TOMTOM_KEY,
  AUTH,
  METRICS,
  memo,
  mediaGet,
  mediaText,
  mediaBody,
  recordUpstream,
  openCors,
}) {
  const ttHas = () => !!TOMTOM_KEY;
  const haversine = (a, b) => {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const ttHostOK = u => { try { const h = new URL(u).hostname; return h === 'api.tomtom.com' || h.endsWith('.api.tomtom.com'); } catch (e) { return false; } };
  async function ttFetch(url) {
    const t0 = Date.now();
    try {
      const { r } = await mediaGet(url, 12000, { accept: 'application/json' }, ttHostOK);
      const txt = await mediaText(r, 2 << 20);
      let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt.slice(0, 400) }; }
      if (!r.ok) { const err = new Error('TomTom ' + r.status + ' ' + (data.detailedError?.message || data.error || txt.slice(0, 120))); err.status = r.status; err.data = data; throw err; }
      recordUpstream('tomtom', true, Date.now() - t0);
      return data;
    } catch (e) {
      recordUpstream('tomtom', false, Date.now() - t0);
      throw e;
    }
  }
  const roundGrid = (v, step) => Math.round(Number(v) / step) * step;
  const roundGridStr = (v, step, d = 2) => roundGrid(v, step).toFixed(d);
  const ttFlow = (lat, lon, zoom = 10) => {
    const gLat = roundGrid(lat, 0.01);
    const gLon = roundGrid(lon, 0.01);
    const z = Math.max(0, Math.min(22, Math.round(zoom)));
    return memo('tt:flow:' + roundGridStr(gLat, 0.01) + ',' + roundGridStr(gLon, 0.01) + ',' + z, 30000, async () => {
      try {
        if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
        const url = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/' + z + '/json?key=' + encodeURIComponent(TOMTOM_KEY) + '&point=' + gLat.toFixed(4) + ',' + gLon.toFixed(4) + '&unit=kmph&thickness=10';
        const d = await ttFetch(url);
        const f = d.flowSegmentData || {};
        return { ok: true, point: { lat: gLat, lon: gLon }, zoom: z, frc: f.frc || '', exists: !!f.coordinate || !!f.frc,
          coordinates: f.coordinates?.coordinate || [],
          currentSpeed: f.currentSpeed ?? null, freeFlowSpeed: f.freeFlowSpeed ?? null,
          currentTravelTime: f.currentTravelTime ?? null, freeFlowTravelTime: f.freeFlowTravelTime ?? null,
          confidence: f.confidence ?? null, roadClosure: !!f.roadClosure, openlr: f.openlr || '', at: Date.now() };
      } catch (e) {
        return { ok: false, err: String(e.message || e).slice(0, 220) };
      }
    }, v => !!(v && v.ok));
  };

  const ttIncidents = (bbox, language = 'id-ID') => {
    const parts = String(bbox || '').split(',').map(Number);
    const normBbox = (parts.length === 4 && parts.every(Number.isFinite))
      ? parts.map(v => roundGridStr(v, 0.05, 2)).join(',')
      : String(bbox || '');
    return memo('tt:inc:' + normBbox + ':' + String(language || 'id-ID').slice(0, 12), 30000, async () => {
      try {
        if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
        const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity,probabilityOfOccurrence,numberOfReports,lastReportTime}}}';
        const url = 'https://api.tomtom.com/traffic/services/5/incidentDetails?key=' + encodeURIComponent(TOMTOM_KEY) +
          '&bbox=' + encodeURIComponent(normBbox) + '&fields=' + encodeURIComponent(fields) +
          '&language=' + encodeURIComponent(language) + '&timeValidityFilter=present';
        const d = await ttFetch(url);
        const rows = (d.incidents || []).filter(Boolean).map(inc => {
          const p = inc.properties || {};
          const coords = inc.geometry?.coordinates;
          let lat = null, lon = null;
          if (inc.geometry?.type === 'Point' && Array.isArray(coords)) { lon = coords[0]; lat = coords[1]; }
          else if (inc.geometry?.type === 'LineString' && Array.isArray(coords) && coords[0]) { lon = coords[0][0]; lat = coords[0][1]; }
          return { id: p.id || '', iconCategory: p.iconCategory ?? 0, magnitude: p.magnitudeOfDelay ?? 0,
            desc: (p.events?.[0]?.description || p.events?.map(e => e.description).join('; ') || 'Insiden lalu lintas'),
            from: p.from || '', to: p.to || '', length: p.length ?? null, delay: p.delay ?? null,
            startTime: p.startTime || '', endTime: p.endTime || '', timeValidity: p.timeValidity || '',
            probability: p.probabilityOfOccurrence || '', reports: p.numberOfReports ?? null, lastReport: p.lastReportTime || '',
            geometry: inc.geometry || null, lat, lon };
        });
        return { ok: true, bbox: normBbox, count: rows.length, incidents: rows, at: Date.now() };
      } catch (e) {
        return { ok: false, bbox: normBbox, err: String(e.message || e).slice(0, 260) };
      }
    }, v => !!(v && v.ok));
  };

  const ttRoute = (from, to, mode = 'driving') => {
    const fLat = roundGrid(from.lat, 0.01), fLon = roundGrid(from.lon, 0.01);
    const tLat = roundGrid(to.lat, 0.01), tLon = roundGrid(to.lon, 0.01);
    return memo('tt:route:' + fLat.toFixed(2) + ',' + fLon.toFixed(2) + '>' + tLat.toFixed(2) + ',' + tLon.toFixed(2) + ':' + mode, 30000, async () => {
      try {
        if (!ttHas()) throw new Error('TomTom API key belum dikonfigurasi');
        const iso = ['driving', 'truck', 'bus', 'taxi', 'motorcycle', 'bicycle', 'pedestrian'].includes(mode) ? mode : 'driving';
        const url = 'https://api.tomtom.com/routing/1/calculateRoute/' + fLat.toFixed(4) + ',' + fLon.toFixed(4) + ':' + tLat.toFixed(4) + ',' + tLon.toFixed(4) +
          '/json?key=' + encodeURIComponent(TOMTOM_KEY) +
          '&traffic=true&routeRepresentation=polyline';
        const d = await ttFetch(url);
        const route = d.routes?.[0];
        if (!route) throw new Error('Rute tidak ditemukan');
        const s = route.summary || {};
        const pts = (route.legs || []).flatMap(l => l.points || []);
        const poly = pts.map(p => ({ lat: p.latitude, lon: p.longitude }));
        return { ok: true, mode: iso,
          from: { lat: fLat, lon: fLon }, to: { lat: tLat, lon: tLon },
          straightKm: +haversine(from, to).toFixed(3),
          distanceKm: s.lengthInMeters ? +(s.lengthInMeters / 1000).toFixed(3) : null,
          travelTimeSec: s.travelTimeInSeconds ?? null,
          trafficTimeSec: (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) > 0 ? (s.travelTimeInSeconds ?? 0) + (s.trafficDelayInSeconds ?? 0) : (s.travelTimeInSeconds ?? null),
          trafficDelaySec: s.trafficDelayInSeconds ?? null,
          departureTime: s.departureTime || '', arrivalTime: s.arrivalTime || '',
          congestion: s.trafficCongestion || '', legs: (route.legs || []).map(l => ({
            summary: l.summary || {}, points: (l.points || []).length })),
          polyline: poly, at: Date.now() };
      } catch (e) {
        return { ok: false, err: String(e.message || e).slice(0, 280) };
      }
    }, v => !!(v && v.ok));
  };

  const ttTileCache = new Map();
  const TT_TILE_TTL = 120000, TT_TILE_CAP = 300, TT_TILE_MAX_BYTES = 16 << 20;
  const ttTileBusy = new Map();
  const ttTileBytes = () => { let n = 0; for (const e of ttTileCache.values()) n += e.buf.length; return n; };
  function ttTileSet(key, entry) {
    ttTileCache.delete(key);
    ttTileCache.set(key, entry);
    while (ttTileCache.size > TT_TILE_CAP || (ttTileCache.size > 1 && ttTileBytes() > TT_TILE_MAX_BYTES)) {
      ttTileCache.delete(ttTileCache.keys().next().value);
    }
  }
  async function ttTile(kind, zRaw, xRaw, yRaw, res, req) {
    const cors = openCors() ? { 'access-control-allow-origin': '*' } : {};
    const z = Number(zRaw), x = Number(xRaw), y = Number(yRaw);
    const maxTile = (1 << Math.max(0, Math.min(18, z | 0))) - 1;
    if (!Number.isInteger(z) || z < 0 || z > 18 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > maxTile || y > maxTile) {
      res.writeHead(400, { ...cors, 'x-content-type-options': 'nosniff' });
      return res.end('koordinat tile tidak valid');
    }
    if (!ttHas()) { res.writeHead(503, cors); return res.end('TomTom key belum dikonfigurasi'); }
    const paths = {
      basic: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
      base: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
      flow: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png',
      incidents: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
      incident: '/traffic/map/4/tile/incidents/s0-dark/' + z + '/' + x + '/' + y + '.png',
      hybrid: '/traffic/map/4/tile/flow/absolute/' + z + '/' + x + '/' + y + '.png'
    };
    const normKind = paths[kind] ? kind : 'flow';
    const cacheKey = normKind + '/' + z + '/' + x + '/' + y;
    const cc = AUTH.userMode ? 'private, no-store' : 'public, max-age=300, s-maxage=120, stale-while-revalidate=300';
    const sendTile = entry => {
      const hdrs = { ...cors, 'x-content-type-options': 'nosniff', 'content-type': entry.ct, 'cache-control': cc, etag: entry.etag };
      if (req && req.headers && req.headers['if-none-match'] === entry.etag) {
        res.writeHead(304, hdrs);
        return res.end();
      }
      res.writeHead(entry.status, { ...hdrs, 'content-length': entry.buf.length });
      res.end(entry.buf);
    };
    const hit = ttTileCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TT_TILE_TTL) {
      ttTileCache.delete(cacheKey); ttTileCache.set(cacheKey, hit);
      METRICS.cacheHits++;
      return sendTile(hit);
    }
    const p = paths[normKind];
    let inflight = ttTileBusy.get(cacheKey);
    if (!inflight) {
      inflight = (async () => {
        const host = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 4)] + '.api.tomtom.com';
        const url = 'https://' + host + p + '?key=' + encodeURIComponent(TOMTOM_KEY);
        const { r } = await mediaGet(url, 12000, {}, ttHostOK);
        const buf = await mediaBody(r, 2 << 20);
        const entry = {
          status: r.status,
          ct: r.headers.get('content-type') || 'image/png',
          buf,
          etag: 'W/"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 14) + '"',
          at: Date.now()
        };
        if (r.ok && buf.length > 0) ttTileSet(cacheKey, entry);
        return entry;
      })().finally(() => ttTileBusy.delete(cacheKey));
      ttTileBusy.set(cacheKey, inflight);
    }
    try {
      const entry = await inflight;
      return sendTile(entry);
    } catch (e) {
      res.writeHead(/terlalu besar/.test(e && e.message) ? 413 : 502, cors);
      return res.end();
    }
  }

  return {
    ttHas,
    ttFlow,
    ttIncidents,
    ttRoute,
    ttTileCache,
    ttTileBytes,
    ttTile,
  };
}

module.exports = { createTomTomService };
