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
    name: 'Jakarta Selatan',
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
  assert.ok(html.includes('<svg class="ic tr-ic ${esc(c.cat)}" aria-hidden="true"><use href="${TK_SIG[c.cat] || \'#i-pin\'}"></use></svg>') && html.includes('class="tr-sev-cat ${esc(c.cat)}"'), 'alertHtml must use category SVG icon and unified sev-cat label');
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
  assert.ok(serverCode.includes("DEFAULT_TH_WATCH = ['infobmkg']"), 'DEFAULT_TH_WATCH must contain only crisis authorities');
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

test('globe mobile touch pipeline isolates overlay pointer events and enables node preview focus', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. CSS touch & coarse pointer support: sit-tip pointer-events auto on coarse screens
  assert.ok(html.includes('@media (hover:none), (pointer:coarse)'), 'sit-tip must enable pointer-events on coarse pointer / touch devices');
  assert.ok(html.includes('.pop-go{') && html.includes('pointer-events:auto;'), 'pop-go button must have explicit pointer-events auto');

  // 2. Event bleed isolation: overlays stop propagation on pointerdown/touchstart/touchend/pointerup
  assert.ok(html.includes("['pointerdown', 'touchstart', 'touchend', 'pointerup'].forEach(evt => {") &&
            html.includes('if (pop) pop.addEventListener(evt, stopGlobeBleed') &&
            html.includes('if (tip) tip.addEventListener(evt, stopGlobeBleed'),
            'pop and tip overlays must stop pointerdown/touchstart propagation to prevent canvas dismiss');

  // 3. Canvas mouseleave guard: synthetic mouseleave on touch devices must not dismiss mobile popups
  assert.ok(html.includes("if (globePtrType === 'touch' || globePtrType === 'pen') return;"),
            'canvas mouseleave must ignore touch/pen pointers to prevent premature popup destruction');

  // 4. Node tap two-step lifecycle: first tap previews node via showNodeTip, second tap focuses via flyTo
  assert.ok(html.includes('let globeActNodeKey = \'\', globeActNodeAt = 0;'), 'globeActNodeKey and timer must be declared for node tap state');
  assert.ok(html.includes('showNodeTip(e, hit.d, true);') && html.includes('globeActNodeKey = nodeKey;'),
            'first tap on node in ptrEnd must show node preview tooltip instead of immediately dismissing');

  // 5. Single popup on incident tap: mobile touch must not render conflicting overlapping tip
  const ptrEndIdx = html.indexOf('function ptrEnd(e){');
  const ptrEndBlock = html.slice(ptrEndIdx, ptrEndIdx + 2200);
  assert.ok(ptrEndBlock.includes('showGlobePop(e, hit.d);') && !ptrEndBlock.includes('showGlobeTip(e, hit.d, true);'),
            'ptrEnd touch branch must only showGlobePop without stacking showGlobeTip simultaneously');
});

test('reader resilience and banned news source enforcement', () => {
  const fs = require('fs');
  const path = require('path');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. mozaik.inilah.com banned in server and client
  assert.ok(serverJs.includes('mozaik\\.inilah\\.com'), 'BANNED_SRC in server.js must ban mozaik.inilah.com');
  assert.ok(html.includes('mozaik\\.inilah\\.com'), 'NEWS_BANNED in public/index.html must ban mozaik.inilah.com');

  // 2. Dead proxies pruned, custom proxy env supported
  assert.ok(!serverJs.includes('corsproxy.io'), 'dead paid proxy corsproxy.io must be pruned from RD_PROXIES');
  assert.ok(!serverJs.includes('proxy.corsfix.com'), 'dead proxy corsfix must be pruned from RD_PROXIES');
  assert.ok(serverJs.includes('process.env.CUSTOM_PROXY_URL') && serverJs.includes('process.env.PROXY_URL'),
            'server.js must support CUSTOM_PROXY_URL / PROXY_URL for Cloudflare Workers / custom gateways');

  // 3. Jina API key env supported
  assert.ok(serverJs.includes('process.env.JINA_API_KEY'), 'server.js must support JINA_API_KEY for free bearer auth');

  // 4. Wire in-memory fallback for blocked articles
  assert.ok(serverJs.includes('function rdWireFind(targetUrl)'), 'server.js must implement rdWireFind');
  assert.ok(serverJs.includes("via: 'wire-fallback'") && serverJs.includes('wireFallback: true'),
            'rdRead must fall back to wire RSS metadata instead of throwing when cloud datacenters are 403 blocked');
  assert.ok(html.includes('d.wireFallback'), 'index.html reader must handle d.wireFallback banner');
});

test('anti-captcha enforcement and wire description / headline performance', () => {
  const fs = require('fs');
  const path = require('path');
  const feedtext = require('../feedtext.js');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. CAPTCHA warning is completely rejected by descFrom
  const captchaText = 'Warning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.';
  const res = feedtext.descFrom({ description: captchaText }, 'Sebuah Berita');
  assert.equal(res, '', 'descFrom must completely reject CAPTCHA / challenge warning boilerplate');

  // 2. server.js and article-extract.js must guard against CAPTCHA in Jina, HTML, and mediaDesc
  const extractJs = fs.readFileSync(path.join(__dirname, '../article-extract.js'), 'utf8');
  assert.ok(serverJs.includes('BOT_CHALLENGE_RE'), 'server.js must reference BOT_CHALLENGE_RE');
  assert.ok(extractJs.includes('BOT_CHALLENGE_RE'), 'article-extract.js must define and enforce BOT_CHALLENGE_RE');

  // 3. public/index.html must clean CAPTCHA in cleanDesc
  assert.ok(html.includes('BOT_CHALLENGE_RE'), 'index.html must define BOT_CHALLENGE_RE for cleanDesc');

  // 4. Headline image requires backend verification when API != null instead of bypassing /api/thumb via fallbackImgOK(h.img)
  assert.ok(html.includes('if (h && h.imgVerified && h.img)'),
            'fetchThumbInfo must only accept pre-verified hero images without calling /api/thumb');
  assert.ok(!html.includes('if (h && h.img && fallbackImgOK(h.img)) imgs.push(h.img)'),
            'fetchThumbInfo must NOT trust unverified RSS images when API != null');

  // 5. descAbort aborts pending fetches on topic change
  assert.ok(html.includes('descAbort') && html.includes('descAbort.abort()'),
            'topic switching must abort pending desc enrichment');
});

