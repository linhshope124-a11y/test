// =============================================================
// SW Bridge — giao tiếp với Service Worker
// =============================================================

let _precacheRequested = false;

/**
 * Yêu cầu SW precache Tesseract runtime (chỉ gọi 1 lần/session).
 * Silent fail — không throw nếu SW chưa sẵn sàng.
 *
 * @returns {Promise<boolean>} true nếu đã gửi message thành công
 */
export async function requestPrecacheTesseract() {
  if (_precacheRequested) return false;
  if (!('serviceWorker' in navigator)) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.active) return false;

    reg.active.postMessage({ type: 'PRECACHE_TESSERACT' });
    _precacheRequested = true;
    console.log('[SW Bridge] Đã yêu cầu precache Tesseract');
    return true;
  } catch (e) {
    console.warn('[SW Bridge] Không gửi được message:', e);
    return false;
  }
}

/**
 * Kiểm tra Tesseract đã được cache trong SW chưa.
 * @returns {Promise<boolean>}
 */
export async function isTesseractCached() {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open('spx-tesseract-v1');
    const keys = await cache.keys();
    return keys.length >= 3;   // JS + worker + traineddata
  } catch {
    return false;
  }
}

/**
 * Xóa cache Tesseract (dùng khi bị lỗi/ hỏng).
 */
export async function clearTesseractCache() {
  if (!('caches' in window)) return false;
  try {
    await caches.delete('spx-tesseract-v1');
    _precacheRequested = false;
    return true;
  } catch {
    return false;
  }
}