# Third-Party Notices & Data Provenance

SITREP incorporates or interacts with the following third-party libraries, vendored scripts, frontend CDN assets, and geospatial datasets. Keep attributions intact and verify upstream dataset terms before public redistribution.

## 1. Runtime Dependencies

- **franc** (`6.2.0`) — MIT License — Natural language detection (`package.json`).
- **curl_cffi** (`0.17.0`) — MIT License — Python libcurl FFI client for `vendor/threads_worker.py` (`requirements.txt`).

## 2. Vendored Components

- **`vendor/threads_scraper.py` (and adapter `threads_thread.py`, `threads_worker.py`)**
  - License: MIT License (`Copyright (c) 2026 ToolzerHub`), preserved verbatim in `vendor/THREADS-SCRAPER-LICENSE`.
  - Local modifications: Adapted JSON stdout worker wrapper (`threads_worker.py`, `threads_thread.py`) for SITREP backend orchestration.
- **`public/leaflet-velocity.min.js`**
  - Upstream: `leaflet-velocity` (MIT License). Used locally for wind velocity canvas rendering; inspect/replace with pinned npm/CDN integrity if customizing.

## 3. Browser CDN Assets (`public/index.html`)

Loaded dynamically at runtime in the browser:
- **Leaflet** (`1.9.4`) — BSD-2-Clause License
- **Leaflet.heat** (`0.2.0`, `simpleheat`) — BSD-2-Clause License
- **hls.js** (`1.5.13`) — Apache-2.0 License
- **Esri World Imagery / Dark Gray Base & Reference** — ArcGIS Online basemap tiles (subject to Esri Master License / attribution)

## 4. Geospatial Datasets & Satellite/Live Feeds

- **`geo/desa-kelurahan-big.json` & `scripts/build-big-village-index.js`**
  - Source: Badan Informasi Geospasial (BIG), `BATAS_DESAKEL_AR` (edition `2026-06`, captured `2026-11-07`).
  - Notice: *"BIG attribution retained. Verify current reuse and redistribution terms before public deployment."* If distributing this repository publicly without written redistribution confirmation from BIG, exclude `geo/desa-kelurahan-big.json` from your public branch and regenerate locally via `scripts/build-big-village-index.js` (`geocode.js` degrades gracefully if the file is absent).
- **`geo/gazetteer.json` & `geo/coord-fixes.json`**
  - Derived from Kepmendagri 2025 administrative hierarchy with local coordinate corrections (`scripts/geo-audit.js`).
- **`public/idn.geo.json`, `public/idn-prov.geo.json`, `public/idn-context.geo.json`, `public/world110.geo.json`**
  - Administrative boundary polygons for globe/map rendering (verify/preserve Natural Earth / GADM / national boundary provenance before commercial redistribution).
- **Copernicus Sentinel-2 L2A (`copernicus.js`)**
  - Requires attribution: *"Contains modified Copernicus Sentinel data"* when Copernicus Sentinel-2 layer is displayed.
- **External Telemetry & Feeds**
  - BMKG (earthquakes, weather, radar, warnings), PVMBG/MAGMA (volcanoes), NASA FIRMS (hotspots), TomTom (traffic tiles/incidents), OpenSky / ADSB / AISStream, and public Indonesian regional RSS/CCTV streams are subject to their respective API terms and fair-use limits.