test('wire-reader synchronization and skeleton lifecycle enforcement', () => {
  const fs = require('fs');
  const path = require('path');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. server.js rdRead syncs article description into descRemember
  assert.ok(serverJs.includes('descRemember([raw, target, finCanon, url, r.url, r.final].filter(Boolean), ds)'),
            'server.js rdRead fin must sync article desc to descCache');

  // 2. server.js descForUrl checks reader cache and wire RSS memory before network
  assert.ok(serverJs.includes('getReadCache(canon, reqUrl)'),
            'server.js descForUrl must check reader cache before network request');
  assert.ok(serverJs.includes('rdWireFind(testU)'),
            'server.js descForUrl must check in-memory wire feed items before network request');

  // 3. index.html defines rdSyncWireDesc to bridge reader and wire cards
  assert.ok(html.includes('function rdSyncWireDesc(d, fallbackUrl)'),
            'index.html must implement rdSyncWireDesc helper');
  assert.ok(html.includes('rdSyncWireDesc(d, url);'),
            'rdArticle must call rdSyncWireDesc to update wire card immediately');
  assert.ok(html.includes('rdSyncWireDesc(d, url);') && html.includes('rdSyncWireDesc(article, h.url);'),
            'rdPrefetch and renderLead must backfill description from reader to wire items');

  // 4. Headline-first list rendering: no stuck skeletons on wire cards
  assert.ok(html.includes('// Headline-first: tidak memasang skeleton di kartu list'),
            'newsHtml must use headline-first pattern and avoid mounting stuck skeletons');
  assert.ok(html.includes('descPending(h) ? `<p class="nw-ex-sk" aria-hidden="true"><span class="nw-sk-line"></span><span class="nw-sk-line short"></span></p>`'),
            'newsHtml must render transitional skeleton placeholder when description is pending');

  // 5. CSS skeleton auto-decay and smooth reveal keyframes
  assert.ok(html.includes('@keyframes sk-decay'),
            'CSS must include sk-decay keyframes to self-destruct hanging skeletons');
  assert.ok(html.includes('.nw-reveal{animation:nw-fade-in') && html.includes('@keyframes nw-fade-in'),
            'CSS must include nw-reveal and nw-fade-in for smooth zero-shift content transition');
  assert.ok(html.includes('<p class="nw-ex nw-reveal">${esc(deEmoji(c))}</p>'),
            'nwSyncDesc must replace skeleton with nw-reveal paragraph');

  // 6. nwCardFor matches deduplicated twin URLs in it.alt
  assert.ok(html.includes('it.alt instanceof Set ? it.alt : (it.alt || [])'),
            'nwCardFor must search both primary url and dedup twin urls');
});

test('indonesian disaster metaphor disambiguation and category domain precedence', () => {
  const fs = require('fs');
  const path = require('path');
  const SOC = require('../social');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Cyber headline with passive flood verb must resolve to siber, never flood
  const cyberHeadline = 'Indonesia Dibanjiri 1,6 Juta Aktivitas Serangan Siber Dalam Sehari';
  const cyberAssessment = SOC.socAssess(cyberHeadline);
  assert.ok(cyberAssessment.topics.includes('serangan siber'), 'Must detect serangan siber topic');
  assert.ok(!cyberAssessment.topics.includes('banjir'), 'Must NEVER detect banjir topic for dibanjiri serangan siber');

  // 2. Metaphorical flood / landslide / fire / disaster expressions are not physical disasters
  const metaphorCases = [
    { text: 'Pasar Tanah Abang Dibanjiri Produk Impor Asal China', forbidden: 'banjir' },
    { text: 'Longsor Suara Partai di Jakarta Mengkhawatirkan Jelang Pemilu', forbidden: 'banjir' },
    { text: 'Banjir Gol di Stadion Manahan Solo, Persis Hajar Lawan', forbidden: 'banjir' },
    { text: 'Banjir Kecaman, Kebijakan PPN 12 Persen Diprotes di Jakarta', forbidden: 'banjir' },
    { text: 'IHSG Ambruk 2 Persen Terseret Penurunan Saham Perbankan', forbidden: 'insiden' },
    { text: 'Gempa Politik di Senayan: Tiga Menteri Dikabarkan Mundur Serentak', forbidden: 'gempa' },
  ];
  for (const tc of metaphorCases) {
    const res = SOC.socAssess(tc.text);
    assert.ok(!res.topics.includes(tc.forbidden), `Topic ${tc.forbidden} must not trigger for "${tc.text}"`);
  }

  // 3. Health events: cardiac arrest and stroke resolve to kesehatan
  const cardiacRes = SOC.socAssess('Pasien Meninggal Akibat Serangan Jantung di Rumah Sakit Bandung');
  assert.ok(cardiacRes.topics.includes('kesehatan'), 'Serangan jantung must classify as kesehatan');

  // 4. Literal physical floods and fires are properly preserved
  const realFlood = SOC.socAssess('Banjir merendam ratusan rumah di Dayeuhkolot Bandung');
  assert.ok(realFlood.topics.includes('banjir'), 'Literal flood must detect banjir');

  const realFire = SOC.socAssess('Kebakaran Hanguskan Pabrik Trikolit di Cengkareng Jakarta Barat');
  assert.ok(realFire.topics.includes('kebakaran'), 'Literal fire must detect kebakaran');

  // 5. Server and frontend implement resolveCategory disambiguation engine
  assert.ok(serverJs.includes('function resolveCategory(ids, title)'), 'server.js must define resolveCategory disambiguation function');
  assert.ok(serverJs.includes('resolveCategory(ids, t)'), 'catOf in server.js must use resolveCategory');
  assert.ok(html.includes('const resolveCategory = (ids, title) =>'), 'index.html must define resolveCategory disambiguation function');
  assert.ok(html.includes('resolveCategory(hits, t)'), 'catOfTitle in index.html must use resolveCategory');
});

