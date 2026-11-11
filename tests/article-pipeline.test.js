'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.SITREP_NO_WESERV = '1';
process.env.SITREP_TOKEN = process.env.SITREP_TOKEN || 'sitrep-article-pipeline-test-token';

const MEDIA = require('../article-media');
const EXTRACT = require('../article-extract');
const FEEDTEXT = require('../feedtext');
const SEC = require('../security');
const SRV = require('../server');

// ---------------------------------------------------------------------------
// Synthetic Binary Image Fixtures (PNG / JPEG / WebP / GIF / SVG / ICO)
// ---------------------------------------------------------------------------

function makePngBuffer(width, height, totalBytes = 9200, seed = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const prefix = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0x00, 0x00, 0x00, 0x0D]),
    Buffer.from('IHDR', 'ascii'),
    ihdr,
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]);
  const out = Buffer.alloc(Math.max(totalBytes, prefix.length + 16), seed & 0xff);
  prefix.copy(out, 0);
  return out;
}

function makeJpegBuffer(width, height, totalBytes = 10400, seed = 7) {
  const header = Buffer.from([
    0xFF, 0xD8,
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xC0, 0x00, 0x0B, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00,
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00,
  ]);
  const out = Buffer.alloc(Math.max(totalBytes, header.length + 4), seed & 0xff);
  header.copy(out, 0);
  out[out.length - 2] = 0xFF;
  out[out.length - 1] = 0xD9;
  return out;
}

function makeTinyGif() {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
}

function inspectAndMakeProbe(routes) {
  return async (url) => {
    const entry = routes[url];
    if (!entry) return { ok: false, reason: 'http_404', transient: false, detail: '404' };
    if (entry.throwErr) throw entry.throwErr;
    if (entry.transient) return { ok: false, reason: 'http_503', transient: true, detail: '503' };
    if (entry.httpError) return { ok: false, reason: 'http_' + entry.httpError, transient: entry.httpError >= 500 || entry.httpError === 429, detail: String(entry.httpError) };
    const finalUrl = entry.redirectTo || url;
    const inspected = MEDIA.inspectImageBuffer(entry.buf, entry.ct || 'image/jpeg');
    if (!inspected.ok) return { ok: false, reason: inspected.reason, transient: false, detail: entry.ct || '' };
    return {
      ok: true,
      w: inspected.w,
      h: inspected.h,
      mime: inspected.mime,
      bytes: Math.max(entry.buf.length, entry.bytes || 0),
      fingerprint: inspected.fingerprint,
      finalUrl,
    };
  };
}

// ---------------------------------------------------------------------------
// 1-9. Strict Image Validation & Canonical Priority Resolution Scenarios
// ---------------------------------------------------------------------------

test('01. RSS image is publisher logo -> Reject cleanly', async () => {
  const tracker = new MEDIA.AssetReuseTracker();
  const logoBuf = makePngBuffer(180, 60, 7500, 11);
  const probeFn = inspectAndMakeProbe({
    'https://cdn.portal.id/brand/logo-portal.png': { buf: logoBuf, ct: 'image/png' },
    'https://cdn.portal.id/static/brandmark.png': { buf: makePngBuffer(800, 450, 9500, 12), ct: 'image/png' },
  });

  // Explicit logo URL pattern + small logo dimensions rejected
  const res1 = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://portal.id/nasional/banjir-bandung-1',
    rssImgs: ['https://cdn.portal.id/brand/logo-portal.png'],
    probeFn,
    reuseTracker: tracker,
  });
  assert.equal(res1.hero.url, '');
  assert.equal(res1.hero.verified, false);
  assert.equal(res1.hero.status, 'rejected');
  assert.ok(res1.diagnostics.rejected.some(r => /junk_url_pattern|non_editorial_filename|non_editorial_path|dimensions_too_small/.test(r.reason)));

  // Single-item RSS resolves relative URL cleanly while hiding raw unverified img from public wire item
  const singleRss = `<rss><channel><item><title>Berita Tunggal</title><link>https://portal.id/a0</link><enclosure url="/assets/editorial-photo.jpg" type="image/jpeg"/></item></channel></rss>`;
  const singleItems = SRV.parseFeed(singleRss, 'https://portal.id/rss.xml');
  assert.equal(singleItems.length, 1);
  assert.equal(singleItems[0].img, '', 'parseFeed must never expose unverified RSS img onto wire item');
  assert.equal(singleItems[0].rssImg, 'https://portal.id/assets/editorial-photo.jpg', 'relative RSS enclosure URL must resolve against feedUrl');

  // Feed-level repeated site asset detection even if URL filename looks generic (site-cover.jpg reused across >=2 items)
  const rssXml = `
    <rss><channel>
      <item><title>Berita Satu</title><link>https://portal.id/a1</link><enclosure url="/assets/site-cover.jpg" type="image/jpeg"/></item>
      <item><title>Berita Dua</title><link>https://portal.id/a2</link><enclosure url="https://portal.id/assets/site-cover.jpg" type="image/jpeg"/></item>
      <item><title>Berita Tiga</title><link>https://portal.id/a3</link><enclosure url="https://portal.id/assets/site-cover.jpg" type="image/jpeg"/></item>
    </channel></rss>`;
  const items = SRV.parseFeed(rssXml, 'https://portal.id/rss.xml');
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.equal(it.img, '', 'parseFeed must never expose unverified RSS img onto wire item');
    assert.equal(it.rssImg, '', 'repeated feed-level asset must be scrubbed from rssImg');
  }
  assert.ok(SRV.assetReuse.isReused('https://portal.id/a1', 'https://portal.id/assets/site-cover.jpg'),
    'feed-level image appearing across >=2 items must be marked as reused site asset');
});

test('02. Open Graph image is favicon -> Reject', async () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Kebakaran Gudang Logistik di Bekasi Berhasil Dipadamkan">
    <meta property="og:image" content="https://berita.co.id/favicon-32x32.png">
    <meta name="twitter:image" content="https://berita.co.id/apple-icon.ico">
  </head><body><article><p>Petugas pemadam kebakaran menerjunkan delapan unit mobil untuk memadamkan api di kawasan industri Bekasi sejak dini hari tadi.</p><p>Tidak ada korban jiwa dalam peristiwa tersebut sementara penyebab kebakaran masih diselidiki oleh aparat kepolisian setempat.</p></article></body></html>`;
  const probeFn = inspectAndMakeProbe({
    'https://berita.co.id/favicon-32x32.png': { buf: makePngBuffer(32, 32, 6000, 1), ct: 'image/png' },
    'https://berita.co.id/apple-icon.ico': { buf: Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), ct: 'image/x-icon' },
  });
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://berita.co.id/bekasi/kebakaran-gudang',
    html,
    probeFn,
  });
  assert.equal(res.hero.url, '');
  assert.equal(res.hero.verified, false);
  assert.ok(res.diagnostics.rejected.length >= 2);
});

test('03. RSS image is social icon -> Reject', async () => {
  const badRss = `<item><title>Demo Buruh di Jakarta</title><link>https://news.id/demo</link><media:content url="https://news.id/assets/medsos/i-whatsapp.png" type="image/png"/></item>`;
  assert.equal(MEDIA.feedImage(badRss, 'https://news.id/rss'), '');

  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://news.id/demo',
    rssImgs: ['https://news.id/assets/medsos/share-whatsapp.png'],
    probeFn: inspectAndMakeProbe({
      'https://news.id/assets/medsos/share-whatsapp.png': { buf: makePngBuffer(64, 64, 5000, 2), ct: 'image/png' },
    }),
  });
  assert.equal(res.hero.url, '');
  assert.equal(res.hero.verified, false);
  assert.ok(res.diagnostics.rejected.some(r => /junk_url_pattern|non_editorial_filename|non_editorial_path/.test(r.reason)));
});

