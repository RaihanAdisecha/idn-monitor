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

  // National power centers & political palace POI vs generic village disambiguation
  assert.equal(GEO.locate('gibran dimakzulkan di istana')?.name, 'Istana Merdeka');
  assert.equal(GEO.locate('Massa Demonstran Segel Istana Wapres Gibran')?.name, 'Istana Merdeka');
  assert.equal(GEO.locate('Demo di DPR Tuntut Batalkan Revisi UU')?.name, 'DPR / MPR Senayan');
  assert.equal(GEO.locate('Aksi Buruh di Depan Gedung MK')?.name, 'Mahkamah Konstitusi');
  assert.equal(GEO.locate('Kebakaran di Istana Maimun Medan')?.name, 'Istana Maimun');
  assert.equal(GEO.locate('Demonstrasi di depan Istana Bogor')?.name, 'Istana Bogor');
  assert.equal(GEO.locate('Warga Desa Istana di Ketapang unjuk rasa')?.name, 'Desa Istana');
  assert.equal(GEO.locate('Warga Desa Istana di Ketapang unjuk rasa')?.prov, 'Kalimantan Barat');
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
  assert.ok(html.includes('.soc-tabs::after{') && html.includes('left:calc(var(--tw) - var(--cant));width:var(--cant);'), 'seam line must sit exactly over the canted joint');
  assert.ok(html.includes('#tab-x,#tab-th{width:var(--tw);flex:none}'), 'both tabs must share one fixed width');
  assert.ok(html.includes('clip-path:polygon(0 0, 100% 0, calc(100% - var(--cant)) 100%, 0 100%);'), 'tab-x must have canted clip path');
  assert.ok(html.includes('clip-path:polygon(var(--cant) 0, 100% 0, 100% 100%, 0 100%);'), 'tab-th must have matching canted clip path');

  // Verify xmeta/tmeta removed from visual presentation
  assert.ok(html.includes('#xmeta,#tmeta{display:none!important}'), 'xmeta and tmeta must be hidden from display');
  assert.ok(!html.includes('id="xcount"') && !html.includes('id="tcount"'), 'social tabs must not render post counts');
  assert.ok(html.includes('.soc-tab .ic{\n  position:absolute;'), 'tab logo must sit absolutely behind the label');
  assert.ok(html.includes('.soc-tab .tx{position:relative;z-index:1;'), 'tab label must stack above the logo');
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

test('breaking ticker uses a fixed column grid, canted telemetry blades and a fading gutter mark instead of animation slop', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // grid kolom tetap: kotak ikon, waktu, judul fleksibel, sumber
  assert.ok(html.includes('grid-template-columns:var(--tk-box) var(--tk-tm) minmax(0,1fr) var(--tk-src);'), 'ticker item must use the fixed four-column grid');
  assert.ok(html.includes('--tk-ic:14px;--tk-box:30px;--tk-tm:38px;--tk-src:76px;--tk-gap:10px;'), 'ticker column tokens must be declared once on .ticker');
  assert.ok(html.includes('height:var(--tick);padding:0 6px 0 0;'), 'item must have zero left padding so the icon box hugs the left edge');

  // ornamen bergerak yang dibuang
  assert.ok(!html.includes('tk-sheen'), 'shimmer sheen must not exist');
  assert.ok(!html.includes('tk-laser') && !html.includes('tk-newflash') && !html.includes('tkpulse'), 'laser, flash and pulse animations must not exist');
  assert.ok(!html.includes('drop-shadow(0 0 4px rgba(241,194,27'), 'category glyphs must not glow');

  // ikon kategori murni berwarna tanpa background container box
  assert.ok(html.includes('.tk-mk{') && html.includes('background:none;border:none'), 'icon container must have no background box or border');
  assert.ok(html.includes('color:var(--cat,#8a8a94)'), 'glyph itself must be colored by category token');
  assert.ok(!html.includes('.tk-mk::after{'), 'the 2px underline mark must be gone');
  assert.ok(html.includes('class="tk-mk"><svg class="ic tk-sig"'), 'renderTk must wrap the glyph in .tk-mk');

  // item baru: gutter mark yang padam, bukan background flash
  assert.ok(html.includes('.tk.tk-new::before{') && html.includes('animation:tk-mark 6s linear forwards'), 'new items must use a self-extinguishing gutter mark');
  assert.ok(html.includes('@media (prefers-reduced-motion:reduce){.tk.tk-new::before{animation:none}}'), 'gutter mark must respect reduced motion');

  // marquee polos: item dipisah teks ///, tanpa kartu diagonal/clip-path sama sekali
  assert.ok(!html.includes('.tk-bg{') && !html.includes('--tk-cant'), 'canted card layer must be gone');
  assert.ok(html.includes('.tk-sep{') && html.includes('///'), 'ticker items must be separated by /// text');
  assert.ok(!html.includes('.tk::after{'), 'ticker item must not render a diagonal blade');
  const tkRule = html.match(/\.tk\{[^}]*\}/)[0];
  assert.ok(!/border-(left|right)/.test(tkRule), 'ticker item must have border-left and border-right removed');
  assert.ok(!html.includes('clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);'), 'LIVE chip must not be canted');
  assert.ok(html.includes('.hdr{') && html.includes('background:#151514;'), 'top header nav must use #151514 background');

  // hover tanpa efek menyala: no background/opacity/color lift
  assert.ok(!html.includes('.tk:hover{') && !html.includes('.tk:hover .tk-mk') && !html.includes('.tk:hover .tk-time'), 'ticker must not brighten on hover');
  assert.ok(html.includes('.tk:hover .tk-t{text-decoration:underline'), 'hover cue must be a neutral underline');

  // sinyal update tanpa shimmer: counter statis di chip LIVE
  assert.ok(html.includes('class="tk-fresh"'), 'new item count must render statically inside the LIVE chip');
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

