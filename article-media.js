'use strict';

const crypto = require('crypto');
const EXTRACT = require('./article-extract');

const PIPELINE_VERSION = 3;

const TRACKING_PARAM_RE = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|_ga|_gl|ga_[a-z_]+|guce_referrer(?:_sig)?|ns_[a-z_]+|oc|ved|usg|sa|spm|fb_action_ids|fb_action_types|fb_source|ref_src|ref_url)$/i;

function canonicalArticleUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/i.test(u.protocol)) return '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
    }
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch (e) {
    return '';
  }
}

function regDomain(u) {
  try {
    const parts = new URL(u).hostname.toLowerCase().replace(/^www\./, '').split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    if (/^(?:co|or|go|ac|sch|net|web|my|biz|mil|com|edu|gov|org)$/i.test(sld) && parts[parts.length - 1].length === 2) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  } catch (e) {
    return '';
  }
}

function resolveUrl(raw, base) {
  return EXTRACT.rdAbs(raw, base);
}

function upgradeImage(u) {
  let x;
  try { x = new URL(u); } catch (e) { return u; }
  const h = x.hostname;
  if (/(^|\.)googleusercontent\.com$/i.test(h)) {
    return u.replace(/=s\d+(?:-[^?]*)?$/, '=s0').replace(/=w\d+(?:-h\d+)?(?:-[^?]*)?$/, '=w1600');
  }
  if (/(^|\.)detik\.net\.id$/i.test(h) || /(^|\.)detik\.com$/i.test(h)) {
    if (/\.(?:svg|gif|ico)(?:$|[?#])/i.test(x.pathname)) return u;
    const w = parseInt(x.searchParams.get('w') || '0', 10);
    if (!w || w < 1200) x.searchParams.set('w', '1200');
    const q = parseInt(x.searchParams.get('q') || '0', 10);
    if (!q || q < 90) x.searchParams.set('q', '90');
    return x.href;
  }
  if (/(^|\.)antaranews\.com$/i.test(h) && /\/cache\/\d+x\d+\//.test(x.pathname)) {
    return u.replace(/\/cache\/\d+x\d+\//, '/cache/1200x800/');
  }
  if (/(^|\.)tribunnews\.com$/i.test(h) && /\/\d+x\d+\//.test(x.pathname)) {
    return u.replace(/\/\d+x\d+\//, '/1200x675/');
  }
  if (/(^|\.)cdn\.bsinews\.id$/i.test(h) || /(^|\.)bsinews\.id$/i.test(h)) {
    const w = parseInt(x.searchParams.get('width') || '0', 10);
    if (!w || w < 1200) {
      x.searchParams.set('width', '1200');
      x.searchParams.set('height', '674');
      x.searchParams.set('quality', '80');
      return x.href;
    }
  }
  return u;
}

function imageKey(u) {
  let p = String(u || '').split('?')[0].split('#')[0].toLowerCase().replace(/\.\w{2,5}$/, '');
  p = p
    .replace(/\/(?:thumb|fill|fit|resize|crop|cache)\/?\d{2,4}(?:x|\/)\d{2,4}\//g, '/')
    .replace(/\/[^/]*\b(?:w_\d+|c_fill|c_scale|f_auto|q_auto[^/]*)[^/]*\//g, '/');
  const base = (p.split('/').pop() || '')
    .replace(/^(?:thumb|tn|sm|md|lg)[-_]/, '')
    .replace(/[-_]\d{2,4}x\d{2,4}$/, '')
    .replace(/[-_](?:169|43|11|16_9|4_3)$/, '')
    .replace(/[-_](?:small|medium|large|thumb|thumbnail|original|full)$/, '');
  if (base.length >= 8 && /[a-z]/.test(base) && !/^(?:image|photo|foto|img|picture|default|thumb|cover|poster|index|whatsapp[-_]image)\d*$/.test(base)) {
    return base;
  }
  return p;
}

function dirKey(u) {
  const seg = String(u || '').split('?')[0].split('#')[0].split('/').filter(Boolean);
  return seg.length > 1 ? seg[seg.length - 2] : '';
}

function rdSmallHint(u) {
  const x = String(u || '');
  const path = x.split('?')[0];
  for (const m of path.matchAll(/(?:^|[\/_=.-])(\d{2,4})x(\d{2,4})(?=[\/_.-]|$)/g)) {
    if (+m[1] < 400 || +m[2] < 200) return true;
  }
  const f = path.match(/\/(?:fill|fit|resize|crop|w)\/(\d{2,4})\/(\d{2,4})\//i);
  if (f && (+f[1] < 400 || +f[2] < 200)) return true;
  const q = x.match(/[?&](?:w|width|size)=(\d{2,4})(?=&|$)/i);
  if (q && +q[1] < 400) return true;
  return false;
}

const RD_IMG_JUNK = /logo|logotype|wordmark|brandmark|favicon|apple-touch-icon|android-chrome|mstile|sprite|avatar|badge|placeholder|blank|pixel|spacer|advert|\/ads?\/|[-_/.]ads?[-_/.]|banner|emoji|emoticon|button|share|loading|lazy\.|default[-_]|no[-_]?image|not[-_]?found|gravatar|pravatar|thumb(?:nail)?s?\/small|image[-_]?404|404[-_]?image/i;
const RD_JUNK_URL = /appstore|playstore|googleplay|gettheapp|framebarasset|asset-template|(?:^|\/)slide[-_]|assets_frontend\/images|\/assets\/(?:medsos|img|images|icons?)\/(?:ui|icons?|buttons?|social|medsos)?|share[-_ ]?preview|social[-_ ]?(?:share|card|icon)|og[-_]?(?:default|image)\b|partials\/|widgets-nocache|analytics_page_request|inpicture_widget|wartawan|scorecard|criteo|doubleclick|googlesyndication|googleadservices|adservice|hotjar|facebook\.net|img\.youtube\.com|(^|\/)ic_[a-z0-9]|en-flag|id-flag|(?:^|\/)thumb_(?:small|mini|tiny|xs|sm|default|placeholder|icon|avatar|\d{1,4}\.)|\/mini\/|\/small\/|\/img\/site\/|foot[-_ ]?network|foto[-_/]bank(?!\/originals)|fotobank|\/(?:tautan|lampiran)\/|image[-_]?404|404[-_]?image|ai[-_ ]?image[-_ ]?generator|\/avatars?\/|\/authors?\/|\/penulis\/|\/icons?\/|\/logos?\//i;
const RD_JUNK_BASE = /^(?:google|gnews|googlenews|telegram|threads|bluesky|pinterest|line|ig|fb|twitter|x|tiktok|instagram|youtube|wa|whatsapp|linkedin|googleplay|appstore|playstore|en-flag|id-flag|favicon|logo|icon|avatar|placeholder|blank|spacer|pixel|spinner|loading|default)([-_. ]|$)/i;

function rdJunkUrl(u) {
  const path = String(u || '').split('?')[0];
  if (RD_JUNK_URL.test(path)) return true;
  const base = path.split('/').pop() || '';
  if (/^(?:whatsapp|wa|telegram)[-_ ](?:image|foto|img|pic|photo|doc|video)/i.test(base)) return false;
  if (/(?:^|\/)(?:i-(?:facebook|twitter|x|whatsapp|telegram|instagram|youtube|pinterest|linkedin|tiktok)|(?:wa|whatsapp|fb|ig|twitter|telegram|pinterest|linkedin|youtube|tiktok)[-_](?:icon|share|logo|btn|komunitas))[^/]*$/i.test(path)) return true;
  return RD_JUNK_BASE.test(base);
}

function classifyCandidateUrl(url, ctx = {}) {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'invalid_url' };
  let x;
  try { x = new URL(url); } catch (e) { return { ok: false, reason: 'invalid_url' }; }
  if (!/^https?:$/i.test(x.protocol)) return { ok: false, reason: 'invalid_protocol' };
  const path = x.pathname;
  if (/\.(?:svg|ico|cur)$/i.test(path)) return { ok: false, reason: 'unsupported_vector_or_icon_ext' };
  if (ctx.role === 'hero' && /\.gif$/i.test(path)) return { ok: false, reason: 'gif_rejected_for_hero' };
  if (rdJunkUrl(url)) return { ok: false, reason: 'junk_url_pattern' };
  const fn = path.split('/').pop() || '';
  if (/(?:^|[-_.])(logo|logotype|wordmark|favicon|apple-touch-icon|sprite|watermark|placeholder|avatar|icons?|default|image[-_]?404|404[-_]?image|no[-_]?image|not[-_]?found)(?:[-_.\d]|$)/i.test(fn)) {
    return { ok: false, reason: 'non_editorial_filename' };
  }
  if (RD_IMG_JUNK.test(path)) return { ok: false, reason: 'non_editorial_path' };
  const up = upgradeImage(url);
  if (rdSmallHint(url) && (up === url || rdSmallHint(up))) {
    return { ok: false, reason: 'small_dimension_url_hint' };
  }
  return { ok: true };
}

function classifyCandidateAttrs(attrs = {}) {
  const cls = ((attrs.class || '') + ' ' + (attrs.id || '') + ' ' + (attrs.role || '')).toLowerCase();
  if (/(?:^|[\s_-])(?:logo|brand|favicon|icon|avatar|author|wartawan|penulis|byline|profile|social|share|badge|emoji|emoticon|reaction|rating|like|dislike|vote|poll|banner|advert|iklan|promo|placeholder|spacer|pixel|blank|sprite|watermark|related|sidebar|widget)(?:$|[\s_-])/.test(cls)) {
    return { ok: false, reason: 'non_editorial_dom_class' };
  }
  const alt = String(attrs.alt || attrs.title || '').trim();
  if (alt && !/^(?:whatsapp|wa)[-_ ]image/i.test(alt)) {
    if (/^(?:logo|favicon|icon|avatar|share|whatsapp|facebook|twitter|telegram|linkedin|advertisement|iklan|banner|placeholder|emoji|reaction|like|dislike|menu|search|no[-_ ]?image)\b/i.test(alt)
      || /\b(?:publisher logo|site logo|author photo|foto penulis|foto wartawan|ai[-_ ]?image[-_ ]?generator|follow us|bagikan ke)\b/i.test(alt)) {
      return { ok: false, reason: 'non_editorial_alt_text' };
    }
  }
  const rawW = String(attrs.width || '').trim();
  const rawH = String(attrs.height || '').trim();
  const w = (!rawW.endsWith('%') ? parseInt(rawW, 10) : 0) || 0;
  const h = (!rawH.endsWith('%') ? parseInt(rawH, 10) : 0) || 0;
  if ((w > 0 && w < 200) || (h > 0 && h < 120)) return { ok: false, reason: 'small_html_attr_dimensions' };
  if (w >= 200 && h > 0 && w / h > 3.2) return { ok: false, reason: 'extreme_banner_html_attrs' };
  return { ok: true };
}

function parseIsobmffSize(buf) {
  const idx = buf.indexOf(Buffer.from('ispe'));
  if (idx >= 4 && idx + 16 <= buf.length) {
    const w = buf.readUInt32BE(idx + 8);
    const h = buf.readUInt32BE(idx + 12);
    if (w > 0 && w < 30000 && h > 0 && h < 30000) return { w, h };
  }
  return null;
}

function imageSize(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.length >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), mime: 'image/gif' };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xFF) { i++; continue; }
      if (m === 0x00 || m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xD9 || m === 0xDA) break;
      if (i + 4 > buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        if (i + 9 > buf.length) break;
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), mime: 'image/jpeg' };
      }
      i += 2 + len;
    }
  }
  if (buf.length >= 25 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const t = buf.toString('ascii', 12, 16);
    if (t === 'VP8X' && buf.length >= 30) {
      return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), mime: 'image/webp' };
    }
    if (t === 'VP8 ' && buf.length >= 30) {
      const i = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
      if (i > 0 && i + 7 <= buf.length) {
        return { w: buf.readUInt16LE(i + 3) & 0x3fff, h: buf.readUInt16LE(i + 5) & 0x3fff, mime: 'image/webp' };
      }
    }
    if (t === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff), mime: 'image/webp' };
    }
  }
  if (buf.length >= 16 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (/^(?:avif|avis|mif1|heic|heix)$/i.test(brand)) {
      const sz = parseIsobmffSize(buf);
      if (sz) return { ...sz, mime: 'image/avif' };
    }
  }
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    const w = buf.readInt32LE(18);
    const h = Math.abs(buf.readInt32LE(22));
    if (w > 0 && h > 0) return { w, h, mime: 'image/bmp' };
  }
  return null;
}