test('wire lead thumbnail pipeline upgrades small RSS images, prevents hijacks, and enforces canonical media verification', async () => {
  const fs = require('fs');
  const path = require('path');
  const MEDIA = require('../article-media');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // 1. Canonical RSS feedImage upgrades Detik/CNN ?w=360 and Antara regional /cache/255x170/ and rejects small hints
  const detikXml = `<enclosure length="25000" type="image/jpeg" url="https://akcdn.detik.net.id/community/media/visual/2026/11/10/demo_169.jpeg?w=360&amp;q=90"/>`;
  assert.equal(MEDIA.feedImage(detikXml), 'https://akcdn.detik.net.id/community/media/visual/2026/11/10/demo_169.jpeg?w=1200&q=90');

  const antaraXml = `<description><![CDATA[<img src="https://cdn.antaranews.com/cache/255x170/2026/01/29/app-benih-ikan.jpg" border="0">]]></description>`;
  assert.equal(MEDIA.feedImage(antaraXml), 'https://cdn.antaranews.com/cache/1200x800/2026/01/29/app-benih-ikan.jpg');

  const singleQuoteXml = `<media:content url='https://cdn.example.com/news/photo-big.jpg' type='image/jpeg'/>`;
  assert.equal(MEDIA.feedImage(singleQuoteXml), 'https://cdn.example.com/news/photo-big.jpg');

  const tinyXml = `<enclosure type="image/jpeg" url="https://cdn.example.com/100x100/avatar.jpg"/>`;
  assert.equal(MEDIA.feedImage(tinyXml), '');

  // 2. isHijackedHtml blocks cross-domain gambling/spam redirects but keeps same registrable domain
  assert.equal(
    MEDIA.isHijackedHtml(
      'https://foto.bisnis.com/view/20261110/2020033/polda-metro-kawal-74-aksi-massa-di-jakarta',
      'https://linkpetir19.com/?refid=hjJMyy',
      '<html><head><title>LinkPetir19 Situs Slot Gacor</title></head><body></body></html>',
      false
    ),
    true
  );
  assert.equal(
    MEDIA.isHijackedHtml(
      'https://m.metrotvnews.com/read/b2lCXEGP-pertamina-pastikan-stok-bbm',
      'https://www.metrotvnews.com/read/b2lCXEGP-pertamina-pastikan-stok-bbm',
      '<html><head><title>MetroTVNews</title></head><body></body></html>',
      false
    ),
    false
  );

  // 3. imageSize handles JPEG 0xFF padding before SOF0 marker (>= 24 bytes)
  const jpegWithFill = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x11, 0x00,
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFF, 0xD9
  ]);
  assert.deepEqual(MEDIA.imageSize(jpegWithFill), { w: 1024, h: 768, mime: 'image/jpeg' });

  // 4. Canonical media validation rejects extreme banners/portraits/tiny dimensions and never returns unprobed images
  assert.ok(!/accept:\s*'image\/avif/.test(serverJs), 'probeImageDirect must not advertise unsupported image/avif');
  assert.equal(MEDIA.validateImageMetrics({ role: 'hero', dim: { w: 1200, h: 200 }, bytes: 25000, mime: 'image/jpeg' }).ok, false);
  assert.equal(MEDIA.validateImageMetrics({ role: 'hero', dim: { w: 1200, h: 800 }, bytes: 25000, mime: 'image/jpeg' }).ok, true);
  assert.ok(serverJs.includes('MEDIA.resolveArticleMedia'), 'server.js must route hero & reader media through canonical resolver');

  // 5. Frontend progressive lead thumbnail hydration, self-heal, backend rejection respect, and canonical reader parity
  assert.ok(html.includes('function attachLeadImage(url, imageUrl)'), 'index.html must define attachLeadImage for progressive hydration');
  assert.ok(html.includes('async function resolveLeadImage(h, isStale)'), 'index.html must define resolveLeadImage');
  assert.ok(html.includes('rdSyncWireDesc(article, h.url);'), 'resolveLeadImage must preserve rdSyncWireDesc call');
  assert.ok(html.includes('leadImgRejected.has('), 'frontend must respect backend rejection without overriding it');
  assert.ok(html.includes('!leadNode.querySelector(\'.lead-img\')'), 'sameLead must self-heal missing lead thumbnail');
  assert.ok(html.includes('const rdImg = (d.img && d.imgVerified !== false) ? d.img'), 'rdSyncWireDesc must only backfill backend-verified hero image onto lead card');

  // 6. WireCore.prepare adopts img from duplicate even when duplicate has shorter desc
  const WireCore = require('../public/wire-core');
  const now = 1_700_000_000_000;
  const dupOut = WireCore.prepare([
    { title: 'Banjir Besar di Bekasi Utara', url: 'https://news.google.com/1', pub: 'MetroTV', desc: 'Deskripsi panjang dari sumber utama tanpa gambar', ts: now - 5_000 },
    { title: 'Banjir Besar di Bekasi Utara', url: 'https://detik.com/2', pub: 'Detik', desc: 'Pendek', img: 'https://cdn.example.com/foto.jpg', ts: now - 10_000 },
  ], now);
  assert.equal(dupOut.length, 1);
  assert.equal(dupOut[0].img, 'https://cdn.example.com/foto.jpg');
  assert.equal(dupOut[0].desc, 'Deskripsi panjang dari sumber utama tanpa gambar');
});