test('Detail situasi uses Opsi 01 telemetry deck with Opsi 02 category label, full-width source tab switcher, and 10-cell canted individual bars in Wilayah tab', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Category icon (.tr-ic) + Opsi 02 category header label (.tr-sev-cat + .tr-loc-tag) inside alertHtml
  assert.ok(html.includes('<svg class="ic tr-ic ${c.cat}" aria-hidden="true"><use href="${TK_SIG[c.cat] || \'#i-pin\'}"></use></svg>') && html.includes('class="tr-sev-cat ${c.cat}"'), 'alertHtml must use category SVG icon and unified sev-cat label');
  assert.ok(!html.includes('class="tr-dot'), 'alertHtml must not use pulse dot instead of category icon');
  assert.ok(html.includes('<span class="tr-loc-tag">${esc(c.place)}</span>'), 'alertHtml must render location tag in header');

  // 2. Opsi 01 dual-channel pills joined inside .tr-pills with transparent bg & diagonal separator, plus full-width segmented source tab switcher
  assert.ok(html.includes('<div class="tr-pills">') && html.includes('class="tr-pill soc"') && html.includes('class="tr-pill news"'), 'alertHtml must render SOSIAL and BERITA inside unified .tr-pills container');
  assert.ok(html.includes('.tr-pill+.tr-pill::before{') && html.includes('background:transparent;border:0;color:var(--text3)'), '.tr-pill must have transparent background and diagonal separator');
  assert.ok(html.includes('class="tr-tabs" role="tablist"') && html.includes('data-lane="soc"') && html.includes('data-lane="news"'), 'lanesHtml must render full-width segmented tab switcher for dual-source signals');

  // 3. Wilayah stays in its own separate tab (#view-krono) and uses 10-cell canted individual bars
  assert.ok(html.includes('<div id="view-krono" hidden><div class="sit-regions" id="sit-regions"></div></div>'), 'Wilayah must remain in its own separate #view-krono tab');
  assert.ok(html.includes('.sr-t{display:grid;grid-template-columns:repeat(10,1fr);gap:2.5px;height:6px;align-items:center}') && html.includes('transform:skewX(-18deg)'), 'Wilayah meter must use 10-cell canted individual bars');
  assert.ok(html.includes("Array.from({ length: 10 }, (_, k) => `<i${k < lit ? ' class=\"on\"' : ''}></i>`).join('')"), 'renderSituation must generate 10 discrete bar elements per region');
});

