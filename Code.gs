/**
 * ============================================================================
 *  MANAJEMEN SERVIS AC RUMAH — Backend Google Apps Script
 * ============================================================================
 *  File ini dipasang di Google Apps Script (script.google.com) yang terhubung
 *  ke Google Spreadsheet Anda, lalu di-deploy sebagai "Web App".
 *
 *  Struktur Google Sheets yang dibutuhkan:
 *
 *  Sheet "Riwayat_Servis" (dibuat otomatis oleh skrip ini jika belum ada)
 *  Kolom (baris 1 = header):
 *    A: ID            -> ID unik record (dibuat otomatis)
 *    B: Timestamp      -> Waktu data disimpan ke server (otomatis)
 *    C: UnitAC         -> Nama unit AC (mis. "AC Kamar Utama")
 *    D: TanggalServis  -> Tanggal servis dilakukan (format YYYY-MM-DD)
 *    E: NamaTeknisi    -> Nama teknisi yang mengerjakan servis
 *    F: Catatan        -> Catatan tambahan (opsional)
 *    G: Status         -> "Aktif" (default) atau "Arsip" (dihapus lewat app,
 *                          tapi masih tersimpan supaya bisa dipulihkan)
 *
 *  KALAU SPREADSHEET ANDA SUDAH ADA DATA DARI VERSI SEBELUM ada kolom Status:
 *  tidak perlu diapa-apakan, baris lama otomatis dianggap "Aktif" oleh skrip
 *  ini (lihat doGet). Kolom G akan mulai terisi otomatis untuk data baru.
 *
 *  Cara Deploy (ringkas — detail lengkap ada di README.md):
 *   1. Buka Google Sheets baru, buka menu Extensions > Apps Script.
 *   2. Hapus isi default Code.gs, lalu tempel (paste) seluruh isi file ini.
 *   3. Klik Deploy > New deployment > pilih tipe "Web app".
 *   4. Execute as: "Me". Who has access: "Anyone".
 *   5. Klik Deploy, salin URL Web App yang muncul.
 *   6. Tempel URL tersebut ke variabel CONFIG.WEB_APP_URL di file app.js PWA.
 *
 *  Kalau Anda SUDAH PERNAH deploy sebelumnya dan hanya meng-update isi
 *  Code.gs (seperti sekarang): Deploy > Manage deployments > klik pensil
 *  (Edit) pada deployment aktif > Version: pilih "New version" > Deploy.
 *  URL Web App tidak berubah, tidak perlu update app.js.
 * ============================================================================
 */

// Nama sheet tempat data servis disimpan
var SHEET_NAME = 'Riwayat_Servis';

// Header kolom (urutan harus sama dengan urutan data yang ditulis)
var HEADERS = ['ID', 'Timestamp', 'UnitAC', 'TanggalServis', 'NamaTeknisi', 'Catatan', 'Status'];

var STATUS_AKTIF = 'Aktif';
var STATUS_ARSIP = 'Arsip';

// Index kolom (0-based, sesuai urutan HEADERS) — dipakai di banyak tempat
// supaya kalau urutan kolom berubah, cukup ubah di satu tempat ini.
var COL = { ID: 0, TIMESTAMP: 1, UNIT: 2, TANGGAL: 3, TEKNISI: 4, CATATAN: 5, STATUS: 6 };

/**
 * Mengambil (atau membuat jika belum ada) sheet data.
 */
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // Lock supaya kalau ada 2 request nyaris bersamaan saat sheet belum ada,
    // sheet (dan headernya) tidak dibuat dobel.
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      sheet = ss.getSheetByName(SHEET_NAME); // cek ulang setelah dapat lock
      if (!sheet) {
        sheet = ss.insertSheet(SHEET_NAME);
      }
    } finally {
      lock.releaseLock();
    }
  }
  if (sheet.getLastRow() === 0) {
    var lock2 = LockService.getScriptLock();
    lock2.waitLock(10000);
    try {
      if (sheet.getLastRow() === 0) { // cek ulang setelah dapat lock
        sheet.appendRow(HEADERS);
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      }
    } finally {
      lock2.releaseLock();
    }
  }
  // Jaga-jaga: kalau sheet-nya dibuat oleh versi Code.gs LAMA (cuma 6 kolom,
  // belum ada Status), lengkapi header kolom G supaya tidak error saat ditulis.
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sheet;
}