test('bottom geobar uses Hybrid 04 Globe Head + 02 Spectrum & Index read-only telemetry driven by live globe data', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert.equal(html.includes('Indonesia · demo, kebakaran, banjir, bencana, insiden'), false, 'static category gimmick string must be removed');
  assert.ok(html.includes('class="geo-globe"') && html.includes('id="geo-telemetry"') && html.includes('id="geo-spec"') && html.includes('id="geo-idx"') && html.includes('id="geo-sensor"') && html.includes('id="geo-shingles"'), 'geobar must render globe head, proportional spectrum bar, sensor pod, and category index');
  assert.ok(html.includes('.geo-head,.geo-globe,.geo-k,.geo-live,.geo-telemetry,.geo-spec,.geo-seg,.geo-idx,.geo-sensor,.geo-shingles,.geo-item,.geo-pip,.geo-n,.geo-l{pointer-events:none;user-select:none;cursor:default}'), 'geobar telemetry displays must be non-clickable');
  assert.ok(!/\.geo-(?:sensor|item|spec|seg|idx)[^}]*box-shadow/.test(html), 'geobar telemetry units must not use box-shadow');
  assert.ok(html.includes('<div class="geo-sensor" id="geo-sensor" aria-label="Sensor geofisika aktif"></div>'), 'initial #geo-sensor HTML must stay empty until telemetry loads');
  assert.ok(html.includes('function renderGeoTelemetry()') && html.includes('!geoIncLoaded || !geoDisLoaded') && html.includes('legendKeyOf(p)'), 'renderGeoTelemetry must aggregate active globe points and wait until both incidents and disasters load');
  const geoSection = html.slice(html.indexOf('<div class="geo-telemetry"'), html.indexOf('<span class="geo-c" id="geo-count">'));
  assert.equal(/<button/i.test(geoSection), false, 'geo-telemetry must not contain clickable button elements');
});

test('news wire lead renders inline video player when hero photo is absent and extracts Republika shorts YouTube + transcript', () => {
  const fs = require('fs');
  const path = require('path');
  const EXTRACT = require('../article-extract');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  const url = 'https://republika.co.id/page/shorts/yt-tobss2886393783/kapolri-bakal-selidiki-kericuhan-demonstrasi-di-yogyakarta';
  const sampleHtml = `<!doctype html><html><head>
    <meta property="og:title" content="Kapolri Bakal Selidiki Kericuhan Demonstrasi di Yogyakarta">
    <meta property="og:image" content="https://static.republika.co.id/files/images/favicon-rol.png">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Kapolri Bakal Selidiki Kericuhan Demonstrasi di Yogyakarta","contentUrl":"https://static.republika.co.id/uploads/video/"}</script>
  </head><body>
    <script>
      const VIDEOS = [
        { id: 1, youtube_id: 'pdgoFsvQ5JY', title: 'Kapolri Bakal Selidiki Kericuhan Demonstrasi di Yogyakarta', news_url: '/yt-tobss2886393783/kapolri-bakal-selidiki-kericuhan-demonstrasi-di-yogyakarta', news_image: 'https://static.republika.co.id/uploads/images/medium_portrait/sample.jpg', content: \`Kapolri meninjau langsung situasi lokasi kericuhan demonstrasi di Gedung DPRD Yogyakarta dini hari tadi.\n\nPihak kepolisian bakal menyelidiki motif serta pelaku kerusuhan demonstrasi yang membawa benda berbahaya di Yogyakarta tersebut.\` },
        { id: 2, youtube_id: 'OtherId999', title: 'Topik Lain Tidak Relevan', news_url: '/yt-other123/lain', news_image: '', content: \`Teks video lain.\` }
      ];
    </script>
  </body></html>`;

  const extracted = EXTRACT.rdExtract(sampleHtml, url, { expectedTitle: 'Kapolri Bakal Selidiki Kericuhan Demonstrasi di Yogyakarta' });
  assert.equal(extracted.textSource, 'script_video_transcript');
  assert.equal(extracted.videos.length, 1);
  assert.equal(extracted.videos[0].url, 'https://www.youtube.com/embed/pdgoFsvQ5JY');
  assert.equal(extracted.videos[0].kind, 'iframe');
  assert.ok(extracted.paras.length >= 2);
  assert.equal(extracted.videos.some(v => v.url.includes('/uploads/video/')), false, 'directory stub /uploads/video/ must be ignored');

  assert.ok(serverJs.includes('resolvePlayableVideos') && serverJs.includes('hasPlayableVideo'), 'server must surface playable videos on /api/thumb and accept video-only pages in /api/read');
  assert.ok(html.includes('function leadVidWrapHtml(') && html.includes('async function resolveLeadVideo(') && html.includes('function attachLeadVideo('), 'frontend must support lead inline video player fallback');
  assert.ok(html.includes("e.target.closest('.lead-vid')"), 'clicking inline lead video player must not hijack card click into reader');
});

test('in-app reader normalizes raw URL og:site_name such as https://www.metrotvnews.com into friendly publisher label', () => {
  const fs = require('fs');
  const path = require('path');
  const WireCore = require('../public/wire-core');
  const EXTRACT = require('../article-extract');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert.equal(WireCore.cleanSiteName('https://www.metrotvnews.com', ''), 'MetroTV');
  assert.equal(WireCore.cleanSiteName('', 'https://jabar.tribunnews.com/2026/11/11/abc'), 'Tribunnews');
  assert.equal(WireCore.cleanSiteName('CNN Indonesia', 'https://www.cnnindonesia.com/x'), 'CNN Indonesia');

  const mtvHtml = `<!doctype html><html><head>
    <meta property="og:site_name" content="https://www.metrotvnews.com">
    <meta property="og:title" content="Aksi Unjuk Rasa di Yogyakarta Berakhir Kondusif">
  </head><body><article><p>Aksi unjuk rasa di Yogyakarta berjalan dan aparat menjaga gedung DPRD DIY.</p><p>Polisi menyelidiki kericuhan unjuk rasa hingga malam hari bersama warga Yogyakarta.</p></article></body></html>`;
  const res = EXTRACT.rdExtract(mtvHtml, 'https://www.metrotvnews.com/play/abc123');
  assert.equal(res.site, 'MetroTV');
  assert.ok(html.includes('WireCore.cleanSiteName(d.site, d.final || url)'), 'rdArticle must normalize cached d.site URLs cleanly');
});