test('cl-toasts implements front-anchored 3D deck stack with strict non-independent sequential front countdown', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Front-anchored grid stack CSS: all cards share grid-area:1/1 and recede upwards via negative --depth
  assert.ok(html.includes('grid-area:1/1;') && html.includes('transform:translate3d(0,calc(var(--depth,0) * -14px),0) scale(calc(1 - var(--depth,0) * .045))'), 'cl-toast must use grid-area:1/1 and negative --depth 3D deck transform peaking at top');
  assert.ok(html.includes('.cl-toasts:not(.open) .cl-toast[data-front="false"]'), 'back cards in stack must be styled and pointer-guarded via data-front="false"');

  // 2. Batch mount order mounts oldest first and newest last so latest card sits at front (--depth:0)
  assert.ok(html.includes('else [...cards].reverse().forEach(clToastCard);'), 'noteWire must mount batch cards in reverse so latest card is at front of deck');

  // 3. clToastSyncZ computes depth = total - 1 - idx and marks front card
  assert.ok(html.includes('const depth = total - 1 - idx;') && html.includes("c.dataset.front = depth === 0 ? 'true' : 'false';"), 'clToastSyncZ must assign --depth and data-front from newest to oldest');

  // 4. clToastPromote parks previous active card in back at 100% (no 1200ms background auto-dismiss)
  assert.ok(!html.includes('st.left = 1200;'), 'clToastPromote must not cut previous card timer to 1200ms in the background');
  assert.ok(html.includes('st.left = CL_TTL; st.t0 = 0; st.barPct = 100;') && html.includes('clToastPaintSegs(cur, 100);'), 'clToastPromote must reset stepped-back card to full CL_TTL waiting state');

  // 5. clToastOut adds .k-out before syncing Z-depth and activating the next card sequentially
  const outIdx = html.indexOf('function clToastOut(el){');
  const outBlock = html.slice(outIdx, outIdx + 600);
  assert.ok(outBlock.indexOf("el.classList.add('k-out')") < outBlock.indexOf('clToastSyncZ()') && outBlock.indexOf('clToastSyncZ()') < outBlock.indexOf('clToastActivate()'), 'clToastOut must mark .k-out then sync Z-depth and activate the next card sequentially');
});

test('mobile market header hides secondary schedule and emiten/sync without ellipsis truncation', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. idxSession provides structured short label and optional sub schedule
  assert.ok(html.includes("short: 'Pasar Tutup', sub: ' · Buka Besok 09:00'") && html.includes("short: 'Pra-pasar'"), 'idxSession must split primary state from secondary schedule detail');

  // 2. renderChips isolates primary state in .mkt-pill-t and secondary schedule in .mkt-pill-sub
  assert.ok(html.includes('<span class="mkt-pill-t">${ses.short}</span>') && html.includes('<span class="mkt-pill-sub">${ses.sub}</span>'), 'renderChips must wrap short label and sub schedule in distinct elements');

  // 3. Mobile CSS hides .stk-meta-x, .mkt-pill-sub, clears ghost margin-right, and frees max-width
  assert.ok(html.includes('.mkt-pill{margin-right:0}') && html.includes('.mkt-pill-sub{display:none}') && html.includes('.stk-meta-x{display:none}'), 'mobile CSS must hide secondary schedule and emiten/sync without trailing margin');
  assert.ok(html.includes('.pane.mkt .ph-m{max-width:none}'), 'mobile CSS must remove artificial 58% max-width cap from market pane header meta');
});