test('04. OG image is actual editorial photograph -> Accept', async () => {
  const ogUrl = 'https://cdn.media.id/2026/11/10/banjir-cilacap-1200x675.jpg';
  const html = `<html><head>
    <meta property="og:image" content="${ogUrl}">
    <meta property="og:title" content="Banjir Rendam Lima Desa di Cilacap Selatan">
  </head><body><article><p>Hujan deras mengguyur wilayah Cilacap selama enam jam hingga menyebabkan sungai meluap ke permukiman warga pada pagi tadi.</p></article></body></html>`;
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://media.id/jateng/banjir-cilacap',
    html,
    probeFn: inspectAndMakeProbe({
      [ogUrl]: { buf: makeJpegBuffer(1200, 675, 24000, 21), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.url, ogUrl);
  assert.equal(res.hero.verified, true);
  assert.equal(res.hero.source, 'og');
  assert.equal(res.hero.width, 1200);
  assert.equal(res.hero.height, 675);
  assert.equal(res.hero.mime, 'image/jpeg');
  assert.equal(res.hero.status, 'verified');
});

test('05. Actual article body contains lead photo -> Prefer valid body candidate over generic OG', async () => {
  const leadUrl = 'https://cdn.media.id/photos/2026/evakuasi-merapi-lead.jpg';
  const ogUrl = 'https://cdn.media.id/og/og-portal-wide.jpg';
  const html = `<html><head>
    <meta property="og:image" content="${ogUrl}">
  </head><body><div class="detail-body">
    <figure><img src="${leadUrl}" alt="Evakuasi warga lereng Merapi"><figcaption>Warga mengungsi ke balai desa Sleman.</figcaption></figure>
    <p>Aktivitas vulkanik Gunung Merapi meningkat sejak pukul empat pagi disertai guguran awan panas mengarah ke hulu Kali Bebeng.</p>
    <p>BPBD Sleman mengimbau warga tetap menjauhi radius lima kilometer dari puncak kawah sambil menyiagakan tenda darurat.</p>
  </div></body></html>`;
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://media.id/sleman/merapi-siaga',
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe({
      [leadUrl]: { buf: makeJpegBuffer(1000, 667, 18000, 31), ct: 'image/jpeg' },
      [ogUrl]: { buf: makeJpegBuffer(1200, 630, 19000, 32), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.url, leadUrl);
  assert.equal(res.hero.source, 'body_lead');
  assert.equal(res.hero.caption, 'Warga mengungsi ke balai desa Sleman.');
  assert.equal(res.bodyImages.length, 0, 'lead photo promoted to hero must not duplicate inside bodyImages');
});

test('06. RSS image differs from article image -> Resolve correct article image', async () => {
  const rssWrong = 'https://cdn.media.id/feed/generic-channel-thumb.jpg';
  const articleImg = 'https://cdn.media.id/2026/11/kecelakaan-tol-cipali.jpg';
  const html = `<html><head><meta property="og:image" content="${articleImg}"></head>
    <body><article><p>Kecelakaan beruntun melibatkan tiga kendaraan terjadi di kilometer 102 Tol Cipali arah Jakarta pagi ini.</p></article></body></html>`;
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://media.id/news/tol-cipali',
    html,
    rssImgs: [rssWrong],
    probeFn: inspectAndMakeProbe({
      [rssWrong]: { buf: makeJpegBuffer(640, 400, 9000, 41), ct: 'image/jpeg' },
      [articleImg]: { buf: makeJpegBuffer(1200, 800, 22000, 42), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.url, articleImg);
  assert.equal(res.hero.source, 'og');
});

test('07. Article contains related-story thumbnails -> Exclude from hero, bodyImages, and body text', async () => {
  const realPhoto = 'https://cdn.pub.id/2026/lrt-gangguan-listrik.jpg';
  const relThumb1 = 'https://cdn.pub.id/2026/other-story-football.jpg';
  const relThumb2 = 'https://cdn.pub.id/2026/other-card-market.jpg';
  const html = `<html><head><title>Gangguan Listrik Hentikan Operasi LRT Jabodebek</title></head><body>
    <div class="article-content">
      <div class="inner-wrap">
        <p>Gangguan pasokan listrik aliran atas membuat perjalanan LRT Jabodebek terhenti selama empat puluh menit pada jam sibuk pagi hari.</p>
        <figure><img src="${realPhoto}"><figcaption>Penumpang menunggu perbaikan listrik LRT di stasiun.</figcaption></figure>
        <p>Petugas teknis PT KAI telah memulihkan jaringan kelistrikan pada jalur Dukuh Atas menuju Harjamukti sehingga jadwal kembali normal.</p>
      </div>
      <div class="related-news">
        <h3>Berita Terkait</h3>
        <a href="/news/hasil-liga-champions"><img src="${relThumb1}"><h4>Hasil Liga Champions Tadi Malam</h4></a>
      </div>
      <div class="baca-juga-box">
        <a href="/ekonomi/harga-beras-naik"><img src="${relThumb2}"><p>Harga Beras Melonjak di Pasar Induk</p></a>
      </div>
    </div>
  </body></html>`;

  const mediaRes = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/metro/lrt-gangguan',
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe({
      [realPhoto]: { buf: makeJpegBuffer(1000, 600, 16000, 51), ct: 'image/jpeg' },
      [relThumb1]: { buf: makeJpegBuffer(800, 500, 14000, 52), ct: 'image/jpeg' },
      [relThumb2]: { buf: makeJpegBuffer(800, 500, 14000, 53), ct: 'image/jpeg' },
    }),
  });
  assert.equal(mediaRes.hero.url, realPhoto);
  assert.equal(mediaRes.bodyImages.length, 0);

  const ext = EXTRACT.rdExtract(html, 'https://pub.id/metro/lrt-gangguan');
  assert.equal(ext.ok, true);
  assert.ok(ext.paras.some(p => p.includes('Gangguan pasokan listrik')));
  assert.ok(ext.paras.some(p => p.includes('Petugas teknis PT KAI')));
  assert.ok(!ext.paras.join(' ').includes('Liga Champions'));
  assert.ok(!ext.paras.join(' ').includes('Harga Beras'));
});

test('08. Article contains author avatar -> Exclude it', async () => {
  const avatar1 = 'https://cdn.pub.id/uploads/reporter-ani-800x800.jpg';
  const avatar2 = 'https://cdn.pub.id/users/penulis-budi.jpg';
  const html = `<html><head><title>Gempa M 5,2 Guncang Maluku Barat Daya</title></head><body><article>
    <div class="author-box"><img class="author-avatar" src="${avatar1}" alt="Reporter Ani"><span>Oleh Ani Wulandari</span></div>
    <img class="avatar-circle" src="${avatar2}" alt="Budi">
    <p>Gempa bumi tektonik berkekuatan magnitudo 5,2 mengguncang wilayah Maluku Barat Daya pada siang tadi tanpa potensi tsunami menurut BMKG.</p>
    <p>Hingga laporan ini disusun belum ada laporan kerusakan bangunan atau korban luka dari pos pengamatan daerah setempat.</p>
  </article></body></html>`;
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/gempa-maluku',
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe({
      [avatar1]: { buf: makeJpegBuffer(800, 800, 15000, 61), ct: 'image/jpeg' },
      [avatar2]: { buf: makeJpegBuffer(600, 600, 15000, 62), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.url, '');
  assert.equal(res.bodyImages.length, 0);
});

test('09. Article has no valid image -> Return no hero image and ignore Organization logo in JSON-LD', async () => {
  const html = `<html><head>
    <meta property="og:image" content="https://pub.id/img/bad-mime.jpg">
    <meta name="twitter:image" content="https://pub.id/assets/tracking-pixel.gif">
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle',
      headline: 'Pengumuman Resmi Jadwal Listrik',
      publisher: { '@type': 'Organization', name: 'Pub', logo: { '@type': 'ImageObject', url: 'https://pub.id/brand/logo-publisher.png' } },
    })}</script>
  </head><body><article><p>PLN melakukan pemeliharaan gardu distribusi selama dua jam pada akhir pekan ini di beberapa kecamatan.</p><p>Warga diimbau menyiapkan cadangan daya sebelum pemadaman sementara dilakukan.</p></article></body></html>`;
  const probeFn = inspectAndMakeProbe({
    'https://pub.id/img/bad-mime.jpg': { buf: Buffer.from('<html>404 Not Found</html>'), ct: 'text/html' },
    'https://pub.id/assets/tracking-pixel.gif': { buf: makeTinyGif(), ct: 'image/gif' },
    'https://pub.id/brand/logo-publisher.png': { buf: makePngBuffer(600, 150, 8000, 70), ct: 'image/png' },
  });
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/pln-pemeliharaan',
    html,
    mode: 'full',
    probeFn,
  });
  assert.equal(res.hero.url, '');
  assert.equal(res.hero.verified, false);
  assert.ok(['rejected', 'no_candidates'].includes(res.hero.status));
});

// ---------------------------------------------------------------------------
// 10. Reader & News Wire Same Canonical Hero + End-to-End Backend Routes
// ---------------------------------------------------------------------------

test('10. Reader and News Wire display same canonical hero image and frontend never overrides backend rejection', async () => {
  const verifiedHero = 'https://cdn.news.id/2026/11/jembatan-ambruk-hero.jpg';
  const rssRawLogo = 'https://cdn.news.id/assets/logo-news-id.png';
  const rawArticleUrl = 'https://news.id/daerah/jembatan-ambruk?utm_source=google&fbclid=xyz123';
  const canonUrl = MEDIA.canonicalArticleUrl(rawArticleUrl);
  assert.equal(canonUrl, 'https://news.id/daerah/jembatan-ambruk');

  const blockedUrl = 'https://news.id/daerah/tanpa-foto-valid';

  // Seed wire cache for all configured NEWS sources (offline — zero outbound RSS network calls)
  SRV.cache.clear();
  SRV.bodyCache.clear();
  SRV.thumbCache.clear();
  SRV.readCache.clear();
  const seededItems = [
    {
      src: SRV.NEWS[0][0],
      pub: 'NewsID',
      title: 'Jembatan Penghubung Antar Kecamatan di Garut Ambruk Diterjang Banjir',
      url: rawArticleUrl,
      img: '',
      rssImg: rssRawLogo,
      rssImgs: [rssRawLogo],
      desc: 'Jembatan penghubung dua kecamatan di Kabupaten Garut ambruk akibat luapan sungai setelah hujan deras semalaman.',
      ts: Date.now() - 60000,
    },
    {
      src: SRV.NEWS[0][0],
      pub: 'NewsID',
      title: 'Dinas Pekerjaan Umum Tutup Jalan Raya Garut Selatan Untuk Perbaikan',
      url: blockedUrl,
      img: '',
      rssImg: rssRawLogo,
      rssImgs: [rssRawLogo],
      desc: 'Ruas jalan penghubung Garut Selatan ditutup sementara oleh Dinas Pekerjaan Umum untuk perbaikan tanggul.',
      ts: Date.now() - 120000,
    },
  ];
  const primaryFeedId = SRV.NEWS[0][0];
  for (const [fid] of SRV.NEWS) {
    SRV.cache.set('n:' + fid, {
      at: Date.now(),
      v: {
        id: fid,
        name: fid,
        ok: true,
        items: fid === primaryFeedId ? seededItems : [],
      },
    });
  }

  // Start SITREP_SERVER on ephemeral port cleanly and shut down in finally
  const port = await new Promise((resolve) => {
    const s = SRV.SITREP_SERVER.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
  const hdrs = { 'x-sitrep-token': process.env.SITREP_TOKEN };
  try {
    // Pass 1: Before canonical resolution, /api/news must NEVER leak rssImg logo
    let rNews = await fetch(`http://127.0.0.1:${port}/api/news`, { headers: hdrs });
    assert.equal(rNews.status, 200);
    let newsJson = await rNews.json();
    const firstItems = newsJson.sources.find(s => s.id === primaryFeedId).items;
    const itemA = firstItems.find(x => x.url === rawArticleUrl);
    assert.ok(itemA, 'seeded article A must appear in /api/news');
    assert.equal(itemA.img, '', 'raw RSS logo must not appear on wire card');
    assert.equal(itemA.imgVerified, false);
    assert.equal(itemA.rssImg, undefined, 'internal rssImg field must be stripped from public JSON');

    // Now simulate canonical resolution populating canonical media & read caches for A (verified) and B (rejected)
    const mediaA = await MEDIA.resolveArticleMedia({
      requestedUrl: rawArticleUrl,
      canonicalUrl: canonUrl,
      html: `<html><head><meta property="og:image" content="${verifiedHero}"></head><body><article><p>Jembatan penghubung antar kecamatan ambruk akibat derasnya arus sungai Cimanuk malam tadi.</p><p>Warga kini harus memutar delapan kilometer menuju jalan alternatif yang disiapkan pemerintah daerah.</p></article></body></html>`,
      rssImgs: [rssRawLogo],
      mode: 'full',
      probeFn: inspectAndMakeProbe({
        [verifiedHero]: { buf: makeJpegBuffer(1200, 675, 21000, 81), ct: 'image/jpeg' },
        [rssRawLogo]: { buf: makePngBuffer(150, 50, 5000, 82), ct: 'image/png' },
      }),
    });
    assert.equal(mediaA.hero.url, verifiedHero);
    SRV.mediaCacheSet([rawArticleUrl, canonUrl], mediaA);
    SRV.setReadCache([rawArticleUrl, canonUrl], {
      ok: true,
      url: canonUrl,
      final: canonUrl,
      canonicalUrl: canonUrl,
      title: 'Jembatan Penghubung Antar Kecamatan di Garut Ambruk Diterjang Banjir',
      site: 'NewsID',
      img: mediaA.hero.url,
      imgVerified: true,
      imgStatus: 'verified',
      desc: 'Jembatan ambruk di Garut',
      paras: ['Jembatan penghubung antar kecamatan ambruk.', 'Warga memutar ke jalur alternatif.'],
      thin: false,
      blocks: [{ k: 'p', t: 'Jembatan penghubung antar kecamatan ambruk.' }],
      media: mediaA,
      via: 'direct',
    }, 60000);

    const mediaB = await MEDIA.resolveArticleMedia({
      requestedUrl: blockedUrl,
      canonicalUrl: blockedUrl,
      rssImgs: [rssRawLogo],
      mode: 'hero',
      probeFn: inspectAndMakeProbe({ [rssRawLogo]: { buf: makePngBuffer(150, 50, 5000, 82), ct: 'image/png' } }),
    });
    assert.equal(mediaB.hero.url, '');
    assert.equal(mediaB.hero.status, 'rejected');
    SRV.mediaCacheSet([blockedUrl], mediaB);

    // Clear cached /api/news response to verify updated canonical media parity on next wire fetch
    SRV.cache.delete('newsresp:v' + SRV.PIPELINE_VERSION);
    SRV.bodyCache.delete('newsresp:v' + SRV.PIPELINE_VERSION);

    const rThumbA = await (await fetch(`http://127.0.0.1:${port}/api/thumb?u=${encodeURIComponent(rawArticleUrl)}`, { headers: hdrs })).json();
    const rThumbB = await (await fetch(`http://127.0.0.1:${port}/api/thumb?u=${encodeURIComponent(blockedUrl)}`, { headers: hdrs })).json();
    const rReadA = await (await fetch(`http://127.0.0.1:${port}/api/read?u=${encodeURIComponent(canonUrl)}`, { headers: hdrs })).json();
    const newsAfter = await (await fetch(`http://127.0.0.1:${port}/api/news`, { headers: hdrs })).json();

    const wireA = newsAfter.sources.find(s => s.id === primaryFeedId).items.find(x => x.url === rawArticleUrl);
    const wireB = newsAfter.sources.find(s => s.id === primaryFeedId).items.find(x => x.url === blockedUrl);

    // Identical canonical hero across News Wire card, /api/thumb, and Reader (/api/read)
    assert.equal(wireA.img, verifiedHero);
    assert.equal(wireA.imgVerified, true);
    assert.equal(rThumbA.img, verifiedHero);
    assert.equal(rThumbA.verified, true);
    assert.equal(rReadA.img, verifiedHero);
    assert.equal(rReadA.imgVerified, true);
    assert.equal(rReadA.canonicalUrl, wireA.canonicalUrl);

    // Rejected article B: wire & thumb both return empty img and imgRejected/rejected status
    assert.equal(wireB.img, '');
    assert.equal(wireB.imgRejected, true);
    assert.equal(rThumbB.img, '');
    assert.equal(rThumbB.status, 'rejected');

    // Verify frontend index.html enforces backend rejection and never leaks rdHero fallback or body block into hero
    const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(indexHtml.includes('if (leadImgRejected.has(h.url)) return \'\';'),
      'resolveLeadImage must abort fallback chain when backend rejected image');
    assert.ok(!indexHtml.includes('if (rdHero) img.src = rdHero'),
      'rdHeroFb must not override failed hero with arbitrary fallback thumbnail');
  } finally {
    await new Promise((resolve) => {
      SRV.SITREP_SERVER.close(resolve);
      if (typeof SRV.SITREP_SERVER.closeAllConnections === 'function') SRV.SITREP_SERVER.closeAllConnections();
    });
    SRV.cache.clear();
    SRV.thumbCache.clear();
    SRV.readCache.clear();
  }
});

// ---------------------------------------------------------------------------
// 11-14. Body Order, Redirect Validation, Lazy-Loading, Srcset Handling
// ---------------------------------------------------------------------------

test('11. Article has multiple valid body images -> Preserve original document order & deduplicate vs hero', async () => {
  const hero = 'https://cdn.pub.id/g/hero-banjir.jpg';
  const b1 = 'https://cdn.pub.id/g/foto-1-posko.jpg';
  const b2 = 'https://cdn.pub.id/g/foto-2-perahu.jpg';
  const b3 = 'https://cdn.pub.id/g/foto-3-dapur.jpg';

  const html = `<html><head><meta property="og:image" content="${hero}"></head><body><article>
    <p>Paragraf satu membahas hujan deras semalaman yang memicu luapan sungai di kabupaten tersebut.</p>
    <figure><img src="${b1}"><figcaption>Posko pengungsian warga di kantor kecamatan.</figcaption></figure>
    <p>Paragraf dua menguraikan upaya evakuasi tim gabungan dengan menerjunkan sejumlah perahu karet.</p>
    <figure><img src="${b2}"><figcaption>Evakuasi lansia menggunakan perahu karet Basarnas.</figcaption></figure>
    <p>Paragraf tiga menjelaskan operasional dapur umum untuk memenuhi kebutuhan pangan ribuan pengungsi.</p>
    <figure><img src="${b3}"><figcaption>Relawan menyiapkan makanan di dapur umum.</figcaption></figure>
    <p>Paragraf empat menyatakan pemerintah daerah menetapkan status tanggap darurat selama tujuh hari ke depan.</p>
  </article></body></html>`;

  const probeFn = inspectAndMakeProbe({
    [hero]: { buf: makeJpegBuffer(1200, 675, 22000, 100), ct: 'image/jpeg' },
    [b1]: { buf: makeJpegBuffer(900, 600, 18000, 101), ct: 'image/jpeg' },
    [b2]: { buf: makeJpegBuffer(900, 600, 18000, 102), ct: 'image/jpeg' },
    [b3]: { buf: makeJpegBuffer(900, 600, 18000, 103), ct: 'image/jpeg' },
  });

  const ext = EXTRACT.rdExtract(html, 'https://pub.id/g/banjir-besar');
  const mediaRes = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/g/banjir-besar',
    html,
    mode: 'full',
    probeFn,
  });

  // b1 is body_lead -> becomes canonical hero, b2 & b3 remain bodyImages in order (AND hero og wasn't a body image!)
  // Wait: explicitly validate order of extracted images inside blocks as well as when og:image + distinct body images assemble
  assert.equal(mediaRes.hero.url, b1);
  assert.deepEqual(mediaRes.bodyImages.map(x => x.url), [b2, b3]);

  const assembled = SRV.rdAssembleBlocks(ext, mediaRes);
  const assembledImgs = assembled.blocks.filter(b => b.k === 'i').map(b => b.img.url);
  assert.deepEqual(assembledImgs, [b2, b3]);
});

test('12. Image URL redirects to another host -> Validate redirect target & enforce SSRF protection', async () => {
  const redirStart = 'https://media.pub.id/img/track/foto-1';
  const publicDest = 'https://assets-partner.cdn-global.net/editorial/kebakaran-pabrik.jpg';
  const junkDest = 'https://cdn-static.pub.id/assets/logo-brand-dark.png';

  // Valid cross-host public redirect passes after validating destination URL + real bytes
  const okRes = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/kebakaran-1',
    html: `<html><head><meta property="og:image" content="${redirStart}"></head><body><article><p>Kebakaran pabrik tekstil berlangsung tiga jam di kawasan industri timur.</p></article></body></html>`,
    probeFn: inspectAndMakeProbe({
      [redirStart]: { redirectTo: publicDest, buf: makeJpegBuffer(1200, 800, 19000, 111), ct: 'image/jpeg' },
    }),
  });
  assert.equal(okRes.hero.url, publicDest);
  assert.equal(okRes.hero.verified, true);

  // Redirect landing on publisher logo URL is rejected post-redirect
  const badRes = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://pub.id/kebakaran-2',
    html: `<html><head><meta property="og:image" content="${redirStart}"></head><body><article><p>Kebakaran pabrik tekstil berlangsung tiga jam.</p></article></body></html>`,
    probeFn: inspectAndMakeProbe({
      [redirStart]: { redirectTo: junkDest, buf: makePngBuffer(600, 200, 9000, 112), ct: 'image/png' },
    }),
  });
  assert.equal(badRes.hero.url, '');
  assert.ok(badRes.diagnostics.rejected.some(r => /_after_redirect$/.test(r.reason)));

  // SSRF protection intact on private IPs / metadata endpoints
  await assert.rejects(() => SEC.rdAssertPublic('http://127.0.0.1/secret.jpg'));
  await assert.rejects(() => SEC.rdAssertPublic('http://169.254.169.254/latest/meta-data/'));
  await assert.rejects(() => SRV.rdRead('http://127.0.0.1:8080/internal-admin'));
  await assert.rejects(() => SRV.thumb('http://10.0.0.5/private.jpg'));
});

