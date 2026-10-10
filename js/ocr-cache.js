// =============================================================
// OCR Cache v2 — Two-tier LRU + IndexedDB persistent
// - L1: in-memory Map (max 20 entries)
// - L2: IndexedDB (max 200 entries, có index ts để evict)
// - API giữ nguyên như bản localStorage cũ
// =============================================================

import { showConfirm } from './dialog.js';
import { showToast } from './ui.js';

// ==================== CONFIG ====================
const OCR_CACHE_VERSION = 'v2-idb';     // ⚠️ đổi version → cache cũ không match
const DB_NAME = 'spx_ocr_cache';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const MEM_MAX = 20;         // entries giữ trong RAM
const DB_MAX = 200;         // entries giữ trong IDB
const DB_MAX_BYTES = 8 * 1024 * 1024;   // 8MB (IDB không giới hạn như localStorage)

// ==================== STATE ====================
let _db = null;
let _dbPromise = null;
const _mem = new Map();     // LRU: key → { value, ts }
let _migrationDone = false;

// ==================== OPEN DB ====================
function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('by_ts', 'ts', { unique: false });
      }
    };

    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { _db.close(); _db = null; _dbPromise = null; };
      resolve(_db);
    };

    req.onerror = () => {
      console.warn('[OcrCache] Không mở được IndexedDB:', req.error);
      reject(req.error);
    };
  });

  return _dbPromise;
}

// ==================== HELPERS ====================
function _cacheKey(hash) {
  return `${OCR_CACHE_VERSION}_${hash}`;
}

function _memGet(key) {
  const entry = _mem.get(key);
  if (!entry) return null;
  // LRU: move to end
  _mem.delete(key);
  _mem.set(key, entry);
  return entry.value;
}

function _memSet(key, value) {
  _mem.set(key, { value, ts: Date.now() });
  while (_mem.size > MEM_MAX) {
    const oldest = _mem.keys().next().value;
    _mem.delete(oldest);
  }
}

// ==================== PUBLIC API ====================

/**
 * Lấy value từ cache (đồng bộ với API cũ).
 * Trả về null nếu miss.
 *
 * ⚠️ Hàm này SYNC nhưng sẽ CHỈ đọc L1 memory. Để đọc L2 (IDB),
 * dùng cacheGetAsync() bên dưới. ocr.js nên gọi cacheGetAsync.
 */
export function cacheGet(hash) {
  const key = _cacheKey(hash);
  return _memGet(key);
}

/**
 * Bản async — đọc cả L1 + L2. Dùng trong ocr.js pipeline.
 */
export async function cacheGetAsync(hash) {
  const key = _cacheKey(hash);

  // L1
  const memVal = _memGet(key);
  if (memVal) return memVal;

  // L2
  try {
    const db = await openDB();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });

    if (!entry) return null;

    // Promote L1
    _memSet(key, entry.value);
    return entry.value;
  } catch (e) {
    console.warn('[OcrCache] cacheGetAsync lỗi:', e);
    return null;
  }
}

/**
 * Ghi vào cache — fire-and-forget cho L2.
 * L1 ghi ngay (sync), L2 ghi async (không block pipeline).
 */
export function cacheSet(hash, value) {
  const key = _cacheKey(hash);

  // L1 sync
  _memSet(key, value);

  // L2 async
  _dbSet(key, value).catch(e => console.warn('[OcrCache] L2 write fail:', e));
}

async function _dbSet(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, value, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Evict nếu vượt DB_MAX
    await _evictIfNeeded();
  } catch (e) {
    // QuotaExceededError → evict rồi thử lại 1 lần
    if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
      await _evictOldest(50);
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ key, value, ts: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      throw e;
    }
  }
}

// ==================== EVICTION ====================
async function _evictIfNeeded() {
  const db = await openDB();

  // Đếm entries
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  if (count > DB_MAX) {
    await _evictOldest(count - DB_MAX + 20);   // evict dư 20 để không evict liên tục
  }
}

async function _evictOldest(n) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const idx = store.index('by_ts');
    const cursorReq = idx.openCursor();
    let removed = 0;

    cursorReq.onsuccess = e => {
      const cursor = e.target.result;
      if (!cursor || removed >= n) return;
      store.delete(cursor.primaryKey);
      removed++;
      cursor.continue();
    };

    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  });
}

// ==================== CLEAR ====================
/**
 * Xóa cache OCR (giữ API cũ — showConfirm + showToast bên trong).
 */