test('globe focus & alert toast pipeline enforces camera override, home return and dedupe stability', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. doFocus overrides active dragging/gestures
  assert.ok(html.includes('ptrs.clear();') && html.includes('gesture = null;') && html.includes('globeVel = null;'), 'doFocus must reset active pointers, gesture and inertia so breaking focus takes over camera cleanly');

  // 2. Breaking queue is not blocked by user gesture idle cooldown
  const maybeFocusIdx = html.indexOf('function maybeFocusFresh(){');
  const maybeFocusBlock = html.slice(maybeFocusIdx, maybeFocusIdx + 3500);
  assert.ok(maybeFocusBlock.indexOf('if (!alertActive && focusQueue.length)') !== -1 &&
            maybeFocusBlock.indexOf('if (!alertActive && focusQueue.length)') < maybeFocusBlock.indexOf('if (performance.now() - lastGestEnd < 25000) return;'), 'focusQueue breaking events must take precedence before gesture idle check');

  // 3. Queue amnesia and infinite rotation loops eradicated
  assert.ok(!maybeFocusBlock.includes('seenIds.delete(qid);'), 'maybeFocusFresh must not delete seenIds when candidate drops temporarily');
  assert.ok(!maybeFocusBlock.includes('rotSeen.clear();'), 'maybeFocusFresh must not clear rotSeen to prevent 8-minute infinite repeat loops');

  // 4. hideSitAlert returns to HOME_VIEW default zoom or processes next queue item
  const hideIdx = html.indexOf('function hideSitAlert(){');
  const hideBlock = html.slice(hideIdx, hideIdx + 800);
  assert.ok(hideBlock.includes('maybeFocusFresh();') && hideBlock.includes('flyTo(HOME_VIEW.lat, HOME_VIEW.lon, HOME_VIEW.zoom, \'home\');'), 'hideSitAlert must advance queue or return to HOME_VIEW default zoom upon alert completion');

  // 5. BMKG disaster ID is magnitude-independent
  assert.ok(html.includes("const key = (g.time || gts || '') + '|' + g.lat.toFixed(2) + ',' + g.lon.toFixed(2);"), 'BMKG quake key must depend only on time and coordinates, not magnitude');
  assert.ok(html.includes("eid: 'bmkg:gempa:' + key,"), 'BMKG disaster items must assign a stable eid');

  // 6. cl-toasts card click flies to location if coordinates exist
  assert.ok(html.includes("if (!closeBtn && frontCard.dataset.la && frontCard.dataset.lo)"), 'cl-toasts card click must fly camera to incident coordinates when present');
});

test('demo detection, geocoding and social orchestration pipeline fixes', () => {
  const GEO = require('../geocode');
  const ASSESS = require('../assessment');
  const SOC = require('../social');
  const fs = require('fs');
  const path = require('path');
  const serverCode = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Geocode: Polda Metro Jaya does not reject valid location; Tugu Tani resolved
  const tuguTani = GEO.locate('Polda Metro Jaya Siapkan Pengamanan Demo di Tugu Tani');
  assert.ok(tuguTani, 'Headline mentioning Polda Metro Jaya and Tugu Tani must resolve');
  assert.equal(tuguTani.name, 'Tugu Tani');
  assert.equal(tuguTani.prec, 'poi');
  assert.equal(tuguTani.la, -6.1834);
  assert.equal(tuguTani.lo, 106.8339);

  // 2. Geocode: Istana disambiguation avoids Desa Istana in Riau
  const istana = GEO.locate('Gibran dimakzulkan di Istana');
  assert.ok(istana, 'Istana headline must resolve to Istana Merdeka POI');
  assert.equal(istana.name, 'Istana Merdeka');
  assert.equal(istana.prec, 'poi');

  // 3. Assessment: Demo mobilization verbs qualify as signalEligible demo events
  const demoNews = ASSESS.assess('Antisipasi Demo 10 November di DPR RI, Polda Metro Jaya Kerahkan Ribuan Personel', SOC.SOC_TOPICS);
  assert.ok(demoNews.topics.includes('demo'), 'Must include demo topic');
  assert.equal(demoNews.signalEligible, true, 'Security mobilization for demo must be signalEligible');
  assert.ok(demoNews.events.some(e => e.category === 'demo' && e.location && e.location.name.includes('DPR')), 'Event must be anchored to DPR');

  // 4. Metaphor & Listing shielding: Real-estate listing does not trigger flood incident
  const adText = 'Rumah Dijual di Sentul Cluster Bebas Banjir DP 0% Cicilan KPR Murah';
  const adResult = SOC.socAssess(adText);
  assert.equal(adResult.signalEligible, false, 'Property listing cannot be signalEligible');
  assert.equal(adResult.events.length, 0, 'Property listing must have 0 events');

  // 5. Server: DEFAULT_TH_WATCH restricts to emergency authorities; media blacklist active
  assert.ok(serverCode.includes("DEFAULT_TH_WATCH = ['infobmkg', 'bnpb_indonesia']"), 'DEFAULT_TH_WATCH must contain only crisis authorities');
  assert.ok(serverCode.includes('TH_MEDIA_BLACKLIST'), 'server.js must define TH_MEDIA_BLACKLIST');

  // 6. Server: newsKeywords and synthQueries enforce Compound Crisis Anchoring & negative filters
  assert.ok(serverCode.includes('-dijual -kpr -rumah -sewa -properti -cluster'), 'X queries must include negative real-estate filters');

  // 7. Frontend: CAT_SKIP does not suppress demo titles
  assert.ok(html.includes('const isDemo = CAT_RE.demo && CAT_RE.demo.test(t);') && html.includes('if (CAT_SKIP.test(t) && !isDemo) return \'\';'), 'Frontend catOfTitle must preserve demo categories');

  // 8. 24h Hybrid Trending: newsTopicHeat covers 24h, buildTrends produces rank & pct, frontend maps telemetry
  assert.ok(serverCode.includes('now - it.ts > 24 * 3600e3'), 'newsTopicHeat must inspect full 24h window');
  assert.ok(serverCode.includes('Math.round(item.score * 20 + 50)'), 'buildTrends must calculate surge percentage');
  assert.ok(html.includes('socTrends = new Map(d.trends.map(t => [t.id, t]))'), 'frontend must ingest d.trends for telemetry chips');
  assert.ok(html.includes('hot-both'), 'frontend CSS/HTML must support hybrid hot-both and hot-wire badges');
});

