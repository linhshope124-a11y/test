// =============================================================
// OCR CACHE trên IndexedDB
// - Bất đồng bộ: không chặn giao diện như localStorage
// - Không chiếm hạn mức localStorage (~5MB) của dữ liệu sản lượng
// - LRU theo thời điểm dùng; lỗi cache KHÔNG bao giờ làm hỏng luồng OCR
// =============================================================

const DB_NAME       = 'spx_ocr_cache';
const STORE         = 'results';
const CACHE_VERSION = 'v1b-3';
const MAX_ENTRIES   = 200;      // vượt mức → xóa cũ nhất còn 80%
const MEM_MAX       = 50;       // LRU trong RAM
const LEGACY_PREFIX = 'spx_ocr_ls_';

const mem = new Map();          // Map giữ thứ tự chèn → dùng làm LRU
let _db = null;

const keyOf = h => `${CACHE_VERSION}_${h}`;

function touchMem(key, value) {
  mem.delete(key);
  mem.set(key, value);
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

function openDb() {
  if (!_db) {
    _db = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB không khả dụng'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('ts', 'ts');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); _db = null; };
        resolve(db);
      };
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bị chặn'));
    });
    _db.catch(() => { _db = null; });   // lần sau thử mở lại
  }
  return _db;
}

async function openStore(mode) {
  const db = await openDb();
  const t = db.transaction(STORE, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = t.onabort = () => rej(t.error || new Error('IDB transaction lỗi'));
  });
  return { s: t.objectStore(STORE), done };
}

export async function ocrCacheGet(hash) {
  const key = keyOf(hash);
  if (mem.has(key)) { const v = mem.get(key); touchMem(key, v); return v; }
  try {
    const { s, done } = await openStore('readwrite');
    const rec = await new Promise((res, rej) => {
      const r = s.get(key);
      r.onsuccess = () => {
        if (r.result) s.put({ ...r.result, ts: Date.now() });   // cập nhật LRU
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    });
    await done;
    if (!rec) return null;
    touchMem(key, rec.value);
    return rec.value;
  } catch { return null; }
}

export async function ocrCacheSet(hash, value) {
  const key = keyOf(hash);
  touchMem(key, value);
  try {
    const { s, done } = await openStore('readwrite');
    s.put({ key, value, ts: Date.now(), size: JSON.stringify(value).length * 2 });
    s.count().onsuccess = e => {
      const n = e.target.result;
      let drop = n - Math.floor(MAX_ENTRIES * 0.8);
      if (n <= MAX_ENTRIES || drop <= 0) return;
      s.index('ts').openKeyCursor().onsuccess = ev => {
        const c = ev.target.result;
        if (!c || drop-- <= 0) return;
        s.delete(c.primaryKey);
        mem.delete(c.primaryKey);
        c.continue();
      };
    };
    await done;
  } catch (e) {
    console.warn('[OCR cache] Không ghi được:', e?.message || e);
  }
}

export async function ocrCacheClear() {
  mem.clear();
  try {
    const { s, done } = await openStore('readwrite');
    let n = 0;
    s.count().onsuccess = e => { n = e.target.result; s.clear(); };
    await done;
    return n;
  } catch { return 0; }
}

export async function ocrCacheStats() {
  let dbEntries = 0, bytes = 0;
  try {
    const { s, done } = await openStore('readonly');
    s.openCursor().onsuccess = e => {
      const c = e.target.result;
      if (c) { dbEntries++; bytes += c.value.size || 0; c.continue(); }
    };
    await done;
  } catch {}
  return { ramEntries: mem.size, dbEntries, sizeKB: Math.round(bytes / 1024), maxEntries: MAX_ENTRIES };
}

// Dọn cache cũ trong localStorage (tối đa 4MB) — giải phóng hạn mức cho dữ liệu chính.
function purgeLegacyLocalStorage() {
  try {
    const rm = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_PREFIX)) rm.push(k);
    }
    rm.forEach(k => localStorage.removeItem(k));
  } catch {}
}
const _t = setTimeout(purgeLegacyLocalStorage, 3000);
_t?.unref?.();
