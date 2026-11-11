'use strict';

const FEEDTEXT = require('./feedtext');
const WireCore = require('./public/wire-core');

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', bull: '•', middot: '·', copy: '©', reg: '®',
  trade: '™', ntilde: 'ñ', Ntilde: 'Ñ', eacute: 'é', Eacute: 'É',
  egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú',
  uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', acirc: 'â', ecirc: 'ê',
  ocirc: 'ô', icirc: 'î', ucirc: 'û', szlig: 'ß', oslash: 'ø', aring: 'å',
  aelig: 'æ', iexcl: '¡', iquest: '¿', plusmn: '±', frac12: '½',
  shy: '', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  deg: '°', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥',
  sect: '§', para: '¶',
};

const rdChr = n => {
  try {
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch (e) {
    return '';
  }
};

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => rdChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => rdChr(+d))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, n) => ENT[n.toLowerCase()] != null ? ENT[n.toLowerCase()] : m);
}

function rdClean(s) {
  return decodeEntities(
    String(s == null ? '' : s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|figcaption|tr|section|article)>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const rdInline = s => rdClean(s).replace(/\s+/g, ' ').trim();
const rdHost = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };

function parseAttrs(tagStr) {
  const o = {};
  const body = String(tagStr || '').replace(/^<\s*[a-zA-Z0-9:-]+/, '').replace(/\/?\s*>$/, '');
  for (const m of body.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const k = m[1].toLowerCase();
    const rawVal = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    o[k] = decodeEntities(rawVal);
  }
  return o;
}

function rdAbs(u, base) {
  if (!u) return '';
  const raw = decodeEntities(String(u).trim());
  if (!raw || /^(?:data:|javascript:|blob:|mailto:|tel:|about:)/i.test(raw)) return '';
  try {
    const x = new URL(raw, base);
    return /^https?:$/i.test(x.protocol) ? x.href : '';
  } catch (e) {
    return '';
  }
}

const BOT_CHALLENGE_RE = /captcha|recaptcha|lsrecaptcha|cf-chl|cf-turnstile|challenge-platform|just a moment|attention required|access denied|verify you are|are you a robot|human verification|checking your browser|please wait while we verify|enable javascript and cookies|bot verification|ddos-guard|pardon our interruption|security check|sorry, you have been blocked|situs ini mungkin memblokir|requiring captcha/i;
const ERROR_PAGE_RE = /^(?:404\s*(?:not\s*found|error)?|page\s*not\s*found|error\s*40[34]|403\s*forbidden|50[0234]\s*(?:bad gateway|service unavailable|gateway time-?out)?|halaman\s+tidak\s+ditemukan|artikel\s+tidak\s+ditemukan|maaf,?\s+halaman\s+yang\s+anda\s+cari\s+tidak\s+ditemukan|oops!?\s*that\s+page\s+can'?t\s+be\s+found)$/i;

function rdMeta(html) {
  const out = {};
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const k = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (!k || !a.content) continue;
    const val = rdInline(a.content);
    if (val && !/^(undefined|null|nan|\[object object\])$/i.test(val)) {
      if (!out[k]) out[k] = val;
    }
  }
  return out;
}

function rdLd(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const raw = m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
      if (!raw) continue;
      const j = JSON.parse(raw);
      const stack = Array.isArray(j) ? [...j] : [j];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.unshift(...n); continue; }
        out.push(n);
        if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
        if (n.mainEntity && typeof n.mainEntity === 'object') stack.push(n.mainEntity);
      }
    } catch (e) {}
  }
  return out;
}

function rdName(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return rdName(v[0]);
  if (typeof v === 'object') return v.name || v.headline || '';
  return '';
}

function findMatchingClose(html, openEndIdx, tagName) {
  const re = new RegExp('<(\\/?)' + tagName + '(?=[\\s/>])([^>]*)>', 'gi');
  re.lastIndex = openEndIdx;
  let depth = 1;
  let m;
  while ((m = re.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const selfClose = !isClose && /\/\s*$/.test(m[2] || '');
    if (selfClose) continue;
    depth += isClose ? -1 : 1;
    if (depth === 0) {
      return { innerEnd: m.index, outerEnd: m.index + m[0].length };
    }
  }
  return null;
}

function stripElementsByTag(html, tags, opts = {}) {
  let s = String(html || '');

  if (opts.unwrapNoscriptImages) {
    s = s.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi, (m, inner) =>
      /<(?:img|amp-img)\b/i.test(inner) ? inner : ' '
    );
  }
  const tagSet = tags.join('|');
  const openRe = new RegExp('<(' + tagSet + ')\\b([^>]*)>', 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = openRe.exec(s)) !== null) {
    const tag = m[1].toLowerCase();
    const attrStr = m[2] || '';
    const start = m.index;
    const openEnd = start + m[0].length;
    if (/\/\s*$/.test(attrStr)) {
      out += s.slice(last, start) + ' ';
      last = openEnd;
      continue;
    }
    const close = findMatchingClose(s, openEnd, tag);
    if (!close) continue;

    if (tag === 'header' && opts.preserveHeaderFigures) {
      const inner = s.slice(openEnd, close.innerEnd);
      if (/<h1\b/i.test(inner) && /<(?:figure|img|amp-img)\b/i.test(inner) && !/<nav\b/i.test(inner)) {
        continue;
      }
    }
    out += s.slice(last, start) + ' ';
    last = close.outerEnd;
    openRe.lastIndex = close.outerEnd;
  }
  out += s.slice(last);
  return out;
}

const ARTICLE_BODY_KEEP_RE = /(?:detail-desc|article-content|article-body|content-detail|detail-content|post-content|entry-content|berita-content|field-name-body|txt-berita|detail_body|news-content|content-body|post-body|article__body|detail__body-text|itp_bodycontent|detail__body|txt-article|detail-text|article-content-body|read__content|read__article|story-body|artikel-isi|isi-berita)/i;

const JUNK_BOX_TOKEN_RE = /(?:^|[\s_-])(?:reactions?|rating|emoticons?|emoji|votes?|polls?|like-box|dislike|social-share|article-tools|post-tools|share-tools|share-box|share-bar|share-buttons?|follow-us|komentar|comments?(?:-box|-list|-section|-area)?|disqus|author-(?:box|card|img|image|photo|profile|info|bio|wrap|detail)|wartawan|penulis|byline|redaksi|editor-box|profile-(?:box|img|image)|related(?:-(?:news|articles?|posts?|stories|box|wrap|list|section))?|baca-juga|baca_juga|bacajuga|berita-terkait|artikel-terkait|linksisip|sisip|recommend(?:ed|ations?)?|most-read|most-popular|injected|widget|latest-(?:news|post|stories)|popular(?:-(?:news|post|box))?|trending|berita-lain|more-(?:news|stories)|also-read|you-may|jnews_|td-related|jeg_(?:block|sidebar)|advert(?:isement|orial)?|iklan|ad-(?:slot|box|unit|banner|container|wrap)|ads-(?:box|slot|wrap|container)|sponsor(?:ed)?|stripbanner|ticker|breaking-news|see-also|summary-article|read-page--summary|inbetween|banner_article_slide|newsletter|subscribe(?:-box|-form)?|cookie(?:-banner|-notice|-consent|-popup)?|gdpr|breadcrumb|pagination|page-nav|tag-list|tags-box|topik-terkait|sr-only|visually-hidden|screen-reader|assistive)(?:$|[\s_-])/i;