/**
 * Helper untuk membungkus response JSON dengan header yang sesuai.
 */
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Cari nomor baris (1-based, sesuai penomoran baris di Sheets) berdasarkan ID.
 * Mengembalikan -1 kalau tidak ketemu.
 */
function findRowById_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      return i + 2; // +2: offset header (baris 1) + index 0-based -> 1-based
    }
  }
  return -1;
}

/**
 * GET /exec
 * Mengambil SELURUH data riwayat servis (aktif maupun arsip) dalam format
 * JSON — pemilahan aktif/arsip dilakukan di sisi PWA (field "status").
 *
 * Contoh respons:
 * {
 *   "status": "success",
 *   "data": [
 *     { "id": "...", "timestamp": "...", "unitAC": "AC Kamar Utama",
 *       "tanggalServis": "2026-06-01", "namaTeknisi": "Budi", "catatan": "...",
 *       "recordStatus": "Aktif" },
 *     ...
 *   ]
 * }
 */
function doGet(e) {
  try {
    var sheet = getSheet_();
    var lastRow = sheet.getLastRow();

    if (lastRow < 2) {
      return jsonResponse_({ status: 'success', data: [] });
    }

    var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    var data = values
      .filter(function (row) { return row[COL.ID] !== ''; })
      .map(function (row) {
        return {
          id: row[COL.ID],
          timestamp: row[COL.TIMESTAMP] instanceof Date ? row[COL.TIMESTAMP].toISOString() : row[COL.TIMESTAMP],
          unitAC: row[COL.UNIT],
          tanggalServis: formatDate_(row[COL.TANGGAL]),
          namaTeknisi: row[COL.TEKNISI],
          catatan: row[COL.CATATAN],
          // Baris lama (dari sebelum ada kolom Status) otomatis dianggap Aktif.
          recordStatus: row[COL.STATUS] ? row[COL.STATUS] : STATUS_AKTIF
        };
      });

    return jsonResponse_({ status: 'success', data: data });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

/**
 * POST /exec
 * Satu endpoint untuk 4 aksi, dibedakan lewat field "action" di body JSON:
 *   - "create"  (default kalau action tidak diisi, demi kompatibilitas lama)
 *   - "update"
 *   - "archive" (soft-delete: hapus dari tampilan Riwayat, pindah ke Arsip)
 *   - "restore" (kembalikan dari Arsip ke Riwayat)
 *
 * PENTING (soal CORS): PWA mengirim body dengan Content-Type "text/plain"
 * (bukan application/json) supaya browser TIDAK melakukan CORS preflight
 * (OPTIONS request), karena Google Apps Script Web App tidak menangani
 * preflight OPTIONS dengan baik. Isi body tetap berupa teks JSON biasa,
 * dan kita parse manual di sini dengan JSON.parse().
 *
 * Body "create"/"update":
 * {
 *   "action": "create" | "update",
 *   "id": "SRV-...",              // wajib untuk "update", diabaikan untuk "create"
 *   "unitAC": "AC Kamar Utama",
 *   "tanggalServis": "2026-08-24",
 *   "namaTeknisi": "Budi Santoso",
 *   "catatan": "Cuci evaporator & isi freon"
 * }
 *
 * Body "archive"/"restore":
 * { "action": "archive" | "restore", "id": "SRV-..." }
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // tunggu maksimal 10 detik jika ada request lain

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonResponse_({ status: 'error', message: 'Payload tidak valid (bukan JSON).' });
    }

    var action = (payload.action || 'create').toString().trim();
    var sheet = getSheet_();

    if (action === 'archive' || action === 'restore') {
      return handleArchiveOrRestore_(sheet, payload, action);
    }
    if (action === 'update') {
      return handleUpdate_(sheet, payload);
    }
    return handleCreate_(sheet, payload);
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function handleCreate_(sheet, payload) {
  var unitAC = (payload.unitAC || '').toString().trim();
  var tanggalServis = (payload.tanggalServis || '').toString().trim();
  var namaTeknisi = (payload.namaTeknisi || '').toString().trim();
  var catatan = (payload.catatan || '').toString().trim();

  if (!unitAC || !tanggalServis) {
    return jsonResponse_({ status: 'error', message: 'Unit AC dan Tanggal Servis wajib diisi.' });
  }

  var id = 'SRV-' + new Date().getTime();
  var timestamp = new Date();

  sheet.appendRow([id, timestamp, unitAC, tanggalServis, namaTeknisi, catatan, STATUS_AKTIF]);

  return jsonResponse_({
    status: 'success',
    message: 'Data servis berhasil disimpan.',
    data: {
      id: id,
      timestamp: timestamp.toISOString(),
      unitAC: unitAC,
      tanggalServis: tanggalServis,
      namaTeknisi: namaTeknisi,
      catatan: catatan,
      recordStatus: STATUS_AKTIF
    }
  });
}

function handleUpdate_(sheet, payload) {
  var id = (payload.id || '').toString().trim();
  var unitAC = (payload.unitAC || '').toString().trim();
  var tanggalServis = (payload.tanggalServis || '').toString().trim();
  var namaTeknisi = (payload.namaTeknisi || '').toString().trim();
  var catatan = (payload.catatan || '').toString().trim();

  if (!id) {
    return jsonResponse_({ status: 'error', message: 'ID data yang mau diedit tidak ditemukan.' });
  }
  if (!unitAC || !tanggalServis) {
    return jsonResponse_({ status: 'error', message: 'Unit AC dan Tanggal Servis wajib diisi.' });
  }

  var rowNum = findRowById_(sheet, id);
  if (rowNum === -1) {
    return jsonResponse_({ status: 'error', message: 'Data dengan ID tersebut tidak ditemukan (mungkin sudah dihapus).' });
  }

  // Kolom C..F (UnitAC, TanggalServis, NamaTeknisi, Catatan) — ID, Timestamp
  // asli, dan Status TIDAK diubah supaya riwayat kapan data dibuat tetap ada.
  sheet.getRange(rowNum, COL.UNIT + 1, 1, 4).setValues([[unitAC, tanggalServis, namaTeknisi, catatan]]);

  return jsonResponse_({
    status: 'success',
    message: 'Data servis berhasil diperbarui.',
    data: { id: id, unitAC: unitAC, tanggalServis: tanggalServis, namaTeknisi: namaTeknisi, catatan: catatan }
  });
}

function handleArchiveOrRestore_(sheet, payload, action) {
  var id = (payload.id || '').toString().trim();
  if (!id) {
    return jsonResponse_({ status: 'error', message: 'ID data tidak ditemukan.' });
  }

  var rowNum = findRowById_(sheet, id);
  if (rowNum === -1) {
    return jsonResponse_({ status: 'error', message: 'Data dengan ID tersebut tidak ditemukan.' });
  }

  var newStatus = action === 'archive' ? STATUS_ARSIP : STATUS_AKTIF;
  sheet.getRange(rowNum, COL.STATUS + 1).setValue(newStatus);

  return jsonResponse_({
    status: 'success',
    message: action === 'archive' ? 'Data dipindahkan ke Arsip.' : 'Data dipulihkan dari Arsip.',
    data: { id: id, recordStatus: newStatus }
  });
}

/**
 * Format nilai tanggal (Date object atau string, dalam bentuk APAPUN) menjadi
 * "YYYY-MM-DD" yang konsisten. INI PENTING: kalau fungsi ini gagal mengembalikan
 * format YYYY-MM-DD, PWA (app.js -> parseDateStr) tidak bisa membaca tanggalnya
 * sama sekali, dan kartu Dashboard akan salah menampilkan "Belum Pernah Servis"
 * walau datanya sebenarnya ada (pernah terjadi — lihat catatan di README/riwayat
 * perbaikan). Karena itu fungsi ini SENGAJA dibuat berlapis (coba beberapa cara)
 * alih-alih langsung .toString() nilai mentahnya.
 */
function formatDate_(value) {
  if (!value) return '';

  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
  }

  var str = value.toString().trim();

  // Sudah dalam format yang benar -> langsung pakai, tidak perlu diproses lagi.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Fallback: value bukan instance Date (mis. tersimpan sebagai teks di Sheets,
  // atau kena bug versi Code.gs sebelumnya) tapi isinya tetap sebuah representasi
  // tanggal yang valid (mis. "Mon Aug 24 2026 00:00:00 GMT+0700 (...)"). Coba
  // parse ulang dengan JavaScript Date supaya tetap bisa dikonversi ke YYYY-MM-DD,
  // alih-alih dikembalikan mentah-mentah dan bikin PWA gagal membacanya.
  var parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
  }

  return str;
}