test('13. Lazy-loaded image uses data-src / data-original / amp-img -> Extract correctly', async () => {
  const lazyUrl = 'https://cdn.detik-clone.id/media/foto-evakuasi-real.jpg';
  const ampUrl = 'https://cdn.detik-clone.id/media/foto-amp-kedua.jpg';
  const html = `<html><body><div class="detail-body">
    <p>Paragraf pembuka menjelaskan langkah cepat petugas di lokasi bencana alam hari ini.</p>
    <figure><img class="lazy" src="https://pub.id/assets/placeholder-loading.gif" data-src="${lazyUrl}" alt="Petugas mengevakuasi warga"><figcaption>Petugas mengevakuasi warga terdampak longsor.</figcaption></figure>
    <p>Paragraf lanjutan menjelaskan distribusi bantuan logistik melalui jalur darat.</p>
    <amp-img src="${ampUrl}" width="900" height="600" alt="Posko bantuan"></amp-img>
  </div></body></html>`;

  const probeFn = inspectAndMakeProbe({
    [lazyUrl]: { buf: makeJpegBuffer(1000, 667, 17000, 121), ct: 'image/jpeg' },
    [ampUrl]: { buf: makeJpegBuffer(900, 600, 16000, 122), ct: 'image/jpeg' },
  });
  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://detik-clone.id/longsor-cianjur',
    html,
    mode: 'full',
    probeFn,
  });
  assert.equal(res.hero.url, lazyUrl);
  assert.equal(res.hero.source, 'body_lead');
  assert.deepEqual(res.bodyImages.map(x => x.url), [ampUrl]);
});