const UNSUPPORTED_MIME_RE = /^(?:image\/svg\+xml|image\/x-icon|image\/vnd\.microsoft\.icon|text\/|application\/(?:json|xml|xhtml\+xml|javascript)|video\/|audio\/)/i;

function inspectImageBuffer(buf, contentType = '') {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct && UNSUPPORTED_MIME_RE.test(ct)) {
    return { ok: false, reason: 'unsupported_mime', mime: ct };
  }
  if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) {
    return { ok: false, reason: 'unsupported_mime', mime: ct };
  }
  if (!buf || buf.length < 12) {
    return { ok: false, reason: 'empty_or_truncated_image' };
  }
  const headText = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart().toLowerCase();
  if (/^(?:<!doctype|<html|<head|<svg|<\?xml|\{)/.test(headText)) {
    return { ok: false, reason: headText.startsWith('<svg') || headText.includes('<svg') ? 'svg_payload' : 'not_an_image_payload' };
  }
  if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) {
    return { ok: false, reason: 'favicon_ico_payload', mime: 'image/x-icon' };
  }
  const dim = imageSize(buf);
  if (!dim || !(dim.w > 0) || !(dim.h > 0)) {
    return { ok: false, reason: 'unrecognized_or_corrupt_image' };
  }
  const fingerprint = crypto.createHash('sha1').update(buf.subarray(0, Math.min(buf.length, 32768))).digest('hex');
  return {
    ok: true,
    w: dim.w,
    h: dim.h,
    mime: dim.mime || ct || 'image/unknown',
    fingerprint,
  };
}

