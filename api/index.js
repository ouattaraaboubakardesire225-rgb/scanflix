// ScanFlix : point d'entrée du serveur (routes, manifeste, service worker, icônes)
const zlib = require('zlib');
const L = require('./_lib');
const H = require('./_h');

const MANIFEST = JSON.stringify({
  name: 'ScanFlix',
  short_name: 'ScanFlix',
  description: "Trouve le titre d'un film depuis une capture d'écran.",
  lang: 'fr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0B1226',
  theme_color: '#0B1226',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const SW_JS = `
const CACHE = 'scanflix-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});
`;

// ---- Icônes PNG dessinées par le code ----
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeIcon(size, padRatio) {
  const p = size * padRatio, box = size - 2 * p;
  const w = Math.max(3, size * 0.04), len = box * 0.28;
  const cx = size / 2, cy = size / 2, r = box * 0.2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      let rgb = [11, 18, 38];
      const u = Math.min(x, size - 1 - x), v = Math.min(y, size - 1 - y);
      const corner = (u >= p && u < p + w && v >= p && v < p + len) || (v >= p && v < p + w && u >= p && u < p + len);
      const x0 = cx - r * 0.7;
      const tri = x >= x0 && x <= cx + r * 1.1 && Math.abs(y - cy) <= r * (1 - (x - x0) / (r * 1.8));
      if (corner || tri) rgb = [255, 107, 90];
      raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ICONS = {};
function icon(s) {
  if (!ICONS[s]) ICONS[s] = s === 'maskable' ? makeIcon(512, 0.3) : makeIcon(s === '512' ? 512 : 192, 0.18);
  return ICONS[s];
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = (req.query && req.query.route) || url.searchParams.get('route') || url.pathname.split('/').pop();
  if (route === 'manifest') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    return res.end(MANIFEST);
  }
  if (route === 'sw') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    return res.end(SW_JS);
  }
  if (route === 'icon') {
    const s = (req.query && req.query.s) || url.searchParams.get('s') || '192';
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(icon(s));
  }
  const h = H[route];
  if (!h) return L.json(res, 404, { error: 'Route inconnue.' });
  return h(req, res);
};