test('14. Image uses srcset (including comma-containing Cloudinary/Kumparan URLs) -> Select highest valid candidate', async () => {
  const commaSrcset = [
    'https://blue.kumparan.com/image/upload/fl_progressive,fl_lossy,c_fill,q_auto:best,w_320/v1634025439/banjir.jpg 320w',
    'https://blue.kumparan.com/image/upload/fl_progressive,fl_lossy,c_fill,q_auto:best,w_1200/v1634025439/banjir.jpg 1200w',
  ].join(', ');
  assert.equal(
    EXTRACT.pickBestSrcset(commaSrcset),
    'https://blue.kumparan.com/image/upload/fl_progressive,fl_lossy,c_fill,q_auto:best,w_1200/v1634025439/banjir.jpg'
  );

  const expectedBest = 'https://blue.kumparan.com/image/upload/fl_progressive,fl_lossy,c_fill,q_auto:best,w_1200/v1634025439/banjir.jpg';
  const html = `<html><body><article>
    <p>Laporan mendalam situasi lalu lintas jelang libur panjang di ruas tol utama Pulau Jawa.</p>
    <img srcset="${commaSrcset}" alt="Kepadatan arus kendaraan">
    <p>Kepadatan kendaraan terpantau meningkat sejak pagi di gerbang tol keluar kota.</p>
  </article></body></html>`;

  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://kumparan-clone.id/tol-macet',
    html,
    probeFn: inspectAndMakeProbe({
      [expectedBest]: { buf: makeJpegBuffer(1200, 675, 21000, 131), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.url, expectedBest);
});

// ---------------------------------------------------------------------------
// 15-17. Text Extraction Quality, Challenges, Metadata Fallback, Off-Topic
// ---------------------------------------------------------------------------

test('15. Article extraction returns CAPTCHA / Cloudflare challenge page -> Reject cleanly', () => {
  const cfHtml = `<!doctype html><html><head><title>Just a moment...</title></head><body>
    <div id="cf-wrapper"><h1>Verify you are human</h1><p>Please wait while we verify your browser with cf-turnstile challenge-platform.</p></div>
  </body></html>`;
  const resHtml = EXTRACT.rdExtract(cfHtml, 'https://tempo-clone.id/berita-1');
  assert.equal(resHtml.ok, false);
  assert.equal(resHtml.textSource, 'challenge');
  assert.equal(resHtml.extraction.quality.isChallengeOrError, true);
  assert.equal(resHtml.paras.length, 0);

  const cfJina = `Title: Attention Required! | Cloudflare\n\nPlease verify you are human. Enable JavaScript and cookies to continue checking your browser.`;
  const resJina = EXTRACT.rdJinaMd(cfJina, 'https://tempo-clone.id/berita-1');
  assert.equal(resJina.ok, false);
  assert.equal(resJina.extraction.quality.isChallengeOrError, true);

  assert.equal(FEEDTEXT.descFrom({ description: 'Please wait while we verify your browser via cf-turnstile.' }, 'Headline'), '');
});

test('16. Article extraction returns only metadata description -> Identify fallback clearly without fabricating full article', () => {
  const thinHtml = `<html><head>
    <title>Kebijakan Tarif Ekspor CPO Mulai Berlaku Bulan Depan</title>
    <meta property="og:description" content="Kementerian Perdagangan resmi menyesuaikan tarif pungutan ekspor CPO sebesar tujuh persen mulai bulan depan.">
  </head><body><main><div class="paywall">Langganan untuk membaca artikel penuh.</div></main></body></html>`;

  const ext = EXTRACT.rdExtract(thinHtml, 'https://bisnis-clone.id/tarif-cpo');
  assert.equal(ext.ok, true);
  assert.equal(ext.thin, true);
  assert.equal(ext.isFallback, true);
  assert.equal(ext.textSource, 'meta_description');
  assert.equal(ext.extraction.quality.isFullArticle, false);
  assert.equal(ext.paras.length, 1);

  // Also ensure server.js wire-fallback never injects fake boilerplate article text
  const serverJs = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(!serverJs.includes('Laporan lengkap berada di situs sumber. Akses server dibatasi oleh proteksi bot penerbit.'),
    'wire-fallback must not fabricate synthetic Indonesian prose inside article paragraphs');

  // Verify JSON-LD NewsArticle.articleBody wins over noisy thin DOM when DOM lacks body paragraphs
  const ldHtml = `<html><head>
    <title>Stok Pangan Nasional Aman Jelang Akhir Tahun Menurut Kementan</title>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle',
      headline: 'Stok Pangan Nasional Aman Jelang Akhir Tahun Menurut Kementan',
      articleBody: 'Kementerian Pertanian memastikan cadangan beras pemerintah mencukupi kebutuhan masyarakat hingga kuartal pertama tahun depan.\n\nOperasi pasar terus digencarkan di berbagai daerah guna menjaga stabilitas harga pangan pokok di tingkat konsumen.',
    })}</script>
  </head><body><div class="paywall">Sign up to read more.</div></body></html>`;
  const ldExt = EXTRACT.rdExtract(ldHtml, 'https://pangan-clone.id/stok-beras');
  assert.equal(ldExt.textSource, 'jsonld_articleBody');
  assert.equal(ldExt.isFallback, false);
  assert.equal(ldExt.thin, false);
  assert.equal(ldExt.paras.length, 2);
});

test('17. Article extraction returns unrelated text -> Reject off-topic hijacked or mismatched content', () => {
  const hijackedHtml = `<html><head><title>Promo Slot Gacor Maxwin Hari Ini Deposit Pulsa</title></head><body><article>
    <p>Daftar sekarang situs permainan online terbaik dengan bonus deposit harian tanpa potongan untuk member baru.</p>
    <p>Nikmati layanan pelanggan dua puluh empat jam serta sistem penarikan instan ke seluruh rekening bank lokal.</p>
  </article></body></html>`;

  const ext = EXTRACT.rdExtract(hijackedHtml, 'https://kompas-clone.id/banjir-bandang-garut', {
    expectedTitle: 'Banjir Bandang Terjang Tiga Kecamatan di Garut Selatan',
  });
  assert.equal(ext.ok, false);
  assert.equal(ext.offTopic, true);
  assert.equal(ext.extraction.quality.isOnTopic, false);
});

// ---------------------------------------------------------------------------
// 18-19. Transient Upstream Failures, Schema Caching, & Cross-CDN Dedup
// ---------------------------------------------------------------------------

test('18. Transient upstream failure does not permanently poison cache and recovers cleanly on retry', async () => {
  const imgUrl = 'https://cdn.pub.id/2026/foto-sempat-503.jpg';
  let calls = 0;
  const flakyProbe = async () => {
    calls++;
    if (calls === 1) return { ok: false, reason: 'http_503', transient: true, detail: '503' };
    const buf = makeJpegBuffer(1200, 800, 19500, 140);
    const ins = MEDIA.inspectImageBuffer(buf, 'image/jpeg');
    return { ok: true, w: ins.w, h: ins.h, mime: ins.mime, bytes: buf.length, fingerprint: ins.fingerprint, finalUrl: imgUrl };
  };

  const html = `<html><head><meta property="og:image" content="${imgUrl}"></head><body><article><p>Berita uji ketahanan cache saat CDN gambar mengalami error sementara.</p></article></body></html>`;
  const articleUrl = 'https://pub.id/berita/uji-retry-' + Date.now();

  const first = await MEDIA.resolveArticleMedia({ requestedUrl: articleUrl, html, probeFn: flakyProbe });
  assert.equal(first.hero.url, '');
  assert.equal(first.hero.status, 'probe_transient_failure');
  assert.equal(first.transientFailure, true);

  // Put transient failure into server mediaCache, then rewind its timestamp by >15s to confirm short transient TTL expiry
  SRV.mediaCacheSet([articleUrl], first);
  assert.ok(SRV.mediaCacheGet(articleUrl), 'short transient entry exists immediately within 15s');
  const ck = 'v' + SRV.PIPELINE_VERSION + ':' + MEDIA.canonicalArticleUrl(articleUrl);
  SRV.thumbCache.get(ck).at -= 20000;
  assert.equal(SRV.mediaCacheGet(articleUrl), null, 'transient failure cache must expire within <=20s rather than poisoning for 15 minutes');

  // Retry succeeds and persists cleanly
  const second = await MEDIA.resolveArticleMedia({ requestedUrl: articleUrl, html, probeFn: flakyProbe });
  assert.equal(second.hero.url, imgUrl);
  assert.equal(second.hero.verified, true);
  assert.equal(second.transientFailure, false);

  // Also test versioned schema rejection in readCache & thumbCache
  SRV.thumbCache.set(ck, { v: second, at: Date.now(), schemaVersion: SRV.PIPELINE_VERSION - 1 });
  assert.equal(SRV.mediaCacheGet(articleUrl), null, 'stale prior pipeline schemaVersion must be ignored automatically');
});

test('19. Duplicate image via different CDN URLs -> Deduplicate cleanly using SHA-1 payload fingerprint', async () => {
  const ogHero = 'https://cdn-primary.media.id/uploads/2026/11/abc123-main.jpg';
  const bodyProxyDup = 'https://imgproxy.othercdn.net/unsafe/fit-in/800x600/filters:quality(80)/different-slug-name.webp';
  const distinctBodyImg = 'https://cdn-primary.media.id/uploads/2026/11/distinct-second.jpg';

  const sharedBytes = makeJpegBuffer(1200, 750, 22000, 200);
  const distinctBytes = makeJpegBuffer(1000, 650, 17500, 201);
  assert.notEqual(
    crypto.createHash('sha1').update(sharedBytes).digest('hex'),
    crypto.createHash('sha1').update(distinctBytes).digest('hex')
  );

  const html = `<html><head><meta property="og:image" content="${ogHero}"></head><body><article>
    <p>Paragraf pertama tentang sidang paripurna anggaran daerah tahun depan berlangsung lancar.</p>
    <figure><img src="${bodyProxyDup}"><figcaption>Duplikat gambar hero via proxy CDN berbeda</figcaption></figure>
    <p>Paragraf kedua menjelaskan rincian alokasi dana infrastruktur dan pendidikan.</p>
    <figure><img src="${distinctBodyImg}"><figcaption>Suasana diskusi komisi anggaran.</figcaption></figure>
  </article></body></html>`;

  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://media.id/politik/paripurna-apbd',
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe({
      [ogHero]: { buf: sharedBytes, ct: 'image/jpeg' },
      [bodyProxyDup]: { buf: Buffer.from(sharedBytes), ct: 'image/jpeg' },
      [distinctBodyImg]: { buf: distinctBytes, ct: 'image/jpeg' },
    }),
  });

  // Notice bodyProxyDup is first image in body ('body_lead') -> chosen as hero OR if distinct/og, shared fingerprint prevents duplicate!
  assert.ok(res.hero.verified);
  assert.equal(res.bodyImages.length, 1, 'duplicate SHA-1 CDN image must never appear in both hero and bodyImages');
  assert.equal(res.bodyImages[0].url, distinctBodyImg);
  assert.equal(res.bodyImages[0].cap, 'Suasana diskusi komisi anggaran.');
});