const SIDEBAR_NEG_RE = /(?:no|without|has|with)-sidebar|sidebar-layout/i;

function isJunkContainerAttr(attrStr) {
  const s = String(attrStr || '');
  if (/\shidden(?:\s|=|$)|aria-hidden\s*=\s*["']true["']/i.test(s)) return true;
  const a = parseAttrs('<div ' + s + '>');
  const combined = [a.class, a.id, a.role, a['data-testid'], a['aria-label'], a['data-component']]
    .filter(Boolean).join(' ');
  if (!combined) return false;
  if (ARTICLE_BODY_KEEP_RE.test(combined)) return false;
  if (JUNK_BOX_TOKEN_RE.test(combined)) return true;
  if (/(?:^|[\s_-])sidebar(?:$|[\s_-])/i.test(combined) && !SIDEBAR_NEG_RE.test(combined)) return true;
  if (/(?:^|[\s_-])(?:banner|promo)(?:$|[\s_-])/i.test(combined) && !/(?:hero|lead|article|main|cover)/i.test(combined)) return true;
  return false;
}

function stripJunkContainers(html) {
  let s = String(html || '');
  const openRe = /<(div|span|p|section|ul|ol|table|figure|aside|dl)\b([^>]*)>/gi;
  for (let pass = 0; pass < 3; pass++) {
    let out = '';
    let last = 0;
    let changed = false;
    openRe.lastIndex = 0;
    let m;
    while ((m = openRe.exec(s)) !== null) {
      const tag = m[1].toLowerCase();
      const attrStr = m[2] || '';
      if (!isJunkContainerAttr(attrStr)) continue;
      const start = m.index;
      const openEnd = start + m[0].length;
      if (/\/\s*$/.test(attrStr)) {
        out += s.slice(last, start) + ' ';
        last = openEnd;
        changed = true;
        continue;
      }
      const close = findMatchingClose(s, openEnd, tag);
      if (!close) continue;

      if ((close.outerEnd - start) > s.length * 0.75) continue;
      out += s.slice(last, start) + ' ';
      last = close.outerEnd;
      openRe.lastIndex = close.outerEnd;
      changed = true;
    }
    out += s.slice(last);
    s = out;
    if (!changed) break;
  }
  return s;
}

function stripCardLinks(s, base) {
  let basePath = '';
  try { basePath = new URL(base).pathname; } catch (e) {}
  return String(s || '').replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (m, at, inner) => {
    if (!/<(?:img|amp-img)\b/i.test(inner)) return m;
    const href = (at.match(/href\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (!href || href[0] === '#' || /\.(?:jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(href)) return m;
    const txt = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/<h[1-6]\b/i.test(inner) || txt.length > 25) return ' ';
    try {
      const h = new URL(href, base);
      if (h.pathname.length > 8 && h.pathname !== basePath) return ' ';
    } catch (e) {}
    return m;
  });
}

function stripLinkBlocks(s) {
  let out = String(s || '').replace(
    /<(h[1-6]|span|strong|b|p|em|i|label)\b[^>]*>\s*(?:baca|simak|lihat|baca juga|simak juga|lihat juga|selengkapnya|berita terkait|artikel terkait)\s*:?\s*<\/\1\s*>/gi,
    ' '
  );
  const re = /<(p|li|h[1-6]|div|span|td)\b[^>]*>((?:(?!<\/?(?:p|li|div|ul|ol|h[1-6]|section|article|table|tr)\b)[\s\S])*?)<\/\1\s*>/gi;
  out = out.replace(re, (m, t, inner) => {
    if (!/<a\b/i.test(inner)) return m;
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain || plain.length > 240) return m;
    let linked = 0;
    for (const a of inner.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      linked += a[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    }
    return linked / plain.length >= 0.8 ? ' ' : m;
  });
  return out;
}

const RD_CONT_RE = /<(article|div|section|main)\b[^>]*(?:(?:class|id)\s*=\s*["'][^"']*(?:detail-desc|article-content|article-body|content-detail|detail-content|post-content|entry-content|berita-content|field-name-body|txt-berita|detail_body|news-content|content-body|post-body|article__body|detail__body-text|itp_bodycontent|detail__body|txt-article|side-article|detail-text|article-content-body|read__content|read__article|story-body|artikel-isi|isi-berita)[^"']*["']|itemprop\s*=\s*["']articleBody["'])[^>]*>/gi;
const RD_LEAD_MEDIA_RE = /<(div|figure|section)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:detail__media|detail-image|photo__wrap|photo-cover|featured-image|post-thumbnail|article-photo|cover-photo|img-article|media-cover|max-card__image|artimg)[^"']*["'][^>]*>/gi;
const RD_LEAD_IMG_TAG_RE = /<img\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:featured[-_]?img|featured[-_]?image|article[-_]?featured|post[-_]?thumbnail|hero[-_]?img|detail[-_]?img|cover[-_]?img|wp-post-image)[^"']*["'][^>]*>/gi;

function extractMatchedElements(html, openRe) {
  const out = [];
  const re = new RegExp(openRe.source, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    const close = findMatchingClose(html, openEnd, tag);
    if (close) {
      out.push({ html: html.slice(openEnd, close.innerEnd), full: html.slice(m.index, close.outerEnd), index: m.index });
    }
  }
  return out;
}

function extractContainers(html) {
  const s = String(html || '');
  const bodyContainers = [];
  const leadMediaContainers = [];

  for (const el of extractMatchedElements(s, RD_CONT_RE)) {
    bodyContainers.push({ kind: 'selector', html: el.html, index: el.index });
  }
  for (const el of extractMatchedElements(s, /<(article)\b[^>]*>/gi)) {
    bodyContainers.push({ kind: 'article', html: el.html, index: el.index });
  }
  for (const el of extractMatchedElements(s, /<(main)\b[^>]*>/gi)) {
    bodyContainers.push({ kind: 'main', html: el.html, index: el.index });
  }
  for (const el of extractMatchedElements(s, RD_LEAD_MEDIA_RE)) {
    leadMediaContainers.push(el.full);
  }
  const leadImgScanHtml = stripElementsByTag(s, ['script', 'style', 'svg', 'form', 'nav', 'aside', 'footer']);
  for (const m of leadImgScanHtml.matchAll(RD_LEAD_IMG_TAG_RE)) {
    leadMediaContainers.push(m[0]);
  }

  const cleanedFull = stripElementsByTag(s, ['script', 'style', 'svg', 'form', 'nav', 'aside', 'footer', 'header', 'button', 'select', 'textarea', 'template', 'dialog', 'menu'], { unwrapNoscriptImages: true });
  bodyContainers.push({ kind: 'full', html: cleanedFull, index: 0 });

  return { bodyContainers, leadMediaContainers };
}

const VID_IFRAME = /(?:youtube\.com\/(?:embed|shorts)\/|youtube-nocookie\.com\/(?:embed|shorts)\/|youtu\.be\/|player\.vimeo\.com\/|facebook\.com\/plugins\/video|\/embed\/|\/player\/|\/video-embed\/)/i;
const VID_FILE = /\.(mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i;
const rdYT = u => {
  const m = String(u).match(/(?:youtube\.com\/(?:embed|shorts)\/|youtu\.be\/|youtube-nocookie\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{6,15})/i);
  return m ? 'https://www.youtube.com/embed/' + m[1] : '';
};

function rdVideoEl(tag, finalURL) {
  if (/^<iframe/i.test(tag)) {
    const a = parseAttrs(tag);
    const u = rdAbs(a.src, finalURL);
    if (!u) return null;
    const yt = rdYT(u);
    if (yt) return { url: yt, kind: 'iframe', poster: '' };
    if (VID_IFRAME.test(u) && !VID_FILE.test(u)) return { url: u, kind: 'iframe', poster: '' };
    return null;
  }
  const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)/i) || [])[1]
    || (tag.match(/<source\b[^>]*\bsrc\s*=\s*["']([^"']+)/i) || [])[1];
  const u = rdAbs(src, finalURL);
  if (!u) return null;
  const poster = (tag.match(/\bposter\s*=\s*["']([^"']+)/i) || [])[1] || '';
  return { url: u, kind: 'video', poster: rdAbs(poster, finalURL) };
}

function isDummyVideoUrl(u) {
  const s = String(u || '').split('?')[0].split('#')[0];
  return /\/(?:uploads\/video|videos?|media)\/?$/i.test(s) && !VID_FILE.test(u) && !VID_IFRAME.test(u);
}

function rdExtractScriptVideos(html, finalURL, title = '', onTopicFn = null) {
  const sHtml = String(html || '');
  const vids = [];
  let scriptBody = '';
  let slugTokens = [];
  try {
    slugTokens = new URL(finalURL).pathname.split('/').filter(Boolean).filter(p => p.length >= 6);
  } catch {}
  const ytSlug = slugTokens.find(p => /^yt-/i.test(p)) || slugTokens[slugTokens.length - 1] || '';

  const ytEntries = [];
  for (const m of sHtml.matchAll(/["']?youtube_id["']?\s*:\s*["']([A-Za-z0-9_-]{6,15})["']/gi)) {
    const start = Math.max(0, sHtml.lastIndexOf('{', m.index));
    let end = sHtml.indexOf('},', m.index);
    const altEnd = sHtml.indexOf('}];', m.index);
    if (altEnd >= 0 && (end < 0 || altEnd < end)) end = altEnd;
    if (end < 0 || end - start > 12000) end = Math.min(sHtml.length, m.index + 5000);
    const obj = sHtml.slice(start, end);
    const nUrl = ((obj.match(/["']?(?:news_url|url)["']?\s*:\s*["']([^"']+)["']/i) || [])[1] || '').trim();
    const nImg = ((obj.match(/["']?(?:news_image|poster|thumbnail)["']?\s*:\s*["']([^"']+)["']/i) || [])[1] || '').trim();
    const vTitle = rdClean(((obj.match(/["']?title["']?\s*:\s*["']([^"']+)["']/i) || [])[1] || '').trim());
    let content = '';
    const bt = obj.match(/["']?content["']?\s*:\s*`([\s\S]*?)`/i);
    if (bt) content = bt[1];
    else {
      const qt = obj.match(/["']?content["']?\s*:\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/i);
      if (qt) content = qt[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    const slugHit = Boolean(ytSlug && nUrl && nUrl.toLowerCase().includes(ytSlug.toLowerCase()));
    ytEntries.push({ ytId: m[1], nUrl, nImg, vTitle, content, slugHit });
  }
  if (ytEntries.length) {
    const chosen = ytEntries.find(e => e.slugHit)
      || (ytEntries.length === 1 ? ytEntries[0] : null)
      || ytEntries.find(e => title && e.vTitle && (!onTopicFn || onTopicFn(title, '', [e.vTitle])));
    if (chosen) {
      vids.push({
        url: 'https://www.youtube.com/embed/' + chosen.ytId,
        kind: 'iframe',
        poster: rdAbs(chosen.nImg || '', finalURL),
      });
      if (chosen.content && chosen.content.trim().length >= 40) {
        scriptBody = chosen.content.replace(/#[A-Za-z0-9_]+/g, '').trim();
      }
    }
  }

  for (const m of sHtml.matchAll(/<meta[^>]+itemprop\s*=\s*["']embedURL["'][^>]+content\s*=\s*["']([^"']+)["']/gi)) {
    const u = rdAbs(m[1], finalURL);
    if (u && (rdYT(u) || VID_IFRAME.test(u))) vids.push({ url: rdYT(u) || u, kind: 'iframe', poster: '' });
  }
  for (const m of sHtml.matchAll(/"embedUrl"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/gi)) {
    const raw = m[1].replace(/\\\//g, '/');
    const u = rdAbs(raw, finalURL);
    if (u && (rdYT(u) || VID_IFRAME.test(u))) vids.push({ url: rdYT(u) || u, kind: 'iframe', poster: '' });
  }
  return { videos: vids, scriptBody };
}

function rdVideos(html, finalURL, dom = true, title = '', onTopicFn = null) {
  const out = [], seen = new Set();
  const abs = u => rdAbs(u || '', finalURL);
  const add = (u, kind, poster) => {
    u = abs(u); if (!u || isDummyVideoUrl(u)) return;
    const yt = rdYT(u);
    if (yt) { u = yt; kind = 'iframe'; }
    const k = u.split('?')[0] + '|' + kind;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ url: u, kind, poster: abs(poster || '') });
  };
  const meta = rdMeta(html);
  const mediaKind = u => VID_FILE.test(u) || /videoplayback|googlevideo|\.m3u8/i.test(u)
    ? 'video'
    : (VID_IFRAME.test(u) && !/\/(berita|news|article|read)\//i.test(u) ? 'iframe' : 'probe');
  for (const k of ['og:video', 'og:video:url', 'og:video:secure_url', 'og:video:mp4', 'twitter:player:stream']) {
    const u = abs(meta[k] || '');
    if (u) add(u, mediaKind(u), '');
  }
  const tplayer = abs(meta['twitter:player'] || '');
  if (tplayer && VID_IFRAME.test(tplayer)) add(tplayer, 'iframe');
  if (dom) {
    for (const m of String(html).matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
      const tag = m[0];
      const src = (tag.match(/\bsrc=["']([^"']+)/i) || [])[1]
        || (m[1].match(/<source\b[^>]*\bsrc=["']([^"']+)/i) || [])[1];
      const poster = (tag.match(/\bposter=["']([^"']+)/i) || [])[1];
      add(src, 'video', poster);
    }
    for (const m of String(html).matchAll(/<iframe\b[^>]*src=["']([^"']+)["']/gi)) {
      const u = abs(m[1]);
      const yt = rdYT(u);
      if (yt) { add(yt, 'iframe'); continue; }
      if (VID_IFRAME.test(u) && !VID_FILE.test(u)) add(u, 'iframe');
    }
  }
  for (const n of rdLd(html)) {
    if (!/video/i.test(String(n['@type'] || ''))) continue;
    const vTitle = String(n.name || '') + ' ' + String(n.description || '');
    if (title && vTitle.trim() && onTopicFn && !onTopicFn(title, '', [vTitle])) continue;
    const u = abs(n.contentUrl || n.embedUrl || '');
    if (u) add(u, mediaKind(u), n.thumbnailUrl);
  }
  const scriptRes = rdExtractScriptVideos(html, finalURL, title, onTopicFn);
  for (const sv of scriptRes.videos) add(sv.url, sv.kind, sv.poster);
  return out.slice(0, 4);
}

const RD_SKIP = /^(?:baca juga|simak juga|lihat juga|berita terkait|artikel terkait|advertisement|iklan|scroll(?:\s+untuk|\s+to)?|lanjutkan(?:\s+membaca)?|ikuti(?:\s+kami|\s+saluran|\s+channel|\s+whatsapp)?|bagikan|komentar|rekomendasi|topik(?:\s+terkait)?|tags?|sumber|foto|video|infografis|follow|newsletter|subscribe|langganan|whatsapp\s+channel|halaman\s+selanjutnya|artikel\s+selanjutnya)\b/i;
const RD_CREDIT = /\b(?:foto|istimewa|dok\.?|ilustrasi)\s*:/i;
const RD_BOILER = /baca berita terkini|berita terkini dan terpercaya|dapatkan (?:berita|update|info)|untuk mendapatkan berita|follow (?:channel|akun|kami)|ikuti (?:kami|saluran|channel|akun)|gabung (?:di )?(?:channel|grup|saluran)|lorem ipsum|all rights reserved|hak cipta|download aplikasi|unduh aplikasi|informasi seputar .{0,60}(?:bisa|dapat) diakses|bergabunglah|klik (?:di sini|link)|whatsapp channel|google news|dilarang (?:keras )?(?:mengambil|menyalin|mengutip|mengcopy)|crawling|pengindeksan otomatis|download sekarang|menyajikan berita terhangat|tinggalkan komentar|^©|^copyright|unduh .{0,30}app|install aplikasi|dapatkan notifikasi|aktifkan notifikasi|laporkan (?:iklan|konten)|unblock notifications|real[- ]time updates|know more|sign up for|subscribe to|berlangganan (?:untuk|newsletter|pos|email)|sponsored|advertisement|sumber (?:utama|pilihan|terpercaya) di google|preferred source|tambahkan .{0,40}sumber|tas darurat.{0,3}ada apa|isi komentar|tanggung jawab (?:pengguna|penulis komentar)|promo rp|jajan pakai|diskon hingga|beli sekarang|daftar sekarang|^(?:sumber|source)\s*:|^(?:editor|penulis|reporter|redaktur|kontributor|pewarta|fotografer)\s*:|(?:window|modal|dialog|jendela|log)\s*(?:ini|log)?[^.\n]{0,50}(?:ditutup|close)|(?:tekan|press|aktifkan|activate)[^.\n]{0,40}(?:escape|\besc\b|tombol tutup|close button|tombol close)|dapat ditutup dengan|situs ini menggunakan cookie|we use cookies|cookie policy|kebijakan privasi|terima semua cookie|accept all cookies/i;
const RD_END = /^(?:baca (?:juga|berita|selengkapnya)|simak (?:juga|berita)|berita (?:terkait|lainnya|terpopuler|populer|rekomendasi)|artikel (?:terkait|lainnya|populer|selanjutnya)|terpopuler|rekomendasi(?: untuk anda)?|tag:|topik:|related (?:news|articles?|posts?)|read (?:more|also)|you (?:may|might) (?:also )?like|karin adalah|apresiasi spesial|gabung membership|kamu bisa bertanya tentang|kontribusi (?:ini|yang) |tambahkan .{0,40}(?:sebagai|jadi) sumber|syarat dan ketentuan|disclaimer\b|komentar\s*(?:\(\d+\))?$|tulis komentar)/i;

const rdCaptionish = t => t.length < 220 && (
  /^[A-Z][A-Z0-9 ,'.&-]{5,45}\s[-–:]\s/.test(t) ||
  (/\([^()]*(?:\/|commons|photo|credit|foto)[^()]*\)\.?$/i.test(t) && t.length < 180) ||
  /^(?:ilustrasi|foto ilustrasi|foto|dok\.?|dokumentasi|gambar|suasana|caption)\s*[:\-–]/i.test(t) ||
  /\((?:foto|antara|dok|sumber|istimewa|reuters|afp|ap|getty)[^)]*\)?\.?$/i.test(t) ||
  /^[\w.-]+\.[a-z]{2,}(?:\/\S*)?…?$/i.test(t)
);

const rdGarbage = t => (t.match(/%[0-9A-F]{2}/gi) || []).length >= 3
  || /^(?:https?:\/\/|www\.)\S+$/i.test(t)
  || (t.match(/[\\{}<>|]/g) || []).length > 6;

const rdHeadlineish = t => {
  if (t.length > 160 || /[.!?"”')]$/.test(t) || /^[\d\-–•*·]/.test(t)) return false;
  const w = t.split(/\s+/).filter(x => /[A-Za-z]/.test(x));
  if (w.length < 4) return false;
  return w.filter(x => /^[A-Z0-9“"(]/.test(x)).length / w.length >= 0.6;
};

const RD_STOP = new Set('yang dan untuk dengan dari pada dalam akan atau juga tidak ini itu oleh para telah sudah bisa saat usai jadi lebih hingga serta kata kini ada sebagai antara bagi agar kembali ungkap soal terkait dalam atas bawah tentang karena agar bahwa seperti kami kita mereka kamu anda'.split(' '));

function topicTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !RD_STOP.has(w));
}

function rdOnTopic(title, desc, paras) {
  const tt = [...new Set(topicTokens(title))];
  if (tt.length < 2 || !paras || !paras.length) return true;
  const body = ' ' + topicTokens(paras.slice(0, 14).join(' ') + ' ' + (desc || '')).join(' ') + ' ';
  const hit = tt.filter(w => body.includes(' ' + w + ' ')).length;
  return hit >= Math.min(2, tt.length) && hit / tt.length >= 0.2;
}

function pruneBlocks(blocks, title, wireTitlesSet) {
  const wire = wireTitlesSet || new Set();
  const me = String(title || '').toLowerCase().replace(/\W+/g, ' ').trim();
  const nrm = t => t.toLowerCase().replace(/\W+/g, ' ').trim();
  let out = [];
  let boilerplateDropped = 0;
  let duplicateDropped = 0;
  const seenPara = new Set();

  for (const b of blocks) {
    if (b.k !== 'p' && b.k !== 'h' && b.k !== 'q' && b.k !== 'li') {
      out.push(b);
      continue;
    }
    const text = String(b.t || '').trim();
    if (!text) continue;
    if (BOT_CHALLENGE_RE.test(text)) { boilerplateDropped++; continue; }
    if (RD_END.test(text) && out.filter(x => x.k === 'p' || x.k === 'q' || x.k === 'li').length >= 2) break;
    if (RD_BOILER.test(text) && text.length < 280) { boilerplateDropped++; continue; }
    if (b.k !== 'h' && (rdCaptionish(text) || rdGarbage(text))) { boilerplateDropped++; continue; }
    if (/^(?:home|beranda|news|nasional|daerah)\s*[/›>»]/i.test(text)) { boilerplateDropped++; continue; }
    const n = nrm(text);
    if (me.length > 20 && (n === me || (n.includes(me) && n.length < me.length + 40))) {
      duplicateDropped++;
      continue;
    }
    if (n !== me && n.length > 25) {
      let hit = false;
      for (const w of wire) {
        if (n === w || (n.includes(w) && n.length < w.length + 25)) { hit = true; break; }
      }
      if (hit) { boilerplateDropped++; continue; }
    }
    const dk = n.slice(0, 150);
    if (seenPara.has(dk)) { duplicateDropped++; continue; }
    seenPara.add(dk);
    out.push(b);
  }

  const ps = out.filter(x => x.k === 'p' || x.k === 'q').map(x => x.t);
  out = out.filter(b => {
    if ((b.k !== 'p' && b.k !== 'q') || !/(?:…|\.\.\.)$/.test(b.t)) return true;
    const head = b.t.replace(/(?:…|\.\.\.)$/, '').trim().toLowerCase();
    if (head.length > 20 && ps.some(o => o !== b.t && o.toLowerCase().includes(head))) {
      duplicateDropped++;
      return false;
    }
    return true;
  });

  const keep = new Array(out.length).fill(true);
  for (let i = 0; i < out.length;) {
    if (out[i].k === 'p' && rdHeadlineish(out[i].t)) {
      let j = i;
      while (j < out.length && (out[j].k !== 'p' || rdHeadlineish(out[j].t))) j++;
      const run = out.slice(i, j).filter(x => x.k === 'p').length;
      if (run >= 2) {
        for (let q = i; q < j; q++) {
          if (out[q].k === 'p') { keep[q] = false; boilerplateDropped++; }
        }
      }
      i = j;
    } else i++;
  }

  return {
    blocks: out.filter((_, i) => keep[i]),
    boilerplateDropped,
    duplicateDropped,
  };
}

function pickBestSrcset(srcsetRaw, base) {
  if (!srcsetRaw) return '';
  const parts = String(srcsetRaw)
    .trim()
    .split(/(?<=\s\d+(?:\.\d+)?[wx])\s*,\s*|,\s+(?=(?:https?:)?\/\/|\/)/i);
  const candidates = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/i);
    if (!m) continue;
    const url = rdAbs(m[1], base);
    if (!url) continue;
    const val = m[2] ? parseFloat(m[2]) : 0;
    const unit = (m[3] || '').toLowerCase();
    const score = unit === 'w' ? val : unit === 'x' ? val * 600 : 100;
    candidates.push({ url, score, val, unit });
  }
  if (!candidates.length) return '';

  const wGood = candidates.filter(c => c.unit === 'w' && c.val >= 700 && c.val <= 1800);
  if (wGood.length) {
    wGood.sort((a, b) => b.val - a.val);
    return wGood[0].url;
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

function extractTagImage(tag, finalURL) {
  const a = parseAttrs(tag);
  const cls = ((a.class || '') + ' ' + (a.id || '') + ' ' + (a.role || '')).toLowerCase();
  if (/emoji|emoticon|reaction|rating|like|dislike|vote|poll|icon|avatar|logo|badge|smile|frown|share|social|author|wartawan|penulis|byline|banner|advert|iklan|promo|placeholder|spinner|loading/.test(cls)) {
    return null;
  }
  const alt = rdInline(a.alt || a.title || '');
  if (/^(?:like|dislike|vote|rate|bagus|jelek|setuju|tidak setuju|share|comment|komentar|emoji|logo|favicon|icon|avatar|iklan|advertisement)/i.test(alt)) {
    return null;
  }
  const rawW = String(a.width || '').trim();
  const rawH = String(a.height || '').trim();
  const w = (!rawW.endsWith('%') ? parseInt(rawW, 10) : 0) || 0;
  const h = (!rawH.endsWith('%') ? parseInt(rawH, 10) : 0) || 0;
  if ((w > 0 && w < 200) || (h > 0 && h < 120)) return null;
  if (w >= 200 && h > 0 && w / h > 3.2) return null;

  const candUrls = [];
  for (const k of ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-srcset', 'srcset', 'src']) {
    if (!a[k]) continue;
    if (k.endsWith('srcset')) {
      const u = pickBestSrcset(a[k], finalURL);
      if (u) candUrls.push(u);
    } else {
      const u = rdAbs(a[k], finalURL);
      if (u && !/(?:placeholder|blank|spacer|transparent|1x1|loading|lazy)\./i.test(u)) candUrls.push(u);
    }
  }
  const url = candUrls[0] || '';
  if (!url) return null;
  if (url.split('?')[0] === String(finalURL).split('?')[0]) return null;
  return { url, alt, attrs: a };
}

function rdBlocks(html, finalURL) {
  const blocks = [], paras = [], vids = [], vseen = new Set(), pseen = new Set();
  let s = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  s = stripElementsByTag(
    s,
    ['script', 'style', 'svg', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select', 'textarea', 'template', 'dialog', 'menu'],
    { unwrapNoscriptImages: true, preserveHeaderFigures: true }
  );

  {
    const openRe = /<article\b([^>]*)>/gi;
    let first = true;
    let out = '', last = 0, m;
    while ((m = openRe.exec(s)) !== null) {
      const start = m.index, openEnd = start + m[0].length;
      const close = findMatchingClose(s, openEnd, 'article');
      if (!close) continue;
      if (first) { first = false; continue; }
      out += s.slice(last, start) + ' ';
      last = close.outerEnd;
      openRe.lastIndex = close.outerEnd;
    }
    if (last > 0) s = out + s.slice(last);
  }
  s = stripJunkContainers(s);
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<video\b[^>]*>[\s\S]*?<\/video\s*>/gi, m => {
    if (vids.length >= 4) return ' ';
    const v = rdVideoEl(m, finalURL);
    if (!v) return ' ';
    const k = v.url.split('?')[0];
    if (vseen.has(k)) return ' ';
    vseen.add(k); vids.push(v);
    return '\n@@RDV' + (vids.length - 1) + '@@\n';
  });
  s = stripCardLinks(s, finalURL);
  s = stripLinkBlocks(s);

  const imgs = [], iseen = new Set();
  const addImg = (tag, cap, insideFigure) => {
    const im = extractTagImage(tag, finalURL);
    if (!im) return ' ';
    const normKey = im.url.split('?')[0].toLowerCase();
    if (iseen.has(normKey) || imgs.length >= 12) return ' ';
    iseen.add(normKey);
    let c = rdInline(cap || '');
    if (!c && im.alt.length >= 16) c = im.alt;
    imgs.push({ url: im.url, cap: c.slice(0, 220), alt: im.alt, attrs: im.attrs, insideFigure: !!insideFigure });
    return '\n@@RDI' + (imgs.length - 1) + '@@\n';
  };

  s = s.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure\s*>/gi, (m, inner) => {
    const t = inner.match(/<(?:img|amp-img)\b[^>]*>/i);
    if (!t) return ' ';
    const cap = (inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || '';
    return addImg(t[0], cap.replace(/<[^>]+>/g, ' '), true);
  });
  s = s.replace(/<(?:img|amp-img)\b[^>]*>/gi, m => addImg(m, '', false));

  s = s.replace(/<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, tag, inner) => '\n@@RDH@@' + inner + '\n');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_, inner) => '\n@@RDQ@@' + inner + '\n');
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => '\n@@RDL@@' + inner + '\n');
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, t) => '\u0001' + t.replace(/<[^>]+>/g, ' ') + '\u0002');

  for (let seg of rdClean(s).split('\n')) {
    let kind = 'p';
    if (seg.startsWith('@@RDH@@')) { kind = 'h'; seg = seg.slice(7); }
    else if (seg.startsWith('@@RDQ@@')) { kind = 'q'; seg = seg.slice(7); }
    else if (seg.startsWith('@@RDL@@')) { kind = 'li'; seg = seg.slice(7); }

    if (seg.indexOf('\u0001') >= 0) {
      let linked = 0;
      for (const lm of seg.matchAll(/\u0001([^\u0001\u0002]*)\u0002/g)) {
        linked += lm[1].replace(/@@RD[VI]\d+@@/g, ' ').trim().length;
      }
      const plain = seg.replace(/@@RD[VI]\d+@@/g, ' ').replace(/[\u0001\u0002]/g, '').replace(/\s+/g, ' ').trim();
      if (plain && plain.length <= 600 && linked / plain.length >= 0.8) continue;
    }
    seg = seg.replace(/[\u0001\u0002]/g, '');
    const parts = seg.split(/@@RD([VI])(\d+)@@/);
    for (let i = 0; i < parts.length; i++) {
      const mod = i % 3;
      if (mod === 1) {
        const mkind = parts[i], n = +parts[i + 1];
        i++;
        if (mkind === 'V' && vids[n]) blocks.push({ k: 'v', v: vids[n] });
        else if (mkind === 'I' && imgs[n]) blocks.push({ k: 'i', img: imgs[n] });
        continue;
      }
      if (mod === 2) continue;
      const t = parts[i].replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const minLen = kind === 'h' ? 8 : (kind === 'li' || kind === 'q') ? 18 : 30;
      const maxLen = kind === 'h' ? 140 : 1800;
      if (t.length < minLen || t.length > maxLen) continue;
      if (RD_SKIP.test(t) || (t.length < 120 && RD_CREDIT.test(t))) continue;
      if (/^(?:copyright|©|all rights reserved)/i.test(t)) continue;
      const k = t.toLowerCase().replace(/\W+/g, ' ').slice(0, 140);
      if (pseen.has(k)) continue;
      pseen.add(k);
      if (kind !== 'h') paras.push(t);
      blocks.push({ k: kind, t });
      if (paras.length >= 50) break;
    }
    if (paras.length >= 50) break;
  }
  return { blocks, paras, videos: vids, images: imgs };
}

function splitArticleBodyText(body) {
  let raw = String(body || '').trim();
  if (!raw) return [];
  if (/<(?:p|br|div|li|h[1-6])\b/i.test(raw)) {
    raw = rdClean(raw);
  } else {
    raw = decodeEntities(raw).replace(/\r\n/g, '\n');
  }
  let parts = raw.split(/\n+/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);

  if (parts.length <= 1 && raw.length > 420) {
    const sents = raw.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/);
    const grouped = [];
    let cur = '';
    for (const st of sents) {
      if (!st) continue;
      cur = cur ? cur + ' ' + st : st;
      if (cur.length >= 240) { grouped.push(cur); cur = ''; }
    }
    if (cur) {
      if (grouped.length && cur.length < 60) grouped[grouped.length - 1] += ' ' + cur;
      else grouped.push(cur);
    }
    parts = grouped;
  }
  return parts.filter(t => t.length >= 25 && t.length <= 1800).slice(0, 50);
}

function computeTextQuality({ title, expectedTitle, url, desc, blocks, boilerplateDropped = 0, duplicateDropped = 0 }) {
  const textBlocks = (blocks || []).filter(b => b.k === 'p' || b.k === 'q' || b.k === 'li');
  const paras = textBlocks.map(b => b.t);
  const paragraphCount = paras.length;
  const totalChars = paras.reduce((sum, p) => sum + p.length, 0);
  const totalRaw = paragraphCount + boilerplateDropped + duplicateDropped;
  const duplicateRatio = totalRaw > 0 ? +(duplicateDropped / totalRaw).toFixed(3) : 0;
  const boilerplateRatio = totalRaw > 0 ? +(boilerplateDropped / totalRaw).toFixed(3) : 0;

  const refTitle = expectedTitle || title || '';
  const tt = [...new Set(topicTokens(refTitle))];
  let headlineRelevance = 1;
  if (tt.length >= 2 && paras.length) {
    const body = ' ' + topicTokens(paras.slice(0, 14).join(' ') + ' ' + (desc || '')).join(' ') + ' ';
    const hit = tt.filter(w => body.includes(' ' + w + ' ')).length;
    headlineRelevance = +(hit / tt.length).toFixed(3);
  } else if (!paras.length) {
    headlineRelevance = 0;
  }

  let expectedMatch = true;
  if (expectedTitle && title) {
    const expToks = [...new Set(topicTokens(expectedTitle))];
    if (expToks.length >= 2) {
      const pageToks = ' ' + topicTokens(title + ' ' + paras.slice(0, 6).join(' ')).join(' ') + ' ';
      const hits = expToks.filter(w => pageToks.includes(' ' + w + ' ')).length;
      if (hits === 0 || (expToks.length >= 3 && hits / expToks.length < 0.2)) {
        expectedMatch = false;
      }
    }
  }

  const onOwnTopic = rdOnTopic(title, desc, paras);
  const isOnTopic = expectedMatch && onOwnTopic;
  const combinedSample = (title || '') + ' ' + (desc || '') + ' ' + paras.slice(0, 3).join(' ');
  const isChallengeOrError = BOT_CHALLENGE_RE.test(combinedSample) ||
    (paragraphCount <= 2 && ERROR_PAGE_RE.test(String(title || '').trim()));
  const isFullArticle = !isChallengeOrError && isOnTopic && (
    (paragraphCount >= 2 && totalChars >= 180) ||
    (paragraphCount >= 1 && totalChars >= 450)
  );

  return {
    paragraphCount,
    totalChars,
    headlineRelevance,
    duplicateRatio,
    boilerplateRatio,
    isOnTopic,
    isChallengeOrError,
    isFullArticle,
  };
}

function cleanArticleTitle(rawTitle, site, finalURL) {
  let title = rdClean(rawTitle || '');
  title = title.replace(/^(?:(?:breaking\s+news|berita\s+video|video|foto|live|eksklusif|update|terkini)\s*[-–—:]\s*)+/i, '').trim();
  const dc = title.match(/\s*::\s*(\S.{1,60}?)\s*$/);
  if (dc && site) {
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const tail = norm(dc[1]), s = norm(site);
    if (tail && (s.includes(tail) || tail.includes(s))) title = title.slice(0, dc.index).trim();
  }
  const sep = title.match(/\s*[|–—]\s*([^|–—]{2,45})\s*$/) || title.match(/\s+-\s+([^-]{2,45})\s*$/);
  if (sep) {
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const tail = norm(sep[1]);
    const host = rdHost(finalURL);
    const cands = [norm(site), norm(host), norm(host.replace(/\.[a-z]{2,8}$/i, ''))].filter(x => x.length >= 3);
    if (tail && cands.some(s => s === tail || s.includes(tail) || tail.includes(s))) {
      title = title.slice(0, sep.index).trim();
    }
  }
  return title;
}

function rdExtract(html, finalURL, opts = {}) {
  const sHtml = String(html || '');
  const meta = rdMeta(sHtml);
  const ld = rdLd(sHtml);
  const art = ld.find(n => /article|posting|news/i.test(String(n['@type'] || ''))) || {};
  const vid = ld.find(n => /video/i.test(String(n['@type'] || ''))) || {};
  const pubName = art.publisher && (typeof art.publisher === 'string' ? art.publisher : art.publisher.name);
  const site = WireCore.cleanSiteName(meta['og:site_name'] || pubName || '', finalURL);
  let rawTitle = meta['og:title'] || meta['twitter:title'] || rdName(art.headline) ||
    (sHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  if (!rawTitle) {
    const h1 = (sHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    if (h1) rawTitle = rdClean(h1);
  }
  let title = cleanArticleTitle(rawTitle, site, finalURL);
  if ((!title || title === rdHost(finalURL)) && opts.expectedTitle) {
    title = cleanArticleTitle(opts.expectedTitle, site, finalURL);
  }
  const rawDesc = meta['og:description'] || meta['twitter:description'] || meta.description ||
    (typeof art.description === 'string' ? art.description : '') || '';
  const byline = meta.author || meta['article:author'] || rdName(art.author) || '';
  const time = meta['article:published_time'] || meta['datepublished'] || art.datePublished || '';

  if (BOT_CHALLENGE_RE.test(title + ' ' + rawDesc) || (sHtml.length < 45000 && BOT_CHALLENGE_RE.test(sHtml))) {
    return {
      ok: false, url: finalURL, final: finalURL, title: title || rdHost(finalURL), site,
      byline, time: time ? String(time) : '', img: '', desc: '', paras: [], thin: true,
      isFallback: false, textSource: 'challenge', videos: [], blocks: [],
      extraction: { method: 'blocked', isFallback: false, quality: { paragraphCount: 0, totalChars: 0, headlineRelevance: 0, duplicateRatio: 0, boilerplateRatio: 0, isOnTopic: false, isChallengeOrError: true, isFullArticle: false } },
    };
  }

  const wireSet = opts.wireTitles || new Set();
  const { bodyContainers } = extractContainers(sHtml);
  const candidates = [];

  for (const cand of bodyContainers) {
    const rawBlk = rdBlocks(cand.html, finalURL);
    const pruned = pruneBlocks(rawBlk.blocks, title, wireSet);
    const q = computeTextQuality({
      title, expectedTitle: opts.expectedTitle, url: finalURL, desc: rawDesc,
      blocks: pruned.blocks, boilerplateDropped: pruned.boilerplateDropped, duplicateDropped: pruned.duplicateDropped,
    });
    const score = (q.isOnTopic ? 120 : -200)
      + Math.min(q.paragraphCount, 15) * 10
      + Math.min(q.totalChars / 180, 35)
      + (cand.kind === 'selector' ? 20 : cand.kind === 'article' ? 12 : cand.kind === 'main' ? 5 : 0)
      - q.boilerplateRatio * 40 - q.duplicateRatio * 40;
    candidates.push({
      method: cand.kind === 'selector' ? 'container_selector' : cand.kind === 'article' ? 'semantic_article' : cand.kind === 'main' ? 'semantic_main' : 'html_density',
      blocks: pruned.blocks,
      videos: rawBlk.videos,
      quality: q,
      score,
    });
    if (cand.kind !== 'full' && q.isFullArticle && q.paragraphCount >= 4 && q.totalChars >= 700) break;
  }

  const scriptVid = rdExtractScriptVideos(sHtml, finalURL, title, rdOnTopic);
  for (const [mName, bodyText] of [
    ['jsonld_articleBody', art.articleBody],
    ['jsonld_description', typeof art.description === 'string' && art.description.length > 160 ? art.description : ''],
    ['jsonld_video_desc', typeof vid.description === 'string' && vid.description.length > 80 ? vid.description : ''],
    ['script_video_transcript', scriptVid.scriptBody],
  ]) {
    if (typeof bodyText !== 'string' || !bodyText.trim()) continue;
    const ps = splitArticleBodyText(bodyText);
    if (!ps.length) continue;
    const pruned = pruneBlocks(ps.map(t => ({ k: 'p', t })), title, wireSet);
    const q = computeTextQuality({
      title, expectedTitle: opts.expectedTitle, url: finalURL, desc: rawDesc,
      blocks: pruned.blocks, boilerplateDropped: pruned.boilerplateDropped, duplicateDropped: pruned.duplicateDropped,
    });
    const score = (q.isOnTopic ? 120 : -200)
      + Math.min(q.paragraphCount, 15) * 10
      + Math.min(q.totalChars / 180, 35)
      + (mName === 'jsonld_articleBody' || mName === 'script_video_transcript' ? 15 : 0)
      - q.boilerplateRatio * 40 - q.duplicateRatio * 40;
    const candVids = mName === 'script_video_transcript' ? scriptVid.videos : [];
    const candBlocks = candVids.length ? [{ k: 'v', v: candVids[0] }, ...pruned.blocks] : pruned.blocks;
    candidates.push({ method: mName, blocks: candBlocks, videos: candVids, quality: q, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  let winner = candidates.find(c => c.quality.isOnTopic && !c.quality.isChallengeOrError && c.quality.paragraphCount > 0) || null;
  let textSource = winner ? winner.method : 'none';
  let isFallback = !winner || !winner.quality.isFullArticle;

  if (!winner || !winner.quality.isFullArticle) {

    const cleanedMetaDesc = FEEDTEXT.descFrom({ description: rdInline(rawDesc) }, title);
    if (!winner && cleanedMetaDesc && !BOT_CHALLENGE_RE.test(cleanedMetaDesc)) {
      const fbBlocks = [{ k: 'p', t: cleanedMetaDesc }];
      const q = computeTextQuality({ title, expectedTitle: opts.expectedTitle, url: finalURL, desc: cleanedMetaDesc, blocks: fbBlocks });
      winner = { method: 'meta_description', blocks: fbBlocks, videos: [], quality: { ...q, isFullArticle: false } };
      textSource = 'meta_description';
      isFallback = true;
    } else if (winner && !winner.quality.isFullArticle) {
      isFallback = true;
    }
  }

  const finalBlocksRaw = winner ? winner.blocks : [];
  const finalQuality = winner ? winner.quality : computeTextQuality({ title, expectedTitle: opts.expectedTitle, url: finalURL, desc: rawDesc, blocks: [] });

  const tnorm = rdInline(title).toLowerCase();
  const filteredBlocks = finalBlocksRaw.filter(b => !(b.k === 'p' && tnorm && b.t.toLowerCase() === tnorm));

  const finBlocks = [];
  const joined = [];
  let total = 0;
  for (const b of filteredBlocks) {
    if (b.k === 'p' || b.k === 'h' || b.k === 'q' || b.k === 'li') {
      if (total + b.t.length > 18000) continue;
      total += b.t.length;
      if (b.k !== 'h') joined.push(b.t);
    }
    finBlocks.push(b);
  }

  const blkVideos = winner ? (winner.videos || []) : [];
  const allV = rdVideos(sHtml, finalURL, false, title, rdOnTopic);
  const vkey = v => String(v.url).split('?')[0];
  const pkeys = new Set(blkVideos.map(vkey));
  const videos = [...blkVideos, ...allV.filter(v => !pkeys.has(vkey(v)))].slice(0, 4);

  let cleanDesc = FEEDTEXT.descFrom({ description: rdInline(rawDesc) }, title) || rdInline(rawDesc);
  if (BOT_CHALLENGE_RE.test(cleanDesc)) cleanDesc = '';
  if (cleanDesc.length < 25 || /^[-–—\s]*[A-Za-z0-9.\s]+$/i.test(cleanDesc)) {
    const firstP = joined.find(p => p.length >= 40) || '';
    if (firstP) cleanDesc = firstP.slice(0, 300);
  }

  const offTopic = candidates.length > 0 && candidates.every(c => !c.quality.isOnTopic);
  return {
    ok: !offTopic && !finalQuality.isChallengeOrError,
    offTopic,
    url: finalURL,
    final: finalURL,
    title: ((!title || title === rdHost(finalURL)) && opts.expectedTitle ? cleanArticleTitle(opts.expectedTitle, site, finalURL) : title) || rdHost(finalURL) || 'Tanpa judul',
    site,
    byline,
    time: time ? String(time) : '',
    img: '',
    desc: cleanDesc,
    paras: joined,
    thin: !finalQuality.isFullArticle,
    isFallback,
    textSource,
    videos,
    blocks: finBlocks,
    extraction: {
      method: textSource,
      isFallback,
      quality: finalQuality,
    },
  };
}

function rdJinaMd(text, url, opts = {}) {
  const sText = String(text || '');
  if (BOT_CHALLENGE_RE.test(sText.slice(0, 5000))) {
    const site = rdHost(url);
    return {
      ok: false,
      offTopic: false,
      url,
      final: url,
      title: site || 'Tanpa judul',
      site,
      byline: '',
      time: '',
      img: '',
      desc: '',
      paras: [],
      thin: true,
      isFallback: false,
      textSource: 'challenge',
      videos: [],
      blocks: [],
      via: 'jina',
      extraction: {
        method: 'blocked',
        isFallback: false,
        quality: { paragraphCount: 0, totalChars: 0, headlineRelevance: 0, duplicateRatio: 0, boilerplateRatio: 0, isOnTopic: false, isChallengeOrError: true, isFullArticle: false },
      },
    };
  }
  const paras = [], seen = new Set(), blocks = [];
  let title = '', done = false;
  const IMG_MD = /\[!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\]\(([^)\s]*)\)|!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const capOf = alt => {
    const c = rdInline(String(alt || '').replace(/^image\s+\d+\s*[:\-–—]?\s*|^image\s*[:\-–—]\s*/i, ''));
    return c.length >= 6 && !/logo|icon|share|whatsapp|facebook|twitter|menu|search|badge/i.test(c) ? c.slice(0, 220) : '';
  };

  let curLinkPath = '';
  try { curLinkPath = new URL(url).pathname; } catch (e) {}

  const emitText = (txt, kind = 'p') => {
    if (done) return;
    txt = txt.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    let linkLen = 0;
    for (const lm of txt.matchAll(/\[([^\]]*)\]\([^)]*\)/g)) linkLen += lm[1].length;
    const stripped = txt.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    if (linkLen / Math.max(1, stripped.length) >= 0.7) return;
    const clean = stripped.replace(/(\*\*|__|\*|_|`|~~)/g, '').replace(/\s+/g, ' ').trim();
    const minLen = kind === 'h' ? 8 : (kind === 'q' || kind === 'li') ? 20 : 35;
    const maxLen = kind === 'h' ? 140 : 1800;
    if (clean.length < minLen || clean.length > maxLen) return;
    if (RD_SKIP.test(clean) || BOT_CHALLENGE_RE.test(clean)) return;
    const k = clean.toLowerCase().replace(/\W+/g, ' ').slice(0, 140);
    if (seen.has(k)) return;
    seen.add(k);
    if (kind !== 'h') paras.push(clean);
    blocks.push({ k: kind, t: clean });
    if (paras.length >= 50) done = true;
  };

  for (const raw of String(text || '').split('\n')) {
    if (done) break;
    const t = raw.trim();
    if (!t) continue;
    if (/^(?:markdown content:|url source:|published time:)/i.test(t)) continue;
    const tm = t.match(/^title:\s*(.+)/i);
    if (tm) { if (!title && !BOT_CHALLENGE_RE.test(tm[1])) title = tm[1].trim(); continue; }
    if (/^```/.test(t)) continue;
    if (t.startsWith('#')) {
      const hd = t.replace(/^#+\s*/, '').trim();
      if (!title && !BOT_CHALLENGE_RE.test(hd)) title = hd;
      else if (paras.length >= 2 && /terpopuler|terkait|baca juga|rekomendasi|berita lain|terbaru|trending|populer|lainnya|related|more (?:news|stories)|latest|you may|komentar|comments?/i.test(hd)) break;
      else if (paras.length >= 1) emitText(hd, 'h');
      continue;
    }
    if (t.startsWith('>')) { emitText(t.replace(/^>+\s*/, ''), 'q'); continue; }
    if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      emitText(t.replace(/^(?:[-*]|\d+\.)\s+/, ''), 'li');
      continue;
    }

    const lineImgs = [];
    const lt = t.replace(IMG_MD, (_, a1, u1, link1, a2, u2, off) => {
      const iu = rdAbs(u1 || u2, url);
      const ia = a1 != null ? a1 : (a2 || '');

      if (link1) {
        try {
          const lx = new URL(link1, url);
          const isImgLink = /\.(?:jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(lx.pathname);
          if (!isImgLink && lx.pathname.length > 8 && lx.pathname !== curLinkPath) return ' ';
        } catch (e) {}
      }
      if (iu) lineImgs.push({ url: iu, cap: capOf(ia), alt: rdInline(ia), off });
      return ' ';
    });
    if (!lineImgs.length) { emitText(lt, 'p'); continue; }
    const pushImgs = () => {
      if (!done) for (const im of lineImgs) blocks.push({ k: 'i', img: { url: im.url, cap: im.cap, alt: im.alt } });
    };
    const txtLen = lt.replace(/\s+/g, ' ').trim().length;
    if (!txtLen || lineImgs[0].off <= Math.max(20, t.length * 0.4)) { pushImgs(); emitText(lt, 'p'); }
    else { emitText(lt, 'p'); pushImgs(); }
  }

  title = cleanArticleTitle(title, rdHost(url), url);
  const pruned = pruneBlocks(blocks, title, opts.wireTitles);
  const finalParas = pruned.blocks.filter(b => b.k === 'p' || b.k === 'q' || b.k === 'li').map(b => b.t);
  const quality = computeTextQuality({
    title, expectedTitle: opts.expectedTitle, url, desc: '',
    blocks: pruned.blocks, boilerplateDropped: pruned.boilerplateDropped, duplicateDropped: pruned.duplicateDropped,
  });

  return {
    ok: !quality.isChallengeOrError && quality.isOnTopic,
    offTopic: !quality.isOnTopic,
    url,
    final: url,
    title: title || WireCore.cleanSiteName('', url) || 'Tanpa judul',
    site: WireCore.cleanSiteName('', url),
    byline: '',
    time: '',
    img: '',
    desc: finalParas[0] ? finalParas[0].slice(0, 300) : '',
    paras: finalParas,
    thin: !quality.isFullArticle,
    isFallback: !quality.isFullArticle,
    textSource: 'jina_markdown',
    videos: [],
    blocks: pruned.blocks,
    via: 'jina',
    extraction: {
      method: 'jina_markdown',
      isFallback: !quality.isFullArticle,
      quality,
    },
  };
}

module.exports = {
  BOT_CHALLENGE_RE,
  ERROR_PAGE_RE,
  decodeEntities,
  rdClean,
  rdInline,
  rdHost,
  rdAbs,
  parseAttrs,
  pickBestSrcset,
  rdMeta,
  rdLd,
  rdName,
  findMatchingClose,
  stripElementsByTag,
  stripJunkContainers,
  stripCardLinks,
  stripLinkBlocks,
  extractContainers,
  rdBlocks,
  rdVideos,
  rdOnTopic,
  topicTokens,
  pruneBlocks,
  computeTextQuality,
  cleanArticleTitle,
  cleanSiteName: WireCore.cleanSiteName,
  rdExtract,
  rdJinaMd,
};
