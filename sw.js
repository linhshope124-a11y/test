// =============================================================
// SPX Tracker — Service Worker
// Cache: app shell (CACHE) + Tesseract (TESS_CACHE) + Share Target
//
// ⚠️ MỖI LẦN SỬA FILE TRONG CORE → BUMP CACHE VERSION
//    - spx-tracker-v3 → spx-tracker-v4 → ...
//    - TESS_CACHE và SHARE_CACHE KHÔNG cần bump (dữ liệu không đổi)
// =============================================================

const CACHE       = 'spx-tracker-v10';      // ⭐ v3 — sau patch #1, #2, #3
const TESS_CACHE  = 'spx-tesseract-v1';    // giữ nguyên — Tesseract không đổi
const SHARE_CACHE = 'spx-shared-files';    // giữ nguyên — dữ liệu tạm

const CORE = [
  './',
  './index.html',
  './guide.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './css/style.css',
  './js/main.js',
  './js/config.js',
  './js/utils.js',
  './js/state.js',
  './js/calc.js',
  './js/theme.js',
  './js/ocr.js',
  './js/ocr-cache.js',      // ⭐ PATCH #3: file mới
  './js/sw-bridge.js',      // ⭐ PATCH #2: file mới
  './js/ui.js',
  './js/render.js',
  './js/entry.js',
  './js/backup.js',
  './js/cloud.js',
  './js/undo.js',
  './js/dialog.js'
];

// ==================== TESSERACT RUNTIME URLs ====================
// Khi user bấm 📷 lần đầu, 3 URL này được precache.
// Lần sau OCR chạy được cả khi offline.
const TESS_RUNTIME_URLS = [
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd.wasm.js',
  'https://tessdata.projectnaptha.com/4.0.0/vie.traineddata.gz'
];

// ==================== INSTALL ====================
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE))
    // KHÔNG skipWaiting — chờ user bấm "Cập nhật"
  );
});

// ==================== ACTIVATE ====================
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE && k !== TESS_CACHE && k !== SHARE_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(client => client.postMessage({
            type: 'SW_UPDATED',
            version: CACHE
          }));
        });
      })
  );
});

// ==================== MESSAGE ====================
self.addEventListener('message', e => {
  const data = e.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // 📷 Precache Tesseract khi user thực sự dùng OCR
  if (data.type === 'PRECACHE_TESSERACT') {
    e.waitUntil(
      caches.open(TESS_CACHE).then(async cache => {
        const results = await Promise.allSettled(
          TESS_RUNTIME_URLS.map(async url => {
            const existing = await cache.match(url);
            if (existing) return 'cached';
            try {
              const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
              if (res.ok) {
                await cache.put(url, res.clone());
                return 'fetched';
              }
              return 'failed:' + res.status;
            } catch (err) {
              return 'error:' + err.message;
            }
          })
        );
        return results.map(r => r.value || r.reason);
      })
    );
  }
});

// ==================== SHARE TARGET ====================
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const rawFiles = formData.getAll('images');
    const files = rawFiles.filter(f =>
      f && typeof f === 'object' && typeof f.size === 'number' && f.size > 0
    );

    const cache = await caches.open(SHARE_CACHE);
    const oldKeys = await cache.keys();
    await Promise.all(oldKeys.map(k => cache.delete(k)));

    if (files.length > 0) {
      const meta = {
        count: files.length,
        names: files.map(f => f.name || `shared_${Date.now()}.jpg`),
        types: files.map(f => f.type || 'image/jpeg'),
        savedAt: Date.now()
      };

      await cache.put(
        new Request('./spx-shared-meta'),
        new Response(JSON.stringify(meta), {
          headers: { 'Content-Type': 'application/json' }
        })
      );

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        await cache.put(
          new Request(`./spx-shared-file-${i}`),
          new Response(file, {
            headers: { 'Content-Type': file.type || 'image/jpeg' }
          })
        );
      }

      console.log(`[SW] Share target: đã lưu ${files.length} file`);
    }
  } catch (e) {
    console.warn('[SW] Share target error:', e);
  }

  const redirectUrl = new URL('index.html?shared=1', self.registration.scope).href;
  return Response.redirect(redirectUrl, 303);
}

// ==================== STATIC DETECT ====================
function _isStaticAsset(pathname) {
  if (pathname.endsWith('/version.json')) return false;
  return /\.(html|css|js|png|jpg|jpeg|svg|webp|gif|ico|woff|woff2|ttf|otf)$/i.test(pathname);
}

function _isTesseractUrl(url) {
  return TESS_RUNTIME_URLS.some(u => url.startsWith(u.split('?')[0]));
}

// ==================== FETCH ====================
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // POST /share-target
  if (req.method === 'POST') {
    if (url.origin === self.location.origin && url.pathname.endsWith('/share-target')) {
      e.respondWith(handleShareTarget(req));
    }
    return;
  }

  if (req.method !== 'GET') return;

  // ===== Tesseract URLs (cross-origin) =====
  // Cache-first từ TESS_CACHE. Nếu chưa có → fetch rồi cache.
  if (_isTesseractUrl(req.url)) {
    e.respondWith(
      caches.open(TESS_CACHE).then(async cache => {
        const cached = await cache.match(req.url);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && res.status === 200 && res.type !== 'opaque') {
            cache.put(req.url, res.clone()).catch(() => {});
          }
          return res;
        } catch (err) {
          return new Response('', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // ===== Same-origin requests =====
  if (url.origin !== self.location.origin) return;

  // version.json → luôn network (no-store)
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  // Static assets → cache-first
  if (_isStaticAsset(url.pathname)) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(cached => {
        if (cached) return cached;
        return fetch(req)
          .then(res => {
            if (res && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => caches.match('./index.html'));
      })
    );
    return;
  }

  // Còn lại → network-first
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});