// ---------------------------------------------------------------------------
// Bonus: Canonical URL Normalization + Balanced Semantic HTML Preservation
// ---------------------------------------------------------------------------

test('20. Canonical URL preserves distinguishing params (?id, ?page) while stripping tracking params, and preserves headings/lists/blockquotes', () => {
  assert.equal(
    MEDIA.canonicalArticleUrl('https://news.id/read?id=101&utm_source=x&fbclid=aaa#section1'),
    'https://news.id/read?id=101'
  );
  assert.equal(
    MEDIA.canonicalArticleUrl('https://news.id/read?id=202&utm_medium=rss'),
    'https://news.id/read?id=202'
  );
  assert.notEqual(
    MEDIA.canonicalArticleUrl('https://news.id/read?id=101'),
    MEDIA.canonicalArticleUrl('https://news.id/read?id=202')
  );

  const richHtml = `<html><head><title>Laporan Cuaca Ekstrem BMKG Pekan Ini</title></head><body><div class="detail-body">
    <p>Badan Meteorologi Klimatologi dan Geofisika memperingatkan potensi hujan lebat disertai angin kencang di sejumlah wilayah Indonesia bagian barat.</p>
    <h2>Wilayah Terdampak Utama</h2>
    <p>Sejumlah provinsi seperti Jawa Barat, Banten, dan Sumatera Selatan masuk dalam status siaga potensi banjir serta tanah longsor selama tiga hari ke depan.</p>
    <blockquote>Kami mengimbau pemerintah daerah memastikan saluran drainase bersih dan siap menghadapi puncak curah hujan pekan ini.</blockquote>
    <ul>
      <li>Periksa prakiraan cuaca harian sebelum bepergian ke luar kota</li>
      <li>Hindari berteduh di bawah pohon besar atau papan reklame saat angin kencang</li>
    </ul>
  </div></body></html>`;

  const ext = EXTRACT.rdExtract(richHtml, 'https://cuaca-clone.id/bmkg-pekan-ini');
  assert.equal(ext.ok, true);
  assert.ok(ext.blocks.some(b => b.k === 'h' && b.t === 'Wilayah Terdampak Utama'));
  assert.ok(ext.blocks.some(b => b.k === 'q' && b.t.includes('saluran drainase bersih')));
  assert.ok(ext.blocks.some(b => b.k === 'li' && b.t.includes('papan reklame')));
});