test('social trending eliminates 0 0 clutter, unifies Swiss canted chips, prevents Threads starvation, and aligns 24h newswire', () => {
  const fs = require('fs');
  const path = require('path');
  const SOC = require('../social');
  const HISTORY = require('../social-history');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const now = Date.now();

  // 1. social-history retag purges retired adhocPhrases (e.g. yesterday's lazy/adhoc terms)
  const map = new Map();
  map.set('p_retired', {
    url: 'https://x.com/u1/status/1',
    text: 'Warga melaporkan banjir merendam puluhan rumah di Bekasi Timur pagi ini',
    ts: now - 3600e3,
    adhocPhrases: ['malioboro', 'demo ricuh'],
    assessment: { version: SOC.CLASSIFIER_VERSION, topics: ['banjir', 'malioboro', 'demo ricuh'], feedEligible: true, signalEligible: true },
  });
  HISTORY.retag(map, SOC.socKeepX, [], now);
  assert.equal(map.has('p_retired'), true);
  assert.deepEqual(map.get('p_retired').topics, ['banjir'], 'Retired adhoc phrases must not resurrect during retag');
  assert.deepEqual(map.get('p_retired').adhocPhrases, [], 'Retired adhocPhrases must be cleared');

  // 2. socBalance caps per-topic share relative to actual arr.length when arr.length < max
  const flooded = Array.from({ length: 100 }, (_, i) => ({
    code: 'D' + i,
    user: 'user_' + i,
    topics: ['demo'],
    assessment: { signalEligible: true, feedEligible: true, reportType: 'reported' },
  }));
  const mixed = flooded.concat(Array.from({ length: 40 }, (_, i) => ({
    code: 'B' + i,
    user: 'b_user_' + i,
    topics: ['banjir'],
    assessment: { signalEligible: true, feedEligible: true, reportType: 'reported' },
  })));
  const balanced = SOC.socBalance(mixed, 1200, p => p.user);
  const demoN = balanced.filter(p => p.topics.includes('demo')).length;
  assert.ok(demoN <= Math.ceil(mixed.length * 0.22) + 2, `demo should be capped around 22% of arr.length (${demoN}/${mixed.length})`);
  assert.ok(balanced.filter(p => p.topics.includes('banjir')).length >= 25, 'non-dominant topic must retain representation');

  // 3. Backend 24h newswire scan, non-zero trending gate, Threads fairness, and cache sync
  assert.ok(serverJs.includes('function collectNews24h('), 'server.js must aggregate all feeds before 24h newswire heat calculation');
  assert.ok(!serverJs.includes('baseQueries = SOC.SOC_TOPICS'), 'socMeta must not leak 0 0 baseQueries into active chips');
  assert.ok(serverJs.includes('if (volOf(id) <= 0) return;'), 'buildTrends must never emit 0 0 zero-post topics');
  assert.ok(serverJs.includes('const restReserve = Math.min(8, rest.length);'), 'threads() must reserve slots for starved rest topics');
  assert.ok(serverJs.includes('let newsHeatRev = 0;') && serverJs.includes('newsHeatRev +'), 'socialMetaFp must track newsHeatRev');

  // 4. Frontend unified .qc-panel shingle deck across all active topics and zero-zero omission
  assert.ok(html.includes('.qc-panel{') && !html.includes('.qc-idle{') && !html.includes('restZero'), 'all active chips must use unified .qc-panel shingles with zero 0-0 idle items');
  assert.ok(html.includes('restActive.map((q, i) => panel(q, hot.length + i, false))'), 'remaining active topics must render with the same .qc-panel shingle builder');
  assert.ok(html.includes('function socCountFor(q, kind)') && html.includes('all.filter(q => socCountFor(q, me) > 0)'), 'qchips must filter strictly to active non-zero platform topics');
  assert.ok(html.includes('function renderAllQchips()'), 'frontend must synchronize X & Threads chip bars together');
});

test('shared docCache and full mediaCache eliminate double fetch between Terbaru and Reader while keeping list items text-only', async () => {
  const fs = require('fs');
  const path = require('path');
  const SRV = require('../server');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  const sampleUrl = 'https://contoh-berita.id/peristiwa/banjir-bandang-garut-2026';
  const bodyImg = 'https://cdn.contoh-berita.id/uploads/banjir-garut-foto-1.jpg';
  const fullHtml = `<!doctype html><html><head>
    <title>Banjir Bandang Terjang Tiga Kecamatan di Garut</title>
    <meta property="og:site_name" content="Contoh Berita">
    <meta name="description" content="Banjir bandang menerjang tiga kecamatan di Kabupaten Garut dan merendam puluhan rumah warga.">
  </head><body><article>
    <p>Hujan deras yang mengguyur wilayah hulu menyebabkan sungai meluap dan memicu banjir bandang di tiga kecamatan Kabupaten Garut sejak dini hari tadi.</p>
    <figure><img src="${bodyImg}" width="900" height="600" alt="Banjir Garut"><figcaption>Petugas BPBD mengevakuasi warga terdampak banjir di Garut.</figcaption></figure>
    <p>Tim gabungan BPBD bersama relawan setempat telah mendirikan posko pengungsian sementara dan menyalurkan bantuan logistik kepada ratusan warga terdampak banjir.</p>
  </article></body></html>`;

  // Populate shared docCache + pre-verified full mediaRes (bodyImages without hero), simulating /api/thumb
  SRV.docCacheSet([sampleUrl], { html: fullHtml, finalUrl: sampleUrl, via: 'direct' });
  const docHit = SRV.docCacheGet(sampleUrl);
  assert.ok(docHit && docHit.html === fullHtml, 'docCache must retain downloaded HTML across endpoints');

  const mediaRes = {
    schemaVersion: SRV.PIPELINE_VERSION,
    requestedUrl: sampleUrl,
    canonicalUrl: sampleUrl,
    mode: 'full',
    hero: { url: '', source: 'none', method: 'none', width: 0, height: 0, aspectRatio: 0, bytes: 0, mime: '', verified: false, status: 'no_candidates', fingerprint: '', caption: '' },
    bodyImages: [{ url: bodyImg, cap: 'Evakuasi BPBD', width: 900, height: 600, aspectRatio: 1.5, mime: 'image/jpeg', bytes: 24000, fingerprint: 'fp-garut-1', source: 'body', verified: true, pos: 1 }],
    transientFailure: false,
    videos: [],
    diagnostics: {},
  };
  SRV.mediaCacheSet([sampleUrl], mediaRes);

  // rdFinish must reuse pre-verified full mediaRes directly without triggering extra network probes
  const draft = {
    ok: true,
    url: sampleUrl,
    final: sampleUrl,
    title: 'Banjir Bandang Terjang Tiga Kecamatan di Garut',
    site: 'Contoh Berita',
    desc: 'Banjir bandang menerjang tiga kecamatan di Kabupaten Garut.',
    paras: ['Hujan deras mengguyur wilayah hulu.', 'Tim gabungan mengevakuasi warga.'],
    videos: [],
    blocks: [{ k: 'p', t: 'Hujan deras mengguyur wilayah hulu.' }],
  };
  const finished = await SRV.rdFinish(draft, sampleUrl, sampleUrl, docHit.html, null, 'direct', null);
  assert.equal(finished.media.bodyImages.length, 1);
  assert.equal(finished.media.bodyImages[0].url, bodyImg);

  // Contracts: server & UI share caches two-way cleanly (bounded docCache) and grid list cards remain thumbnail-free
  assert.ok(serverJs.includes('if (thumbBusy.has(canon))') && serverJs.includes('docCacheGet(canon)'), 'rdRead must await in-flight thumb and reuse docCache');
  assert.ok(serverJs.includes('if (readBusy.has(canon))') && serverJs.includes('DOC_CACHE_MAX_HTML = 1 << 20'), 'thumb must await in-flight rdRead and cap docCache HTML at 1MB per canonical article');
  assert.ok(serverJs.includes('reuseFullMedia'), 'rdFinish must reuse pre-verified full mediaCache from /api/thumb');
  assert.ok(html.includes('function pickVerifiedMediaImg(d)') && html.includes('rdCache.set(h.url, article)'), 'frontend must cache /api/read fallback and keep Terbaru parity with Reader bodyImages');
  assert.ok(html.includes("else if (!d.transient && d.status === 'rejected')"), 'fetchThumbInfo must only lock leadImgRejected on explicit rejected status');
  const newsHtmlBlock = html.slice(html.indexOf('function newsHtml(h, full){'), html.indexOf('const dayKey ='));
  assert.ok(!newsHtmlBlock.includes('<img'), 'regular Wire list items must remain text-only without thumbnails');
});

