// Audit instreader: image/video/link noise per news source
// Usage: node scripts/audit-reader.js [maxPerSource] [baseUrl]
// If server not running, spawns one on 8799.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const MAX_PER = parseInt(process.argv[2] || '2', 10);
let BASE = process.argv[3] || 'http://localhost:8787';
const SRC = path.join(__dirname, '..', 'server.js');
const OUT = path.join(__dirname, 'audit-output.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// F2: gate token. Diisi dari process.env.SITREP_TOKEN bila ada; kalau tidak,
// resolveToken() mengambilnya dari <meta name="sitrep-token"> yang di-inject
// server di GET / (token acak per-boot). Server hasil spawn mewarisi process.env,
// jadi SITREP_TOKEN yang diset eksplisit otomatis berlaku juga di server itu.
let TOKEN = process.env.SITREP_TOKEN || '';

function reqHeaders(extra) {
  return { ...(extra || {}), ...(TOKEN ? { 'x-sitrep-token': TOKEN } : {}) };
}
// Query param paling aman untuk URL proxy-style yang lewat gate token
// (/img, /hls, /vhs, /api/thumb, /api/read): header saja bisa hilang saat redirect.
function gateUrl(url) {
  if (!TOKEN) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
}
async function resolveToken() {
  if (TOKEN) return TOKEN;                       // sudah dari env
  const home = BASE.replace(/\/+$/, '') + '/';
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(home, { signal: c.signal, headers: { 'user-agent': UA } });
    const html = await r.text();
    const m = html.match(/<meta[^>]*name=["']sitrep-token["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']sitrep-token["']/i);
    if (m && m[1]) TOKEN = m[1];
  } catch (e) { /* gagal → ditangani pemanggil */ }
  finally { clearTimeout(t); }
  return TOKEN;
}

const JUNK_IMG = /logo|icon|sprite|avatar|badge|placeholder|blank|pixel|spacer|advert|[-_/]ads?[-_/]|banner|emoji|gravatar|default[-_]|no[-_]?image|facebook\.net|img\.youtube\.com|wartawan|penulis|author/i;
const LINK_JUNK_TEXT = /baca juga|berita terkait|artikel terkait|lihat juga|rekomendasi|most read|trending|terpopuler|terkini/i;

function ping(url) {
  return new Promise((res, rej) => {
    const r = http.get(url, { headers: reqHeaders({ 'user-agent': UA }) }, (resp) => { resp.on('data', () => {}); resp.on('end', () => resp.statusCode === 200 ? res(true) : rej(new Error('bad ' + resp.statusCode))); });
    r.on('error', rej); r.setTimeout(6000, () => { r.destroy(new Error('timeout')); });
  });
}
async function waitUp(url, tries = 30) {
  for (let i = 0; i < tries; i++) { try { await ping(url); return true; } catch (e) { await new Promise(r => setTimeout(r, 800)); } }
  return false;
}
async function fetchJson(url, ms = 60000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: reqHeaders() }); return await r.json(); } finally { clearTimeout(t); }
}
async function fetchHtml(url, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: c.signal, headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' } });
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return { ok: r.ok, ct, html: '', len: 0 };
    const html = await r.text();
    return { ok: r.ok, status: r.status, ct, html: html.slice(0, 3e6), len: html.length };
  } finally { clearTimeout(t); }
}

function staticAudit() {
  const src = fs.readFileSync(SRC, 'utf8');
  const grab = (re) => { const m = src.match(re); return m ? m[1] : ''; };
  const checks = [];
  const has = (name, re, why) => checks.push({ name, hit: re.test(src), why });
  has('RD_CONT_RE covers detail-desc/article-content/post-content', /RD_CONT_RE\s*=\s*\/.*(?:detail-desc|article-content|post-content)/s, 'If container missed, rdBlocks scans full page incl navbar/related');
  has('RD_BAD_BOX strips author/related boxes', /RD_BAD_BOX\s*=\s*\/.*(?:author|related|reaction)/s, 'Author box + related boxes must go before img scan');
  has('RD_JUNK_URL blocks appstore/tracker', /RD_JUNK_URL\s*=\s*\/.*(?:appstore|playstore)/s, 'App-store badges & trackers');
  has('RD_IMG_JUNK blocks svg/gif/emoji', /RD_IMG_JUNK\s*=\s*\/.*emoji/s, 'Emoji/widget images');
  has('thumbFromHtml caps hero w>=600', /w >= 600/, 'Tiny hero fallback should not pass');
  has('pickImg render-size <600 drop', /pickImg[\s\S]*?sm && \+sm\[1\] < 600/, 'Body img with 300x169 etc in URL dropped at any w/h attr state');
  has('rdBlocks strips <script/style/svg/nav/header/footer/aside>', /<(script|style|noscript|svg|form|nav|header|footer|aside)/, 'Non-content buckets removed');
  has('og:image reuse guard', /ogReuse/, 'Same og:image on many articles = site asset, not photo');
  const junkList = [
    [/emoji/i, 'emoji alt/class handled only in pickImg cls check; URL-only emoji pngs like /wp-content/uploads/emoji-* may slip'],
    [/pravatar|i\.pravatar/i, 'pravatar avatar may slip if width attr missing'],
    [/160x160|100x100|150x150|32x32/i, 'WordPress-style small sizes: only numeric {3,4}x{3,4} regex, 100/300 fine, 32 slips (2 digits)'],
    [/24x24|16x16|48x48/i, 'Icon sizes 2 digits slip numeric render-size regex'],
    [/logo/i, 'logo in filename handled by addCandidate but pickImg relies more on class/alt; logo url without class token can slip'],
  ];
  return { checks, junkList: junkList.map(([re, note]) => ({ re: String(re), note })) };
}