function validateImageMetrics({ role = 'hero', source = 'og', dim, bytes = 0, mime = '', insideFigure = false }) {
  if (!dim || !(dim.w > 0) || !(dim.h > 0)) {
    return { ok: false, reason: 'missing_dimensions' };
  }
  const m = String(mime || '').toLowerCase();
  if (/svg|icon|bmp/.test(m)) {
    return { ok: false, reason: 'unsupported_image_format', detail: m };
  }
  if (m === 'image/gif') {
    if (role === 'hero' || bytes < 25000 || dim.w < 450 || dim.h < 250) {
      return { ok: false, reason: 'gif_asset_rejected', detail: `${dim.w}x${dim.h},${bytes}B` };
    }
  }
  const minBytes = role === 'hero' ? 5000 : 4500;
  if (bytes > 0 && bytes < minBytes) {
    return { ok: false, reason: 'file_too_small', detail: `${bytes}B < ${minBytes}B` };
  }
  const ar = +(dim.w / dim.h).toFixed(3);
  if (role === 'hero') {
    if (dim.w < 480 || dim.h < 250) {
      return { ok: false, reason: 'dimensions_too_small', detail: `${dim.w}x${dim.h}` };
    }
    if (ar > 2.6 || ar < 0.72) {
      return { ok: false, reason: 'invalid_aspect_ratio', detail: `ar=${ar}` };
    }
    const isSquare = ar >= 0.88 && ar <= 1.14;
    if (isSquare && !(source === 'body_lead' && insideFigure && dim.w >= 500)) {
      return { ok: false, reason: 'square_logo_or_icon_risk', detail: `${dim.w}x${dim.h}` };
    }
  } else {
    if (dim.w < 400 || dim.h < 200) {
      return { ok: false, reason: 'body_dimensions_too_small', detail: `${dim.w}x${dim.h}` };
    }
    if (ar > 2.8 || ar < 0.45) {
      return { ok: false, reason: 'body_invalid_aspect_ratio', detail: `ar=${ar}` };
    }
  }
  return { ok: true, aspectRatio: ar };
}