test('Firecrawl per-URL cooldown and bounded thumbBusy wait prevent retry storms', async () => {
  const fs = require('fs');
  const path = require('path');
  const SRV = require('../server');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  // Behavior: fcFailMark blocks the URL for the cooldown window; fcBlocked expires cleanly
  const deadUrl = 'https://mati-total.id/artikel/timeout-selamanya';
  assert.equal(SRV.fcBlocked(deadUrl), false, 'unmarked URL must not be blocked');
  SRV.fcFailMark(deadUrl);
  assert.equal(SRV.fcBlocked(deadUrl), true, 'failed URL must be blocked during cooldown');
  SRV.fcBlocked('https://lain.id/artikel/lain'); // unrelated URL stays free
  assert.equal(SRV.fcBlocked('https://lain.id/artikel/lain'), false);

  // Contract: cooldown applied at all three Firecrawl call sites (thumb, reader, cctv catalog)
  const fcCalls = serverJs.match(/api\.firecrawl\.dev\/v1\/scrape/g) || [];
  assert.equal(fcCalls.length, 3, 'expected exactly 3 Firecrawl call sites');
  assert.equal((serverJs.match(/fcBlocked\(/g) || []).length, 3, 'every Firecrawl site must check fcBlocked');
  assert.equal((serverJs.match(/fcFailMark\(/g) || []).length >= 3, true, 'every Firecrawl site must mark failures');

  // Contract: rdRead waits on in-flight thumb with a timeout, not forever
  assert.ok(serverJs.includes('Promise.race([thumbBusy.get(canon), sleep(8000)])'), 'thumbBusy wait must be bounded at 8s');
});

test('Leaflet Peta Insiden & Globe render zoom-responsive, collision-culled, non-interactive regional labels', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // CSS + Globe viewport culling + Leaflet wiring contracts
  assert.ok(html.includes('.reg-lbl-ic{pointer-events:none!important') && html.includes('pointer-events:none;user-select:none'), 'regional labels must be non-interactive CSS overlays');
  assert.ok(html.includes("const regPane = map.createPane('regLabels')") && html.includes("regPane.style.pointerEvents = 'none'"), 'Leaflet regLabels pane must be non-interactive');
  assert.ok(html.includes("map.on('moveend resize', paintMapRegLabels)"), 'Leaflet must update regional labels on zoom/pan/resize');
  assert.ok(html.includes('box.x + box.w > w - 2') && html.includes('label di luar viewport jangan makan kuota maxLab'), 'Globe must cull off-screen regional labels before checking maxLab');
  const mapFooterHtml = html.slice(html.indexOf('<div class="map-f">'), html.indexOf('<aside class="tvwrap"'));
  assert.equal(/>Lalin</i.test(mapFooterHtml), false, 'Peta Insiden legend must remove stale Lalin item');
  assert.ok(mapFooterHtml.includes('id="map-leg-items"') && ['Demo', 'Kebakaran', 'Banjir', 'Bencana', 'Insiden', 'Siber', 'Kriminal', 'Kesehatan', 'Ekonomi', 'Politik', 'Gempa', 'Gunung Api'].every(l => mapFooterHtml.includes(l)), 'Peta Insiden legend must mirror all 12 Globe categories');

  // Extract paintMapRegLabels body and execute against mock Leaflet map + data
  const fnStart = html.indexOf('function paintMapRegLabels(){');
  const fnEnd = html.indexOf('\nfunction ttFlowPopup(', fnStart);
  assert.ok(fnStart > 0 && fnEnd > fnStart, 'paintMapRegLabels must exist in public/index.html');
  const fnCode = html.slice(fnStart, fnEnd);

  const added = [];
  let currentZoom = 5;
  let cleared = 0;
  const ctx = {
    mapReady: true,
    mapOpen: true,
    layerOn: { pins: true, heat: true },
    mapData: [
      { fixed: true, name: 'Node Empty', la: -6.2, lo: 106.8 },
      { name: 'Jakarta', la: -6.2, lo: 106.8 },
      { name: 'Jakarta', la: -6.2, lo: 106.8 },
      { name: 'Jakarta', la: -6.2, lo: 106.8 },
      { name: 'Bekasi', la: -6.21, lo: 106.85 }, // collides with Jakarta box at same px neighborhood
      { name: 'Surabaya', la: -7.25, lo: 112.75 },
      { name: 'Surabaya', la: -7.25, lo: 112.75 },
      { name: 'Papua Jauh', la: -2.5, lo: 140.7 }, // offscreen in mock projection -> must not consume maxLab
    ],
    deEmoji: s => String(s || ''),
    esc: s => String(s || ''),
    regTextWidth: txt => txt.length * 5,
    regLabelLayer: {
      clearLayers: () => { added.length = 0; cleared++; },
      addLayer: m => added.push(m),
    },
    map: {
      getSize: () => ({ x: 800, y: 500 }),
      getZoom: () => currentZoom,
      latLngToContainerPoint: ([la, lo]) => {
        if (lo > 130) return { x: 1200, y: 200 }; // offscreen right
        if (Math.abs(la + 6.2) < 0.05 && Math.abs(lo - 106.82) < 0.1) return { x: 200, y: 250 }; // Jakarta & Bekasi collide
        return { x: 450, y: 280 }; // Surabaya clear
      },
    },
    L: {
      divIcon: opts => opts,
      marker: (ll, opts) => ({ ll, opts }),
    },
  };
  vm.runInNewContext(fnCode + '; paintMapRegLabels();', ctx);

  assert.equal(added.length, 2, 'should place Jakarta 3 and Surabaya 2 while culling colliding Bekasi and offscreen Papua');
  assert.ok(added[0].opts.icon.html.includes('JAKARTA 3'), 'highest count cluster wins slot');
  assert.ok(added[1].opts.icon.html.includes('SURABAYA 2'));
  assert.equal(added[0].opts.interactive, false, 'marker must be non-interactive');
  assert.equal(added[0].opts.keyboard, false, 'marker must not be keyboard-focusable');
  assert.equal(added[0].opts.pane, 'regLabels');
  assert.ok(!added.some(m => m.opts.icon.html.includes('NODE EMPTY')), 'fixed monitoring nodes must not create incident labels');

  // Turning off both pins and heat clears regional labels
  ctx.layerOn.pins = false;
  ctx.layerOn.heat = false;
  vm.runInNewContext(fnCode + '; paintMapRegLabels();', ctx);
  assert.equal(added.length, 0, 'turning off both pins and heat must clear regional labels');
  assert.ok(cleared >= 2);
});

test('Social sources (Instagram Reels, TikTok, Facebook, Threads, X) are blocked from Newswire without false-positiving news about Instagram', async () => {
  const fs = require('fs');
  const path = require('path');
  const SRV = require('../server');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  // Social URLs & GNEWS social publisher wrappers must be rejected
  assert.equal(SRV.isBannedHostUrl('https://www.instagram.com/reel/DfmGpMdTsyK/'), true);
  assert.equal(SRV.isBannedHostUrl('https://instagr.am/p/ABC123/'), true);
  assert.equal(SRV.isBannedHostUrl('https://vt.tiktok.com/ZS2abc/'), true);
  assert.equal(SRV.isBannedHostUrl('https://www.facebook.com/watch/?v=123'), true);
  assert.equal(SRV.isBannedNewsItem({
    title: 'Aksi demo di Yogyakarta ricuh #tribunmedan',
    url: 'https://news.google.com/rss/articles/CBMiVkFVX3lxTFAzZWYzbVpY',
    pub: 'Instagram',
  }), true);
  assert.equal(SRV.isBannedNewsItem({
    title: 'Kejadian banjir',
    url: 'https://news.google.com/rss/articles/CBMi123',
    srcUrl: 'https://www.instagram.com',
    pub: '',
  }), true);

  // Legitimate articles discussing Instagram or Threads CDN image proxy must remain intact
  assert.equal(SRV.isBannedNewsItem({
    title: 'Instagram Gibran Banjir 26 Postingan Semalam',
    url: 'https://www.detik.com/bali/berita/d-8747561/instagram-gibran-banjir-26-postingan-semalam',
    pub: '',
    src: 'DETIK BALI',
  }), false);
  assert.ok(serverJs.includes("const IMG_HOSTS = ['fbcdn.net', 'cdninstagram.com'"), 'Threads CDN proxy allowlist must stay enabled');

  // Direct thumb() & rdRead() calls on Instagram Reel URLs must reject cleanly without scraping
  const th = await SRV.thumb('https://www.instagram.com/reel/DfmGpMdTsyK/');
  assert.equal(th.verified, false);
  assert.equal(th.status, 'rejected');
  assert.equal(th.transient, false);
  await assert.rejects(
    () => SRV.rdRead('https://www.instagram.com/reel/DfmGpMdTsyK/'),
    err => !err.transient && /dikecualikan/i.test(err.message)
  );
});

test('WAF/Cloudflare-gated news photos verify via crawler fallback and flow cleanly through /img verified proxy allowlist', async () => {
  const fs = require('fs');
  const path = require('path');
  const SRV = require('../server');
  const MEDIA = require('../article-media');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  const artUrl = 'https://www.suaradewata.com/berita/202405219038/contoh';
  const imgUrl = 'https://www.suaradewata.com/uploads/berita/contoh_123.webp';
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: artUrl,
    canonicalUrl: artUrl,
    html: `<html><head><meta property="og:image" content="${imgUrl}"></head><body><article><p>Konten berita modifikasi cuaca.</p></article></body></html>`,
    mode: 'full',
    method: 'bot',
    probeFn: async () => ({
      ok: true,
      w: 750,
      h: 500,
      mime: 'image/webp',
      bytes: 111112,
      fingerprint: 'fp-waf-bot',
      finalUrl: imgUrl,
      viaBot: true,
    }),
  });
  assert.equal(res.hero.verified, true);
  assert.equal(res.hero.url, imgUrl);
  assert.equal(res.hero.proxy, true, 'bot-verified image must signal proxy: true so browser bypasses WAF 403');

  // Verify frontend & server contracts for /img verified proxy allowlist + single-hop error fallback
  assert.ok(serverJs.includes('for (const bua of RD_BOT_UAS.slice(0, 3))') && serverJs.includes('registerVerifiedProxyImg'), 'probeImage must fall back to RD_BOT_UAS and whitelist verified image URLs');
  assert.ok(serverJs.includes('const vMeta = u ? verifiedProxyImgs.get(u) : null;'), '/img must serve verified news images while still returning 403 for unverified hosts');
  assert.ok(html.includes('rdMediaImgSrc(d.img, d.proxy)') && html.includes('rdMediaImgSrc(hero, d.imgProxy)'), 'Terbaru and Reader must load proxy-flagged images through /img');
  assert.ok(html.includes('function rdImgProxyFallback(img)') && html.includes('rdFigFb(this)') && html.includes('rdLeadImgFb(this)'), 'Terbaru and Reader must fall back once to /img on client load error');

  // Security check: arbitrary non-verified external URL still returns 403 on /img
  await new Promise((resolve, reject) => {
    const s = SRV.SITREP_SERVER.listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/img?u=${encodeURIComponent('https://evil.example/unverified.webp')}`, {
          headers: { 'x-sitrep-token': SRV.AUTH.apiToken },
        });
        assert.equal(r.status, 403);
        resolve();
      } catch (e) { reject(e); } finally { s.close(); }
    });
  });
});

test('open-proxy hardening: shared-CDN suffixes need catalog membership, config.json cannot carry secrets, desc entries cannot promote URLs', () => {
  const fs = require('fs');
  const path = require('path');
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

  // H1: /hls & snap hostOK must not suffix-match shared CDN domains
  assert.ok(serverJs.includes('SHARED_CDN_SUFFIX'), 'shared-CDN suffix denylist must exist');
  assert.ok(serverJs.includes('cloudfront') && serverJs.includes('akamaized'), 'cloudfront/akamaized must be listed');
  assert.ok(serverJs.includes('catalogHostAdd(new URL(u).hostname)'), 'px() must whitelist hosts discovered inside trusted playlists');
  assert.ok(serverJs.includes("s:'(https?:\\/\\/[^']+)'"), 'TV_CH stream hosts must be seeded into catalogHosts');

  // config.json secret strip: no credential fallbacks remain
  for (const bad of ['CFG.tomtom.api_key', 'CFG.firms.api_key', 'CFG.aisstream.api_key', 'CFG.jina_key', 'CFG.firecrawl_key', 'CFG.copernicus.client_id', 'CFG.copernicus.client_secret', 'TH.cookies']) {
    assert.ok(!serverJs.includes(bad), 'secret fallback must be removed: ' + bad);
  }
  assert.ok(serverJs.includes('delete X.auth_token'), 'X config must strip auth_token/ct0/accounts');
  assert.ok(serverJs.includes('config.json berisi field yang menyerupai credential'), 'startup must warn on secret-looking config fields');

  // M2: /api/desc entries are private — cannot promote arbitrary URLs to public allowlist
  assert.ok(serverJs.includes('descRememberPriv'), 'descForUrl must write non-public entries');
  assert.ok(serverJs.includes('de.pub'), 'isKnownNewsUrl must require pub desc entries');
  assert.ok(serverJs.includes('descDemote([url])'), '/api/desc handler must demote processed URLs');

  // M1: copernicus tiles use the heavy rate bucket
  assert.ok(serverJs.includes("u.pathname.startsWith('/api/copernicus/tile/')"), 'copernicus tiles must be rate-limited as heavy');
});

test('DOM-XSS hardening: all URL sinks use escUrl/safeUrl and category attributes are escaped', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  assert.ok(html.includes('const safeUrl = u =>') && html.includes('const escUrl = u => esc(safeUrl(u));'), 'safeUrl/escUrl helpers must exist');

  // Behavior: safeUrl allows http(s)/relative, rejects javascript:/data:/vbscript:
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const ctx = { location: { href: 'https://sitrep.local/' }, URL, esc };
  const fnSrc = html.slice(html.indexOf('const safeUrl = u =>'), html.indexOf('const escUrl = u =>'));
  vm.runInNewContext(fnSrc + '; this.__r = u => safeUrl(u);', ctx);
  const su = ctx.__r;
  assert.equal(su('https://berita.id/a'), 'https://berita.id/a');
  assert.equal(su('http://berita.id/a'), 'http://berita.id/a');
  assert.equal(su('/api/img?u=x'), '/api/img?u=x');
  assert.equal(su('javascript:alert(1)'), '#');
  assert.equal(su('JaVaScRiPt:alert(1)'), '#');
  assert.equal(su('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(su('vbscript:msgbox(1)'), '#');
  assert.equal(su(''), '#');
  assert.equal(su(null), '#');

  // Contract: no href/src/data-src/poster interpolation may use bare esc() on a URL
  const bare = html.match(/(?:href|src|data-src|poster)="\$\{esc\(/g) || [];
  assert.equal(bare.length, 0, 'bare esc() in URL attributes must be zero, got: ' + bare.slice(0, 3).join(','));

  // Contract: category interpolated into attributes/classes must be escaped
  assert.ok(!/data-cat="\$\{(?!esc\()[^}]+\}"/.test(html), 'data-cat must use esc()');
  assert.ok(!/class="[^"]*\$\{(?!esc\()[^}]*cat[^}]*\}[^"]*"/.test(html), 'cat in class attributes must use esc()');
});

test('social cold-start guard: warming/empty streaks delay "no data" and "error" states', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  // Server contract: warmSocial must flag cold-memo responses so the UI can
  // distinguish "collector still running" from "genuinely empty"
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(serverJs.includes('warming: true'), 'warmSocial must emit warming flag');

  // Client must consume the flag and gate empty/error copy behind streaks
  assert.ok(html.includes('xCold'), 'X cold-start state missing');
  assert.ok(html.includes('tCold'), 'Threads cold-start state missing');
  assert.ok(html.includes('!!d.warming'), 'pullX/pullThreads must read d.warming');
  assert.ok(html.includes('xEmptyStreak') && html.includes('tEmptyStreak'), 'empty streak counters missing');
  assert.ok(html.includes('xErrStreak') && html.includes('tErrStreak'), 'error streak counters missing');
  assert.ok(html.includes('kolektor sedang berjalan'), 'loading copy for warming state missing');
  assert.ok(html.includes('.empty.wait'), 'waiting visual state missing');

  // Hard failure copy must be streak-gated, not shown on first transient error
  assert.ok(!html.includes("Server tidak merespons. Jalankan node server.js.</div>');"), 'unconditional server-down copy must be removed');
});