async function auditOne(item, srcId) {
  const u = item.url;
  const t0 = Date.now();
  let read = null, thumb = null, readErr = '', thumbErr = '';
  try { read = await fetchJson(gateUrl(BASE + '/api/read?u=' + encodeURIComponent(u)), 60000); } catch (e) { readErr = String(e.message || e); }
  const tRead = Date.now() - t0;
  try { thumb = await fetchJson(gateUrl(BASE + '/api/thumb?u=' + encodeURIComponent(u)), 30000); } catch (e) { thumbErr = String(e.message || e); }
  let raw = null, rawErr = '';
  // resolve google news? server does it; for raw we fetch original (may fail on GN) and skip raw analysis gracefully
  try { raw = await fetchHtml(u, 20000); } catch (e) { rawErr = String(e.message || e).slice(0, 120); }

  const blocks = (read && read.blocks) || [];
  const imgs = blocks.filter(b => b.k === 'i').map(b => b.img);
  const vids = blocks.filter(b => b.k === 'v').map(b => b.v);
  const paras = (read && read.paras) || [];

  const junkImgs = imgs.filter(im => JUNK_IMG.test(im.url + ' ' + (im.cap || '')));
  const junkParas = paras.filter(p => LINK_JUNK_TEXT.test(p) || /^(baca juga|simak juga|lihat juga)/i.test(p.trim()));
  const hero = (read && read.img) || '';
  const heroKey = hero ? hero.split('?')[0].replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/\.\w+$/, '').toLowerCase() : '';
  const bodyHeroDup = imgs.filter(im => im.url.split('?')[0].replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/\.\w+$/, '').toLowerCase() === heroKey);
  const probeVids = vids.filter(v => v && v.kind === 'probe').length;
  const iframeVids = vids.filter(v => v && v.kind === 'iframe').map(v => v.url);
  const fileVids = vids.filter(v => v && v.kind === 'video').map(v => v.url);
  const nonYtIframe = iframeVids.filter(v => !/youtube\.com|youtu\.be|youtube-nocookie/.test(v));

  let container = { contRe: false, articleTag: 0, imgTotal: 0, imgAfterStrip: 'n/a' };
  if (raw && raw.html) {
    const html = raw.html;
    container.contRe = /<(article|div|section|main)\b[^>]*(?:class|id)=["'][^"']*(?:detail-desc|article-content|article-body|content-detail|detail-content|post-content|entry-content|berita-content|field-name-body|txt-berita|detail_body|news-content|content-body|post-body|article__body)[^"']*["'][^>]*>/i.test(html);
    container.articleTag = (html.match(/<article\b/gi) || []).length;
    container.imgTotal = (html.match(/<img\b/gi) || []).length;
  }

  const issues = [];
  if (readErr) issues.push('read fetch failed: ' + readErr.slice(0, 100));
  if (junkImgs.length) issues.push(junkImgs.length + ' junk image(s): ' + junkImgs.map(i => i.url.slice(0, 110)).join(' | '));
  if (junkParas.length) issues.push(junkParas.length + ' related/link paragraph(s) leaked: ' + junkParas.map(p => p.slice(0, 90)).join(' | '));
  if (bodyHeroDup.length) issues.push('hero duplicated in body x' + bodyHeroDup.length);
  if (probeVids) issues.push(probeVids + ' probe video(s) unresolved');
  if (nonYtIframe.length) issues.push('non-YouTube iframe(s) kept: ' + nonYtIframe.map(v => v.slice(0, 110)).join(' | '));
  if (!hero) issues.push('no hero image');
  if (raw && raw.html && !container.contRe && container.articleTag === 0) issues.push('container NOT detected (RD_CONT_RE missed + no <article>): full-page scan, high leak risk');
  if (paras.length < 2) issues.push('thin paras=' + paras.length);
  if (raw && rawErr) issues.push('raw fetch note: ' + rawErr);

  return { src: srcId, title: item.title, url: u, tRead, ok: !!(read && read.ok), err: (read && read.err) || readErr,
    hero, thumbImg: (thumb && thumb.img) || '', thumbErr, heroThumbMismatch: !!(hero && thumb && thumb.img && hero !== thumb.img),
    paras: paras.length, blocks: blocks.length, imgs: imgs.length, junkImgs: junkImgs.length, junkParas: junkParas.length,
    vids: { total: vids.length, file: fileVids.length, iframe: iframeVids.length, probe: probeVids },
    container, issues, imgUrls: [...imgs.map(i => i.url), ...(hero ? ['HERO:' + hero] : [])].slice(0, 8) };
}

