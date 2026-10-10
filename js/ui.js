// ================ AUTO-SAVE OCR TOGGLE ================
const AUTOSAVE_OCR_KEY = 'spx_ocr_autosave';

/**
 * Kiểm tra setting tự lưu OCR. Default = BẬT.
 */
export function isAutoSaveOCR() {
  try {
    const v = localStorage.getItem(AUTOSAVE_OCR_KEY);
    return v === null ? true : v === '1';
  } catch { return true; }
}

/**
 * Ghi setting. Không cần refresh — ocr.js đọc trực tiếp mỗi lần tryAutoSave.
 */
export function setAutoSaveOCR(enabled) {
  try {
    localStorage.setItem(AUTOSAVE_OCR_KEY, enabled ? '1' : '0');
  } catch {}
  updateMenuAutoSaveUI();
}

/**
 * Đảo trạng thái + toast.
 */
export function toggleAutoSaveOCR() {
  const next = !isAutoSaveOCR();
  setAutoSaveOCR(next);
  showToast(
    next ? '✅ Đã bật tự lưu OCR' : '⏸️ Đã tắt tự lưu OCR — phải xác nhận tay',
    next ? 'success' : 'warning',
    2200
  );
  return next;
}

/**
 * Wrapper gọi từ menu — toggle + đóng menu.
 */
export function toggleAutoSaveOCRFromMenu() {
  toggleAutoSaveOCR();
  closeMenuModal();
}

/**
 * Cập nhật text UI trong menu.
 */
export function updateMenuAutoSaveUI() {
  const enabled = isAutoSaveOCR();
  const title = document.getElementById('menuAutoSaveTitle');
  const sub   = document.getElementById('menuAutoSaveSub');
  if (title) title.innerText = enabled ? 'Tự lưu OCR: BẬT' : 'Tự lưu OCR: TẮT';
  if (sub)   sub.innerText   = enabled
    ? 'Tự động lưu khi OCR đọc đúng (score cao)'
    : 'Đang tắt — phải xác nhận thủ công';
}