class AssetReuseTracker {
  constructor() {
    this.byHost = new Map();
    this.feedReuse = new Set();
  }

  markFeedReused(imgUrl) {
    if (!imgUrl) return;
    this.feedReuse.add(imageKey(imgUrl));
    if (this.feedReuse.size > 1500) this.feedReuse.delete(this.feedReuse.keys().next().value);
  }

  isReused(articleUrl, imgUrl, fingerprint = '') {
    const k = imageKey(imgUrl);
    if (this.feedReuse.has(k)) return true;
    const host = regDomain(articleUrl);
    if (!host) return false;
    const m = this.byHost.get(host);
    if (!m) return false;
    const artKey = canonicalArticleUrl(articleUrl) || articleUrl;
    for (const checkKey of [k, fingerprint ? 'fp:' + fingerprint : ''].filter(Boolean)) {
      const s = m.get(checkKey);
      if (!s) continue;

      if (s.has(artKey)) { if (s.size >= 3) return true; }
      else if (s.size >= 2) return true;
    }
    return false;
  }

  record(articleUrl, imgUrl, fingerprint = '') {
    const host = regDomain(articleUrl);
    if (!host || !imgUrl) return;
    const artKey = canonicalArticleUrl(articleUrl) || articleUrl;
    let m = this.byHost.get(host);
    if (!m) {
      m = new Map();
      this.byHost.set(host, m);
      if (this.byHost.size > 100) this.byHost.delete(this.byHost.keys().next().value);
    }
    for (const checkKey of [imageKey(imgUrl), fingerprint ? 'fp:' + fingerprint : ''].filter(Boolean)) {
      let s = m.get(checkKey);
      if (!s) {
        s = new Set();
        m.set(checkKey, s);
        if (m.size > 200) m.delete(m.keys().next().value);
      }
      s.add(artKey);
    }
  }
}

function ldArticleImages(html, baseUrl) {
  const out = [];
  const collect = (node, outArr) => {
    if (!node) return;
    if (Array.isArray(node)) { for (const n of node) collect(n, outArr); return; }
    if (typeof node === 'string') { outArr.push(node); return; }
    if (typeof node !== 'object') return;
    const t = String(node['@type'] || '');
    if (/person|organization/i.test(t)) return;
    if (typeof node.url === 'string') outArr.push(node.url);
    if (typeof node.contentUrl === 'string') outArr.push(node.contentUrl);
    for (const k of ['image', 'thumbnailUrl', 'primaryImageOfPage']) {
      if (node[k]) collect(node[k], outArr);
    }
  };
  for (const n of EXTRACT.rdLd(html)) {
    const t = String(n['@type'] || '');
    if (/person|organization/i.test(t)) continue;

    if (/breadcrumb|navigation|searchaction/i.test(t)) continue;
    const urls = [];
    collect(n.image || n.thumbnailUrl || n.primaryImageOfPage, urls);
    for (const raw of urls) {
      const u = resolveUrl(raw, baseUrl);
      if (u) out.push(u);
    }
  }
  return out;
}