(async () => {
  let child = null;
  const up = await waitUp(BASE + '/api/ping', 3);
  if (!up) {
    BASE = 'http://localhost:8799';
    console.log('[audit] server not on 8787, spawning on 8799');
    // env proses ini diwariskan → SITREP_TOKEN (bila diset) ikut ke server,
    // sehingga token yang dipakai server == token audit (lihat TOKEN di atas).
    child = spawn('node', ['server.js'], { env: { ...process.env, PORT: '8799' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write('[srv] ' + d));
    child.stderr.on('data', d => process.stderr.write('[srv] ' + d));
    const ok = await waitUp(BASE + '/api/ping', 40);
    if (!ok) { console.error('server failed to start'); if (child) child.kill(); process.exit(1); }
  }
  console.log('[audit] base', BASE);
  // F2: pastikan token ada sebelum ada request /api/* (semua bakal 403 tanpanya).
  if (!await resolveToken()) {
    console.error('[audit] ERROR: tidak bisa memperoleh token SITREP — semua /api/* akan ditolak 403.');
    console.error('[audit] Tanpa SITREP_TOKEN di env, server memakai token acak per-boot yang hanya');
    console.error('[audit] tersedia lewat <meta name="sitrep-token" content="..."> pada GET / —');
    console.error('[audit] halaman itu tidak bisa di-fetch/diparse, atau SITREP_TOKEN memang belum diset.');
    console.error('[audit] Cara perbaiki: set environment lalu jalankan ulang, mis.');
    console.error('[audit]   SITREP_TOKEN=<TOKEN> node scripts/audit-reader.js [maxPerSource] [baseUrl]');
    console.error('[audit] (server yang di-spawn script ini mewarisi process.env, jadi cukup set sekali.)');
    if (child) child.kill();
    process.exit(1);
  }
  console.log('[audit] token OK (sumber: ' + (process.env.SITREP_TOKEN ? 'env SITREP_TOKEN' : 'meta /') + ')');
  const stat = staticAudit();
  console.log('[static]');
  for (const c of stat.checks) console.log(' ' + (c.hit ? 'PASS' : 'FAIL') + ' ' + c.name + ' :: ' + c.why);
  for (const j of stat.junkList) console.log(' GAP ' + j.re + ' :: ' + j.note);

  const news = await fetchJson(BASE + '/api/news', 60000);
  const srcs = news.sources || [];
  console.log('\n[feeds] ' + srcs.length + ' sources');
  const results = [];
  for (const s of srcs) {
    const items = (s.items || []).slice(0, MAX_PER);
    if (!s.ok || !items.length) {
      console.log('\n== ' + s.id + ' : NOT OK (' + (s.err || 'no items') + ')');
      results.push({ src: s.id, ok: false, err: s.err || 'no items', items: [] });
      continue;
    }
    console.log('\n== ' + s.id + ' : ' + s.items.length + ' items, auditing ' + items.length);
    const rows = [];
    for (const it of items) {
      const r = await auditOne(it, s.id);
      rows.push(r);
      console.log(' - ' + r.title.slice(0, 72));
      console.log('   url ' + r.url.slice(0, 120));
      console.log('   ok=' + r.ok + ' paras=' + r.paras + ' imgs=' + r.imgs + ' junkImgs=' + r.junkImgs + ' junkParas=' + r.junkParas + ' vids[file/iframe/probe]=' + r.vids.file + '/' + r.vids.iframe + '/' + r.vids.probe + ' hero=' + (r.hero ? 'yes' : 'no') + ' thumbMatch=' + (!r.heroThumbMismatch) + ' readMs=' + r.tRead);
      console.log('   container contRe=' + r.container.contRe + ' articleTags=' + r.container.articleTag + ' rawImgTags=' + r.container.imgTotal);
      for (const i of r.issues) console.log('   ISSUE: ' + i);
    }
    results.push({ src: s.id, ok: true, items: rows });
  }
  const flat = results.flatMap(r => r.items || []);
  const summary = {
    at: new Date().toISOString(), base: BASE, perSource: MAX_PER,
    static: stat,
    totalAudited: flat.length,
    withJunkImg: flat.filter(r => r.junkImgs > 0).length,
    withJunkPara: flat.filter(r => r.junkParas > 0).length,
    noHero: flat.filter(r => !r.hero).length,
    heroThumbMismatch: flat.filter(r => r.heroThumbMismatch).length,
    containerMissed: flat.filter(r => r.container && !r.container.contRe && r.container.articleTag === 0 && r.container.imgTotal > 0).length,
    probeVids: flat.reduce((a, r) => a + r.vids.probe, 0),
    results
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('\n[summary] audited=' + flat.length + ' withJunkImg=' + summary.withJunkImg + ' withJunkPara=' + summary.withJunkPara + ' noHero=' + summary.noHero + ' heroThumbMismatch=' + summary.heroThumbMismatch + ' containerMissed=' + summary.containerMissed + ' probeVids=' + summary.probeVids);
  console.log('[write] ' + OUT);
  if (child) child.kill();
})().catch(e => { console.error(e); process.exit(1); });