test('21. Comment reCAPTCHA scripts inside >=45KB full articles do not false-trigger challenge rejection, and 2-story archive photo reuse is preserved while >=3-story feed logos are rejected', async () => {
  // A) Full >45KB Indonesian article with comment-box reCAPTCHA script must extract cleanly
  const padding = '<!-- layout-pad -->'.repeat(2400);
  const fullWithRecaptcha = `<html><head>
    <title>KAI Pastikan Jalur Rel Lintas Selatan Aman Dilalui Pasca Perbaikan</title>
    <script src="https://www.google.com/recaptcha/api.js"></script>
  </head><body>${padding}<article class="article-body">
    <p>PT Kereta Api Indonesia memastikan seluruh jalur rel kereta api di lintas selatan Jawa Barat telah aman dilalui rangkaian kereta penumpang pagi ini.</p>
    <p>Tim prasarana selesai memperbaiki bantalan rel yang sempat tergerus luapan air hujan semalaman sehingga perjalanan kembali normal tepat waktu.</p>
  </article></body></html>`;
  assert.ok(fullWithRecaptcha.length >= 45000);
  const ext = EXTRACT.rdExtract(fullWithRecaptcha, 'https://media.id/kai-jalur-selatan');
  assert.equal(ext.ok, true);
  assert.equal(ext.extraction.quality.isChallengeOrError, false);
  assert.equal(ext.paras.length, 2);

  // B) Archival portrait reused across 2 breaking follow-up stories in a feed must NOT be falsely rejected as a site logo
  const followUpRss = `
    <rss><channel>
      <item><title>Pejabat A Diperiksa KPK</title><link>https://media.id/news/1</link><enclosure url="https://cdn.media.id/photos/pejabat-a-archive.jpg" type="image/jpeg"/></item>
      <item><title>Pejabat A Beri Klarifikasi Resmi</title><link>https://media.id/news/2</link><enclosure url="https://cdn.media.id/photos/pejabat-a-archive.jpg" type="image/jpeg"/></item>
    </channel></rss>`;
  const twoItems = SRV.parseFeed(followUpRss, 'https://media.id/rss');
  assert.equal(twoItems.length, 2);
  assert.equal(twoItems[0].rssImg, 'https://cdn.media.id/photos/pejabat-a-archive.jpg');
  assert.equal(twoItems[1].rssImg, 'https://cdn.media.id/photos/pejabat-a-archive.jpg');

  const tracker = new MEDIA.AssetReuseTracker();
  const sharedPhoto = 'https://cdn.media.id/photos/pejabat-a-archive.jpg';
  const buf = makeJpegBuffer(1200, 800, 18000, 211);
  const probeFn = inspectAndMakeProbe({ [sharedPhoto]: { buf, ct: 'image/jpeg' } });
  const r1 = await MEDIA.resolveArticleMedia({ requestedUrl: 'https://media.id/news/1', rssImgs: [sharedPhoto], probeFn, reuseTracker: tracker });
  const r2 = await MEDIA.resolveArticleMedia({ requestedUrl: 'https://media.id/news/2', rssImgs: [sharedPhoto], probeFn, reuseTracker: tracker });
  const r3 = await MEDIA.resolveArticleMedia({ requestedUrl: 'https://media.id/news/3', rssImgs: [sharedPhoto], probeFn, reuseTracker: tracker });
  assert.equal(r1.hero.url, sharedPhoto);
  assert.equal(r2.hero.url, sharedPhoto, '2nd follow-up article sharing archival portrait must keep verified hero');
  assert.equal(r3.hero.url, '', '3rd+ distinct article reusing same image triggers site-wide reuse rejection');

  // C) Frontend desc retry & fallback cache rules present in public/index.html
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('retryMap[u]'), 'runDescEnrich must honor backend transient retryable flag instead of 12m dead-locking');
  assert.ok(indexHtml.includes('!d.wireFallback && !d.upstreamBlocked && !d.isFallback'), 'rdOpen/rdPrefetch must not permanently cache transient fallback responses');
  assert.ok(indexHtml.includes('id="rd-fb-retry"'), 'empty restriction fallback notice must expose retry control alongside source link');
});