function extractHtmlImageCandidates(html, baseUrl) {
  const sHtml = String(html || '').slice(0, 1800000);
  const metaCands = [];
  const bodyCands = [];
  const seenUrls = new Set();

  const pushCand = (arr, rawUrl, source, attrs = {}, extra = {}) => {
    const u = resolveUrl(rawUrl, baseUrl);
    if (!u) return;
    const key = source + '|' + u;
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
    arr.push({ url: u, source, attrs, ...extra });
  };

  const cleanBodyHtml = EXTRACT.stripCardLinks(EXTRACT.stripJunkContainers(sHtml), baseUrl);
  const { bodyContainers, leadMediaContainers } = EXTRACT.extractContainers(cleanBodyHtml);
  const bodySeen = new Set();

  for (const lmHtml of leadMediaContainers) {
    let cleanLm = EXTRACT.stripJunkContainers(lmHtml);
    cleanLm = EXTRACT.stripCardLinks(cleanLm, baseUrl);
    for (const fig of cleanLm.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure\s*>/gi)) {
      const imgM = fig[1].match(/<(?:img|amp-img)\b[^>]*>/i);
      if (!imgM) continue;
      const aSpotDesc = (fig[1].match(/<a\b[^>]*data-description=["']([^"']+)["']/i) || [])[1];
      const cap = EXTRACT.rdInline(((fig[1].match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption\s*>/i) || [])[1] || '').replace(/<[^>]+>/g, ' ')) ||
        (aSpotDesc ? EXTRACT.rdInline(aSpotDesc) : '');
      const a = EXTRACT.parseAttrs(imgM[0]);
      const aSpotLink = (fig[1].match(/<a\b[^>]*href=["']([^"']+\.(?:jpe?g|png|webp|avif)[^"']*)["']/i) || [])[1];
      const src = (aSpotLink && !/\.(?:svg|ico)$/i.test(aSpotLink) ? aSpotLink : '') ||
        EXTRACT.pickBestSrcset(a['data-srcset'] || a.srcset, baseUrl) || a['data-src'] || a['data-lazy-src'] || a['data-original'] || a['data-lazy'] || a['data-url'] || a.src;
      const resolved = resolveUrl(src, baseUrl);
      if (resolved && !bodySeen.has(resolved)) {
        bodySeen.add(resolved);
        pushCand(bodyCands, resolved, 'body_lead', a, { cap, insideFigure: true, pos: 0 });
      }
    }
    for (const imgM of cleanLm.matchAll(/<(?:img|amp-img)\b[^>]*>/gi)) {
      const a = EXTRACT.parseAttrs(imgM[0]);
      const src = EXTRACT.pickBestSrcset(a['data-srcset'] || a.srcset, baseUrl) || a['data-src'] || a['data-lazy-src'] || a['data-original'] || a['data-lazy'] || a['data-url'] || a.src;
      const resolved = resolveUrl(src, baseUrl);
      if (resolved && !bodySeen.has(resolved)) {
        bodySeen.add(resolved);
        pushCand(bodyCands, resolved, 'body_lead', a, { cap: EXTRACT.rdInline(a.alt || ''), insideFigure: false, pos: 0 });
      }
    }
  }

  const mainBodyCand = bodyContainers.find(c => c.kind === 'selector') ||
    bodyContainers.find(c => c.kind === 'article') ||
    bodyContainers.find(c => c.kind === 'main') ||
    bodyContainers[0];
  if (mainBodyCand) {
    const blk = EXTRACT.rdBlocks(mainBodyCand.html, baseUrl);
    let pCount = 0;
    for (const b of blk.blocks) {
      if (b.k === 'p' || b.k === 'q' || b.k === 'li') { pCount++; continue; }
      if (b.k === 'i' && b.img && b.img.url) {
        if (bodySeen.has(b.img.url)) continue;
        bodySeen.add(b.img.url);

        const source = pCount <= 1 ? 'body_lead' : 'body';
        pushCand(bodyCands, b.img.url, source, b.img.attrs || { alt: b.img.alt }, {
          cap: b.img.cap || '',
          insideFigure: !!b.img.insideFigure,
          pos: pCount,
        });
      }
    }
  }

  for (const m of sHtml.matchAll(/<meta\b[^>]*>/gi)) {
    const a = EXTRACT.parseAttrs(m[0]);
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (!a.content) continue;
    if (/^og:image(?::secure_url|:url)?$/.test(k)) {
      pushCand(metaCands, a.content, 'og', {});
    } else if (/^twitter:image(?::src)?$/.test(k)) {
      pushCand(metaCands, a.content, 'twitter', {});
    } else if (k === 'thumbnailurl' || k === 'thumbnail' || (a.itemprop || '').toLowerCase() === 'image') {
      pushCand(metaCands, a.content, 'meta', {});
    }
  }
  for (const m of sHtml.matchAll(/<link\b[^>]*>/gi)) {
    const a = EXTRACT.parseAttrs(m[0]);
    if ((a.rel || '').toLowerCase() === 'image_src' && a.href) pushCand(metaCands, a.href, 'meta', {});
  }
  for (const m of sHtml.matchAll(/<video\b[^>]*>/gi)) {
    const a = EXTRACT.parseAttrs(m[0]);
    if (a.poster) pushCand(metaCands, a.poster, 'meta', {});
  }
  for (const u of ldArticleImages(sHtml, baseUrl)) {
    pushCand(metaCands, u, 'ld', {});
  }

  return { bodyCands, metaCands };
}

function extractJinaImageCandidates(markdown, articleUrl, title = '') {
  const out = [];
  const parsed = EXTRACT.rdJinaMd(markdown, articleUrl, { expectedTitle: title });
  let pCount = 0;
  for (const b of parsed.blocks) {
    if (b.k === 'p' || b.k === 'q' || b.k === 'li') { pCount++; continue; }
    if (b.k === 'i' && b.img && b.img.url) {
      out.push({
        url: b.img.url,
        source: pCount <= 1 ? 'body_lead' : 'body',
        attrs: { alt: b.img.alt || '' },
        cap: b.img.cap || '',
        insideFigure: true,
        pos: pCount,
      });
    }
  }
  return out;
}