export async function clearOcrCache() {
  const ok = await showConfirm(
    'Xóa toàn bộ cache OCR?\n\nLần sau quét lại ảnh cũ sẽ phải OCR từ đầu.',
    { title: '🗑️ Xóa cache OCR', okText: 'Xóa', cancelText: 'Hủy', danger: true }
  );
  if (!ok) return 0;

  let count = 0;

  // L1
  count += _mem.size;
  _mem.clear();

  // L2
  try {
    const db = await openDB();
    count += await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      let c = 0;
      countReq.onsuccess = () => { c = countReq.result; };
      store.clear();
      tx.oncomplete = () => resolve(c);
      tx.onerror = () => resolve(0);
    });
  } catch (e) {
    console.warn('[OcrCache] clear L2 fail:', e);
  }

  // Legacy: dọn cache localStorage từ version cũ (migration)
  count += _cleanLegacyLocalStorage();

  showToast(`Đã xóa ${count} cache OCR`, 'success', 2500);
  return count;
}

// ==================== STATS ====================
/**
 * Trả về stats (giữ shape cũ để main.js không phải sửa).
 */
export function getOcrCacheStats() {
  return {
    ramEntries: _mem.size,
    lsEntries: _lastIdbCount,     // expose ra để main.js hiển thị "LS" — thực chất là IDB
    sizeKB: _lastIdbSizeKB,
    maxEntries: DB_MAX,
    maxSizeKB: Math.round(DB_MAX_BYTES / 1024)
  };
}

// Cache stats của lần đọc gần nhất (để getOcrCacheStats sync)
let _lastIdbCount = 0;
let _lastIdbSizeKB = 0;

/**
 * Refresh stats — gọi khi mở Settings modal. Async.
 */
export async function refreshOcrCacheStats() {
  try {
    const db = await openDB();
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    // Ước lượng size: đọc 50 entries, lấy trung bình
    let total = 0, scanned = 0;
    await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const cursor = tx.objectStore(STORE_NAME).openCursor();
      cursor.onsuccess = e => {
        const c = e.target.result;
        if (!c || scanned >= 50) { resolve(); return; }
        try { total += JSON.stringify(c.value).length * 2; } catch {}
        scanned++;
        c.continue();
      };
      cursor.onerror = () => resolve();
    });

    _lastIdbCount = count;
    const avg = scanned > 0 ? total / scanned : 0;
    _lastIdbSizeKB = Math.round((avg * count) / 1024);
  } catch (e) {
    console.warn('[OcrCache] refreshStats fail:', e);
    _lastIdbCount = 0;
    _lastIdbSizeKB = 0;
  }

  return getOcrCacheStats();
}

// ==================== MIGRATION ====================
/**
 * Dọn cache localStorage từ version cũ (v1b-3).
 * Chạy 1 lần, tự động trong initOcrCache().
 */
function _cleanLegacyLocalStorage() {
  const LS_PREFIX = 'spx_ocr_ls_';
  const LS_INDEX = 'spx_ocr_ls_index';
  let removed = 0;

  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) toRemove.push(key);
    }
    toRemove.forEach(k => {
      try { localStorage.removeItem(k); removed++; } catch {}
    });
    localStorage.removeItem(LS_INDEX);
  } catch (e) {
    console.warn('[OcrCache] Legacy cleanup fail:', e);
  }

  return removed;
}

/**
 * Init — gọi 1 lần khi app khởi động.
 * - Mở IDB
 * - Dọn cache localStorage cũ
 */
export async function initOcrCache() {
  if (_migrationDone) return;
  _migrationDone = true;

  try {
    await openDB();

    // Migration: đọc cache từ localStorage cũ → chuyển sang IDB
    await _migrateFromLocalStorage();

    // Sau migration, dọn sạch localStorage
    _cleanLegacyLocalStorage();

    console.log('[OcrCache] Đã khởi tạo IDB cache');
  } catch (e) {
    console.warn('[OcrCache] Init fail — fallback RAM-only:', e);
  }
}

async function _migrateFromLocalStorage() {
  const LS_PREFIX = 'spx_ocr_ls_';
  const LS_INDEX = 'spx_ocr_ls_index';

  let index = [];
  try {
    const raw = localStorage.getItem(LS_INDEX);
    if (raw) index = JSON.parse(raw);
  } catch {}

  if (!Array.isArray(index) || index.length === 0) return;

  let migrated = 0;

  for (const fullKey of index) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + fullKey);
      if (!raw) continue;

      const value = JSON.parse(raw);
      if (!value) continue;

      // fullKey có dạng "v1b-3_<hash>" → strip version cũ, thêm version mới
      const hashPart = fullKey.split('_').slice(1).join('_');
      if (!hashPart) continue;

      const newKey = _cacheKey(hashPart);

      await _dbSet(newKey, value);
      _memSet(newKey, value);
      migrated++;
    } catch (e) {
      // Ignore entry lỗi, tiếp tục entry khác
    }
  }

  if (migrated > 0) {
    console.log(`[OcrCache] Migration: ${migrated}/${index.length} entries`);
  }
}

// ==================== DEBUG (console) ====================
/**
 * Expose ra window để debug: liệt kê cache keys.
 */
export async function debugListCache() {
  try {
    const db = await openDB();
    return await new Promise(resolve => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}