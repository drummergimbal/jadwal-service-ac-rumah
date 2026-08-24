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
 *
 *  Cara Deploy (ringkas — detail lengkap ada di README.md):
 *   1. Buka Google Sheets baru, buka menu Extensions > Apps Script.
 *   2. Hapus isi default Code.gs, lalu tempel (paste) seluruh isi file ini.
 *   3. Klik Deploy > New deployment > pilih tipe "Web app".
 *   4. Execute as: "Me". Who has access: "Anyone".
 *   5. Klik Deploy, salin URL Web App yang muncul.
 *   6. Tempel URL tersebut ke variabel CONFIG.WEB_APP_URL di file app.js PWA.
 * ============================================================================
 */

// Nama sheet tempat data servis disimpan
var SHEET_NAME = 'Riwayat_Servis';

// Header kolom (urutan harus sama dengan urutan data yang ditulis)
var HEADERS = ['ID', 'Timestamp', 'UnitAC', 'TanggalServis', 'NamaTeknisi', 'Catatan'];

/**
 * Mengambil (atau membuat jika belum ada) sheet data.
 */
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
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
 * GET /exec
 * Mengambil seluruh data riwayat servis dalam format JSON.
 *
 * Contoh respons:
 * {
 *   "status": "success",
 *   "data": [
 *     { "id": "...", "timestamp": "...", "unitAC": "AC Kamar Utama",
 *       "tanggalServis": "2026-06-01", "namaTeknisi": "Budi", "catatan": "..." },
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
      .filter(function (row) { return row[0] !== ''; })
      .map(function (row) {
        return {
          id: row[0],
          timestamp: row[1] instanceof Date ? row[1].toISOString() : row[1],
          unitAC: row[2],
          tanggalServis: formatDate_(row[3]),
          namaTeknisi: row[4],
          catatan: row[5]
        };
      });

    return jsonResponse_({ status: 'success', data: data });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

/**
 * POST /exec
 * Menerima data servis baru dari PWA dan menambahkannya sebagai baris baru.
 *
 * PENTING (soal CORS): PWA mengirim body dengan Content-Type "text/plain"
 * (bukan application/json) supaya browser TIDAK melakukan CORS preflight
 * (OPTIONS request), karena Google Apps Script Web App tidak menangani
 * preflight OPTIONS dengan baik. Isi body tetap berupa teks JSON biasa,
 * dan kita parse manual di sini dengan JSON.parse().
 *
 * Body yang diharapkan (JSON string):
 * {
 *   "unitAC": "AC Kamar Utama",
 *   "tanggalServis": "2026-08-24",
 *   "namaTeknisi": "Budi Santoso",
 *   "catatan": "Cuci evaporator & isi freon"
 * }
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

    var unitAC = (payload.unitAC || '').toString().trim();
    var tanggalServis = (payload.tanggalServis || '').toString().trim();
    var namaTeknisi = (payload.namaTeknisi || '').toString().trim();
    var catatan = (payload.catatan || '').toString().trim();

    if (!unitAC || !tanggalServis) {
      return jsonResponse_({ status: 'error', message: 'Unit AC dan Tanggal Servis wajib diisi.' });
    }

    var sheet = getSheet_();
    var id = 'SRV-' + new Date().getTime();
    var timestamp = new Date();

    sheet.appendRow([id, timestamp, unitAC, tanggalServis, namaTeknisi, catatan]);

    return jsonResponse_({
      status: 'success',
      message: 'Data servis berhasil disimpan.',
      data: {
        id: id,
        timestamp: timestamp.toISOString(),
        unitAC: unitAC,
        tanggalServis: tanggalServis,
        namaTeknisi: namaTeknisi,
        catatan: catatan
      }
    });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Format nilai tanggal (Date object atau string) menjadi "YYYY-MM-DD".
 */
function formatDate_(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  return value.toString();
}