function extractFeedImageCandidates(xmlBlock, baseUrl) {
  const b = String(xmlBlock || '');
  const rawList = [];
  const dec = s => EXTRACT.decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());

  const custom = b.match(/<img>\s*([^<\s]+)\s*<\/img>/i);
  if (custom) rawList.push(dec(custom[1]));

  for (const m of b.matchAll(/<media:(?:content|thumbnail)\b[^>]*>/gi)) {
    const a = EXTRACT.parseAttrs(m[0]);
    if (a.medium && !/image/i.test(a.medium)) continue;
    if (a.type && !/^image\//i.test(a.type)) continue;
    if (a.url) rawList.push(dec(a.url));
  }
  for (const m of b.matchAll(/<enclosure\b[^>]*>/gi)) {
    const a = EXTRACT.parseAttrs(m[0]);
    if (a.type && !/^image/i.test(a.type)) continue;
    if (!a.type && a.url && /\.(?:mp3|mp4|m4a|wav|pdf|ogg)(\?|#|$)/i.test(a.url)) continue;
    if (a.url) rawList.push(dec(a.url));
  }
  const body = b.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) || b.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
  if (body) {
    for (const imgM of body[1].matchAll(/<img\b[^>]*>/gi)) {
      const a = EXTRACT.parseAttrs(imgM[0]);
      const src = a['data-src'] || a['data-original'] || a.src;
      if (src) rawList.push(dec(src));
    }
  }

  const out = [];
  const seen = new Set();
  for (const r of rawList) {
    const abs = resolveUrl(r, baseUrl);
    if (!abs) continue;
    const up = upgradeImage(abs);
    if (seen.has(up)) continue;
    const chk = classifyCandidateUrl(up, { role: 'hero' });
    if (!chk.ok) continue;
    seen.add(up);
    out.push(up);
  }
  return out;
}

function feedImage(xmlBlock, baseUrl = 'https://localhost/') {
  return extractFeedImageCandidates(xmlBlock, baseUrl)[0] || '';
}

function isHijackedHtml(articleUrl, finalUrl, html, fromProxy, wireTitle = '') {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = EXTRACT.rdInline(m ? m[1] : '');
  if (fromProxy && /(?:slot\s*gacor|maxwin|togel|judol|scatter|linkpetir|situs\s*slot|judi\s*online)/i.test(title)) return true;
  if (!finalUrl || regDomain(finalUrl) === regDomain(articleUrl)) return false;
  const toks = new Set(String(new URL(articleUrl).pathname).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 3));
  if (wireTitle) {
    for (const w of String(wireTitle).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      if (w.length > 3) toks.add(w);
    }
  }
  if (!toks.size) return false;
  const meta = EXTRACT.rdMeta(html);
  const pageText = (title + ' ' + String(meta['og:title'] || '')).toLowerCase();
  for (const w of toks) if (pageText.includes(w)) return false;
  return true;
}

const PRIORITY_TIERS = ['body_lead', 'og', 'twitter', 'ld', 'meta', 'body', 'rss'];

