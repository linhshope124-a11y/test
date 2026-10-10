import {
  state,
  persistData,
  sanitizeRecords,
  persistSalaryByMonth,
  persistRankByMonth
} from './state.js';
import { APP_VERSION, STORAGE_KEYS, WEIGHT_KEYS } from './config.js';
import { getTodayIso } from './utils.js';
import { updateAllViews } from './render.js';
import { initRankUI, initRegionUI, showToast } from './ui.js';
import { showAlert, showConfirm } from './dialog.js';

// ==================== CONFIG ====================
const AUTO_BACKUP_DAYS = 7;
const AUTO_BACKUP_LAST_KEY = 'spx_last_auto_backup';
const AUTO_BACKUP_SNOOZE_KEY = 'spx_auto_backup_snooze';

// ==================== HELPERS ====================
function weightsEqual(a, b) {
  return WEIGHT_KEYS.every(k => (parseInt(a[k], 10) || 0) === (parseInt(b[k], 10) || 0));
}

function dedupeList(list) {
  const seen = new Set();
  return list.filter(r => {
    const key = r.date + '|' + WEIGHT_KEYS.map(k => parseInt(r.weights?.[k], 10) || 0).join('_');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function totalRecords(data) {
  return (data.delivery?.length || 0) + (data.pickup?.length || 0) + (data.return?.length || 0);
}

// ⭐ HÀM MỚI: Tạo payload backup
function buildBackupPayload() {
  return {
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: {
      rankByMonth:   state.rankByMonth,
      salaryByMonth: state.salaryByMonth,
      salaryDays:    state.salaryDays,
      region:        state.region,
      theme:         localStorage.getItem(STORAGE_KEYS.theme) || 'light'
    },
    data: state.appData
  };
}

// ⭐ HÀM MỚI: Tải file thực sự — PHẢI gọi trong click handler đồng bộ
export function downloadBackupFile(prefix = 'SPX_Data') {
  const payload = buildBackupPayload();
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `${prefix}_${getTodayIso()}.json`);
  document.body.appendChild(a);
  a.click();
  a.remove();
  markBackupDone();
}

// ⭐ HÀM MỚI: Ghi timestamp lần backup gần nhất
export function markBackupDone() {
  try {
    localStorage.setItem(AUTO_BACKUP_LAST_KEY, String(Date.now()));
  } catch {}
}

// ⭐ HÀM MỚI: Check xem có cần auto backup không
function needsAutoBackup() {
  const total = totalRecords(state.appData);
  if (total === 0) return false;

  // Nếu hôm nay đã bấm "Để sau" → không hỏi lại
  try {
    const snooze = localStorage.getItem(AUTO_BACKUP_SNOOZE_KEY);
    if (snooze === getTodayIso()) return false;
  } catch {}

  let last = 0;
  try {
    last = parseInt(localStorage.getItem(AUTO_BACKUP_LAST_KEY) || '0', 10);
  } catch {}

  if (!Number.isFinite(last) || last === 0) return true;

  const daysSince = (Date.now() - last) / (1000 * 60 * 60 * 24);
  return daysSince >= AUTO_BACKUP_DAYS;
}

// ⭐ HÀM MỚI: Kiểm tra + hỏi user backup nếu quá hạn
export async function checkAutoBackup() {
  if (!needsAutoBackup()) return;

  const total = totalRecords(state.appData);
  const ok = await showConfirm(
    `📥 Đã ${AUTO_BACKUP_DAYS} ngày chưa backup.\n\n` +
    `Bạn đang có ${total} bản ghi.\n\n` +
    `Tải file backup về máy để phòng khi mất dữ liệu?\n\n` +
    `(File sẽ lưu vào thư mục Downloads)`,
    {
      title: '📥 Backup định kỳ',
      okText: '📥 Lưu file ngay',
      cancelText: 'Để sau',
      danger: false
    }
  );

  if (ok) {
    // ⚠️ KHÔNG await — phải trigger download ngay trong stack này
    // để browser cho phép (user gesture requirement)
    downloadBackupFile('SPX_Auto_Backup');
    showToast('Đã tải file backup về máy', 'success', 2500);
  } else {
    // Đánh dấu hôm nay đã snooze → không hỏi lại
    try {
      localStorage.setItem(AUTO_BACKUP_SNOOZE_KEY, getTodayIso());
    } catch {}
  }
}

// ==================== COPY / PASTE JSON ====================
export function copyDataJson() {
  const jsonStr = JSON.stringify(state.appData, null, 2);
  const btn = document.getElementById('copyJsonBtn');
  const ok = () => {
    btn.innerHTML = '✓ Đã chép!';
    btn.style.background = '#10b981'; btn.style.borderColor = '#10b981'; btn.style.color = '#fff';
    setTimeout(() => { btn.innerHTML = '📋 Chép'; btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
  };
  const fb = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = jsonStr; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      ok();
    } catch { showToast('Không chép được', 'error'); }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(jsonStr).then(ok).catch(fb);
  else fb();
}

export function openPasteJsonModal()  {
  document.getElementById('jsonPasteInput').value = '';
  document.getElementById('pasteJsonModal').classList.add('active');
}
export function closePasteJsonModal() { document.getElementById('pasteJsonModal').classList.remove('active'); }

// ==================== APPLY IMPORT ====================
export function applyImportedPayload(parsed, mode = 'overwrite') {
  let importedData = null, importedSettings = null;
  if (parsed?.data && (parsed.data.delivery || parsed.data.pickup || parsed.data.return)) {
    importedData = parsed.data; importedSettings = parsed.settings || null;
  } else if (parsed && (parsed.delivery || parsed.pickup || parsed.return)) {
    importedData = parsed;
  } else return { success: false };

  const newDel  = dedupeList(sanitizeRecords(importedData.delivery));
  const newPick = dedupeList(sanitizeRecords(importedData.pickup));
  const newRet  = dedupeList(sanitizeRecords(importedData.return));

  let removedCount = 0;
  let addedCount = 0;

  if (mode === 'overwrite') {
    const oldTotal = totalRecords(state.appData);
    state.appData = {
      delivery: newDel,
      pickup:   newPick,
      return:   newRet
    };
    addedCount = totalRecords(state.appData);
    removedCount = 0;
    console.log(`[Import] OVERWRITE: ${oldTotal} → ${addedCount} bản ghi`);
  } else {
    const mergeList = (oldList, newList) => {
      const merged = [...oldList];
      const keyOf = r => r.date + '|' + WEIGHT_KEYS.map(k => r.weights[k]).join('_');
      const have = new Set(oldList.map(keyOf));
      let added = 0;
      newList.forEach(r => {
        const k = keyOf(r);
        if (have.has(k)) return;
        have.add(k);
        merged.push(r);
        added++;
      });
      return { list: merged, added };
    };

    const m1 = mergeList(state.appData.delivery, newDel);
    const m2 = mergeList(state.appData.pickup,   newPick);
    const m3 = mergeList(state.appData.return,   newRet);

    state.appData = {
      delivery: m1.list,
      pickup:   m2.list,
      return:   m3.list
    };
    addedCount = m1.added + m2.added + m3.added;
    const newTotal = totalRecords({ delivery: newDel, pickup: newPick, return: newRet });
    removedCount = newTotal - addedCount;
    console.log(`[Import] MERGE: thêm ${addedCount}, skip ${removedCount} trùng`);
  }

  persistData();

  // ===== Settings =====
  if (importedSettings) {
    if (typeof importedSettings.region === 'string' &&
        (importedSettings.region === 'mien' || importedSettings.region === 'hcm_hn')) {
      state.region = importedSettings.region;
      localStorage.setItem('spx_region', state.region);
    }

    if (typeof importedSettings.theme === 'string') {
      localStorage.setItem(STORAGE_KEYS.theme, importedSettings.theme);
      document.documentElement.setAttribute('data-theme', importedSettings.theme);
    }

    if (importedSettings.salaryByMonth && typeof importedSettings.salaryByMonth === 'object') {
      if (mode === 'overwrite') {
        state.salaryByMonth = importedSettings.salaryByMonth;
      } else {
        Object.keys(importedSettings.salaryByMonth).forEach(m => {
          if (!state.salaryByMonth[m]) {
            state.salaryByMonth[m] = importedSettings.salaryByMonth[m];
          }
        });
      }
      persistSalaryByMonth();
    } else {
      const legacySalary = Number(importedSettings.manualSalary) || 0;
      const legacyBuuCuc = importedSettings.manualPoints?.buuCuc || 0;
      const legacyTaiXe  = importedSettings.manualPoints?.taiXe  || 0;
      if (legacySalary > 0 || legacyBuuCuc > 0 || legacyTaiXe > 0) {
        const m = state.currentMonth || new Date().toISOString().slice(0, 7);
        if (!state.salaryByMonth[m]) {
          state.salaryByMonth[m] = { base: legacySalary, buuCuc: legacyBuuCuc, taiXe: legacyTaiXe };
          persistSalaryByMonth();
        }
      }
    }

    if (importedSettings.rankByMonth && typeof importedSettings.rankByMonth === 'object') {
      if (mode === 'overwrite') {
        state.rankByMonth = importedSettings.rankByMonth;
      } else {
        Object.keys(importedSettings.rankByMonth).forEach(m => {
          if (!state.rankByMonth[m]) {
            state.rankByMonth[m] = importedSettings.rankByMonth[m];
          }
        });
      }
      persistRankByMonth();
    } else if (typeof importedSettings.rankName === 'string' && importedSettings.rankName !== 'none') {
      const m = state.currentMonth || new Date().toISOString().slice(0, 7);
      if (!state.rankByMonth[m]) {
        state.rankByMonth[m] = {
          name: importedSettings.rankName,
          bonus: Number(importedSettings.rankBonus) || 0
        };
        persistRankByMonth();
      }
    }

    if (Number.isFinite(importedSettings.salaryDays)) {
      state.salaryDays = importedSettings.salaryDays;
      localStorage.setItem('spx_salary_days', state.salaryDays);
    }
  }

  persistData();
  return { success: true, addedCount, removedCount, mode };
}

export async function askImportMode(newCount = 0) {
  const currentTotal = totalRecords(state.appData);
  if (currentTotal === 0) return 'overwrite';

  const newInfo = newCount > 0 ? `\n📁 File muốn nạp: ${newCount} bản ghi\n` : '';
  const msg =
    `App đang có ${currentTotal} bản ghi.` + newInfo + `\n` +
    `Chọn cách nạp:\n\n` +
    `• GHI ĐÈ — Xóa hết data cũ, thay bằng dữ liệu mới\n` +
    `• THÊM VÀO — Giữ data cũ + thêm mới (bỏ qua bản ghi trùng)`;

  const ok = await showConfirm(msg, {
    title: 'Nạp dữ liệu',
    okText: 'GHI ĐÈ',
    cancelText: 'THÊM VÀO',
    danger: true
  });

  return ok ? 'overwrite' : 'merge';
}

// ==================== IMPORT (paste JSON) ====================
export async function confirmImportJsonString() {
  const text = document.getElementById('jsonPasteInput').value.trim();
  if (!text) {
    await showAlert('Vui lòng dán chuỗi JSON!', { title: 'Thiếu dữ liệu', okText: 'Đóng' });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    await showAlert('Dữ liệu JSON không hợp lệ!', { title: 'Lỗi định dạng', okText: 'Đóng' });
    return;
  }

  const newCount = (parsed.data?.delivery?.length || 0)
                 + (parsed.data?.pickup?.length   || 0)
                 + (parsed.data?.return?.length   || 0);
  const mode = await askImportMode(newCount);
  if (mode === 'cancel') return;

  const result = applyImportedPayload(parsed, mode);
  if (!result.success) {
    await showAlert('Chuỗi JSON không đúng định dạng!', { title: 'Lỗi định dạng', okText: 'Đóng' });
    return;
  }

  updateAllViews();
  initRankUI();
  initRegionUI();
  closePasteJsonModal();

  const msg = mode === 'overwrite'
    ? `Đã GHI ĐÈ: ${result.addedCount} bản ghi mới`
    : `Đã THÊM VÀO: +${result.addedCount} bản ghi` +
      (result.removedCount > 0 ? `\nBỏ qua ${result.removedCount} bản ghi trùng` : '');
  await showAlert(msg, { title: '✅ Hoàn tất', okText: 'OK' });
}

// ==================== EXPORT ====================
export function exportData() {
  downloadBackupFile('SPX_Data');
}

// ==================== IMPORT FILE ====================
export async function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      await showAlert('Không đọc được file sao lưu!', { title: 'Lỗi file', okText: 'Đóng' });
      event.target.value = '';
      return;
    }

    const newCount = (parsed.data?.delivery?.length || 0)
                   + (parsed.data?.pickup?.length   || 0)
                   + (parsed.data?.return?.length   || 0);
    const mode = await askImportMode(newCount);
    if (mode === 'cancel') { event.target.value = ''; return; }

    const result = applyImportedPayload(parsed, mode);
    if (!result.success) {
      await showAlert('File sao lưu không đúng định dạng!', { title: 'Lỗi file', okText: 'Đóng' });
      event.target.value = '';
      return;
    }

    updateAllViews();
    initRankUI();
    initRegionUI();

    const msg = mode === 'overwrite'
      ? `Đã GHI ĐÈ: ${result.addedCount} bản ghi mới`
      : `Đã THÊM VÀO: +${result.addedCount} bản ghi` +
        (result.removedCount > 0 ? `\nBỏ qua ${result.removedCount} bản ghi trùng` : '');
    await showAlert(msg, { title: '✅ Hoàn tất', okText: 'OK' });
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ==================== RESTORE FROM VAULT ====================
export async function restoreFromVault() {
  let vault = null;
  try {
    vault = JSON.parse(localStorage.getItem(STORAGE_KEYS.vault));
  } catch {}

  const hasData = vault && (
    (vault.delivery && vault.delivery.length > 0) ||
    (vault.pickup   && vault.pickup.length   > 0) ||
    (vault.return   && vault.return.length   > 0)
  );
  if (!hasData) {
    await showAlert('Không tìm thấy dữ liệu tự động lưu trữ.', { title: 'Không có vault', okText: 'Đóng' });
    return;
  }

  const ok = await showConfirm(
    'Đã tìm thấy bản sao lưu tự động.\n\nBạn có muốn phục hồi không?',
    { title: 'Phục hồi vault', okText: 'Phục hồi', cancelText: 'Hủy' }
  );
  if (!ok) return;

  state.appData = {
    delivery: sanitizeRecords(vault.delivery),
    pickup:   sanitizeRecords(vault.pickup),
    return:   sanitizeRecords(vault.return)
  };
  persistData();
  updateAllViews();
  await showAlert('Đã phục hồi dữ liệu!', { title: '✅ Hoàn tất', okText: 'OK' });
}