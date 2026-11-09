'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WireCore = require('../public/wire-core');
const GEO = require('../geocode');
const EVMERGE = require('../evmerge');
const FEEDTEXT = require('../feedtext');
const ASSESS = require('../assessment');
const SOC = require('../social');
const SIGNALS = require('../public/signals');

test('WireCore.prepare preserves publisher/url alignment while adopting longer desc', () => {
  const now = 1_700_000_000_000;
  const items = [
    { title: 'Banjir Rendam Bekasi Hari Ini', url: 'https://detik.com/1', pub: 'Detik', src: 'DETIK', desc: 'Pendek', ts: now - 10_000 },
    { title: 'Banjir Rendam Bekasi Hari Ini!', url: 'https://kompas.com/2', pub: 'Kompas', src: 'KOMPAS', desc: 'Deskripsi jauh lebih panjang dari artikel kedua', img: 'https://img/k.jpg', ts: now - 60_000 },
  ];
  const out = WireCore.prepare(items, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://detik.com/1');
  assert.equal(out[0].pub, 'Detik');
  assert.equal(out[0].src, 'DETIK');
  assert.equal(out[0].desc, 'Deskripsi jauh lebih panjang dari artikel kedua');
  assert.equal(out[0].img, 'https://img/k.jpg');
});

test('geocode blocks generic village/ibukota hijacks and resolves Province/POI accurately', () => {
  assert.equal(GEO.locate('Helikopter jatuh di hutan'), null);
  assert.equal(GEO.locate('Anggaran negara untuk pendidikan'), null);
  assert.equal(GEO.locate('Warga berkumpul di lapangan'), null);
  assert.equal(GEO.locate('Kebakaran di Kelantan Malaysia'), null);

  const jambi = GEO.locate('Banjir di Provinsi Jambi');
  assert.ok(jambi);
  assert.equal(jambi.prec, 'prov');
  assert.equal(jambi.prov, 'Jambi');

  const boyolali = GEO.locate('Demo mahasiswa di Simpang Lima Boyolali');
  assert.ok(boyolali);
  assert.match(boyolali.name, /Boyolali/);

  const pg = GEO.locate('Banjir di Pondok Gede');
  assert.ok(pg);
  assert.equal(pg.prov, 'Jawa Barat');
});

test('evmerge preserves shared incident tokens across large single-city cluster', () => {
  const now = 1_700_000_000_000;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    kind: 'kebakaran',
    place: 'Jakarta Selatan',
    prov: 'DKI Jakarta',
    la: -6.26,
    lo: 106.81,
    prec: 'kab',
    title: `Kebakaran Depo Pertamina Plumpang Jakarta Selatan laporan ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    src: `SRC${i + 1}`,
    ts: now - i * 60_000,
  }));
  const merged = EVMERGE.mergeEvents(rows);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].n, 12);
});

test('feedtext preserves video amatir in prose and handles Indonesian rank abbreviations', () => {
  const cleaned = FEEDTEXT.descFrom({ description: 'Polisi memeriksa video amatir yang merekam detik-detik kejadian kecelakaan tersebut di jalan raya.' }, '');
  assert.match(cleaned, /video amatir/i);

  const lede = FEEDTEXT.descFrom({ contentEncoded: '<p>Kombes. Pol. Budi Santoso mengatakan pelaku sudah ditangkap di Bekasi tadi malam oleh tim gabungan.</p>' }, '');
  assert.match(lede, /Kombes\. Pol\. Budi Santoso/);
});

test('assessment links multiline Threads location and blocks Malaysian states', () => {
  const th = SOC.socAssess('Innalillahi, siswa SMK 7 Semarang\nMeninggal kecelakaan\nDi lemah Abang semarang');
  assert.equal(th.signalEligible, true);
  assert.equal(th.scope, 'Indonesia');
  assert.ok(th.events.some(e => e.location && /Semarang/i.test(e.location.name)));

  const my = SOC.socAssess('Kebakaran besar melanda kawasan perumahan di Kelantan petang tadi');
  assert.equal(my.scope, 'foreign');
  assert.equal(my.signalEligible, false);

  const ent = SOC.socAssess('Kecelakaan beruntun terjadi di Tol Cipularang &amp; jalur arah Bandung macet parah');
  assert.ok(ent.events.length >= 1);
  assert.ok(!ent.events[0].evidence.includes('&amp'));
});

test('signals matches rare specific events with 1 shared specific token', () => {
  const v = SIGNALS.VERSION;
  const a = {
    category: 'bencana',
    type: 'earthquake',
    scope: 'Indonesia',
    reportType: 'reported',
    signalEligible: true,
    severity: 'critical',
    location: { name: 'Kab. Cianjur', prov: 'Jawa Barat', prec: 'kab' },
    evidence: 'Gempa magnitudo mengguncang Cugenang Cianjur',
    version: v,
  };
  const b = {
    category: 'bencana',
    type: 'earthquake',
    scope: 'Indonesia',
    reportType: 'reported',
    signalEligible: true,
    severity: 'critical',
    location: { name: 'Kab. Cianjur', prov: 'Jawa Barat', prec: 'kab' },
    evidence: 'Warga Cugenang panik saat gempa bumi',
    version: v,
  };
  assert.equal(SIGNALS.relation(a, b), 'strong');
  assert.equal(SIGNALS.matches(a, b), true);
});

test('news source labels strip category suffixes and preserve clean outlets', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('const cleanSrc ='), 'index.html must define cleanSrc helper');

  // Extract cleanSrc implementation directly from index.html to verify client behavior
  const m = html.match(/const cleanSrc = \(([\s\S]*?\n\};)/);
  assert.ok(m, 'cleanSrc must be extracted');
  const cleanSrcFn = new Function('tkPub', 'return ' + m[0].replace(/^const cleanSrc =/, ''));
  const tkPub = v => {
    v = String(v || '').trim();
    if (/^(https?:)?\/\//i.test(v) || /^www\./i.test(v)) {
      try { return new URL(/^www\./i.test(v) ? 'https://' + v : v).hostname.replace(/^www\./i, ''); } catch (e) { return ''; }
    }
    return v;
  };
  const cleanSrc = cleanSrcFn(tkPub);

  assert.equal(cleanSrc('GNEWS · KESEHATAN'), 'GNEWS');
  assert.equal(cleanSrc('GNEWS · KERACUNAN'), 'GNEWS');
  assert.equal(cleanSrc('GNEWS · BANJIR'), 'GNEWS');
  assert.equal(cleanSrc('GNEWS · DEMO'), 'GNEWS');
  assert.equal(cleanSrc('GNEWS · KESEHATAN', 'Kompas.com'), 'Kompas.com');
  assert.equal(cleanSrc('GNEWS · KERACUNAN', 'https://detik.com/read/123'), 'detik.com');
  assert.equal(cleanSrc('ANTARA · KESEHATAN'), 'ANTARA');
  assert.equal(cleanSrc('ANTARA'), 'ANTARA');
  assert.equal(cleanSrc('DETIK'), 'DETIK');
  assert.equal(cleanSrc('TEMPO'), 'TEMPO');
  assert.equal(cleanSrc('CNN INDONESIA'), 'CNN INDONESIA');
});

test('tweet card action bar mirrors threads layout with clustered spacing, share icon and right-aligned X mark', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify CSS definitions for .tw-a
  assert.ok(html.includes('.tw-a{display:flex;align-items:center;gap:4px;margin-top:12px;margin-left:-7px}'), 'tw-a must use tight 4px gap and negative margin matching th-a');
  assert.ok(html.includes('.tw-mark{margin-left:auto;'), 'tw-mark must push X logo to right via margin-left:auto');
  assert.ok(html.includes('.tw-mark .ic{width:13px;height:13px}'), 'tw-mark icon must have 13px size matching th-mark');

  // Verify tweetCard markup structure
  assert.ok(html.includes('class="tw-share"') && html.includes('${I.share}'), 'tw-a must include share icon');
  assert.ok(html.includes('<span class="tw-mark" title="X">${I.x}</span>'), 'tw-a must include X brand mark');
  assert.ok(html.includes('<span class="tw-reply">'), 'tw-a must have tw-reply class');
  assert.ok(html.includes('<span class="tw-rt">'), 'tw-a must have tw-rt class');
  assert.ok(html.includes('<span class="tw-like">'), 'tw-a must have tw-like class');
  assert.ok(html.includes('<span class="tw-views">'), 'tw-a must have tw-views class');
});

test('social pane tabs use canted twin blades diagonal divider with far-right alignment and hidden xmeta', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify .soc-tabs positioned on far right via margin-left: auto and styling
  assert.ok(html.includes('margin-left:auto;') && html.includes('position:relative;'), 'soc-tabs must align to the far right with margin-left: auto');
  assert.ok(html.includes('#tab-x::after{') && html.includes('right:0;bottom:0;width:1.5px;'), 'tab-x must have diagonal divider pseudo-element');
  assert.ok(html.includes('transform-origin:100% 0;transform:skewX(-18deg);pointer-events:none;'), 'diagonal divider must use top-right origin and matching -18deg skew to prevent cutoff');
  assert.ok(html.includes('clip-path:polygon(0 0, 100% 0, calc(100% - 12px) 100%, 0 100%);'), 'tab-x must have canted clip path');
  assert.ok(html.includes('clip-path:polygon(12px 0, 100% 0, 100% 100%, 0 100%);'), 'tab-th must have matching canted clip path');

  // Verify xmeta/tmeta removed from visual presentation
  assert.ok(html.includes('#xmeta,#tmeta{display:none!important}'), 'xmeta and tmeta must be hidden from display');
  assert.ok(html.includes('.soc-tab[aria-selected="true"] b{color:#e0e0ea;font-weight:600}'), 'active tab number must be bright light gray, not red');
});

test('in-app reader media uses adaptive mosaic grid classes and bounded layout', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify CSS mosaic rules
  assert.ok(html.includes('.rd-media.rd-m-1{grid-template-columns:1fr;max-height:280px}'), 'rd-m-1 must use single column with max-height');
  assert.ok(html.includes('.rd-media.rd-m-2{grid-template-columns:1fr 1fr;height:210px}'), 'rd-m-2 must use 50/50 split with bounded height');
  assert.ok(html.includes('.rd-media.rd-m-3{grid-template-columns:1.6fr 1fr;'), 'rd-m-3 must use hero left + flank right stack');
  assert.ok(html.includes('.rd-media.rd-m-4{grid-template-columns:1fr 1fr;'), 'rd-m-4 must use 2x2 grid');

  // Verify JS generation of rd-m-*
  assert.ok(html.includes('class="rd-media rd-m-${mCount}"'), 'rdPost must attach dynamic rd-m-${mCount} class to media container');
});

test('cl-toasts overlay is decoupled from collapsed panes and guarded for mobile touch countdown', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. cl-toasts is outside .sit-body (top-level after </main>)
  const mainEnd = html.indexOf('</main>');
  const clToastsMarkup = html.indexOf('<div class="cl-toasts" id="cl-toasts"');
  assert.ok(mainEnd > 0 && clToastsMarkup > mainEnd, 'cl-toasts must be positioned as a top-level overlay outside </main>');
  assert.ok(!html.slice(html.indexOf('<div class="pb sit-body">'), mainEnd).includes('id="cl-toasts"'), 'cl-toasts must not be inside .sit-body');

  // 2. CSS mobile positioning uses calculated header + ticker offset
  assert.ok(html.includes('.cl-toasts{left:10px;right:10px;top:calc(var(--hdr) + var(--tick) + 8px);align-items:center}'), 'mobile cl-toasts top must clear header and ticker');

  // 3. Desktop hover/focus trap is guarded with fine pointer query
  assert.ok(html.includes("matchMedia('(hover:hover) and (pointer:fine)').matches"), 'hover listeners must check for fine pointer to prevent mobile sticky pause');

  // 4. Mobile touch listeners support press-and-hold pause and release resume
  assert.ok(html.includes("clToastsEl.addEventListener('touchstart'"), 'cl-toasts must listen for touchstart');
  assert.ok(html.includes("clToastsEl.addEventListener('touchend'"), 'cl-toasts must listen for touchend');
  assert.ok(html.includes("clToastsEl.addEventListener('touchcancel'"), 'cl-toasts must listen for touchcancel');

  // 5. Mount height has defensive fallback
  assert.ok(html.includes('const h = el.offsetHeight || 68;'), 'clToastMount must have fallback height');
});

test('incident map popups for hotspot and air quality use structured split KPI hero layout', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify CSS for split KPI hero cards
  assert.ok(html.includes('.mp-kpi-card{display:flex;flex-direction:column;gap:6px;min-width:210px;max-width:275px}'), 'must define mp-kpi-card container');
  assert.ok(html.includes('.mp-kpi-body{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;align-items:stretch}'), 'must define 2-column split hero layout');
  assert.ok(html.includes('.mp-kpi-val{'), 'must define mp-kpi-val typography');

  // Verify Hotspot popup implementation (SiPongi & NASA FIRMS)
  assert.ok(html.includes('<div class="mp-kpi-card" style="--kpi-c:${col}">') && html.includes('HOTSPOT · SIPONGI KEMENHUT'), 'SiPongi hotspot must use split KPI layout');
  assert.ok(html.includes('HOTSPOT · NASA FIRMS') && html.includes('Titik Api Karhutla'), 'NASA FIRMS hotspot must use split KPI layout');

  // Verify Air Quality popup implementation (AQMS)
  assert.ok(html.includes('KUALITAS UDARA · AQMS KLHK') && html.includes('<span class="mp-kpi-sub">ISPU</span>'), 'AQMS air quality must use split KPI layout with ISPU hero metric');
});

test('incident map popups remove redundant close button', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify close button is hidden via CSS
  assert.ok(html.includes('#map .leaflet-popup-close-button{display:none!important}'), 'popup close button must be hidden via CSS display:none');
  // Verify fireHitTest sets closeButton: false
  assert.ok(html.includes('L.popup({ closeButton: false, maxWidth: 340 })'), 'fireHitTest popup must set closeButton: false');
});

test('earthquake incident map popups use dual-metric tactical HUD with container accent background', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Verify CSS definition for dual-metric HUD
  assert.ok(html.includes('.mp-hud-card{display:flex;flex-direction:column;gap:6px;min-width:220px;max-width:285px}'), 'must define mp-hud-card container');
  assert.ok(html.includes('.mp-hud-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}'), 'must define 2-column grid for metrics');
  assert.ok(html.includes('.mp-hud-box{') && html.includes('background:color-mix(in srgb,var(--box-c,#ffffff) 10%,#101016);'), 'mp-hud-box must use container accent background');
  
  // 2. Verify NO colored left border on mp-hud-box
  assert.ok(!html.includes('.mp-hud-box{border-left') && !html.includes('mp-hud-box" style="border-left'), 'mp-hud-box must not use colored left border');

  // 3. Verify BMKG gempa popup builder uses dual metrics and tsunami ribbon
  assert.ok(html.includes('GEMPA BUMI · BMKG') && html.includes('class="mp-hud-card"'), 'BMKG gempa must render mp-hud-card');
  assert.ok(html.includes('mp-hud-box" style="--box-c:${magCol}"') && html.includes('MAGNITUDE'), 'BMKG gempa must render magnitude hero box');
  assert.ok(html.includes('mp-hud-box" style="--box-c:${depCol}"') && html.includes('KEDALAMAN'), 'BMKG gempa must render depth hero box');
  assert.ok(html.includes('mp-hud-banner banner-safe') && html.includes('TIDAK BERPOTENSI TSUNAMI'), 'BMKG gempa must render tsunami status banner');
});

test('traffic incident popups use Opsi 1 Telemetry Runway Strip with crowdsource report bar and route vector', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Verify CSS classes for Telemetry Runway Strip
  assert.ok(html.includes('.tt-corr-card{display:flex;flex-direction:column;gap:7px;min-width:240px;max-width:320px}'), 'must define tt-corr-card container');
  assert.ok(html.includes('.tt-runway{') && html.includes('.tt-chamber:first-child{border-right:1px dashed rgba(255,255,255,.12)}'), 'must define docked dual-chamber runway');
  assert.ok(html.includes('.tt-report-strip{'), 'must define dedicated crowdsource report bar');
  assert.ok(html.includes('.tt-corridor{'), 'must define linear corridor vector container');

  // Verify ttIncPopup implementation
  assert.ok(html.includes('class="tt-corr-card"') && html.includes('class="tt-runway"'), 'ttIncPopup must render tt-corr-card and tt-runway');
  assert.ok(html.includes('DILAPORKAN:') && html.includes('class="tt-report-strip"'), 'ttIncPopup must render explicit DILAPORKAN crowdsource bar');
  assert.ok(html.includes('class="tt-corridor"') && html.includes('VEKTOR RUAS JALAN'), 'ttIncPopup must render corridor route vector');
});

test('04 News Wire keeps filter expand/unexpand drawer with command-bar input and no inner buttons', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Expand/unexpand drawer (#fltwrap, #newstools, #fltpill) is preserved
  assert.ok(html.includes('id="fltwrap"') && html.includes('id="fltpill"') && html.includes('<span class="flt-lb">filter</span>'), 'must preserve #fltwrap drawer and #fltpill filter expand/unexpand tab');

  // 2. #fq uses .inp.cmd inside .flt-in matching Social (#xq, #tq) and CCTV (#cq)
  assert.ok(html.includes('<input class="inp cmd" id="fq" type="search" placeholder="Saring berita…"'), '#fq must use class="inp cmd"');

  // 3. Inner buttons (#ontopic, #fltclear) are removed
  assert.ok(!html.includes('id="ontopic"') && !html.includes('id="fltclear"'), 'inner buttons (#ontopic, #fltclear) must be removed from news filter drawer');
});