async function runBounded(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveArticleMedia({
  requestedUrl,
  canonicalUrl,
  html = null,
  jinaMarkdown = null,
  rssImgs = [],
  rssImg = '',
  mode = 'hero',
  method = 'html',
  wireTitle = '',
  probeFn,
  reuseTracker = null,
  cacheHit = false,
  upstreamStatus = 'ok',
}) {
  const targetUrl = canonicalUrl || canonicalArticleUrl(requestedUrl) || requestedUrl;
  const discovered = [];
  const rejected = [];
  const rawCands = [];

  if (html && !jinaMarkdown) {
    const { bodyCands, metaCands } = extractHtmlImageCandidates(html, targetUrl);
    rawCands.push(...bodyCands, ...metaCands);
  } else {
    if (html) {
      const { metaCands } = extractHtmlImageCandidates(html, targetUrl);
      rawCands.push(...metaCands);
    }
    if (jinaMarkdown) {
      rawCands.push(...extractJinaImageCandidates(jinaMarkdown, targetUrl, wireTitle));
    }
  }

  const rssList = [...(Array.isArray(rssImgs) ? rssImgs : []), ...(rssImg ? [rssImg] : [])];
  for (const ru of rssList) {
    const resolved = resolveUrl(ru, targetUrl);
    if (resolved) rawCands.push({ url: resolved, source: 'rss', attrs: {} });
  }

  const tierRank = s => { const idx = PRIORITY_TIERS.indexOf(s); return idx >= 0 ? idx : 99; };
  const byUrl = new Map();
  for (const c of rawCands) {
    discovered.push({ url: c.url, source: c.source });
    const up = upgradeImage(c.url);
    const key = up;
    const prev = byUrl.get(key);
    if (!prev || tierRank(c.source) < tierRank(prev.source)) {
      byUrl.set(key, { ...c, url: up, rawUrl: c.url });
    }
  }

  const preValidated = [];
  for (const c of byUrl.values()) {
    const urlCheck = classifyCandidateUrl(c.url, { role: 'any' });
    if (!urlCheck.ok) {
      rejected.push({ url: c.url, source: c.source, reason: urlCheck.reason });
      continue;
    }
    const attrCheck = classifyCandidateAttrs(c.attrs || {});
    if (!attrCheck.ok) {
      rejected.push({ url: c.url, source: c.source, reason: attrCheck.reason });
      continue;
    }
    if (reuseTracker && reuseTracker.isReused(targetUrl, c.url)) {
      rejected.push({ url: c.url, source: c.source, reason: 'reused_site_asset' });
      continue;
    }
    preValidated.push(c);
  }

  const attrArea = c => {
    const rawW = String((c.attrs && c.attrs.width) || '').trim();
    const rawH = String((c.attrs && c.attrs.height) || '').trim();
    if (rawW.endsWith('%') || rawH.endsWith('%')) return 1;
    const w = parseInt(rawW || '0', 10) || 0;
    const h = parseInt(rawH || '0', 10) || 0;
    if (w > 0 && w < 320) return -1;
    if (h > 0 && h < 180) return -1;
    return w > 0 ? 1 : 0;
  };
  const ordered = preValidated.slice().sort((a, b) => {
    const td = tierRank(a.source) - tierRank(b.source);
    if (td !== 0) return td;
    return attrArea(b) - attrArea(a);
  });
  const maxProbes = mode === 'full' ? 14 : 8;
  const pickProbeQueue = (cands, limit) => {
    if (cands.length <= limit) return cands;
    const quotas = mode === 'full'
      ? [['body_lead', 4], ['og', 2], ['twitter', 1], ['ld', 1], ['meta', 1], ['rss', 1]]
      : [['body_lead', 3], ['og', 2], ['twitter', 1], ['ld', 1], ['rss', 1]];
    const picked = [];
    const seenPick = new Set();
    for (const [tier, cap] of quotas) {
      let n = 0;
      for (const c of cands) {
        if (picked.length >= limit || n >= cap) break;
        if (c.source === tier && !seenPick.has(c)) {
          seenPick.add(c);
          picked.push(c);
          n++;
        }
      }
    }
    for (const c of cands) {
      if (picked.length >= limit) break;
      if (!seenPick.has(c)) {
        seenPick.add(c);
        picked.push(c);
      }
    }
    return picked.sort((a, b) => tierRank(a.source) - tierRank(b.source));
  };
  const toProbe = pickProbeQueue(ordered, maxProbes);

  let attempted = 0, verifiedCount = 0, failedCount = 0;
  let sawTransientError = false;
  let sawDefinitiveFail = false;

  const probeCandidate = async c => {
    attempted++;
    const tryUrls = c.rawUrl && c.rawUrl !== c.url ? [c.url, c.rawUrl] : [c.url];
    let probeRes = null;
    for (const u of tryUrls) {
      try {
        probeRes = await probeFn(u, targetUrl);
      } catch (e) {
        probeRes = { ok: false, reason: 'probe_exception', transient: true, detail: String(e && e.message || e) };
      }
      if (probeRes && probeRes.ok) {
        return { cand: c, url: probeRes.finalUrl || u, probe: probeRes };
      }
    }
    failedCount++;
    if (probeRes && probeRes.transient) sawTransientError = true;
    else sawDefinitiveFail = true;
    rejected.push({
      url: c.url,
      source: c.source,
      reason: (probeRes && probeRes.reason) || 'probe_failed',
      detail: probeRes && probeRes.detail,
    });
    return null;
  };

  let probed = [];
  if (mode === 'hero' && toProbe.length > 4) {
    const fastBatch = toProbe.slice(0, 4);
    const restBatch = toProbe.slice(4);
    const fastRes = await runBounded(fastBatch, 4, probeCandidate);
    probed.push(...fastRes);
    let bestFastTier = 99;
    for (const r of fastRes) {
      if (!r) continue;
      const roleChk = classifyCandidateUrl(r.url, { role: 'hero' });
      const mv = roleChk.ok && validateImageMetrics({ role: 'hero', source: r.cand.source, dim: r.probe, bytes: r.probe.bytes, mime: r.probe.mime, insideFigure: r.cand.insideFigure });
      if (mv && mv.ok) bestFastTier = Math.min(bestFastTier, tierRank(r.cand.source));
    }
    const minRestTier = restBatch.reduce((m, c) => Math.min(m, tierRank(c.source)), 99);
    if ((bestFastTier > 1 || minRestTier < bestFastTier) && restBatch.length) {
      probed.push(...await runBounded(restBatch, 4, probeCandidate));
    }
  } else {
    probed = await runBounded(toProbe, 4, probeCandidate);
  }

  const verifiedPool = [];
  for (const r of probed) {
    if (!r) continue;

    const finalCheck = classifyCandidateUrl(r.url, { role: 'any' });
    if (!finalCheck.ok) {
      rejected.push({ url: r.url, source: r.cand.source, reason: finalCheck.reason + '_after_redirect' });
      continue;
    }
    if (reuseTracker && reuseTracker.isReused(targetUrl, r.url, r.probe.fingerprint)) {
      rejected.push({ url: r.url, source: r.cand.source, reason: 'reused_site_asset' });
      continue;
    }
    verifiedCount++;
    verifiedPool.push(r);
  }

  let selectedHero = null;
  const heroEligible = [];
  for (const r of verifiedPool) {
    const roleChk = classifyCandidateUrl(r.url, { role: 'hero' });
    if (!roleChk.ok) {
      rejected.push({ url: r.url, source: r.cand.source, reason: roleChk.reason });
      continue;
    }
    const mv = validateImageMetrics({
      role: 'hero',
      source: r.cand.source,
      dim: r.probe,
      bytes: r.probe.bytes,
      mime: r.probe.mime,
      insideFigure: r.cand.insideFigure,
    });
    if (!mv.ok) {
      rejected.push({ url: r.url, source: r.cand.source, reason: mv.reason, detail: mv.detail });
      continue;
    }
    heroEligible.push({ ...r, aspectRatio: mv.aspectRatio });
  }

  for (const tier of PRIORITY_TIERS) {
    const tierItems = heroEligible.filter(x => x.cand.source === tier);
    if (!tierItems.length) continue;
    if (tier === 'body_lead') {
      const landscape = tierItems.find(x => x.aspectRatio >= 1.05);
      if (landscape) { selectedHero = landscape; break; }
      const hasLandscapeOg = heroEligible.some(x => (x.cand.source === 'og' || x.cand.source === 'twitter') && x.aspectRatio >= 1.15);
      if (hasLandscapeOg) continue;
    }

    tierItems.sort((a, b) => ((b.probe.w >= 600 ? 1 : 0) - (a.probe.w >= 600 ? 1 : 0)) || (b.probe.w - a.probe.w));
    selectedHero = tierItems[0];
    break;
  }

  if (selectedHero) {
    const hk = imageKey(selectedHero.url);
    const hfp = selectedHero.probe.fingerprint;
    const betterSamePhoto = heroEligible.find(x =>
      x !== selectedHero &&
      (imageKey(x.url) === hk || (hfp && x.probe.fingerprint === hfp)) &&
      x.probe.w > selectedHero.probe.w + 150
    );
    if (betterSamePhoto) {
      selectedHero = { ...betterSamePhoto, cand: { ...betterSamePhoto.cand, source: selectedHero.cand.source } };
    }
    if (reuseTracker) {
      reuseTracker.record(targetUrl, selectedHero.url, selectedHero.probe.fingerprint);
    }
  }

  const bodyImages = [];
  if (mode === 'full') {
    const seenBodyUrl = new Set();
    const seenBodyKeys = new Set();
    const seenBodyFp = new Set();
    const hKey = selectedHero ? imageKey(selectedHero.url) : '';
    const hFp = selectedHero ? selectedHero.probe.fingerprint : '';
    const hDir = selectedHero ? dirKey(selectedHero.url) : '';
    const hDirUniq = hDir.length >= 6 && /\d/.test(hDir);

    const bodyCandidatesInOrder = verifiedPool
      .filter(x => x.cand.source === 'body_lead' || x.cand.source === 'body')
      .sort((a, b) => (a.cand.pos ?? 999) - (b.cand.pos ?? 999));

    let firstBody = true;
    for (const item of bodyCandidatesInOrder) {
      const wasFirst = firstBody;
      firstBody = false;
      const u = item.url;
      const ik = imageKey(u);
      const fp = item.probe.fingerprint;
      if (selectedHero) {
        if (u === selectedHero.url || ik === hKey || (hFp && fp === hFp)) continue;
        if (wasFirst && hDirUniq && dirKey(u) === hDir) continue;
      }
      if (seenBodyUrl.has(u) || seenBodyKeys.has(ik) || (fp && seenBodyFp.has(fp))) continue;
      const mv = validateImageMetrics({
        role: 'body',
        source: item.cand.source,
        dim: item.probe,
        bytes: item.probe.bytes,
        mime: item.probe.mime,
        insideFigure: item.cand.insideFigure,
      });
      if (!mv.ok) {
        rejected.push({ url: u, source: item.cand.source, reason: mv.reason, detail: mv.detail });
        continue;
      }
      seenBodyUrl.add(u);
      seenBodyKeys.add(ik);
      if (fp) seenBodyFp.add(fp);
      bodyImages.push({
        url: u,
        cap: item.cand.cap || '',
        width: item.probe.w,
        height: item.probe.h,
        aspectRatio: mv.aspectRatio,
        mime: item.probe.mime,
        bytes: item.probe.bytes,
        fingerprint: fp,
        source: item.cand.source,
        verified: true,
        ...(item.probe.viaBot || item.probe.viaWeserv ? { proxy: true } : {}),
        pos: item.cand.pos ?? 0,
      });
      if (bodyImages.length >= 8) break;
    }
  }

  let heroStatus = 'verified';
  if (!selectedHero) {
    if (!discovered.length) heroStatus = 'no_candidates';
    else if (sawTransientError && !sawDefinitiveFail) heroStatus = 'probe_transient_failure';
    else heroStatus = 'rejected';
  }

  const hero = selectedHero ? {
    url: selectedHero.url,
    source: selectedHero.cand.source,
    method: selectedHero.cand.source === 'rss' ? 'rss' : method,
    width: selectedHero.probe.w,
    height: selectedHero.probe.h,
    aspectRatio: selectedHero.aspectRatio,
    bytes: selectedHero.probe.bytes,
    mime: selectedHero.probe.mime,
    verified: true,
    ...(selectedHero.probe.viaBot || selectedHero.probe.viaWeserv ? { proxy: true } : {}),
    status: 'verified',
    fingerprint: selectedHero.probe.fingerprint,
    caption: selectedHero.cand.cap || '',
  } : {
    url: '',
    source: 'none',
    method: 'none',
    width: 0,
    height: 0,
    aspectRatio: 0,
    bytes: 0,
    mime: '',
    verified: false,
    status: heroStatus,
    fingerprint: '',
    caption: '',
  };

  return {
    schemaVersion: PIPELINE_VERSION,
    requestedUrl,
    canonicalUrl: targetUrl,
    hero,
    bodyImages,
    transientFailure: !selectedHero && sawTransientError && !sawDefinitiveFail,
    diagnostics: {
      discovered,
      selected: selectedHero ? {
        url: hero.url,
        source: hero.source,
        width: hero.width,
        height: hero.height,
        aspectRatio: hero.aspectRatio,
        mime: hero.mime,
        bytes: hero.bytes,
      } : null,
      rejected,
      probeStats: { attempted, verified: verifiedCount, failed: failedCount },
      cacheHit: !!cacheHit,
      upstreamStatus,
    },
  };
}

module.exports = {
  PIPELINE_VERSION,
  canonicalArticleUrl,
  regDomain,
  resolveUrl,
  upgradeImage,
  imageKey,
  dirKey,
  rdSmallHint,
  rdJunkUrl,
  RD_IMG_JUNK,
  RD_JUNK_URL,
  RD_JUNK_BASE,
  classifyCandidateUrl,
  classifyCandidateAttrs,
  imageSize,
  inspectImageBuffer,
  validateImageMetrics,
  AssetReuseTracker,
  extractHtmlImageCandidates,
  extractJinaImageCandidates,
  extractFeedImageCandidates,
  feedImage,
  isHijackedHtml,
  resolveArticleMedia,
};