test('22. BANNED_SRC filters paid koran.tempo.co / majalah.tempo.co / plus.tempo.co across direct RSS, Google News wrappers, descForUrl, and rdRead', async () => {
  const nowRfc = new Date().toUTCString();
  const rss = `
    <rss><channel>
      <item><title>Edisi Koran Berbayar</title><link>https://koran.tempo.co/read/nasional/123</link><pubDate>${nowRfc}</pubDate><description>Edisi koran</description></item>
      <item><title>Edisi Majalah Berbayar</title><link>https://majalah.tempo.co/read/investigasi/456</link><pubDate>${nowRfc}</pubDate><description>Edisi majalah</description></item>
      <item><title>Tempo Plus Path</title><link>https://www.tempo.co/plus/789/eks</link><pubDate>${nowRfc}</pubDate><description>Plus</description></item>
      <item><title>GN Koran Tempo</title><link>https://news.google.com/rss/articles/CBMiKoranTest</link><pubDate>${nowRfc}</pubDate><source url="https://koran.tempo.co">Koran Tempo</source></item>
      <item><title>GN Majalah Tempo</title><link>https://news.google.com/rss/articles/CBMiMajalahTest</link><pubDate>${nowRfc}</pubDate><source url="https://majalah.tempo.co">Majalah Tempo</source></item>
      <item><title>Berita Tempo Gratis Politik Nasional</title><link>https://www.tempo.co/politik/berita-terbuka-999</link><pubDate>${nowRfc}</pubDate><description>Ringkasan berita terbuka untuk publik Indonesia.</description></item>
      <item><title>GN Tempo Reguler</title><link>https://news.google.com/rss/articles/CBMiTempoFree</link><pubDate>${nowRfc}</pubDate><source url="https://www.tempo.co">Tempo.co</source></item>
    </channel></rss>`;

  const parsed = SRV.parseFeed(rss, 'https://news.google.com/rss');
  assert.equal(parsed.length, 2, 'only free www.tempo.co items must survive BANNED_SRC filtering');
  assert.deepEqual(parsed.map(i => i.title), ['Berita Tempo Gratis Politik Nasional', 'GN Tempo Reguler']);

  const paidUrl = 'https://koran.tempo.co/read/ekonomi/98765/uji-eksklusif';
  assert.equal(await SRV.descForUrl(paidUrl), '', 'descForUrl must immediately return empty for banned paid Tempo URL');
  await assert.rejects(() => SRV.rdRead(paidUrl, false), err => err && err.transient === false && /berbayar|dikecualikan/i.test(err.message));
});

test('23. Related-article card links & 15+ body thumbnails never starve og:image hero selection, and upgradeImage leaves .svg icons untouched', async () => {
  // SVG URLs on detik CDN must not receive raster query params
  assert.equal(
    MEDIA.upgradeImage('https://cdn.detik.net.id/20detik4/images/close-button.svg?v=123'),
    'https://cdn.detik.net.id/20detik4/images/close-button.svg?v=123'
  );

  // Sindo-style layout: 15 related-article 228x152 cards + 15 small bare body_lead thumbs inside container alongside valid 850x567 og:image
  const relatedCards = Array.from({ length: 15 }, (_, i) =>
    `<a href="https://sports.media.id/read/100${i}/artikel-lama-${i}"><div class="img-article"><img width="228" height="152" class="lazyload" src="https://cdn.media.id/pre.png" data-src="https://pict.media.id/webp/228/old-${i}.webp"></div><div class="title-article news-title">Artikel Terkait Lama Nomor ${i} yang Sudah Tayang</div></a>`
  ).join('\n');
  // Also simulate 15 non-linked small thumbnails inside body to verify pickProbeQueue slot reservation independently
  const smallBodyLead = Array.from({ length: 15 }, (_, i) =>
    `<div class="detail-image"><img width="228" height="152" src="https://pict.media.id/webp/228/widget-${i}.webp" alt="foto ${i}"></div>`
  ).join('\n');
  const heroOg = 'https://pict.media.id/dyn/850/main-hero-article.jpg';

  const html = `<html><head>
    <meta property="og:image" content="${heroOg}">
  </head><body>
    <div class="detail-desc">
      ${relatedCards}
      ${smallBodyLead}
      <p>Tim investigasi lapangan mencatat perbaikan jaringan distribusi logistik berjalan sesuai jadwal sejak subuh.</p>
      <p>Sejumlah petugas dikerahkan ke titik simpul utama untuk memastikan kelancaran pasokan hingga malam hari.</p>
    </div>
  </body></html>`;

  const responses = {
    [heroOg]: { buf: makeJpegBuffer(850, 567, 22000, 91), ct: 'image/jpeg' },
  };
  for (let i = 0; i < 15; i++) {
    responses[`https://pict.media.id/webp/228/old-${i}.webp`] = { buf: makeJpegBuffer(228, 152, 6500, 30 + i), ct: 'image/jpeg' };
    responses[`https://pict.media.id/webp/228/widget-${i}.webp`] = { buf: makeJpegBuffer(228, 152, 6500, 60 + i), ct: 'image/jpeg' };
  }

  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: 'https://sports.media.id/read/9999/liputan-utama-hari-ini',
    canonicalUrl: 'https://sports.media.id/read/9999/liputan-utama-hari-ini',
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe(responses),
  });

  assert.equal(res.hero.url, heroOg, 'og:image hero must not be starved by >14 small body_lead/related candidates');
  assert.equal(res.hero.verified, true);
  assert.ok(!res.diagnostics.discovered.some(d => d.url.includes('/old-')), 'related <a href> card images must be stripped before discovery');
});