test('05 CCTV regional citybar uses Swiss Index Register with canted diagonal shingle blades, zero pill slop, and tabular count', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Grid & layout: flush register bar docked directly above camgrid with zero outer margin/padding and hairline bottom
  assert.ok(html.includes('.citybar{') && html.includes('padding:0;margin:0;'), 'citybar must be flush with zero outer margin and padding');
  assert.ok(html.includes('border-bottom:1px solid rgba(255,255,255,.08);'), 'citybar must have a subtle hairline bottom border');

  // 2. Canted diagonal shingle blades: diagonal right on each item, except last child which terminates flat
  assert.ok(html.includes('--cant:10px;'), 'citybar must declare cant token');
  assert.ok(html.includes('.cb:first-child{') && html.includes('clip-path:polygon(0 0, 100% 0, calc(100% - var(--cant)) 100%, 0 100%);'), 'first tab must be flat left, canted right');
  assert.ok(html.includes('.cb:not(:first-child):not(:last-child){') && html.includes('clip-path:polygon(var(--cant) 0, 100% 0, calc(100% - var(--cant)) 100%, 0 100%);'), 'middle tabs must be canted left and canted right');
  assert.ok(html.includes('.cb:last-child{') && html.includes('clip-path:polygon(var(--cant) 0, 100% 0, 100% 100%, 0 100%);'), 'last tab must be canted left and flat right (except paling terakhir)');
  assert.ok(html.includes('.cb:not(:last-child)::before{') && html.includes('linear-gradient(to bottom right,'), 'diagonal seam hairline must match cant angle via to bottom right');
  assert.ok(html.includes('.cb .cb-name{font:500 11px/1 var(--disp);letter-spacing:-.01em}'), 'city name must use display typography');

  // 3. Technical index prefix: micro mono with // delimiter
  assert.ok(html.includes('.cb .cb-idx{') && html.includes('var(--mono)'), 'index prefix must use mono font');
  assert.ok(html.includes('.cb .cb-idx::after{content:"//";'), 'index prefix must render technical // delimiter');

  // 4. Tabular metadata count: naked numbers without rounded pill badge background
  assert.ok(html.includes('.cb .cb-n{') && html.includes('font-variant-numeric:tabular-nums;'), 'count must use tabular numbers');
  assert.ok(!html.includes('background:var(--layer2);border-radius:8px'), 'pill badge slop must be eradicated');

  // 5. Active state: bottom shelf lock indicator with crisp hairline and tonal fill
  assert.ok(html.includes('.cb[aria-selected="true"]{') && html.includes('box-shadow:inset 0 -2px 0 #f4f4f7;'), 'active tab must feature bottom shelf lock indicator');
  assert.ok(html.includes('.cb[aria-selected="true"]{') && html.includes('background:rgba(255,255,255,.05);'), 'active tab must have subtle tonal fill');

  // 6. drawCityBar builder markup: injects cb-idx, cb-name, and cb-n
  assert.ok(html.includes('<span class="cb-idx">${num}</span>'), 'drawCityBar must render cb-idx span');
  assert.ok(html.includes('<span class="cb-name">${esc(d)}</span>'), 'drawCityBar must render cb-name span');
  assert.ok(html.includes('<span class="cb-n">${n}</span>'), 'drawCityBar must render cb-n span');
});