test('24. Rolling 24h news history retains rotated RSS tail items, keeps 01 Globe / situation parity (>400 pins), and fixes dead CNA/GNEWS Kesehatan feeds & sync', async () => {
  // A) Feed URL fixes verified in SRV.NEWS
  const cnaEntry = SRV.NEWS.find(([id]) => id === 'CNA INDONESIA');
  const kesEntry = SRV.NEWS.find(([id]) => id === 'GNEWS · KESEHATAN');
  assert.ok(cnaEntry && !/category=3321/.test(cnaEntry[1]), 'CNA INDONESIA feed must use active main endpoint without stale category=3321');
  assert.ok(kesEntry && kesEntry[1].split('OR').length <= 15, 'GNEWS · KESEHATAN query must stay compact so Google News respects when:2d');
  const serverSrc = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.ok(serverSrc.includes("if (id === 'VOI')") && serverSrc.includes('site:voi.id when:2d'), 'VOI feed must fall back fast to Google News site:voi.id when direct RSS is Cloudflare 403');

  // B) Rolling 24h mergeNewsHist preserves older <24h events pushed off short RSS tails while pruning >24h and deduping rotating GNews links
  const feedId = '__TEST_HIST__';
  const now = Date.now();
  try {
    const firstBatch = [
      { title: 'Kebakaran Gudang di Bekasi Pagi Ini', url: 'https://news.example.id/bekasi-1', ts: now - 10 * 3600e3, pub: 'Antara', desc: 'Gudang logistik terbakar di Bekasi.' },
      { title: 'Banjir Merendam Demak', url: 'https://news.google.com/rss/articles/CBMiOldToken1', ts: now - 5 * 3600e3, pub: 'Kompas', desc: '' },
      { title: 'Berita Basi Kemarin Lusa', url: 'https://news.example.id/old-expired', ts: now - 26 * 3600e3, pub: 'Antara', desc: '' },
      { title: 'Artikel Koran Tempo Berbayar', url: 'https://koran.tempo.co/read/1', ts: now - 2 * 3600e3, pub: 'Koran Tempo', desc: '' },
    ];
    const m1 = SRV.mergeNewsHist(feedId, firstBatch, now, { persist: false });
    assert.equal(m1.length, 2, 'expired >24h and banned paid items must be pruned');

    // Second fetch pushes out 'bekasi-1' from RSS XML and rotates GNews URL for 'Banjir Merendam Demak'
    const secondBatch = [
      { title: 'Banjir Merendam Demak', url: 'https://news.google.com/rss/articles/CBMiRotatedToken2', ts: now - 4 * 3600e3, pub: 'Kompas', desc: 'Air setinggi 50 cm merendam Demak.' },
      { title: 'Gempa Dangkal Guncang Garut', url: 'https://news.example.id/garut-2', ts: now - 15 * 60e3, pub: 'Antara', desc: 'Gempa dirasakan warga Garut.' },
    ];
    const m2 = SRV.mergeNewsHist(feedId, secondBatch, now, { persist: false });
    assert.equal(m2.length, 3, 'bekasi-1 (10h ago) must survive XML rotation and rotated GNews duplicate must collapse into 1');
    assert.equal(m2.find(i => i.title === 'Banjir Merendam Demak').desc, 'Air setinggi 50 cm merendam Demak.');

    // C) Parity between incidents() (>400 pins supported via 800 cap) and situation().located
    SRV.cache.clear();
    SRV.bodyCache.clear();
    const seededEvents = Array.from({ length: 420 }, (_, i) => ({
      title: `Kebakaran Pabrik Sektor-${i} Terjadi di Bandung`,
      url: `https://news.example.id/ev-${i}`,
      ts: now - (i + 1) * 60000,
      pub: 'MediaRI',
      desc: 'Api melalap area gudang di Bandung.',
      src: SRV.NEWS[0][0],
    }));
    for (const [fid] of SRV.NEWS) {
      SRV.cache.set('n:' + fid, {
        at: Date.now(),
        v: { id: fid, ok: true, stale: false, items: fid === SRV.NEWS[0][0] ? seededEvents : [] },
      });
    }
    const [inc, sit] = await Promise.all([SRV.incidents(), SRV.situation()]);
    assert.ok(inc.total > 400, 'merged incidents count should support >400 active 24h events without artificial 400 cap');
    assert.equal(inc.items.filter(x => !x.fixed).length, inc.total, 'incidents() items must not clip at 400');
    assert.equal(sit.located, inc.total, 'situation().located (#sit-total) must match incidents().total');

    // invalidateDerivedFromNews clears both situation & incidents derived caches
    SRV.invalidateDerivedFromNews();
    assert.equal(SRV.cache.has('situation'), false);
    assert.equal(SRV.cache.has('incidents'), false);
  } finally {
    SRV.newsHistByFeed.delete(feedId);
    SRV.cache.clear();
    SRV.bodyCache.clear();
  }

  // D) Frontend sync wiring: syncGlobeSoon pulls situation, refreshAll passes fresh, and 60s pullIncidents runs on closed-map dashboard
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('pullIncidents(); pullSituation();'), 'syncGlobeSoon must refresh both globe pins and #sit-total KPI');
  assert.ok(indexHtml.includes('schedulePoll(() => pullIncidents(), 60000,'), '60s globe incident refresh must run even when fullscreen map is closed');
  assert.ok(indexHtml.includes('await Promise.all([pullMedia(manual), pullSituation(manual), pullStocks()]);'), 'manual refresh must pass fresh flag to both news and situation');
});

test('25. Standalone featured <img> outside content container and editorial thumb_<slug> OG URLs resolve cleanly', async () => {
  const url = 'https://tribratanews-resmesuji.lampung.polri.go.id/detail-post/patroli-strong-point';
  const fullImg = 'https://tribratanews-resmesuji.lampung.polri.go.id/berkas/post-images/2026-11/patroli-strong-point.jpg';
  const ogThumbImg = 'https://tribratanews-resmesuji.lampung.polri.go.id/berkas/post-images/2026-11/thumb_patroli-strong-point.jpg';
  const html = `<!doctype html><html><head>
    <meta property="og:image" content="${ogThumbImg}">
  </head><body>
    <header><img src="https://tribratanews-resmesuji.lampung.polri.go.id/berkas/settings/logo-header.png" alt="Logo"></header>
    <img src="${fullImg}" class="tb-article-featured-img img-fluid" alt="Polres Mesuji Patroli" loading="eager">
    <div class="tb-article-content">
      MESUJI – Personel Polres Mesuji melaksanakan patroli pengaturan lalu lintas pada malam hari.</p>
    </div>
  </body></html>`;

  assert.equal(MEDIA.classifyCandidateUrl(ogThumbImg, { role: 'hero' }).ok, true);
  assert.equal(MEDIA.classifyCandidateUrl('https://news.example.id/gallery/thumb_small.jpg', { role: 'hero' }).ok, false);
  assert.equal(MEDIA.classifyCandidateUrl('https://news.example.id/gallery/thumb_01.jpg', { role: 'hero' }).ok, false);
  assert.equal(MEDIA.imageKey(ogThumbImg), MEDIA.imageKey(fullImg));

  const res = await MEDIA.resolveArticleMedia({
    requestedUrl: url,
    canonicalUrl: url,
    html,
    mode: 'full',
    probeFn: inspectAndMakeProbe({
      [fullImg]: { buf: makePngBuffer(1152, 864, 18000, 91), ct: 'image/jpeg' },
      [ogThumbImg]: { buf: makePngBuffer(600, 450, 9500, 92), ct: 'image/jpeg' },
    }),
  });
  assert.equal(res.hero.verified, true);
  assert.equal(res.hero.url, fullImg);
  assert.equal(res.hero.source, 'body_lead');
});
